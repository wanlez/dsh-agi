/**
 * What this plugin keeps on disk.
 *
 * The settings page shows one total and the per-file detail, so the operator can see what the
 * ball actually costs and clear the diagnostic logs that otherwise grow unnoticed. Only logs
 * are removable: models, the experience library, the workspace, attachments, and the installed
 * code are measured and reported, never touched.
 */

import { readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** One measured path. `id` is stable so the page can localize its own label. */
export interface SpaceFile {
  readonly id: string
  readonly label: string
  readonly path: string
  readonly bytes: number
  readonly files: number
  readonly cleanable?: true
}

export interface SpaceGroup {
  readonly id: string
  readonly label: string
  readonly bytes: number
  readonly files: number
  readonly items: readonly SpaceFile[]
}

export interface SpaceReport {
  readonly total: number
  readonly files: number
  readonly computedAt: number
  readonly groups: readonly SpaceGroup[]
}

export interface SpaceClean {
  readonly removed: number
  readonly bytes: number
}

/** Stops a runaway walk on a huge directory from blocking the settings page. */
const MAX_FILES = 40_000

/** Diagnostic logs this plugin writes into the OS temp directory. */
const LOG_PREFIX = 'dsh-agi-'

/** One file or one directory tree. Missing paths simply measure as zero. */
async function measure(path: string): Promise<{ bytes: number, files: number }> {
  const seen = await stat(path).catch(() => undefined)
  if (seen === undefined) return { bytes: 0, files: 0 }
  if (!seen.isDirectory()) return { bytes: seen.size, files: 1 }
  let bytes = 0
  let files = 0
  const stack = [path]
  while (stack.length > 0 && files < MAX_FILES) {
    const current = stack.pop()
    if (current === undefined) break
    const entries = await readdir(current, { withFileTypes: true }).catch(() => undefined)
    if (entries === undefined) continue
    for (const entry of entries) {
      if (files >= MAX_FILES) break
      const child = join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(child)
        continue
      }
      const info = await stat(child).catch(() => undefined)
      if (info === undefined) continue
      bytes += info.size
      files += 1
    }
  }
  return { bytes, files }
}

/** The installed package root, found by walking up for this plugin's package.json. */
export function packageRoot(): string {
  let current = dirname(fileURLToPath(import.meta.url))
  for (let step = 0; step < 6; step += 1) {
    current = dirname(current)
    if (!current.endsWith('host') && !current.endsWith('dist') && !current.endsWith('src')) return current
  }
  return current
}

/** One log file in the temp directory, newest first. */
async function logFiles(): Promise<SpaceFile[]> {
  const dir = tmpdir()
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => undefined)
  if (entries === undefined) return []
  const found: SpaceFile[] = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!entry.name.startsWith(LOG_PREFIX) || !entry.name.endsWith('.log')) continue
    const path = join(dir, entry.name)
    const info = await stat(path).catch(() => undefined)
    if (info === undefined) continue
    found.push({ id: entry.name, label: entry.name, path, bytes: info.size, files: 1, cleanable: true })
  }
  found.sort((left, right) => right.bytes - left.bytes)
  return found
}

/**
 * One target of the report: a directory tree, the plugin's own logs, or a set of paths that
 * together make up one installed artifact.
 */
interface Target {
  readonly id: string
  readonly label: string
  readonly group: string
  readonly path: string
  /** Measured together as one row; `path` is then just the row's caption. */
  readonly paths?: readonly string[]
}

function targets(): readonly (readonly [group: string, list: readonly Target[]])[] {
  const plugin = packageRoot()
  return [
    ['logs', []],
    ['state', [
      { id: 'records', label: 'Session archive', group: 'state', path: dshHomePath('dsh-agi', 'records') },
      { id: 'workspace', label: 'Ball workspace', group: 'state', path: dshHomePath('dsh-agi', 'workspace') },
      { id: 'library', label: 'Experience library', group: 'state', path: dshHomePath('dsh-agi', 'knowledge') },
      { id: 'helper-data', label: 'Helper cache', group: 'state', path: dshHomePath('dsh-agi', 'helper-data') },
      { id: 'native', label: 'Native helpers', group: 'state', path: dshHomePath('dsh-agi', 'native') },
    ]],
    ['voice', [
      { id: 'wake-model', label: 'Wake word model', group: 'voice', path: dshHomePath('dsh-agi', 'voice', 'kws') },
      { id: 'tts-model', label: 'Local TTS model', group: 'voice', path: dshHomePath('dsh-agi', 'voice', 'tts') },
      { id: 'asr-model', label: 'ASR model', group: 'voice', path: dshHomePath('speech-to-text', 'sensevoice') },
      { id: 'runtime', label: 'Helper runtime', group: 'voice', path: dshHomePath('dsh-agi', 'electron-runtime') },
    ]],
    // The official attachment store is shared with every other conversation in Harness, so it
    // is not this plugin's footprint and is not reported here.
    ['shared', [
      {
        id: 'code',
        label: 'Installed code',
        group: 'shared',
        path: plugin,
        paths: [join(plugin, 'dist'), join(plugin, 'lib'), join(plugin, 'client.js')],
      },
      // Only a development checkout carries its dependencies next to the bundle.
      { id: 'deps', label: 'Development dependencies', group: 'shared', path: join(plugin, 'node_modules') },
    ]],
  ]
}

async function measureTargets(list: readonly Target[]): Promise<SpaceFile[]> {
  const measured = await Promise.all(list.map(async (target) => {
    let bytes = 0
    let files = 0
    for (const path of target.paths ?? [target.path]) {
      const size = await measure(path)
      bytes += size.bytes
      files += size.files
    }
    return { id: target.id, label: target.label, path: target.path, bytes, files }
  }))
  // A path that does not exist on this machine is not a row: nothing to report, nothing to see.
  return measured.filter((item) => item.files > 0)
}

/** Measure everything the ball keeps, grouped for one settings card. */
export async function collectSpace(): Promise<SpaceReport> {
  const [logs, ...groups] = targets()
  const files = await logFiles()
  const logBytes = files.reduce((sum, file) => sum + file.bytes, 0)
  const built: SpaceGroup[] = [{
    id: 'logs',
    label: 'Logs',
    bytes: logBytes,
    files: files.length,
    items: files,
  }]
  for (const [id, list] of groups) {
    const items = await measureTargets(list)
    built.push({
      id,
      label: id,
      bytes: items.reduce((sum, item) => sum + item.bytes, 0),
      files: items.reduce((sum, item) => sum + item.files, 0),
      items,
    })
  }
  return {
    total: built.reduce((sum, group) => sum + group.bytes, 0),
    files: built.reduce((sum, group) => sum + group.files, 0),
    computedAt: Date.now(),
    groups: built,
  }
}

/** Delete the diagnostic logs only. Nothing else is ever removed from here. */
export async function cleanSpaceLogs(): Promise<SpaceClean> {
  const files = await logFiles()
  let removed = 0
  let bytes = 0
  for (const file of files) {
    try {
      await rm(file.path, { force: true })
      removed += 1
      bytes += file.bytes
    } catch {
      // A log another process still holds open stays until the next attempt.
    }
  }
  return { removed, bytes }
}
