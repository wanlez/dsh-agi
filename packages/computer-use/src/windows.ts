/**
 * Windows desktop capture (GDI) and HID input (`SendInput`).
 * Observation bounds, capture, and pointer input share physical pixels.
 * Production loads `user32` / `gdi32` through koffi on the first call.
 * Tests inject {@link WindowsDesktopOps} and never post real input.
 * @module @deepseek-ai/dsh-experimental-tool-computer-use/src/windows
 */

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { deflateSync, crc32 } from 'node:zlib'
import type {
  CapturedScreen,
  ClickInput,
  CopyImageToClipboardInput,
  DesktopBackend,
  DesktopForeground,
  DragInput,
  HotkeyInput,
  LongPressInput,
  OpenAppInput,
  OpenAppResult,
  OpenInBrowserInput,
  OpenInFinderInput,
  ScreenInfo,
  ScrollInput,
  TypeInput,
  ZoomInput,
  ZoomResult,
} from './backend.ts'
import { FOCUS_FALLBACK_FOREGROUND, UNFOCUSED_WINDOW_NOTE } from './backend.ts'
import { activeCaptureExcludeWindowIds } from './capture-exclude.ts'
import { mapNormalizedToGlobal } from './coordinates.ts'
import { delay } from './wait.ts'
import {
  selectWindowsObservation,
  type WindowsDesktopSnapshot,
  type WindowsObservationSelection,
} from './windows-foreground.ts'

/** Logical screen rectangle in virtual-screen pixels. */
export interface WindowsRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** One clipboard format and a copy of its global-memory bytes. */
export interface ClipboardEntry {
  readonly format: number
  readonly bytes: Buffer
}

/** Clipboard contents saved before a paste; {@link WindowsDesktopOps.restoreClipboard} puts the formats back. */
export interface ClipboardSnapshot {
  readonly entries: readonly ClipboardEntry[]
  /**
   * Clipboard formats the snapshot saw but could not copy: GDI and owner-display handles that
   * are not global memory, and formats past the snapshot's memory budget. `restoreClipboard`
   * empties the clipboard first, so these are formats a paste destroys for good.
   */
  readonly dropped: readonly number[]
}

/**
 * Whether putting a snapshot back left something behind.
 *
 * A restore always empties the clipboard first, so an incomplete one is data loss the user
 * cannot see: the caller must say so rather than let it pass silently. Counting `dropped`
 * as well as `entries` is what makes the empty-snapshot case — a full-screen screenshot on a
 * 4K display is one format over budget — report at all.
 * @param snapshot - what `saveClipboard` captured.
 * @param restored - number of formats `restoreClipboard` handed back to the system.
 * @returns true when at least one format the clipboard held did not return.
 */
export function clipboardRestoreIncomplete(snapshot: ClipboardSnapshot, restored: number): boolean {
  return restored < snapshot.entries.length + snapshot.dropped.length
}

/**
 * Host operations behind the Windows backend.
 * Production uses Win32. Tests supply fakes.
 * `listWindows` returns physical pixels. Capture and pointer input use that same space.
 */
export interface WindowsDesktopOps {
  /** Z-order snapshot in physical pixels, including the foreground hwnd. */
  listWindows(): WindowsDesktopSnapshot
  /**
   * Capture one screen rectangle as PNG.
   * @param bounds - rectangle in physical screen pixels.
   * @param mark - optional pointer point drawn as a crosshair (zoom crops).
   */
  capturePng(bounds: WindowsRect, mark?: { readonly x: number; readonly y: number }): Uint8Array
  /**
   * True when the window `hwnd` is elevated above this process (UIPI), so posted input
   * would be dropped. `0` and windows that are no longer on screen are never blocked;
   * a window whose integrity level cannot be read is blocked.
   * @param hwnd - top-level HWND from `listWindows`, `windowFromPoint`, or `foregroundWindowId`.
   */
  targetBlocksInput(hwnd: number): boolean
  /**
   * Top-level window at one physical screen point.
   * @param x - screen x in the same physical space as `movePointer`.
   * @param y - screen y in the same physical space as `movePointer`.
   * @returns its HWND, or `0` when no window contains the point.
   */
  windowFromPoint(x: number, y: number): number
  movePointer(x: number, y: number): void
  mouseButton(button: 'left' | 'right', down: boolean): void
  scrollWheel(x: number, y: number, delta: number): void
  /**
   * Post one key transition.
   * @param virtualKey - Win32 virtual-key code.
   * @param down - true for key down, false for key up.
   * @param extended - true for the extended navigation keys (`KEYEVENTF_EXTENDEDKEY`).
   */
  key(virtualKey: number, down: boolean, extended?: boolean): void
  /**
   * Milliseconds since the last user input event, for the idle gate that keeps our posted
   * input from stealing focus while the user is typing.
   * Optional: injected fakes may omit it, and the gate then stays open.
   * @returns idle time in milliseconds.
   */
  idleMillis?(): number
  /**
   * Post one click transition straight to `hwnd` instead of moving the real pointer.
   * Used for clients that drive their UI from window messages; a fake may omit it.
   * @param hwnd - target top-level HWND.
   * @param x - screen x in the same physical space as `movePointer`.
   * @param y - screen y in the same physical space as `movePointer`.
   * @param button - which button to post.
   * @param down - true for press, false for release.
   * @returns whether the message was posted.
   */
  postClick?(hwnd: number, x: number, y: number, button: 'left' | 'right', down: boolean): boolean
  /**
   * Copy every clipboard format and its bytes, so the paste path can put the clipboard back.
   * Formats whose handle cannot be locked (GDI handles, owner-display) are skipped.
   */
  saveClipboard(): ClipboardSnapshot
  /** Replace the clipboard with a saved snapshot, format by format. */
  restoreClipboard(snapshot: ClipboardSnapshot): void
  setClipboardText(text: string): void
  copyImageFile(path: string): void
  listWindowApps(): readonly string[]
  /**
   * Bring a running app forward.
   * @param name - process base name, or a window title that is or starts with `name` at a word boundary.
   * @returns false when no window matches `name`.
   * @throws when a window matches but does not become foreground.
   */
  activateApp(name: string): boolean
  /**
   * HWND of the current foreground window.
   * @returns a positive HWND, or `0` when no window is foreground.
   */
  foregroundWindowId(): number
  /**
   * Bring `hwnd` forward with the same Alt plus `SetForegroundWindow` sequence as `activateApp`.
   * Restores an iconic window before that call.
   * @param hwnd - top-level HWND from an observation.
   * @returns false when that window is not in the current top-level list or does not become foreground.
   */
  focusWindow(hwnd: number): boolean
  /**
   * Process base name owning `hwnd`. Windows recycles handles, so a remembered id alone
   * proves nothing: this is how the backend checks the window it is about to focus is still
   * the app the session observed.
   * @param hwnd - top-level HWND from an observation.
   * @returns the name, or undefined when that handle no longer resolves.
   */
  windowAppName(hwnd: number): string | undefined
  launch(target: string, parameters?: string): void
  /**
   * Explorer address path for one Explorer window.
   * @param hwnd - Explorer window handle.
   * @returns the folder path, or undefined when it cannot be read.
   */
  explorerFolder(hwnd: number): string | undefined
}

const ELEVATED_WINDOW = 'computer-use: the target window is running elevated, so this process cannot click or type into it'

const KEY_NAMES: Readonly<Record<string, number>> = {
  ctrl: 0x11,
  control: 0x11,
  alt: 0x12,
  option: 0x12,
  shift: 0x10,
  win: 0x5B,
  windows: 0x5B,
  meta: 0x5B,
  cmd: 0x5B,
  command: 0x5B,
  super: 0x5B,
  enter: 0x0D,
  return: 0x0D,
  tab: 0x09,
  escape: 0x1B,
  esc: 0x1B,
  space: 0x20,
  backspace: 0x08,
  delete: 0x2E,
  del: 0x2E,
  up: 0x26,
  down: 0x28,
  left: 0x25,
  right: 0x27,
  home: 0x24,
  end: 0x23,
  pageup: 0x21,
  pagedown: 0x22,
  insert: 0x2D,
}

/**
 * Keys whose scan code is the extended set: arrows, editing/navigation keys, and the
 * Windows keys (`VK_LWIN` is `E0 5B`). Numpad names are not in this map.
 */
const EXTENDED_KEY_NAMES = new Set([
  'up',
  'down',
  'left',
  'right',
  'home',
  'end',
  'pageup',
  'pagedown',
  'insert',
  'delete',
  'del',
  'win',
  'windows',
  'meta',
  'cmd',
  'command',
  'super',
])

const MODIFIER_VKS = new Set([0x10, 0x11, 0x12, 0x5B, 0x5C])

/** Same settle the macOS HID script uses after a move, before the button goes down. */
const POINTER_MOVE_SETTLE_MS = 80
const BUTTON_HOLD_MS = 50
/**
 * Pause before an injected action so the ball's phase pill can show "acting" before the
 * input lands. 350 ms is long enough to notice, short enough not to feel slow. 0 disables it.
 */
const ACTION_LEAD_MS = (() => {
  const configured = Number(process.env.DSH_AGI_ACTION_LEAD_MS ?? 350)
  return Number.isFinite(configured) && configured > 0 ? configured : 0
})()

/**
 * How long the user must have been idle before posted input is allowed through.
 * Set `DSH_AGI_IDLE_GATE_MS=0` to disable the gate, or to another positive value to change it.
 */
const IDLE_GATE_MS = Number(process.env.DSH_AGI_IDLE_GATE_MS ?? 800)
/** How long a deferred pointer/key action waits for the user to go idle before failing. */
const IDLE_GATE_WAIT_MS = Number(process.env.DSH_AGI_IDLE_WAIT_MS ?? 20000)

/**
 * File listing the apps whose windows accept posted click messages instead of real input.
 * Lives beside the other dsh-agi data so the user can edit it without a rebuild.
 * @returns absolute path of `post-click-apps.json`.
 */
const POST_CLICK_FILE = (): string => join(
  process.env.DSH_HOME !== undefined && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : join(process.env.USERPROFILE ?? '', '.dsh'),
  'dsh-agi',
  'post-click-apps.json',
)

/** Last-read copy of {@link POST_CLICK_FILE}; `mtime` -1 means "not read yet". */
let postClickCache: { mtime: number; apps: string[] } = { mtime: -1, apps: [] }

/**
 * Lowercased app names whose clicks should be posted to the window instead of synthesized.
 * Re-read when the file's mtime changes; without a file the env default applies.
 * @returns app names, or `['*']` for every app.
 */
function postClickApps(): string[] {
  const file = POST_CLICK_FILE()
  try {
    const mtime = statSync(file).mtimeMs
    if (mtime !== postClickCache.mtime) {
      const data = JSON.parse(readFileSync(file, 'utf8')) as { apps?: unknown }
      const apps = Array.isArray(data.apps) ? data.apps : []
      postClickCache = { mtime, apps: apps.map(name => String(name).toLowerCase()) }
    }
    return postClickCache.apps
  } catch {
    return String(process.env.DSH_AGI_POST_CLICK_APPS ?? 'clouddesktop-qml,clouddesktop')
      .split(',')
      .map(name => name.trim().toLowerCase())
      .filter(name => name !== '')
  }
}

/**
 * Whether clicking `windowId` should post the messages instead.
 * The posted path leaves the user's pointer where it is, which is the only way to click a
 * remote/streamed desktop client without moving their real cursor.
 * @param ops - Win32 operations.
 * @param windowId - observed owner window, if the session has one.
 * @returns true when the window's app is listed for posted clicks.
 */
function postClickAllowed(ops: WindowsDesktopOps, windowId: number | undefined): boolean {
  if (windowId === undefined || ops.postClick === undefined) return false
  if (typeof ops.windowAppName !== 'function') return false
  const apps = postClickApps()
  if (apps.length === 0) return false
  const app = String(ops.windowAppName(windowId) ?? '').toLowerCase()
  return apps.includes('*') || apps.includes(app)
}

/**
 * Wait until the user has been idle for {@link IDLE_GATE_MS} before posting input.
 * Typing or clicking while the user is working would steal focus mid-keystroke, so the
 * action waits instead, and gives up after {@link IDLE_GATE_WAIT_MS}.
 * @param host - Win32 operations; without `idleMillis` the gate stays open.
 * @param signal - cooperative cancellation while waiting.
 * @throws when the user never goes idle within the wait budget.
 */
async function waitForUserIdle(host: WindowsDesktopOps, signal: AbortSignal): Promise<void> {
  const idle = host.idleMillis
  if (!Number.isFinite(IDLE_GATE_MS) || IDLE_GATE_MS <= 0) return
  if (idle === undefined) return
  const started = Date.now()
  while (idle() < IDLE_GATE_MS) {
    if (Date.now() - started > IDLE_GATE_WAIT_MS) {
      throw new Error('computer-use: the user is actively using this machine; deferred input, retry later')
    }
    await delay(120, signal)
  }
}

const DOUBLE_CLICK_GAP_MS = 100
const DRAG_STEPS = 10
const DRAG_STEP_MS = 20
const SCROLL_NOTCH = 120
const SCROLL_STEP_MS = 20
const MODIFIER_GAP_MS = 20
const CLIPBOARD_SETTLE_MS = 30
/** Wait after Ctrl+V before restoring the clipboard, so the target reads the pasted text. */
const PASTE_SETTLE_MS = 80

interface PostedKey {
  readonly vk: number
  readonly extended: boolean
}

/**
 * Map one hotkey token to a Win32 virtual-key code.
 * @param key - model-supplied key name.
 * @returns the virtual-key code.
 * @throws when the token is not a known key, letter, digit, or function key.
 */
export function windowsVirtualKey(key: string): number {
  const token = key.trim().toLowerCase()
  const named = KEY_NAMES[token]
  if (named !== undefined) return named
  if (/^[a-z]$/u.test(token)) return token.toUpperCase().charCodeAt(0)
  if (/^[0-9]$/u.test(token)) return token.charCodeAt(0)
  const fn = /^f([1-9]|1[0-2])$/u.exec(token)
  if (fn !== null) return 0x70 + Number(fn[1]) - 1
  throw new Error(`computer-use: unknown key ${JSON.stringify(key)}`)
}

/**
 * Whether a hotkey token needs `KEYEVENTF_EXTENDEDKEY`.
 * @param key - model-supplied key name.
 * @returns true for arrows, editing/navigation keys, and the Windows keys. Letters and digits return false.
 */
export function windowsKeyIsExtended(key: string): boolean {
  return EXTENDED_KEY_NAMES.has(key.trim().toLowerCase())
}

function postedKey(key: string): PostedKey {
  return { vk: windowsVirtualKey(key), extended: windowsKeyIsExtended(key) }
}

function postedVk(vk: number): PostedKey {
  return { vk, extended: false }
}

/**
 * Encode a 32-bit BGRA buffer as a PNG.
 * @param width - pixel width.
 * @param height - pixel height.
 * @param bgra - tightly packed BGRA pixels, one row after another.
 * @param bottomUp - true when the first row in `bgra` is the bottom of the image.
 * @returns PNG bytes.
 */
export function encodeBgraPng(width: number, height: number, bgra: Buffer, bottomUp: boolean): Uint8Array {
  const rowBytes = width * 4
  const raw = Buffer.alloc((rowBytes + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const sourceY = bottomUp ? height - 1 - y : y
    const dest = y * (rowBytes + 1)
    raw[dest] = 0
    for (let x = 0; x < width; x += 1) {
      const source = sourceY * rowBytes + x * 4
      const pixel = dest + 1 + x * 4
      raw[pixel] = bgra[source + 2] ?? 0
      raw[pixel + 1] = bgra[source + 1] ?? 0
      raw[pixel + 2] = bgra[source] ?? 0
      raw[pixel + 3] = 255
    }
  }
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const name = Buffer.from(type)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])) >>> 0)
  return Buffer.concat([length, name, data, crc])
}

function liveSignal(signal: AbortSignal | undefined): AbortSignal {
  return signal ?? new AbortController().signal
}

function pointOf(position: readonly [number, number], screen: ScreenInfo): { x: number; y: number } {
  const mapped = mapNormalizedToGlobal(position, screen)
  return { x: Math.round(mapped.x), y: Math.round(mapped.y) }
}

/**
 * Refuse pointer input whose window is elevated: the window under the point receives the
 * click, not whatever holds the foreground.
 * @param ops - Win32 operations.
 * @param point - physical screen point the pointer was moved to.
 * @throws when that window is elevated. Nothing is posted after that throw.
 */
function assertPointInput(ops: WindowsDesktopOps, point: { x: number; y: number }): void {
  if (ops.targetBlocksInput(ops.windowFromPoint(point.x, point.y))) throw new Error(ELEVATED_WINDOW)
}

/**
 * Refuse a focus change into an elevated window before it happens; UIPI would drop the
 * posted keys. No observation means no focus change, so there is nothing to check.
 * @param ops - Win32 operations.
 * @param hwnd - window a hotkey is about to bring forward, if the session has one.
 * @throws when that window is elevated. Focus is untouched after that throw.
 */
function assertTargetInput(ops: WindowsDesktopOps, hwnd: number | undefined): void {
  if (hwnd === undefined) return
  if (ops.targetBlocksInput(hwnd)) throw new Error(ELEVATED_WINDOW)
}

/**
 * Move keyboard focus to the window the session last observed when it is not already foreground.
 * A session without a window id posts keys as-is: it must not guess a foreground window.
 * @param host - Win32 operations.
 * @param target - observation window from the caller, if the session has one.
 * @throws when the window cannot become foreground. No keys are posted after that throw.
 */
function restoreObservedFocus(
  host: WindowsDesktopOps,
  target: { readonly windowId?: number; readonly transientWindowIds?: readonly number[]; readonly appName?: string },
): void {
  if (target.windowId === undefined) return
  const foreground = host.foregroundWindowId()
  if (foreground === target.windowId || target.transientWindowIds?.includes(foreground) === true) return
  // Windows recycles HWNDs. The id this session observed may belong to an unrelated window
  // by now, and posting the keys there would type into whatever replaced it.
  if (target.appName !== undefined && target.appName !== '') {
    const owner = host.windowAppName(target.windowId)
    if (owner !== undefined && owner.toLowerCase() !== target.appName.toLowerCase()) {
      throw new Error(
        `computer-use: the ${target.appName} window this session observed is gone; click inside the window, then retry hotkey`,
      )
    }
  }
  if (host.focusWindow(target.windowId)) return
  const label = target.appName === undefined || target.appName === '' ? `window ${String(target.windowId)}` : target.appName
  throw new Error(
    `computer-use: keyboard focus could not be moved to ${label}; click inside the window, then retry hotkey`,
  )
}

async function clickAt(
  ops: WindowsDesktopOps,
  button: 'left' | 'right',
  count: number,
  point: { x: number; y: number },
  signal: AbortSignal,
  windowId: number | undefined,
): Promise<void> {
  const postClick = ops.postClick
  if (windowId !== undefined && postClick !== undefined && postClickAllowed(ops, windowId)) {
    for (let index = 0; index < count; index += 1) {
      postClick(windowId, point.x, point.y, button, true)
      // The release always runs, so an abort between press and release cannot leave the
      // target thinking the button is still held.
      try {
        await delay(BUTTON_HOLD_MS, signal)
      } finally {
        postClick(windowId, point.x, point.y, button, false)
      }
      if (index + 1 < count) await delay(DOUBLE_CLICK_GAP_MS, signal)
    }
    return
  }
  ops.movePointer(point.x, point.y)
  await delay(POINTER_MOVE_SETTLE_MS, signal)
  assertPointInput(ops, point)
  for (let index = 0; index < count; index += 1) {
    ops.mouseButton(button, true)
    // A press always gets its release: the hold delay rejects on abort, and a button left
    // down would turn the next click into a drag.
    try {
      await delay(BUTTON_HOLD_MS, signal)
    } finally {
      ops.mouseButton(button, false)
    }
    if (index + 1 < count) await delay(DOUBLE_CLICK_GAP_MS, signal)
  }
}

async function chord(
  ops: WindowsDesktopOps,
  keys: readonly PostedKey[],
  signal: AbortSignal,
): Promise<void> {
  const modifiers = keys.filter(key => MODIFIER_VKS.has(key.vk))
  const rest = keys.filter(key => !MODIFIER_VKS.has(key.vk))
  const pressed: PostedKey[] = []
  try {
    for (const key of modifiers) {
      ops.key(key.vk, true, key.extended)
      pressed.push(key)
    }
    if (modifiers.length > 0) await delay(MODIFIER_GAP_MS, signal)
    for (const key of rest) {
      ops.key(key.vk, true, key.extended)
      pressed.push(key)
    }
  } finally {
    // Reverse order, whatever happened: an abort between the presses must not leave a
    // modifier or key held down.
    for (const key of [...pressed].reverse()) ops.key(key.vk, false, key.extended)
  }
}

/**
 * Hold `keys` down, run `run` with them held, then release every key that went down in
 * reverse order. Anything that throws or aborts inside `run` still releases them.
 */
async function withHeldKeys<T>(
  ops: WindowsDesktopOps,
  keys: readonly PostedKey[],
  signal: AbortSignal,
  run: () => Promise<T>,
): Promise<T> {
  const pressed: PostedKey[] = []
  try {
    for (const key of keys) {
      ops.key(key.vk, true, key.extended)
      pressed.push(key)
    }
    if (pressed.length > 0) await delay(MODIFIER_GAP_MS, signal)
    return await run()
  } finally {
    for (const key of [...pressed].reverse()) ops.key(key.vk, false, key.extended)
  }
}

function observationOf(ops: WindowsDesktopOps): WindowsObservationSelection | undefined {
  return selectWindowsObservation(ops.listWindows(), activeCaptureExcludeWindowIds())
}

function screenFromObservation(selected: WindowsObservationSelection): ScreenInfo {
  return {
    index: 0,
    bounds: selected.bounds,
    scale: selected.scale,
    windowId: selected.windowId,
    ...selected.transientWindowIds.length === 0 ? {} : { transientWindowIds: selected.transientWindowIds },
    appName: selected.appName,
  }
}

let productionOps: WindowsDesktopOps | undefined

async function production(): Promise<WindowsDesktopOps> {
  productionOps ??= (await import('./windows-native.ts')).createProductionWindowsOps()
  return productionOps
}

/**
 * Construct the Windows backend.
 * @param ops - injected host operations. Omit to use Win32 on the first call.
 * @returns capture and HID input against the host desktop.
 */
export function createWindowsDesktopBackend(ops?: WindowsDesktopOps): DesktopBackend {
  const use = async (): Promise<WindowsDesktopOps> => ops ?? await production()

  return {
    withGuiTurn: run => run(),

    async listScreens(signal) {
      signal?.throwIfAborted()
      const selected = observationOf(await use())
      if (selected === undefined) return []
      return [screenFromObservation(selected)]
    },

    async capture(screen, signal): Promise<CapturedScreen> {
      signal?.throwIfAborted()
      try {
        const data = (await use()).capturePng(screen.bounds)
        return { data, mediaType: 'image/png' }
      } catch (error: unknown) {
        if (error instanceof Error && error.message.startsWith('computer-use:')) throw error
        throw new Error(`computer-use: screen capture failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    },

    async inspectForeground(signal) {
      signal?.throwIfAborted()
      const host = await use()
      const selected = observationOf(host)
      if (selected === undefined) return FOCUS_FALLBACK_FOREGROUND
      const folder = selected.appName.toLowerCase() === 'explorer'
        ? host.explorerFolder(selected.windowId)
        : undefined
      const foreground: DesktopForeground = {
        appName: selected.appName,
        ...selected.windowTitle === '' ? {} : { windowTitle: selected.windowTitle },
        ...folder === undefined ? {} : { finderFolder: folder },
        ...selected.focused ? {} : { focusNote: UNFOCUSED_WINDOW_NOTE },
      }
      return foreground
    },

    async listApps(signal) {
      signal?.throwIfAborted()
      return (await use()).listWindowApps()
    },

    async openApp(input: OpenAppInput, signal): Promise<OpenAppResult> {
      signal?.throwIfAborted()
      const host = await use()
      if (host.activateApp(input.name)) return { kind: 'activated', name: input.name }
      host.launch(input.name)
      return { kind: 'launched', name: input.name }
    },

    async click(input: ClickInput, signal) {
      const host = await use()
      const point = pointOf(input.position, input.screen)
      const abort = liveSignal(signal)
      const modifiers = (input.modifiers ?? []).map(postedKey)
      await waitForUserIdle(host, abort)
      if (ACTION_LEAD_MS > 0) await delay(ACTION_LEAD_MS, abort)
      const windowId = input.screen.windowId
      if (modifiers.length === 0) {
        await clickAt(host, input.button, input.count, point, abort, windowId)
        return
      }
      // Shift-clicks, Ctrl-clicks, and Cmd-chords hold their modifiers for this click only;
      // a refused point or an abort still releases them.
      await withHeldKeys(host, modifiers, abort, () => clickAt(host, input.button, input.count, point, abort, windowId))
    },

    /**
     * Move the pointer to a normalized position and capture a square zoom around it.
     * The default crop side is one sixth of the target window's height; callers refining
     * a small control pass a smaller side. The crop is clamped to `clamp` (the window).
     * @param input - screen, normalized position, optional side and clamp bounds.
     * @returns the pixel point, crop rectangle, and PNG bytes.
     */
    async zoom(input: ZoomInput): Promise<ZoomResult> {
      const host = await use()
      const screen = input.screen
      const point = pointOf(input.position, screen)
      const clamp = input.clamp ?? screen.bounds
      const side = Math.max(24, Math.round(input.side ?? screen.bounds.height / 6))
      const half = Math.floor(side / 2)
      const x = Math.max(clamp.x, Math.min(point.x - half, clamp.x + clamp.width - side))
      const y = Math.max(clamp.y, Math.min(point.y - half, clamp.y + clamp.height - side))
      const rect = {
        x,
        y,
        width: Math.min(side, clamp.width),
        height: Math.min(side, clamp.height),
      }
      host.movePointer(point.x, point.y)
      const data = host.capturePng(rect, point)
      return { point, rect, data, mediaType: 'image/png' }
    },

    async typeText(input: TypeInput, signal) {
      const host = await use()
      const abort = liveSignal(signal)
      await waitForUserIdle(host, abort)
      if (ACTION_LEAD_MS > 0) await delay(ACTION_LEAD_MS, abort)
      await clickAt(host, 'left', 1, pointOf(input.position, input.screen), abort, input.screen.windowId)
      if (input.replace) await chord(host, [postedVk(0x11), postedVk(0x41)], abort)
      const previous = host.saveClipboard()
      try {
        host.setClipboardText(input.text)
        await delay(CLIPBOARD_SETTLE_MS, abort)
        await chord(host, [postedVk(0x11), postedVk(0x56)], abort)
        await delay(PASTE_SETTLE_MS, abort)
        if (input.submit) {
          await delay(CLIPBOARD_SETTLE_MS, abort)
          await chord(host, [postedVk(0x0D)], abort)
        }
      } finally {
        // Every saved format goes back, not just the text: an image or file list the user
        // copied must survive the paste.
        host.restoreClipboard(previous)
      }
    },

    async scroll(input: ScrollInput, signal) {
      const host = await use()
      const point = pointOf(input.position, input.screen)
      assertPointInput(host, point)
      const abort = liveSignal(signal)
      await waitForUserIdle(host, abort)
      const step = (input.direction === 'up' ? 1 : -1) * SCROLL_NOTCH
      for (let index = 0; index < input.scrollLevel; index += 1) {
        host.scrollWheel(point.x, point.y, step)
        await delay(SCROLL_STEP_MS, abort)
      }
    },

    async hotkey(input: HotkeyInput, signal) {
      signal?.throwIfAborted()
      const host = await use()
      // The window comes from this session's own observation, so another session's capture
      // cannot redirect the keys. It is checked before focus moves: UIPI drops posted keys
      // into an elevated window.
      assertTargetInput(host, input.windowId)
      restoreObservedFocus(host, input)
      const abort = liveSignal(signal)
      await waitForUserIdle(host, abort)
      await chord(host, input.keys.map(postedKey), abort)
    },

    async longPress(input: LongPressInput, signal) {
      const host = await use()
      const point = pointOf(input.position, input.screen)
      const abort = liveSignal(signal)
      if (ACTION_LEAD_MS > 0) await delay(ACTION_LEAD_MS, abort)
      host.movePointer(point.x, point.y)
      await delay(POINTER_MOVE_SETTLE_MS, abort)
      assertPointInput(host, point)
      host.mouseButton('left', true)
      try {
        await delay(Math.round(input.durationSeconds * 1000), abort)
      } finally {
        host.mouseButton('left', false)
      }
    },

    async drag(input: DragInput, signal) {
      const host = await use()
      const start = pointOf(input.startPosition, input.startScreen)
      const end = pointOf(input.endPosition, input.endScreen)
      const abort = liveSignal(signal)
      if (ACTION_LEAD_MS > 0) await delay(ACTION_LEAD_MS, abort)
      host.movePointer(start.x, start.y)
      await delay(POINTER_MOVE_SETTLE_MS, abort)
      assertPointInput(host, start)
      host.mouseButton('left', true)
      // Hold and move inside one protected block: an abort must still release the button.
      try {
        await delay(BUTTON_HOLD_MS, abort)
        for (let step = 1; step <= DRAG_STEPS; step += 1) {
          const t = step / DRAG_STEPS
          host.movePointer(
            Math.round(start.x + (end.x - start.x) * t),
            Math.round(start.y + (end.y - start.y) * t),
          )
          await delay(DRAG_STEP_MS, abort)
        }
      } finally {
        host.mouseButton('left', false)
      }
    },

    async openInBrowser(input: OpenInBrowserInput, signal) {
      signal?.throwIfAborted()
      ;(await use()).launch(input.url ?? 'https://')
    },

    async openInFinder(input: OpenInFinderInput, signal) {
      signal?.throwIfAborted()
      const host = await use()
      if (input.revealOnly) host.launch('explorer.exe', `/select,"${input.path}"`)
      else host.launch(input.path)
    },

    async copyImageToClipboard(input: CopyImageToClipboardInput, signal) {
      signal?.throwIfAborted()
      ;(await use()).copyImageFile(input.path)
    },
  }
}
