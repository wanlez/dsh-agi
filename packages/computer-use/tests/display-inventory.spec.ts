import { describe, expect, it } from 'vitest'
import {
  displayForPoint,
  displayForWindow,
  formatDisplayInventoryEnvelope,
  logicalToPhysical,
  mapWindowPointToPhysical,
  type DisplayInventory,
} from '../src/display-inventory.ts'

const inventory: DisplayInventory = {
  sampledAt: '2026-11-14T00:00:00.000Z',
  dpiAwareness: 'per-monitor-v2',
  virtualDesktop: { x: -3000, y: 0, width: 4920, height: 1500 },
  displays: [
    {
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
    },
    {
      index: 1,
      name: '\\\\.\\DISPLAY2',
      handle: '0x2',
      primary: false,
      physicalRect: { x: -3000, y: 0, width: 3000, height: 1500 },
      workArea: { x: -3000, y: 0, width: 3000, height: 1460 },
      logicalRect: { x: -2000, y: 0, width: 2000, height: 1000 },
      dpiX: 144,
      dpiY: 144,
      scale: 1.5,
      rotation: 0,
    },
  ],
}

describe('display inventory', () => {
  it('reports physical and logical rectangles for each display', () => {
    expect(inventory.displays).toHaveLength(2)
    expect(inventory.displays[1]?.logicalRect).toEqual({ x: -2000, y: 0, width: 2000, height: 1000 })
    expect(inventory.displays[1]?.scale).toBe(1.5)
  })

  it('picks the monitor containing a point in either coordinate space', () => {
    expect(displayForPoint(inventory, -1000, 500, 'logical')?.index).toBe(1)
    expect(displayForPoint(inventory, -1000, 500, 'physical')?.index).toBe(1)
    expect(displayForPoint(inventory, 100, 100, 'physical')?.index).toBe(0)
  })

  it('picks the monitor with the largest window overlap', () => {
    expect(displayForWindow(inventory, { x: -2200, y: 0, width: 800, height: 600 }, 'logical')?.index).toBe(1)
    expect(displayForWindow(inventory, { x: 100, y: 100, width: 800, height: 600 }, 'physical')?.index).toBe(0)
  })

  it('maps logical points through the monitor scale', () => {
    expect(logicalToPhysical(inventory.displays[1]!, -1000, 500)).toEqual({ x: -1500, y: 750 })
  })

  it('maps a normalized window point through window, display, then physical pixels', () => {
    const mapped = mapWindowPointToPhysical(
      [500, 500],
      { x: -2000, y: 0, width: 2000, height: 1000 },
      inventory,
      'logical',
    )
    expect(mapped.display.index).toBe(1)
    expect(mapped.x).toBe(-1500)
    expect(mapped.y).toBe(750)
    expect(mapped.insideDisplay).toBe(true)
    expect(mapped.windowSpansDisplays).toBe(false)
  })

  it('does not scale an already physical window rectangle', () => {
    const mapped = mapWindowPointToPhysical(
      [500, 500],
      { x: 0, y: 0, width: 1000, height: 800 },
      inventory,
      'physical',
    )
    expect(mapped).toMatchObject({ x: 500, y: 400, insideDisplay: true })
  })

  it('prints a compact, sanitized envelope with all displays', () => {
    const text = formatDisplayInventoryEnvelope(inventory)
    expect(text).toContain('<display_inventory awareness="per-monitor-v2"')
    expect(text).toContain('count="2"')
    expect(text).toContain('name="\\\\.\\DISPLAY1"')
    expect(text).toContain('primary="true"')
    expect(text).toContain('physical="-3000,0 3000x1500"')
    expect(text).toContain('scale="1.50"')
  })

  it('rejects an empty inventory and degenerate windows', () => {
    expect(() => mapWindowPointToPhysical([0, 0], { x: 0, y: 0, width: 10, height: 10 }, {
      ...inventory,
      displays: [],
    })).toThrow(/inventory is empty/u)
    expect(() => mapWindowPointToPhysical([0, 0], { x: 0, y: 0, width: 0, height: 10 }, inventory))
      .toThrow(/empty rectangle/u)
  })
})
