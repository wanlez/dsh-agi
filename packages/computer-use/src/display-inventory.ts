/**
 * Multi-monitor inventory and the one coordinate conversion every pointer action uses.
 *
 * The Windows backend runs with per-monitor-v2 DPI awareness while it talks to Win32, so
 * `GetWindowRect`, `BitBlt`, and `SendInput` all share physical pixels. This module keeps
 * that contract explicit: a normalized window position is mapped through the window
 * rectangle, then the monitor that contains it, and only then into physical pixels. The
 * same inventory is printed into the observation envelope so the model can reason about
 * multiple displays and mixed scaling.
 * @module @deepseek-ai/dsh-experimental-tool-computer-use/src/display-inventory
 */

import { sanitizeModelText } from './text-sanitize.ts'

/** Screen-space rectangle. The unit depends on the field that carries it. */
export interface DisplayRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** One physical display plus its logical (DPI-virtualized) rectangle. */
export interface DisplayInfo {
  /** Zero-based enumeration index; not the Windows Settings display number. */
  readonly index: number
  /** Monitor device name, for example `\\.\DISPLAY1`. */
  readonly name: string
  /** `HMONITOR` formatted as a hexadecimal string. */
  readonly handle: string
  /** True for the monitor Windows marks primary. */
  readonly primary: boolean
  /** Monitor rectangle in physical pixels. */
  readonly physicalRect: DisplayRect
  /** Usable desktop rectangle in physical pixels. */
  readonly workArea: DisplayRect
  /**
   * Monitor rectangle as a DPI-unaware process sees it. Equals {@link physicalRect} when
   * the system does not virtualize that monitor (common at 100% scale).
   */
  readonly logicalRect: DisplayRect
  readonly dpiX: number
  readonly dpiY: number
  /** `dpiX / 96`; also reported as a convenience for model-facing text. */
  readonly scale: number
  /** Display rotation in degrees, when the platform reports it. */
  readonly rotation: number
}

/** DPI awareness mode the inventory was sampled under. */
export type DpiAwareness = 'per-monitor-v2' | 'per-monitor' | 'system' | 'unaware' | 'unknown'

/** All displays, the virtual desktop union, and the awareness used to sample them. */
export interface DisplayInventory {
  readonly sampledAt: string
  readonly dpiAwareness: DpiAwareness
  /** Union of every monitor in physical pixels; may start at a negative coordinate. */
  readonly virtualDesktop: DisplayRect
  readonly displays: DisplayInfo[]
}

/** Whether the input rectangle uses physical or DPI-virtualized coordinates. */
export type DisplayCoordinateSpace = 'physical' | 'logical'

/** Result of one normalized-window-point conversion. */
export interface PhysicalPointMapping {
  /** Physical virtual-desktop point that `SendInput` receives. */
  readonly x: number
  readonly y: number
  /** Monitor chosen for the point. */
  readonly display: DisplayInfo
  /** True when the converted point lies inside the chosen monitor. */
  readonly insideDisplay: boolean
  /** True when the window rectangle crossed more than one monitor. */
  readonly windowSpansDisplays: boolean
}

function right(rect: DisplayRect): number {
  return rect.x + rect.width
}

function bottom(rect: DisplayRect): number {
  return rect.y + rect.height
}

function intersectionArea(left: DisplayRect, rightRect: DisplayRect): number {
  const width = Math.max(0, Math.min(right(left), right(rightRect)) - Math.max(left.x, rightRect.x))
  const height = Math.max(0, Math.min(bottom(left), bottom(rightRect)) - Math.max(left.y, rightRect.y))
  return width * height
}

function pointInRect(x: number, y: number, rect: DisplayRect): boolean {
  return x >= rect.x && x <= right(rect) && y >= rect.y && y <= bottom(rect)
}

function distanceToCenterSquared(x: number, y: number, rect: DisplayRect): number {
  const cx = rect.x + rect.width / 2
  const cy = rect.y + rect.height / 2
  return (x - cx) ** 2 + (y - cy) ** 2
}

/**
 * Pick the monitor that contains a point, or the nearest monitor when the point sits in a
 * gap of the virtual desktop layout.
 * @param inventory - sampled displays.
 * @param x - point x in {@link space}.
 * @param y - point y in {@link space}.
 * @param space - coordinate space of the point.
 * @returns the best display, or `undefined` when the inventory has no displays.
 */
export function displayForPoint(
  inventory: DisplayInventory,
  x: number,
  y: number,
  space: DisplayCoordinateSpace,
): DisplayInfo | undefined {
  const candidates = inventory.displays
  if (candidates.length === 0) return undefined
  for (const display of candidates) {
    if (pointInRect(x, y, space === 'physical' ? display.physicalRect : display.logicalRect)) return display
  }
  let best: DisplayInfo | undefined
  let bestDistance = Number.POSITIVE_INFINITY
  for (const display of candidates) {
    const rect = space === 'physical' ? display.physicalRect : display.logicalRect
    const distance = distanceToCenterSquared(x, y, rect)
    if (distance < bestDistance) {
      bestDistance = distance
      best = display
    }
  }
  return best
}

/**
 * Pick the monitor with the largest overlap with a window rectangle.
 * @param inventory - sampled displays.
 * @param rect - window rectangle in {@link space}.
 * @param space - coordinate space of the rectangle.
 * @returns the best display, or `undefined` when the inventory has no displays.
 */
export function displayForWindow(
  inventory: DisplayInventory,
  rect: DisplayRect,
  space: DisplayCoordinateSpace,
): DisplayInfo | undefined {
  if (inventory.displays.length === 0) return undefined
  let best: DisplayInfo | undefined
  let bestArea = -1
  for (const display of inventory.displays) {
    const area = intersectionArea(rect, space === 'physical' ? display.physicalRect : display.logicalRect)
    if (area > bestArea) {
      bestArea = area
      best = display
    }
  }
  return best ?? inventory.displays[0]
}

/**
 * Convert a point from one monitor's logical coordinates into physical pixels.
 * @param display - monitor carrying the point.
 * @param x - logical x.
 * @param y - logical y.
 * @returns physical x/y, clamped only when a logical rectangle is degenerate.
 */
export function logicalToPhysical(display: DisplayInfo, x: number, y: number): { x: number; y: number } {
  const logicalWidth = display.logicalRect.width > 0 ? display.logicalRect.width : 1
  const logicalHeight = display.logicalRect.height > 0 ? display.logicalRect.height : 1
  const physicalWidth = display.physicalRect.width > 0 ? display.physicalRect.width : logicalWidth
  const physicalHeight = display.physicalRect.height > 0 ? display.physicalRect.height : logicalHeight
  return {
    x: display.physicalRect.x + ((x - display.logicalRect.x) / logicalWidth) * physicalWidth,
    y: display.physicalRect.y + ((y - display.logicalRect.y) / logicalHeight) * physicalHeight,
  }
}

/**
 * Map a `[0, 1000]` position inside a window through the window rectangle and its monitor
 * into physical virtual-desktop pixels.
 *
 * This is the only path pointer actions use before posting input. A logical window
 * rectangle is scaled through the monitor's logical-to-physical mapping; a physical
 * rectangle is passed through unchanged but still validated against the inventory.
 * @param position - `[x, y]` in the same 0–1000 space the model used.
 * @param windowRect - window rectangle in {@link space}.
 * @param inventory - sampled displays.
 * @param space - coordinate space of {@link windowRect}; physical by default.
 * @returns physical point, chosen display, and containment flags.
 * @throws when the inventory has no displays or the window rectangle is degenerate.
 */
export function mapWindowPointToPhysical(
  position: readonly [number, number],
  windowRect: DisplayRect,
  inventory: DisplayInventory,
  space: DisplayCoordinateSpace = 'physical',
): PhysicalPointMapping {
  if (inventory.displays.length === 0) throw new Error('computer-use: display inventory is empty')
  if (windowRect.width <= 0 || windowRect.height <= 0) {
    throw new Error('computer-use: the target window has an empty rectangle')
  }
  const [nx, ny] = position
  const windowX = windowRect.x + (nx / 1000) * windowRect.width
  const windowY = windowRect.y + (ny / 1000) * windowRect.height
  const display = displayForWindow(inventory, windowRect, space)
  if (display === undefined) throw new Error('computer-use: no display contains the target window')
  const converted = space === 'physical'
    ? { x: windowX, y: windowY }
    : logicalToPhysical(display, windowX, windowY)
  const windowSpansDisplays = inventory.displays.some((candidate) => {
    if (candidate.index === display.index) return false
    const rect = space === 'physical' ? candidate.physicalRect : candidate.logicalRect
    return intersectionArea(windowRect, rect) > 0
  })
  return {
    x: converted.x,
    y: converted.y,
    display,
    insideDisplay: pointInRect(
      converted.x,
      converted.y,
      display.physicalRect,
    ),
    windowSpansDisplays,
  }
}

function formatRect(rect: DisplayRect): string {
  return `${String(Math.round(rect.x))},${String(Math.round(rect.y))} ${String(Math.round(rect.width))}x${String(Math.round(rect.height))}`
}

/**
 * Compact, model-facing display inventory.
 * Names are sanitized and truncated; handles stay as hexadecimal strings.
 * @param inventory - sampled displays.
 * @returns one `<display_inventory>` block.
 */
export function formatDisplayInventoryEnvelope(inventory: DisplayInventory): string {
  const header = `<display_inventory awareness="${inventory.dpiAwareness}" `
    + `virtual="${formatRect(inventory.virtualDesktop)}" count="${String(inventory.displays.length)}">`
  const lines = inventory.displays.map((display) => {
    const name = sanitizeModelText(display.name, { maxChars: 80 })
    return `<display index="${String(display.index)}" name="${name}" handle="${display.handle}" `
      + `primary="${display.primary ? 'true' : 'false'}" physical="${formatRect(display.physicalRect)}" `
      + `logical="${formatRect(display.logicalRect)}" work="${formatRect(display.workArea)}" `
      + `dpi="${String(Math.round(display.dpiX))}x${String(Math.round(display.dpiY))}" `
      + `scale="${display.scale.toFixed(2)}" rotation="${String(Math.round(display.rotation))}"/>`
  })
  return [header, ...lines, '</display_inventory>'].join('\n')
}

/**
 * One-line diagnostic summary, used by the diagnostics service and logs.
 * @param inventory - sampled displays.
 * @returns sanitized summary text.
 */
export function summarizeDisplayInventory(inventory: DisplayInventory): string {
  const primary = inventory.displays.find(display => display.primary)
  return sanitizeModelText(
    `${String(inventory.displays.length)} display(s), virtual ${formatRect(inventory.virtualDesktop)}, `
    + `primary ${primary?.name ?? 'unknown'}, awareness ${inventory.dpiAwareness}`,
    { maxChars: 240 },
  )
}
