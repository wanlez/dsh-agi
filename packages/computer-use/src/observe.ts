/**
 * Capture the frontmost window, persist it, and build model-facing image content.
 * @module @deepseek-ai/dsh-experimental-tool-computer-use/src/observe
 */

import type { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { CapturedScreen, DesktopBackend, DesktopForeground, ScreenInfo } from './backend.ts'
import { FOCUS_FALLBACK_FOREGROUND } from './backend.ts'
import type { CoordinateMode } from './coordinate-mode.ts'
import {
  formatDisplayInventoryEnvelope,
  type DisplayInventory,
} from './display-inventory.ts'
import {
  DEFAULT_MODEL_TEXT_MAX_CHARS,
  formatObservationStatus,
  observationState,
  sanitizeModelText,
  UNKNOWN_OBSERVATION_STATUS,
  type ObservationStatus,
} from './text-sanitize.ts'
import { delay } from './wait.ts'

/** Canonical image metadata stored beside one captured screen. */
export interface ObservedImage {
  attachmentId: string
  mediaType: ImageMediaType
  bytes: number
  width: number
  height: number
  name?: string
  originalDimensions?: {
    width: number
    height: number
  }
}

/** One captured display plus its durable attachment. */
export interface ObservedScreen {
  screenIndex: number
  logicalWidth: number
  logicalHeight: number
  scale: number
  /** Owner window of this surface; Windows hands focus back to it for a hotkey. HWND/CGWindowID. */
  windowId?: number
  /** Extra window ids the surface included (menus and other family windows). */
  transientWindowIds?: number[]
  /** App owning {@link windowId}, for the hotkey focus error message. */
  appName?: string
  image: ObservedImage
}

/** Capture outcome used by first-frame notices and GUI tool results. */
export interface DesktopObservation {
  readonly screens: readonly ObservedScreen[]
  readonly foreground: DesktopForeground
  readonly blocks: ContentBlock[]
  /** Encoded rasters in the same order as {@link screens}, before attachment downscale. */
  readonly captures: readonly CapturedScreen[]
  /** Multi-monitor inventory when the backend supplied one. */
  readonly displayInventory?: DisplayInventory
  /** Per-field sampling state for the observation envelope. */
  readonly status: ObservationStatus
}

const IMAGE_NAME_PREFIX = 'desktop-screen'

function isObservationAbort(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true
  return error instanceof Error && error.name === 'AbortError'
}

/**
 * Keep the optional stored-image metadata (`name`, `originalDimensions`) off the
 * attachment reference when the store did not report it.
 */
export function optionalImageFields(image: {
  name?: string
  originalDimensions?: { width: number; height: number }
}): Pick<ObservedImage, 'name' | 'originalDimensions'> {
  return {
    ...image.name === undefined ? {} : { name: image.name },
    ...image.originalDimensions === undefined ? {} : {
      originalDimensions: { ...image.originalDimensions },
    },
  }
}

/**
 * Re-brand stored image metadata into the attachment reference an `ImageBlock` carries.
 * @param image - canonical image metadata.
 * @returns the branded attachment reference.
 */
export function imageRefFromObserved(image: ObservedImage): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId(image.attachmentId),
    mediaType: image.mediaType,
    bytes: image.bytes,
    width: image.width,
    height: image.height,
    ...optionalImageFields(image),
  }
}

/**
 * Format OS foreground metadata as one observation-level envelope.
 * Every value is sanitized before it enters the model. Empty folder, title, and note fields
 * are omitted. Screenshot filesystem paths are never included.
 * @param foreground - inspect result after overlay-window skip.
 * @param maxChars - maximum code points per field.
 * @returns model-facing tags for app name, optional window title, optional Finder folder, or focus fallback.
 */
export function formatForegroundEnvelope(
  foreground: DesktopForeground,
  maxChars: number = DEFAULT_MODEL_TEXT_MAX_CHARS,
): string {
  const appName = sanitizeModelText(foreground.appName, { maxChars }).trim() || 'none'
  const lines = [`<frontmost_app>${appName}</frontmost_app>`]
  if (foreground.windowTitle !== undefined) {
    const title = sanitizeModelText(foreground.windowTitle, { maxChars }).trim()
    if (title !== '') lines.push(`<frontmost_window>${title}</frontmost_window>`)
  }
  if (foreground.focusNote !== undefined) {
    const note = sanitizeModelText(foreground.focusNote, { maxChars }).trim()
    if (note !== '') lines.push(`<focus_note>${note}</focus_note>`)
    return lines.join('\n')
  }
  if (foreground.finderFolder !== undefined) {
    const folder = sanitizeModelText(foreground.finderFolder, { maxChars }).trim()
    if (folder !== '') lines.push(`<frontmost_folder>${folder}</frontmost_folder>`)
  }
  return lines.join('\n')
}

/**
 * Copy foreground fields that schema validation accepts (`undefined` keys omitted).
 * @param foreground - inspect result stored on the observation.
 * @returns a tool-output object with only defined optional fields.
 */
export function compactForeground(foreground: DesktopForeground): DesktopForeground {
  const appName = sanitizeModelText(foreground.appName, { maxChars: 200 })
  return {
    appName,
    ...foreground.windowTitle === undefined
      ? {}
      : { windowTitle: sanitizeModelText(foreground.windowTitle, { maxChars: 512 }) },
    ...foreground.finderFolder === undefined
      ? {}
      : { finderFolder: sanitizeModelText(foreground.finderFolder, { maxChars: 512 }) },
    ...foreground.focusNote === undefined
      ? {}
      : { focusNote: sanitizeModelText(foreground.focusNote, { maxChars: 512 }) },
  }
}

/**
 * Format one screen as model-facing envelope text.
 * Millifraction names only the 0–1000 space. Pixel mode names that attachment's WxH,
 * which is the same pair execute divides by. Paths and other pixel sizes stay omitted.
 * @param screen - captured display and attached image.
 * @param mode - session click encoding; millifraction when omitted.
 * @returns envelope text naming index and the click space.
 */
export function formatScreenEnvelope(
  screen: ObservedScreen,
  mode: CoordinateMode = 'millifraction',
): string {
  if (mode === 'pixel') {
    return `<screen_index>${String(screen.screenIndex)}</screen_index>
<coordinate_space>pixels</coordinate_space>
<attached_size>${String(screen.image.width)}x${String(screen.image.height)}</attached_size>`
  }
  return `<screen_index>${String(screen.screenIndex)}</screen_index>
<coordinate_space>0-1000</coordinate_space>`
}

/**
 * Project captured screens into alternating envelope text and image blocks.
 * @param screens - captured displays in index order.
 * @param mode - session click encoding; millifraction when omitted.
 * @returns model-facing content with no filesystem path.
 */
export function observationBlocks(
  screens: readonly ObservedScreen[],
  mode: CoordinateMode = 'millifraction',
): ContentBlock[] {
  const blocks: ContentBlock[] = []
  for (const screen of screens) {
    blocks.push({ type: 'text', text: formatScreenEnvelope(screen, mode) })
    blocks.push({ type: 'image', attachment: imageRefFromObserved(screen.image) })
  }
  return blocks
}

/** Extra envelope fields for the three-state status and display inventory. */
export interface ObservationEnvelopeOptions {
  /** Per-field states; omitted fields use {@link UNKNOWN_OBSERVATION_STATUS}. */
  readonly status?: ObservationStatus
  /** Multi-monitor inventory printed before the screenshots. */
  readonly displayInventory?: DisplayInventory
  /** Maximum code points per text field. */
  readonly maxChars?: number
}

/**
 * Observation content: status, foreground, optional display inventory, then per-screen
 * envelopes and images.
 * @param screens - captured displays in index order.
 * @param foreground - OS metadata from {@link DesktopBackend.inspectForeground}.
 * @param mode - session click encoding; millifraction when omitted.
 * @param options - tri-state status, display inventory, and text limit.
 * @returns model-facing content with no screenshot filesystem path.
 */
export function observationContent(
  screens: readonly ObservedScreen[],
  foreground: DesktopForeground,
  mode: CoordinateMode = 'millifraction',
  options: ObservationEnvelopeOptions = {},
): ContentBlock[] {
  const status = options.status ?? UNKNOWN_OBSERVATION_STATUS
  const maxChars = options.maxChars ?? DEFAULT_MODEL_TEXT_MAX_CHARS
  const head: ContentBlock[] = [
    { type: 'text', text: formatObservationStatus(status) },
    { type: 'text', text: formatForegroundEnvelope(foreground, maxChars) },
  ]
  if (options.displayInventory !== undefined) {
    head.push({ type: 'text', text: formatDisplayInventoryEnvelope(options.displayInventory) })
  }
  return [...head, ...observationBlocks(screens, mode)]
}

/** Options for {@link observeDesktop}. */
export interface ObserveDesktopOptions {
  /** Milliseconds to wait before list/inspect/capture. Default: 0. */
  readonly settleMs?: number
  /** Session click encoding for screen envelopes. Default: millifraction. */
  readonly coordinateMode?: CoordinateMode
  /**
   * Whether to persist one capture to the attachment store.
   * Default persists every capture. Returning false keeps bytes on {@link DesktopObservation.captures} only.
   * @param captured - encoded screen bytes from {@link DesktopBackend.capture}.
   * @returns false to skip `saveImage` for this capture.
   */
  readonly persistCapture?: (captured: CapturedScreen) => boolean
  /** Include the display inventory when the backend supplies it. Default: true. */
  readonly displayInventoryEnabled?: boolean
  /** Maximum code points per model-facing text field. */
  readonly maxChars?: number
}

/**
 * Capture the overlay-skipped frontmost window, persist the image, and build content blocks.
 * When no operable window remains, returns focus tags with no screenshot.
 * @param ctx - plugin context with `attachments`.
 * @param backend - desktop capture implementation.
 * @param signal - cooperative cancellation.
 * @param options - optional settle wait, session click encoding, and persist filter.
 * @returns canonical screens, foreground metadata, and model-facing blocks.
 */
export async function observeDesktop(
  ctx: Context,
  backend: DesktopBackend,
  signal: AbortSignal,
  options: ObserveDesktopOptions = {},
): Promise<DesktopObservation> {
  signal.throwIfAborted()
  const settleMs = options.settleMs ?? 0
  if (settleMs > 0) await delay(settleMs, signal)
  let displayInventory: DisplayInventory | undefined
  let inventorySampled = false
  if (options.displayInventoryEnabled !== false && backend.displayInventory !== undefined) {
    try {
      displayInventory = await backend.displayInventory(signal)
      inventorySampled = true
    } catch (error: unknown) {
      if (isObservationAbort(error, signal)) throw error
      // The inventory is diagnostic; a failure is recorded as unsampled, not as zero displays.
    }
  }
  const listed = await backend.listScreens(signal)
  const selected = listed.slice(0, 1)
  let foreground = FOCUS_FALLBACK_FOREGROUND
  let foregroundSampled = false
  try {
    foreground = await backend.inspectForeground(signal)
    foregroundSampled = true
  } catch (error: unknown) {
    if (isObservationAbort(error, signal)) throw error
  }
  const screens: ObservedScreen[] = []
  const captures: CapturedScreen[] = []
  const persistCapture = options.persistCapture
  for (const screen of selected) {
    signal.throwIfAborted()
    const captured = await backend.capture(screen, signal)
    captures.push(captured)
    if (persistCapture !== undefined && !persistCapture(captured)) continue
    const saved = await ctx.attachments.saveImage({
      data: captured.data,
      mediaType: captured.mediaType,
      name: `${IMAGE_NAME_PREFIX}-${String(screen.index)}`,
    })
    screens.push({
      screenIndex: screen.index,
      logicalWidth: screen.bounds.width,
      logicalHeight: screen.bounds.height,
      scale: screen.scale,
      // The window the surface belongs to rides along so a later hotkey can focus it.
      ...screen.windowId === undefined ? {} : { windowId: screen.windowId },
      ...screen.transientWindowIds === undefined ? {} : { transientWindowIds: [...screen.transientWindowIds] },
      ...screen.appName === undefined ? {} : { appName: screen.appName },
      image: {
        attachmentId: saved.attachmentId,
        mediaType: saved.mediaType,
        bytes: saved.bytes,
        width: saved.width,
        height: saved.height,
        ...optionalImageFields(saved),
      },
    })
  }
  const status: ObservationStatus = {
    foreground: observationState(
      foregroundSampled,
      foreground.appName === '' || foreground.appName === 'none',
    ),
    windowTitle: observationState(
      foregroundSampled,
      foreground.windowTitle === undefined || sanitizeModelText(foreground.windowTitle).trim() === '',
    ),
    capture: observationState(true, captures.length === 0),
    displayInventory: displayInventory === undefined
      ? observationState(inventorySampled, true)
      : observationState(inventorySampled, displayInventory.displays.length === 0),
  }
  return {
    screens,
    foreground,
    blocks: observationContent(screens, foreground, options.coordinateMode ?? 'millifraction', {
      status,
      ...displayInventory === undefined ? {} : { displayInventory },
      ...options.maxChars === undefined ? {} : { maxChars: options.maxChars },
    }),
    captures,
    ...displayInventory === undefined ? {} : { displayInventory },
    status,
  }
}

/**
 * Resolve a screen_index against the current observation surface list.
 * @param screens - backend surface list.
 * @param screenIndex - model-supplied index.
 * @returns the matching screen.
 * @throws when the index is missing.
 */
export function requireScreen(screens: readonly ScreenInfo[], screenIndex: number): ScreenInfo {
  const screen = screens.find(candidate => candidate.index === screenIndex)
  if (screen === undefined) {
    const last = screens.at(-1)
    const range = last === undefined ? 'none' : `0..${String(last.index)}`
    throw new Error(`computer-use: screen_index ${String(screenIndex)} is out of range (${range})`)
  }
  return screen
}
