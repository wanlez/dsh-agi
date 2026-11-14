/**
 * Where the experience graph lives, and how it moves.
 *
 * The library is a plain folder; the profile only remembers where it is
 * (`agi-knowledge-graph.json`). Moving it must never leave two half-libraries behind,
 * so the order is fixed:
 *
 *   copy into a staging folder → verify (files, counts, index/manifest parse)
 *   → switch the pointer → delete the old folder.
 *
 * Any failure before the pointer switch rolls the target back and leaves the source
 * untouched. A failure while deleting the old folder is not data loss: the pointer is
 * already switched and both copies are complete, so it is reported as `leftover`.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { GraphError } from './model.ts'
import {
  countsOf,
  GRAPH_CONFIG,
  GRAPH_FOLDER,
  GRAPH_FORMAT,
  KnowledgeGraphStore,
  knowledgeGraphDirFor,
  type GraphManifest,
} from './store.ts'

/** Pointer the standing prompt reads whatever profile is active. */
export const GRAPH_POINTER = 'ACTIVE_GRAPH'

/**
 * Legacy pointer written by the markdown experience library. The graph is the execution
 * entry now, so this file names the graph as well; the markdown archive gets
 * `ACTIVE_KNOWLEDGE_ARCHIVE` instead.
 */
export const LEGACY_KNOWLEDGE_POINTER = 'ACTIVE_KNOWLEDGE'

/** Archive pointer kept for the old markdown library. */
export const KNOWLEDGE_ARCHIVE_POINTER = 'ACTIVE_KNOWLEDGE_ARCHIVE'

/** Append-only migration log kept inside the library that received the copy. */
export const GRAPH_MIGRATION_LOG = 'migration_log.jsonl'

/** Same log name outside the profile, so a failed migration is still discoverable. */
const GRAPH_MIGRATION_HOME_LOG = 'knowledge-graph-migration.log'

/** Counts shared by the manifest and the migration report. */
export interface GraphCounts {
  readonly nodes: number
  readonly edges: number
  readonly paths: number
  readonly decisions: number
}

/** One migration or import line. */
export interface GraphMigrationLogEntry {
  readonly ts: string
  readonly event:
    | 'start'
    | 'copied'
    | 'switched'
    | 'deleted-old'
    | 'leftover'
    | 'done'
    | 'failed'
    | 'rollback'
    | 'import'
  readonly from: string
  readonly to: string
  readonly mode?: 'move' | 'merge'
  readonly detail?: string
  readonly counts?: GraphCounts
}

/** What the settings page reads. */
export interface GraphLibraryState {
  readonly dir: string
  readonly defaultDir: string
  readonly isDefault: boolean
  readonly counts: GraphCounts & { readonly screenshots: number }
  readonly lastMigration: GraphMigrationLogEntry | null
}

/** Hooks the tests use to fail a migration at a chosen step. */
export interface GraphMigrationHooks {
  /** Runs right after the staged copy verified, before the pointer switch. */
  readonly afterCopy?: () => Promise<void> | void
  /** Runs after the pointer switch, before the old folder is removed. */
  readonly beforeDelete?: () => Promise<void> | void
}

/** Optional collaborators. */
export interface GraphMigrationOptions {
  /** Recorded in the log. */
  readonly operator?: string
  /** Called after the pointer switch so ACTIVE_GRAPH follows the new folder. */
  readonly publish?: (dir: string) => void
  /** Mirror the log into the harness home. Tests turn it off. */
  readonly homeLog?: boolean
  readonly hooks?: GraphMigrationHooks
}

/** What a successful migration did. */
export interface GraphMigrationResult {
  readonly from: string
  readonly to: string
  readonly mode: 'move' | 'merge'
  readonly counts: GraphCounts & { readonly screenshots: number }
  readonly copied: {
    readonly nodes: number
    readonly paths: number
    readonly screenshots: number
    readonly edges: number
  }
  readonly deletedOld: boolean
  /** True when the old folder could not be removed; both copies are complete. */
  readonly leftover: boolean
  readonly log: string
  readonly durationMs: number
}

/** One file-level verification report. */
export interface GraphVerification {
  readonly ok: boolean
  readonly problems: readonly string[]
  readonly counts: GraphCounts & { readonly screenshots: number }
}

/** Publish the absolute library path for the standing prompt. Best effort. */
export function publishGraphPointer(dir: string): void {
  try {
    const home = dshHomePath('dsh-agi')
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, GRAPH_POINTER), `${dir}\n`, 'utf8')
    writeFileSync(join(home, LEGACY_KNOWLEDGE_POINTER), `${dir}\n`, 'utf8')
  } catch {
    // The editor still works; only the prompt's discovery hint is missing.
  }
}

/** Absolute pointer files, for diagnostics and tests. */
export function graphPointerPaths(): { graph: string; knowledge: string; archive: string } {
  const home = dshHomePath('dsh-agi')
  return {
    graph: join(home, GRAPH_POINTER),
    knowledge: join(home, LEGACY_KNOWLEDGE_POINTER),
    archive: join(home, KNOWLEDGE_ARCHIVE_POINTER),
  }
}

/** The shipped folder inside the profile. */
export function defaultGraphDir(baseDir: string): string {
  return resolve(join(baseDir, 'dsh-agi', GRAPH_FOLDER))
}

/** Case-insensitive comparison and containment, as Windows needs. */
function normalise(value: string): string {
  const absolute = resolve(value)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

function samePath(left: string, right: string): boolean {
  return normalise(left) === normalise(right)
}

function isInside(child: string, parent: string): boolean {
  const inner = normalise(child)
  const outer = normalise(parent)
  if (inner === outer) return true
  return inner.startsWith(outer.endsWith(sep) ? outer : `${outer}${sep}`)
}

async function readJson(file: string): Promise<{ ok: boolean; value?: unknown; error?: string }> {
  try {
    return { ok: true, value: JSON.parse(await readFile(file, 'utf8')) as unknown }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function listFiles(folder: string): Promise<string[]> {
  try {
    return (await readdir(folder)).sort()
  } catch {
    return []
  }
}

/** Screenshot files under `screenshots/<node>/`, counted for the verification report. */
async function countScreenshots(dir: string): Promise<number> {
  let total = 0
  for (const node of await listFiles(join(dir, 'screenshots'))) {
    total += (await listFiles(join(dir, 'screenshots', node))).length
  }
  return total
}

/**
 * Read one library and prove it is complete: the manifest and index parse, every node and
 * path file parses, the edge log parses, and the counts match what the graph reports.
 * @param dir - absolute library folder.
 * @param expected - counts the copy must equal; omitted means "only prove it loads".
 */
export async function verifyGraphLibrary(dir: string, expected?: Partial<GraphCounts>): Promise<GraphVerification> {
  const problems: string[] = []
  if (!existsSync(dir)) {
    return { ok: false, problems: [`目录不存在：${dir}`], counts: { nodes: 0, edges: 0, paths: 0, decisions: 0, screenshots: 0 } }
  }
  const manifest = await readJson(join(dir, 'manifest.json'))
  if (!manifest.ok) problems.push(`manifest.json 无法解析：${manifest.error ?? ''}`)
  else {
    const value = manifest.value as Record<string, unknown> | null
    if (value === null || typeof value !== 'object' || value.format !== GRAPH_FORMAT) {
      problems.push('manifest.json 不是本插件的图谱库（format 不匹配）。')
    } else if (typeof value.version !== 'number') {
      problems.push('manifest.json 缺少 version。')
    }
  }
  const index = await readJson(join(dir, 'index.json'))
  if (!index.ok) problems.push(`index.json 无法解析：${index.error ?? ''}`)
  else {
    const value = index.value as Record<string, unknown> | null
    if (value === null || typeof value !== 'object' || !Array.isArray(value.paths)) {
      problems.push('index.json 缺少 paths 数组。')
    }
  }
  let nodeFiles = 0
  for (const name of await listFiles(join(dir, 'nodes'))) {
    if (!name.endsWith('.json')) continue
    nodeFiles += 1
    const parsed = await readJson(join(dir, 'nodes', name))
    if (!parsed.ok) problems.push(`nodes/${name} 无法解析：${parsed.error ?? ''}`)
  }
  let pathFiles = 0
  for (const name of await listFiles(join(dir, 'paths'))) {
    if (!name.endsWith('.json')) continue
    pathFiles += 1
    const parsed = await readJson(join(dir, 'paths', name))
    if (!parsed.ok) problems.push(`paths/${name} 无法解析：${parsed.error ?? ''}`)
  }
  for (const name of ['edges.jsonl', 'decision_log.jsonl']) {
    try {
      const text = await readFile(join(dir, name), 'utf8')
      for (const [line, content] of text.split(/\r?\n/u).entries()) {
        const trimmed = content.trim()
        if (trimmed === '') continue
        try {
          JSON.parse(trimmed) as unknown
        } catch {
          problems.push(`${name} 第 ${line + 1} 行不是合法 JSON。`)
          break
        }
      }
    } catch {
      problems.push(`${name} 读不到。`)
    }
  }
  const store = new KnowledgeGraphStore(dir)
  let counts: GraphCounts = { nodes: 0, edges: 0, paths: 0, decisions: 0 }
  try {
    counts = countsOf((await store.load()).snapshot)
  } catch (error) {
    problems.push(`图谱装载失败：${error instanceof Error ? error.message : String(error)}`)
  }
  const screenshots = await countScreenshots(dir)
  if (counts.nodes !== nodeFiles) problems.push(`节点文件 ${nodeFiles} 个，但图谱装载出 ${counts.nodes} 个。`)
  if (counts.paths !== pathFiles) problems.push(`路径文件 ${pathFiles} 个，但图谱装载出 ${counts.paths} 个。`)
  // A manifest whose counts disagree with the files on disk means a write was interrupted:
  // the library is readable but not the one the previous commit promised.
  if (manifest.ok) {
    const declared = (manifest.value as Record<string, unknown>).counts as Record<string, unknown> | undefined
    const labels: Record<keyof GraphCounts, string> = { nodes: '节点', edges: '边', paths: '路径', decisions: '决策' }
    for (const key of ['nodes', 'edges', 'paths', 'decisions'] as const) {
      const value = declared?.[key]
      if (typeof value === 'number' && value !== counts[key]) {
        problems.push(`manifest 记录${labels[key]} ${value} 个，实际 ${counts[key]} 个。`)
      }
    }
  }
  if (expected?.nodes !== undefined && counts.nodes !== expected.nodes) {
    problems.push(`节点数不一致：期望 ${expected.nodes}，实际 ${counts.nodes}。`)
  }
  if (expected?.edges !== undefined && counts.edges !== expected.edges) {
    problems.push(`边数不一致：期望 ${expected.edges}，实际 ${counts.edges}。`)
  }
  if (expected?.paths !== undefined && counts.paths !== expected.paths) {
    problems.push(`路径数不一致：期望 ${expected.paths}，实际 ${counts.paths}。`)
  }
  if (expected?.decisions !== undefined && counts.decisions !== expected.decisions) {
    problems.push(`决策记录数不一致：期望 ${expected.decisions}，实际 ${counts.decisions}。`)
  }
  return { ok: problems.length === 0, problems, counts: { ...counts, screenshots } }
}

/** Mirror one log line into the harness home so a crash still leaves a trace. */
async function mirrorHomeLog(entry: GraphMigrationLogEntry, options: GraphMigrationOptions): Promise<void> {
  if (options.homeLog === false) return
  try {
    const home = dshHomePath('dsh-agi')
    await mkdir(home, { recursive: true })
    await writeFile(join(home, GRAPH_MIGRATION_HOME_LOG), `${JSON.stringify(entry)}\n`, { encoding: 'utf8', flag: 'a' })
  } catch {
    // A read-only home only costs the mirror.
  }
}

/** Append the run's lines to the library that ended up owning the graph. */
async function writeLibraryLog(dir: string, entries: readonly GraphMigrationLogEntry[]): Promise<void> {
  if (entries.length === 0) return
  try {
    await writeFile(join(dir, GRAPH_MIGRATION_LOG), entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n', {
      encoding: 'utf8',
      flag: 'a',
    })
  } catch {
    // The result still carries the outcome; the local log is a convenience.
  }
}

/** The newest migration line recorded inside one library. */
export async function lastGraphMigration(dir: string): Promise<GraphMigrationLogEntry | null> {
  try {
    const text = await readFile(join(dir, GRAPH_MIGRATION_LOG), 'utf8')
    const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line !== '')
    const last = lines[lines.length - 1]
    if (last === undefined) return null
    return JSON.parse(last) as GraphMigrationLogEntry
  } catch {
    return null
  }
}

/** What the settings page shows: folder, counts, newest migration line. */
export async function graphLibraryState(baseDir: string): Promise<GraphLibraryState> {
  const dir = knowledgeGraphDirFor(baseDir)
  const fallback = defaultGraphDir(baseDir)
  const counts = { nodes: 0, edges: 0, paths: 0, decisions: 0, screenshots: 0 }
  try {
    const loaded = new KnowledgeGraphStore(dir).load()
    const snapshot = (await loaded).snapshot
    Object.assign(counts, countsOf(snapshot), { screenshots: await countScreenshots(dir) })
  } catch {
    // An unreadable library is reported as zeros; the editor shows the real error.
  }
  return {
    dir,
    defaultDir: fallback,
    isDefault: samePath(dir, fallback),
    counts,
    lastMigration: await lastGraphMigration(dir),
  }
}

/** Write the profile's folder choice atomically; Windows rename replaces the file. */
async function writeGraphConfig(baseDir: string, dir: string): Promise<void> {
  await mkdir(baseDir, { recursive: true })
  const file = join(baseDir, GRAPH_CONFIG)
  const temporary = `${file}.tmp-${process.pid}`
  await writeFile(temporary, `${JSON.stringify({ dir }, null, 2)}\n`, 'utf8')
  try {
    await rename(temporary, file)
  } catch {
    await writeFile(file, `${JSON.stringify({ dir }, null, 2)}\n`, 'utf8')
    await rm(temporary, { force: true })
  }
}

/** The current config text, for a rollback. */
function readGraphConfig(baseDir: string): { text: string } | undefined {
  try {
    return { text: readFileSync(join(baseDir, GRAPH_CONFIG), 'utf8') }
  } catch {
    return undefined
  }
}

async function removeQuietly(target: string): Promise<void> {
  try {
    await rm(target, { recursive: true, force: true })
  } catch {
    // Best effort: the caller records what remains.
  }
}

/** Whether a folder holds a graph library the merge branch can accept. */
async function isGraphLibrary(dir: string): Promise<boolean> {
  const manifest = await readJson(join(dir, 'manifest.json'))
  if (!manifest.ok) return false
  const value = manifest.value as Record<string, unknown> | null
  return value !== null && typeof value === 'object' && value.format === GRAPH_FORMAT
}

async function isEmptyFolder(dir: string): Promise<boolean> {
  return (await listFiles(dir)).length === 0
}

/** Copy one library into a fresh staging folder. */
async function stageCopy(from: string, stage: string): Promise<void> {
  await rm(stage, { recursive: true, force: true })
  await mkdir(dirname(stage), { recursive: true })
  await cp(from, stage, { recursive: true, force: true })
}

/** Files a merge added, plus the target files it overwrote, for an exact rollback. */
interface MergeJournal {
  readonly added: string[]
  readonly backups: Map<string, string | undefined>
  edges: number
}

/** Read JSON lines without losing blank lines. */
async function jsonLines(file: string): Promise<Record<string, unknown>[]> {
  try {
    const text = await readFile(file, 'utf8')
    const rows: Record<string, unknown>[] = []
    for (const line of text.split(/\r?\n/u)) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      try {
        const parsed = JSON.parse(trimmed) as unknown
        if (parsed !== null && typeof parsed === 'object') rows.push(parsed as Record<string, unknown>)
      } catch {
        // A corrupt historical line is dropped by the store too.
      }
    }
    return rows
  } catch {
    return []
  }
}

/**
 * Merge the staged copy into an existing graph library: nodes and paths that are already
 * there keep the target's version, screenshots fill the gaps, edges are unioned, and the
 * decision log is appended. The manifest and index are regenerated from the merged graph.
 */
async function mergeStaged(stage: string, to: string): Promise<MergeJournal> {
  const journal: MergeJournal = { added: [], backups: new Map(), edges: 0 }
  const backup = async (relative: string): Promise<void> => {
    if (journal.backups.has(relative)) return
    try {
      journal.backups.set(relative, await readFile(join(to, relative), 'utf8'))
    } catch {
      journal.backups.set(relative, undefined)
    }
  }
  for (const file of ['edges.jsonl', 'decision_log.jsonl', 'manifest.json', 'index.json']) await backup(file)

  for (const folder of ['nodes', 'paths']) {
    for (const name of await listFiles(join(stage, folder))) {
      if (!name.endsWith('.json')) continue
      const target = join(to, folder, name)
      if (existsSync(target)) continue
      await mkdir(dirname(target), { recursive: true })
      await cp(join(stage, folder, name), target)
      journal.added.push(join(folder, name))
    }
  }
  for (const node of await listFiles(join(stage, 'screenshots'))) {
    for (const name of await listFiles(join(stage, 'screenshots', node))) {
      const target = join(to, 'screenshots', node, name)
      if (existsSync(target)) continue
      await mkdir(dirname(target), { recursive: true })
      await cp(join(stage, 'screenshots', node, name), target)
      journal.added.push(join('screenshots', node, name))
    }
  }

  const targetEdges = await jsonLines(join(to, 'edges.jsonl'))
  const stagedEdges = await jsonLines(join(stage, 'edges.jsonl'))
  const byKey = new Map<string, Record<string, unknown>>()
  for (const edge of [...targetEdges, ...stagedEdges]) {
    if (typeof edge.from !== 'string' || typeof edge.to !== 'string') continue
    const key = `${edge.from}->${edge.to}`
    if (!byKey.has(key)) byKey.set(key, edge)
  }
  journal.edges = byKey.size
  const store = new KnowledgeGraphStore(to)
  store.saveEdges([...byKey.values()].map((edge) => ({
    from: edge.from as string,
    to: edge.to as string,
    type: 'sequence' as const,
    created_at: typeof edge.created_at === 'string' ? edge.created_at : new Date(0).toISOString(),
  })))

  const stagedDecisions = await readFile(join(stage, 'decision_log.jsonl'), 'utf8').catch(() => '')
  if (stagedDecisions.trim() !== '') {
    await writeFile(join(to, 'decision_log.jsonl'), stagedDecisions.endsWith('\n') ? stagedDecisions : `${stagedDecisions}\n`, {
      encoding: 'utf8',
      flag: 'a',
    })
  }
  const merged = await store.load()
  await store.commit(merged.snapshot, merged.settings)
  return journal
}

/** Undo a merge: drop the copied files and restore the backed-up target files. */
async function rollbackMerge(to: string, journal: MergeJournal): Promise<void> {
  for (const relative of journal.added) await removeQuietly(join(to, relative))
  for (const [relative, text] of journal.backups) {
    const target = join(to, relative)
    if (text === undefined) await removeQuietly(target)
    else {
      try {
        await writeFile(target, text, 'utf8')
      } catch {
        // The caller reports that the rollback was partial.
      }
    }
  }
}

/**
 * Point the library at another folder and move the whole library there.
 *
 * Validation: the target must be absolute, outside the current folder and its children,
 * and either empty, missing, or already a graph library (then both are merged).
 * @param baseDir - profile directory that holds the folder choice.
 * @param next - absolute folder the user picked.
 * @param options - operator, pointer publisher, failure hooks, log mirroring.
 */
export async function setGraphLibraryDir(
  baseDir: string,
  next: unknown,
  options: GraphMigrationOptions = {},
): Promise<GraphMigrationResult> {
  if (typeof next !== 'string' || next.trim() === '' || !isAbsolute(next)) {
    throw new GraphError('graph-invalid-path', '经验库目录必须是绝对路径。', 400)
  }
  const from = knowledgeGraphDirFor(baseDir)
  const to = resolve(next)
  if (samePath(from, to)) {
    const source = await verifyGraphLibrary(from)
    return {
      from,
      to,
      mode: 'move',
      counts: source.counts,
      copied: { nodes: 0, paths: 0, screenshots: 0, edges: 0 },
      deletedOld: false,
      leftover: false,
      log: join(from, GRAPH_MIGRATION_LOG),
      durationMs: 0,
    }
  }
  if (isInside(to, from) || isInside(from, to)) {
    throw new GraphError('graph-nested-path', '目标目录不能是当前目录本身、子目录或上级目录。', 400)
  }
  await new KnowledgeGraphStore(from).init()
  const source = await verifyGraphLibrary(from)
  if (!source.ok) {
    throw new GraphError('graph-source-broken', `当前经验库不完整，先修好再迁移：${source.problems.join('；')}`, 409)
  }
  let mode: 'move' | 'merge'
  if (!existsSync(to) || (await isEmptyFolder(to))) mode = 'move'
  else if (await isGraphLibrary(to)) mode = 'merge'
  else throw new GraphError('graph-target-not-empty', `目标目录已有非图谱文件，换一个空目录或先清空：${to}`, 409)

  const startedAt = Date.now()
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
  const stage = join(dirname(to), `.graph-migrate-${stamp}-${process.pid}`)
  const logBase: GraphMigrationLogEntry = {
    ts: new Date().toISOString(),
    event: 'start',
    from,
    to,
    mode,
    detail: options.operator ?? 'settings-page',
    counts: source.counts,
  }
  // Keep the run's lines in memory and write them to whichever folder owns the graph at
  // the end: the target after a success, the source after a rollback. Mirroring each line
  // into the harness home means a crash still leaves a trace somewhere.
  const entries: GraphMigrationLogEntry[] = []
  const record = async (entry: GraphMigrationLogEntry): Promise<void> => {
    entries.push(entry)
    await mirrorHomeLog(entry, options)
  }
  await record(logBase)

  let journal: MergeJournal | undefined
  let createdTarget = false
  let removedEmptyTarget = false
  let switched = false
  const previousConfig = readGraphConfig(baseDir)
  try {
    await stageCopy(from, stage)
    const staged = await verifyGraphLibrary(stage, {
      nodes: source.counts.nodes,
      edges: source.counts.edges,
      paths: source.counts.paths,
      decisions: source.counts.decisions,
    })
    if (!staged.ok) {
      throw new GraphError('graph-copy-unverified', `复制校验失败：${staged.problems.join('；')}`, 500)
    }
    await record({ ...logBase, ts: new Date().toISOString(), event: 'copied', counts: staged.counts })
    await options.hooks?.afterCopy?.()

    let expected: Partial<GraphCounts>
    let copied: GraphMigrationResult['copied']
    if (mode === 'move') {
      if (existsSync(to)) {
        await rm(to, { recursive: true, force: true })
        removedEmptyTarget = true
      }
      try {
        await rename(stage, to)
      } catch {
        await cp(stage, to, { recursive: true, force: true })
        await removeQuietly(stage)
      }
      createdTarget = true
      expected = {
        nodes: source.counts.nodes,
        edges: source.counts.edges,
        paths: source.counts.paths,
        decisions: source.counts.decisions,
      }
      copied = {
        nodes: source.counts.nodes,
        paths: source.counts.paths,
        screenshots: source.counts.screenshots,
        edges: source.counts.edges,
      }
    } else {
      const before = await verifyGraphLibrary(to)
      journal = await mergeStaged(stage, to)
      expected = {
        nodes: before.counts.nodes + journal.added.filter((file) => file.startsWith('nodes')).length,
        paths: before.counts.paths + journal.added.filter((file) => file.startsWith('paths')).length,
        edges: journal.edges,
      }
      copied = {
        nodes: journal.added.filter((file) => file.startsWith('nodes')).length,
        paths: journal.added.filter((file) => file.startsWith('paths')).length,
        screenshots: journal.added.filter((file) => file.startsWith('screenshots')).length,
        edges: source.counts.edges,
      }
      const merged = await verifyGraphLibrary(to, expected)
      if (!merged.ok) {
        throw new GraphError('graph-merge-unverified', `合并校验失败：${merged.problems.join('；')}`, 500)
      }
      await removeQuietly(stage)
    }
    const target = await verifyGraphLibrary(to, expected)
    if (!target.ok) throw new GraphError('graph-verify-failed', `目标校验失败：${target.problems.join('；')}`, 500)

    // The pointer switch is the commit point: nothing is deleted before it succeeds.
    await writeGraphConfig(baseDir, to)
    switched = true
    options.publish?.(to)
    await record({ ...logBase, ts: new Date().toISOString(), event: 'switched', counts: target.counts })
    await options.hooks?.beforeDelete?.()

    let leftover = false
    try {
      await rm(from, { recursive: true, force: true })
      await record({ ...logBase, ts: new Date().toISOString(), event: 'deleted-old', counts: target.counts })
    } catch {
      leftover = true
      await record(
        { ...logBase, ts: new Date().toISOString(), event: 'leftover', detail: '旧目录删不掉，两份都是完整的', counts: target.counts },
      )
    }
    const result: GraphMigrationResult = {
      from,
      to,
      mode,
      counts: target.counts,
      copied,
      deletedOld: !leftover,
      leftover,
      log: join(to, GRAPH_MIGRATION_LOG),
      durationMs: Date.now() - startedAt,
    }
    await record({ ...logBase, ts: new Date().toISOString(), event: 'done', counts: target.counts, detail: `mode=${mode} leftover=${leftover}` })
    await writeLibraryLog(to, entries)
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // Roll back whatever the attempt changed at the target, in reverse order.
    if (journal !== undefined) await rollbackMerge(to, journal)
    if (createdTarget) await removeQuietly(to)
    if (removedEmptyTarget && !existsSync(to)) {
      try {
        await mkdir(to, { recursive: true })
      } catch {
        // An empty folder is not worth failing the rollback for.
      }
    }
    if (switched) {
      try {
        if (previousConfig === undefined) await removeQuietly(join(baseDir, GRAPH_CONFIG))
        else await writeFile(join(baseDir, GRAPH_CONFIG), previousConfig.text, 'utf8')
      } catch {
        // The log below records the rollback attempt.
      }
      options.publish?.(from)
    }
    await removeQuietly(stage)
    await record({
      ...logBase,
      ts: new Date().toISOString(),
      event: 'failed',
      detail: message.slice(0, 500),
    })
    await record({
      ...logBase,
      ts: new Date().toISOString(),
      event: 'rollback',
      detail: switched ? '指针已还原到原目录' : '未切换指针，原目录未改动',
    })
    await writeLibraryLog(from, entries)
    const intact = await verifyGraphLibrary(from)
    throw new GraphError(
      'graph-migration-failed',
      `迁移失败，已回滚到原目录（${intact.ok ? '原库完整' : '原库校验未通过'}）：${message}`,
      500,
    )
  }
}

/** Open the library in the system file manager. */
export function openGraphFolder(baseDir: string): void {
  try {
    const opener = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
    spawn(opener, [knowledgeGraphDirFor(baseDir)], { detached: true, stdio: 'ignore' }).unref()
  } catch {
    // A missing file manager only costs the button.
  }
}

/** Manifest counts, exported for the settings card. */
export function manifestCounts(manifest: GraphManifest): GraphCounts {
  return { ...manifest.counts }
}
