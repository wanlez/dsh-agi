/**
 * Keyword matching for the experience graph.
 *
 * The vector channel is good at meaning but bad at short queries: "云电脑" scored 0.67
 * against the node titled "进入天翼云电脑", so the 0.75 threshold hid the exact answer.
 * This module is the second, independent channel: character-level, dependency-free, and
 * usable with no model at all.
 *
 * Score for one field:
 *
 *   base  = max( longest common substring / query length , bigram Dice of the whole field )
 *   score = min(1, base * field weight + (query is a full substring ? 0.05 : 0))
 *
 * The substring part is what makes a longer exact query never score below a shorter one;
 * the Dice part still finds queries whose characters appear but not in one run. Both
 * comparisons are capped (query 64, clause 512 characters) so a long note cannot blow up
 * the DP.
 */

/** Longest query the bounded DP runs on. A longer query keeps its first 64 characters. */
const QUERY_LIMIT = 64

/** Longest single clause the DP runs on. Full-substring checks still read the whole field. */
const SEGMENT_LIMIT = 512

/** How many clauses of one field are scored; very long notes are cut off after this. */
const SEGMENT_COUNT = 12

/** Characters kept around a hit in the snippet the editor renders. */
const SNIPPET_CONTEXT = 24

/** A full-substring hit gets this bonus on top of the weighted base score. */
const SUBSTRING_BONUS = 0.05

/** Default lowest keyword score that is not treated as noise. */
export const KEYWORD_FLOOR = 0.2

/** Default number of keyword candidates returned next to the semantic ones. */
export const KEYWORD_TOP = 20

/**
 * How much each field counts. A title hit is stronger evidence than the same words buried
 * in a long description, so a short common word cannot lift every note to a perfect score.
 */
const FIELD_WEIGHT: Readonly<Record<string, number>> = {
  title: 1,
  name: 1,
  summary: 0.9,
  description: 0.9,
  screenshot: 0.85,
}

/** One piece of text that takes part in a keyword match. */
export interface KeywordField {
  readonly field: string
  readonly text: string
}

/** The best hit of one query in one text. */
export interface KeywordMatch {
  /** 0..1, rounded to four decimals. */
  readonly score: number
  /** Which field produced the hit, e.g. `title` or `description`. */
  readonly field: string
  /** The matched run, copied verbatim from the field (safe to highlight). */
  readonly fragment: string
  /** The fragment with a little context, for the editor's hit line. */
  readonly snippet: string
}

/** Kept characters: anything that is a letter or a number, in any script. */
const WORD_CHARACTER = /^[\p{L}\p{N}]$/u

interface NormalizedText {
  readonly text: string
  /** For every kept character, its offset in the source string. */
  readonly origin: readonly number[]
}

/**
 * Lowercase, NFKC, and drop whitespace/punctuation/symbols, keeping letters and digits.
 * The origin table lets a hit found in the normalized text be highlighted in the source.
 */
function normalize(text: string): NormalizedText {
  const characters: string[] = []
  const origin: number[] = []
  let offset = 0
  for (const character of text) {
    const width = character.length
    for (const part of character.normalize('NFKC').toLowerCase()) {
      if (WORD_CHARACTER.test(part)) {
        characters.push(part)
        origin.push(offset)
      }
    }
    offset += width
  }
  return { text: characters.join(''), origin }
}

/**
 * Normalize one text the same way scoring does: lowercase, no spaces, no punctuation.
 * @param text - any user or node text.
 * @returns the comparable form; an empty text becomes an empty string.
 */
export function normalizeKeywordText(text: string): string {
  return normalize(text).text
}

/** One contiguous run found in a text. */
interface Run {
  readonly length: number
  readonly start: number
  readonly end: number
}

/**
 * Longest common substring of two already-normalized texts, with its end offset in
 * `text`. Rolling rows keep it O(len(query) * len(text)) in bounded memory.
 */
function commonSubstring(query: string, text: string): Run {
  const width = Math.max(0, Math.min(text.length, SEGMENT_LIMIT))
  if (query === '' || width === 0) return { length: 0, start: 0, end: 0 }
  const height = Math.min(query.length, QUERY_LIMIT)
  let previous = new Uint16Array(width + 1)
  let current = new Uint16Array(width + 1)
  let best = 0
  let bestEnd = 0
  for (let row = 1; row <= height; row += 1) {
    const code = query.charCodeAt(row - 1)
    for (let column = 1; column <= width; column += 1) {
      if (code === text.charCodeAt(column - 1)) {
        const value = previous[column - 1] + 1
        current[column] = value
        if (value > best) {
          best = value
          bestEnd = column
        }
      } else {
        current[column] = 0
      }
    }
    const swap = previous
    previous = current
    current = swap
  }
  return { length: best, start: bestEnd - best, end: bestEnd }
}

/**
 * Length of the longest common substring after the same normalization scoring uses.
 * Bounded to the query and clause limits, so it is safe on arbitrary note text.
 * @param left - first text.
 * @param right - second text.
 * @returns the run length in normalized characters.
 */
export function longestCommonSubstringLength(left: string, right: string): number {
  return commonSubstring(normalize(left).text, normalize(right).text).length
}

/** Character-bigram counts of a normalized text. */
function bigrams(text: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (let index = 0; index + 1 < text.length; index += 1) {
    const gram = text.slice(index, index + 2)
    counts.set(gram, (counts.get(gram) ?? 0) + 1)
  }
  return counts
}

/** Dice coefficient of two bigram multisets: 2·overlap / (|left| + |right|). */
function dice(left: Map<string, number>, right: Map<string, number>): number {
  if (left.size === 0 || right.size === 0) return 0
  let overlap = 0
  let leftTotal = 0
  let rightTotal = 0
  for (const count of left.values()) leftTotal += count
  for (const count of right.values()) rightTotal += count
  for (const [gram, count] of left) overlap += Math.min(count, right.get(gram) ?? 0)
  return (2 * overlap) / (leftTotal + rightTotal)
}

/** Clamp and round a score for display and stable sorting. */
function rounded(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 10_000) / 10_000
}

/** Offset just past the code point that starts at `index`. */
function after(source: string, index: number): number {
  const code = source.codePointAt(index) ?? 0
  return index + (code > 0xffff ? 2 : 1)
}

/** Cut the source around a hit into one readable line with the fragment inside. */
function snippetOf(source: string, from: number, to: number): string {
  const left = Math.max(0, from - SNIPPET_CONTEXT)
  const right = Math.min(source.length, to + SNIPPET_CONTEXT)
  const body = source.slice(left, right).replace(/\s+/gu, ' ').trim()
  return `${left > 0 ? '…' : ''}${body}${right < source.length ? '…' : ''}`
}

/** Clause boundaries: newlines, Chinese and ASCII sentence punctuation, arrows. */
const CLAUSE = /[^\n。；;，,！!？?：:→]+/gu

/**
 * Split a long text into clauses with their source offsets, bounded to SEGMENT_COUNT.
 * Scoring per clause both bounds the DP and gives a tighter highlight.
 */
function clausesOf(text: string): readonly { readonly text: string, readonly start: number }[] {
  if (text.length <= SEGMENT_LIMIT) return [{ text, start: 0 }]
  const result: { text: string, start: number }[] = []
  CLAUSE.lastIndex = 0
  for (let match = CLAUSE.exec(text); match !== null && result.length < SEGMENT_COUNT; match = CLAUSE.exec(text)) {
    const value = match[0]
    if (value.trim() === '') continue
    result.push({ text: value, start: match.index })
  }
  return result.length === 0 ? [{ text, start: 0 }] : result
}

/** One hit in one field: the normalized score before the field weight and bonus. */
interface FieldHit {
  readonly base: number
  readonly start: number
  readonly end: number
}

/**
 * Best LCS run of the query inside one clause, with offsets relative to the clause.
 * `queryLength` is the normalized query length, used as the ratio denominator.
 */
function runInClause(query: string, queryLength: number, clause: string): FieldHit | undefined {
  const normalized = normalize(clause)
  if (normalized.text === '') return undefined
  const run = commonSubstring(query, normalized.text)
  if (run.length === 0) return undefined
  return {
    base: run.length / Math.max(1, queryLength),
    start: normalized.origin[run.start] as number,
    end: after(clause, normalized.origin[run.end - 1] as number),
  }
}

/** First matched bigram in the field, used to point at a Dice-only hit. */
function bigramPosition(query: string, target: string): Run | undefined {
  for (let index = 0; index + 1 < query.length; index += 1) {
    const found = target.indexOf(query.slice(index, index + 2))
    if (found !== -1) return { length: 2, start: found, end: found + 2 }
  }
  return undefined
}

/**
 * Score one query against a list of fields.
 *
 * Every field is normalized, checked for full containment first (unbounded and cheap),
 * then scored clause by clause for the bounded LCS and once for the whole-field Dice.
 * The best weighted score wins; ties keep the earlier field, and callers pass the
 * title/name first.
 *
 * @param query - the operator's text.
 * @param fields - field name plus text, most important first.
 * @returns the best hit, or null when the query shares nothing usable with the fields.
 */
export function keywordMatch(query: string, fields: readonly KeywordField[]): KeywordMatch | null {
  const normalizedQuery = normalize(query)
  if (normalizedQuery.text === '') return null
  const queryText = normalizedQuery.text
  const queryGrams = bigrams(queryText)
  let best: KeywordMatch | null = null

  for (const field of fields) {
    const source = field.text
    if (source.trim() === '') continue
    const weight = FIELD_WEIGHT[field.field] ?? 1
    const normalized = normalize(source)
    if (normalized.text === '') continue

    let base = 0
    let start = 0
    let end = 0
    const at = normalized.text.indexOf(queryText)
    const contained = at !== -1
    if (contained) {
      base = 1
      start = normalized.origin[at] as number
      end = after(source, normalized.origin[at + queryText.length - 1] as number)
    } else {
      for (const clause of clausesOf(source)) {
        const hit = runInClause(queryText, queryText.length, clause.text)
        if (hit === undefined || hit.base <= base) continue
        base = hit.base
        start = clause.start + hit.start
        end = clause.start + hit.end
      }
      const overlap = dice(queryGrams, bigrams(normalized.text))
      if (overlap > base) {
        const run = commonSubstring(queryText, normalized.text)
        const position = run.length > 0 ? run : bigramPosition(queryText, normalized.text)
        if (position !== undefined) {
          base = overlap
          start = normalized.origin[position.start] as number
          end = after(source, normalized.origin[position.end - 1] as number)
        }
      }
    }
    if (base <= 0 || end <= start) continue
    const score = rounded(base * weight + (contained ? SUBSTRING_BONUS : 0))
    if (best !== null && score <= best.score) continue
    best = {
      score,
      field: field.field,
      fragment: source.slice(start, end),
      snippet: snippetOf(source, start, end),
    }
  }
  return best
}

/**
 * Convenience form for one text, using the default weight.
 * @param query - the operator's text.
 * @param text - one field to compare against.
 * @returns 0..1; 0 means nothing shared.
 */
export function keywordScore(query: string, text: string): number {
  return keywordMatch(query, [{ field: 'text', text }])?.score ?? 0
}
