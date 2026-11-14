/**
 * Local frame differencing for the preview-stage hover probe.
 *
 * The probe captures the same small rectangle before and after the pointer moves onto the
 * target. A pixel counts as changed only when its largest BGRA channel delta exceeds the
 * configured tolerance, so anti-aliasing and subpixel jitter do not produce a false
 * positive. The cursor shape is an auxiliary signal only: a hand cursor can appear without
 * a repaint, and many controls react with a border or background instead of a cursor.
 * @module @deepseek-ai/dsh-experimental-tool-computer-use/src/hover
 */

/** Tunables for {@link compareHoverFrames}. */
export interface HoverDiffOptions {
  /** Per-channel delta above which a pixel counts as changed. Default: 8. */
  readonly pixelTolerance?: number
  /** Minimum changed fraction of sampled pixels for feedback. Default: 0.02 (2%). */
  readonly minChangedRatio?: number
  /** Minimum changed sampled pixels for feedback. Default: 16. */
  readonly minChangedPixels?: number
  /** Sample every N pixels in each axis. Default: 2. */
  readonly sampleStride?: number
}

/** Result of comparing two BGRA frames. */
export interface HoverDiff {
  readonly width: number
  readonly height: number
  readonly sampledPixels: number
  readonly changedPixels: number
  readonly changedRatio: number
  readonly maxDelta: number
  readonly meanDelta: number
}

/** Cursor signal captured around the probe. */
export interface HoverCursorSignal {
  /** Cursor kind before the pointer moved, or `undefined` when hidden. */
  readonly before?: string
  /** Cursor kind after the pointer moved. */
  readonly after?: string
  /** True when the raw cursor handle changed. */
  readonly changed?: boolean
}

/** Model-facing hover judgement plus the numbers behind it. */
export interface HoverFeedback {
  readonly available: boolean
  readonly hasFeedback: boolean
  readonly confidence: 'likely' | 'none' | 'uncertain'
  readonly changedPixels: number
  readonly sampledPixels: number
  readonly changedRatio: number
  readonly pixelTolerance: number
  readonly cursorChanged: boolean
  readonly cursorBefore?: string
  readonly cursorAfter?: string
  /** True when the cursor landed on a hand-shaped cursor; never sufficient on its own. */
  readonly cursorAssist: boolean
  readonly summary: string
  /** Present when the probe could not produce a usable comparison. */
  readonly unavailableReason?: string
}

/** Native probe result before {@link judgeHoverFeedback}. */
export interface HoverProbeResult extends HoverFeedback {}

function readPixel(frame: Uint8Array, offset: number): readonly [number, number, number] {
  return [frame[offset] ?? 0, frame[offset + 1] ?? 0, frame[offset + 2] ?? 0]
}

/**
 * Compare two tightly packed BGRA frames of the same size.
 * @param before - baseline frame.
 * @param after - frame captured after the pointer moved.
 * @param width - frame width in pixels.
 * @param height - frame height in pixels.
 * @param options - tolerance and sampling tunables.
 * @returns changed-pixel statistics.
 * @throws when the frame sizes or dimensions disagree.
 */
export function compareHoverFrames(
  before: Uint8Array,
  after: Uint8Array,
  width: number,
  height: number,
  options: HoverDiffOptions = {},
): HoverDiff {
  const expected = width * height * 4
  if (width <= 0 || height <= 0 || before.byteLength !== expected || after.byteLength !== expected) {
    throw new Error('computer-use: hover frames are not the same size')
  }
  const tolerance = Math.max(0, Math.floor(options.pixelTolerance ?? 8))
  const stride = Math.max(1, Math.floor(options.sampleStride ?? 2))
  let sampled = 0
  let changed = 0
  let maxDelta = 0
  let sumDelta = 0
  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const offset = (y * width + x) * 4
      const [b0, g0, r0] = readPixel(before, offset)
      const [b1, g1, r1] = readPixel(after, offset)
      const delta = Math.max(Math.abs(b0 - b1), Math.abs(g0 - g1), Math.abs(r0 - r1))
      sampled += 1
      sumDelta += delta
      if (delta > maxDelta) maxDelta = delta
      if (delta > tolerance) changed += 1
    }
  }
  return {
    width,
    height,
    sampledPixels: sampled,
    changedPixels: changed,
    changedRatio: sampled === 0 ? 0 : changed / sampled,
    maxDelta,
    meanDelta: sampled === 0 ? 0 : sumDelta / sampled,
  }
}

/**
 * Decide whether a local difference is strong enough to call "hover feedback".
 *
 * Pixel change is the primary signal. The cursor is deliberately only an assist: a
 * shape change with no repaint cannot prove a hover state, and a repaint with no cursor
 * change is still valid feedback.
 * @param diff - statistics from {@link compareHoverFrames}.
 * @param options - the same thresholds used for the comparison.
 * @param cursor - optional cursor signal.
 * @returns structured judgement with a short model-facing summary.
 */
export function judgeHoverFeedback(
  diff: HoverDiff,
  options: HoverDiffOptions = {},
  cursor: HoverCursorSignal = {},
): HoverFeedback {
  const tolerance = Math.max(0, Math.floor(options.pixelTolerance ?? 8))
  const minRatio = Math.max(0, Math.min(1, options.minChangedRatio ?? 0.02))
  const minPixels = Math.max(1, Math.floor(options.minChangedPixels ?? 16))
  const cursorChanged = cursor.changed === true
  const cursorAssist = cursor.after === 'hand'
  const enoughPixels = diff.changedPixels >= minPixels && diff.changedRatio >= minRatio
  const hasFeedback = enoughPixels
  const confidence: HoverFeedback['confidence'] = hasFeedback
    ? (diff.changedRatio >= minRatio * 2 || cursorAssist ? 'likely' : 'likely')
    : (cursorAssist || cursorChanged ? 'uncertain' : 'none')
  const percent = (diff.changedRatio * 100).toFixed(2)
  const thresholdPercent = (minRatio * 100).toFixed(2)
  const cursorText = cursor.before === undefined && cursor.after === undefined
    ? 'cursor hidden'
    : `cursor ${cursor.before ?? 'hidden'}→${cursor.after ?? 'hidden'}${cursorChanged ? ' (changed)' : ''}`
  const summary = hasFeedback
    ? `Hover feedback detected: ${percent}% of sampled pixels changed (threshold ${thresholdPercent}%); ${cursorText}.`
    : cursorAssist
      ? `No pixel-level hover feedback: ${percent}% changed (threshold ${thresholdPercent}%); cursor became a hand, which is only an auxiliary signal.`
      : `No hover feedback: ${percent}% of sampled pixels changed (threshold ${thresholdPercent}%); ${cursorText}.`
  return {
    available: true,
    hasFeedback,
    confidence,
    changedPixels: diff.changedPixels,
    sampledPixels: diff.sampledPixels,
    changedRatio: diff.changedRatio,
    pixelTolerance: tolerance,
    cursorChanged,
    ...cursor.before === undefined ? {} : { cursorBefore: cursor.before },
    ...cursor.after === undefined ? {} : { cursorAfter: cursor.after },
    cursorAssist,
    summary,
  }
}

/**
 * Build the unavailable result used when no baseline frame exists or the probe failed.
 * @param reason - sanitized reason shown to the model.
 * @param options - thresholds, retained for the receipt.
 * @returns an `available:false` result.
 */
export function unavailableHoverFeedback(reason: string, options: HoverDiffOptions = {}): HoverFeedback {
  return {
    available: false,
    hasFeedback: false,
    confidence: 'uncertain',
    changedPixels: 0,
    sampledPixels: 0,
    changedRatio: 0,
    pixelTolerance: Math.max(0, Math.floor(options.pixelTolerance ?? 8)),
    cursorChanged: false,
    cursorAssist: false,
    summary: `Hover feedback was not sampled: ${reason}.`,
    unavailableReason: reason,
  }
}

/**
 * Model-facing one-liner for a preview result.
 * @param hover - probe result, when one was produced.
 * @returns summary text, or an empty string when no probe ran.
 */
export function hoverFeedbackText(hover: HoverFeedback | undefined): string {
  if (hover === undefined) return ''
  if (!hover.available) return ` ${hover.summary}`
  return hover.hasFeedback
    ? ` Hover feedback detected · clickable. ${hover.summary}`
    : ` No hover feedback detected. ${hover.summary}`
}
