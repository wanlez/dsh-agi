import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { deferredDir, type DeferredInstall } from '../src/deferred-install.ts'
import { ProfileStore } from '../src/preferences.ts'
import { AUTO_CHECK_INTERVAL_MS, compareVersions, exemptReleaseAge, installRegistry, installSpec, ownPackage, registryTarballUrl, releaseTarballUrl, renameWithRetry, UpdateChecker, versionFromRegistry, versionFromRelease, withReleaseAgeExclusion } from '../src/update.ts'

const here = fileURLToPath(new URL('.', import.meta.url))

const root = mkdtempSync(join(tmpdir(), 'orb-update-'))
after(() => { rmSync(root, { recursive: true, force: true }) })

let counter = 0
function store(): ProfileStore {
  counter += 1
  const path = join(root, `profile-${counter}`)
  mkdirSync(path, { recursive: true })
  return new ProfileStore(path)
}

/** A manager that records the spec it was handed and answers with a scripted result. */
function manager(
  result: Record<string, unknown> = { application: 'restart-required' },
  script: {
    /** Results for successive `installBundle` calls. Later calls use `result`. */
    installs?: Record<string, unknown>[]
    /** Present when this manager can remove a bundle. The value is what the call returns. */
    remove?: Record<string, unknown>
    /** Present when this manager can select a bundle again. */
    reenable?: Record<string, unknown>
    /** Index of the `installBundle` call that rejects instead of returning a result. */
    installThrowsAt?: number
    /** Index of the `removeBundle` call that rejects instead of returning a result. */
    removeThrows?: boolean
  } = {},
) {
  const specs: string[] = []
  const registries: Array<string | undefined> = []
  const enabled: Array<boolean | undefined> = []
  const removed: string[] = []
  const reenabled: string[] = []
  const trace: string[] = []
  let cursor = 0
  return {
    specs,
    registries,
    enabled,
    removed,
    reenabled,
    trace,
    service: {
      async installBundle(spec: string, options?: { registry?: string; enabled?: boolean }) {
        specs.push(spec)
        registries.push(options?.registry)
        enabled.push(options?.enabled)
        const index = cursor
        cursor += 1
        if (index === script.installThrowsAt) throw new Error('install request rejected')
        return script.installs?.[index] ?? result
      },
      ...script.remove === undefined ? {} : {
        async removeBundle(name: string) {
          trace.push('remove')
          removed.push(name)
          if (script.removeThrows === true) throw new Error('removal request rejected')
          return script.remove
        },
      },
      ...script.reenable === undefined ? {} : {
        async setBundleEnabled(name: string) {
          trace.push('enable')
          reenabled.push(name)
          return script.reenable
        },
      },
    },
  }
}

function checker(options: {
  store: ProfileStore
  own?: { name: string; version: string } | undefined
  latest?: string | undefined
  result?: Record<string, unknown>
  installs?: Record<string, unknown>[]
  remove?: Record<string, unknown>
  reenable?: Record<string, unknown>
  notify?: (version: string) => void
  mapped?: string[]
}) {
  const fake = manager(options.result, {
    installs: options.installs,
    remove: options.remove,
    reenable: options.reenable,
    installThrowsAt: options.installThrowsAt,
    removeThrows: options.removeThrows,
  })
  const announced: string[] = []
  const deferred: DeferredInstall[] = []
  const update = new UpdateChecker({
    store: options.store,
    manager: () => fake.service,
    notify: (version) => { announced.push(version); options.notify?.(version) },
    fetchLatest: async () => options.latest,
    own: 'own' in options ? options.own : { name: 'dsh-agi', version: '0.1.0' },
    mappedImages: () => options.mapped ?? [],
    deferInstall: (job) => {
      fake.trace.push('defer')
      deferred.push(job)
      // The real scheduler writes this file; a reloaded instance reads it back.
      mkdirSync(deferredDir(options.store.dir), { recursive: true })
      writeFileSync(join(deferredDir(options.store.dir), 'job.json'), JSON.stringify(job))
    },
  })
  return {
    update,
    announced,
    specs: fake.specs,
    registries: fake.registries,
    enabled: fake.enabled,
    removed: fake.removed,
    reenabled: fake.reenabled,
    trace: fake.trace,
    deferred,
  }
}

/** A local http mock answering `routes[path]` with `[status, body]`; other paths hang up. */
async function mockServer(routes: Record<string, [number, string]>): Promise<{ base: string; close(): void }> {
  const server = createServer((request, response) => {
    const hit = routes[request.url ?? '']
    if (hit === undefined) { response.destroy(); return }
    response.writeHead(hit[0], { 'content-type': 'application/json' })
    response.end(hit[1])
  })
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => { server.close() } }
}

/** Sets env vars for the duration of `run`, restoring or clearing them after. */
async function withEnv(values: Record<string, string>, run: () => Promise<void>): Promise<void> {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]))
  for (const [key, value] of Object.entries(values)) process.env[key] = value
  try {
    await run()
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

/** Nothing listens here, so curl fails fast: a source that is down. */
const DEAD_SOURCE = 'http://127.0.0.1:1'

describe('update versions', () => {
  it('orders releases, patches, and prereleases', () => {
    assert.equal(compareVersions('0.2.0', '0.1.0'), 1)
    assert.equal(compareVersions('0.1.0', '0.2.0'), -1)
    assert.equal(compareVersions('v0.1.0', '0.1.0'), 0)
    assert.equal(compareVersions('0.1.10', '0.1.9'), 1, 'numeric, not lexicographic')
    assert.equal(compareVersions('1.0', '1.0.0'), 0, 'a missing segment counts as zero')
    assert.equal(compareVersions('0.2.0-rc.2', '0.2.0'), -1, 'a prerelease precedes its release')
    assert.equal(compareVersions('0.2.0-rc.10', '0.2.0-rc.9'), 1)
    assert.equal(compareVersions('0.2.0-beta', '0.2.0-rc'), -1)
  })

  it('reads the installed manifest and refuses to guess one', () => {
    assert.deepEqual(ownPackage(), undefined, 'running from packages/host/lib finds no manifest')
  })

  it('derives the release tag and tarball address from a version', () => {
    assert.equal(versionFromRelease('{"tag_name":"plugin-v0.2.0"}'), '0.2.0')
    assert.equal(versionFromRelease('{"tag_name":"plugin-v0.2.0-rc.1"}'), '0.2.0-rc.1')
    assert.equal(versionFromRelease('{"name":"unrelated"}'), undefined)
    assert.equal(versionFromRelease('not json'), undefined)
    assert.equal(
      releaseTarballUrl('0.2.0'),
      'https://github.com/mini-yifan/dsh-orb-cordis/releases/download/plugin-v0.2.0/dsh-agi-0.2.0.tgz',
    )
    process.env.DSH_AGI_UPDATE_URL = 'http://127.0.0.1:9/downloads/dsh-agi-0.2.0.tgz'
    assert.equal(releaseTarballUrl('0.2.0'), 'http://127.0.0.1:9/downloads/dsh-agi-0.2.0.tgz')
    delete process.env.DSH_AGI_UPDATE_URL
  })
})

describe('release-age exemption', () => {
  it('replaces a versioned rule with the bare name, written first', () => {
    const before = 'packages:\n  - .\n\nnodeLinker: hoisted\nminimumReleaseAgeExclude:\n  - dsh-agi@0.1.0\n'
    assert.equal(
      withReleaseAgeExclusion(before, 'dsh-agi'),
      'packages:\n  - .\n\nnodeLinker: hoisted\nminimumReleaseAgeExclude:\n  - dsh-agi\n',
    )
  })

  it('adds the key when the file has none', () => {
    assert.equal(
      withReleaseAgeExclusion('packages:\n  - .\n', 'dsh-agi'),
      'packages:\n  - .\nminimumReleaseAgeExclude:\n  - dsh-agi\n',
    )
  })

  it('keeps quiet when the package is already exempt by name', () => {
    assert.equal(withReleaseAgeExclusion('minimumReleaseAgeExclude:\n  - dsh-agi\n', 'dsh-agi'), undefined)
    assert.equal(withReleaseAgeExclusion('minimumReleaseAgeExclude:\n  - dsh-agi\n  - other\n', 'dsh-agi'), undefined)
  })

  it('collapses every rule a profile collected for one package into the first bare name', () => {
    // The shape pnpm leaves behind: it appends one `name@version` rule per young
    // release, and reads only the first rule per name, so the bare entry in the
    // middle exempts nothing (pnpm #732) — which is what blocked uninstalls.
    const before =
      'packages:\n  - .\nminimumReleaseAgeExclude:\n  - dsh-agi@0.1.0\n  - dsh-agi@0.1.2\n  - dsh-agi\n  - dsh-agi@0.1.4\n  - dsh-agi@0.1.3\n  - other@1.0.0 || 2.0.0\n'
    assert.equal(
      withReleaseAgeExclusion(before, 'dsh-agi'),
      'packages:\n  - .\nminimumReleaseAgeExclude:\n  - dsh-agi\n  - other@1.0.0 || 2.0.0\n',
    )
  })

  it('drops a rule pnpm appends behind the bare name', () => {
    assert.equal(
      withReleaseAgeExclusion('minimumReleaseAgeExclude:\n  - dsh-agi\n  - dsh-agi@0.1.4\n', 'dsh-agi'),
      'minimumReleaseAgeExclude:\n  - dsh-agi\n',
    )
  })

  it('quotes a scoped name and leaves other entries untouched', () => {
    assert.equal(
      withReleaseAgeExclusion('minimumReleaseAgeExclude:\n\t- other\n', '@scope/orb'),
      "minimumReleaseAgeExclude:\n\t- '@scope/orb'\n\t- other\n",
    )
  })

  it('adds the bare name even when only versioned entries exist', () => {
    assert.equal(
      withReleaseAgeExclusion('minimumReleaseAgeExclude:\n  - dsh-agi@0.1.2\n', 'dsh-agi'),
      'minimumReleaseAgeExclude:\n  - dsh-agi\n',
    )
  })

  it('leaves an unfamiliar file shape alone', () => {
    assert.equal(withReleaseAgeExclusion('minimumReleaseAgeExclude: [dsh-agi]\n', 'dsh-agi'), undefined)
  })

  it('writes the exemption into the profile before installing', async () => {
    const profile = store()
    writeFileSync(
      join(profile.dir, 'pnpm-workspace.yaml'),
      'packages:\n  - .\nminimumReleaseAgeExclude:\n  - dsh-agi@0.1.0\n',
    )
    const { update } = checker({ store: profile, latest: '0.2.0' })
    await update.check()
    await update.install()
    assert.equal(
      readFileSync(join(profile.dir, 'pnpm-workspace.yaml'), 'utf8'),
      'packages:\n  - .\nminimumReleaseAgeExclude:\n  - dsh-agi\n',
    )
  })

  it('repairs the profile at start, whatever route installed the version', () => {
    const profile = store()
    // What the market's or the plugin manager's own `pnpm add` leaves behind:
    // pnpm's appended rule sits behind the first rule, which keeps governing.
    const broken = 'packages:\n  - .\nminimumReleaseAgeExclude:\n  - dsh-agi@0.1.4\n  - dsh-agi@0.1.5\n'
    writeFileSync(join(profile.dir, 'pnpm-workspace.yaml'), broken)
    exemptReleaseAge(profile.dir, 'dsh-agi')
    const repaired = 'packages:\n  - .\nminimumReleaseAgeExclude:\n  - dsh-agi\n'
    assert.equal(readFileSync(join(profile.dir, 'pnpm-workspace.yaml'), 'utf8'), repaired)
    // Idempotent: starting again changes nothing.
    exemptReleaseAge(profile.dir, 'dsh-agi')
    assert.equal(readFileSync(join(profile.dir, 'pnpm-workspace.yaml'), 'utf8'), repaired)
  })

  it('leaves a profile without a workspace file alone', () => {
    const profile = store()
    exemptReleaseAge(profile.dir, 'dsh-agi')
    assert.equal(existsSync(join(profile.dir, 'pnpm-workspace.yaml')), false)
  })

  it('rides out a destination the system refuses for a moment', () => {
    // pnpm itself, OneDrive, or a scanner can hold `pnpm-workspace.yaml`; the refusal is
    // transient far more often than it is permanent.
    const refusals = [Object.assign(new Error('busy'), { code: 'EPERM' }), Object.assign(new Error('busy'), { code: 'EBUSY' })]
    let attempts = 0
    const renamed: string[] = []
    renameWithRetry('staged', 'target', (from, to) => {
      attempts += 1
      const refusal = refusals.shift()
      if (refusal !== undefined) throw refusal
      renamed.push(`${from}->${to}`)
    })
    assert.equal(attempts, 3, 'two refusals, then the rename that lands')
    assert.deepEqual(renamed, ['staged->target'])
  })

  it('gives up on a rename that never lands, and reports the real error', () => {
    const refusal = Object.assign(new Error('still held'), { code: 'EPERM' })
    let attempts = 0
    assert.throws(
      () => renameWithRetry('staged', 'target', () => { attempts += 1; throw refusal }),
      (error: unknown) => error === refusal,
    )
    assert.equal(attempts, 5, 'every attempt is used before the error surfaces')
  })

  it('survives a workspace file it cannot replace, without leaving the staged copy behind', () => {
    const profile = store()
    const file = join(profile.dir, 'pnpm-workspace.yaml')
    writeFileSync(file, 'packages:\n  - .\n')
    // A directory where the staged sibling goes: the write cannot land, whichever platform.
    mkdirSync(`${file}.dsh-agi-tmp`, { recursive: true })
    exemptReleaseAge(profile.dir, 'dsh-agi')
    assert.equal(readFileSync(file, 'utf8'), 'packages:\n  - .\n', 'the profile file is untouched')
    assert.equal(existsSync(`${file}.dsh-agi-tmp`), true, 'what the test itself created is still a directory')

    // The rename path is the one that must clean up after itself. Read with normalized line
    // endings: the pin is about the code, and a Windows checkout has CRLF on disk.
    const source = readFileSync(join(here, '../src/update.ts'), 'utf8').replaceAll('\r\n', '\n')
    assert.match(source, /catch \(error\) \{\n\s+rmSync\(staged, \{ force: true \}\)\n\s+throw error\n\s+\}/u)
  })
})

describe('update sources', () => {
  it('reads a registry dist-tag document and its tarball address', () => {
    assert.equal(versionFromRegistry('{"name":"dsh-agi","version":"0.2.0"}'), '0.2.0')
    assert.equal(versionFromRegistry('{"name":"dsh-agi","version":"v0.2.0-rc.1"}'), '0.2.0-rc.1')
    assert.equal(versionFromRegistry('{"name":"dsh-agi"}'), undefined)
    assert.equal(versionFromRegistry('not json'), undefined)
    assert.equal(
      registryTarballUrl('https://registry.npmmirror.com', 'dsh-agi', '0.2.0'),
      'https://registry.npmmirror.com/dsh-agi/-/dsh-agi-0.2.0.tgz',
    )
    assert.equal(installSpec('0.2.0', 'dsh-agi'), 'dsh-agi@0.2.0')
    assert.equal(installSpec('v0.2.0-rc.1', 'dsh-agi'), 'dsh-agi@0.2.0-rc.1')
    assert.equal(
      installRegistry(undefined),
      'https://registry.npmmirror.com',
      'an unknown source asks the primary mirror first',
    )
    assert.equal(installRegistry('https://registry.npmjs.org'), 'https://registry.npmjs.org')
    process.env.DSH_AGI_UPDATE_URL = 'http://127.0.0.1:9/downloads/dsh-agi-0.2.0.tgz'
    assert.equal(
      installSpec('0.2.0', 'dsh-agi'),
      'http://127.0.0.1:9/downloads/dsh-agi-0.2.0.tgz',
      'the env override wins over the version spec',
    )
    delete process.env.DSH_AGI_UPDATE_URL
  })

  it('prefers a registry that answers and installs that version from it, over real HTTP', async () => {
    const registry = await mockServer({ '/dsh-agi/latest': [200, '{"name":"dsh-agi","version":"0.3.0"}'] })
    try {
      await withEnv({ DSH_AGI_UPDATE_REGISTRIES: registry.base }, async () => {
        const profile = store()
        const announced: string[] = []
        const fake = manager()
        const update = new UpdateChecker({
          store: profile,
          manager: () => fake.service,
          notify: (version) => announced.push(version),
          own: { name: 'dsh-agi', version: '0.1.0' },
        })
        await update.check(true)
        assert.deepEqual(announced, ['0.3.0'])
        assert.equal(update.state().error, null)
        await update.install()
        assert.deepEqual(fake.specs, ['dsh-agi@0.3.0'])
        assert.deepEqual(fake.registries, [registry.base])
      })
    } finally {
      registry.close()
    }
  })

  it('moves down the registry chain when one is unreachable', async () => {
    const registry = await mockServer({ '/dsh-agi/latest': [200, '{"name":"dsh-agi","version":"0.4.0"}'] })
    try {
      await withEnv({ DSH_AGI_UPDATE_REGISTRIES: `${DEAD_SOURCE},${registry.base}` }, async () => {
        const profile = store()
        const announced: string[] = []
        const fake = manager()
        const update = new UpdateChecker({
          store: profile,
          manager: () => fake.service,
          notify: (version) => announced.push(version),
          own: { name: 'dsh-agi', version: '0.1.0' },
        })
        await update.check(true)
        assert.deepEqual(announced, ['0.4.0'], 'the second registry answered')
        await update.install()
        assert.deepEqual(fake.specs, ['dsh-agi@0.4.0'])
        assert.deepEqual(fake.registries, [registry.base])
      })
    } finally {
      registry.close()
    }
  })

  it('falls back to GitHub when no registry knows the package', async () => {
    const registry = await mockServer({ '/dsh-agi/latest': [404, '{"error":"not found"}'] })
    const github = await mockServer({ '/releases/latest': [200, '{"tag_name":"plugin-v0.2.0"}'] })
    try {
      await withEnv({ DSH_AGI_UPDATE_REGISTRIES: registry.base, DSH_AGI_UPDATE_API: github.base }, async () => {
        const profile = store()
        const announced: string[] = []
        const fake = manager()
        const update = new UpdateChecker({
          store: profile,
          manager: () => fake.service,
          notify: (version) => announced.push(version),
          own: { name: 'dsh-agi', version: '0.1.0' },
        })
        await update.check(true)
        assert.deepEqual(announced, ['0.2.0'], 'the release answered after the registry 404ed')
        await update.install()
        assert.deepEqual(fake.specs, ['dsh-agi@0.2.0'])
        assert.deepEqual(fake.registries, ['https://registry.npmmirror.com'], 'the version still installs from the primary mirror')
      })
    } finally {
      registry.close()
      github.close()
    }
  })
})

describe('update checker', () => {
  it('reports an available version once and remembers it', async () => {
    const profile = store()
    const { update, announced } = checker({ store: profile, latest: '0.2.0' })
    assert.equal(update.state().available, false, 'nothing is known before the first check')
    await update.check()
    assert.deepEqual(announced, ['0.2.0'])
    const state = update.state()
    assert.equal(state.currentVersion, '0.1.0')
    assert.equal(state.installedVersion, '0.1.0')
    assert.equal(state.latestVersion, '0.2.0')
    assert.equal(state.available, true)
    assert.equal(state.error, null)
    assert.equal(update.availableVersion(), '0.2.0')
    assert.deepEqual(profile.updateRecord(), {
      checkedAt: profile.updateRecord().checkedAt,
      latestVersion: '0.2.0',
      notifiedVersion: '0.2.0',
      autoCheck: true,
      lastError: '',
    })
    // A second check on the same version stays quiet, and a restart does too.
    await update.check()
    assert.deepEqual(announced, ['0.2.0'])
    const restarted = checker({ store: profile, latest: '0.2.0' })
    await restarted.update.check()
    assert.deepEqual(restarted.announced, [])
  })

  it('stays quiet when the published version is not newer', async () => {
    const profile = store()
    const { update, announced } = checker({ store: profile, latest: '0.1.0' })
    await update.check()
    assert.deepEqual(announced, [])
    assert.equal(update.state().available, false)
    assert.equal(update.state().error, null)
  })

  it('reports a network failure when every mirror 404s and GitHub is unreachable', async () => {
    // A mirror that has not synced yet answers 404: that is not an answer about the
    // version, so a transfer failure on the remaining source stays a network error.
    const registry = await mockServer({ '/dsh-agi/latest': [404, '{"error":"not found"}'] })
    try {
      await withEnv({ DSH_AGI_UPDATE_REGISTRIES: registry.base, DSH_AGI_UPDATE_API: DEAD_SOURCE }, async () => {
        const profile = store()
        const fake = manager()
        const update = new UpdateChecker({
          store: profile,
          manager: () => fake.service,
          notify: () => {},
          own: { name: 'dsh-agi', version: '0.1.0' },
        })
        await update.check(true)
        const state = update.state()
        assert.equal(state.error, 'network')
        assert.equal(state.checkedAt, null, 'a failed check does not start the quiet period')
      })
    } finally {
      registry.close()
    }
  })

  it('reports an install in progress instead of offering the version again', () => {
    const profile = store()
    const dir = deferredDir(profile.dir)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'status.json'), JSON.stringify({
      phase: 'installing',
      spec: 'dsh-agi@0.2.0',
      pid: process.pid,
      startedAt: Date.now(),
    }))
    const { update } = checker({ store: profile, latest: '0.2.0' })
    const state = update.state()
    assert.equal(state.installing, true, 'the settings page shows the running install')
    assert.equal(state.deferred, false, 'installing is its own state, not the quit-and-reopen one')
    assert.equal(state.available, false, 'the update button does not queue it a second time')
  })

  it('keeps a 2xx mirror without a version from reading as "no release"', async () => {
    // The mirror answers 200 but the body carries no version. That says nothing about
    // whether a release exists, so GitHub's transfer failure stays a network error instead
    // of clearing it and refreshing the quiet period.
    const registry = await mockServer({ '/dsh-agi/latest': [200, '<html>gateway error</html>'] })
    try {
      await withEnv({ DSH_AGI_UPDATE_REGISTRIES: registry.base, DSH_AGI_UPDATE_API: DEAD_SOURCE }, async () => {
        const profile = store()
        const fake = manager()
        const update = new UpdateChecker({
          store: profile,
          manager: () => fake.service,
          notify: () => {},
          own: { name: 'dsh-agi', version: '0.1.0' },
        })
        await update.check(true)
        const state = update.state()
        assert.equal(state.error, 'network')
        assert.equal(state.checkedAt, null, 'a failed check does not start the quiet period')
      })
    } finally {
      registry.close()
    }
  })

  it('records a network failure without dropping the version it already knew', async () => {
    const profile = store()
    const first = checker({ store: profile, latest: '0.2.0' })
    await first.update.check()
    const offline = checker({ store: profile, latest: undefined })
    await offline.update.check(true)
    assert.equal(offline.update.state().error, 'network')
    assert.equal(offline.update.state().latestVersion, '0.2.0')
    assert.equal(offline.update.state().available, true)
  })

  it('reads a repository without releases as checked and quiet, over real HTTP', async () => {
    // The GitHub API answers 404 for /releases/latest until the first release ships.
    const github = await mockServer({
      '/releases/latest': [404, '{"message":"Not Found","documentation_url":"https://docs.github.com/rest"}'],
    })
    try {
      await withEnv({ DSH_AGI_UPDATE_REGISTRIES: DEAD_SOURCE, DSH_AGI_UPDATE_API: github.base }, async () => {
        const profile = store()
        const fake = manager()
        const update = new UpdateChecker({
          store: profile,
          manager: () => fake.service,
          notify: () => {},
          own: { name: 'dsh-agi', version: '0.1.0' },
        })
        await update.check(true)
        const state = update.state()
        assert.equal(state.error, null, 'no release published yet is not a failure')
        assert.equal(state.available, false)
        assert.equal(state.latestVersion, null)
        assert.ok(state.checkedAt !== null, 'the throttle still records the answer')
      })
    } finally {
      github.close()
    }
  })

  it('resolves the latest version through curl end to end', async () => {
    const github = await mockServer({ '/releases/latest': [200, '{"tag_name":"plugin-v0.2.0","name":"0.2.0"}'] })
    try {
      await withEnv({ DSH_AGI_UPDATE_REGISTRIES: DEAD_SOURCE, DSH_AGI_UPDATE_API: github.base }, async () => {
        const profile = store()
        const announced: string[] = []
        const fake = manager()
        const update = new UpdateChecker({
          store: profile,
          manager: () => fake.service,
          notify: (version) => announced.push(version),
          own: { name: 'dsh-agi', version: '0.1.0' },
        })
        await update.check(true)
        assert.deepEqual(announced, ['0.2.0'])
        assert.equal(update.state().available, true)
        assert.equal(update.state().error, null)
      })
    } finally {
      github.close()
    }
  })

  it('throttles the automatic check but not a manual one', async () => {
    const profile = store()
    const { update } = checker({ store: profile, latest: '0.2.0' })
    await update.check()
    const checkedAt = profile.updateRecord().checkedAt
    assert.ok(Date.now() - checkedAt < AUTO_CHECK_INTERVAL_MS)
    // A fresh checker sees the same throttle: the timestamp is on disk, not in memory.
    let asked = 0
    const second = new UpdateChecker({
      store: profile,
      manager: () => undefined,
      notify: () => {},
      fetchLatest: async () => { asked += 1; return '0.3.0' },
      own: { name: 'dsh-agi', version: '0.1.0' },
    })
    await second.check()
    assert.equal(asked, 0)
    await second.check(true)
    assert.equal(asked, 1)
    assert.equal(second.state().latestVersion, '0.3.0')
  })

  it('skips the automatic check when the preference is off', async () => {
    const profile = store()
    profile.setUpdateRecord({ autoCheck: false })
    let asked = 0
    const update = new UpdateChecker({
      store: profile,
      manager: () => undefined,
      notify: () => {},
      fetchLatest: async () => { asked += 1; return '0.2.0' },
      own: { name: 'dsh-agi', version: '0.1.0' },
    })
    await update.check()
    assert.equal(asked, 0)
    assert.equal(update.state().autoCheck, false)
    await update.check(true)
    assert.equal(asked, 1)
    update.setAutoCheck(true)
    assert.equal(update.state().autoCheck, true)
  })

  it('installer falls back to the primary mirror when no check source is known', async () => {
    const profile = store()
    const { update, specs, registries } = checker({ store: profile, latest: '0.2.0' })
    await update.check()
    await update.install()
    assert.deepEqual(specs, ['dsh-agi@0.2.0'])
    assert.deepEqual(registries, ['https://registry.npmmirror.com'], 'no check source still asks the primary mirror')
    const state = update.state()
    assert.equal(state.updating, false)
    assert.equal(state.error, null)
    assert.equal(state.installedVersion, '0.2.0')
    assert.equal(state.available, false, 'nothing is left to install')
    assert.equal(state.restartRequired, true, 'the running process still holds the old code')
    assert.equal(update.availableVersion(), null)
  })

  it('leaves an installed bundle in place when the manager still replaces it', async () => {
    const profile = store()
    const { update, specs, removed } = checker({
      store: profile,
      latest: '0.2.0',
      remove: { application: 'applied' },
    })
    await update.check()
    await update.install()
    assert.deepEqual(removed, [], 'a manager that installs over the package is not asked to remove it')
    assert.deepEqual(specs, ['dsh-agi@0.2.0'])
    assert.equal(update.state().installedVersion, '0.2.0')
  })

  it('removes an already-installed bundle and installs the same spec again', async () => {
    const profile = store()
    profile.setUpdateRecord({ lastError: 'stale' })
    const { update, specs, enabled, removed } = checker({
      store: profile,
      latest: '0.2.0',
      installs: [
        { application: 'failed', error: { code: 'already-installed' } },
        { application: 'applied' },
      ],
      remove: { application: 'applied' },
    })
    assert.equal(update.state().error, 'stale', 'a reload shows the failure the previous attempt stored')
    await update.check()
    assert.equal(update.state().error, 'stale', 'checking again does not clear a stored upgrade failure')
    await update.install()
    assert.deepEqual(removed, ['dsh-agi'])
    assert.deepEqual(specs, ['dsh-agi@0.2.0', 'dsh-agi@0.2.0'])
    assert.deepEqual(enabled, [true, true], 'both installs leave the bundle selected')
    const state = update.state()
    assert.equal(state.error, null)
    assert.equal(state.installedVersion, '0.2.0')
    assert.equal(state.available, false)
    assert.equal(profile.updateRecord().lastError, '')
  })

  it('keeps the installed bundle when removal is refused before it is turned off', async () => {
    const profile = store()
    const { update, specs, removed, reenabled } = checker({
      store: profile,
      latest: '0.2.0',
      installs: [{ application: 'failed', error: { code: 'already-installed' } }],
      remove: { application: 'failed', error: { code: 'not-removable' } },
      reenable: { application: 'applied' },
    })
    await update.check()
    await update.install()
    assert.deepEqual(removed, ['dsh-agi'])
    assert.deepEqual(specs, ['dsh-agi@0.2.0'], 'a refused removal does not install again')
    assert.deepEqual(reenabled, [], 'the bundle was never deselected')
    assert.equal(update.state().error, 'not-removable')
    assert.equal(update.state().installedVersion, '0.1.0')
    assert.equal(profile.updateRecord().lastError, '')
  })

  it('turns the bundle back on when removal fails after deselecting it', async () => {
    const profile = store()
    const { update, specs, reenabled } = checker({
      store: profile,
      latest: '0.2.0',
      installs: [{ application: 'failed', error: { code: 'already-installed' } }],
      remove: { application: 'failed', error: { code: 'bundle-in-use' } },
      reenable: { application: 'applied' },
    })
    await update.check()
    await update.install()
    assert.deepEqual(specs, ['dsh-agi@0.2.0'])
    assert.deepEqual(reenabled, ['dsh-agi'])
    assert.equal(update.state().error, 'bundle-in-use')
    assert.equal(profile.updateRecord().lastError, 'bundle-in-use')
    const restored = checker({ store: profile, latest: '0.2.0' })
    assert.equal(restored.update.state().error, 'bundle-in-use', 'the reloaded page can still say why')
  })

  it('installs after the app quits when removal cannot delete a locked package', async () => {
    const profile = store()
    const { update, specs, trace, deferred } = checker({
      store: profile,
      latest: '0.2.0',
      installs: [{ application: 'failed', error: { code: 'already-installed' } }],
      remove: {
        application: 'failed',
        error: { code: 'operation-error', diagnostic: 'ERR_PNPM_EPERM: EPERM, unlink' },
      },
      reenable: { application: 'applied' },
    })
    await update.check()
    await update.install()
    assert.deepEqual(specs, ['dsh-agi@0.2.0'], 'the locked package is not installed again in this process')
    assert.deepEqual(trace, ['remove', 'defer', 'enable'], 'the job exists before the reload starts the next instance')
    assert.equal(deferred.length, 1)
    assert.equal(deferred[0]?.spec, 'dsh-agi@0.2.0')
    assert.equal(update.state().error, null)
    assert.equal(update.state().deferred, true)

    // Reenabling the bundle reloads it: the page that starts then must read the job back.
    const restored = checker({ store: profile, latest: '0.2.0' })
    assert.equal(restored.update.state().deferred, true, 'the reloaded page still sees the queued install')
    assert.equal(restored.update.state().available, false, 'the update button stays hidden while the job waits')
    rmSync(join(deferredDir(profile.dir), 'job.json'), { force: true })
    assert.equal(restored.update.state().available, true, 'a job that vanished no longer hides the update')
  })

  it('turns the bundle back on when the removal request rejects', async () => {
    const profile = store()
    const { update, removed, reenabled, trace } = checker({
      store: profile,
      latest: '0.2.0',
      installs: [{ application: 'failed', error: { code: 'already-installed' } }],
      remove: { application: 'applied' },
      reenable: { application: 'applied' },
      removeThrows: true,
    })
    await update.check()
    await update.install()
    assert.deepEqual(removed, ['dsh-agi'])
    assert.deepEqual(reenabled, ['dsh-agi'], 'a rejected removal may have deselected the bundle')
    assert.deepEqual(trace, ['remove', 'enable'])
    assert.equal(update.state().error, 'removal request rejected')
    assert.equal(profile.updateRecord().lastError, 'removal request rejected', 'the reloaded page can read it')
    const restored = checker({ store: profile, latest: '0.2.0' })
    assert.equal(restored.update.state().error, 'removal request rejected')
    assert.equal(restored.update.state().installedVersion, '0.1.0')
  })

  it('restores the running version when the install after removal rejects', async () => {
    const profile = store()
    const { update, specs, removed } = checker({
      store: profile,
      latest: '0.2.0',
      installs: [{ application: 'failed', error: { code: 'already-installed' } }],
      remove: { application: 'applied' },
      installThrowsAt: 1,
    })
    await update.check()
    await update.install()
    assert.deepEqual(removed, ['dsh-agi'])
    assert.deepEqual(specs, ['dsh-agi@0.2.0', 'dsh-agi@0.2.0', 'dsh-agi@0.1.0'], 'the rollback installs the running version')
    assert.equal(update.state().error, 'install request rejected')
    assert.equal(update.state().installedVersion, '0.1.0')
    assert.equal(profile.updateRecord().lastError, 'install request rejected')
  })

  it('reports a cancelled install instead of counting it as applied', async () => {
    const profile = store()
    const { update } = checker({ store: profile, latest: '0.2.0', result: { application: 'cancelled' } })
    await update.check()
    await update.install()
    assert.equal(update.state().error, 'cancelled')
    assert.equal(update.state().installedVersion, '0.1.0')
    assert.equal(update.state().restartRequired, false)
  })

  it('does not resurrect a remembered failure whose version is already installed', () => {
    const profile = store()
    profile.setUpdateRecord({ lastError: 'incompatible-version', latestVersion: '0.1.0' })
    const { update } = checker({ store: profile, latest: '0.1.0' })
    assert.equal(update.state().error, null, 'the remembered failure is already history')
    assert.equal(profile.updateRecord().lastError, '')
  })

  it('clears a remembered failure when a check finds no newer version', async () => {
    const profile = store()
    profile.setUpdateRecord({ lastError: 'incompatible-version' })
    const { update } = checker({ store: profile, latest: '0.1.0' })
    assert.equal(update.state().error, 'incompatible-version')
    await update.check()
    assert.equal(update.state().error, null, 'no newer version means the old failure no longer applies')
    assert.equal(profile.updateRecord().lastError, '')
  })

  it('installs the running version again when the replacement install fails', async () => {
    const profile = store()
    const { update, specs, removed } = checker({
      store: profile,
      latest: '0.2.0',
      installs: [
        { application: 'failed', error: { code: 'already-installed' } },
        { application: 'failed', error: { code: 'incompatible-version' } },
        { application: 'applied' },
      ],
      remove: { application: 'applied' },
    })
    await update.check()
    await update.install()
    assert.deepEqual(removed, ['dsh-agi'])
    assert.deepEqual(specs, ['dsh-agi@0.2.0', 'dsh-agi@0.2.0', 'dsh-agi@0.1.0'])
    assert.equal(update.state().error, 'incompatible-version')
    assert.equal(update.state().installedVersion, '0.1.0', 'the failed upgrade does not count as installed')
    assert.equal(update.availableVersion(), '0.2.0')
    assert.equal(profile.updateRecord().lastError, 'incompatible-version')
    const restored = checker({ store: profile, latest: '0.2.0' })
    assert.equal(restored.update.state().error, 'incompatible-version')
  })

  it('reports already-installed when the manager cannot remove a bundle', async () => {
    const profile = store()
    const { update, specs, removed } = checker({
      store: profile,
      latest: '0.2.0',
      result: { application: 'failed', error: { code: 'already-installed' } },
    })
    await update.check()
    await update.install()
    assert.deepEqual(removed, [])
    assert.deepEqual(specs, ['dsh-agi@0.2.0'])
    assert.equal(update.state().error, 'already-installed')
    assert.equal(update.state().installedVersion, '0.1.0')
  })

  it('reports how an install failed instead of throwing', async () => {
    const profile = store()
    const failed = checker({
      store: profile,
      latest: '0.2.0',
      result: { application: 'failed', error: { code: 'incompatible-version' } },
    })
    await failed.update.check()
    await failed.update.install()
    assert.equal(failed.update.state().error, 'incompatible-version')
    assert.equal(failed.update.state().installedVersion, '0.1.0')
    assert.equal(failed.update.availableVersion(), '0.2.0', 'the offer survives for a retry')

    const blocked = checker({
      store: profile,
      latest: '0.2.0',
      result: { application: 'failed', pendingBuilds: ['koffi'] },
    })
    await blocked.update.check()
    await blocked.update.install()
    assert.equal(blocked.update.state().error, 'build-blocked')
    assert.deepEqual(blocked.update.state().pendingBuilds, ['koffi'])

    const diagnosed = checker({
      store: profile,
      latest: '0.2.0',
      result: {
        application: 'failed',
        error: {
          diagnostic: 'ERR_PNPM_NO_MATURE_MATCHING_VERSION: 1 version does not meet the minimumReleaseAge constraint\ndetail below',
        },
      },
    })
    await diagnosed.update.check()
    await diagnosed.update.install()
    assert.equal(
      diagnosed.update.state().error,
      'ERR_PNPM_NO_MATURE_MATCHING_VERSION: 1 version does not meet the minimumReleaseAge constraint',
      'a codeless pnpm failure keeps its first diagnostic line',
    )

    const wrapped = checker({
      store: profile,
      latest: '0.2.0',
      result: {
        application: 'failed',
        error: {
          code: 'operation-error',
          diagnostic: 'Progress: resolved 1, reused 0, downloaded 0, added 0\n[ERR_PNPM_MISSING_TARBALL_INTEGRITY] Cannot install package "dsh-agi@https://example.invalid/dsh-agi.tgz"\nmore',
        },
      },
    })
    await wrapped.update.check()
    await wrapped.update.install()
    assert.equal(
      wrapped.update.state().error,
      '[ERR_PNPM_MISSING_TARBALL_INTEGRITY] Cannot install package "dsh-agi@https://example.invalid/dsh-agi.tgz"',
      'the generic operation-error wrapper yields to the pnpm line',
    )
  })

  it('waits for the app to quit instead of replacing a package whose addon is loaded', async () => {
    const profile = store()
    const { update, specs, deferred } = checker({ store: profile, latest: '0.2.0', mapped: ['node_modules/koffi/build/koffi.node'] })
    await update.check()
    await update.install(['koffi'])
    assert.deepEqual(specs, [], 'pnpm never sees a package it cannot replace')
    assert.deepEqual(deferred, [{
      profileDir: profile.dir,
      spec: 'dsh-agi@0.2.0',
      version: '0.2.0',
      registry: 'https://registry.npmmirror.com',
      parentPid: process.pid,
      approvedBuilds: ['koffi'],
    }])
    const state = update.state()
    assert.equal(state.error, null)
    assert.equal(state.deferred, true)
    assert.equal(state.restartRequired, true)
    assert.equal(state.available, false, 'the button does not queue the same version twice')
    assert.equal(state.installedVersion, '0.1.0', 'nothing is on disk yet')
    await update.install()
    assert.equal(deferred.length, 1)
  })

  it('hands a locked-file failure to the after-exit install', async () => {
    const profile = store()
    const { update, specs, deferred } = checker({
      store: profile,
      latest: '0.2.0',
      result: {
        application: 'failed',
        error: {
          code: 'operation-error',
          diagnostic: '[ERR_PNPM_EPERM] [importPackage C:\\p\\node_modules\\dsh-agi] EPERM, Permission denied: \\\\?\\C:\\p\\node_modules\\dsh-agi_tmp_1_1\\node_modules',
        },
      },
    })
    await update.check()
    await update.install()
    assert.deepEqual(specs, ['dsh-agi@0.2.0'])
    assert.equal(deferred.length, 1, 'the half-replaced package is repaired once the app quits')
    assert.equal(update.state().error, null)
    assert.equal(update.state().deferred, true)
  })

  it('reports a deferred install that failed after the app quit', () => {
    const profile = store()
    mkdirSync(deferredDir(profile.dir), { recursive: true })
    const result = join(deferredDir(profile.dir), 'result.json')
    writeFileSync(result, JSON.stringify({ spec: 'dsh-agi@0.2.0', ok: false, detail: 'ERR_PNPM_FETCH_404 not found' }))
    const { update } = checker({ store: profile, latest: '0.2.0' })
    assert.equal(update.state().error, 'ERR_PNPM_FETCH_404 not found')
    assert.equal(existsSync(result), false, 'the outcome is reported once')
    assert.equal(checker({ store: profile, latest: '0.2.0' }).update.state().error, null)
  })

  it('keeps working without the official plugin manager', async () => {
    const profile = store()
    const update = new UpdateChecker({
      store: profile,
      manager: () => undefined,
      notify: () => {},
      fetchLatest: async () => '0.2.0',
      own: { name: 'dsh-agi', version: '0.1.0' },
    })
    await update.check()
    assert.equal(update.state().available, true, 'the notice needs no manager')
    assert.equal(update.state().canUpdate, false)
    await update.install()
    assert.equal(update.state().installedVersion, '0.1.0', 'nothing was installed')
  })

  it('has nothing to offer without a readable version', async () => {
    const profile = store()
    const update = new UpdateChecker({
      store: profile,
      manager: () => undefined,
      notify: () => {},
      fetchLatest: async () => '9.9.9',
      own: undefined,
    })
    await update.check()
    const state = update.state()
    assert.equal(state.currentVersion, '')
    assert.equal(state.available, false)
    assert.equal(state.canUpdate, false)
  })
})
