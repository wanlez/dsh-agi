import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import { createFakeDesktopBackend } from '../src/fake.ts'
import { observeDesktop } from '../src/observe.ts'
import type { DisplayInventory } from '../src/display-inventory.ts'

const SIGNAL = new AbortController().signal

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
    logicalRect: { x: 0, y: 0, width: 1536, height: 864 },
    dpiX: 120,
    dpiY: 120,
    scale: 1.25,
    rotation: 0,
  }],
}

let home: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (home !== undefined) await rm(home, { recursive: true, force: true })
  home = undefined
})

async function makeContext(): Promise<Context> {
  home = await mkdtemp(join(tmpdir(), 'dsh-cu-status-'))
  const ctx = new Context()
  context = ctx
  await ctx.plugin(LocalAttachmentStore, { dshHome: home })
  return ctx
}

describe('observation three-state status', () => {
  it('marks an empty capture as empty and includes the display inventory envelope', async () => {
    const ctx = await makeContext()
    const fake = createFakeDesktopBackend({
      screens: [],
      foreground: { appName: 'none' },
    })
    const observation = await observeDesktop(ctx, {
      ...fake,
      displayInventory: async () => inventory,
    }, SIGNAL)
    expect(observation.status).toMatchObject({
      foreground: 'empty',
      capture: 'empty',
      displayInventory: 'provided',
    })
    const text = observation.blocks.filter(block => block.type === 'text').map(block => block.text).join('\n')
    expect(text).toContain('capture=empty;display_inventory=provided')
    expect(text).toContain('<display_inventory awareness="per-monitor-v2"')
    expect(text).toContain('scale="1.25"')
  })

  it('marks a missing inventory as unsampled instead of zero displays', async () => {
    const ctx = await makeContext()
    const observation = await observeDesktop(ctx, createFakeDesktopBackend({
      screens: [],
      foreground: { appName: 'none' },
    }), SIGNAL)
    expect(observation.status.displayInventory).toBe('unsampled')
    const text = observation.blocks.filter(block => block.type === 'text').map(block => block.text).join('\n')
    expect(text).toContain('display_inventory=unsampled')
    expect(text).not.toContain('<display_inventory')
  })

  it('marks foreground as unsampled when inspectForeground throws', async () => {
    const ctx = await makeContext()
    const observation = await observeDesktop(ctx, {
      ...createFakeDesktopBackend(),
      inspectForeground: async () => { throw new Error('access denied') },
    }, SIGNAL)
    expect(observation.status.foreground).toBe('unsampled')
    expect(observation.status.windowTitle).toBe('unsampled')
    const text = observation.blocks.filter(block => block.type === 'text').map(block => block.text).join('\n')
    expect(text).toContain('foreground=unsampled;window_title=unsampled;capture=provided')
  })
})
