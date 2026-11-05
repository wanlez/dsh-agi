/**
 * Update check and one-click upgrade for the installed bundle.
 * The check asks the npm registries first (npmmirror, then npmjs): the package is
 * published there, the mirrors answer fast in China, and `name@version` carries the
 * registry's `dist.integrity`. GitHub Releases is the fallback for a version the
 * registry has not mirrored yet; that path installs the release tarball URL.
 */

import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { deferredInstallInProgress, pendingDeferredInstall, scheduleInstallAfterExit, takeDeferredOutcome, type DeferredInstall } from './deferred-install.ts'
import { mappedImages, ownPackageRoot } from './native-images.ts'
import type { ProfileStore } from './preferences.ts'

/**
 * The GitHub repository that publishes plugin releases, `plugin-v<version>` tags.
 * 分享版不再指向发布仓库（TEMP-UPDATE-OFF）：置空后 GitHub Releases 这一路取不到东西，
 * 升级入口也由路由直接拒绝；恢复官方行为时填回仓库名。
 */
export const UPDATE_REPO = 'wanlez/dsh-agi'

/** Registry sources probed before GitHub, in order. npmmirror syncs minutes after a publish. */
export const REGISTRY_BASES = ['https://registry.npmmirror.com', 'https://registry.npmjs.org']

/** How long a remembered answer stays fresh for the automatic check. */
export const AUTO_CHECK_INTERVAL_MS = 60 * 60 * 1000

/** Delay before the first automatic check: the official host needs the network at boot. */
export const FIRST_CHECK_DELAY_MS = 20 * 1000

const PERIODIC_CHECK_MS = 6 * 60 * 60 * 1000

/** Answer a host without an updater gives: the settings page then hides the whole card. */
export const EMPTY_UPDATE_STATE: UpdateState = {
  currentVersion: '',
  installedVersion: '',
  latestVersion: null,
  available: false,
  checking: false,
  updating: false,
  canUpdate: false,
  autoCheck: false,
  checkedAt: null,
  restartRequired: false,
  deferred: false,
  installing: false,
  error: null,
  pendingBuilds: [],
}

/** What the settings page renders. `currentVersion` is the code this process runs. */
export interface UpdateState {
  currentVersion: string
  /** Version on disk now; differs from {@link currentVersion} after an upgrade until restart. */
  installedVersion: string
  latestVersion: string | null
  available: boolean
  checking: boolean
  updating: boolean
  canUpdate: boolean
  autoCheck: boolean
  checkedAt: number | null
  restartRequired: boolean
  /** The update waits for the app to quit: a loaded native file blocks replacing the package now. */
  deferred: boolean
  /** The after-exit script is installing right now; the page says to wait, not to reopen. */
  installing: boolean
  error: string | null
  pendingBuilds: string[]
}

/** The package manifest next to the built host. */
export interface OwnPackage {
  readonly name: string
  readonly version: string
}

/** The slice of the official `pluginManager` service this plugin uses. */
export interface PluginManager {
  installBundle(spec: string, options?: {
    enabled?: boolean
    requestId?: string
    approvedBuilds?: string[]
    /** Registry asked first. The manager keeps its own fallbacks when this one is among them. */
    registry?: string
  }): Promise<InstallResult>
  /**
   * Remove an installed bundle by package name.
   * With HMR, `installBundle` of a package that is already installed fails with
   * `already-installed` before pnpm runs; the upgrade removes the bundle first.
   * Absent on a manager that still installs over the current package itself.
   */
  removeBundle?(name: string): Promise<InstallResult>
  /**
   * Turn a bundle back on without installing it.
   * `removeBundle` disables the bundle before pnpm runs, so a removal that fails
   * after that point has to select it again or the ball stays off.
   */
  setBundleEnabled?(name: string, enabled: boolean): Promise<InstallResult>
}

export interface InstallResult {
  readonly changed?: boolean
  readonly application?: string
  readonly error?: { readonly code?: string; readonly diagnostic?: string }
  readonly pendingBuilds?: readonly string[]
  readonly bundle?: string
}

export interface UpdateDeps {
  readonly store: ProfileStore
  /** Official service, read live because it mounts after us. */
  manager(): unknown
  /** Announce a newly published version on the ball, once per version. */
  notify(version: string): void
  /** Test seam: newest published version, or undefined when no registry answers. */
  fetchLatest?(name: string): Promise<string | undefined>
  /** Test seam: the installed manifest. */
  own?: OwnPackage | undefined
  /** Test seam: native images in the package some process holds mapped (see `native-images.ts`). */
  mappedImages?(): string[]
  /** Test seam: hand the install to a script that runs once this process exits. */
  deferInstall?(job: DeferredInstall): void
}

/**
 * Read the installed manifest.
 * The path assumes the assembled layout: `dist/host/index.js` next to the package's
 * `package.json`, which holds both in the profile's `node_modules/dsh-agi` and in a
 * `link:`ed source checkout. Running from `packages/host/lib` finds nothing, so callers
 * treat an unknown version as "no update UI".
 */
export function ownPackage(url: string = import.meta.url): OwnPackage | undefined {
  let raw: string
  try {
    raw = readFileSync(new URL('../../package.json', url), 'utf8')
  } catch {
    return undefined
  }
  try {
    const manifest = JSON.parse(raw) as { name?: unknown; version?: unknown }
    if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') return undefined
    if (manifest.name === '' || manifest.version === '') return undefined
    return { name: manifest.name, version: manifest.version }
  } catch {
    return undefined
  }
}

/** Order two dotted versions. A prerelease sorts below the release it precedes. */
export function compareVersions(left: string, right: string): number {
  const a = splitVersion(left)
  const b = splitVersion(right)
  for (let index = 0; index < Math.max(a.main.length, b.main.length); index += 1) {
    const one = a.main[index] ?? 0
    const other = b.main[index] ?? 0
    if (one !== other) return one < other ? -1 : 1
  }
  if (a.pre === b.pre) return 0
  if (a.pre === '') return 1
  if (b.pre === '') return -1
  return comparePrerelease(a.pre, b.pre)
}

/** The bundle list a deferred install should put back after pnpm rewrites the manifest. */
function profileBundles(dir: string): string[] {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      dsh?: { profile?: { bundles?: unknown } }
    }
    const bundles = manifest.dsh?.profile?.bundles
    return Array.isArray(bundles) ? bundles.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function isPluginManager(value: unknown): value is PluginManager {
  return typeof value === 'object' && value !== null
    && typeof (value as { installBundle?: unknown }).installBundle === 'function'
}

/**
 * Checks the repository's latest release and runs the official installer.
 * Every failure stays inside this class: the update path must never break the ball.
 */
export class UpdateChecker {
  private readonly store: ProfileStore
  private readonly deps: UpdateDeps
  private readonly own: OwnPackage | undefined
  private installed: string
  private latest: string | null
  private checking = false
  private updating = false
  private error: string | null = null
  private pendingBuilds: string[] = []
  private restartRequired = false
  /** Version handed to the after-exit install; offering it again would only queue it twice. */
  private deferred: string | null = null
  /** The after-exit script is running right now (its status file says so). */
  private installing = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private interval: ReturnType<typeof setInterval> | undefined
  /** The registry base that answered the last check; GitHub is the fallback when none did. */
  private source: string | undefined
  /** Distinguishes install requests issued in the same millisecond. */
  private requestSerial = 0

  constructor(deps: UpdateDeps) {
    this.deps = deps
    this.store = deps.store
    this.own = 'own' in deps ? deps.own : ownPackage()
    this.installed = this.own?.version ?? ''
    this.latest = this.store.updateRecord().latestVersion || null
    const remembered = this.store.updateRecord().lastError
    // A remembered failure whose version is no longer newer than the installed one is
    // history (a manual reinstall, a newer build): do not resurrect it on every start.
    if (remembered !== '') {
      if (this.latest !== null && compareVersions(this.latest, this.installed) <= 0) this.store.setUpdateRecord({ lastError: '' })
      else this.error = remembered
    }
    this.installing = deferredInstallInProgress(this.store.dir)
    this.adoptDeferredOutcome()
    this.normalizeDependency()
  }

  /**
   * Read the outcome an after-exit install left, and refresh whether one is still running.
   * Called once at construction and again by a start that waited for the install to finish.
   */
  adoptDeferredOutcome(): void {
    const outcome = takeDeferredOutcome(this.store.dir)
    this.installing = deferredInstallInProgress(this.store.dir)
    if (outcome === undefined) return
    if (outcome.ok) {
      // The deferred install is what the remembered failure was about; a later
      // check must not keep showing it.
      this.error = null
      this.pendingBuilds = []
      this.store.setUpdateRecord({ lastError: '' })
      return
    }
    this.error = outcome.detail === '' ? 'deferred-install-failed' : outcome.detail
  }

  /**
   * Whether the after-exit script is installing right now, re-read so a state can never
   * latch: the outcome and the status file are written back to back, and a host that reads
   * between them would otherwise hide the update card for the rest of the session.
   * @returns true while a live install is running.
   */
  private installInProgress(): boolean {
    this.installing = deferredInstallInProgress(this.store.dir)
    return this.installing
  }

  /**
   * Repair a profile dependency that points at the temporary update folder. The updater
   * installs `file:.../.dsh-agi-update/<tarball>`; pnpm records that path, which breaks
   * the next install once the folder is cleaned. The running version is the stable spec.
   */
  private normalizeDependency(): void {
    const own = this.own
    if (own === undefined || own.version === '') return
    try {
      const file = join(this.store.dir, 'package.json')
      const manifest = JSON.parse(readFileSync(file, 'utf8')) as { dependencies?: Record<string, string> }
      const deps = manifest.dependencies
      const spec = deps?.[own.name]
      if (deps === undefined || typeof spec !== 'string') return
      if (!spec.startsWith('file:') && !spec.includes('.dsh-agi-update')) return
      deps[own.name] = own.version
      writeFileSync(file, `${JSON.stringify(manifest, null, 2)}
`)
      console.info(`dsh-agi: dependency ${own.name} normalized to ${own.version}`)
    } catch (error) {
      console.error(`dsh-agi: could not normalize the dependency: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  state(): UpdateState {
    const latest = this.latest
    const installed = this.installed
    const installing = this.installInProgress()
    return {
      currentVersion: this.own?.version ?? '',
      installedVersion: installed,
      latestVersion: latest,
      available: this.available(),
      checking: this.checking,
      updating: this.updating,
      canUpdate: this.own !== undefined && isPluginManager(this.deps.manager()),
      autoCheck: this.store.updateRecord().autoCheck,
      checkedAt: this.store.updateRecord().checkedAt || null,
      restartRequired: this.restartRequired,
      deferred: this.deferredPending(),
      installing,
      error: this.error,
      pendingBuilds: [...this.pendingBuilds],
    }
  }

  /** Version waiting to be installed, when the check found one. */
  availableVersion(): string | null {
    return this.available() ? this.latest : null
  }

  /** Schedule the automatic checks and return the disposer. */
  start(): () => void {
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.check()
    }, FIRST_CHECK_DELAY_MS)
    this.timer.unref()
    this.interval = setInterval(() => { void this.check() }, PERIODIC_CHECK_MS)
    this.interval.unref()
    return () => {
      if (this.timer !== undefined) clearTimeout(this.timer)
      if (this.interval !== undefined) clearInterval(this.interval)
      this.timer = undefined
      this.interval = undefined
    }
  }

  /**
   * Ask the repository's latest release for the newest published version.
   * The automatic call is throttled by {@link AUTO_CHECK_INTERVAL_MS}; `/update/check` is not.
   */
  async check(manual = false): Promise<void> {
    if (this.checking || this.updating || this.own === undefined) return
    const record = this.store.updateRecord()
    if (!manual && !record.autoCheck) return
    if (!manual && Date.now() - record.checkedAt < AUTO_CHECK_INTERVAL_MS) return
    this.checking = true
    try {
      const latest = await this.fetch()
      if (latest === null) {
        // The repository answered but publishes no release yet: a clean, quiet nothing.
        // A failure remembered from an upgrade that unloaded this plugin stays up; a check
        // does not retry the install, so it must not look like the failure went away.
        this.error = this.rememberedError()
        this.store.setUpdateRecord({ checkedAt: Date.now() })
        return
      }
      if (latest === undefined) {
        this.error = 'network'
        return
      }
      this.latest = latest
      // A remembered failure only describes an upgrade that is still available. Once
      // the installed version caught up (a manual reinstall, a deferred install that
      // finally landed), keeping it would show a failure for work already done.
      const updateAvailable = compareVersions(latest, this.installed) > 0
      this.error = updateAvailable ? this.rememberedError() : null
      if (!updateAvailable) this.pendingBuilds = []
      const announce = updateAvailable && record.notifiedVersion !== latest
      this.store.setUpdateRecord({
        checkedAt: Date.now(),
        latestVersion: latest,
        ...updateAvailable ? {} : { lastError: '' },
        ...announce ? { notifiedVersion: latest } : {},
      })
      if (announce) this.deps.notify(latest)
    } finally {
      this.checking = false
    }
  }

  /**
   * Install the version the check found through the official plugin manager.
   * The spec is `name@version` and the registry is the one that answered the
   * check, so pnpm resolves registry metadata — including `dist.integrity` —
   * instead of a bare tarball URL. The manager owns the profile lock, the
   * download and the manifest restore.
   *
   * A manager without HMR still installs over the package that is already there.
   * With HMR (every shipped desktop profile), that call fails before pnpm with
   * `already-installed`. The upgrade then follows the manager's own rule: remove
   * the bundle, then install the same spec. The removal stops this plugin; the
   * promise that called it keeps running and issues the install.
   *
   * On Windows a package whose native addon is loaded cannot be replaced: pnpm
   * fails with EPERM after it has already deleted part of the live package.
   * When the probe finds such an addon, or pnpm fails that way anyway, the
   * install waits for the app to quit instead (see `deferred-install.ts`).
   * That path runs pnpm directly, so the HMR refusal never applies to it.
   */
  async install(approvedBuilds?: string[]): Promise<void> {
    const version = this.availableVersion()
    const manager = this.deps.manager()
    if (version === null || this.updating || !isPluginManager(manager) || this.own === undefined) return
    this.updating = true
    this.error = null
    this.pendingBuilds = []
    const name = this.own.name
    const previous = this.own.version
    try {
      // Drop a failure the previous attempt left. The next page is either this
      // process or the build the install is about to load, and neither should
      // keep describing an attempt that has already been retried.
      this.store.setUpdateRecord({ lastError: '' })
      exemptReleaseAge(this.store.dir, name)
      const spec = installSpec(version, name)
      const registry = installRegistry(this.source)
      if (this.lockedImages().length > 0) {
        this.deferUntilExit(version, spec, registry, approvedBuilds ?? [])
        return
      }
      const result = await this.requestInstall(manager, spec, registry, approvedBuilds)
      if (result.application === 'failed' && isLockedFileFailure(result.error)) {
        this.deferUntilExit(version, spec, registry, approvedBuilds ?? [])
        return
      }
      if (result.application === 'failed' && result.error?.code === 'already-installed' && typeof manager.removeBundle === 'function') {
        await this.replaceInstalled(manager, name, previous, version, spec, registry, approvedBuilds)
        return
      }
      if (result.application === 'failed') {
        this.noteFailure(result)
        return
      }
      if (result.application === 'cancelled') {
        this.error = 'cancelled'
        return
      }
      this.accept(version)
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
    } finally {
      this.updating = false
    }
  }

  /**
   * Remove the installed bundle and install `spec` in its place.
   * Called only after `installBundle` refused with `already-installed`, which
   * changes nothing. The removal is what unloads this plugin; `requestInstall`
   * then runs on the manager reference captured before that unload.
   * @param manager - the manager captured before the removal.
   * @param name - package name, which is the bundle name `removeBundle` takes.
   * @param previous - version running now, installed again if the new one fails.
   * @param version - version being installed.
   * @param spec - `name@version` for {@link version}.
   * @param registry - registry the check answered from.
   * @param approvedBuilds - install scripts the settings page approved.
   */
  private async replaceInstalled(
    manager: PluginManager,
    name: string,
    previous: string,
    version: string,
    spec: string,
    registry: string,
    approvedBuilds: string[] | undefined,
  ): Promise<void> {
    const removeBundle = manager.removeBundle
    if (removeBundle === undefined) return
    // pnpm remove rewrites the workspace file. Put the exemption back first so the
    // install that follows cannot settle for a release that is already a day old.
    exemptReleaseAge(this.store.dir, name)
    let removed: InstallResult
    try {
      removed = await removeBundle.call(manager, name)
    } catch (error) {
      // A rejected removal may have deselected the bundle before it threw; turn it
      // back on or the ball stays off with nobody left to show the message.
      this.error = error instanceof Error ? error.message : String(error)
      this.rememberFailure()
      await this.reenable(manager, name)
      return
    }
    if (removed.application === 'failed' || removed.application === 'cancelled') {
      if (isLockedFileFailure(removed.error)) {
        // The package is still the running one, and pnpm could not delete it.
        // Queue the after-exit install first: reenabling reloads this bundle, and the
        // instance that starts then reads the job file, not this instance's fields.
        this.deferUntilExit(version, spec, registry, approvedBuilds ?? [])
        if (this.error !== null) this.rememberFailure()
        if (!removalStoppedBeforeDisable(removed.error)) await this.reenable(manager, name)
        return
      }
      if (removed.application === 'cancelled') this.error = 'cancelled'
      else this.noteFailure(removed)
      if (!removalStoppedBeforeDisable(removed.error)) {
        this.rememberFailure()
        await this.reenable(manager, name)
      }
      return
    }
    let again: InstallResult
    try {
      again = await this.requestInstall(manager, spec, registry, approvedBuilds)
    } catch (error) {
      // The previous version was removed and this call never produced a result:
      // put the running version back rather than leave the bundle absent.
      this.error = error instanceof Error ? error.message : String(error)
      this.rememberFailure()
      await this.restorePrevious(manager, name, previous, registry, approvedBuilds)
      return
    }
    if (again.application === 'failed' && isLockedFileFailure(again.error)) {
      // The new files are already half-written. Installing the previous version
      // over that tree fails the same way, so the repair waits for this process to exit.
      this.deferUntilExit(version, spec, registry, approvedBuilds ?? [])
      return
    }
    if (again.application === 'failed' || again.application === 'cancelled') {
      if (again.application === 'cancelled') this.error = 'cancelled'
      else this.noteFailure(again)
      this.rememberFailure()
      await this.restorePrevious(manager, name, previous, registry, approvedBuilds)
      return
    }
    this.accept(version)
  }

  /**
   * Install the version that was running before a failed replacement.
   * `already-installed` means that package is still on disk, which is the outcome
   * the rollback wanted; any other failure leaves the bundle missing and is logged.
   */
  private async restorePrevious(
    manager: PluginManager,
    name: string,
    previous: string,
    registry: string,
    approvedBuilds: string[] | undefined,
  ): Promise<void> {
    try {
      const rolled = await this.requestInstall(manager, exactSpec(previous, name), registry, approvedBuilds)
      if (rolled.application === 'failed' && rolled.error?.code !== 'already-installed') {
        console.error(`dsh-agi: restoring ${name}@${previous} failed: ${reportedInstallError(rolled.error)}`)
      }
    } catch (error) {
      console.error(`dsh-agi: restoring ${name}@${previous} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Install one spec with the bundle left enabled. */
  private requestInstall(
    manager: PluginManager,
    spec: string,
    registry: string,
    approvedBuilds: string[] | undefined,
  ): Promise<InstallResult> {
    this.requestSerial += 1
    return manager.installBundle(spec, {
      enabled: true,
      requestId: `dsh-agi-update-${Date.now()}-${this.requestSerial}`,
      registry,
      ...approvedBuilds === undefined ? {} : { approvedBuilds },
    })
  }

  /** Record a failed install on this instance. A script approval stays a distinct code. */
  private noteFailure(result: InstallResult): void {
    this.error = reportedInstallError(result.error)
    this.pendingBuilds = result.pendingBuilds === undefined ? [] : [...result.pendingBuilds]
    if (this.pendingBuilds.length > 0) this.error = 'build-blocked'
  }

  /**
   * Keep {@link noteFailure}'s message where a plugin started by the next call can read it.
   * The call that follows reloads this bundle, and the reloaded page never sees `this.error`.
   */
  private rememberFailure(): void {
    if (this.error !== null && this.error !== '') this.store.setUpdateRecord({ lastError: this.error })
  }

  /** The remembered upgrade failure, or nothing when the last attempt did not leave one. */
  private rememberedError(): string | null {
    const remembered = this.store.updateRecord().lastError
    return remembered === '' ? null : remembered
  }

  /** Select the bundle again after a removal disabled it and then failed. */
  private async reenable(manager: PluginManager, name: string): Promise<void> {
    if (typeof manager.setBundleEnabled !== 'function') return
    try {
      await manager.setBundleEnabled(name, true)
    } catch (error) {
      console.error(`dsh-agi: could not turn the bundle back on after a failed removal: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** The install landed. The running code is still the previous build until a restart or reload. */
  private accept(version: string): void {
    const own = this.own
    if (own === undefined) return
    this.installed = version
    this.latest = version
    this.restartRequired = compareVersions(version, own.version) !== 0
    this.store.setUpdateRecord({ latestVersion: version, notifiedVersion: version, checkedAt: Date.now(), lastError: '' })
  }

  setAutoCheck(enabled: boolean): void {
    this.store.setUpdateRecord({ autoCheck: enabled })
  }

  private available(): boolean {
    return this.own !== undefined && this.latest !== null && !this.deferredPending()
      && !this.installInProgress()
      && compareVersions(this.latest, this.installed) > 0
  }

  /**
   * Whether an after-exit install is queued. The job file outlives this instance,
   * so the plugin a bundle toggle reloads still hides the update button and keeps
   * showing the deferred banner instead of offering the same install again.
   * @returns true while the upgrade waits for the app to quit.
   */
  private deferredPending(): boolean {
    if (this.deferred !== null) return true
    return pendingDeferredInstall(this.store.dir) !== undefined
  }

  private lockedImages(): string[] {
    if (this.deps.mappedImages !== undefined) return this.deps.mappedImages()
    if (process.platform !== 'win32' || this.own === undefined) return []
    // A workspace checkout runs from `packages/`, which is no installed package.
    if (ownPackage(import.meta.url)?.name !== this.own.name) return []
    try {
      return mappedImages(ownPackageRoot(import.meta.url))
    } catch {
      return []
    }
  }

  private deferUntilExit(version: string, spec: string, registry: string, approvedBuilds: readonly string[]): void {
    const job: DeferredInstall = {
      profileDir: this.store.dir,
      spec,
      version,
      registry,
      parentPid: process.pid,
      approvedBuilds,
      name: this.own?.name,
      bundles: profileBundles(this.store.dir),
    }
    try {
      (this.deps.deferInstall ?? scheduleInstallAfterExit)(job)
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
      return
    }
    this.deferred = version
    this.restartRequired = true
  }

  private async fetch(): Promise<string | null | undefined> {
    const own = this.own
    if (own === undefined) return undefined
    if (this.deps.fetchLatest !== undefined) return this.deps.fetchLatest(own.name)
    const forced = process.env.DSH_AGI_UPDATE_LATEST?.trim()
    if (forced !== undefined && forced !== '') return forced
    this.source = undefined
    // Ask the registries and GitHub, then take the higher version. npm is primary
    // (npmmirror answers fast and carries dist.integrity), but a new npm package
    // sits behind a staged-review placeholder (`0.0.0-stage`) until npm approves it;
    // that placeholder must never mask the real release on GitHub.
    let registryVersion: string | undefined
    let registryBase: string | undefined
    for (const base of registryBases()) {
      const body = await curlText(`${base}/${own.name}/latest`)
      // `undefined` is a transfer failure, `''` is this source's 404: neither says anything
      // about whether the package exists, so the next source decides.
      if (body === undefined || body === '') continue
      const version = versionFromRegistry(body)
      // A 2xx without a parseable version is not an answer either.
      if (version === undefined) continue
      registryVersion = version
      registryBase = base
      break
    }
    const release = await curlText(`${apiBase()}/releases/latest`)
    // `null` is GitHub reachable without a release; `undefined` is a transfer failure.
    const githubVersion = release === undefined ? undefined : versionFromRelease(release) ?? null
    if (registryVersion !== undefined
      && (githubVersion === undefined || githubVersion === null || compareVersions(registryVersion, githubVersion) >= 0)) {
      this.source = registryBase
      return registryVersion
    }
    if (githubVersion === undefined) return registryVersion
    return githubVersion
  }


}

/** The API base the check asks; `DSH_AGI_UPDATE_API` re-points it (tests, mirrors). */
function apiBase(): string {
  const configured = process.env.DSH_AGI_UPDATE_API?.trim()
  if (configured !== undefined && configured !== '') return configured.replace(/\/+$/, '')
  return `https://api.github.com/repos/${UPDATE_REPO}`
}

/** The tag a release publishes: version 0.2.0 ships as `plugin-v0.2.0`. */
export function releaseTag(version: string): string {
  return `plugin-v${version.trim().replace(/^v/, '')}`
}

/**
 * The tarball a release attaches, the name `pnpm pack` produces for the bundle.
 * `DSH_AGI_UPDATE_URL` overrides the whole address (tests, staged releases).
 */
export function releaseTarballUrl(version: string): string {
  const clean = version.trim().replace(/^v/, '')
  const overridden = process.env.DSH_AGI_UPDATE_URL?.trim()
  if (overridden !== undefined && overridden !== '') return overridden
  return `https://github.com/${UPDATE_REPO}/releases/download/${releaseTag(clean)}/dsh-agi-${clean}.tgz`
}

/** The registry sources the check probes; `DSH_AGI_UPDATE_REGISTRIES` re-points them (tests, mirrors). */
export function registryBases(): string[] {
  const configured = process.env.DSH_AGI_UPDATE_REGISTRIES?.trim()
  if (configured === undefined || configured === '') return [...REGISTRY_BASES]
  return configured
    .split(',')
    .map((base) => base.trim().replace(/\/+$/, ''))
    .filter((base) => base !== '')
}

/** The version a registry's dist-tag document names: `{"version":"0.2.0"}`. */
export function versionFromRegistry(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { version?: unknown }
    if (typeof parsed.version !== 'string') return undefined
    const version = parsed.version.trim().replace(/^v/, '')
    return version === '' ? undefined : version
  } catch {
    return undefined
  }
}

/** The tarball address a registry serves for a package version. */
export function registryTarballUrl(base: string, name: string, version: string): string {
  const clean = version.trim().replace(/^v/, '')
  return `${base.replace(/\/+$/, '')}/${name}/-/${name}-${clean}.tgz`
}

/**
 * The spec the installer receives: the GitHub release tarball for that version.
 * The package is not published on npm, so a registry spec (`name@version`) has
 * nothing to resolve. `DSH_AGI_UPDATE_URL` overrides the whole spec (tests,
 * staged releases).
 */
export function installSpec(version: string, name: string): string {
  const overridden = process.env.DSH_AGI_UPDATE_URL?.trim()
  if (overridden !== undefined && overridden !== '') return overridden
  return exactSpec(version, name)
}

/**
 * The release tarball for a version, ignoring the staged-update override. A rollback
 * must restore the version that was running, not whatever `DSH_AGI_UPDATE_URL` points at.
 */
function exactSpec(version: string, name: string): string {
  return releaseTarballUrl(version)
}

/**
 * Registry the manager should ask first: the one that answered the check, or
 * the primary mirror when this process has not checked yet. The manager still
 * falls through to its own list when this registry is one of them.
 */
export function installRegistry(source: string | undefined): string {
  return source ?? REGISTRY_BASES[0] ?? 'https://registry.npmmirror.com'
}

/**
 * Text for a failed install. A specific manager code (incompatible version,
 * and so on) wins. `operation-error` is the manager's wrapper around a pnpm
 * failure, so the card shows the `ERR_PNPM_*` line from the diagnostic instead
 * of that wrapper.
 */
export function reportedInstallError(error: InstallResult['error']): string {
  const code = error?.code
  const lines = error?.diagnostic?.split('\n').map((line) => line.trim()).filter((line) => line !== '') ?? []
  if (code !== undefined && code !== '' && code !== 'operation-error') return code
  const detail = lines.find((line) => line.includes('ERR_PNPM_')) ?? lines[0]
  if (detail !== undefined && detail !== '') return detail.slice(0, 200)
  return code === undefined || code === '' ? 'operation-error' : code
}

/** A pnpm failure from replacing a package whose files Windows keeps locked. */
export function isLockedFileFailure(error: InstallResult['error']): boolean {
  const text = `${error?.code ?? ''}\n${error?.diagnostic ?? ''}`
  return /ERR_PNPM_EPERM|ERR_PNPM_EBUSY|\bEPERM\b|\bEBUSY\b/.test(text)
}

/**
 * A removal that failed before it deselected the bundle.
 * `not-removable` and `stop-profile` are decided before `selectBundle(false)`.
 * Anything later has already turned the bundle off, and leaving it that way
 * hides the ball until something selects it again.
 * @param error - the removal's error.
 * @returns true when the bundle is still selected.
 */
function removalStoppedBeforeDisable(error: InstallResult['error']): boolean {
  return error?.code === 'not-removable' || error?.code === 'stop-profile'
}

/**
 * Record the package as an explicit exemption from pnpm's minimum-release-age
 * gate. pnpm v11 defaults `minimumReleaseAge` to 24 hours, so a registry-named
 * resolution silently settles for an older version while a fresh release waits
 * out the cutoff (observed 2026-10-06: `dsh-agi` resolved to 0.1.1 everywhere
 * the hour after 0.1.2 shipped), and the manager's install pipeline verifies the
 * lockfile against the gate before pnpm's own auto-exemption can apply. The
 * entry is the bare package name — pnpm grants it to every version, and unlike
 * exact `name@version` entries it passes the lockfile verification path
 * reliably (observed: versioned entries still failed verification). The write
 * puts that name first among its own rules, because pnpm honours only the first
 * one (see `withReleaseAgeExclusion`).
 *
 * Called twice: once when the plugin starts, so the profile reads correctly
 * whatever route installed the version (pnpm's own auto-exemption appends a
 * `name@version` rule that an older rule shadows), and once before an update
 * installs. Best-effort: an unreadable or unexpected file skips the write, and
 * the caller proceeds on pnpm's own defaults.
 */
export function exemptReleaseAge(profileDir: string, name: string): void {
  const file = join(profileDir, 'pnpm-workspace.yaml')
  let next: string | undefined
  try {
    next = withReleaseAgeExclusion(readFileSync(file, 'utf8'), name)
  } catch {
    // No workspace file (dev checkout, older profile): nothing to exempt.
    return
  }
  if (next === undefined) return
  try {
    writeProfileFile(file, next)
  } catch (error) {
    // Still best-effort — the caller installs either way — but no longer silent: without the
    // exemption pnpm settles for the previous release for up to a day, which the user reads
    // as "the update did nothing".
    console.error(`dsh-agi: could not write the release-age exemption into ${file}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Replace a profile file atomically. The after-exit install script writes the same
 * `pnpm-workspace.yaml` (its build approvals), and a plain write would let a concurrent
 * reader — or pnpm itself — see a truncated document.
 *
 * Windows refuses to replace a file another process is holding — pnpm itself, OneDrive, a
 * scanner — with EPERM/EACCES/EBUSY, and the holder is normally gone within a moment, so the
 * rename is retried. The staged file never survives a failure: leaving it behind would put a
 * second copy of the profile's workspace file next to the real one.
 * @param file - absolute path of the profile file.
 * @param text - complete new contents.
 */
function writeProfileFile(file: string, text: string): void {
  const staged = `${file}.dsh-agi-tmp`
  writeFileSync(staged, text)
  try {
    renameWithRetry(staged, file)
  } catch (error) {
    rmSync(staged, { force: true })
    throw error
  }
}

/** Attempts, and the pause before each one, for a rename the system may be refusing for now. */
const PROFILE_RENAME_ATTEMPTS = 5
const PROFILE_RENAME_BACKOFF_MS = 50

/**
 * Rename with a short retry, for the destinations Windows can refuse while another process
 * holds them. Exported so the retry can be exercised without a real lock.
 * @param from - staged path.
 * @param to - destination path.
 * @param rename - the rename to perform; tests inject one that refuses.
 * @throws the last rename error once every attempt is used.
 */
export function renameWithRetry(
  from: string,
  to: string,
  rename: (from: string, to: string) => void = renameSync,
): void {
  for (let attempt = 1; ; attempt += 1) {
    try {
      rename(from, to)
      return
    } catch (error) {
      if (attempt >= PROFILE_RENAME_ATTEMPTS) throw error
      sleepSync(PROFILE_RENAME_BACKOFF_MS * attempt)
    }
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** The package an exemption entry names, with any version or version union dropped. */
function excludedPackageName(entry: string): string {
  const at = entry.startsWith('@') ? entry.indexOf('@', 1) : entry.indexOf('@')
  return at === -1 ? entry : entry.slice(0, at)
}

/**
 * Write the package's exemption as the first entry of the profile's
 * `minimumReleaseAgeExclude` block, replacing whatever rules the file already
 * carried for the same name.
 *
 * pnpm's `evaluateVersionPolicy` returns at the FIRST rule whose package name
 * matches, so a rule only counts when nothing of the same name precedes it
 * (pnpm #732). Appending the bare name — what this used to do — is therefore
 * dead the moment any `name@version` rule sits earlier, and pnpm appends such a
 * rule for every young version it installs, so the file grows one shadowing
 * entry per release. The result is a profile where the package is not actually
 * exempt: `pnpm remove` re-resolves the young dependency, produces a
 * resolution-policy violation, and aborts with
 * `ERR_PNPM_RESOLUTION_POLICY_VIOLATIONS_UNHANDLED` (its remove path never wires
 * the violation callback), which blocks uninstalling ANY other plugin until the
 * version ages past the cutoff.
 *
 * A bare name exempts every version, so the same-name `name@version` rules a
 * profile collected are dropped instead of being left to shadow it later, and
 * the bare entry is written first. Other packages' lines keep their order and
 * spelling. Returns the new text, or undefined when the file already reads that
 * way or is not the block list pnpm writes.
 */
export function withReleaseAgeExclusion(text: string, name: string): string | undefined {
  if (name === '') return undefined
  const lines = text.split('\n')
  let key = -1
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (line === 'minimumReleaseAgeExclude:') {
      key = index
      break
    }
    // Inline arrays and shorthand are not pnpm's own output: leave them alone.
    if (/^minimumReleaseAgeExclude\s*:/.test(line)) return undefined
  }
  // `@` cannot start a plain YAML scalar, so a scoped name is quoted the way pnpm writes one.
  const entry = name.startsWith('@') ? `'${name.replaceAll("'", "''")}'` : name
  if (key === -1) {
    const head = text === '' || text.endsWith('\n') ? text : `${text}\n`
    return `${head}minimumReleaseAgeExclude:\n  - ${entry}\n`
  }
  // One rule per name: this package's own lines are replaced by the bare entry,
  // and a file that already reads that way is left byte for byte.
  const kept: string[] = []
  let indent: string | undefined
  let seen = 0
  let bareFirst = false
  let index = key + 1
  for (; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const written = /^([ \t]+)-[ \t]+\S/.exec(line)
    if (written === null) break
    indent ??= written[1]
    const body = line.slice(line.indexOf('-') + 1).trim().replace(/^['"]|['"]$/g, '')
    if (excludedPackageName(body) === name) {
      if (seen === 0) bareFirst = body === name
      seen += 1
      indent = written[1] ?? indent
      continue
    }
    kept.push(line)
  }
  if (bareFirst && seen === 1) return undefined
  const updated = [...lines.slice(0, key + 1), `${indent ?? '  '}- ${entry}`, ...kept, ...lines.slice(index)].join('\n')
  return updated === text ? undefined : updated
}

/** The version a release names: `plugin-v0.2.0` → `0.2.0`. */
export function versionFromRelease(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { tag_name?: unknown }
    if (typeof parsed.tag_name !== 'string') return undefined
    const version = parsed.tag_name.trim().replace(/^plugin-v/, '')
    return version === '' ? undefined : version
  } catch {
    return undefined
  }
}

function splitVersion(value: string): { main: number[]; pre: string } {
  const trimmed = value.trim().replace(/^v/, '')
  const dash = trimmed.indexOf('-')
  const head = dash === -1 ? trimmed : trimmed.slice(0, dash)
  const pre = dash === -1 ? '' : trimmed.slice(dash + 1)
  const main = head.split('.').map((part) => {
    const parsed = Number.parseInt(part, 10)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
  })
  return { main, pre }
}

function comparePrerelease(left: string, right: string): number {
  const a = left.split('.')
  const b = right.split('.')
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const one = a[index]
    const other = b[index]
    if (one === undefined) return -1
    if (other === undefined) return 1
    if (one === other) continue
    const oneNumber = /^\d+$/.test(one) ? Number.parseInt(one, 10) : undefined
    const otherNumber = /^\d+$/.test(other) ? Number.parseInt(other, 10) : undefined
    if (oneNumber !== undefined && otherNumber !== undefined) return oneNumber < otherNumber ? -1 : 1
    if (oneNumber !== undefined) return -1
    if (otherNumber !== undefined) return 1
    return one < other ? -1 : 1
  }
  return 0
}

/**
 * Fetch a plain-text body. HTTPS answers are pinned to https end to end; a
 * plain-http address (the local mock) keeps its scheme so the loopback works.
 * Resolves `''` when the server answers 404, `undefined` when the transfer
 * fails or answers with another non-2xx status.
 */
async function curlText(url: string): Promise<string | undefined> {
  const proto = url.startsWith('https://') ? ['--proto', '=https', '--proto-redir', '=https'] : []
  // The Windows schannel backend aborts the handshake when a certificate
  // revocation check cannot complete — common behind proxies. Skipping it costs
  // no trust here (the answer is data, not code); other backends ignore the flag.
  const tls = process.platform === 'win32' ? ['--ssl-no-revoke'] : []
  return new Promise((resolve) => {
    const child = spawn('curl', [
      '-sSL',
      ...proto,
      ...tls,
      '--connect-timeout', '5',
      '--max-time', '15',
      '-w', '\n%{http_code}',
      url,
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr.resume()
    child.once('error', () => { resolve(undefined) })
    child.once('exit', (code) => {
      if (code !== 0) return resolve(undefined)
      const text = Buffer.concat(out).toString('utf8')
      const cut = text.lastIndexOf('\n')
      const status = cut === -1 ? '' : text.slice(cut + 1).trim()
      const body = cut === -1 ? '' : text.slice(0, cut)
      if (status === '404') return resolve('')
      resolve(status.startsWith('2') ? body : undefined)
    })
  })
}
