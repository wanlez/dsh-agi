/**
 * Win32 capture and input used by {@link createWindowsDesktopBackend}.
 * Loaded only on Windows, and only when a method runs without injected operations.
 * Each coordinate-bearing call sets this thread to per-monitor DPI awareness so
 * window rectangles, `BitBlt`, and `SendInput` share physical pixels, then restores
 * the previous awareness. `.agents/notes/implemented/architecture/2026-09-23-windows-computer-use-per-monitor-dpi.md`
 * owns that decision.
 * @module @deepseek-ai/dsh-experimental-tool-computer-use/src/windows-native
 */

import { execFileSync } from 'node:child_process'
import type { ActionCursor, ActionSnapshot, CursorKind, ModalState, ModalWindowFact } from './action-receipt.ts'
import { detectModalFromFacts } from './action-receipt.ts'
import { selectAppWindow } from './app-match.ts'
import { bitmapLooksDegenerate, captureWithFallback } from './capture-strategy.ts'
import koffi from './koffi.ts'
import { compositeCursor, cursorDrawPlacement, drawCrosshair, drawGrid, flipRows, resolveCursorAlpha } from './cursor.ts'
import type { DisplayInfo, DisplayInventory, DpiAwareness } from './display-inventory.ts'
import { compareHoverFrames, judgeHoverFeedback, unavailableHoverFeedback, type HoverFeedback } from './hover.ts'
import { appOwnerPid } from './windows-foreground.ts'
import type { WindowsDesktopSnapshot, WindowsWindowFact } from './windows-foreground.ts'
import {
  clipboardRestoreIncomplete,
  encodeBgraPng,
  type ClipboardSnapshot,
  type ResolvedWindowsDesktopOptions,
  type WindowsDesktopOps,
  type WindowsRect,
} from './windows.ts'

const SRCCOPY = 0x00CC0020
const PW_RENDERFULLCONTENT = 0x00000002
const MOUSEEVENTF_MOVE = 0x0001
const MOUSEEVENTF_LEFTDOWN = 0x0002
const MOUSEEVENTF_LEFTUP = 0x0004
const MOUSEEVENTF_RIGHTDOWN = 0x0008
const MOUSEEVENTF_RIGHTUP = 0x0010
const MOUSEEVENTF_WHEEL = 0x0800
const MOUSEEVENTF_ABSOLUTE = 0x8000
const MOUSEEVENTF_VIRTUALDESK = 0x4000
const INPUT_MOUSE = 0
const INPUT_KEYBOARD = 1
const KEYEVENTF_EXTENDEDKEY = 0x0001
const KEYEVENTF_KEYUP = 0x0002
const CF_UNICODETEXT = 13
const GMEM_MOVEABLE = 0x0002
/** Integrity RID of a normal, unelevated process (`S-1-16-8192`). */
const MEDIUM_INTEGRITY_RID = 0x2000
/**
 * Bytes a clipboard snapshot may copy across all its formats. A 4K screenshot's CF_DIB is
 * tens of megabytes, and the snapshot runs on every `input_text`, so the budget keeps a
 * single paste from materializing an unbounded amount of memory. Formats that do not fit
 * are left out; the plain-text entry is taken first.
 */
const CLIPBOARD_SNAPSHOT_LIMIT_BYTES = 16 * 1024 * 1024

/**
 * Clipboard formats whose handle is a GDI object, not a GlobalAlloc block: CF_BITMAP,
 * CF_METAFILEPICT, CF_PALETTE, CF_ENHMETAFILE and their CF_DSP* twins. GlobalSize is only
 * defined for global memory; probing one of these handles corrupted the heap and killed
 * the host with STATUS_HEAP_CORRUPTION (0xC0000374) whenever the clipboard held a bitmap.
 * The picture still travels as CF_DIB / CF_DIBV5, so skipping them loses no pixels.
 */
const GDI_CLIPBOARD_FORMATS = new Set([2, 3, 9, 14, 0x0082, 0x0083, 0x008e])
const SM_XVIRTUALSCREEN = 76
const SM_YVIRTUALSCREEN = 77
const SM_CXVIRTUALSCREEN = 78
const SM_CYVIRTUALSCREEN = 79
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
const TOKEN_QUERY = 0x0008
const TokenIntegrityLevel = 25
const SW_SHOWNORMAL = 1
const SW_RESTORE = 9
const GW_OWNER = 4
/** `GetAncestor` flag: the root (top-level) window of a child. */
const GA_ROOT = 2
const GWL_STYLE = -16
const GWL_EXSTYLE = -20
const WS_POPUP = 0x80000000
const WS_EX_TOOLWINDOW = 0x00000080
const DWMWA_EXTENDED_FRAME_BOUNDS = 9
const DWMWA_CLOAKED = 14
const MONITOR_DEFAULTTONEAREST = 2
const MDT_EFFECTIVE_DPI = 0
const VK_MENU = 0x12
/** `CURSORINFO.flags` bit set while the pointer is drawn. */
const CURSOR_SHOWING = 0x0001
/** Per-monitor v2, then per-monitor. `SetThreadDpiAwarenessContext` returns NULL when the context is unsupported. */
const DPI_PER_MONITOR_V2 = -4
const DPI_PER_MONITOR = -3
const FOREGROUND_RETRY_MS = 50
const GW_ENABLEDPOPUP = 6
const MONITORINFOF_PRIMARY = 0x00000001
/** DPI-awareness context for an unaware process; used only to sample logical monitor rectangles. */
const DPI_UNAWARE = -1
const IDC_ARROW = 32512
const IDC_IBEAM = 32513
const IDC_WAIT = 32514
const IDC_CROSS = 32515
const IDC_SIZEWE = 32644
const IDC_SIZENS = 32645
const IDC_HAND = 32649
/** Size of `MONITORINFOEXW` on every supported architecture: 40-byte header + 32 UTF-16 chars. */
const MONITORINFOEX_SIZE = 104

const RECT = koffi.struct('DSH_CU_RECT', {
  left: 'int32',
  top: 'int32',
  right: 'int32',
  bottom: 'int32',
})

const POINT = koffi.struct('DSH_CU_POINT', {
  x: 'int32',
  y: 'int32',
})

const BITMAPINFOHEADER = koffi.struct('DSH_CU_BITMAPINFOHEADER', {
  biSize: 'uint32',
  biWidth: 'int32',
  biHeight: 'int32',
  biPlanes: 'uint16',
  biBitCount: 'uint16',
  biCompression: 'uint32',
  biSizeImage: 'uint32',
  biXPelsPerMeter: 'int32',
  biYPelsPerMeter: 'int32',
  biClrUsed: 'uint32',
  biClrImportant: 'uint32',
})

const MOUSEINPUT = koffi.struct('DSH_CU_MOUSEINPUT', {
  dx: 'int32',
  dy: 'int32',
  mouseData: 'uint32',
  dwFlags: 'uint32',
  time: 'uint32',
  dwExtraInfo: 'uintptr',
})

const KEYBDINPUT = koffi.struct('DSH_CU_KEYBDINPUT', {
  wVk: 'uint16',
  wScan: 'uint16',
  dwFlags: 'uint32',
  time: 'uint32',
  dwExtraInfo: 'uintptr',
})

const INPUT_UNION = koffi.union('DSH_CU_INPUT_UNION', {
  mi: MOUSEINPUT,
  ki: KEYBDINPUT,
})

const INPUT = koffi.struct('DSH_CU_INPUT', {
  type: 'uint32',
  u: INPUT_UNION,
})

const CURSORINFO = koffi.struct('DSH_CU_CURSORINFO', {
  cbSize: 'uint32',
  flags: 'uint32',
  hCursor: 'void *',
  ptScreenPos: POINT,
})

const GUITHREADINFO = koffi.struct('DSH_CU_GUITHREADINFO', {
  cbSize: 'uint32',
  flags: 'uint32',
  hwndActive: 'void *',
  hwndFocus: 'void *',
  hwndCapture: 'void *',
  hwndMenuOwner: 'void *',
  hwndMoveSize: 'void *',
  hwndCaret: 'void *',
  rcCaret: RECT,
})

const ICONINFO = koffi.struct('DSH_CU_ICONINFO', {
  fIcon: 'int32',
  xHotspot: 'uint32',
  yHotspot: 'uint32',
  hbmMask: 'void *',
  hbmColor: 'void *',
})

/** `tagBITMAP`; only `bmWidth` and `bmHeight` are read. */
const BITMAP = koffi.struct('DSH_CU_BITMAP', {
  bmType: 'int32',
  bmWidth: 'int32',
  bmHeight: 'int32',
  bmWidthBytes: 'int32',
  bmPlanes: 'uint16',
  bmBitsPixel: 'uint16',
  bmBits: 'void *',
})

void RECT
void POINT
void BITMAPINFOHEADER

interface NativeRect {
  left: number
  top: number
  right: number
  bottom: number
}

interface NativePoint {
  x: number
  y: number
}

interface NativeBindings {
  readonly user32: ReturnType<typeof koffi.load>
  readonly gdi32: ReturnType<typeof koffi.load>
  readonly kernel32: ReturnType<typeof koffi.load>
  readonly shell32: ReturnType<typeof koffi.load>
  readonly advapi32: ReturnType<typeof koffi.load>
  readonly dwmapi: ReturnType<typeof koffi.load>
}

type DpiContext = number | bigint

function isNull(value: unknown): boolean {
  return value === null || value === undefined || value === 0 || value === 0n
}

function dpiContext(value: unknown): DpiContext | undefined {
  if (typeof value === 'bigint') return value === 0n ? undefined : value
  if (typeof value === 'number' && value !== 0) return value
  return undefined
}

function hwndId(value: unknown): number | undefined {
  const id = typeof value === 'bigint' ? Number(value) : typeof value === 'number' ? value : Number.NaN
  if (!Number.isSafeInteger(id) || id === 0) return undefined
  return id
}

function low32(value: unknown): number {
  if (typeof value === 'bigint') return Number(BigInt.asIntN(32, value))
  if (typeof value === 'number' && Number.isFinite(value)) return value | 0
  return 0
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function bind(libraries: NativeBindings): {
  GetForegroundWindow: () => unknown
  GetWindowRect: (hwnd: unknown, rect: NativeRect) => number
  GetWindowTextLengthW: (hwnd: unknown) => number
  GetWindowTextW: (hwnd: unknown, buffer: Buffer, max: number) => number
  GetWindowThreadProcessId: (hwnd: unknown, pid: number[]) => number
  IsWindowVisible: (hwnd: unknown) => number
  IsIconic: (hwnd: unknown) => number
  EnumWindows: (callback: unknown, param: number) => number
  EnumChildWindows: (hwnd: unknown, callback: unknown, param: number) => number
  EnumDisplayMonitors: (hdc: unknown, rect: unknown, callback: unknown, param: number) => number
  GetClassNameW: (hwnd: unknown, buffer: Buffer, max: number) => number
  GetWindow: (hwnd: unknown, command: number) => unknown
  GetAncestor: (hwnd: unknown, flags: number) => unknown
  GetParent: (hwnd: unknown) => unknown
  IsWindowEnabled: (hwnd: unknown) => number
  GetWindowLongPtrW: (hwnd: unknown, index: number) => unknown
  ShowWindow: (hwnd: unknown, command: number) => number
  SetForegroundWindow: (hwnd: unknown) => number
  MonitorFromWindow: (hwnd: unknown, flags: number) => unknown
  GetMonitorInfoW: (monitor: unknown, info: Buffer) => number
  GetSystemMetrics: (index: number) => number
  GetCursorPos: (point: NativePoint) => number
  SetCursorPos: (x: number, y: number) => number
  WindowFromPoint: (point: NativePoint) => unknown
  GetCursorInfo: (info: Buffer) => number
  GetIconInfo: (cursor: unknown, info: Buffer) => number
  SetThreadDpiAwarenessContext: ((context: DpiContext) => unknown) | undefined
  GetDpiForMonitor: ((monitor: unknown, type: number, dpiX: number[], dpiY: number[]) => number) | undefined
  GetDC: (hwnd: unknown) => unknown
  ReleaseDC: (hwnd: unknown, hdc: unknown) => number
  CreateCompatibleDC: (hdc: unknown) => unknown
  CreateCompatibleBitmap: (hdc: unknown, width: number, height: number) => unknown
  SelectObject: (hdc: unknown, object: unknown) => unknown
  BitBlt: (dest: unknown, x: number, y: number, w: number, h: number, src: unknown, sx: number, sy: number, rop: number) => number
  PrintWindow: (hwnd: unknown, hdc: unknown, flags: number) => number
  DwmFlush: () => number
  GetGUIThreadInfo: (threadId: number, info: Buffer) => number
  GetFocus: () => unknown
  LoadCursorW: (instance: unknown, name: number) => unknown
  GetDIBits: (
    hdc: unknown,
    bitmap: unknown,
    start: number,
    lines: number,
    bits: Buffer,
    header: Record<string, number>,
    usage: number,
  ) => number
  DeleteObject: (object: unknown) => number
  DeleteDC: (hdc: unknown) => number
  GetObjectW: (handle: unknown, size: number, info: Buffer) => number
  SendInput: (count: number, inputs: unknown[], size: number) => number
  PostMessageW: (hwnd: unknown, message: number, wParam: number, lParam: number) => number
  ScreenToClient: (hwnd: unknown, point: NativePoint) => number
  GetLastInputInfo: (info: Buffer) => number
  GetTickCount: () => number
  OpenClipboard: (hwnd: unknown) => number
  EmptyClipboard: () => number
  SetClipboardData: (format: number, memory: unknown) => unknown
  CloseClipboard: () => number
  GetClipboardData: (format: number) => unknown
  EnumClipboardFormats: (format: number) => number
  GlobalAlloc: (flags: number, bytes: number) => unknown
  GlobalLock: (memory: unknown) => unknown
  GlobalUnlock: (memory: unknown) => number
  GlobalSize: (memory: unknown) => unknown
  GlobalFree: (memory: unknown) => unknown
  RtlMoveMemory: (dest: unknown, source: unknown, bytes: number) => void
  OpenProcess: (access: number, inherit: number, pid: number) => unknown
  CloseHandle: (handle: unknown) => number
  QueryFullProcessImageNameW: (process: unknown, flags: number, buffer: Buffer, size: number[]) => number
  OpenProcessToken: (process: unknown, access: number, token: unknown[]) => number
  GetTokenInformation: (token: unknown, cls: number, buffer: Buffer | null, size: number, needed: number[]) => number
  GetSidSubAuthorityCount: (sid: unknown) => unknown
  GetSidSubAuthority: (sid: unknown, index: number) => unknown
  ShellExecuteW: (hwnd: unknown, verb: string | null, file: string, params: string | null, dir: string | null, show: number) => unknown
  DwmGetWindowAttribute: (hwnd: unknown, attribute: number, buffer: Buffer, size: number) => number
  enumProc: ReturnType<typeof koffi.proto>
  childProc: ReturnType<typeof koffi.proto>
  monitorProc: ReturnType<typeof koffi.proto>
} {
  const { user32, gdi32, kernel32, shell32, advapi32, dwmapi } = libraries
  const enumProc = koffi.proto('int __stdcall DshCuEnumWindowsProc(void *hwnd, intptr lParam)')
  const childProc = koffi.proto('int __stdcall DshCuEnumChildProc(void *hwnd, intptr lParam)')
  const monitorProc = koffi.proto(
    'int __stdcall DshCuMonitorEnumProc(void *hMonitor, void *hdc, DSH_CU_RECT *lprc, intptr lParam)',
  )
  let setThreadDpi: ((context: DpiContext) => unknown) | undefined
  try {
    setThreadDpi = user32.func('intptr __stdcall SetThreadDpiAwarenessContext(intptr dpiContext)')
  } catch {
    // Windows 10 before 1607 has no per-thread DPI context. Calls stay on the process awareness.
    setThreadDpi = undefined
  }
  let getDpiForMonitor: ((monitor: unknown, type: number, dpiX: number[], dpiY: number[]) => number) | undefined
  try {
    const shcore = koffi.load('shcore.dll')
    getDpiForMonitor = shcore.func(
      'int __stdcall GetDpiForMonitor(void *hmonitor, int dpiType, _Out_ uint32 *dpiX, _Out_ uint32 *dpiY)',
    )
  } catch {
    // shcore is absent. Monitor scale stays 1; rectangles still come from the thread awareness.
    getDpiForMonitor = undefined
  }
  return {
    GetForegroundWindow: user32.func('void * __stdcall GetForegroundWindow()'),
    GetWindowRect: user32.func('int __stdcall GetWindowRect(void *hWnd, _Out_ DSH_CU_RECT *lpRect)'),
    GetWindowTextLengthW: user32.func('int __stdcall GetWindowTextLengthW(void *hWnd)'),
    GetWindowTextW: user32.func('int __stdcall GetWindowTextW(void *hWnd, uint16_t *lpString, int nMaxCount)'),
    GetWindowThreadProcessId: user32.func('uint32 __stdcall GetWindowThreadProcessId(void *hWnd, _Out_ uint32 *lpdwProcessId)'),
    IsWindowVisible: user32.func('int __stdcall IsWindowVisible(void *hWnd)'),
    IsIconic: user32.func('int __stdcall IsIconic(void *hWnd)'),
    EnumWindows: user32.func('int __stdcall EnumWindows(DshCuEnumWindowsProc *lpEnumFunc, intptr lParam)'),
    EnumChildWindows: user32.func('int __stdcall EnumChildWindows(void *hWndParent, DshCuEnumChildProc *lpEnumFunc, intptr lParam)'),
    EnumDisplayMonitors: user32.func(
      'int __stdcall EnumDisplayMonitors(void *hdc, void *lprcClip, DshCuMonitorEnumProc *lpfnEnum, intptr dwData)',
    ),
    GetClassNameW: user32.func('int __stdcall GetClassNameW(void *hWnd, uint16_t *lpClassName, int nMaxCount)'),
    GetWindow: user32.func('void * __stdcall GetWindow(void *hWnd, uint32 uCmd)'),
    GetAncestor: user32.func('void * __stdcall GetAncestor(void *hwnd, uint32 gaFlags)'),
    GetParent: user32.func('void * __stdcall GetParent(void *hwnd)'),
    IsWindowEnabled: user32.func('int __stdcall IsWindowEnabled(void *hWnd)'),
    GetWindowLongPtrW: user32.func('intptr __stdcall GetWindowLongPtrW(void *hWnd, int nIndex)'),
    ShowWindow: user32.func('int __stdcall ShowWindow(void *hWnd, int nCmdShow)'),
    SetForegroundWindow: user32.func('int __stdcall SetForegroundWindow(void *hWnd)'),
    MonitorFromWindow: user32.func('void * __stdcall MonitorFromWindow(void *hwnd, uint32 dwFlags)'),
    GetMonitorInfoW: user32.func('int __stdcall GetMonitorInfoW(void *hMonitor, _Inout_ uint8_t *lpmi)'),
    GetSystemMetrics: user32.func('int __stdcall GetSystemMetrics(int nIndex)'),
    GetCursorPos: user32.func('int __stdcall GetCursorPos(_Out_ DSH_CU_POINT *lpPoint)'),
    SetCursorPos: user32.func('int __stdcall SetCursorPos(int X, int Y)'),
    WindowFromPoint: user32.func('void * __stdcall WindowFromPoint(DSH_CU_POINT point)'),
    GetCursorInfo: user32.func('int __stdcall GetCursorInfo(_Inout_ uint8_t *pci)'),
    GetIconInfo: user32.func('int __stdcall GetIconInfo(void *hIcon, _Out_ uint8_t *piconinfo)'),
    SetThreadDpiAwarenessContext: setThreadDpi,
    GetDpiForMonitor: getDpiForMonitor,
    GetDC: user32.func('void * __stdcall GetDC(void *hWnd)'),
    ReleaseDC: user32.func('int __stdcall ReleaseDC(void *hWnd, void *hDC)'),
    CreateCompatibleDC: gdi32.func('void * __stdcall CreateCompatibleDC(void *hdc)'),
    CreateCompatibleBitmap: gdi32.func('void * __stdcall CreateCompatibleBitmap(void *hdc, int cx, int cy)'),
    SelectObject: gdi32.func('void * __stdcall SelectObject(void *hdc, void *h)'),
    BitBlt: gdi32.func(
      'int __stdcall BitBlt(void *hdc, int x, int y, int cx, int cy, void *hdcSrc, int x1, int y1, uint32 rop)',
    ),
    PrintWindow: user32.func('int __stdcall PrintWindow(void *hwnd, void *hdcBlt, uint32 nFlags)'),
    DwmFlush: dwmapi.func('int __stdcall DwmFlush()'),
    GetGUIThreadInfo: user32.func(
      'int __stdcall GetGUIThreadInfo(uint32 idThread, _Inout_ DSH_CU_GUITHREADINFO *pgui)',
    ),
    GetFocus: user32.func('void * __stdcall GetFocus()'),
    LoadCursorW: user32.func('void * __stdcall LoadCursorW(void *hInstance, intptr lpCursorName)'),
    GetDIBits: gdi32.func(
      'int __stdcall GetDIBits(void *hdc, void *hbm, uint32 start, uint32 cLines, '
      + '_Out_ uint8_t *lpvBits, _Inout_ DSH_CU_BITMAPINFOHEADER *lpbmi, uint32 usage)',
    ),
    DeleteObject: gdi32.func('int __stdcall DeleteObject(void *ho)'),
    DeleteDC: gdi32.func('int __stdcall DeleteDC(void *hdc)'),
    GetObjectW: gdi32.func('int __stdcall GetObjectW(void *h, int c, _Out_ uint8_t *pv)'),
    SendInput: user32.func('uint32 __stdcall SendInput(uint32 cInputs, DSH_CU_INPUT *pInputs, int cbSize)'),
    PostMessageW: user32.func('int __stdcall PostMessageW(void *hWnd, uint32 Msg, uintptr wParam, intptr lParam)'),
    ScreenToClient: user32.func('int __stdcall ScreenToClient(void *hWnd, _Inout_ DSH_CU_POINT *lpPoint)'),
    GetLastInputInfo: user32.func('int __stdcall GetLastInputInfo(_Inout_ uint8_t *plii)'),
    GetTickCount: kernel32.func('uint32 __stdcall GetTickCount()'),
    OpenClipboard: user32.func('int __stdcall OpenClipboard(void *hWndNewOwner)'),
    EmptyClipboard: user32.func('int __stdcall EmptyClipboard()'),
    SetClipboardData: user32.func('void * __stdcall SetClipboardData(uint32 uFormat, void *hMem)'),
    CloseClipboard: user32.func('int __stdcall CloseClipboard()'),
    GetClipboardData: user32.func('void * __stdcall GetClipboardData(uint32 uFormat)'),
    EnumClipboardFormats: user32.func('uint32 __stdcall EnumClipboardFormats(uint32 format)'),
    GlobalAlloc: kernel32.func('void * __stdcall GlobalAlloc(uint32 uFlags, uintptr dwBytes)'),
    GlobalLock: kernel32.func('void * __stdcall GlobalLock(void *hMem)'),
    GlobalUnlock: kernel32.func('int __stdcall GlobalUnlock(void *hMem)'),
    GlobalSize: kernel32.func('uintptr __stdcall GlobalSize(void *hMem)'),
    GlobalFree: kernel32.func('void * __stdcall GlobalFree(void *hMem)'),
    RtlMoveMemory: kernel32.func('void __stdcall RtlMoveMemory(void *Destination, void *Source, uintptr Length)'),
    OpenProcess: kernel32.func(
      'void * __stdcall OpenProcess(uint32 dwDesiredAccess, int bInheritHandle, uint32 dwProcessId)',
    ),
    CloseHandle: kernel32.func('int __stdcall CloseHandle(void *hObject)'),
    QueryFullProcessImageNameW: kernel32.func(
      'int __stdcall QueryFullProcessImageNameW(void *hProcess, uint32 dwFlags, '
      + 'uint16_t *lpExeName, _Inout_ uint32 *lpdwSize)',
    ),
    OpenProcessToken: advapi32.func(
      'int __stdcall OpenProcessToken(void *ProcessHandle, uint32 DesiredAccess, _Out_ void **TokenHandle)',
    ),
    GetTokenInformation: advapi32.func(
      'int __stdcall GetTokenInformation(void *TokenHandle, int TokenInformationClass, '
      + '_Out_ uint8_t *TokenInformation, uint32 TokenInformationLength, _Out_ uint32 *ReturnLength)',
    ),
    GetSidSubAuthorityCount: advapi32.func('uint8_t * __stdcall GetSidSubAuthorityCount(void *pSid)'),
    GetSidSubAuthority: advapi32.func(
      'uint32 * __stdcall GetSidSubAuthority(void *pSid, uint32 nSubAuthority)',
    ),
    ShellExecuteW: shell32.func(
      'intptr __stdcall ShellExecuteW(void *hwnd, str16 lpOperation, str16 lpFile, '
      + 'str16 lpParameters, str16 lpDirectory, int nShowCmd)',
    ),
    DwmGetWindowAttribute: dwmapi.func(
      'int __stdcall DwmGetWindowAttribute(void *hwnd, uint32 dwAttribute, _Out_ uint8_t *pvAttribute, uint32 cbAttribute)',
    ),
    enumProc,
    childProc,
    monitorProc,
  }
}

type Bindings = ReturnType<typeof bind>

function windowText(api: Bindings, hwnd: unknown): string {
  const length = api.GetWindowTextLengthW(hwnd)
  if (length <= 0) return ''
  const buffer = Buffer.alloc((length + 1) * 2)
  api.GetWindowTextW(hwnd, buffer, length + 1)
  return buffer.toString('utf16le', 0, length * 2)
}

function classNameOf(api: Bindings, hwnd: unknown): string {
  const buffer = Buffer.alloc(256 * 2)
  const length = api.GetClassNameW(hwnd, buffer, 256)
  if (length <= 0) return ''
  return buffer.toString('utf16le', 0, length * 2)
}

function pidOf(api: Bindings, hwnd: unknown): number {
  const pid = [0]
  api.GetWindowThreadProcessId(hwnd, pid)
  return pid[0] ?? 0
}

function processBaseName(api: Bindings, pid: number): string | undefined {
  if (pid === 0) return undefined
  const handle = api.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid)
  if (isNull(handle)) return undefined
  try {
    const chars = Buffer.alloc(1024 * 2)
    const size = [1024]
    if (api.QueryFullProcessImageNameW(handle, 0, chars, size) === 0) return undefined
    const count = size[0] ?? 0
    const full = chars.toString('utf16le', 0, count * 2)
    const base = full.split(/[\\/]/u).at(-1) ?? full
    return base.replace(/\.exe$/iu, '')
  } finally {
    api.CloseHandle(handle)
  }
}

function integrityRid(api: Bindings, pid: number): number | undefined {
  try {
    return integrityRidUnchecked(api, pid)
  } catch {
    // Token or SID queries can throw when koffi cannot decode an inaccessible process.
    return undefined
  }
}

let warnedUnknownSelf = false

/** Say once that the elevation check fell back to the unelevated default. */
function warnUnknownSelfIntegrity(): void {
  if (warnedUnknownSelf) return
  warnedUnknownSelf = true
  console.error('computer-use: this process integrity level cannot be read; assuming unelevated')
}

function integrityRidUnchecked(api: Bindings, pid: number): number | undefined {
  const handle = api.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid)
  if (isNull(handle)) return undefined
  const token: unknown[] = [null]
  try {
    if (api.OpenProcessToken(handle, TOKEN_QUERY, token) === 0) return undefined
    const tokenHandle = token[0]
    try {
      const needed = [0]
      api.GetTokenInformation(tokenHandle, TokenIntegrityLevel, null, 0, needed)
      const size = needed[0] ?? 0
      if (size < 8) return undefined
      const info = Buffer.alloc(size)
      if (api.GetTokenInformation(tokenHandle, TokenIntegrityLevel, info, size, needed) === 0) return undefined
      const sid = info.readBigUInt64LE(0)
      const countPtr = api.GetSidSubAuthorityCount(sid)
      const count = koffi.decode(countPtr, 'uint8') as number
      if (count < 1) return undefined
      const ridPtr = api.GetSidSubAuthority(sid, count - 1)
      return koffi.decode(ridPtr, 'uint32') as number
    } finally {
      api.CloseHandle(tokenHandle)
    }
  } finally {
    api.CloseHandle(handle)
  }
}

function explorerFolder(hwnd: number): string | undefined {
  const script = `
$shell = New-Object -ComObject Shell.Application
foreach ($window in @($shell.Windows())) {
  if ([int64]$window.HWND -eq ${String(hwnd)}) {
    $window.Document.Folder.Self.Path
    break
  }
}
`
  try {
    const stdout = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 2000,
    })
    const path = stdout.trim()
    return path === '' ? undefined : path
  } catch {
    return undefined
  }
}

function sendMouse(api: Bindings, flags: number, x: number, y: number, data = 0): void {
  const absolute = (flags & MOUSEEVENTF_ABSOLUTE) !== 0
  const left = api.GetSystemMetrics(SM_XVIRTUALSCREEN)
  const top = api.GetSystemMetrics(SM_YVIRTUALSCREEN)
  const width = Math.max(1, api.GetSystemMetrics(SM_CXVIRTUALSCREEN))
  const height = Math.max(1, api.GetSystemMetrics(SM_CYVIRTUALSCREEN))
  // An absolute point outside the virtual desktop is not rejected by SendInput: Windows clamps it
  // to the nearest edge, so a stale or mismapped coordinate silently clicks somewhere else. Refuse
  // it here and name both the point and the desktop the caller can target.
  if (absolute && (x < left || y < top || x >= left + width || y >= top + height)) {
    throw new Error(
      `computer-use: pointer target (${String(x)}, ${String(y)}) is outside the virtual desktop `
      + `x ${String(left)}..${String(left + width - 1)}, y ${String(top)}..${String(top + height - 1)}`,
    )
  }
  const input = {
    type: INPUT_MOUSE,
    u: {
      mi: {
        dx: absolute ? Math.round(((x - left) * 65535) / Math.max(1, width - 1)) : x,
        dy: absolute ? Math.round(((y - top) * 65535) / Math.max(1, height - 1)) : y,
        mouseData: data >>> 0,
        dwFlags: flags,
        time: 0,
        dwExtraInfo: 0,
      },
    },
  }
  if (api.SendInput(1, [input], INPUT.size) !== 1) {
    throw new Error('computer-use: [retryable] Windows refused the pointer event, so nothing was posted; the same action can be retried')
  }
}

function postKey(api: Bindings, virtualKey: number, down: boolean, extended: boolean): void {
  const input = {
    type: INPUT_KEYBOARD,
    u: {
      ki: {
        wVk: virtualKey,
        wScan: 0,
        dwFlags: (down ? 0 : KEYEVENTF_KEYUP) | (extended ? KEYEVENTF_EXTENDEDKEY : 0),
        time: 0,
        dwExtraInfo: 0,
      },
    },
  }
  if (api.SendInput(1, [input], INPUT.size) !== 1) {
    throw new Error('computer-use: [retryable] Windows refused the key event, so nothing was posted; the same action can be retried')
  }
}

function withClipboard(api: Bindings, write: () => void): void {
  if (api.OpenClipboard(null) === 0) throw new Error('computer-use: OpenClipboard failed')
  try {
    write()
  } finally {
    api.CloseClipboard()
  }
}

function enumTopLevel(api: Bindings): unknown[] {
  const hwnds: unknown[] = []
  const callback = koffi.register((hwnd: unknown) => {
    hwnds.push(hwnd)
    return 1
  }, koffi.pointer(api.enumProc))
  try {
    api.EnumWindows(callback, 0)
  } finally {
    koffi.unregister(callback)
  }
  return hwnds
}

function coreWindowPid(api: Bindings, hwnd: unknown): number | undefined {
  let found = 0
  const callback = koffi.register((child: unknown) => {
    if (classNameOf(api, child) !== 'Windows.UI.Core.CoreWindow') return 1
    found = pidOf(api, child)
    return 0
  }, koffi.pointer(api.childProc))
  try {
    api.EnumChildWindows(hwnd, callback, 0)
  } finally {
    koffi.unregister(callback)
  }
  return found === 0 ? undefined : found
}

function frameOf(api: Bindings, hwnd: unknown): WindowsRect | undefined {
  const extended = Buffer.alloc(16)
  if (api.DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, extended, 16) === 0) {
    const left = extended.readInt32LE(0)
    const top = extended.readInt32LE(4)
    const right = extended.readInt32LE(8)
    const bottom = extended.readInt32LE(12)
    return { x: left, y: top, width: right - left, height: bottom - top }
  }
  const rect: NativeRect = { left: 0, top: 0, right: 0, bottom: 0 }
  if (api.GetWindowRect(hwnd, rect) === 0) return undefined
  return { x: rect.left, y: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top }
}

function pointerKey(value: unknown): string {
  if (typeof value === 'bigint') return `0x${value.toString(16)}`
  if (typeof value === 'number' && Number.isFinite(value)) return `0x${Math.trunc(value).toString(16)}`
  return String(value)
}

function samePointer(left: unknown, right: unknown): boolean {
  if (isNull(left) || isNull(right)) return false
  return pointerKey(left) === pointerKey(right)
}

interface NativeMonitorInfo {
  readonly rect: WindowsRect
  readonly work: WindowsRect
  readonly primary: boolean
  readonly name: string
}

function monitorInfo(api: Bindings, monitor: unknown): NativeMonitorInfo | undefined {
  const info = Buffer.alloc(MONITORINFOEX_SIZE)
  info.writeUInt32LE(MONITORINFOEX_SIZE, 0)
  if (api.GetMonitorInfoW(monitor, info) === 0) return undefined
  const rect = {
    x: info.readInt32LE(4),
    y: info.readInt32LE(8),
    width: info.readInt32LE(12) - info.readInt32LE(4),
    height: info.readInt32LE(16) - info.readInt32LE(8),
  }
  const work = {
    x: info.readInt32LE(20),
    y: info.readInt32LE(24),
    width: info.readInt32LE(28) - info.readInt32LE(20),
    height: info.readInt32LE(32) - info.readInt32LE(24),
  }
  const flags = info.readUInt32LE(36)
  const rawName = info.toString('utf16le', 40, MONITORINFOEX_SIZE)
  const nul = rawName.indexOf('\u0000')
  return {
    rect,
    work,
    primary: (flags & MONITORINFOF_PRIMARY) !== 0,
    name: nul < 0 ? rawName : rawName.slice(0, nul),
  }
}

function withDpiContext<T>(api: Bindings, context: DpiContext, run: () => T): T {
  const set = api.SetThreadDpiAwarenessContext
  if (set === undefined) return run()
  const previous = dpiContext(set(context))
  try {
    return run()
  } finally {
    if (previous !== undefined) set(previous)
  }
}

function enumMonitors(api: Bindings): unknown[] {
  const monitors: unknown[] = []
  const callback = koffi.register((monitor: unknown) => {
    monitors.push(monitor)
    return 1
  }, koffi.pointer(api.monitorProc))
  try {
    api.EnumDisplayMonitors(null, null, callback, 0)
  } finally {
    koffi.unregister(callback)
  }
  return monitors
}

function dialogClass(className: string): boolean {
  const lower = className.toLowerCase()
  return className === '#32770' || lower.includes('dialog') || lower.includes('modal')
}

function modalFacts(api: Bindings, root: unknown): ModalWindowFact[] {
  const facts: ModalWindowFact[] = []
  const add = (hwnd: unknown, child: boolean, ownerOverride?: unknown): void => {
    const id = hwndId(hwnd)
    if (id === undefined) return
    const owner = ownerOverride ?? api.GetWindow(hwnd, GW_OWNER)
    facts.push({
      hwnd: id,
      ownerHwnd: hwndId(owner) ?? 0,
      className: classNameOf(api, hwnd),
      title: windowText(api, hwnd),
      visible: api.IsWindowVisible(hwnd) !== 0,
      enabled: api.IsWindowEnabled(hwnd) !== 0,
      child,
    })
  }
  for (const hwnd of enumTopLevel(api)) add(hwnd, false)
  const enabledPopup = api.GetWindow(root, GW_ENABLEDPOPUP)
  if (!isNull(enabledPopup)) add(enabledPopup, true, root)
  const childCallback = koffi.register((child: unknown) => {
    if (api.IsWindowVisible(child) !== 0 && dialogClass(classNameOf(api, child))) add(child, true, root)
    return 1
  }, koffi.pointer(api.childProc))
  try {
    api.EnumChildWindows(root, childCallback, 0)
  } finally {
    koffi.unregister(childCallback)
  }
  return facts
}

function cursorKind(api: Bindings, cursor: unknown): CursorKind {
  if (isNull(cursor)) return 'hidden'
  const systemCursors: ReadonlyArray<readonly [number, CursorKind]> = [
    [IDC_ARROW, 'arrow'],
    [IDC_HAND, 'hand'],
    [IDC_IBEAM, 'ibeam'],
    [IDC_CROSS, 'cross'],
    [IDC_WAIT, 'wait'],
    [IDC_SIZEWE, 'resize'],
    [IDC_SIZENS, 'resize'],
  ]
  for (const [id, kind] of systemCursors) {
    if (samePointer(cursor, api.LoadCursorW(null, id))) return kind
  }
  return 'other'
}

function readCursorSignal(api: Bindings): ActionCursor {
  const info = Buffer.alloc(CURSORINFO.size)
  info.writeUInt32LE(CURSORINFO.size, 0)
  if (api.GetCursorInfo(info) === 0) return { handle: 'hidden', kind: 'hidden' }
  const cursor = koffi.decode(info, CURSORINFO) as { flags: number; hCursor: unknown }
  if ((cursor.flags & CURSOR_SHOWING) === 0 || isNull(cursor.hCursor)) return { handle: 'hidden', kind: 'hidden' }
  return { handle: pointerKey(cursor.hCursor), kind: cursorKind(api, cursor.hCursor) }
}

function threadIdOf(api: Bindings, hwnd: unknown): number {
  const pid = [0]
  return api.GetWindowThreadProcessId(hwnd, pid)
}

function focusWindowOf(api: Bindings, hwnd: unknown): number {
  const threadId = threadIdOf(api, hwnd)
  if (threadId !== 0) {
    const info = Buffer.alloc(GUITHREADINFO.size)
    info.writeUInt32LE(GUITHREADINFO.size, 0)
    if (api.GetGUIThreadInfo(threadId, info) !== 0) {
      const decoded = koffi.decode(info, GUITHREADINFO) as { hwndFocus: unknown }
      const focus = hwndId(decoded.hwndFocus)
      if (focus !== undefined) return focus
    }
  }
  return hwndId(api.GetFocus()) ?? 0
}

function isSameOrDescendant(api: Bindings, candidate: unknown, root: unknown): boolean {
  if (isNull(candidate) || isNull(root)) return false
  let current: unknown = candidate
  const seen = new Set<string>()
  for (let depth = 0; depth < 32; depth += 1) {
    if (isNull(current)) return false
    const key = pointerKey(current)
    if (seen.has(key)) return false
    seen.add(key)
    if (samePointer(current, root)) return true
    current = api.GetParent(current)
  }
  return false
}

function cloaked(api: Bindings, hwnd: unknown): boolean {
  const flag = Buffer.alloc(4)
  if (api.DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, flag, 4) !== 0) return false
  return flag.readUInt32LE(0) !== 0
}

function bitmapSize(api: Bindings, bitmap: unknown): { width: number; height: number } | undefined {
  const info = Buffer.alloc(BITMAP.size)
  if (api.GetObjectW(bitmap, BITMAP.size, info) === 0) return undefined
  const decoded = koffi.decode(info, BITMAP) as { bmWidth: number; bmHeight: number }
  if (decoded.bmWidth <= 0 || decoded.bmHeight <= 0) return undefined
  return { width: decoded.bmWidth, height: decoded.bmHeight }
}

/** Read one bitmap as top-down 32-bit BGRA. `GetDIBits` converts depth and row order for us. */
function bitmapPixels(
  api: Bindings,
  dc: unknown,
  bitmap: unknown,
  size: { width: number; height: number },
): Buffer | undefined {
  const rowBytes = size.width * 4
  const pixels = Buffer.alloc(rowBytes * size.height)
  const header = {
    biSize: 40,
    biWidth: size.width,
    biHeight: size.height,
    biPlanes: 1,
    biBitCount: 32,
    biCompression: 0,
    biSizeImage: pixels.length,
    biXPelsPerMeter: 0,
    biYPelsPerMeter: 0,
    biClrUsed: 0,
    biClrImportant: 0,
  }
  if (api.GetDIBits(dc, bitmap, 0, size.height, pixels, header, 0) === 0) return undefined
  flipRows(pixels, rowBytes, size.height)
  return pixels
}

/**
 * Copy one physical screen rectangle with BitBlt.
 * All GDI objects are released in `finally`, including the failure path.
 */
function captureRegionPixels(api: Bindings, region: WindowsRect): Buffer {
  const screenDc = api.GetDC(null)
  if (isNull(screenDc)) throw new Error('computer-use: screen capture failed (GetDC)')
  const memory = api.CreateCompatibleDC(screenDc)
  if (isNull(memory)) {
    api.ReleaseDC(null, screenDc)
    throw new Error('computer-use: screen capture failed (CreateCompatibleDC)')
  }
  const bitmap = api.CreateCompatibleBitmap(screenDc, region.width, region.height)
  if (isNull(bitmap)) {
    api.DeleteDC(memory)
    api.ReleaseDC(null, screenDc)
    throw new Error('computer-use: screen capture failed (CreateCompatibleBitmap)')
  }
  const previous = api.SelectObject(memory, bitmap)
  try {
    if (api.BitBlt(memory, 0, 0, region.width, region.height, screenDc, region.x, region.y, SRCCOPY) === 0) {
      throw new Error('computer-use: screen capture failed (BitBlt)')
    }
    const pixels = bitmapPixels(api, memory, bitmap, { width: region.width, height: region.height })
    if (pixels === undefined) throw new Error('computer-use: screen capture failed (GetDIBits)')
    return pixels
  } finally {
    api.SelectObject(memory, previous)
    api.DeleteObject(bitmap)
    api.DeleteDC(memory)
    api.ReleaseDC(null, screenDc)
  }
}

/** Copy a rectangle out of a window-sized frame, filling any outside area with black. */
function cropPixels(
  source: Buffer,
  sourceWidth: number,
  sourceHeight: number,
  sourceRect: WindowsRect,
  target: WindowsRect,
): Buffer {
  const output = Buffer.alloc(target.width * target.height * 4)
  const offsetX = target.x - sourceRect.x
  const offsetY = target.y - sourceRect.y
  for (let y = 0; y < target.height; y += 1) {
    const sourceY = y + offsetY
    if (sourceY < 0 || sourceY >= sourceHeight) continue
    for (let x = 0; x < target.width; x += 1) {
      const sourceX = x + offsetX
      if (sourceX < 0 || sourceX >= sourceWidth) continue
      const sourceOffset = (sourceY * sourceWidth + sourceX) * 4
      const targetOffset = (y * target.width + x) * 4
      output[targetOffset] = source[sourceOffset] ?? 0
      output[targetOffset + 1] = source[sourceOffset + 1] ?? 0
      output[targetOffset + 2] = source[sourceOffset + 2] ?? 0
      output[targetOffset + 3] = 255
    }
  }
  return output
}

/**
 * Capture a window surface with `PrintWindow(PW_RENDERFULLCONTENT)` and crop the requested
 * screen rectangle out of it. This is the rescue path for GPU-composited and Chromium
 * surfaces that BitBlt leaves black. GDI objects are released on every path.
 */
function captureWindowPixels(api: Bindings, target: unknown, region: WindowsRect): Buffer {
  const windowRect: NativeRect = { left: 0, top: 0, right: 0, bottom: 0 }
  if (api.GetWindowRect(target, windowRect) === 0) {
    throw new Error('computer-use: PrintWindow failed (GetWindowRect)')
  }
  const width = windowRect.right - windowRect.left
  const height = windowRect.bottom - windowRect.top
  if (width <= 0 || height <= 0) throw new Error('computer-use: PrintWindow failed (empty window)')
  const screenDc = api.GetDC(null)
  if (isNull(screenDc)) throw new Error('computer-use: PrintWindow failed (GetDC)')
  const memory = api.CreateCompatibleDC(screenDc)
  if (isNull(memory)) {
    api.ReleaseDC(null, screenDc)
    throw new Error('computer-use: PrintWindow failed (CreateCompatibleDC)')
  }
  const bitmap = api.CreateCompatibleBitmap(screenDc, width, height)
  if (isNull(bitmap)) {
    api.DeleteDC(memory)
    api.ReleaseDC(null, screenDc)
    throw new Error('computer-use: PrintWindow failed (CreateCompatibleBitmap)')
  }
  const previous = api.SelectObject(memory, bitmap)
  try {
    if (api.PrintWindow(target, memory, PW_RENDERFULLCONTENT) === 0) {
      throw new Error('computer-use: PrintWindow returned false')
    }
    const pixels = bitmapPixels(api, memory, bitmap, { width, height })
    if (pixels === undefined) throw new Error('computer-use: PrintWindow failed (GetDIBits)')
    return cropPixels(pixels, width, height, {
      x: windowRect.left,
      y: windowRect.top,
      width,
      height,
    }, region)
  } finally {
    api.SelectObject(memory, previous)
    api.DeleteObject(bitmap)
    api.DeleteDC(memory)
    api.ReleaseDC(null, screenDc)
  }
}

interface NativeCursor {
  readonly pointer: NativePoint
  readonly hotspot: NativePoint
  readonly color: unknown
  readonly mask: unknown
}

/**
 * The system pointer as Win32 reports it.
 * `GetIconInfo` hands over two bitmaps the caller owns; the shared cursor handle is not ours to free.
 * @returns position, hotspot, and bitmaps, or undefined when no pointer is drawn.
 */
function readCursor(api: Bindings): NativeCursor | undefined {
  const info = Buffer.alloc(CURSORINFO.size)
  info.writeUInt32LE(CURSORINFO.size, 0)
  if (api.GetCursorInfo(info) === 0) return undefined
  const cursor = koffi.decode(info, CURSORINFO) as { flags: number; hCursor: unknown; ptScreenPos: NativePoint }
  if ((cursor.flags & CURSOR_SHOWING) === 0 || isNull(cursor.hCursor)) return undefined
  const icon = Buffer.alloc(ICONINFO.size)
  if (api.GetIconInfo(cursor.hCursor, icon) === 0) return undefined
  const decoded = koffi.decode(icon, ICONINFO) as {
    xHotspot: number
    yHotspot: number
    hbmMask: unknown
    hbmColor: unknown
  }
  return {
    pointer: { x: cursor.ptScreenPos.x, y: cursor.ptScreenPos.y },
    hotspot: { x: decoded.xHotspot, y: decoded.yHotspot },
    color: decoded.hbmColor,
    mask: decoded.hbmMask,
  }
}

/**
 * Draw the system pointer into one capture raster.
 * `BitBlt` copies the desktop without the cursor layer, so the agent cannot see where its
 * clicks land. macOS gets the same pointer baked in by `screencapture -x -C`.
 * @param bounds - capture region in physical pixels, matching the raster origin.
 */
function drawCursor(
  api: Bindings,
  pixels: Buffer,
  width: number,
  height: number,
  bounds: WindowsRect,
): void {
  const cursor = readCursor(api)
  if (cursor === undefined) return
  const screenDc = api.GetDC(null)
  if (isNull(screenDc)) return
  try {
    const size = bitmapSize(api, cursor.color)
    if (size === undefined) return
    const placement = cursorDrawPlacement(cursor.pointer, cursor.hotspot, size, bounds)
    if (placement === undefined) return
    const color = bitmapPixels(api, screenDc, cursor.color, size)
    if (color === undefined) return
    const mask = isNull(cursor.mask) ? undefined : bitmapPixels(api, screenDc, cursor.mask, size)
    const resolved = resolveCursorAlpha({
      width: size.width,
      height: size.height,
      color,
      ...mask === undefined ? {} : { mask },
    })
    compositeCursor(pixels, width, height, resolved, size.width, size.height, placement)
  } finally {
    if (!isNull(cursor.color)) api.DeleteObject(cursor.color)
    if (!isNull(cursor.mask)) api.DeleteObject(cursor.mask)
    api.ReleaseDC(null, screenDc)
  }
}

function monitorOf(api: Bindings, hwnd: unknown, fallback: WindowsRect): { monitor: WindowsRect; dpi: number } {
  const handle = api.MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST)
  if (isNull(handle)) return { monitor: fallback, dpi: 96 }
  const info = Buffer.alloc(40)
  info.writeUInt32LE(40, 0)
  if (api.GetMonitorInfoW(handle, info) === 0) return { monitor: fallback, dpi: 96 }
  const left = info.readInt32LE(4)
  const top = info.readInt32LE(8)
  const right = info.readInt32LE(12)
  const bottom = info.readInt32LE(16)
  const monitor = { x: left, y: top, width: right - left, height: bottom - top }
  const readDpi = api.GetDpiForMonitor
  if (readDpi === undefined) return { monitor, dpi: 96 }
  const dpiX = [0]
  const dpiY = [0]
  if (readDpi(handle, MDT_EFFECTIVE_DPI, dpiX, dpiY) !== 0) return { monitor, dpi: 96 }
  const dpi = dpiX[0] ?? 0
  return { monitor, dpi: dpi > 0 ? dpi : 96 }
}

function stylesOf(api: Bindings, hwnd: unknown): { popup: boolean; toolWindow: boolean } {
  const style = low32(api.GetWindowLongPtrW(hwnd, GWL_STYLE))
  const extended = low32(api.GetWindowLongPtrW(hwnd, GWL_EXSTYLE))
  return {
    popup: (style & WS_POPUP) !== 0,
    toolWindow: (extended & WS_EX_TOOLWINDOW) !== 0,
  }
}

function cachedAppName(api: Bindings, cache: Map<number, string>, pid: number): string {
  const cached = cache.get(pid)
  if (cached !== undefined) return cached
  const name = processBaseName(api, pid) ?? 'unknown'
  cache.set(pid, name)
  return name
}

/**
 * Win32 operations for the production Windows backend.
 * @param options - hardening switches and probe tunables from the plugin config.
 * @returns operations that capture and post input on this machine.
 */
export function createProductionWindowsOps(
  options: ResolvedWindowsDesktopOptions = {
    displayInventoryEnabled: true,
    modalGuardEnabled: true,
    captureFallbackEnabled: true,
    printWindowEnabled: true,
    dwmFlushEnabled: true,
    hoverFeedbackEnabled: true,
    hoverPixelTolerance: 8,
    hoverMinChangedRatio: 0.02,
    hoverMinChangedPixels: 16,
    hoverSettleMs: 80,
  },
): WindowsDesktopOps {
  if (process.arch === 'x64' && INPUT.size !== 40) {
    throw new Error(`computer-use: INPUT size ${String(INPUT.size)} is not 40`)
  }
  if (process.arch === 'x64' && (CURSORINFO.size !== 24 || ICONINFO.size !== 32 || BITMAP.size !== 32)) {
    throw new Error('computer-use: cursor structs are not laid out for x64')
  }
  if (process.arch === 'x64' && GUITHREADINFO.size !== 72) {
    throw new Error(`computer-use: GUITHREADINFO size ${String(GUITHREADINFO.size)} is not 72`)
  }
  const libraries: NativeBindings = {
    user32: koffi.load('user32.dll'),
    gdi32: koffi.load('gdi32.dll'),
    kernel32: koffi.load('kernel32.dll'),
    shell32: koffi.load('shell32.dll'),
    advapi32: koffi.load('advapi32.dll'),
    dwmapi: koffi.load('dwmapi.dll'),
  }
  const api = bind(libraries)
  const selfRid = integrityRid(api, process.pid)

  function perMonitor<T>(fn: () => T): T {
    const set = api.SetThreadDpiAwarenessContext
    if (set === undefined) return fn()
    const first = dpiContext(set(DPI_PER_MONITOR_V2))
    const restore = first ?? dpiContext(set(DPI_PER_MONITOR))
    if (restore === undefined) return fn()
    try {
      return fn()
    } finally {
      set(restore)
    }
  }

  function placePointer(x: number, y: number): void {
    sendMouse(api, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, x, y)
    const pos: NativePoint = { x: 0, y: 0 }
    if (api.GetCursorPos(pos) === 0 || pos.x !== x || pos.y !== y) {
      if (api.SetCursorPos(x, y) === 0) {
        throw new Error('computer-use: [retryable] the pointer could not be moved and no click was posted; the same action can be retried')
      }
    }
  }

  function listWindows(): WindowsDesktopSnapshot {
    return perMonitor(() => {
      const names = new Map<number, string>()
      const windows: WindowsWindowFact[] = []
      for (const hwnd of enumTopLevel(api)) {
        const id = hwndId(hwnd)
        if (id === undefined) continue
        const frame = frameOf(api, hwnd)
        if (frame === undefined) continue
        const className = classNameOf(api, hwnd)
        const pid = pidOf(api, hwnd)
        const appPid = appOwnerPid(className, pid, () => coreWindowPid(api, hwnd))
        const styles = stylesOf(api, hwnd)
        const display = monitorOf(api, hwnd, frame)
        windows.push({
          hwnd: id,
          pid: appPid,
          ownerHwnd: hwndId(api.GetWindow(hwnd, GW_OWNER)) ?? 0,
          className,
          appName: cachedAppName(api, names, appPid),
          title: windowText(api, hwnd),
          visible: api.IsWindowVisible(hwnd) !== 0,
          iconic: api.IsIconic(hwnd) !== 0,
          cloaked: cloaked(api, hwnd),
          toolWindow: styles.toolWindow,
          popup: styles.popup,
          frame,
          monitor: display.monitor,
          monitorDpi: display.dpi,
        })
      }
      return {
        foregroundHwnd: hwndId(api.GetForegroundWindow()) ?? 0,
        windows,
      }
    })
  }

  function isForeground(hwnd: unknown): boolean {
    return hwndId(api.GetForegroundWindow()) === hwndId(hwnd)
  }

  function windowPointer(id: number): unknown {
    if (!Number.isSafeInteger(id) || id <= 0) return undefined
    for (const hwnd of enumTopLevel(api)) {
      if (hwndId(hwnd) === id) return hwnd
    }
    return undefined
  }

  /**
   * `SetForegroundWindow` is ignored unless this process received the last input.
   * A posted Alt transition satisfies that, then the key is released.
   * @param target - top-level HWND pointer from `EnumWindows`.
   * @returns false when `target` is still not foreground after one retry.
   */
  function becomeForeground(target: unknown): boolean {
    if (api.IsIconic(target) !== 0) api.ShowWindow(target, SW_RESTORE)
    postKey(api, VK_MENU, true, false)
    try {
      api.SetForegroundWindow(target)
      if (!isForeground(target)) {
        sleepSync(FOREGROUND_RETRY_MS)
        if (!isForeground(target)) return false
      }
      return true
    } finally {
      postKey(api, VK_MENU, false, false)
    }
  }

  function monitorDpi(monitor: unknown): { x: number; y: number } {
    const read = api.GetDpiForMonitor
    if (read === undefined) return { x: 96, y: 96 }
    const x = [0]
    const y = [0]
    if (read(monitor, MDT_EFFECTIVE_DPI, x, y) !== 0) return { x: 96, y: 96 }
    return { x: (x[0] ?? 0) > 0 ? x[0] ?? 96 : 96, y: (y[0] ?? 0) > 0 ? y[0] ?? 96 : 96 }
  }

  function displayInventoryNow(): DisplayInventory {
    return perMonitor(() => {
      const displays: DisplayInfo[] = []
      for (const [index, monitor] of enumMonitors(api).entries()) {
        const physical = monitorInfo(api, monitor)
        if (physical === undefined) continue
        const logical = withDpiContext(api, DPI_UNAWARE, () => monitorInfo(api, monitor)) ?? physical
        const dpi = monitorDpi(monitor)
        const scale = dpi.x / 96
        displays.push({
          index,
          name: physical.name === '' ? `display-${String(index)}` : physical.name,
          handle: pointerKey(monitor),
          primary: physical.primary,
          physicalRect: physical.rect,
          workArea: physical.work,
          logicalRect: logical.rect,
          dpiX: dpi.x,
          dpiY: dpi.y,
          scale,
          rotation: 0,
        })
      }
      const awareness: DpiAwareness = api.SetThreadDpiAwarenessContext === undefined
        ? 'unknown'
        : 'per-monitor-v2'
      return {
        sampledAt: new Date().toISOString(),
        dpiAwareness: awareness,
        virtualDesktop: {
          x: api.GetSystemMetrics(SM_XVIRTUALSCREEN),
          y: api.GetSystemMetrics(SM_YVIRTUALSCREEN),
          width: Math.max(1, api.GetSystemMetrics(SM_CXVIRTUALSCREEN)),
          height: Math.max(1, api.GetSystemMetrics(SM_CYVIRTUALSCREEN)),
        },
        displays,
      }
    })
  }

  function detectModalNow(): ModalState | undefined {
    return perMonitor(() => {
      const foreground = api.GetForegroundWindow()
      if (isNull(foreground)) return undefined
      const root = api.GetAncestor(foreground, GA_ROOT)
      const target = isNull(root) ? foreground : root
      const rootId = hwndId(target)
      if (rootId === undefined) return undefined
      return detectModalFromFacts(rootId, modalFacts(api, target))
    })
  }

  function inspectActionNow(
    windowId?: number,
    point?: { readonly x: number; readonly y: number },
  ): ActionSnapshot {
    return perMonitor(() => {
      let target = windowId === undefined ? undefined : windowPointer(windowId)
      if (target === undefined && point !== undefined) {
        const hit = api.WindowFromPoint({ x: point.x, y: point.y })
        if (!isNull(hit)) {
          const root = api.GetAncestor(hit, GA_ROOT)
          target = isNull(root) ? hit : root
        }
      }
      const targetId = target === undefined ? windowId : hwndId(target)
      const focus = target === undefined ? 0 : focusWindowOf(api, target)
      const foreground = hwndId(api.GetForegroundWindow()) ?? 0
      const modal = options.modalGuardEnabled ? detectModalNow() : undefined
      const windowRect = target === undefined ? undefined : frameOf(api, target)
      return {
        ...targetId === undefined ? {} : { windowId: targetId },
        ...windowRect === undefined ? {} : { windowRect },
        foregroundWindowId: foreground,
        focusWindowId: focus,
        focusOnTarget: target === undefined ? false : isSameOrDescendant(api, api.GetAncestor(focus, GA_ROOT), api.GetAncestor(target, GA_ROOT)),
        targetEnabled: target === undefined ? true : api.IsWindowEnabled(target) !== 0,
        ...modal === undefined ? {} : { modal },
        cursor: readCursorSignal(api),
      }
    })
  }

  function captureFramePixels(region: WindowsRect, windowId?: number): Buffer {
    const target = windowId === undefined ? undefined : windowPointer(windowId)
    const choice = captureWithFallback<Buffer>({
      enabled: options.captureFallbackEnabled,
      dwmFlush: () => {
        if (options.dwmFlushEnabled) api.DwmFlush()
      },
      bitblt: () => captureRegionPixels(api, region),
      ...target === undefined || !options.printWindowEnabled
        ? {}
        : { printWindow: () => captureWindowPixels(api, target, region) },
      isDegenerate: pixels => bitmapLooksDegenerate(pixels, region.width, region.height).degenerate,
    })
    if (choice.backend === 'printwindow') {
      // One line is enough to explain a rescue in the host log; titles never go here.
      console.error(
        `computer-use: capture backend PrintWindow (${choice.fallbackReason ?? 'fallback'}`
        + `${choice.printWindowDegenerate ? ', still degenerate' : ''})`,
      )
    }
    return choice.data
  }

  let hoverBaseline: { key: string; pixels: Buffer; at: number } | undefined

  function hoverProbeNow(
    rect: WindowsRect,
    point: { readonly x: number; readonly y: number },
    settleMs = options.hoverSettleMs,
  ): HoverFeedback {
    return perMonitor(() => {
      if (!options.hoverFeedbackEnabled) return unavailableHoverFeedback('hover feedback is disabled')
      const width = Math.max(1, Math.round(rect.width))
      const height = Math.max(1, Math.round(rect.height))
      const normalized = { x: Math.round(rect.x), y: Math.round(rect.y), width, height }
      const foregroundKey = pointerKey(api.GetForegroundWindow())
      const key = `${foregroundKey}:${String(normalized.x)},${String(normalized.y)},${String(width)},${String(height)}`
      const pos: NativePoint = { x: 0, y: 0 }
      const hasPos = api.GetCursorPos(pos) !== 0
      const pointerInside = hasPos
        && pos.x >= normalized.x && pos.x <= normalized.x + normalized.width
        && pos.y >= normalized.y && pos.y <= normalized.y + normalized.height
      if (hoverBaseline === undefined || hoverBaseline.key !== key || Date.now() - hoverBaseline.at > 10_000) {
        if (pointerInside) {
          return unavailableHoverFeedback('the pointer was already over the target and no baseline frame exists')
        }
        const baseline = captureFramePixels(normalized)
        hoverBaseline = { key, pixels: baseline, at: Date.now() }
      }
      const beforeCursor = readCursorSignal(api)
      if (!hasPos || pos.x !== point.x || pos.y !== point.y) placePointer(point.x, point.y)
      if (settleMs > 0) sleepSync(settleMs)
      const after = captureFramePixels(normalized)
      const afterCursor = readCursorSignal(api)
      const diff = compareHoverFrames(hoverBaseline.pixels, after, width, height, {
        pixelTolerance: options.hoverPixelTolerance,
        minChangedRatio: options.hoverMinChangedRatio,
        minChangedPixels: options.hoverMinChangedPixels,
      })
      const feedback = judgeHoverFeedback(diff, {
        pixelTolerance: options.hoverPixelTolerance,
        minChangedRatio: options.hoverMinChangedRatio,
        minChangedPixels: options.hoverMinChangedPixels,
      }, {
        before: beforeCursor.kind,
        after: afterCursor.kind,
        changed: beforeCursor.handle !== afterCursor.handle,
      })
      // Keep the pre-hover baseline for the follow-up preview: keeping the post-hover
      // frame would make the second preview compare hover against hover and report none.
      return feedback
    })
  }

  return {
    listWindows,
    ...options.displayInventoryEnabled ? { displayInventory: displayInventoryNow } : {},
    ...options.modalGuardEnabled ? { detectModal: detectModalNow } : {},
    inspectAction: inspectActionNow,
    hoverProbe: hoverProbeNow,
    capturePng(bounds, mark, windowId) {
      return perMonitor(() => {
        const width = Math.max(1, Math.round(bounds.width))
        const height = Math.max(1, Math.round(bounds.height))
        const originX = Math.round(bounds.x)
        const originY = Math.round(bounds.y)
        const region: WindowsRect = { x: originX, y: originY, width, height }
        const pixels = captureFramePixels(region, windowId)
        drawCursor(api, pixels, width, height, region)
        // The grid lets the model estimate a position from any screenshot; the crosshair
        // marks the exact point a previewed pointer action will act on.
        drawGrid(pixels, width, height)
        if (mark !== undefined && Number.isFinite(mark.x) && Number.isFinite(mark.y)) {
          drawCrosshair(pixels, width, height, mark.x - originX, mark.y - originY)
        }
        return encodeBgraPng(width, height, pixels, false)
      })
    },
    targetBlocksInput(hwnd) {
      const target = windowPointer(hwnd)
      if (target === undefined) return false
      const rid = integrityRid(api, pidOf(api, target))
      // Fail closed: an elevated window commonly refuses the token read, and the caller
      // must not post input that UIPI would only drop silently.
      if (rid === undefined) return true
      // Our own level is unreadable, which should not happen for our own token. Assume the
      // unelevated default rather than allowing everything: a higher target stays blocked,
      // while an elevated own process can still type into anything at or below medium.
      if (selfRid === undefined) {
        warnUnknownSelfIntegrity()
        return rid > MEDIUM_INTEGRITY_RID
      }
      return rid > selfRid
    },
    windowFromPoint(x, y) {
      return perMonitor(() => {
        const hit = api.WindowFromPoint({ x, y })
        if (isNull(hit)) return 0
        // The hit is usually a child control; the check deals in top-level HWNDs, and a
        // child window cannot be resolved back to one.
        const root = api.GetAncestor(hit, GA_ROOT)
        return hwndId(isNull(root) ? hit : root) ?? 0
      })
    },
    movePointer(x, y) {
      perMonitor(() => { placePointer(x, y) })
    },
    mouseButton(button, down) {
      const flags = button === 'right'
        ? (down ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP)
        : (down ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP)
      perMonitor(() => { sendMouse(api, flags, 0, 0) })
    },
    scrollWheel(x, y, delta) {
      perMonitor(() => {
        placePointer(x, y)
        sendMouse(api, MOUSEEVENTF_WHEEL, 0, 0, delta)
      })
    },
    key(virtualKey, down, extended = false) {
      postKey(api, virtualKey, down, extended)
    },
    idleMillis() {
      // LASTINPUTINFO is { cbSize: uint32; dwTime: uint32 }; the tick count wraps every
      // 49.7 days, so the subtraction is done unsigned and reinterpreted.
      const buffer = Buffer.alloc(8)
      buffer.writeUInt32LE(8, 0)
      if (!api.GetLastInputInfo(buffer)) return 0
      const last = buffer.readUInt32LE(4)
      const now = api.GetTickCount() >>> 0
      return (now - (last >>> 0)) >>> 0
    },
    postClick(hwnd, x, y, button, down) {
      const target = windowPointer(hwnd)
      if (target === undefined) return false
      // PostMessage carries client coordinates, so the screen point is converted first.
      const point = { x, y }
      if (!api.ScreenToClient(target, point)) return false
      const message = button === 'right'
        ? (down ? 0x0204 : 0x0205)
        : (down ? 0x0201 : 0x0202)
      const wParam = down ? (button === 'right' ? 2 : 1) : 0
      const lParam = ((point.y & 0xffff) << 16) | (point.x & 0xffff)
      return api.PostMessageW(target, message, wParam, lParam) !== 0
    },
    saveClipboard() {
      const seen: { format: number; size: number }[] = []
      const bytes = new Map<number, Buffer>()
      withClipboard(api, () => {
        let format = 0
        for (;;) {
          format = api.EnumClipboardFormats(format)
          if (format === 0) break
          // A GDI handle here is not a heap block: GlobalSize on it is undefined behaviour.
          if (GDI_CLIPBOARD_FORMATS.has(format)) continue
          const handle = api.GetClipboardData(format)
          if (isNull(handle)) continue
          const size = Number(api.GlobalSize(handle))
          if (!Number.isFinite(size) || size <= 0) continue
          seen.push({ format, size })
        }
        // Plain text first: it is the entry that matters when the budget cannot cover
        // everything, and it is what the paste is about to overwrite.
        seen.sort((left, right) => Number(right.format === CF_UNICODETEXT) - Number(left.format === CF_UNICODETEXT)
          || left.size - right.size)
        let used = 0
        for (const entry of seen) {
          if (used + entry.size > CLIPBOARD_SNAPSHOT_LIMIT_BYTES) continue
          const handle = api.GetClipboardData(entry.format)
          if (isNull(handle)) continue
          // GDI and owner-display formats are handles, not global memory; GlobalLock fails
          // on them and the format is skipped rather than copied as garbage.
          const locked = api.GlobalLock(handle)
          if (isNull(locked)) continue
          try {
            const copy = Buffer.alloc(entry.size)
            api.RtlMoveMemory(copy, locked, entry.size)
            bytes.set(entry.format, copy)
            used += entry.size
          } finally {
            api.GlobalUnlock(handle)
          }
        }
      })
      // A delayed-rendered format still costs one synchronous GetClipboardData above: the
      // budget bounds the memory, not the owner's render time.
      const entries = seen.flatMap((entry) => {
        const copy = bytes.get(entry.format)
        return copy === undefined ? [] : [{ format: entry.format, bytes: copy }]
      })
      // Whatever the clipboard held and this snapshot did not take is lost the moment a paste
      // empties it, so it travels with the snapshot and the restore reports it.
      const copied = new Set(entries.map((entry) => entry.format))
      return { entries, dropped: seen.filter((entry) => !copied.has(entry.format)).map((entry) => entry.format) }
    },
    restoreClipboard(snapshot) {
      let restored = 0
      withClipboard(api, () => {
        api.EmptyClipboard()
        for (const entry of snapshot.entries) {
          const memory = api.GlobalAlloc(GMEM_MOVEABLE, entry.bytes.length)
          if (isNull(memory)) continue
          const locked = api.GlobalLock(memory)
          if (isNull(locked)) {
            // The system was never handed this block, so it must be freed here.
            api.GlobalFree(memory)
            continue
          }
          api.RtlMoveMemory(locked, entry.bytes, entry.bytes.length)
          api.GlobalUnlock(memory)
          if (isNull(api.SetClipboardData(entry.format, memory))) {
            // Refused, so ownership never moved: free it rather than leak the block.
            api.GlobalFree(memory)
            continue
          }
          restored += 1
        }
      })
      if (clipboardRestoreIncomplete(snapshot, restored)) {
        // The clipboard was emptied and something did not go back; say so instead of losing it
        // silently. This covers the empty snapshot too: a format over budget never got copied,
        // and without the warning the user's screenshot would just disappear.
        console.error('computer-use: the clipboard could not be fully restored after the paste')
      }
    },
    setClipboardText(text) {
      const bytes = Buffer.from(`${text}\0`, 'utf16le')
      const memory = api.GlobalAlloc(GMEM_MOVEABLE, bytes.length)
      if (isNull(memory)) throw new Error('computer-use: clipboard allocation failed')
      const locked = api.GlobalLock(memory)
      if (isNull(locked)) throw new Error('computer-use: clipboard allocation failed')
      api.RtlMoveMemory(locked, bytes, bytes.length)
      api.GlobalUnlock(memory)
      withClipboard(api, () => {
        api.EmptyClipboard()
        if (isNull(api.SetClipboardData(CF_UNICODETEXT, memory))) {
          throw new Error('computer-use: SetClipboardData failed')
        }
      })
    },
    copyImageFile(path) {
      const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$image = [System.Drawing.Image]::FromFile(${JSON.stringify(path)})
try { [System.Windows.Forms.Clipboard]::SetImage($image) } finally { $image.Dispose() }
`
      execFileSync('powershell.exe', ['-NoProfile', '-STA', '-Command', script], {
        windowsHide: true,
        timeout: 5000,
      })
    },
    listWindowApps() {
      const names = new Set<string>()
      for (const hwnd of enumTopLevel(api)) {
        if (api.IsWindowVisible(hwnd) === 0) continue
        const name = processBaseName(api, pidOf(api, hwnd))
        if (name !== undefined && name !== '') names.add(name)
      }
      return [...names]
    },
    activateApp(name) {
      return perMonitor(() => {
        const windows = enumTopLevel(api).filter((hwnd) => api.IsWindowVisible(hwnd) !== 0)
        const index = selectAppWindow(windows.map((hwnd) => ({
          appName: processBaseName(api, pidOf(api, hwnd)) ?? '',
          title: windowText(api, hwnd),
        })), name)
        const target = index === undefined ? undefined : windows[index]
        if (target === undefined) return false
        if (!becomeForeground(target)) throw new Error(`computer-use: failed to activate ${name}`)
        return true
      })
    },
    foregroundWindowId() {
      return hwndId(api.GetForegroundWindow()) ?? 0
    },
    focusWindow(hwnd) {
      return perMonitor(() => {
        const target = windowPointer(hwnd)
        if (target === undefined) return false
        return becomeForeground(target)
      })
    },
    windowAppName(hwnd) {
      const target = windowPointer(hwnd)
      if (target === undefined) return undefined
      // The same derivation `listWindows` records in its `appName`: a UWP frame answers with the
      // app inside it, not with `ApplicationFrameHost`. Answering differently here fails every
      // name check against a window this session just observed.
      return perMonitor(() => {
        const pid = pidOf(api, target)
        return processBaseName(api, appOwnerPid(classNameOf(api, target), pid, () => coreWindowPid(api, target)))
      })
    },
    launch(target, parameters) {
      const result = Number(api.ShellExecuteW(null, 'open', target, parameters ?? null, null, SW_SHOWNORMAL))
      if (!Number.isFinite(result) || result <= 32) {
        throw new Error(`computer-use: failed to open ${target}`)
      }
    },
    explorerFolder,
  }
}
