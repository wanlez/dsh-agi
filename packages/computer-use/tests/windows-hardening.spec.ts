import { describe, expect, it } from 'vitest'
import type { ModalState } from '../src/action-receipt.ts'
import type { DisplayInventory } from '../src/display-inventory.ts'
import { runWithCaptureExcludeWindowIds } from '../src/capture-exclude.ts'
import {
  createWindowsDesktopBackend,
  type WindowsDesktopOps,
} from '../src/windows.ts'
import type { WindowsDesktopSnapshot, WindowsWindowFact } from '../src/windows-foreground.ts'

const bounds = { x: 10, y: 20, width: 100, height: 80 }

const inventory: DisplayInventory = {
  sampledAt: '2026-11-14T00:00:00.000Z',
  dpiAwareness: 'per-monitor-v2',
  virtualDesktop: { x: 0, y: 0, width: 1920, height: 1080 },
  displays: [{
    index: 0,
    name: '\\\\.\\DISPLAY1',
    handle: '0x1',
    primary: true,
    physicalRect: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    logicalRect: { x: 0, y: 0, width: 1920, height: 1080 },
    dpiX: 96,
    dpiY: 96,
    scale: 1,
    rotation: 0,
  }],
}

function fact(overrides: Partial<WindowsWindowFact> = {}): WindowsWindowFact {
  return {
    hwnd: 5,
    pid: 10,
    ownerHwnd: 0,
    className: 'Notepad',
    appName: 'notepad',
    title: 'notes.txt',
    visible: true,
    iconic: false,
    cloaked: false,
    toolWindow: false,
    popup: false,
    frame: bounds,
    monitor: { x: 0, y: 0, width: 1920, height: 1080 },
    monitorDpi: 96,
    ...overrides,
  }
}

function snapshot(): WindowsDesktopSnapshot {
  return { foregroundHwnd: 5, windows: [fact()] }
}

const modal: ModalState = {
  present: true,
  windowId: 9,
  title: 'Sign in',
  className: '#32770',
  parentWindowId: 5,
  reason: 'owned-dialog',
  suggestedActions: ['press-esc', 'focus-modal', 'ask-user'],
}

function ops(overrides: Partial<WindowsDesktopOps> = {}): WindowsDesktopOps & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    listWindows: snapshot,
    displayInventory: () => inventory,
    detectModal: () => modal,
    capturePng: () => Uint8Array.from([1]),
    targetBlocksInput: () => false,
    windowFromPoint: () => 5,
    movePointer: (x, y) => { calls.push(`move:${String(x)},${String(y)}`) },
    mouseButton: (_button, down) => { calls.push(down ? 'down' : 'up') },
    scrollWheel: () => undefined,
    key: () => undefined,
    saveClipboard: () => ({ entries: [], dropped: [] }),
    restoreClipboard: () => undefined,
    setClipboardText: () => undefined,
    copyImageFile: () => undefined,
    listWindowApps: () => [],
    activateApp: () => false,
    foregroundWindowId: () => 5,
    focusWindow: () => false,
    windowAppName: () => 'notepad',
    launch: () => undefined,
    explorerFolder: () => undefined,
    ...overrides,
  }
}

describe('Windows hardening integration', () => {
  it('refuses a click while a modal is present and returns the structured warning', async () => {
    const host = ops()
    const backend = createWindowsDesktopBackend(host)
    const outcome = await backend.click({
      screen: { index: 0, bounds, scale: 1, windowId: 5 },
      position: [500, 500],
      button: 'left',
      count: 1,
    })
    expect(outcome).toMatchObject({ performed: false, modal: { windowId: 9, title: 'Sign in' } })
    expect(host.calls).toContain('move:60,60')
    expect(host.calls).not.toContain('down')
    expect(host.calls).not.toContain('up')
  })

  it('still clicks when the modal probe reports nothing', async () => {
    const host = ops({ detectModal: () => undefined })
    const backend = createWindowsDesktopBackend(host)
    const outcome = await backend.click({
      screen: { index: 0, bounds, scale: 1, windowId: 5 },
      position: [0, 0],
      button: 'left',
      count: 1,
    })
    expect(outcome).toMatchObject({ performed: true })
    expect(host.calls).toContain('down')
    expect(host.calls).toContain('up')
  })

  it('maps normalized coordinates through the inventory before posting input', async () => {
    const host = ops({ detectModal: () => undefined })
    const backend = createWindowsDesktopBackend(host)
    await backend.click({
      screen: { index: 0, bounds, scale: 1, windowId: 5 },
      position: [1000, 1000],
      button: 'left',
      count: 1,
    })
    // Bounds are 10,20 + 100x80, and the physical display inventory starts at 0,0.
    expect(host.calls[0]).toBe('move:110,100')
  })

  it('keeps the capture-exclude path working with the new backend methods', async () => {
    const host = ops({ detectModal: () => undefined })
    const backend = createWindowsDesktopBackend(host)
    await runWithCaptureExcludeWindowIds([], async () => {
      await expect(backend.displayInventory?.()).resolves.toEqual(inventory)
    })
  })
})
