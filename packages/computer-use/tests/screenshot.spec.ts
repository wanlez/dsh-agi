import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FAKE_DESKTOP_PNG } from '../src/fake.ts'
import { pairScreenshotFiles, screenshotFileStem, writeScreenshots } from '../src/screenshot.ts'

const homes: string[] = []

afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true })
})

describe('screenshot files', () => {
  it('stamps a single screen without an index suffix', () => {
    expect(screenshotFileStem(new Date(2026, 8, 15, 20, 10, 0), 0, 1)).toBe(
      'Screenshot 2026-09-15 at 20.10.00',
    )
  })

  it('names each display when several screens are saved', () => {
    expect(screenshotFileStem(new Date(2026, 8, 15, 20, 10, 0), 1, 2)).toBe(
      'Screenshot 2026-09-15 at 20.10.00 (screen 1)',
    )
  })

  it('writes one PNG into the save directory and skips an identical image', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-cu-shot-'))
    homes.push(dir)
    const now = new Date(2026, 8, 15, 20, 10, 0)
    const first = await writeScreenshots(
      [{ data: FAKE_DESKTOP_PNG, mediaType: 'image/png', screenIndex: 0 }],
      { dir, now },
    )
    expect(first).toEqual([join(dir, 'Screenshot 2026-09-15 at 20.10.00.png')])
    expect(await readFile(first[0]!)).toEqual(Buffer.from(FAKE_DESKTOP_PNG))
    // The same bytes are already on disk, so a second save keeps no duplicate.
    const second = await writeScreenshots(
      [{ data: FAKE_DESKTOP_PNG, mediaType: 'image/png', screenIndex: 0 }],
      { dir, now },
    )
    expect(second).toEqual([])
    // Different bytes with the same stamp still get a unique filename.
    const other = new Uint8Array([...FAKE_DESKTOP_PNG, 0])
    const third = await writeScreenshots(
      [{ data: other, mediaType: 'image/png', screenIndex: 0 }],
      { dir, now },
    )
    expect(third).toEqual([join(dir, 'Screenshot 2026-09-15 at 20.10.00 2.png')])
  })

  it('writes jpeg files for jpeg captures', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-cu-shot-jpg-'))
    homes.push(dir)
    const first = Uint8Array.of(0xff, 0xd8, 0xff, 0x01)
    const second = Uint8Array.of(0xff, 0xd8, 0xff, 0x02)
    const paths = await writeScreenshots(
      [
        { data: first, mediaType: 'image/jpeg', screenIndex: 0 },
        { data: second, mediaType: 'image/jpeg', screenIndex: 1 },
      ],
      { dir, now: new Date(2026, 8, 15, 8, 5, 9) },
    )
    expect(paths).toEqual([
      join(dir, 'Screenshot 2026-09-15 at 08.05.09 (screen 0).jpg'),
      join(dir, 'Screenshot 2026-09-15 at 08.05.09 (screen 1).jpg'),
    ])
  })

  it('keeps no file and still succeeds when no directory is given', async () => {
    const files = [{ data: FAKE_DESKTOP_PNG, mediaType: 'image/png' as const, screenIndex: 0 }]
    await expect(writeScreenshots(files, {})).resolves.toEqual([])
    await expect(writeScreenshots(files, { dir: '   ' })).resolves.toEqual([])
  })

  it('refuses an empty capture list', async () => {
    await expect(writeScreenshots([], { dir: tmpdir() })).rejects.toThrow(/no screenshot files/u)
  })

  it('pairs captures with observation screen indexes', () => {
    expect(pairScreenshotFiles(
      [{ data: FAKE_DESKTOP_PNG, mediaType: 'image/png' }],
      [{ screenIndex: 2 }],
    )).toEqual([{ data: FAKE_DESKTOP_PNG, mediaType: 'image/png', screenIndex: 2 }])
  })

  it('refuses captures and screens of different lengths', () => {
    expect(() => pairScreenshotFiles(
      [{ data: FAKE_DESKTOP_PNG, mediaType: 'image/png' }],
      [{ screenIndex: 0 }, { screenIndex: 1 }],
    )).toThrow(/disagree/u)
  })

  it('refuses a missing screen at a capture index', () => {
    const screens: Array<{ readonly screenIndex: number } | undefined> = [
      undefined,
      { screenIndex: 1 },
    ]
    expect(() => pairScreenshotFiles(
      [
        { data: FAKE_DESKTOP_PNG, mediaType: 'image/png' },
        { data: FAKE_DESKTOP_PNG, mediaType: 'image/png' },
      ],
      screens as Array<{ readonly screenIndex: number }>,
    )).toThrow(/disagree/u)
  })

  it('stamps with the current time when now is omitted', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-cu-shot-now-'))
    homes.push(dir)
    const paths = await writeScreenshots(
      [{ data: FAKE_DESKTOP_PNG, mediaType: 'image/png', screenIndex: 0 }],
      { dir },
    )
    expect(paths[0]?.startsWith(join(dir, 'Screenshot '))).toBe(true)
  })

  it('stops after 100 colliding screenshot names', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-cu-shot-unique-'))
    homes.push(dir)
    const now = new Date(2026, 8, 15, 20, 10, 0)
    // Every save needs distinct bytes, or the dedupe would skip it instead of naming it.
    for (let i = 0; i < 100; i += 1) {
      await writeScreenshots(
        [{ data: Uint8Array.of(i), mediaType: 'image/png', screenIndex: 0 }],
        { dir, now },
      )
    }
    await expect(writeScreenshots(
      [{ data: Uint8Array.of(200), mediaType: 'image/png', screenIndex: 0 }],
      { dir, now },
    )).rejects.toThrow(/unique screenshot filename/u)
  })

  it('fails when the save directory cannot be created', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-cu-shot-denied-'))
    homes.push(home)
    const blocked = join(home, 'not-a-directory')
    await writeFile(blocked, 'x')
    await expect(writeScreenshots(
      [{ data: FAKE_DESKTOP_PNG, mediaType: 'image/png', screenIndex: 0 }],
      { dir: blocked },
    )).rejects.toThrow()
  })
})
