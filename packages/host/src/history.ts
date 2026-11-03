/**
 * Retention for the floating-ball workspace history.
 *
 * A cleanup archives a conversation, packs its subagent directories and the images
 * only it references into a hidden folder inside the root session directory, then
 * hands that directory to the operating system's trash (macOS Trash / Windows
 * Recycle Bin). Restoring the folder from the system trash puts it back in the
 * sessions root; the restore scan below then moves the packed pieces back and
 * unarchives the conversation. There is no plugin-owned trash and no copy: the
 * files the user restores are the only copy.
 */

import { existsSync, statSync } from 'node:fs'
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { isHistoryRetentionDays, type ProfileStore } from './preferences.ts'

/** One row from the official Session list. Only the fields retention reads are named. */
export interface HistorySessionRow {
  readonly sessionId: string
  /** Last chat (last prompt), which is what a retention day counts. */
  readonly updatedAt?: number
  readonly running?: boolean
  /**
   * True while the conversation holds no turn: the official list marks it, and the main window
   * shows only the selected blank. The ball mints these on every New Chat press in the versions
   * before 0.1.9, which is what {@link HistoryCleaner.sweepBlanks} takes out of the store.
   */
  readonly blank?: boolean
  readonly parentSessionId?: string
  readonly origin?: string
  readonly cwd?: string
  readonly projections?: {
    readonly values?: {
      readonly agentPreset?: string
      readonly title?: string
    }
  }
}

/** The persisted Session header fields the graph needs. */
export interface HistorySessionHeader {
  readonly id: string
  readonly cwd?: string
  readonly parentSession?: string
  readonly origin?: string
  readonly createdAt?: number
}

/** One stored Session snapshot; `sizeBytes` is the physical log size. */
export interface HistorySessionSnapshot {
  readonly header: HistorySessionHeader
  readonly sizeBytes?: number
}

/** A read handle from the official persistence service. */
export interface HistorySessionHandle {
  read(): Promise<{ readonly events?: readonly unknown[] }>
  close(): Promise<void>
}

/** The slice of `ctx.sessionPersistence` retention uses. */
export interface HistoryPersistence {
  list(options?: { readonly signal?: AbortSignal }): Promise<readonly HistorySessionSnapshot[]>
  stat(id: string, options?: { readonly signal?: AbortSignal }): Promise<HistorySessionSnapshot | undefined>
  open(id: string, mode: 'read'): Promise<HistorySessionHandle>
  /** JSONL backend convenience: the absolute log path for one header. */
  locate?(header: HistorySessionHeader): { readonly path?: string } | undefined
}

/** Workspace archive/pin sets, read before a run so neither kind is ever deleted. */
export interface WorkspaceSafety {
  readonly pinned: readonly string[]
  readonly archived: readonly string[]
}

export interface HistoryState {
  readonly available: boolean
  readonly workspacePath: string
  readonly retentionDays: number
  readonly cleaning: boolean
  readonly phase: string
  readonly error: string | null
  readonly lastCleanupAt: number | null
  readonly lastDeletedSessions: number
  readonly lastMovedBytes: number
  /** Set when an unreadable orb-workspace session forced a partial cleanup. */
  readonly warning: '' | 'images-kept'
  readonly warningSessions: number
}

export interface HistoryPreviewSession {
  readonly id: string
  readonly title: string
  readonly updatedAt: number
}

export interface HistoryPreview {
  readonly days: number
  readonly cutoff: number
  readonly roots: number
  readonly members: number
  readonly images: number
  readonly bytes: number
  readonly oldest: number | null
  readonly newest: number | null
  readonly skipped: HistorySkipCounts
  /** Root sessions in the run, capped; the dialog names what it will remove. */
  readonly sessions: readonly HistoryPreviewSession[]
}

export interface HistorySkipCounts {
  active: number
  pinned: number
  archived: number
  current: number
  unchanged: number
  unreadable: number
  restored: number
}

export interface HistoryDeps {
  readonly store: ProfileStore
  readonly workspacePath: () => string
  readonly currentSession: () => string | undefined
  readonly listSessions: () => Promise<readonly HistorySessionRow[]>
  /** True while a Session has an attached Agent or its UI is open. */
  readonly isAttached: (id: string) => boolean
  readonly workspaceSafety: () => Promise<WorkspaceSafety>
  readonly archive: (id: string) => Promise<void>
  readonly unarchive: (id: string) => Promise<void>
  /** Resolved lazily so a late-mounted service is still usable. */
  readonly persistence: () => HistoryPersistence | undefined
  /** Whether the services and the operating-system trash are usable here. */
  readonly available: () => boolean
  /** Move one path to the operating system's trash. Never keeps a copy. */
  readonly trash: (path: string) => Promise<void>
  readonly sessionsRoot: string
  readonly objectsRoot: string
  readonly now?: () => number
  readonly log?: (message: string) => void
}

/** What a trashed conversation folder carries so it can be unpacked on restore. */
export interface OsTrashManifest {
  readonly version: 1
  readonly rootId: string
  readonly createdAt: number
  readonly workspace: string
  readonly sessions: readonly { readonly id: string; readonly dir: string }[]
  readonly images: readonly { readonly id: string }[]
  readonly archived: readonly string[]
  /** True once the folder has actually been handed to the system trash. */
  readonly trashed?: boolean
}

/** State shown when a Host has no persistence or no usable system trash. */
export const EMPTY_HISTORY_STATE: HistoryState = {
  available: false,
  workspacePath: '',
  retentionDays: 0,
  cleaning: false,
  phase: '',
  error: null,
  lastCleanupAt: null,
  lastDeletedSessions: 0,
  lastMovedBytes: 0,
  warning: '',
  warningSessions: 0,
}

/** First automatic check after startup; long enough for the app to settle. */
export const HISTORY_FIRST_CHECK_MS = 60 * 1000

/** How often a finite retention is checked while the app stays open. */
export const HISTORY_INTERVAL_MS = 24 * 60 * 60 * 1000

/** How often the sessions root is checked for folders restored from system trash. */
export const HISTORY_RESTORE_INTERVAL_MS = 10 * 1000

const DAY_MS = 24 * 60 * 60 * 1000
const MOVE_ATTEMPTS = 5
const MOVE_BACKOFF_MS = 50
const SHA256_REF = /sha256:[0-9a-f]{64}/g
/** Hidden folder inside a trashed root Session directory. */
const MARKER = '.dsh-agi-os-trash'
const MARKER_MANIFEST = 'manifest.json'

/** A candidate session plus everything a run needs to move it. */
interface CandidateTree {
  readonly root: HistorySessionRow
  readonly members: readonly HistorySessionRow[]
  readonly sessions: ReadonlyMap<string, HistorySessionSnapshot>
  readonly dirs: ReadonlyMap<string, string>
  readonly images: ReadonlyMap<string, number>
  readonly logBytes: number
  readonly newest: number
  readonly oldest: number
}

interface HistoryPlan {
  readonly cutoff: number
  readonly trees: readonly CandidateTree[]
  readonly images: ReadonlyMap<string, number>
  readonly logBytes: number
  readonly skipped: HistorySkipCounts
}

interface TrashOutcome {
  readonly ok: boolean
  readonly sessions: number
  readonly bytes: number
}

class HistoryUnavailableError extends Error {}

/**
 * Retention, preview, cleanup, and restoration from the operating system's trash.
 * The class never decides whether a service exists; {@link HistoryDeps.available}
 * and the injected functions keep every composition explicit.
 */
export class HistoryCleaner {
  private readonly deps: HistoryDeps
  private cleaning = false
  /** A cleanup was requested while {@link cleaning} was already held. */
  private cleanPending = false
  private phase = ''
  private error: string | null = null
  private warning: '' | 'images-kept' = ''
  private warningSessions = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private interval: ReturnType<typeof setInterval> | undefined
  private restoreTimer: ReturnType<typeof setInterval> | undefined

  constructor(deps: HistoryDeps) {
    this.deps = deps
  }

  /** State rendered by the settings card; never scans session logs. */
  state(): HistoryState {
    const history = this.deps.store.history()
    return {
      available: this.available(),
      workspacePath: this.deps.workspacePath(),
      retentionDays: history.retentionDays,
      cleaning: this.cleaning,
      phase: this.phase,
      error: this.error,
      lastCleanupAt: history.lastCleanupAt === 0 ? null : history.lastCleanupAt,
      lastDeletedSessions: history.lastDeletedSessions,
      lastMovedBytes: history.lastMovedBytes,
      warning: this.warning,
      warningSessions: this.warningSessions,
    }
  }

  /** Persist a retention policy. 0 means forever and deletes nothing. */
  setRetention(days: number): void {
    if (!isHistoryRetentionDays(days)) throw new Error('invalid-retention')
    this.deps.store.setHistoryRecord({ retentionDays: days })
    this.error = null
    this.warning = ''
    this.warningSessions = 0
  }

  /** Read-only count of what the current policy would move. */
  async preview(days: number): Promise<HistoryPreview> {
    this.assertAvailable()
    if (!isHistoryRetentionDays(days)) throw new Error('invalid-retention')
    if (days === 0) {
      return {
        days,
        cutoff: 0,
        roots: 0,
        members: 0,
        images: 0,
        bytes: 0,
        oldest: null,
        newest: null,
        skipped: emptySkips(),
        sessions: [],
      }
    }
    const plan = await this.plan(days)
    let bytes = plan.logBytes
    for (const size of plan.images.values()) bytes += size
    return {
      days,
      cutoff: plan.cutoff,
      roots: plan.trees.length,
      members: plan.trees.reduce((sum, tree) => sum + tree.members.length, 0),
      images: plan.images.size,
      bytes,
      oldest: plan.trees.length === 0 ? null : Math.min(...plan.trees.map((tree) => tree.oldest)),
      newest: plan.trees.length === 0 ? null : Math.max(...plan.trees.map((tree) => tree.newest)),
      skipped: plan.skipped,
      sessions: plan.trees.slice(0, 20).map((tree) => ({
        id: tree.root.sessionId,
        title: tree.root.projections?.values?.title || tree.root.sessionId,
        updatedAt: tree.root.updatedAt ?? 0,
      })),
    }
  }

  /**
   * Start a cleanup and return at once; the card polls {@link state}.
   * A request that arrives while a restore scan or another cleanup holds the
   * lock is kept and runs when that pass finishes, so a confirmed retention
   * change is not dropped.
   */
  startClean(): void {
    this.cleanPending = true
    this.startQueuedClean()
  }

  /** Run one queued cleanup once the shared lock is free. */
  private startQueuedClean(): void {
    if (this.cleaning || !this.cleanPending) return
    this.cleanPending = false
    this.cleaning = true
    this.phase = 'scanning'
    this.error = null
    this.warning = ''
    this.warningSessions = 0
    void this.clean().catch((error: unknown) => {
      this.error = messageOf(error)
      this.log(`history cleanup failed: ${this.error}`)
    }).finally(() => {
      this.cleaning = false
      this.phase = ''
      this.startQueuedClean()
    })
  }

  /**
   * Unpack every conversation folder that came back from the system trash.
   * Runs at startup and on a timer so Finder's Put Back takes effect without a restart.
   */
  async restoreStaged(): Promise<void> {
    if (this.cleaning) return
    this.cleaning = true
    this.phase = 'restoring'
    try {
      let projects
      try {
        projects = await readdir(this.deps.sessionsRoot, { withFileTypes: true })
      } catch {
        return
      }
      for (const project of projects) {
        if (!project.isDirectory()) continue
        let sessions
        try {
          sessions = await readdir(join(this.deps.sessionsRoot, project.name), { withFileTypes: true })
        } catch {
          continue
        }
        for (const session of sessions) {
          if (!session.isDirectory()) continue
          const dir = join(this.deps.sessionsRoot, project.name, session.name)
          const marker = join(dir, MARKER)
          if (!existsSync(join(marker, MARKER_MANIFEST))) continue
          try {
            await this.recoverMarker(dir, marker)
          } catch (error) {
            this.log(`could not restore a conversation from ${dir}: ${messageOf(error)}`)
          }
        }
      }
    } finally {
      this.cleaning = false
      this.phase = ''
      // A cleanup confirmed during this scan must run before the lock looks idle.
      this.startQueuedClean()
    }
  }

  /** Schedule the restore scan and the daily retention check. */
  start(): () => void {
    void this.restoreStaged()
    this.restoreTimer = setInterval(() => { void this.restoreStaged() }, HISTORY_RESTORE_INTERVAL_MS)
    this.restoreTimer.unref()
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.startClean()
    }, HISTORY_FIRST_CHECK_MS)
    this.timer.unref()
    this.interval = setInterval(() => { this.startClean() }, HISTORY_INTERVAL_MS)
    this.interval.unref()
    return () => {
      if (this.timer !== undefined) clearTimeout(this.timer)
      if (this.interval !== undefined) clearInterval(this.interval)
      if (this.restoreTimer !== undefined) clearInterval(this.restoreTimer)
      this.timer = undefined
      this.interval = undefined
      this.restoreTimer = undefined
    }
  }

  private available(): boolean {
    try {
      return this.deps.available()
    } catch {
      return false
    }
  }

  private assertAvailable(): void {
    if (!this.available()) throw new HistoryUnavailableError('history-unavailable')
  }

  /** Plan one run. Preview skips the live-reference scan; cleanup needs it. */
  private async plan(days: number): Promise<HistoryPlan> {
    const persistence = this.deps.persistence()
    if (persistence === undefined) throw new HistoryUnavailableError('history-unavailable')
    const now = this.now()
    const cutoff = now - days * DAY_MS
    const [snapshots, rows, safety] = await Promise.all([
      persistence.list({ signal: AbortSignal.timeout(30_000) }),
      this.deps.listSessions(),
      this.deps.workspaceSafety(),
    ])
    const rowById = new Map(rows.map((row) => [row.sessionId, row]))
    const snapshotById = new Map(snapshots.map((snapshot) => [snapshot.header.id, snapshot]))
    const pinned = new Set(safety.pinned)
    const archived = new Set(safety.archived)
    const restored = new Set(this.deps.store.history().restoredSessionIds)
    const children = new Map<string, Set<string>>()
    const addChild = (parent: string | undefined, id: string, origin: string | undefined): void => {
      if (parent === undefined || origin !== 'subagent') return
      const set = children.get(parent)
      if (set === undefined) children.set(parent, new Set([id]))
      else set.add(id)
    }
    for (const snapshot of snapshots) addChild(snapshot.header.parentSession, snapshot.header.id, snapshot.header.origin)
    for (const row of rows) addChild(row.parentSessionId, row.sessionId, row.origin)
    const skipped = emptySkips()
    const trees: CandidateTree[] = []
    const workspace = resolve(this.deps.workspacePath())
    for (const row of rows) {
      if (!isOrbRoot(row, workspace)) continue
      if (row.updatedAt === undefined || !Number.isFinite(row.updatedAt) || row.updatedAt <= 0) {
        skipped.unchanged += 1
        continue
      }
      if (row.updatedAt >= cutoff) {
        skipped.unchanged += 1
        continue
      }
      const tree = await this.candidateTree(row, children, rowById, snapshotById, pinned, archived, restored, cutoff, skipped)
      if (tree !== undefined) trees.push(tree)
    }
    const readable: CandidateTree[] = []
    for (const tree of trees) {
      try {
        readable.push(await this.readCandidate(tree))
      } catch (error) {
        skipped.unreadable += 1
        this.log(`history cleanup skipped ${tree.root.sessionId}: ${messageOf(error)}`)
      }
    }
    const images = new Map<string, number>()
    let logBytes = 0
    for (const tree of readable) {
      logBytes += tree.logBytes
      for (const [id, bytes] of tree.images) images.set(id, bytes)
    }
    return { cutoff, trees: readable, images, logBytes, skipped }
  }

  /** Resolve one root plus its subagent descendants, skipping anything protected. */
  private async candidateTree(
    root: HistorySessionRow,
    children: ReadonlyMap<string, ReadonlySet<string>>,
    rowById: ReadonlyMap<string, HistorySessionRow>,
    snapshotById: ReadonlyMap<string, HistorySessionSnapshot>,
    pinned: ReadonlySet<string>,
    archived: ReadonlySet<string>,
    restored: ReadonlySet<string>,
    cutoff: number,
    skipped: HistorySkipCounts,
  ): Promise<CandidateTree | undefined> {
    const members: HistorySessionRow[] = []
    const sessions = new Map<string, HistorySessionSnapshot>()
    const pending = [root.sessionId]
    const seen = new Set<string>()
    let newest = 0
    let oldest = Number.POSITIVE_INFINITY
    while (pending.length > 0) {
      const id = pending.pop()
      if (id === undefined || seen.has(id)) continue
      seen.add(id)
      const row = rowById.get(id)
      if (row === undefined) { skipped.unchanged += 1; return undefined }
      if (pinned.has(id)) { skipped.pinned += 1; return undefined }
      if (archived.has(id)) { skipped.archived += 1; return undefined }
      if (restored.has(id)) { skipped.restored += 1; return undefined }
      if (this.deps.currentSession() === id) { skipped.current += 1; return undefined }
      if (row.running === true || this.deps.isAttached(id)) { skipped.active += 1; return undefined }
      if (row.updatedAt === undefined || !Number.isFinite(row.updatedAt) || row.updatedAt <= 0) {
        skipped.unchanged += 1
        return undefined
      }
      if (row.updatedAt >= cutoff) { skipped.unchanged += 1; return undefined }
      const snapshot = snapshotById.get(id)
      if (snapshot === undefined) { skipped.unchanged += 1; return undefined }
      members.push(row)
      sessions.set(id, snapshot)
      newest = Math.max(newest, row.updatedAt)
      oldest = Math.min(oldest, row.updatedAt)
      for (const child of children.get(id) ?? []) pending.push(child)
    }
    const dirs = new Map<string, string>()
    for (const member of members) {
      const dir = await this.sessionDirectory(member.sessionId, sessions.get(member.sessionId))
      if (dir === undefined) { skipped.unreadable += 1; return undefined }
      dirs.set(member.sessionId, dir)
    }
    return { root, members, sessions, dirs, images: new Map(), logBytes: 0, newest, oldest }
  }

  /** Read one candidate tree's events, image ids, and physical log bytes. */
  private async readCandidate(tree: CandidateTree): Promise<CandidateTree> {
    const persistence = this.persistenceOrThrow()
    const images = new Map<string, number>()
    let logBytes = 0
    for (const member of tree.members) {
      const snapshot = tree.sessions.get(member.sessionId)
      if (snapshot === undefined) throw new Error(`session ${member.sessionId} disappeared`)
      const statted = await persistence.stat(member.sessionId, { signal: AbortSignal.timeout(15_000) })
      logBytes += statted?.sizeBytes ?? snapshot.sizeBytes ?? 0
      const handle = await persistence.open(member.sessionId, 'read')
      try {
        const read = await handle.read()
        for (const id of structuredImageIds(read.events ?? [])) {
          if (images.has(id)) continue
          images.set(id, await this.objectSize(id))
        }
      } finally {
        await handle.close().catch(() => undefined)
      }
    }
    return { ...tree, images, logBytes }
  }

  private async clean(): Promise<void> {
    const days = this.deps.store.history().retentionDays
    if (days <= 0) return
    this.assertAvailable()
    this.phase = 'planning'
    const plan = await this.plan(days)
    if (plan.trees.length === 0) return
    const persistence = this.persistenceOrThrow()
    const deleting = new Set(plan.trees.flatMap((tree) => tree.members.map((member) => member.sessionId)))
    const workspace = resolve(this.deps.workspacePath())
    const live = await this.liveReferences(persistence, deleting, workspace)
    if (live.incomplete) {
      this.warning = 'images-kept'
      this.warningSessions = live.unreadable
    }
    const owners = new Map<string, Set<string>>()
    for (const tree of plan.trees) {
      for (const id of tree.images.keys()) {
        const set = owners.get(id)
        if (set === undefined) owners.set(id, new Set([tree.root.sessionId]))
        else set.add(tree.root.sessionId)
      }
    }
    this.phase = 'archiving'
    let deleted = 0
    let bytes = 0
    const failures: string[] = []
    for (const tree of plan.trees) {
      const images = new Map<string, number>()
      if (!live.incomplete) {
        for (const [id, size] of tree.images) {
          if (live.refs.has(id)) continue
          if ((owners.get(id)?.size ?? 0) !== 1) continue
          images.set(id, size)
        }
      }
      const outcome = await this.trashTree(tree, images)
      if (outcome.ok) {
        deleted += outcome.sessions
        bytes += outcome.bytes
      } else {
        failures.push(tree.root.sessionId)
      }
    }
    if (deleted > 0) {
      this.deps.store.setHistoryRecord({
        lastCleanupAt: this.now(),
        lastDeletedSessions: deleted,
        lastMovedBytes: bytes,
      })
    }
    if (failures.length > 0) throw new Error(`os-trash-failed:${String(failures.length)}`)
    this.error = null
  }

  /**
   * Move conversations that never got a message to the operating system's trash.
   *
   * Every New Chat press used to mint a Session, so a profile that pressed it a few times carries
   * a pile of empty "untitled" rows. Neither window shows them again — the main window draws only
   * the selected blank, the ball now hides the rest — so what is left is to take them out of the
   * store once. Everything a window could be using is spared: the current conversation, anything
   * with an attached Agent, pinned or archived rows, and anything touched inside the grace window
   * (a draft someone is typing into).
   *
   * @param options.graceMs - how recently a blank must have been touched to be left alone.
   * @param options.limit - hard cap for one pass, so a backlog cannot hold the start path.
   * @returns how many conversations were moved to the trash.
   */
  async sweepBlanks(options: { graceMs?: number; limit?: number } = {}): Promise<number> {
    // A pass that could not run must not be recorded as one: the caller writes its marker from a
    // returned number, and a profile swept while its history services were missing would keep the
    // junk forever.
    if (!this.available()) throw new HistoryUnavailableError('history-unavailable')
    if (this.cleaning) throw new Error('history-busy')
    const now = this.now()
    const grace = options.graceMs ?? 5 * 60 * 1000
    const limit = options.limit ?? 60
    const workspace = resolve(this.deps.workspacePath())
    const [rows, safety] = await Promise.all([this.deps.listSessions(), this.deps.workspaceSafety()])
    const pinned = new Set(safety.pinned)
    const archived = new Set(safety.archived)
    let swept = 0
    for (const row of rows) {
      if (swept >= limit) break
      if (row.blank !== true || row.running === true) continue
      if (!isOrbRoot(row, workspace)) continue
      if (pinned.has(row.sessionId) || archived.has(row.sessionId)) continue
      if (this.deps.currentSession() === row.sessionId) continue
      if (this.deps.isAttached(row.sessionId)) continue
      if (typeof row.updatedAt !== 'number' || !Number.isFinite(row.updatedAt) || row.updatedAt <= 0) continue
      if (now - row.updatedAt < grace) continue
      const dir = await this.sessionDirectory(row.sessionId, undefined)
      if (dir === undefined) {
        this.log(`blank sweep skipped ${row.sessionId}: its directory could not be located`)
        continue
      }
      // A one-session tree with no children and no images: a blank has neither by definition.
      const tree: CandidateTree = {
        root: row,
        members: [row],
        sessions: new Map(),
        dirs: new Map([[row.sessionId, dir]]),
        images: new Map(),
        logBytes: 0,
        newest: row.updatedAt,
        oldest: row.updatedAt,
      }
      try {
        if ((await this.trashTree(tree, new Map())).ok) swept += 1
      } catch (error) {
        this.log(`blank sweep skipped ${row.sessionId}: ${messageOf(error)}`)
      }
    }
    this.phase = ''
    if (swept > 0) this.log(`blank sweep moved ${swept} empty conversation(s) to the system trash`)
    return swept
  }

  /** Pack one conversation tree into its root directory and hand that directory to the OS trash. */
  private async trashTree(tree: CandidateTree, images: ReadonlyMap<string, number>): Promise<TrashOutcome> {
    const rootDir = tree.dirs.get(tree.root.sessionId)
    if (rootDir === undefined) return { ok: false, sessions: 0, bytes: 0 }
    const marker = join(rootDir, MARKER)
    if (existsSync(marker)) {
      this.log(`history cleanup skipped ${tree.root.sessionId}: it already has a pending restore marker`)
      return { ok: false, sessions: 0, bytes: 0 }
    }
    const movedImages = [...images.keys()].filter((id) => existsSync(this.objectPath(id)))
    let manifest: OsTrashManifest = {
      version: 1,
      rootId: tree.root.sessionId,
      createdAt: this.now(),
      workspace: resolve(this.deps.workspacePath()),
      sessions: tree.members.map((member) => ({ id: member.sessionId, dir: tree.dirs.get(member.sessionId) as string })),
      images: movedImages.map((id) => ({ id })),
      archived: tree.members.map((member) => member.sessionId),
    }
    try {
      await this.writeMarker(marker, manifest)
    } catch (error) {
      this.log(`history cleanup could not stage ${tree.root.sessionId}: ${messageOf(error)}`)
      return { ok: false, sessions: 0, bytes: 0 }
    }
    if (!await this.archiveTree(tree)) {
      await rm(marker, { recursive: true, force: true }).catch(() => undefined)
      return { ok: false, sessions: 0, bytes: 0 }
    }
    try {
      for (const member of tree.members) {
        if (member.sessionId === tree.root.sessionId) continue
        const from = tree.dirs.get(member.sessionId) as string
        if (!existsSync(from)) throw new Error(`session directory ${member.sessionId} disappeared`)
        await movePath(from, join(marker, 'sessions', member.sessionId))
      }
      for (const id of movedImages) {
        await movePath(this.objectPath(id), join(marker, 'objects', objectRelative(id)))
      }
    } catch (error) {
      this.log(`history cleanup could not pack ${tree.root.sessionId}: ${messageOf(error)}`)
      await this.unpackMarker(rootDir, marker, manifest)
      return { ok: false, sessions: 0, bytes: 0 }
    }
    // Mark the folder as actually trashed before handing it over; a marker recovered
    // later then means the user restored it, while a pre-trash crash does not.
    try {
      manifest = { ...manifest, trashed: true }
      await this.writeMarker(marker, manifest)
    } catch (error) {
      this.log(`history cleanup could not mark ${tree.root.sessionId}: ${messageOf(error)}`)
      await this.unpackMarker(rootDir, marker, manifest)
      return { ok: false, sessions: 0, bytes: 0 }
    }
    this.phase = 'trashing'
    try {
      await this.deps.trash(rootDir)
    } catch (error) {
      this.log(`history cleanup could not move ${tree.root.sessionId} to the system trash: ${messageOf(error)}`)
      await this.unpackMarker(rootDir, marker, manifest)
      return { ok: false, sessions: 0, bytes: 0 }
    }
    const bytes = tree.logBytes + movedImages.reduce((sum, id) => sum + (images.get(id) ?? 0), 0)
    return { ok: true, sessions: tree.members.length, bytes }
  }

  /** Move packed children/images back into their original paths and unarchive the tree. */
  private async unpackMarker(rootDir: string, marker: string, manifest: OsTrashManifest): Promise<boolean> {
    let complete = true
    for (const session of manifest.sessions) {
      if (session.id === manifest.rootId) continue
      if (!isSessionId(session.id) || !isUnder(this.deps.sessionsRoot, session.dir)) {
        this.log(`history restore skipped an unsafe session entry ${String(session.id)}`)
        complete = false
        continue
      }
      const from = join(marker, 'sessions', session.id)
      if (!existsSync(from)) {
        if (!existsSync(session.dir)) complete = false
        continue
      }
      if (existsSync(session.dir)) continue
      try {
        await mkdir(dirname(session.dir), { recursive: true })
        await movePath(from, session.dir)
      } catch (error) {
        this.log(`history restore could not move ${session.id}: ${messageOf(error)}`)
        complete = false
      }
    }
    for (const image of manifest.images) {
      if (!isImageId(image.id)) {
        this.log(`history restore skipped an unsafe image entry ${String(image.id)}`)
        complete = false
        continue
      }
      const from = join(marker, 'objects', objectRelative(image.id))
      if (!existsSync(from)) {
        if (!existsSync(this.objectPath(image.id))) complete = false
        continue
      }
      const target = this.objectPath(image.id)
      if (existsSync(target)) continue
      try {
        await mkdir(dirname(target), { recursive: true })
        await movePath(from, target)
      } catch (error) {
        this.log(`history restore could not move ${image.id}: ${messageOf(error)}`)
        complete = false
      }
    }
    if (!complete) {
      this.log(`history restore for ${rootDir} is incomplete; its marker stays for the next scan`)
      return false
    }
    for (const id of manifest.archived) await this.deps.unarchive(id).catch((error: unknown) => this.log(`history restore could not unarchive ${id}: ${messageOf(error)}`))
    await rm(marker, { recursive: true, force: true })
    return true
  }

  private async recoverMarker(rootDir: string, marker: string): Promise<void> {
    const manifest = await this.readMarker(marker)
    if (manifest === undefined) {
      this.log(`history restore skipped ${marker}: unreadable manifest`)
      return
    }
    if (manifest.rootId !== basename(rootDir)) {
      this.log(`history restore skipped ${marker}: marker does not belong to its directory`)
      return
    }
    if (!isUnder(this.deps.sessionsRoot, rootDir)) {
      this.log(`history restore skipped ${rootDir}: outside the sessions root`)
      return
    }
    const restored = await this.unpackMarker(rootDir, marker, manifest)
    if (restored && manifest.trashed === true) this.protect(manifest.archived)
  }

  /** A manual system-trash restore is a keep decision; skip these in future runs. */
  private protect(ids: readonly string[]): void {
    const history = this.deps.store.history()
    const merged = [...new Set([...history.restoredSessionIds, ...ids])].slice(-1000)
    this.deps.store.setHistoryRecord({ restoredSessionIds: merged })
  }

  /**
   * Collect every image id still referenced by a session that stays.
   * An unreadable session outside the orb workspace (a legacy v0 log, for example)
   * cannot own an orb screenshot in practice; ignoring it lets the cleanup proceed.
   * An unreadable orb session is unknown, so no image object is moved in that run.
   */
  private async liveReferences(
    persistence: HistoryPersistence,
    deleting: ReadonlySet<string>,
    workspace: string,
  ): Promise<{ refs: Set<string>; incomplete: boolean; unreadable: number }> {
    const refs = new Set<string>()
    let incomplete = false
    let unreadable = 0
    for (const snapshot of await persistence.list({ signal: AbortSignal.timeout(30_000) })) {
      if (deleting.has(snapshot.header.id)) continue
      try {
        const handle = await persistence.open(snapshot.header.id, 'read')
        try {
          const read = await handle.read()
          for (const id of referencedImageIds(read.events ?? [])) refs.add(id)
        } finally {
          await handle.close().catch(() => undefined)
        }
      } catch (error) {
        const cwd = snapshot.header.cwd
        const inWorkspace = cwd === undefined
          || resolve(cwd) === workspace
          || isUnder(workspace, cwd)
        if (inWorkspace) {
          incomplete = true
          unreadable += 1
          this.log(`history cleanup could not read orb session ${snapshot.header.id}: ${messageOf(error)}`)
        } else {
          this.log(`history cleanup ignored unreadable session ${snapshot.header.id} outside the orb workspace: ${messageOf(error)}`)
        }
      }
    }
    return { refs, incomplete, unreadable }
  }

  private async archiveTree(tree: CandidateTree): Promise<boolean> {
    const archived: string[] = []
    try {
      for (const member of tree.members) {
        await this.deps.archive(member.sessionId)
        archived.push(member.sessionId)
      }
      return true
    } catch (error) {
      this.log(`history cleanup skipped ${tree.root.sessionId}: ${messageOf(error)}`)
      for (const id of archived.reverse()) await this.deps.unarchive(id).catch(() => undefined)
      return false
    }
  }

  private async sessionDirectory(id: string, snapshot: HistorySessionSnapshot | undefined): Promise<string | undefined> {
    const persistence = this.persistenceOrThrow()
    const header = snapshot?.header ?? (await persistence.stat(id, { signal: AbortSignal.timeout(15_000) }))?.header
    if (header === undefined) return undefined
    const located = persistence.locate?.(header)
    if (typeof located?.path === 'string' && located.path !== '') {
      const dir = dirname(located.path)
      return isUnder(this.deps.sessionsRoot, dir) ? dir : undefined
    }
    try {
      for (const project of await readdir(this.deps.sessionsRoot, { withFileTypes: true })) {
        if (!project.isDirectory()) continue
        const candidate = join(this.deps.sessionsRoot, project.name, id)
        if (!isUnder(this.deps.sessionsRoot, candidate)) continue
        try {
          if (statSync(candidate).isDirectory()) return candidate
        } catch {
          // Try the next project directory.
        }
      }
    } catch {
      return undefined
    }
    return undefined
  }

  private objectPath(id: string): string {
    const hex = id.slice('sha256:'.length)
    return join(this.deps.objectsRoot, hex.slice(0, 2), hex)
  }

  private async objectSize(id: string): Promise<number> {
    try {
      return (await stat(this.objectPath(id))).size
    } catch {
      return 0
    }
  }

  private persistenceOrThrow(): HistoryPersistence {
    const persistence = this.deps.persistence()
    if (persistence === undefined) throw new HistoryUnavailableError('history-unavailable')
    return persistence
  }

  private async writeMarker(marker: string, manifest: OsTrashManifest): Promise<void> {
    await mkdir(join(marker, 'sessions'), { recursive: true, mode: 0o700 })
    await mkdir(join(marker, 'objects'), { recursive: true, mode: 0o700 })
    const file = join(marker, MARKER_MANIFEST)
    const staged = `${file}.tmp`
    await writeFile(staged, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
    await rename(staged, file)
  }

  private async readMarker(marker: string): Promise<OsTrashManifest | undefined> {
    try {
      const parsed = JSON.parse(await readFile(join(marker, MARKER_MANIFEST), 'utf8')) as Partial<OsTrashManifest>
      if (parsed.version !== 1 || typeof parsed.rootId !== 'string' || !Array.isArray(parsed.sessions) || !Array.isArray(parsed.images)) return undefined
      return parsed as OsTrashManifest
    } catch {
      return undefined
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private log(message: string): void {
    (this.deps.log ?? ((line: string) => console.error(`dsh-agi: ${line}`)))(message)
  }
}

/** Roots the ball's history shows: the workspace itself, an ordinary preset, not a subagent. */
export function isOrbRoot(row: HistorySessionRow, workspace: string): boolean {
  if (row.origin === 'subagent') return false
  if (typeof row.cwd !== 'string' || resolve(row.cwd) !== resolve(workspace)) return false
  const preset = row.projections?.values?.agentPreset
  return preset === undefined || preset === 'computer-use'
}

/** Image ids carried by structured ImageBlocks in persisted events. */
export function structuredImageIds(events: readonly unknown[]): Set<string> {
  const ids = new Set<string>()
  visit(events, (value) => {
    if (typeof value.attachmentId !== 'string' || !isImageId(value.attachmentId)) return
    ids.add(value.attachmentId)
  })
  return ids
}

/**
 * All `sha256:` ids in a session, including text placeholders left by image offload.
 * Used for remaining sessions so a conservative read never misses an id.
 */
export function referencedImageIds(events: readonly unknown[]): Set<string> {
  const ids = new Set<string>()
  const text = JSON.stringify(events)
  for (const match of text.matchAll(SHA256_REF)) ids.add(match[0])
  return ids
}

function visit(value: unknown, onRecord: (value: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) visit(item, onRecord)
    return
  }
  if (typeof value !== 'object' || value === null) return
  const record = value as Record<string, unknown>
  onRecord(record)
  for (const item of Object.values(record)) visit(item, onRecord)
}

function emptySkips(): HistorySkipCounts {
  return { active: 0, pinned: 0, archived: 0, current: 0, unchanged: 0, unreadable: 0, restored: 0 }
}

function isImageId(id: string): boolean {
  return /^sha256:[0-9a-f]{64}$/.test(id)
}

function isSessionId(id: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(id) && !id.includes('..')
}

function objectRelative(id: string): string {
  const hex = id.slice('sha256:'.length)
  return join(hex.slice(0, 2), hex)
}

function isUnder(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

async function movePath(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true })
  let last: unknown
  for (let attempt = 0; attempt < MOVE_ATTEMPTS; attempt += 1) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      last = error
      const code = (error as { code?: unknown }).code
      if (code !== 'EXDEV') {
        if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw error
        await new Promise((resolve) => setTimeout(resolve, MOVE_BACKOFF_MS))
        continue
      }
      await cp(from, to, { recursive: true, errorOnExist: true, force: false })
      await rm(from, { recursive: true, force: true })
      return
    }
  }
  throw last
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : String(error)
}

export { HistoryUnavailableError }
