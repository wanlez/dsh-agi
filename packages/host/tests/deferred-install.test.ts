import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFERRED_INSTALL_CEILING_MS,
  DEFERRED_INSTALL_PENDING_MS,
  deferredDir,
  deferredInstallInProgress,
  mergeApprovedBuilds,
  pendingDeferredInstall,
  scheduleInstallAfterExit,
  takeDeferredOutcome,
  type DeferredInstall,
} from '../src/deferred-install.ts'

const root = mkdtempSync(join(tmpdir(), 'orb-deferred-'))
after(() => { rmSync(root, { recursive: true, force: true }) })

let counter = 0
function profile(): string {
  counter += 1
  const dir = join(root, `profile-${counter}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function statusFile(dir: string, spec: string, pid: number, startedAt: number): void {
  mkdirSync(deferredDir(dir), { recursive: true })
  writeFileSync(join(deferredDir(dir), 'status.json'), JSON.stringify({ phase: 'installing', spec, pid, startedAt }))
}

/** A pid that is certainly gone: spawnSync waited for it to exit. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' })
  assert.equal(child.status, 0)
  return child.pid
}

describe('release-age exemption and build approvals share the workspace file', () => {
  it('adds a top-level allowBuilds mapping, keeping the release-age key', () => {
    const before = 'packages:\n  - .\nminimumReleaseAgeExclude:\n  - dsh-agi\n'
    assert.equal(
      mergeApprovedBuilds(before, ['koffi']),
      'packages:\n  - .\nminimumReleaseAgeExclude:\n  - dsh-agi\nallowBuilds:\n  koffi: true\n',
    )
  })

  it('creates the file for a profile that has none, and extends an existing mapping', () => {
    assert.equal(mergeApprovedBuilds('', ['koffi']), 'allowBuilds:\n  koffi: true\n')
    assert.equal(
      mergeApprovedBuilds('allowBuilds:\n  zod: true\n', ['koffi']),
      'allowBuilds:\n  zod: true\n  koffi: true\n',
    )
    // Already approved: nothing to write.
    assert.equal(mergeApprovedBuilds('allowBuilds:\n  koffi: true\n', ['koffi']), undefined)
  })

  it('re-approves a build the profile had refused, and quotes a scoped name', () => {
    assert.equal(
      mergeApprovedBuilds('allowBuilds:\n  koffi: false\n  zod: true\n', ['koffi']),
      'allowBuilds:\n  koffi: true\n  zod: true\n',
    )
    assert.equal(mergeApprovedBuilds('', ['@scope/native']), "allowBuilds:\n  '@scope/native': true\n")
    assert.equal(mergeApprovedBuilds("allowBuilds:\n  '@scope/native': true\n", ['@scope/native']), undefined)
    // A commented entry is read as present rather than duplicated.
    assert.equal(mergeApprovedBuilds('allowBuilds:\n  koffi: true # keep\n', ['koffi']), undefined)
  })

  it('writes nothing for an empty approval list and leaves unfamiliar shapes alone', () => {
    assert.equal(mergeApprovedBuilds('packages:\n  - .\n', []), undefined)
    // A flow mapping is not pnpm's own output.
    assert.equal(mergeApprovedBuilds('allowBuilds: {}\n', ['koffi']), undefined)
    // A key an older version wrote is left where it is; the real one is added beside it.
    assert.equal(
      mergeApprovedBuilds('onlyBuiltDependencies:\n  - koffi\n', ['koffi']),
      'onlyBuiltDependencies:\n  - koffi\nallowBuilds:\n  koffi: true\n',
    )
  })
})

describe('the after-exit script', () => {
  it('marks the install as running before pnpm starts, and swaps that for the outcome', async () => {
    const dir = profile()
    const bin = join(root, 'bin')
    mkdirSync(bin, { recursive: true })
    // Stands in for pnpm: records whether the status file was already in place.
    const fake = join(bin, 'pnpm')
    writeFileSync(fake, '#!/bin/sh\n'
      + 'if [ -f .dsh-agi-update/status.json ]; then echo present > .dsh-agi-update/pnpm-saw-status.txt; '
      + 'else echo absent > .dsh-agi-update/pnpm-saw-status.txt; fi\n'
      + 'exit 0\n')
    chmodSync(fake, 0o755)
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - .\nminimumReleaseAgeExclude:\n  - dsh-agi\n')
    const previousPath = process.env.PATH
    process.env.PATH = `${bin}:${previousPath ?? ''}`
    const job: DeferredInstall = {
      profileDir: dir,
      spec: 'dsh-agi@0.2.0',
      registry: 'https://registry.npmmirror.com',
      parentPid: deadPid(),
      approvedBuilds: ['koffi'],
    }
    try {
      scheduleInstallAfterExit(job)
      const result = join(deferredDir(dir), 'result.json')
      const deadline = Date.now() + 30_000
      while (!existsSync(result) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
      assert.ok(existsSync(result), 'the script writes its outcome')
      assert.deepEqual(JSON.parse(readFileSync(result, 'utf8')), { spec: 'dsh-agi@0.2.0', ok: true, detail: '' })
      assert.equal(existsSync(join(deferredDir(dir), 'status.json')), false, 'the status goes away with the outcome')
      assert.equal(existsSync(join(deferredDir(dir), 'job.json')), false, 'the job goes away with the outcome')
      assert.equal(
        readFileSync(join(deferredDir(dir), 'pnpm-saw-status.txt'), 'utf8').trim(),
        'present',
        'pnpm only ever runs while the install is marked as running',
      )
      assert.equal(
        readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8'),
        'packages:\n  - .\nminimumReleaseAgeExclude:\n  - dsh-agi\nallowBuilds:\n  koffi: true\n',
      )
      const outcome = takeDeferredOutcome(dir)
      assert.equal(outcome?.ok, true)
      assert.equal(deferredInstallInProgress(dir), false, 'a finished install never gates the next start')
    } finally {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
    }
  })
})

describe('install-in-progress detection', () => {
  it('is true while the script runs and false once its outcome lands', () => {
    const dir = profile()
    assert.equal(deferredInstallInProgress(dir), false, 'nothing scheduled')
    statusFile(dir, 'dsh-agi@0.2.0', process.pid, Date.now())
    assert.equal(deferredInstallInProgress(dir), true)
    writeFileSync(join(deferredDir(dir), 'result.json'), JSON.stringify({ spec: 'dsh-agi@0.2.0', ok: true, detail: '' }))
    assert.equal(deferredInstallInProgress(dir), false)
  })

  it('keeps trusting a young status whose script is gone, and collects an old one as failed', () => {
    const dir = profile()
    statusFile(dir, 'dsh-agi@0.2.0', deadPid(), Date.now())
    assert.equal(deferredInstallInProgress(dir), true, 'a fresh status is trusted while the script may still fork')

    const stale = profile()
    const old = join(deferredDir(stale), 'status.json')
    statusFile(stale, 'dsh-agi@0.3.0', deadPid(), Date.now() - DEFERRED_INSTALL_CEILING_MS - 1000)
    const past = new Date(Date.now() - DEFERRED_INSTALL_CEILING_MS - 1000)
    utimesSync(old, past, past)
    assert.equal(deferredInstallInProgress(stale), false, 'past its own ceiling the leftover is collected')
    assert.equal(existsSync(old), false)
    assert.deepEqual(takeDeferredOutcome(stale), {
      spec: 'dsh-agi@0.3.0',
      ok: false,
      detail: 'deferred-install-stalled',
    })
  })

  it('covers the seconds before the status file, while the job owner is gone', () => {
    const dir = profile()
    const jobFile = join(deferredDir(dir), 'job.json')
    mkdirSync(deferredDir(dir), { recursive: true })
    writeFileSync(jobFile, JSON.stringify({ profileDir: dir, spec: 'dsh-agi@0.2.0', registry: 'x', parentPid: deadPid(), approvedBuilds: [] }))
    assert.equal(deferredInstallInProgress(dir), true, 'pnpm is about to run: the ball waits')

    // The heartbeat stopped long ago: the script died before pnpm ran, so nothing is being replaced.
    const past = new Date(Date.now() - DEFERRED_INSTALL_PENDING_MS - 1000)
    utimesSync(jobFile, past, past)
    assert.equal(deferredInstallInProgress(dir), false)
  })

  it('does not gate an install whose owner is still running', () => {
    const dir = profile()
    mkdirSync(deferredDir(dir), { recursive: true })
    writeFileSync(join(deferredDir(dir), 'job.json'), JSON.stringify({ parentPid: process.pid }))
    assert.equal(deferredInstallInProgress(dir), false, 'the package is untouched until that exit')
  })

  it('reports the queued job back to an instance that did not schedule it', () => {
    const dir = profile()
    const folder = deferredDir(dir)
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'job.json'), JSON.stringify({
      profileDir: dir,
      spec: 'dsh-agi@0.2.0',
      version: '0.2.0',
      registry: 'x',
      parentPid: process.pid,
      approvedBuilds: [],
    }))
    assert.deepEqual(pendingDeferredInstall(dir), { spec: 'dsh-agi@0.2.0', version: '0.2.0' })
  })

  it('reads the version off an older job that did not carry one', () => {
    const dir = profile()
    const folder = deferredDir(dir)
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'job.json'), JSON.stringify({
      profileDir: dir,
      spec: 'dsh-agi@0.2.0',
      registry: 'x',
      parentPid: process.pid,
      approvedBuilds: [],
    }))
    assert.deepEqual(pendingDeferredInstall(dir), { spec: 'dsh-agi@0.2.0', version: '0.2.0' })
  })

  it('drops a queued job once its outcome lands', () => {
    const dir = profile()
    const folder = deferredDir(dir)
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'job.json'), JSON.stringify({ profileDir: dir, spec: 'dsh-agi@0.2.0', registry: 'x', parentPid: process.pid, approvedBuilds: [] }))
    writeFileSync(join(folder, 'result.json'), JSON.stringify({ spec: 'dsh-agi@0.2.0', ok: true, detail: '' }))
    assert.equal(pendingDeferredInstall(dir), undefined)
  })

  it('drops a job whose script stopped touching it before pnpm started', () => {
    const dir = profile()
    const folder = deferredDir(dir)
    mkdirSync(folder, { recursive: true })
    const jobFile = join(folder, 'job.json')
    writeFileSync(jobFile, JSON.stringify({ profileDir: dir, spec: 'dsh-agi@0.2.0', registry: 'x', parentPid: deadPid(), approvedBuilds: [] }))
    const past = new Date(Date.now() - DEFERRED_INSTALL_PENDING_MS - 1000)
    utimesSync(jobFile, past, past)
    assert.equal(pendingDeferredInstall(dir), undefined)
  })

  it('does not call a running script deferred: that state is installing', () => {
    const dir = profile()
    statusFile(dir, 'dsh-agi@0.2.0', process.pid, Date.now())
    assert.equal(pendingDeferredInstall(dir), undefined)
    assert.equal(deferredInstallInProgress(dir), true)
  })

  it('reports a finished install as finished even when its job file lingers', () => {
    const dir = profile()
    const folder = deferredDir(dir)
    mkdirSync(folder, { recursive: true })
    // What a Windows lock on job.json leaves behind: the outcome is on disk, the status file is
    // gone, and the job file is still fresh enough to read as a scheduled install.
    writeFileSync(join(folder, 'job.json'), JSON.stringify({ parentPid: deadPid(), spec: 'dsh-agi@0.2.0' }))
    writeFileSync(join(folder, 'result.json'), JSON.stringify({ spec: 'dsh-agi@0.2.0', ok: true, detail: '' }))
    assert.equal(deferredInstallInProgress(dir), false, 'an outcome on disk means the install is over')
    assert.deepEqual(takeDeferredOutcome(dir), { spec: 'dsh-agi@0.2.0', ok: true, detail: '' })
  })
})
