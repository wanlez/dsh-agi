/**
 * Write captured desktop rasters to a directory with unique filenames.
 * @module @deepseek-ai/dsh-experimental-tool-computer-use/src/screenshot
 */

import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'

/** One captured window raster to persist as a user-visible file. */
export interface DesktopScreenshotFile {
  readonly data: Uint8Array
  readonly mediaType: ImageMediaType
  readonly screenIndex: number
}

/** File extension per encoded image type. */
export const EXTENSION: Record<ImageMediaType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * macOS-style Screenshot stamp used as the saved filename stem.
 * @param now - local time used in the stamp.
 * @param screenIndex - observation surface index (0 for the attached window).
 * @param screenCount - how many surfaces this capture wrote.
 * @returns filename stem without extension.
 */
export function screenshotFileStem(
  now: Date,
  screenIndex: number,
  screenCount: number,
): string {
  const stamp = `${String(now.getFullYear())}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`
    + ` at ${pad2(now.getHours())}.${pad2(now.getMinutes())}.${pad2(now.getSeconds())}`
  if (screenCount === 1) return `Screenshot ${stamp}`
  return `Screenshot ${stamp} (screen ${String(screenIndex)})`
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.access(path)
    return true
  } catch {
    // Missing and unreadable paths both look absent here; writeFile reports the real error.
    return false
  }
}

async function uniquePath(directory: string, stem: string, extension: string): Promise<string> {
  let candidate = join(directory, `${stem}.${extension}`)
  for (let suffix = 2; suffix <= 101; suffix += 1) {
    if (!await pathExists(candidate)) return candidate
    if (suffix > 100) break
    candidate = join(directory, `${stem} ${String(suffix)}.${extension}`)
  }
  throw new Error('computer-use: could not allocate a unique screenshot filename')
}

/**
 * Pair capture rasters with observation screen indexes.
 * @param captures - rasters in screen order.
 * @param screens - observation envelopes in the same order.
 * @returns files ready for {@link writeScreenshots}.
 */
export function pairScreenshotFiles(
  captures: readonly Pick<DesktopScreenshotFile, 'data' | 'mediaType'>[],
  screens: readonly { readonly screenIndex: number }[],
): DesktopScreenshotFile[] {
  if (captures.length !== screens.length) {
    throw new Error('computer-use: screenshot captures and screens disagree')
  }
  const files: DesktopScreenshotFile[] = []
  for (const [index, captured] of captures.entries()) {
    const screen = screens[index]
    if (screen === undefined) {
      throw new Error('computer-use: screenshot captures and screens disagree')
    }
    files.push({
      data: captured.data,
      mediaType: captured.mediaType,
      screenIndex: screen.screenIndex,
    })
  }
  return files
}

/**
 * Write each captured raster into `options.dir`, skipping images already there.
 *
 * The directory is optional: without one the caller keeps no file at all. When it is given,
 * the files already in it are hashed (up to 200) so saving the same screen twice — one
 * playbook step per screenshot — does not pile up duplicates.
 * @param files - captured rasters in screen order.
 * @param options.dir - directory that receives the files; omitted keeps none.
 * @param options.now - local timestamp used in the filename stamp; default `new Date()`.
 * @returns absolute paths of the files actually written, in screen order.
 */
export async function writeScreenshots(
  files: readonly DesktopScreenshotFile[],
  options: { dir?: string; now?: Date },
): Promise<readonly string[]> {
  if (files.length === 0) throw new Error('computer-use: no screenshot files to write')
  const directory = options.dir
  if (directory === undefined || directory.trim() === '') return []
  await fs.mkdir(directory, { recursive: true })
  const existing = new Set<string>()
  try {
    for (const name of await fs.readdir(directory)) {
      if (existing.size >= 200) break
      try {
        existing.add(createHash('sha256').update(await fs.readFile(join(directory, name))).digest('hex'))
      } catch {
        // A subdirectory or unreadable entry just cannot match a capture; ignore it.
      }
    }
  } catch {
    // An unreadable directory is the write's problem to report, not the dedupe scan's.
  }
  const now = options.now ?? new Date()
  const paths: string[] = []
  const written = new Set<string>()
  for (const file of files) {
    const hash = createHash('sha256').update(file.data).digest('hex')
    if (existing.has(hash) || written.has(hash)) continue
    written.add(hash)
    const stem = screenshotFileStem(now, file.screenIndex, files.length)
    const path = await uniquePath(directory, stem, EXTENSION[file.mediaType])
    await fs.writeFile(path, file.data)
    paths.push(path)
  }
  return paths
}
