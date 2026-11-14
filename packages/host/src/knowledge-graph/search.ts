/**
 * Retrieval for the experience graph.
 *
 * There is no embedding endpoint in the Harness's model channel, so the cache is a
 * deterministic local vectorizer: character n-grams hashed into a fixed number of
 * dimensions. It needs no third-party service, runs offline, and is stable across
 * restarts. When a chat model is available each candidate also gets a one-line
 * difference produced by that model; when it is not, the editor shows the similarity
 * and both descriptions side by side.
 */

import {
  isNodeSearchable,
  nodeSearchText,
  pathSearchText,
  type GraphNode,
  type GraphPath,
  type GraphSettings,
} from './model.ts'
import { keywordMatch, type KeywordField, type KeywordMatch } from './keyword.ts'

/** Dimensionality of the cached local vector. */
export const EMBEDDING_DIMENSIONS = 256

/**
 * How many semantic candidates one channel returns. The channel always offers its best
 * three above the floor; a fixed threshold no longer empties the list.
 */
export const SEMANTIC_TOP = 3

/** One image the judge model should also see, if the route accepts images. */
export interface GraphImageInput {
  readonly mediaType: string
  readonly data: Uint8Array
  readonly name?: string
}

/** The one-shot chat call the host injects; returns the model's text. */
export type GraphCompletion = (
  prompt: string,
  signal?: AbortSignal,
  images?: readonly GraphImageInput[],
) => Promise<string>

/** What each channel scored one candidate. A missing side means that channel missed. */
export interface CandidateScores {
  readonly semantic?: number
  readonly keyword?: number
}

/** One node candidate the editor shows in the semantic block. */
export interface NodeCandidate {
  readonly node: GraphNode
  readonly similarity: number
  /** True when the similarity reached the saved threshold; false is "未达阈值 · 最接近". */
  readonly meets_threshold: boolean
  /** One-line model difference; null means the editor shows the fallback layout. */
  readonly diff: string | null
  /** Both channel scores, so a node hit by both is still rendered once. */
  readonly scores: CandidateScores
}

/** One node candidate the editor shows in the keyword block. */
export interface NodeKeywordCandidate {
  readonly node: GraphNode
  /** Keyword score 0..1; this channel never consults the similarity threshold. */
  readonly score: number
  readonly field: string
  /** Matched run, copied from the field, for highlighting. */
  readonly fragment: string
  /** Fragment with context, for the hit line. */
  readonly snippet: string
  readonly scores: CandidateScores
}

/** One path candidate shown for confirmation. */
export interface PathCandidate {
  readonly path: GraphPath
  readonly similarity: number
  /** True when the similarity reached the saved threshold; false is "未达阈值 · 最接近". */
  readonly meets_threshold: boolean
  /** Only a path that meets the threshold and validates may run without a human override. */
  readonly auto_executable: boolean
  readonly node_titles: readonly string[]
  /** False when the saved sequence no longer matches the graph. */
  readonly runnable: boolean
  readonly scores: CandidateScores
}

/** One path candidate found by the keyword channel. */
export interface PathKeywordCandidate {
  readonly path: GraphPath
  readonly score: number
  readonly field: string
  readonly fragment: string
  readonly snippet: string
  readonly node_titles: readonly string[]
  readonly runnable: boolean
  readonly scores: CandidateScores
}

/** The answer of one node search. */
export interface NodeSearchResult {
  readonly query: string
  readonly threshold: number
  /** Similarity floor the semantic channel applied, so the editor can explain the bands. */
  readonly semantic_floor: number
  /**
   * Semantic channel: top three at or above the floor. Reaching the threshold marks a
   * candidate as confirmed; between the floor and the threshold it stays visible as
   * "未达阈值 · 最接近".
   */
  readonly candidates: readonly NodeCandidate[]
  /** Keyword channel: above its own floor, deduplicated against confirmed candidates. */
  readonly keyword: readonly NodeKeywordCandidate[]
  /** True when both channels are empty. */
  readonly empty: boolean
  /** Highest similarity seen, even when it stayed below the floor. */
  readonly best_similarity: number | null
  /** Floor the keyword channel applied, so the editor can explain an empty block. */
  readonly keyword_threshold: number
}

/** The answer of one index match. */
export interface PathSearchResult {
  readonly query: string
  readonly threshold: number
  /** Similarity floor the semantic channel applied. */
  readonly semantic_floor: number
  /** Top three at or above the floor; confirmed paths come first. */
  readonly candidates: readonly PathCandidate[]
  /** Keyword hits deduplicated against confirmed candidates. */
  readonly keyword: readonly PathKeywordCandidate[]
  /** True means stop and ask the operator to add information instead of executing. */
  readonly empty: boolean
  /** The stop message the operator sees when nothing matched. */
  readonly message: string | null
  readonly keyword_threshold: number
}

/** FNV-1a over UTF-16 code units; stable and dependency-free. */
function hash(text: string): number {
  let value = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index)
    value = Math.imul(value, 0x01000193)
  }
  return value >>> 0
}

/** Add one feature to the vector with a signed hash, so unrelated features cancel. */
function addFeature(vector: Float64Array, feature: string, weight: number): void {
  const bucket = hash(feature)
  const sign = (bucket & 1) === 0 ? 1 : -1
  vector[bucket % EMBEDDING_DIMENSIONS] += sign * weight
}

/**
 * Embed one piece of text. CJK is covered by character uni/bi/tri-grams; Latin words
 * also contribute whole-word features. The first line carries triple weight, which is
 * why every caller passes the title first.
 * @param text - text to embed.
 * @returns an L2-normalized vector; an empty text becomes all zeros.
 */
export function embedText(text: string): number[] {
  const normalized = text.normalize('NFKC').toLowerCase()
  const vector = new Float64Array(EMBEDDING_DIMENSIONS)
  const lines = normalized.split('\n')
  lines.forEach((line, lineIndex) => {
    const weight = lineIndex === 0 ? 3 : 1
    const compact = line.replace(/\s+/g, '')
    for (let index = 0; index < compact.length; index += 1) {
      addFeature(vector, `u:${compact[index]}`, weight * 0.4)
      if (index + 1 < compact.length) addFeature(vector, `b:${compact.slice(index, index + 2)}`, weight)
      if (index + 2 < compact.length) addFeature(vector, `t:${compact.slice(index, index + 3)}`, weight * 0.6)
    }
    for (const word of line.split(/[^a-z0-9]+/u)) {
      if (word.length >= 2) addFeature(vector, `w:${word}`, weight * 1.2)
    }
  })
  let norm = 0
  for (const value of vector) norm += value * value
  norm = Math.sqrt(norm)
  if (norm === 0) return Array.from(vector)
  return Array.from(vector, (value) => Math.round((value / norm) * 1e6) / 1e6)
}

/** Cosine similarity of two vectors, clamped to 0..1 for display. */
export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  const length = Math.min(left.length, right.length)
  if (length === 0) return 0
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < length; index += 1) {
    const a = left[index] ?? 0
    const b = right[index] ?? 0
    dot += a * b
    leftNorm += a * a
    rightNorm += b * b
  }
  if (leftNorm === 0 || rightNorm === 0) return 0
  const cosine = dot / Math.sqrt(leftNorm * rightNorm)
  return Math.round(Math.min(1, Math.max(0, cosine)) * 10_000) / 10_000
}

/** Character-bigram Dice coefficient, the no-model fallback for a raw string compare. */
export function lexicalSimilarity(left: string, right: string): number {
  const grams = (text: string): Map<string, number> => {
    const compact = text.normalize('NFKC').toLowerCase().replace(/\s+/g, '')
    const result = new Map<string, number>()
    for (let index = 0; index + 1 < compact.length; index += 1) {
      const gram = compact.slice(index, index + 2)
      result.set(gram, (result.get(gram) ?? 0) + 1)
    }
    return result
  }
  const a = grams(left)
  const b = grams(right)
  if (a.size === 0 || b.size === 0) return 0
  let overlap = 0
  for (const [gram, count] of a) overlap += Math.min(count, b.get(gram) ?? 0)
  return Math.round((2 * overlap / (a.size + b.size)) * 10_000) / 10_000
}

/**
 * Score one long field against the query by its best clause instead of only the whole
 * blob. Long Chinese descriptions otherwise dilute a short requirement: the embedded
 * name or one sentence can match at 0.8 while the concatenation scores 0.5. The cache
 * still holds the whole-field vector; clauses are cheap to recompute.
 */
export function clauseSimilarity(queryVector: readonly number[], text: string): number {
  let best = cosineSimilarity(queryVector, embedText(text))
  const clauses = text
    .split(/[\n。；;，,！!？?：:→]+/u)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length >= 2)
  for (const clause of clauses.slice(0, 40)) {
    const score = cosineSimilarity(queryVector, embedText(clause))
    if (score > best) best = score
  }
  return best
}

/** The cached vector, or a freshly computed one when the cache is empty. */
export function nodeEmbedding(node: GraphNode): readonly number[] {
  const cached = node.embedding
  if (cached !== null && cached.length === EMBEDDING_DIMENSIONS) return cached
  return embedText(nodeSearchText(node))
}

/** The cached path vector, or a freshly computed one. */
export function pathEmbedding(path: GraphPath, nodes: ReadonlyMap<string, GraphNode>): readonly number[] {
  const cached = path.embedding
  if (cached !== null && cached.length === EMBEDDING_DIMENSIONS) return cached
  return embedText(pathSearchText(path, nodes))
}

/** Fields one node's keyword score reads. Title first: a title hit wins ties. */
function nodeKeywordFields(node: GraphNode): readonly KeywordField[] {
  return [
    { field: 'title', text: node.title },
    { field: 'description', text: node.description },
    ...node.screenshots.map((shot): KeywordField => ({ field: 'screenshot', text: shot.caption })),
  ]
}

/** Fields one saved path's keyword score reads: exactly name and summary. */
function pathKeywordFields(path: GraphPath): readonly KeywordField[] {
  return [
    { field: 'name', text: path.name },
    { field: 'summary', text: path.summary },
  ]
}

/** A title/name hit ranks above a description/summary hit when the scores tie. */
function fieldRank(field: string): number {
  return field === 'title' || field === 'name' ? 0 : field === 'description' || field === 'summary' ? 1 : 2
}

/** One-line prompt asking the model how two steps differ. */
function differencePrompt(query: string, node: GraphNode): string {
  return [
    '你在协助一个人检索经验库里的操作节点。',
    `用户需求：${query}`,
    `候选节点：${node.title}`,
    `节点说明：${node.description.slice(0, 1200)}`,
    '只输出一句话（不超过 40 个汉字）说明候选节点与用户需求的关键差异，例如「对象不同：火狐 vs 腾讯」「前置不同：需先登录」。',
    '如果几乎相同，输出「描述几乎相同，可直接复用」。不要解释，不要加引号。',
  ].join('\n')
}

/** Trim model output to one short line; undefined means unusable. */
function oneLine(text: string): string | undefined {
  const line = text.split(/\r?\n/u).map((part) => part.trim()).find((part) => part !== '')
  if (line === undefined) return undefined
  const unquoted = line.replace(/^[「“"']+|[」”"']+$/gu, '').trim()
  return unquoted === '' ? undefined : unquoted.slice(0, 120)
}

/**
 * Ask the model for one sentence of difference. Failure is normal: the editor then
 * falls back to similarity plus both descriptions, exactly as approved.
 */
export async function describeDifference(
  completion: GraphCompletion | undefined,
  query: string,
  node: GraphNode,
  signal?: AbortSignal,
): Promise<string | null> {
  if (completion === undefined) return null
  try {
    const timeout = AbortSignal.timeout(20_000)
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    const text = await completion(differencePrompt(query, node), combined)
    return oneLine(text) ?? null
  } catch {
    return null
  }
}

/**
 * Search the graph through two independent channels.
 *
 * The semantic channel is no longer emptied by the threshold: it returns its best three
 * candidates at or above the floor, and marks each one with `meets_threshold`. A candidate
 * between the floor and the threshold stays visible as "未达阈值 · 最接近". The keyword
 * channel is character level, ignores the threshold, and survives with no model at all, so
 * a short query like "云电脑" still finds "进入天翼云电脑". Only candidates that met the
 * threshold are deduplicated against the keyword block; a below-threshold semantic card
 * may therefore also appear in the keyword block, because that channel still answers on
 * its own terms.
 *
 * @param nodes - every node in the library.
 * @param query - the operator's natural-language description.
 * @param settings - threshold, semantic floor, keyword top and floor.
 * @param completion - optional model used for the one-line difference.
 * @param signal - caller cancellation.
 */
export async function searchNodes(
  nodes: ReadonlyMap<string, GraphNode>,
  query: string,
  settings: GraphSettings,
  completion?: GraphCompletion,
  signal?: AbortSignal,
): Promise<NodeSearchResult> {
  const trimmed = query.trim()
  const keywordFloor = settings.keywordFloor
  const semanticFloor = settings.semanticFloor
  if (trimmed === '') {
    return {
      query: trimmed,
      threshold: settings.searchThreshold,
      semantic_floor: semanticFloor,
      candidates: [],
      keyword: [],
      empty: true,
      best_similarity: null,
      keyword_threshold: keywordFloor,
    }
  }
  const queryVector = embedText(trimmed)
  const searchable = [...nodes.values()].filter((node) => isNodeSearchable(node))
  const scored = searchable
    .map((node) => ({
      node,
      similarity: Math.max(
        cosineSimilarity(queryVector, nodeEmbedding(node)),
        clauseSimilarity(queryVector, nodeSearchText(node)),
      ),
    }))
    .sort((left, right) => right.similarity - left.similarity)
  const best = scored[0]?.similarity ?? null
  // The floor decides visibility; the threshold only decides the label. Top three always.
  const semantic = scored
    .filter((entry) => entry.similarity >= semanticFloor)
    .slice(0, SEMANTIC_TOP)
  const confirmedIds = new Set(
    semantic
      .filter((entry) => entry.similarity >= settings.searchThreshold)
      .map((entry) => entry.node.id),
  )

  // Score the keyword channel first, so a semantic card can also show its keyword score.
  const keywordScores = new Map<string, KeywordMatch>()
  for (const node of searchable) {
    const hit = keywordMatch(trimmed, nodeKeywordFields(node))
    if (hit !== null && hit.score >= keywordFloor) keywordScores.set(node.id, hit)
  }

  const candidates = await Promise.all(semantic.map(async (entry): Promise<NodeCandidate> => {
    const keywordScore = keywordScores.get(entry.node.id)?.score
    return {
      node: entry.node,
      similarity: entry.similarity,
      meets_threshold: entry.similarity >= settings.searchThreshold,
      diff: await describeDifference(completion, trimmed, entry.node, signal),
      scores: {
        semantic: entry.similarity,
        ...keywordScore === undefined ? {} : { keyword: keywordScore },
      },
    }
  }))

  const keyword = searchable
    .map((node) => ({ node, hit: keywordScores.get(node.id) }))
    .filter((entry): entry is { readonly node: GraphNode, readonly hit: KeywordMatch } => entry.hit !== undefined)
    .sort((left, right) => right.hit.score - left.hit.score
      || fieldRank(left.hit.field) - fieldRank(right.hit.field)
      || left.node.title.localeCompare(right.node.title))
    .filter((entry) => !confirmedIds.has(entry.node.id))
    .slice(0, settings.keywordTop)
    .map((entry): NodeKeywordCandidate => ({
      node: entry.node,
      score: entry.hit.score,
      field: entry.hit.field,
      fragment: entry.hit.fragment,
      snippet: entry.hit.snippet,
      scores: { keyword: entry.hit.score },
    }))

  return {
    query: trimmed,
    threshold: settings.searchThreshold,
    semantic_floor: semanticFloor,
    candidates,
    keyword,
    empty: candidates.length === 0 && keyword.length === 0,
    best_similarity: best,
    keyword_threshold: keywordFloor,
  }
}

/**
 * Match the natural-language request against saved path indexes through both channels.
 *
 * The semantic side follows the node channel exactly: confirmed paths (at or above the
 * threshold) first, then filled up to three with paths at or above the floor and marked
 * "未达阈值 · 最接近". A below-threshold path is never auto-executable — `auto_executable`
 * is false unless it met the threshold and validates — so the operator has to confirm it
 * explicitly. The keyword side scores name and summary, ignores the threshold, and
 * returns its own top N without being deduplicated against below-threshold cards.
 *
 * @param nodes - every node.
 * @param paths - every saved path.
 * @param query - the operator's requirement.
 * @param settings - threshold, semantic floor, keyword top and floor.
 * @param runnableOf - predicate supplied by the caller (the path validator).
 */
export function searchPaths(
  nodes: ReadonlyMap<string, GraphNode>,
  paths: readonly GraphPath[],
  query: string,
  settings: GraphSettings,
  runnableOf: (path: GraphPath) => boolean,
): PathSearchResult {
  const trimmed = query.trim()
  const keywordFloor = settings.keywordFloor
  const semanticFloor = settings.semanticFloor
  const message = '没有匹配的收藏：请补充更具体的信息（目标系统、对象、前置条件），或先在编辑器里新建一条收藏路径。'
  if (trimmed === '') {
    return {
      query: trimmed,
      threshold: settings.searchThreshold,
      semantic_floor: semanticFloor,
      candidates: [],
      keyword: [],
      empty: true,
      message,
      keyword_threshold: keywordFloor,
    }
  }
  const queryVector = embedText(trimmed)
  const scored = paths
    .map((path) => ({
      path,
      similarity: Math.max(
        cosineSimilarity(queryVector, pathEmbedding(path, nodes)),
        clauseSimilarity(queryVector, pathSearchText(path, nodes)),
      ),
    }))
    .sort((left, right) => right.similarity - left.similarity)
  // Confirmed paths rank first because the list is sorted by similarity; the floor only
  // removes noise, and the top-three cap is filled from whatever remains above it.
  const semantic = scored
    .filter((entry) => entry.similarity >= semanticFloor)
    .slice(0, SEMANTIC_TOP)
  const confirmedIds = new Set(
    semantic
      .filter((entry) => entry.similarity >= settings.searchThreshold)
      .map((entry) => entry.path.id),
  )

  const keywordScores = new Map<string, KeywordMatch>()
  for (const path of paths) {
    const hit = keywordMatch(trimmed, pathKeywordFields(path))
    if (hit !== null && hit.score >= keywordFloor) keywordScores.set(path.id, hit)
  }

  const candidates = semantic.map((entry): PathCandidate => {
    const keywordScore = keywordScores.get(entry.path.id)?.score
    const meetsThreshold = entry.similarity >= settings.searchThreshold
    const runnable = runnableOf(entry.path)
    return {
      path: entry.path,
      similarity: entry.similarity,
      meets_threshold: meetsThreshold,
      auto_executable: meetsThreshold && runnable,
      node_titles: entry.path.node_sequence.map((id) => nodes.get(id)?.title ?? id),
      runnable,
      scores: {
        semantic: entry.similarity,
        ...keywordScore === undefined ? {} : { keyword: keywordScore },
      },
    }
  })

  const keyword = paths
    .map((path) => ({ path, hit: keywordScores.get(path.id) }))
    .filter((entry): entry is { readonly path: GraphPath, readonly hit: KeywordMatch } => entry.hit !== undefined)
    .sort((left, right) => right.hit.score - left.hit.score
      || fieldRank(left.hit.field) - fieldRank(right.hit.field)
      || left.path.name.localeCompare(right.path.name))
    .filter((entry) => !confirmedIds.has(entry.path.id))
    .slice(0, settings.keywordTop)
    .map((entry): PathKeywordCandidate => ({
      path: entry.path,
      score: entry.hit.score,
      field: entry.hit.field,
      fragment: entry.hit.fragment,
      snippet: entry.hit.snippet,
      node_titles: entry.path.node_sequence.map((id) => nodes.get(id)?.title ?? id),
      runnable: runnableOf(entry.path),
      scores: { keyword: entry.hit.score },
    }))

  const empty = candidates.length === 0 && keyword.length === 0
  return {
    query: trimmed,
    threshold: settings.searchThreshold,
    semantic_floor: semanticFloor,
    candidates,
    keyword,
    empty,
    message: empty ? message : null,
    keyword_threshold: keywordFloor,
  }
}
