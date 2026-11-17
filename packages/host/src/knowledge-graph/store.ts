/**
 * File form of the experience graph.
 *
 * One library directory holds human-readable, diffable files:
 *   manifest.json       library settings and counts
 *   nodes/<id>.json     one node per file
 *   edges.jsonl         one edge per line
 *   paths/<id>.json     one prepared path per file
 *   index.json          the execution entry the model reads first
 *   decision_log.jsonl  append-only decisions
 *   screenshots/<id>/   images referenced by the node
 *
 * Writes are atomic per file (temp file, then rename), so a viewer never reads a
 * half-written node while the editor saves it.
 */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import {
  DEFAULT_GRAPH_SETTINGS,
  NODE_STATUSES,
  pathProblems,
  type DecisionField,
  type DecisionLogEntry,
  type GraphEdge,
  type GraphNode,
  type GraphPath,
  type GraphSettings,
  type GraphSnapshot,
  type CommonSense,
  type CommonSenseEntry,
  type NodeScreenshot,
  type PathGraph,
  type PathGraphEdge,
  type PathGraphNode,
} from './model.ts'

/** Marker in manifest.json; changing it means a migration is needed. */
export const GRAPH_FORMAT = 'dsh-agi.knowledge-graph'

/** Current on-disk version. */
export const GRAPH_VERSION = 1

/** Profile file that can point the library somewhere else. */
export const GRAPH_CONFIG = 'agi-knowledge-graph.json'

/** Folder name inside the profile. */
export const GRAPH_FOLDER = 'knowledge-graph'

/** What manifest.json contains. */
export interface GraphManifest {
  readonly format: typeof GRAPH_FORMAT
  readonly version: number
  readonly created_at: string
  readonly updated_at: string
  readonly settings: GraphSettings
  readonly counts: { readonly nodes: number; readonly edges: number; readonly paths: number; readonly decisions: number }
}

/** One loaded snapshot plus its settings and manifest. */
export interface LoadedGraph {
  readonly snapshot: GraphSnapshot
  readonly settings: GraphSettings
  readonly manifest: GraphManifest
}

/** The directory in use: the profile's choice when absolute, the default otherwise. */
export function knowledgeGraphDirFor(baseDir: string): string {
  try {
    const config = JSON.parse(readFileSync(join(baseDir, GRAPH_CONFIG), 'utf8')) as { dir?: unknown } | null
    if (typeof config?.dir === 'string' && isAbsolute(config.dir)) return resolve(config.dir)
  } catch {
    // No override recorded yet.
  }
  return resolve(join(baseDir, 'dsh-agi', GRAPH_FOLDER))
}

/** A missing or unreadable file is treated as an empty library. */
async function readText(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return undefined
  }
}

/** Write one file atomically; Windows rename replaces an existing file. */
async function writeAtomic(file: string, text: string): Promise<void> {
  const temporary = `${file}.tmp-${randomUUID().slice(0, 8)}`
  await mkdir(dirname(file), { recursive: true })
  await writeFile(temporary, text, 'utf8')
  try {
    await rename(temporary, file)
  } catch {
    await writeFile(file, text, 'utf8')
    await rm(temporary, { force: true })
  }
}

/** Parse one JSON line, ignoring a corrupt line instead of losing the rest. */
function parseLine<T>(line: string): T | undefined {
  const trimmed = line.trim()
  if (trimmed === '') return undefined
  try {
    return JSON.parse(trimmed) as T
  } catch {
    return undefined
  }
}

/** Whether the value is a finite number list. */
function numberList(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null
  if (!value.every((item) => typeof item === 'number' && Number.isFinite(item))) return null
  return value as number[]
}

/** Rebuild a node from disk, rejecting shapes the rest of the code cannot trust. */
function parseNode(raw: unknown): GraphNode | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  if (typeof record.id !== 'string' || record.id === '' || typeof record.title !== 'string') return undefined
  const status = typeof record.status === 'string' && (NODE_STATUSES as readonly string[]).includes(record.status)
    ? record.status as GraphNode['status']
    : 'active'
  const screenshots: NodeScreenshot[] = []
  if (Array.isArray(record.screenshots)) {
    for (const item of record.screenshots) {
      if (typeof item !== 'object' || item === null) continue
      const shot = item as Record<string, unknown>
      if (typeof shot.id !== 'string' || typeof shot.file !== 'string' || typeof shot.caption !== 'string') continue
      screenshots.push({
        id: shot.id,
        file: shot.file,
        caption: shot.caption,
        ...typeof shot.name === 'string' && shot.name.trim() !== '' ? { name: shot.name } : {},
        ...shot.source === 'ai' ? { source: 'ai' as const } : {},
      })
    }
  }
  // An older build wrote `io.input` / `io.output`. Those keys are ignored on read and
  // dropped on the next save: the model no longer has an `io` member at all.
  return {
    id: record.id,
    title: record.title,
    description: typeof record.description === 'string' ? record.description : '',
    embedding: numberList(record.embedding),
    status,
    created_at: typeof record.created_at === 'string' ? record.created_at : new Date(0).toISOString(),
    created_by: typeof record.created_by === 'string' ? record.created_by : 'unknown',
    derived_from: typeof record.derived_from === 'string' ? record.derived_from : null,
    screenshots,
    ...typeof record.ai_notes === 'string' && record.ai_notes.trim() !== '' ? { ai_notes: record.ai_notes } : {},
    ...typeof record.ai_updated_at === 'string' && record.ai_updated_at !== '' ? { ai_updated_at: record.ai_updated_at } : {},
    ...typeof record.favorite === 'boolean' ? { favorite: record.favorite } : {},
  }
}

/** Rebuild an edge from disk. */
function parseEdge(raw: unknown): GraphEdge | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  if (typeof record.from !== 'string' || typeof record.to !== 'string') return undefined
  return {
    from: record.from,
    to: record.to,
    type: 'sequence',
    created_at: typeof record.created_at === 'string' ? record.created_at : new Date(0).toISOString(),
  }
}

/** Rebuild a path's owned graph from disk. */
function parsePathGraph(raw: unknown): PathGraph | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  if (!Array.isArray(record.nodes) || !Array.isArray(record.edges)) return undefined
  const nodes: PathGraphNode[] = []
  for (const item of record.nodes) {
    if (typeof item !== 'object' || item === null) continue
    const entry = item as Record<string, unknown>
    if (typeof entry.key !== 'string' || typeof entry.node_id !== 'string') continue
    nodes.push({ key: entry.key, node_id: entry.node_id })
  }
  const edges: PathGraphEdge[] = []
  for (const item of record.edges) {
    if (typeof item !== 'object' || item === null) continue
    const entry = item as Record<string, unknown>
    if (typeof entry.from !== 'string' || typeof entry.to !== 'string') continue
    edges.push({ from: entry.from, to: entry.to })
  }
  return { nodes, edges }
}

/** Rebuild a path from disk. */
function parsePath(raw: unknown): GraphPath | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  if (typeof record.id !== 'string' || typeof record.name !== 'string' || typeof record.summary !== 'string') return undefined
  if (typeof record.start_node !== 'string' || typeof record.end_node !== 'string') return undefined
  if (!Array.isArray(record.node_sequence) || !record.node_sequence.every((item) => typeof item === 'string')) return undefined
  return {
    id: record.id,
    name: record.name,
    summary: record.summary,
    embedding: numberList(record.embedding),
    start_node: record.start_node,
    end_node: record.end_node,
    node_sequence: record.node_sequence as string[],
    ...typeof record.favorite === 'boolean' ? { favorite: record.favorite } : {},
    ...record.graph !== undefined ? { graph: parsePathGraph(record.graph) } : {},
  }
}

/** Rebuild a decision line from disk. */
function parseDecision(raw: unknown): DecisionLogEntry | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  if (typeof record.node_id !== 'string' || typeof record.action !== 'string') return undefined
  const candidates = Array.isArray(record.candidates)
    ? record.candidates.filter((item): item is { node_id: string; similarity: number | null } => {
      return typeof item === 'object' && item !== null
        && typeof (item as Record<string, unknown>).node_id === 'string'
    }).map((item) => ({ node_id: item.node_id, similarity: typeof item.similarity === 'number' ? item.similarity : null }))
    : []
  const fields = Array.isArray(record.fields)
    ? record.fields.filter((item): item is DecisionField => item === 'title' || item === 'description')
    : []
  return {
    node_id: record.node_id,
    action: record.action as DecisionLogEntry['action'],
    candidates,
    similarity: typeof record.similarity === 'number' ? record.similarity : null,
    diff_summary: typeof record.diff_summary === 'string' ? record.diff_summary : '',
    chosen: typeof record.chosen === 'string' ? record.chosen : null,
    operator: typeof record.operator === 'string' ? record.operator : 'unknown',
    ts: typeof record.ts === 'string' ? record.ts : new Date(0).toISOString(),
    ...fields.length === 0 ? {} : { fields },
  }
}

/** Normalize settings read from a manifest or a settings route. */
export function normalizeSettings(raw: unknown): GraphSettings {
  const record = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
  const threshold = typeof record.searchThreshold === 'number' && Number.isFinite(record.searchThreshold)
    ? Math.min(1, Math.max(0, record.searchThreshold))
    : DEFAULT_GRAPH_SETTINGS.searchThreshold
  const semanticFloor = typeof record.semanticFloor === 'number' && Number.isFinite(record.semanticFloor)
    ? Math.min(1, Math.max(0, record.semanticFloor))
    : DEFAULT_GRAPH_SETTINGS.semanticFloor
  const topK = typeof record.topK === 'number' && Number.isSafeInteger(record.topK) && record.topK > 0
    ? Math.min(50, record.topK)
    : DEFAULT_GRAPH_SETTINGS.topK
  const confirmTop = typeof record.confirmTop === 'number' && Number.isSafeInteger(record.confirmTop) && record.confirmTop > 0
    ? Math.min(10, record.confirmTop)
    : DEFAULT_GRAPH_SETTINGS.confirmTop
  const keywordTop = typeof record.keywordTop === 'number' && Number.isSafeInteger(record.keywordTop) && record.keywordTop > 0
    ? Math.min(100, record.keywordTop)
    : DEFAULT_GRAPH_SETTINGS.keywordTop
  const keywordFloor = typeof record.keywordFloor === 'number' && Number.isFinite(record.keywordFloor)
    ? Math.min(1, Math.max(0, record.keywordFloor))
    : DEFAULT_GRAPH_SETTINGS.keywordFloor
  return { searchThreshold: threshold, semanticFloor, topK, confirmTop, keywordTop, keywordFloor }
}

/** One library directory. */
export class KnowledgeGraphStore {
  readonly dir: string

  constructor(dir: string) {
    this.dir = resolve(dir)
  }

  /** Create the folder shape and a manifest on first use. */
  async init(): Promise<void> {
    await mkdir(join(this.dir, 'nodes'), { recursive: true })
    await mkdir(join(this.dir, 'paths'), { recursive: true })
    await mkdir(join(this.dir, 'screenshots'), { recursive: true })
    if (!existsSync(join(this.dir, 'manifest.json'))) {
      const now = new Date().toISOString()
      await this.writeManifest({
        format: GRAPH_FORMAT,
        version: GRAPH_VERSION,
        created_at: now,
        updated_at: now,
        settings: DEFAULT_GRAPH_SETTINGS,
        counts: { nodes: 0, edges: 0, paths: 0, decisions: 0 },
      })
    }
    if (!existsSync(join(this.dir, 'edges.jsonl'))) await writeAtomic(join(this.dir, 'edges.jsonl'), '')
    if (!existsSync(join(this.dir, 'decision_log.jsonl'))) await writeAtomic(join(this.dir, 'decision_log.jsonl'), '')
    // The standing prompt reads index.json before anything else; a brand-new library
    // must already have an empty one. A library with files but no index is rebuilt by
    // `load()` instead, so this branch never hides imported paths.
    if (!existsSync(join(this.dir, 'index.json'))
      && (await this.list('nodes', '.json')).length === 0
      && (await this.list('paths', '.json')).length === 0) {
      await this.writeIndex({ nodes: new Map(), edges: [], paths: [], decisions: [] })
    }
  }

  /** Read manifest.json, defaulting every missing field. */
  async readManifest(): Promise<GraphManifest> {
    const text = await readText(join(this.dir, 'manifest.json'))
    let raw: Record<string, unknown> = {}
    if (text !== undefined) {
      try {
        raw = JSON.parse(text) as Record<string, unknown>
      } catch {
        raw = {}
      }
    }
    const now = new Date().toISOString()
    const counts = typeof raw.counts === 'object' && raw.counts !== null ? raw.counts as Record<string, unknown> : {}
    const count = (key: string): number => typeof counts[key] === 'number' ? counts[key] as number : 0
    return {
      format: GRAPH_FORMAT,
      version: GRAPH_VERSION,
      created_at: typeof raw.created_at === 'string' ? raw.created_at : now,
      updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : now,
      settings: normalizeSettings(raw.settings),
      counts: {
        nodes: count('nodes'),
        edges: count('edges'),
        paths: count('paths'),
        decisions: count('decisions'),
      },
    }
  }

  /** Read the whole library. Missing folders simply read as empty. */
  async load(): Promise<LoadedGraph> {
    await this.init()
    const manifest = await this.readManifest()
    const nodes = new Map<string, GraphNode>()
    for (const name of await this.list('nodes', '.json')) {
      const text = await readText(join(this.dir, 'nodes', name))
      if (text === undefined) continue
      let raw: unknown
      try {
        raw = JSON.parse(text) as unknown
      } catch {
        continue
      }
      const node = parseNode(raw)
      if (node !== undefined) nodes.set(node.id, node)
    }
    const edges: GraphEdge[] = []
    const seenEdges = new Set<string>()
    for (const line of (await readText(join(this.dir, 'edges.jsonl')) ?? '').split(/\r?\n/u)) {
      const edge = parseEdge(parseLine<unknown>(line))
      if (edge === undefined) continue
      const key = `${edge.from}->${edge.to}`
      if (seenEdges.has(key)) continue
      seenEdges.add(key)
      edges.push(edge)
    }
    const paths: GraphPath[] = []
    for (const name of await this.list('paths', '.json')) {
      const text = await readText(join(this.dir, 'paths', name))
      if (text === undefined) continue
      let raw: unknown
      try {
        raw = JSON.parse(text) as unknown
      } catch {
        continue
      }
      const path = parsePath(raw)
      if (path !== undefined) paths.push(path)
    }
    const decisions: DecisionLogEntry[] = []
    for (const line of (await readText(join(this.dir, 'decision_log.jsonl')) ?? '').split(/\r?\n/u)) {
      const entry = parseDecision(parseLine<unknown>(line))
      if (entry !== undefined) decisions.push(entry)
    }
    paths.sort((left, right) => left.name.localeCompare(right.name))
    edges.sort((left, right) => `${left.from}->${left.to}`.localeCompare(`${right.from}->${right.to}`))
    const snapshot: GraphSnapshot = { nodes, edges, paths, decisions }
    if (!existsSync(join(this.dir, 'index.json'))) await this.writeIndex(snapshot)
    return { snapshot, settings: manifest.settings, manifest }
  }

  /** List one subfolder filtered by suffix, sorted for a stable diff. */
  private async list(folder: string, suffix: string): Promise<string[]> {
    try {
      return (await readdir(join(this.dir, folder))).filter((name) => name.endsWith(suffix)).sort()
    } catch {
      return []
    }
  }

  /** Save one node file. */
  async saveNode(node: GraphNode): Promise<void> {
    await writeAtomic(join(this.dir, 'nodes', `${safeId(node.id)}.json`), `${JSON.stringify(node, null, 2)}\n`)
  }

  /** Remove a node file (only used by tests / destructive tooling, never by the UI). */
  async removeNodeFile(nodeId: string): Promise<void> {
    await rm(join(this.dir, 'nodes', `${safeId(nodeId)}.json`), { force: true })
  }

  /** Save one path file. */
  async savePath(path: GraphPath): Promise<void> {
    await writeAtomic(join(this.dir, 'paths', `${safeId(path.id)}.json`), `${JSON.stringify(path, null, 2)}\n`)
  }

  /** Remove a path file. */
  async removePathFile(pathId: string): Promise<void> {
    await rm(join(this.dir, 'paths', `${safeId(pathId)}.json`), { force: true })
  }

  /** Replace edges.jsonl. */
  async saveEdges(edges: readonly GraphEdge[]): Promise<void> {
    const text = edges.map((edge) => JSON.stringify(edge)).join('\n')
    await writeAtomic(join(this.dir, 'edges.jsonl'), text === '' ? '' : `${text}\n`)
  }

  /** Append one decision line. */
  async appendDecision(entry: DecisionLogEntry): Promise<void> {
    await writeFile(join(this.dir, 'decision_log.jsonl'), `${JSON.stringify(entry)}\n`, { encoding: 'utf8', flag: 'a' })
  }

  /** Write the manifest with fresh counts. */
  async writeManifest(manifest: GraphManifest): Promise<void> {
    await writeAtomic(join(this.dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  }

  /** Persist library settings into the manifest. */
  async saveSettings(settings: GraphSettings, snapshot: GraphSnapshot): Promise<GraphManifest> {
    const previous = await this.readManifest()
    const manifest: GraphManifest = {
      ...previous,
      version: GRAPH_VERSION,
      updated_at: new Date().toISOString(),
      settings,
      counts: countsOf(snapshot),
    }
    await this.writeManifest(manifest)
    return manifest
  }

  /** Write manifest counts plus the generated path index. */
  async commit(snapshot: GraphSnapshot, settings: GraphSettings): Promise<void> {
    const manifest: GraphManifest = {
      format: GRAPH_FORMAT,
      version: GRAPH_VERSION,
      created_at: (await this.readManifest()).created_at,
      updated_at: new Date().toISOString(),
      settings,
      counts: countsOf(snapshot),
    }
    await this.writeManifest(manifest)
    await this.writeIndex(snapshot)
  }

  /**
   * Regenerate `index.json`, the file the model reads before choosing a path. It
   * carries the id, name, summary, start/end nodes, full node id sequence, readable
   * titles, and whether the path currently validates.
   */
  async writeIndex(snapshot: GraphSnapshot): Promise<void> {
    const paths = snapshot.paths.map((path) => {
      const problems = pathProblems(snapshot.nodes, snapshot.edges, path)
      return {
        id: path.id,
        name: path.name,
        summary: path.summary,
        start_node: path.start_node,
        start_title: snapshot.nodes.get(path.start_node)?.title ?? path.start_node,
        end_node: path.end_node,
        end_title: snapshot.nodes.get(path.end_node)?.title ?? path.end_node,
        node_sequence: [...path.node_sequence],
        node_titles: path.node_sequence.map((id) => snapshot.nodes.get(id)?.title ?? id),
        runnable: problems.length === 0,
        problems: problems.map((problem) => problem.message),
      }
    })
    const index = {
      format: 'dsh-agi.knowledge-graph.index',
      version: GRAPH_VERSION,
      updated_at: new Date().toISOString(),
      usage: [
        '这是执行入口：先用自然语言需求检索收藏的 name/summary；没有匹配就停下来请人补充信息。',
        '有匹配时给出最符合的前三个让人确认；确认后用 id 读取 paths/<id>.json 的完整路径。',
        '语义相似度低于阈值的收藏只能作为「最接近」参考，不得自动执行，必须由人显式确认。',
        '执行时每个节点由模型判定是否达标；未达标就停止，不要跳过缺失的前置。',
      ],
      paths,
    }
    await writeAtomic(join(this.dir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`)
  }

  /** Absolute path of one screenshot, refusing names that leave its folder. */
  screenshotPath(nodeId: string, file: string): string | undefined {
    const clean = safeFile(file)
    if (clean === undefined) return undefined
    return join(this.dir, 'screenshots', safeId(nodeId), clean)
  }

  /** Save screenshot bytes and return the stored file name. */
  async writeScreenshot(nodeId: string, file: string, bytes: Uint8Array): Promise<string> {
    const folder = join(this.dir, 'screenshots', safeId(nodeId))
    await mkdir(folder, { recursive: true })
    const clean = safeFile(file) ?? `${randomUUID().slice(0, 8)}.png`
    await writeFile(join(folder, clean), bytes)
    return clean
  }

  /** Copy the bytes of an existing screenshot into another node's folder. */
  async copyScreenshot(fromNode: string, fromFile: string, toNode: string, toFile: string): Promise<void> {
    const source = this.screenshotPath(fromNode, fromFile)
    const target = this.screenshotPath(toNode, toFile)
    if (source === undefined || target === undefined || !existsSync(source)) return
    await mkdir(dirname(target), { recursive: true })
    await copyFile(source, target)
  }

  /** Delete one screenshot file; a missing file is fine. */
  async removeScreenshotFile(nodeId: string, file: string): Promise<void> {
    const target = this.screenshotPath(nodeId, file)
    if (target !== undefined) await rm(target, { force: true })
  }

  /** Read screenshot bytes for a model call or a route. */
  async readScreenshot(nodeId: string, file: string): Promise<Uint8Array | undefined> {
    const target = this.screenshotPath(nodeId, file)
    if (target === undefined) return undefined
    try {
      return await readFile(target)
    } catch {
      return undefined
    }
  }

  /** Read the operator's common-sense entries; a missing or broken file reads as empty. */
  async readCommonSense(): Promise<CommonSense> {
    const raw = JSON.parse(await readFile(join(this.dir, 'common-sense.json'), 'utf8').catch(() => 'null')) as unknown
    if (typeof raw !== 'object' || raw === null) return { entries: [] }
    const list = (raw as { entries?: unknown }).entries
    if (!Array.isArray(list)) return { entries: [] }
    const entries: CommonSenseEntry[] = []
    for (const item of list) {
      if (typeof item !== 'object' || item === null) continue
      const record = item as Record<string, unknown>
      if (typeof record.id !== 'string' || typeof record.text !== 'string') continue
      const images = Array.isArray(record.images)
        ? record.images.flatMap((image) => {
            if (typeof image !== 'object' || image === null) return []
            const entry = image as Record<string, unknown>
            return typeof entry.file === 'string'
              ? [{ file: entry.file, ...typeof entry.name === 'string' ? { name: entry.name } : {} }]
              : []
          })
        : []
      entries.push({ id: record.id, text: record.text, ...images.length === 0 ? {} : { images } })
    }
    return { entries }
  }

  /** Persist the common-sense area. The operator's page is the only writer. */
  async saveCommonSense(commonSense: CommonSense): Promise<void> {
    await writeFile(join(this.dir, 'common-sense.json'), JSON.stringify(commonSense, null, 2), 'utf8')
  }

  /** Store one common-sense image and return its stored file name. */
  async writeCommonSenseImage(file: string, bytes: Uint8Array): Promise<string> {
    const folder = join(this.dir, 'common-sense')
    await mkdir(folder, { recursive: true })
    const clean = safeFile(file) ?? `${randomUUID().slice(0, 8)}.png`
    await writeFile(join(folder, clean), bytes)
    return clean
  }

  /** Read one common-sense image, or undefined when it is gone. */
  async readCommonSenseImage(file: string): Promise<Uint8Array | undefined> {
    const clean = safeFile(file)
    if (clean === undefined) return undefined
    try {
      return await readFile(join(this.dir, 'common-sense', clean))
    } catch {
      return undefined
    }
  }

  /** Delete one common-sense image file; a missing file is fine. */
  async removeCommonSenseImage(file: string): Promise<void> {
    const clean = safeFile(file)
    if (clean !== undefined) await rm(join(this.dir, 'common-sense', clean), { force: true })
  }

  /** File size, used by the screenshot route. */
  async screenshotSize(nodeId: string, file: string): Promise<number | undefined> {
    const target = this.screenshotPath(nodeId, file)
    if (target === undefined) return undefined
    try {
      return (await stat(target)).size
    } catch {
      return undefined
    }
  }
}

/** Counts for the manifest. */
export function countsOf(snapshot: GraphSnapshot): GraphManifest['counts'] {
  return {
    nodes: snapshot.nodes.size,
    edges: snapshot.edges.length,
    paths: snapshot.paths.length,
    decisions: snapshot.decisions.length,
  }
}

/** Keep an id safe as a file name. */
export function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/gu, '_').slice(0, 120)
}

/** Keep a file name inside its folder. */
export function safeFile(file: string): string | undefined {
  const clean = basename(file).trim()
  if (clean === '' || clean === '.' || clean === '..' || clean.includes('\0')) return undefined
  return clean.slice(0, 160)
}

/** Content hash used to name uploaded screenshots without a timestamp dependency. */
export function screenshotDigest(bytes: Uint8Array): string {
  return createHash('sha1').update(bytes).digest('hex').slice(0, 10)
}
