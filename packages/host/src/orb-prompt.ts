/**
 * The ball page's prompt frame. The helper forwards it verbatim over the socket,
 * so this module is the one place that decides what a typed line means.
 */

/** Delivery mode a typed prompt asks the host for. */
export type OrbPromptMode = 'steer' | 'interrupt'

/** One validated prompt frame from the ball page. */
export interface OrbPromptFrame {
  /** Trimmed user text, at most {@link ORB_PROMPT_LIMIT} characters. */
  readonly text: string
  /** How the line reaches the agent. */
  readonly mode: OrbPromptMode
}

/** Longest text one typed prompt may carry; the page enforces the same cap. */
export const ORB_PROMPT_LIMIT = 8_000

/**
 * Validate one prompt frame from the page. A missing or unknown delivery mode
 * reads as `interrupt`, which is what every page before steering sent; an older
 * helper sends the bare string.
 * @param message - one decoded socket message.
 * @returns the frame, or undefined when this is not a prompt or its text is empty.
 */
export function readOrbPrompt(message: unknown): OrbPromptFrame | undefined {
  if (typeof message !== 'object' || message === null) return undefined
  const record = message as { type?: unknown; text?: unknown; mode?: unknown }
  if (record.type !== 'prompt' || typeof record.text !== 'string') return undefined
  if (record.text.length > ORB_PROMPT_LIMIT) return undefined
  const text = record.text.trim()
  if (text === '') return undefined
  return { text, mode: record.mode === 'steer' ? 'steer' : 'interrupt' }
}
