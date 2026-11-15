/**
 * Validated Computer Use tunables from cordis.yml.
 * Every hardening feature has a switch and a backwards-compatible default: all are on,
 * and omitting the whole section keeps the previous behavior except for the new safety
 * checks.
 * @module @deepseek-ai/dsh-experimental-tool-computer-use/src/config
 */

import z from '@deepseek-ai/schemastery'

/** Loader-accepted Computer Use configuration. */
export interface Config {
  /**
   * Milliseconds to wait after a GUI action before inspect and pixel capture, so open menus are listed.
   * Default: 600.
   */
  readonly postActionWaitMs?: number
  /** Include the multi-monitor inventory in observation envelopes. Default: true. */
  readonly displayInventoryEnabled?: boolean
  /** Refuse a click while a modal window disables the foreground. Default: true. */
  readonly modalGuardEnabled?: boolean
  /** Sample the target environment before and after actions. Default: true. */
  readonly actionReceiptEnabled?: boolean
  /** Tolerated physical-pixel window movement before a receipt flags stale coordinates. Default: 2. */
  readonly actionRectTolerancePx?: number
  /** Try PrintWindow when BitBlt fails or returns an all-black/uniform frame. Default: true. */
  readonly captureFallbackEnabled?: boolean
  /** Allow the PrintWindow rescue path. Default: true; only effective with fallback enabled. */
  readonly printWindowEnabled?: boolean
  /** Call DwmFlush before every capture. Default: true. */
  readonly dwmFlushEnabled?: boolean
  /** Enable the preview-stage local hover diff. Default: true. */
  readonly hoverFeedbackEnabled?: boolean
  /**
   * Reuse the previous attachment when a capture is pixel-identical to it, so the model is not
   * sent the same image twice. Default: false — the post-action frame is the evidence that the
   * action changed (or failed to change) the screen, so dropping it trades verification for
   * tokens. Turn it on for long runs where the screen often stays identical.
   */
  readonly frameDedupEnabled?: boolean
  /** Per-channel BGRA delta that counts as a hover change. Default: 8. */
  readonly hoverPixelTolerance?: number
  /** Minimum changed fraction of sampled pixels for hover feedback. Default: 0.02. */
  readonly hoverMinChangedRatio?: number
  /** Minimum changed sampled pixels for hover feedback. Default: 16. */
  readonly hoverMinChangedPixels?: number
  /** Wait after moving onto a target before the hover frame. Default: 80. */
  readonly hoverSettleMs?: number
  /** Maximum code points kept in one model-facing string. Default: 512. */
  readonly modelTextMaxChars?: number
}

/** Config after defaults and load-time validation. */
export interface ResolvedComputerUseConfig {
  readonly postActionWaitMs: number
  readonly displayInventoryEnabled: boolean
  readonly modalGuardEnabled: boolean
  readonly actionReceiptEnabled: boolean
  readonly actionRectTolerancePx: number
  readonly captureFallbackEnabled: boolean
  readonly printWindowEnabled: boolean
  readonly dwmFlushEnabled: boolean
  readonly hoverFeedbackEnabled: boolean
  /** Pixel-identical captures reuse the previous attachment instead of a second copy. */
  readonly frameDedupEnabled: boolean
  readonly hoverPixelTolerance: number
  readonly hoverMinChangedRatio: number
  readonly hoverMinChangedPixels: number
  readonly hoverSettleMs: number
  readonly modelTextMaxChars: number
}

/** Loader schema for the Computer Use plugin. */
export const Config: z<Config> = z.object({
  postActionWaitMs: z.number().default(600),
  displayInventoryEnabled: z.boolean().default(true),
  modalGuardEnabled: z.boolean().default(true),
  actionReceiptEnabled: z.boolean().default(true),
  actionRectTolerancePx: z.number().default(2),
  captureFallbackEnabled: z.boolean().default(true),
  printWindowEnabled: z.boolean().default(true),
  dwmFlushEnabled: z.boolean().default(true),
  hoverFeedbackEnabled: z.boolean().default(true),
  frameDedupEnabled: z.boolean().default(false),
  hoverPixelTolerance: z.number().default(8),
  hoverMinChangedRatio: z.number().default(0.02),
  hoverMinChangedPixels: z.number().default(16),
  hoverSettleMs: z.number().default(80),
  modelTextMaxChars: z.number().default(512),
})

function requireFiniteNonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a finite number ≥ 0`)
  }
  return value
}

function requireUnitInterval(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be a finite number between 0 and 1`)
  }
  return value
}

function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}

/**
 * Apply defaults and reject invalid tunables at load.
 * @param config - plugin config, possibly partial.
 * @returns resolved tunables.
 */
export function resolveComputerUseConfig(config: Config = {}): ResolvedComputerUseConfig {
  return {
    postActionWaitMs: requireFiniteNonNegative(config.postActionWaitMs ?? 600, 'postActionWaitMs'),
    displayInventoryEnabled: config.displayInventoryEnabled ?? true,
    modalGuardEnabled: config.modalGuardEnabled ?? true,
    actionReceiptEnabled: config.actionReceiptEnabled ?? true,
    actionRectTolerancePx: requireFiniteNonNegative(config.actionRectTolerancePx ?? 2, 'actionRectTolerancePx'),
    captureFallbackEnabled: config.captureFallbackEnabled ?? true,
    printWindowEnabled: config.printWindowEnabled ?? true,
    dwmFlushEnabled: config.dwmFlushEnabled ?? true,
    hoverFeedbackEnabled: config.hoverFeedbackEnabled ?? true,
    frameDedupEnabled: config.frameDedupEnabled ?? false,
    hoverPixelTolerance: requireFiniteNonNegative(config.hoverPixelTolerance ?? 8, 'hoverPixelTolerance'),
    hoverMinChangedRatio: requireUnitInterval(config.hoverMinChangedRatio ?? 0.02, 'hoverMinChangedRatio'),
    hoverMinChangedPixels: requirePositiveInteger(config.hoverMinChangedPixels ?? 16, 'hoverMinChangedPixels'),
    hoverSettleMs: requireFiniteNonNegative(config.hoverSettleMs ?? 80, 'hoverSettleMs'),
    modelTextMaxChars: requirePositiveInteger(config.modelTextMaxChars ?? 512, 'modelTextMaxChars'),
  }
}
