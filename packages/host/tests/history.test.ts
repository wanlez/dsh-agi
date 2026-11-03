import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ProfileStore } from '../src/preferences.ts'
import {
  HistoryCleaner,
  type HistoryPersistence,
  type HistorySessionHeader,
  type HistorySessionRow,
  type HistorySessionSnapshot,
  type OsTrashManifest,
  type WorkspaceSafety,
} from '../src/history.ts'

const root = mkdtempSync(join(tmpdir(), 'orb-history-'))
after(() => { rmSync(root, { recursive: true, force: true }) })

const NOW = Date.parse('2026-10-18T00:00:00Z')
const DAY = 24 * 60 * 60 * 1000
const MARKER = '.dsh-agi-os-trash'

interface FakeSession {
  readonly id: string
  readonly cwd: string
  readonly parent?: string
  readonly origin?: string
  readonly updatedAt: number
  readonly running?: boolean
  /** Never prompted: what the old New Chat button left behind. */
  readonly blank?: boolean
  readonly preset?: string
  readonly events: readonly unknown[]
  readonly bytes: number
}

function imageId(index: number): string {
  return `sha256:${String(index.toString(16)).padStart(2, '0').repeat(32)}`
}

function imageEvent(id: string, bytes: number): unknown {
  return {
    type: 'user/message',
    data: {
      content: [{
        type: 'image',
        attachment: { attachmentId: id, mediaType: 'image/jpeg', bytes, width: 100, height: 100, name: 'desktop-screen-0' },
      }],
    },
  }
}

function fixture(): {
  cleaner: HistoryCleaner
  store: ProfileStore
  workspace: string
  sessionsRoot: string
  objectsRoot: string
  trashDir: string
  sessions: FakeSession[]
  archived: Set<string>
  pinned: Set<string>
  attached: Set<string>
  archiveFails: Set<string>
  unreadable: Set<string>
  unarchived: string[]
  trashed: string[]
  add: (session: Partial<FakeSession> & { id: string; updatedAt: number; cwd?: string; events?: readonly unknown[]; bytes?: number }) => FakeSession
  object: (id: string, bytes: number) => void
  setCurrent: (id: string | undefined) => void
  restoreRoot: (id: string) => void
  run: () => Promise<void>
  holdArchive: () => void
  holdUnarchive: () => void
  releaseHold: () => void
  archiveHeld: () => boolean
  unarchiveHeld: () => boolean
  listCalls: { count: number }
} {
  const base = mkdtempSync(join(root, 'case-'))
  const profileDir = join(base, 'profile')
  const sessionsRoot = join(base, 'sessions')
  const objectsRoot = join(base, 'objects')
  const trashDir = join(base, 'system-trash')
  mkdirSync(profileDir, { recursive: true })
  mkdirSync(sessionsRoot, { recursive: true })
  mkdirSync(objectsRoot, { recursive: true })
  mkdirSync(trashDir, { recursive: true })
  const workspace = join(base, 'orb-workspace')
  mkdirSync(workspace, { recursive: true })
  const store = new ProfileStore(profileDir)
  const sessions: FakeSession[] = []
  const dirs = new Map<string, string>()
  const archived = new Set<string>()
  const pinned = new Set<string>()
  const attached = new Set<string>()
  const archiveFails = new Set<string>()
  const unreadable = new Set<string>()
  const unarchived: string[] = []
  const trashed: string[] = []
  const listCalls = { count: 0 }
  let hold: 'archive' | 'unarchive' | undefined
  let releaseHeld: (() => void) | undefined
  const held = { archive: false, unarchive: false }
  const waitIfHeld = async (kind: 'archive' | 'unarchive'): Promise<void> => {
    if (hold !== kind) return
    held[kind] = true
    await new Promise<void>((resolve) => { releaseHeld = resolve })
  }

  const add = (session: Partial<FakeSession> & { id: string; updatedAt: number; cwd?: string; events?: readonly unknown[]; bytes?: number }): FakeSession => {
    const record: FakeSession = {
      id: session.id,
      cwd: session.cwd ?? workspace,
      ...session.parent === undefined ? {} : { parent: session.parent },
      ...session.origin === undefined ? {} : { origin: session.origin },
      updatedAt: session.updatedAt,
      ...session.running === undefined ? {} : { running: session.running },
      ...session.blank === undefined ? {} : { blank: session.blank },
      ...session.preset === undefined ? {} : { preset: session.preset },
      events: session.events ?? [],
      bytes: session.bytes ?? 1000,
    }
    sessions.push(record)
    const dir = join(sessionsRoot, `proj-${String(sessions.length)}`, record.id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), 'x')
    dirs.set(record.id, dir)
    return record
  }

  const object = (id: string, bytes: number): void => {
    const hex = id.slice('sha256:'.length)
    const dir = join(objectsRoot, hex.slice(0, 2))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, hex), Buffer.alloc(bytes))
  }

  const header = (session: FakeSession): HistorySessionHeader => ({
    id: session.id,
    cwd: session.cwd,
    ...session.parent === undefined ? {} : { parentSession: session.parent },
    ...session.origin === undefined ? {} : { origin: session.origin },
    createdAt: session.updatedAt,
  })
  const snapshot = (session: FakeSession): HistorySessionSnapshot => ({ header: header(session), sizeBytes: session.bytes })

  const persistence: HistoryPersistence = {
    async list() { return sessions.map(snapshot) },
    async stat(id) {
      const found = sessions.find((session) => session.id === id)
      return found === undefined ? undefined : snapshot(found)
    },
    async open(id) {
      if (unreadable.has(id)) throw new Error('subagent/descriptor 5 uses unsupported descriptor version 2')
      const found = sessions.find((session) => session.id === id)
      if (found === undefined) throw new Error(`missing session ${id}`)
      return {
        async read() { return { events: found.events } },
        async close() {},
      }
    },
    locate(value) {
      const dir = dirs.get(value.id)
      return dir === undefined ? undefined : { path: join(dir, 'session.v4.jsonl.zstd') }
    },
  }

  let current: string | undefined
  const rows = (): HistorySessionRow[] => {
    listCalls.count += 1
    return sessions.map((session) => ({
      sessionId: session.id,
      updatedAt: session.updatedAt,
      ...session.running === undefined ? {} : { running: session.running },
      ...session.parent === undefined ? {} : { parentSessionId: session.parent },
      ...session.origin === undefined ? {} : { origin: session.origin },
      cwd: session.cwd,
      blank: session.blank === true,
      projections: { values: { agentPreset: session.preset ?? 'computer-use' } },
    }))
  }

  const cleaner = new HistoryCleaner({
    store,
    workspacePath: () => workspace,
    currentSession: () => current,
    listSessions: async () => rows(),
    isAttached: (id) => attached.has(id),
    workspaceSafety: async (): Promise<WorkspaceSafety> => ({ pinned: [...pinned], archived: [...archived] }),
    async archive(id) {
      if (archiveFails.has(id)) throw new Error('workspace/session-active')
      await waitIfHeld('archive')
      archived.add(id)
    },
    async unarchive(id) {
      await waitIfHeld('unarchive')
      archived.delete(id)
      unarchived.push(id)
    },
    persistence: () => persistence,
    available: () => true,
    async trash(path) {
      const target = join(trashDir, basename(path))
      await rename(path, target)
      trashed.push(target)
    },
    sessionsRoot,
    objectsRoot,
    now: () => NOW,
    log: () => {},
  })

  const run = async (): Promise<void> => {
    cleaner.startClean()
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (!cleaner.state().cleaning) return
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    throw new Error('cleanup did not finish')
  }

  const restoreRoot = (id: string): void => {
    const original = dirs.get(id)
    assert.ok(original)
    renameSync(join(trashDir, basename(original)), original)
  }

  return {
    cleaner,
    store,
    workspace,
    sessionsRoot,
    objectsRoot,
    trashDir,
    sessions,
    archived,
    pinned,
    attached,
    archiveFails,
    unreadable,
    unarchived,
    trashed,
    add,
    object,
    setCurrent: (id) => { current = id },
    restoreRoot,
    run,
    holdArchive: () => { hold = 'archive' },
    holdUnarchive: () => { hold = 'unarchive' },
    releaseHold: () => {
      hold = undefined
      held.archive = false
      held.unarchive = false
      releaseHeld?.()
      releaseHeld = undefined
    },
    archiveHeld: () => held.archive,
    unarchiveHeld: () => held.unarchive,
    listCalls,
  }
}

describe('history retention', () => {
  it('defaults to forever and validates the retention range', () => {
    const { cleaner, store } = fixture()
    assert.equal(cleaner.state().retentionDays, 0)
    assert.equal(cleaner.state().lastCleanupAt, null)
    assert.throws(() => cleaner.setRetention(-1), /invalid-retention/)
    assert.throws(() => cleaner.setRetention(2), /invalid-retention/)
    assert.throws(() => cleaner.setRetention(61), /invalid-retention/)
    cleaner.setRetention(60)
    assert.equal(cleaner.state().retentionDays, 60)
    cleaner.setRetention(30)
    assert.equal(store.history().retentionDays, 30)
    assert.equal(cleaner.state().retentionDays, 30)
  })

  it('counts the last chat, not the creation time', async () => {
    const case_ = fixture()
    case_.add({ id: 'session-old-created', updatedAt: NOW - 200 * DAY })
    const active = case_.add({ id: 'session-active', updatedAt: NOW - 2 * DAY })
    const preview = await case_.cleaner.preview(30)
    assert.equal(preview.roots, 1)
    assert.equal(case_.sessions.find((session) => session.id === active.id)?.updatedAt, NOW - 2 * DAY)
    assert.ok(!preview.oldest || preview.oldest < NOW)
  })

  it('puts an old root and its subagent child into the system trash, then restores them', async () => {
    const case_ = fixture()
    const shot = imageId(1)
    case_.object(shot, 222)
    const rootSession = case_.add({ id: 'session-root', updatedAt: NOW - 40 * DAY, events: [imageEvent(shot, 222)] })
    const child = case_.add({ id: 'session-child', parent: rootSession.id, origin: 'subagent', updatedAt: NOW - 41 * DAY })
    case_.store.setHistoryRecord({ retentionDays: 30 })

    const preview = await case_.cleaner.preview(30)
    assert.equal(preview.roots, 1)
    assert.equal(preview.members, 2)
    assert.equal(preview.images, 1)
    assert.equal(preview.bytes, 222 + 1000 + 1000)
    assert.equal(preview.sessions.length, 1)
    assert.equal(preview.sessions[0]?.id, rootSession.id)

    const rootDir = join(case_.sessionsRoot, 'proj-1', rootSession.id)
    await case_.run()
    assert.equal(existsSync(rootDir), false)
    assert.equal(existsSync(join(case_.sessionsRoot, 'proj-2', child.id)), false)
    assert.equal(existsSync(join(case_.objectsRoot, shot.slice(7, 9), shot.slice(7))), false)
    assert.equal(case_.trashed.length, 1)
    assert.equal(case_.trashed[0], join(case_.trashDir, rootSession.id))
    const trashedRoot = case_.trashed[0]
    assert.ok(trashedRoot)
    assert.equal(existsSync(join(trashedRoot, MARKER, 'sessions', child.id)), true)
    assert.equal(existsSync(join(trashedRoot, MARKER, 'objects', shot.slice(7, 9), shot.slice(7))), true)
    const state = case_.cleaner.state()
    assert.equal(state.lastDeletedSessions, 2)
    assert.ok(state.lastMovedBytes > 0)
    assert.deepEqual([...case_.archived].sort(), [child.id, rootSession.id].sort())

    case_.restoreRoot(rootSession.id)
    await case_.cleaner.restoreStaged()
    assert.equal(existsSync(rootDir), true)
    assert.equal(existsSync(join(case_.sessionsRoot, 'proj-2', child.id)), true)
    assert.equal(existsSync(join(case_.objectsRoot, shot.slice(7, 9), shot.slice(7))), true)
    assert.equal(existsSync(join(rootDir, MARKER)), false)
    assert.equal(case_.archived.size, 0)
    assert.deepEqual([...case_.store.history().restoredSessionIds].sort(), [child.id, rootSession.id].sort())
    assert.equal((await case_.cleaner.preview(30)).roots, 0)
  })

  it('keeps a whole tree when one subagent is recent', async () => {
    const case_ = fixture()
    const rootSession = case_.add({ id: 'session-root', updatedAt: NOW - 40 * DAY })
    case_.add({ id: 'session-child', parent: rootSession.id, origin: 'subagent', updatedAt: NOW - 2 * DAY })
    case_.store.setHistoryRecord({ retentionDays: 30 })
    const preview = await case_.cleaner.preview(30)
    assert.equal(preview.roots, 0)
    assert.equal(preview.members, 0)
    await case_.run()
    assert.equal(existsSync(join(case_.sessionsRoot, 'proj-1', rootSession.id)), true)
    assert.equal(case_.trashed.length, 0)
  })

  it('skips attached, running, pinned, archived, current, and other-workspace sessions', async () => {
    const case_ = fixture()
    case_.add({ id: 'session-running', updatedAt: NOW - 40 * DAY, running: true })
    const pinned = case_.add({ id: 'session-pinned', updatedAt: NOW - 40 * DAY })
    case_.pinned.add(pinned.id)
    const archived = case_.add({ id: 'session-archived', updatedAt: NOW - 40 * DAY })
    case_.archived.add(archived.id)
    const attached = case_.add({ id: 'session-attached', updatedAt: NOW - 40 * DAY })
    case_.attached.add(attached.id)
    const current = case_.add({ id: 'session-current', updatedAt: NOW - 40 * DAY })
    case_.setCurrent(current.id)
    case_.add({ id: 'session-elsewhere', cwd: join(case_.workspace, '..', 'other'), updatedAt: NOW - 40 * DAY })
    case_.store.setHistoryRecord({ retentionDays: 30 })
    const preview = await case_.cleaner.preview(30)
    assert.equal(preview.roots, 0)
    assert.equal(preview.skipped.active, 2)
    assert.equal(preview.skipped.pinned, 1)
    assert.equal(preview.skipped.archived, 1)
    assert.equal(preview.skipped.current, 1)
  })

  it('moves only images no remaining conversation references', async () => {
    const case_ = fixture()
    const shared = imageId(1)
    const exclusive = imageId(2)
    case_.object(shared, 111)
    case_.object(exclusive, 222)
    case_.add({ id: 'session-old', updatedAt: NOW - 40 * DAY, events: [imageEvent(shared, 111), imageEvent(exclusive, 222)] })
    case_.add({ id: 'session-kept', updatedAt: NOW - 1 * DAY, events: [imageEvent(shared, 111)] })
    case_.store.setHistoryRecord({ retentionDays: 30 })
    await case_.run()
    assert.equal(existsSync(join(case_.objectsRoot, shared.slice(7, 9), shared.slice(7))), true)
    assert.equal(existsSync(join(case_.objectsRoot, exclusive.slice(7, 9), exclusive.slice(7))), false)
  })

  it('leaves an image shared by two deleted trees in place', async () => {
    const case_ = fixture()
    const shared = imageId(1)
    case_.object(shared, 111)
    case_.add({ id: 'session-a', updatedAt: NOW - 40 * DAY, events: [imageEvent(shared, 111)] })
    case_.add({ id: 'session-b', updatedAt: NOW - 41 * DAY, events: [imageEvent(shared, 111)] })
    case_.store.setHistoryRecord({ retentionDays: 30 })
    await case_.run()
    assert.equal(existsSync(join(case_.objectsRoot, shared.slice(7, 9), shared.slice(7))), true)
    assert.equal(case_.trashed.length, 2)
  })

  it('keeps a tree in place when archiving is refused, and unarchives a partial tree', async () => {
    const case_ = fixture()
    const refused = case_.add({ id: 'session-refused', updatedAt: NOW - 40 * DAY })
    case_.archiveFails.add(refused.id)
    case_.store.setHistoryRecord({ retentionDays: 30 })
    await case_.run()
    assert.equal(existsSync(join(case_.sessionsRoot, 'proj-1', refused.id)), true)
    assert.equal(case_.trashed.length, 0)
    assert.equal(existsSync(join(case_.sessionsRoot, 'proj-1', refused.id, MARKER)), false)

    const second = fixture()
    const parent = second.add({ id: 'session-parent', updatedAt: NOW - 40 * DAY })
    const child = second.add({ id: 'session-child', parent: parent.id, origin: 'subagent', updatedAt: NOW - 41 * DAY })
    second.archiveFails.add(child.id)
    second.store.setHistoryRecord({ retentionDays: 30 })
    await second.run()
    assert.equal(existsSync(join(second.sessionsRoot, 'proj-1', parent.id)), true)
    assert.equal(second.archived.size, 0)
    assert.deepEqual(second.unarchived, [parent.id])
    assert.equal(second.trashed.length, 0)
  })

  it('restores packed files and unarchives when the OS trash returns a folder', async () => {
    const case_ = fixture()
    const shot = imageId(1)
    case_.object(shot, 222)
    const session = case_.add({ id: 'session-restore', updatedAt: NOW - 40 * DAY, events: [imageEvent(shot, 222)] })
    case_.store.setHistoryRecord({ retentionDays: 30 })
    await case_.run()
    const rootDir = join(case_.sessionsRoot, 'proj-1', session.id)
    assert.equal(existsSync(rootDir), false)
    assert.equal(case_.archived.has(session.id), true)
    case_.restoreRoot(session.id)
    await case_.cleaner.restoreStaged()
    assert.equal(existsSync(rootDir), true)
    assert.equal(existsSync(join(case_.sessionsRoot, 'proj-1', session.id, MARKER)), false)
    assert.equal(existsSync(join(case_.objectsRoot, shot.slice(7, 9), shot.slice(7))), true)
    assert.equal(case_.archived.has(session.id), false)
  })

  it('recovers a half-packed root left in the sessions tree', async () => {
    const case_ = fixture()
    const shot = imageId(1)
    case_.object(shot, 222)
    const session = case_.add({ id: 'session-interrupted', updatedAt: NOW - 40 * DAY, events: [imageEvent(shot, 222)] })
    const rootDir = join(case_.sessionsRoot, 'proj-1', session.id)
    const marker = join(rootDir, MARKER)
    mkdirSync(join(marker, 'sessions'), { recursive: true })
    mkdirSync(join(marker, 'objects'), { recursive: true })
    const manifest: OsTrashManifest = {
      version: 1,
      rootId: session.id,
      createdAt: NOW - DAY,
      workspace: case_.workspace,
      sessions: [{ id: session.id, dir: rootDir }],
      images: [{ id: shot }],
      archived: [session.id],
    }
    writeFileSync(join(marker, 'manifest.json'), `${JSON.stringify(manifest)}\n`)
    const hex = shot.slice('sha256:'.length)
    mkdirSync(join(marker, 'objects', hex.slice(0, 2)), { recursive: true })
    writeFileSync(join(marker, 'objects', hex.slice(0, 2), hex), 'x')
    rmSync(join(case_.objectsRoot, hex.slice(0, 2), hex), { force: true })
    case_.archived.add(session.id)
    await case_.cleaner.restoreStaged()
    assert.equal(existsSync(join(case_.objectsRoot, hex.slice(0, 2), hex)), true)
    assert.equal(existsSync(marker), false)
    assert.equal(case_.archived.has(session.id), false)
    assert.deepEqual(case_.store.history().restoredSessionIds, [])
  })

  it('rolls back when the OS trash refuses the folder', async () => {
    const case_ = fixture()
    const shot = imageId(1)
    case_.object(shot, 222)
    const rootSession = case_.add({ id: 'session-trash-fails', updatedAt: NOW - 40 * DAY, events: [imageEvent(shot, 222)] })
    const child = case_.add({ id: 'session-child', parent: rootSession.id, origin: 'subagent', updatedAt: NOW - 41 * DAY })
    case_.store.setHistoryRecord({ retentionDays: 30 })
    // Replace the fake OS trash with one that refuses.
    const failing = new HistoryCleaner({
      store: case_.store,
      workspacePath: () => case_.workspace,
      currentSession: () => undefined,
      listSessions: async () => case_.sessions.map((session) => ({
        sessionId: session.id,
        updatedAt: session.updatedAt,
        ...session.parent === undefined ? {} : { parentSessionId: session.parent },
        ...session.origin === undefined ? {} : { origin: session.origin },
        cwd: session.cwd,
        projections: { values: { agentPreset: session.preset ?? 'computer-use' } },
      })),
      isAttached: () => false,
      workspaceSafety: async () => ({ pinned: [], archived: [...case_.archived] }),
      archive: async (id) => { case_.archived.add(id) },
      unarchive: async (id) => { case_.archived.delete(id) },
      persistence: () => ({
        async list() { return case_.sessions.map((session) => ({ header: { id: session.id, cwd: session.cwd, parentSession: session.parent, origin: session.origin }, sizeBytes: session.bytes })) },
        async stat(id) { const found = case_.sessions.find((session) => session.id === id); return found === undefined ? undefined : { header: { id: found.id, cwd: found.cwd, parentSession: found.parent, origin: found.origin }, sizeBytes: found.bytes } },
        async open(id) { const found = case_.sessions.find((session) => session.id === id); if (found === undefined) throw new Error('missing'); return { async read() { return { events: found.events } }, async close() {} } },
        locate(value) { const dir = join(case_.sessionsRoot, `proj-${String(case_.sessions.findIndex((session) => session.id === value.id) + 1)}`, value.id); return { path: join(dir, 'session.v4.jsonl.zstd') } },
      }),
      available: () => true,
      trash: async () => { throw new Error('system trash refused') },
      sessionsRoot: case_.sessionsRoot,
      objectsRoot: case_.objectsRoot,
      now: () => NOW,
      log: () => {},
    })
    failing.startClean()
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (!failing.state().cleaning) break
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.equal(existsSync(join(case_.sessionsRoot, 'proj-1', rootSession.id)), true)
    assert.equal(existsSync(join(case_.sessionsRoot, 'proj-2', child.id)), true)
    assert.equal(existsSync(join(case_.objectsRoot, shot.slice(7, 9), shot.slice(7))), true)
    assert.equal(existsSync(join(case_.sessionsRoot, 'proj-1', rootSession.id, MARKER)), false)
    assert.equal(case_.archived.size, 0)
    assert.ok(failing.state().error)
  })

  it('ignores an unreadable legacy session outside the orb workspace', async () => {
    const case_ = fixture()
    const shot = imageId(1)
    case_.object(shot, 222)
    const rootSession = case_.add({ id: 'session-orb-old', updatedAt: NOW - 40 * DAY, events: [imageEvent(shot, 222)] })
    const legacy = case_.add({
      id: 'session-legacy',
      cwd: join(case_.workspace, '..', 'legacy-project'),
      updatedAt: NOW - DAY,
    })
    case_.unreadable.add(legacy.id)
    case_.store.setHistoryRecord({ retentionDays: 30 })
    await case_.run()
    assert.equal(existsSync(join(case_.sessionsRoot, 'proj-1', rootSession.id)), false)
    assert.equal(existsSync(join(case_.objectsRoot, shot.slice(7, 9), shot.slice(7))), false)
    assert.equal(case_.cleaner.state().warning, '')
    assert.equal(case_.trashed.length, 1)
  })

  it('cleans session folders but keeps images when an orb session cannot be read', async () => {
    const case_ = fixture()
    const shot = imageId(1)
    case_.object(shot, 222)
    const rootSession = case_.add({ id: 'session-orb-old', updatedAt: NOW - 40 * DAY, events: [imageEvent(shot, 222)] })
    const unreadable = case_.add({ id: 'session-orb-unreadable', updatedAt: NOW - DAY })
    case_.unreadable.add(unreadable.id)
    case_.store.setHistoryRecord({ retentionDays: 30 })
    await case_.run()
    assert.equal(existsSync(join(case_.sessionsRoot, 'proj-1', rootSession.id)), false)
    assert.equal(existsSync(join(case_.objectsRoot, shot.slice(7, 9), shot.slice(7))), true)
    assert.equal(case_.cleaner.state().warning, 'images-kept')
    assert.equal(case_.cleaner.state().warningSessions, 1)
    assert.equal(case_.trashed.length, 1)
  })

  it('leaves a session directory untouched when cleanup is off', async () => {
    const case_ = fixture()
    const session = case_.add({ id: 'session-forever', updatedAt: NOW - 400 * DAY })
    await case_.run()
    assert.equal(existsSync(join(case_.sessionsRoot, 'proj-1', session.id)), true)
    assert.equal(case_.trashed.length, 0)
  })

  it('runs a cleanup that was requested while a restore scan held the lock', async () => {
    const case_ = fixture()
    const old = case_.add({ id: 'session-old', updatedAt: NOW - 40 * DAY })
    const parked = case_.add({ id: 'session-parked', updatedAt: NOW - DAY })
    const parkedDir = join(case_.sessionsRoot, 'proj-2', parked.id)
    const marker = join(parkedDir, MARKER)
    mkdirSync(join(marker, 'sessions'), { recursive: true })
    mkdirSync(join(marker, 'objects'), { recursive: true })
    const manifest: OsTrashManifest = {
      version: 1,
      rootId: parked.id,
      createdAt: NOW - DAY,
      workspace: case_.workspace,
      sessions: [{ id: parked.id, dir: parkedDir }],
      images: [],
      archived: [parked.id],
    }
    writeFileSync(join(marker, 'manifest.json'), `${JSON.stringify(manifest)}\n`)
    case_.archived.add(parked.id)
    case_.holdUnarchive()
    const restoring = case_.cleaner.restoreStaged()
    await waitFor(() => case_.unarchiveHeld())
    assert.equal(case_.cleaner.state().phase, 'restoring')
    case_.cleaner.setRetention(30)
    case_.cleaner.startClean()
    assert.equal(case_.cleaner.state().phase, 'restoring')
    assert.equal(existsSync(join(case_.sessionsRoot, 'proj-1', old.id)), true)
    assert.equal(case_.trashed.length, 0)
    case_.releaseHold()
    await restoring
    await waitFor(() => !case_.cleaner.state().cleaning)
    assert.equal(existsSync(join(case_.sessionsRoot, 'proj-1', old.id)), false)
    assert.deepEqual(case_.trashed, [join(case_.trashDir, old.id)])
    assert.equal(existsSync(parkedDir), true)
    assert.equal(existsSync(marker), false)
    assert.equal(case_.cleaner.state().lastDeletedSessions, 1)
    assert.equal(case_.cleaner.state().error, null)
  })

  it('sweeps empty conversations into the trash and spares anything in use', async () => {
    const case_ = fixture()
    const junk = case_.add({ id: 'blank-junk', updatedAt: NOW - 3 * DAY, blank: true })
    const older = case_.add({ id: 'blank-older', updatedAt: NOW - 9 * DAY, blank: true })
    // A conversation with a turn is not blank: the list says so, and it stays.
    const talked = case_.add({ id: 'talked', updatedAt: NOW - 3 * DAY })
    // Anything a window may be typing into is spared: fresh, attached, current, pinned, archived.
    case_.add({ id: 'blank-fresh', updatedAt: NOW - 1000, blank: true })
    case_.add({ id: 'blank-attached', updatedAt: NOW - 3 * DAY, blank: true })
    case_.attached.add('blank-attached')
    case_.add({ id: 'blank-pinned', updatedAt: NOW - 3 * DAY, blank: true })
    case_.pinned.add('blank-pinned')
    case_.add({ id: 'blank-archived', updatedAt: NOW - 3 * DAY, blank: true })
    case_.archived.add('blank-archived')
    case_.add({ id: 'blank-current', updatedAt: NOW - 3 * DAY, blank: true })
    case_.setCurrent('blank-current')
    // A standard-preset conversation in the same directory is not the ball's to remove.
    case_.add({ id: 'standard-blank', updatedAt: NOW - 3 * DAY, blank: true, preset: 'standard' })

    const swept = await case_.cleaner.sweepBlanks()
    assert.equal(swept, 2, 'the two stale empties are gone, and nothing else')
    assert.deepEqual(case_.trashed.map((path) => basename(path)).sort(), ['blank-junk', 'blank-older'])
    assert.equal(existsSync(join(case_.sessionsRoot, 'proj-1', junk.id)), false)
    assert.equal(existsSync(join(case_.sessionsRoot, 'proj-2', older.id)), false)
    assert.equal(existsSync(join(case_.sessionsRoot, 'proj-3', talked.id)), true, 'a conversation with a turn stays')
    assert.equal(case_.archived.has('blank-junk'), true, 'a swept conversation is archived on the way out')
    assert.equal(case_.cleaner.state().phase, '', 'the sweep does not leave the card showing a cleanup phase')
    // A second pass finds nothing left to do.
    assert.equal(await case_.cleaner.sweepBlanks(), 0)
  })

  it('runs a follow-up cleanup when retention changes during an in-flight cleanup', async () => {
    const case_ = fixture()
    const recent = case_.add({ id: 'session-recent', updatedAt: NOW - 10 * DAY })
    const old = case_.add({ id: 'session-old', updatedAt: NOW - 40 * DAY })
    case_.cleaner.setRetention(30)
    case_.holdArchive()
    case_.cleaner.startClean()
    await waitFor(() => case_.archiveHeld())
    assert.equal(case_.listCalls.count, 1)
    case_.cleaner.setRetention(7)
    case_.cleaner.startClean()
    assert.equal(existsSync(join(case_.sessionsRoot, 'proj-1', recent.id)), true)
    assert.equal(case_.trashed.length, 0)
    case_.releaseHold()
    await waitFor(() => !case_.cleaner.state().cleaning)
    assert.equal(existsSync(join(case_.sessionsRoot, 'proj-2', old.id)), false)
    assert.equal(existsSync(join(case_.sessionsRoot, 'proj-1', recent.id)), false)
    assert.equal(case_.trashed.length, 2)
    assert.equal(case_.listCalls.count, 2)
    assert.equal(case_.cleaner.state().error, null)
  })
})

async function waitFor(ready: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (ready()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('timed out')
}
