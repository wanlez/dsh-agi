/**
 * The experience library: one folder of Markdown workflows the ball's agent reads and
 * writes. The folder lives in the harness home by default, can be pointed anywhere the
 * user keeps their notes, and carries an `OFF` marker when the library is switched off.
 *
 * The plugin records the chosen folder in the profile (`agi-knowledge.json`) and mirrors it
 * into `dsh-agi/ACTIVE_KNOWLEDGE`, a fixed pointer the agent's standing instructions can
 * name — moving the library therefore never strands a link that was written into a card.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { cp, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** Marker file that switches the library off without deleting anything. */
const KNOWLEDGE_OFF_NAME = 'OFF'

/** Profile file that remembers a folder the user picked. */
const KNOWLEDGE_CONFIG = 'agi-knowledge.json'

/** Fixed pointer outside the profile, readable by the agent whatever folder is current. */
const KNOWLEDGE_POINTER = 'ACTIVE_KNOWLEDGE'

/** One entry the settings page lists. */
export interface KnowledgeEntry {
  readonly name: string
  /** Present (and true) for a folder: one folder per workflow. */
  readonly dir?: true
  readonly bytes: number
  /** Modification time in Unix milliseconds. */
  readonly mtime: number
}

/** What the settings page renders. */
export interface KnowledgeState {
  readonly dir: string
  /** The shipped folder, shown next to a custom one. */
  readonly defaultDir: string
  readonly enabled: boolean
  readonly files: readonly KnowledgeEntry[]
  readonly isDefault: boolean
}

/** What a folder change moved. */
export interface KnowledgeMigration {
  readonly moved: number
  /** Entry names that could neither be renamed nor copied. */
  readonly failed: readonly string[]
  readonly from: string
  readonly dir: string
}

/**
 * A route-level rejection: the HTTP layer answers with {@link status} instead of 500.
 * Mirrors the status field `readJson` puts on its own errors.
 */
export class KnowledgeRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

/** The shipped folder. */
function defaultKnowledgeDir(): string {
  return dshHomePath('dsh-agi', 'knowledge')
}

/**
 * The folder in use: the profile's choice when it is an absolute path, the shipped one
 * otherwise. A broken config falls back rather than failing the settings page.
 * @param baseDir - profile directory that holds `agi-knowledge.json`.
 */
export function knowledgeDirFor(baseDir: string): string {
  try {
    const config = JSON.parse(readFileSync(join(baseDir, KNOWLEDGE_CONFIG), 'utf8')) as { dir?: unknown } | null
    if (typeof config?.dir === 'string' && isAbsolute(config.dir)) return config.dir
  } catch {
    // No choice recorded yet.
  }
  return defaultKnowledgeDir()
}

/** Keep the fixed pointer in step with the folder in use. */
function writeKnowledgePointer(dir: string): void {
  try {
    const home = dshHomePath('dsh-agi')
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, KNOWLEDGE_POINTER), `${dir}\n`, 'utf8')
  } catch {
    // The agent's instructions still name the folder; only the pointer is missing.
  }
}

/** Whether the library is on: the `OFF` marker is the switch. */
function knowledgeEnabledIn(dir: string): boolean {
  return !existsSync(join(dir, KNOWLEDGE_OFF_NAME))
}

/**
 * List the library: folders plus the Markdown files beside them.
 * @param baseDir - profile directory that holds the folder choice.
 */
export async function knowledgeState(baseDir: string): Promise<KnowledgeState> {
  const dir = knowledgeDirFor(baseDir)
  try {
    await mkdir(dir, { recursive: true })
  } catch {
    // An unreadable folder is reported as empty.
  }
  const files: KnowledgeEntry[] = []
  try {
    for (const name of await readdir(dir)) {
      let info
      try {
        info = await stat(join(dir, name))
      } catch {
        continue
      }
      if (info.isDirectory()) {
        files.push({ name, dir: true, bytes: 0, mtime: info.mtimeMs })
        continue
      }
      if (!name.toLowerCase().endsWith('.md')) continue
      files.push({ name, bytes: info.size, mtime: info.mtimeMs })
    }
  } catch {
    // Listing failed: the page shows an empty library.
  }
  files.sort((left, right) => left.name.localeCompare(right.name))
  writeKnowledgePointer(dir)
  return {
    dir,
    defaultDir: defaultKnowledgeDir(),
    enabled: knowledgeEnabledIn(dir),
    files,
    isDefault: dir === defaultKnowledgeDir(),
  }
}

/**
 * Switch the library on or off. Off writes the marker and leaves every file alone.
 * @param baseDir - profile directory that holds the folder choice.
 * @param on - true removes the marker.
 */
export async function setKnowledgeEnabled(baseDir: string, on: boolean): Promise<void> {
  const dir = knowledgeDirFor(baseDir)
  try {
    await mkdir(dir, { recursive: true })
  } catch {
    // Writing the marker below reports the real failure.
  }
  if (on) await rm(join(dir, KNOWLEDGE_OFF_NAME), { force: true })
  else await writeFile(join(dir, KNOWLEDGE_OFF_NAME), 'off\n')
}

/**
 * Point the library at another folder and move what is already there into it. A name that
 * already exists at the target keeps both sides: the moved entry gets ` (1)`, ` (2)`, …
 * The config is written only after the copy pass, so a failed move never loses the source.
 * @param baseDir - profile directory that holds the folder choice.
 * @param next - absolute folder the user picked.
 * @throws KnowledgeRequestError with 400 for a relative path or a folder nested in the current one.
 */
export async function setKnowledgeDir(baseDir: string, next: unknown): Promise<KnowledgeMigration> {
  if (typeof next !== 'string' || next.trim() === '' || !isAbsolute(next)) {
    throw new KnowledgeRequestError('knowledge-invalid-path', 400)
  }
  const from = knowledgeDirFor(baseDir)
  const to = resolve(next)
  if (to === from) return { moved: 0, failed: [], from, dir: to }
  // Moving a folder into itself (or into its own child) would make every entry collide.
  const normalise = (value: string): string => String(value).split('\\').join('/').replace(/\/+$/, '')
  if (normalise(to).startsWith(`${normalise(from)}/`) || normalise(from).startsWith(`${normalise(to)}/`)) {
    throw new KnowledgeRequestError('knowledge-nested-path', 400)
  }
  await mkdir(to, { recursive: true })
  let moved = 0
  const failed: string[] = []
  let names: string[] = []
  try {
    names = await readdir(from)
  } catch {
    // An empty or missing source leaves nothing to move.
  }
  for (const name of names) {
    const source = join(from, name)
    const dot = name.lastIndexOf('.')
    const stem = dot > 0 ? name.slice(0, dot) : name
    const extension = dot > 0 ? name.slice(dot) : ''
    let candidate = name
    for (let index = 1; existsSync(join(to, candidate)) && index < 100; index += 1) {
      candidate = `${stem} (${index})${extension}`
    }
    const target = join(to, candidate)
    try {
      await rename(source, target)
      moved += 1
    } catch {
      // A cross-device move cannot rename; copy and drop the source instead.
      try {
        await cp(source, target, { recursive: true, force: false })
        await rm(source, { recursive: true, force: true })
        moved += 1
      } catch {
        failed.push(name)
      }
    }
  }
  writeFileSync(join(baseDir, KNOWLEDGE_CONFIG), `${JSON.stringify({ dir: to }, null, 2)}\n`, 'utf8')
  writeKnowledgePointer(to)
  return { moved, failed, from, dir: to }
}

/** Open the library in the system file manager. */
export function openKnowledgeFolder(baseDir: string): void {
  try {
    const opener = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
    spawn(opener, [knowledgeDirFor(baseDir)], { detached: true, stdio: 'ignore' }).unref()
  } catch {
    // A missing file manager only costs the button.
  }
}
