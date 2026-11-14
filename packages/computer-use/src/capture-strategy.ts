/**
 * Capture backend selection: DwmFlush, BitBlt, and the PrintWindow rescue path.
 *
 * BitBlt reads the screen DC and is the normal backend. GPU-composited windows, Chromium
 * surfaces, and some UWP frames can return a successful but uniformly black bitmap, so the
 * bitmap is sampled before it is accepted. A failed BitBlt or a degenerate bitmap switches
 * to `PrintWindow(PW_RENDERFULLCONTENT)` when a target HWND is available. The original
 * BitBlt frame is still returned if the rescue attempt fails.
 *
 * DXGI Desktop Duplication is deliberately not implemented here: the current koffi-only
 * surface has no COM/D3D bindings, and adding them means a native module or a long koffi
 * COM bridge. That is a larger project than the PrintWindow fallback and is tracked as a
 * known capability gap rather than attempted half-way.
 * @module @deepseek-ai/dsh-experimental-tool-computer-use/src/capture-strategy
 */

/** Backend that produced the accepted frame. */
export type CaptureBackend = 'bitblt' | 'printwindow'

/** Why a rescue backend was tried. */
export type CaptureFallbackReason = 'bitblt-failed' | 'bitblt-degenerate'

/** Result of one capture attempt chain. */
export interface CaptureChoice<T> {
  readonly data: T
  readonly backend: CaptureBackend
  readonly fallbackReason?: CaptureFallbackReason
  /** True when a PrintWindow attempt actually ran, whether it succeeded or not. */
  readonly printWindowAttempted: boolean
  /** True when PrintWindow ran but its own frame was also degenerate. */
  readonly printWindowDegenerate: boolean
  /** `DwmFlush` was called; `failed` is silent in production but visible to diagnostics. */
  readonly dwmFlush: 'ok' | 'failed'
  /** Present when a rescue was attempted and rejected. */
  readonly rescueError?: string
}

/** Callbacks for {@link captureWithFallback}. */
export interface CaptureFallbackInput<T> {
  /** True to try PrintWindow after a failed/degenerate BitBlt. */
  readonly enabled: boolean
  /** Wait for one composition before sampling. */
  readonly dwmFlush: () => void
  readonly bitblt: () => T
  /** PrintWindow path; omitted when no HWND is available. */
  readonly printWindow?: () => T
  /** Content check for one captured bitmap. */
  readonly isDegenerate?: (value: T) => boolean
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Run the fallback chain in the required order:
 * `DwmFlush` → BitBlt → (on failure or degenerate frame) PrintWindow.
 *
 * A DwmFlush failure is ignored. A PrintWindow failure or degenerate rescue frame returns
 * the original successful BitBlt frame, because a black frame is still more useful for
 * diagnostics than an exception that loses the capture entirely.
 * @param input - capture callbacks and enable flag.
 * @returns accepted frame and a trace of what ran.
 * @throws when BitBlt fails and no rescue frame can be produced.
 */
export function captureWithFallback<T>(input: CaptureFallbackInput<T>): CaptureChoice<T> {
  let flush: CaptureChoice<T>['dwmFlush'] = 'ok'
  try {
    input.dwmFlush()
  } catch {
    // DwmFlush can fail or block on remote sessions; capture still proceeds.
    flush = 'failed'
  }
  let bitbltFrame: T
  try {
    bitbltFrame = input.bitblt()
  } catch (bitbltError: unknown) {
    if (!input.enabled || input.printWindow === undefined) {
      throw new Error(`computer-use: screen capture failed: ${errorText(bitbltError)}`)
    }
    try {
      const rescued = input.printWindow()
      return {
        data: rescued,
        backend: 'printwindow',
        fallbackReason: 'bitblt-failed',
        printWindowAttempted: true,
        printWindowDegenerate: input.isDegenerate?.(rescued) === true,
        dwmFlush: flush,
      }
    } catch (rescueError: unknown) {
      throw new Error(
        `computer-use: screen capture failed: BitBlt: ${errorText(bitbltError)}; PrintWindow: ${errorText(rescueError)}`,
      )
    }
  }
  const degenerate = input.isDegenerate?.(bitbltFrame) === true
  if (!degenerate || !input.enabled || input.printWindow === undefined) {
    return {
      data: bitbltFrame,
      backend: 'bitblt',
      printWindowAttempted: false,
      printWindowDegenerate: false,
      dwmFlush: flush,
    }
  }
  try {
    const rescued = input.printWindow()
    const rescueDegenerate = input.isDegenerate?.(rescued) === true
    return {
      data: rescued,
      backend: 'printwindow',
      fallbackReason: 'bitblt-degenerate',
      printWindowAttempted: true,
      printWindowDegenerate: rescueDegenerate,
      dwmFlush: flush,
    }
  } catch (rescueError: unknown) {
    return {
      data: bitbltFrame,
      backend: 'bitblt',
      fallbackReason: 'bitblt-degenerate',
      printWindowAttempted: true,
      printWindowDegenerate: false,
      dwmFlush: flush,
      rescueError: errorText(rescueError),
    }
  }
}

/** Options for {@link bitmapLooksDegenerate}. */
export interface DegenerateBitmapOptions {
  /** Maximum pixels sampled. Default: 4096. */
  readonly sampleLimit?: number
  /** Maximum per-channel value still considered black. Default: 8. */
  readonly blackThreshold?: number
  /** Fraction of black samples at or above which the frame is suspect. Default: 0.998. */
  readonly blackRatioThreshold?: number
  /** Fraction of one repeated color at or above which the frame is suspect. Default: 0.998. */
  readonly uniformRatioThreshold?: number
}

/** Why a bitmap was judged degenerate. */
export interface DegenerateBitmapResult {
  readonly degenerate: boolean
  readonly reason?: 'black' | 'uniform'
  readonly sampled: number
  readonly blackRatio: number
  readonly uniformRatio: number
  readonly maxColorCount: number
}

/**
 * Sample a top-down BGRA bitmap and flag an all-black or single-color frame.
 *
 * The sample is deliberately sparse: a 4K frame is reduced to at most roughly 4096
 * pixels, so the check costs almost nothing relative to the capture. Alpha is ignored
 * because BitBlt from a screen DC normally leaves it at zero.
 * @param pixels - tightly packed BGRA pixels.
 * @param width - bitmap width.
 * @param height - bitmap height.
 * @param options - thresholds.
 * @returns statistical judgement.
 * @throws when the buffer is smaller than `width * height * 4`.
 */
export function bitmapLooksDegenerate(
  pixels: Uint8Array,
  width: number,
  height: number,
  options: DegenerateBitmapOptions = {},
): DegenerateBitmapResult {
  if (width <= 0 || height <= 0) return { degenerate: false, sampled: 0, blackRatio: 0, uniformRatio: 0, maxColorCount: 0 }
  if (pixels.byteLength < width * height * 4) {
    throw new Error('computer-use: bitmap is smaller than its declared dimensions')
  }
  const limit = Math.max(64, Math.floor(options.sampleLimit ?? 4096))
  const blackThreshold = Math.max(0, Math.floor(options.blackThreshold ?? 8))
  const blackRatioThreshold = Math.max(0, Math.min(1, options.blackRatioThreshold ?? 0.998))
  const uniformRatioThreshold = Math.max(0, Math.min(1, options.uniformRatioThreshold ?? 0.998))
  const total = width * height
  const stride = Math.max(1, Math.floor(Math.sqrt(total / limit)))
  const counts = new Map<number, number>()
  let sampled = 0
  let black = 0
  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const offset = (y * width + x) * 4
      const b = pixels[offset] ?? 0
      const g = pixels[offset + 1] ?? 0
      const r = pixels[offset + 2] ?? 0
      sampled += 1
      if (b <= blackThreshold && g <= blackThreshold && r <= blackThreshold) black += 1
      const key = (b << 16) | (g << 8) | r
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  let maxColorCount = 0
  for (const count of counts.values()) if (count > maxColorCount) maxColorCount = count
  const blackRatio = sampled === 0 ? 0 : black / sampled
  const uniformRatio = sampled === 0 ? 0 : maxColorCount / sampled
  if (blackRatio >= blackRatioThreshold) {
    return { degenerate: true, reason: 'black', sampled, blackRatio, uniformRatio, maxColorCount }
  }
  if (uniformRatio >= uniformRatioThreshold) {
    return { degenerate: true, reason: 'uniform', sampled, blackRatio, uniformRatio, maxColorCount }
  }
  return { degenerate: false, sampled, blackRatio, uniformRatio, maxColorCount }
}
