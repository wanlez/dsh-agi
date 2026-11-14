/**
 * Model-facing text hygiene and the three-state observation vocabulary.
 *
 * Everything that reaches a model — window titles, control names, page text, and error
 * strings — passes through {@link sanitizeModelText}. The function removes Unicode private
 * use areas, repairs lone surrogates, escapes line breaks, and truncates with an explicit
 * marker so the model never mistakes a clipped value for the whole value.
 *
 * Observation results use {@link ObservationState}: `provided` means the value was
 * sampled, `empty` means it was sampled and genuinely had no value, and `unsampled` means
 * the value was never obtained (permission, timeout, unsupported platform). The distinction
 * stops "could not read" from being presented as "there is nothing there".
 * @module @deepseek-ai/dsh-experimental-tool-computer-use/src/text-sanitize
 */

/** How one observation field was obtained. */
export type ObservationState = 'provided' | 'unsampled' | 'empty'

/** Per-field states carried by one observation envelope. */
export interface ObservationStatus {
  readonly foreground: ObservationState
  readonly windowTitle: ObservationState
  readonly capture: ObservationState
  readonly displayInventory: ObservationState
}

/** Envelope-wide default when a backend cannot report individual states. */
export const UNKNOWN_OBSERVATION_STATUS: ObservationStatus = {
  foreground: 'unsampled',
  windowTitle: 'unsampled',
  capture: 'unsampled',
  displayInventory: 'unsampled',
}

/** Default maximum length of one model-facing string, in code points. */
export const DEFAULT_MODEL_TEXT_MAX_CHARS = 512

/** Options for {@link sanitizeModelText}. */
export interface SanitizeModelTextOptions {
  /** Maximum code points kept before truncation. Default: {@link DEFAULT_MODEL_TEXT_MAX_CHARS}. */
  readonly maxChars?: number
}

function isPrivateUse(codePoint: number): boolean {
  return (codePoint >= 0xe000 && codePoint <= 0xf8ff)
    || (codePoint >= 0xf0000 && codePoint <= 0xffffd)
    || (codePoint >= 0x100000 && codePoint <= 0x10fffd)
}

function isLoneSurrogate(codePoint: number): boolean {
  return codePoint >= 0xd800 && codePoint <= 0xdfff
}

function isDroppedControl(codePoint: number): boolean {
  // NUL, C0 controls (except TAB/LF/CR), DEL, and C1 controls. Keep ordinary spaces.
  return codePoint === 0
    || (codePoint >= 0x01 && codePoint <= 0x08)
    || codePoint === 0x0b
    || codePoint === 0x0c
    || (codePoint >= 0x0e && codePoint <= 0x1f)
    || (codePoint >= 0x7f && codePoint <= 0x9f)
}

function countCodePoints(value: string): number {
  return Array.from(value).length
}

/**
 * Remove private-use characters, replace lone surrogates, replace dropped controls with a
 * space, escape newlines and tabs, and truncate with an explicit marker.
 * @param input - raw text from a window, error, page, or tool result.
 * @param options - optional truncation length.
 * @returns a single-line, valid-Unicode string safe to place in the model envelope.
 */
export function sanitizeModelText(
  input: string,
  options: SanitizeModelTextOptions = {},
): string {
  const maxChars = Number.isFinite(options.maxChars) && (options.maxChars ?? 0) > 0
    ? Math.max(16, Math.floor(options.maxChars ?? DEFAULT_MODEL_TEXT_MAX_CHARS))
    : DEFAULT_MODEL_TEXT_MAX_CHARS
  let repaired = ''
  for (const character of input) {
    const codePoint = character.codePointAt(0)
    if (codePoint === undefined) continue
    if (isLoneSurrogate(codePoint)) {
      repaired += '\uFFFD'
      continue
    }
    if (isPrivateUse(codePoint)) continue
    if (isDroppedControl(codePoint)) {
      repaired += ' '
      continue
    }
    repaired += character
  }
  const escaped = repaired
    .replace(/\r\n?/gu, '\n')
    .replace(/\n/gu, '\\n')
    .replace(/\t/gu, '\\t')
  const length = countCodePoints(escaped)
  if (length <= maxChars) return escaped
  const kept = Array.from(escaped).slice(0, maxChars).join('')
  return `${kept}…[truncated ${String(length - maxChars)} chars]`
}

/**
 * Build one state from whether sampling succeeded and whether the sampled value was empty.
 * @param sampled - true when the producer ran and returned a value.
 * @param empty - true when the sampled value has no content.
 * @returns `unsampled`, `empty`, or `provided`.
 */
export function observationState(sampled: boolean, empty: boolean): ObservationState {
  if (!sampled) return 'unsampled'
  return empty ? 'empty' : 'provided'
}

/**
 * Format a status map as one compact, sanitized envelope line.
 * @param status - per-field states.
 * @returns model-facing `<observation_status>` text.
 */
export function formatObservationStatus(status: ObservationStatus): string {
  return '<observation_status>'
    + `foreground=${status.foreground};`
    + `window_title=${status.windowTitle};`
    + `capture=${status.capture};`
    + `display_inventory=${status.displayInventory}`
    + '</observation_status>'
}

function sanitizeJsonNode(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') return sanitizeModelText(value)
  if (typeof value === 'bigint') return sanitizeModelText(value.toString())
  if (typeof value === 'undefined') return null
  if (typeof value === 'function' || typeof value === 'symbol') return null
  if (depth > 12) return '[max-depth]'
  if (value instanceof Error) {
    return { name: sanitizeModelText(value.name), message: sanitizeModelText(value.message) }
  }
  if (typeof value === 'object') {
    if (seen.has(value)) return '[circular]'
    seen.add(value)
    try {
      if (Array.isArray(value)) {
        return value.map(item => sanitizeJsonNode(item, seen, depth + 1))
      }
      const result: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(value)) {
        result[sanitizeModelText(key, { maxChars: 80 })] = sanitizeJsonNode(item, seen, depth + 1)
      }
      return result
    } finally {
      seen.delete(value)
    }
  }
  return null
}

/**
 * Sanitize an arbitrary value before JSON serialization.
 *
 * Strings are passed through {@link sanitizeModelText}; arrays and plain objects are
 * walked, cycles become `"[circular]"`, non-finite numbers become `null`, and errors
 * become safe `{name,message}` records.
 * @param value - value that may contain user-controlled text.
 * @returns a JSON-safe clone.
 */
export function sanitizeJsonValue(value: unknown): unknown {
  return sanitizeJsonNode(value, new WeakSet<object>(), 0)
}

/**
 * Serialize a value after sanitizing every string in it.
 * The function never throws: a failed serialization returns a small JSON error object.
 * @param value - value to serialize.
 * @param space - indentation passed to `JSON.stringify`.
 * @returns safe JSON text.
 */
export function safeJsonStringify(value: unknown, space?: number): string {
  try {
    return JSON.stringify(sanitizeJsonValue(value), undefined, space) ?? 'null'
  } catch {
    return '{"error":"serialization-failed"}'
  }
}
