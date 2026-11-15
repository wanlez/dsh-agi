import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import { createFakeDesktopBackend } from '../src/fake.ts'
import { observeDesktop } from '../src/observe.ts'

const SIGNAL = new AbortController().signal

let home: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (home !== undefined) await rm(home, { recursive: true, force: true })
  home = undefined
})

async function makeContext(): Promise<Context> {
  home = await mkdtemp(join(tmpdir(), 'dsh-cu-dedup-'))
  const ctx = new Context()
  context = ctx
  await ctx.plugin(LocalAttachmentStore, { dshHome: home })
  return ctx
}

describe('observation frame deduplication', () => {
  it('reuses the previous attachment for a pixel-identical frame', async () => {
    const ctx = await makeContext()
    const backend = createFakeDesktopBackend()
    const first = await observeDesktop(ctx, backend, SIGNAL)
    const previous = first.screens[0]?.image
    expect(previous).toBeDefined()
    expect(first.blocks.some(block => block.type === 'image')).toBe(true)

    const second = await observeDesktop(ctx, backend, SIGNAL, {
      reuseImage: () => previous,
    })
    expect(second.screens[0]?.deduplicated).toBe(true)
    expect(second.screens[0]?.image.attachmentId).toBe(previous?.attachmentId)
    expect(second.blocks.some(block => block.type === 'image')).toBe(false)
    const text = second.blocks.filter(block => block.type === 'text').map(block => block.text).join('\n')
    expect(text).toContain('<frame_note>')
    expect(text).toContain('pixel-identical')
  })

  it('stores a fresh capture when the caller declines to reuse', async () => {
    const ctx = await makeContext()
    const observation = await observeDesktop(ctx, createFakeDesktopBackend(), SIGNAL, {
      reuseImage: () => undefined,
    })
    expect(observation.screens[0]?.deduplicated).toBeUndefined()
    expect(observation.blocks.some(block => block.type === 'image')).toBe(true)
    const text = observation.blocks.filter(block => block.type === 'text').map(block => block.text).join('\n')
    expect(text).not.toContain('<frame_note>')
  })
})
