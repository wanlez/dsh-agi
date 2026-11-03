/**
 * Host-side Orb plugin.
 * The ball is a separate Electron process. This plugin owns the socket, the preferences, and the Computer Use session.
 */

import { randomUUID } from 'node:crypto'
import { cpSync, existsSync, readdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { TccMonitor } from './tcc.ts'
import { imageDebug } from './debug-log.ts'
import { profileDirectory, ProfileStore } from './preferences.ts'
import { registerOrbRoutes } from './routes.ts'
import { installOrbServices, watchOrbPermissions } from './services.ts'
import { watchAppearance } from './appearance.ts'
import { OrbRuntime, type OrbContext, type PreStepMessage } from './orb.ts'
import { exemptReleaseAge, ownPackage, UpdateChecker } from './update.ts'
import { DEFERRED_INSTALL_CEILING_MS, deferredInstallInProgress } from './deferred-install.ts'
import { KOFFI_DIR_ENV, ownPackageRoot, removeStaleStages, stageKoffi } from './native-images.ts'

/** Cordis plugin name. */
export const name = 'agi-host'

/** Official services this plugin reads. Missing ones keep it pending. */
export const inject = [
  'webServer',
  'connection',
  'sessionController',
  'workspaceController',
  'sessions',
  'agentDefaultModel',
  // The composer uploads screenshots through this store; a Host without it keeps text-only.
  'attachments',
]

export type { OrbContext }

/**
 * Move what the pre-rename plugin wrote into the harness home to the current names: the two
 * data folders, the session folders whose names carry the old workspace path, and the
 * profile's `orb-*.json` files.
 *
 * Every step is best-effort: a profile that was already migrated (the new name exists) is
 * left alone, and a file the OS refuses to move is simply not migrated.
 * @param profileDir - profile directory that may still hold `orb-*.json` files.
 */
function migrateLegacyOrbData(profileDir: string): void {
  try {
    const home = dshHomePath()
    for (const [legacyName, nextName] of [['dsh-orb', 'dsh-agi'], ['dsh_orb', 'dsh_agi']] as const) {
      const legacy = join(home, legacyName)
      const next = join(home, nextName)
      if (!existsSync(legacy) || existsSync(next)) continue
      try {
        renameSync(legacy, next)
      } catch {
        // A folder held open somewhere cannot be renamed; a copy still saves the data.
        try {
          cpSync(legacy, next, { recursive: true })
        } catch {
          // Left for the next start.
        }
      }
      console.error(`dsh-agi: migrated ${legacyName} -> ${nextName}`)
    }
    // Session folders are named after the workspace path, so their names carry the old
    // spelling; renaming them is what makes the old conversations findable again.
    const sessionsRoot = join(home, 'sessions')
    for (const name of readdirSync(sessionsRoot)) {
      if (!name.includes('dsh_orb')) continue
      const next = name.split('dsh_orb').join('dsh_agi')
      if (existsSync(join(sessionsRoot, next))) continue
      try {
        renameSync(join(sessionsRoot, name), join(sessionsRoot, next))
        console.error(`dsh-agi: migrated sessions dir ${name}`)
      } catch {
        // A folder in use stays where it is.
      }
    }
  } catch {
    // No harness home or no sessions root yet: nothing to migrate.
  }
  try {
    for (const name of readdirSync(profileDir)) {
      const match = /^orb-(.+)\.json$/.exec(name)
      if (match === null) continue
      const next = join(profileDir, `agi-${match[1]}.json`)
      if (existsSync(next)) continue
      try {
        // Copied, not moved: an older build of the plugin still needs its own file.
        cpSync(join(profileDir, name), next)
      } catch {
        // The setting falls back to its default.
      }
    }
  } catch {
    // An unreadable profile directory only costs the migration.
  }
}

/**
 * Register preferences, Computer Use services, and settings routes, then start the ball.
 * Linux never starts the helper. `autoStart: false` and `ball-enabled.json` leave Computer Use in the main window.
 * @param ctx - host services named in {@link inject}.
 * @param config - patch config. `autoStart: false` skips the helper until settings turn it back on.
 */
export function apply(ctx: OrbContext, config: { autoStart?: boolean } = {}): void {
  logWebPort(ctx)
  const own = ownPackage()
  const profile = profileDirectory(ctx)
  const installing = deferredInstallInProgress(profile)
  if (installing) {
    // The after-exit script is replacing this package right now. Staging koffi, loading it,
    // or starting the helper would fight the running pnpm, so the ball waits for the outcome.
    console.error('dsh-agi: an update install is running; the ball waits for it to finish')
  } else if (process.platform === 'win32' && own !== undefined) {
    // Before anything loads koffi: a loaded addon inside the package locks it against
    // the next update on Windows (see native-images.ts).
    stageNativeImages()
  }
  // The fork was called dsh-orb before it was called dsh-agi. Move what the old name left
  // behind before any profile file is read, or the user starts over with their settings gone.
  migrateLegacyOrbData(profile)
  // A track the user never picked in the ball follows the model fallback the runtime
  // refreshes from the live catalog and the main window's default — the route the
  // official sign-in points at the account once the profile has no API key.
  const store = new ProfileStore(profile)
  // pnpm appends a `name@version` rule for every young release it installs and reads
  // only the first rule per package name, so a profile that installed this plugin
  // through the market or `dsh plugin install` holds an exemption that shadows the
  // installed version — and then removing ANY other plugin fails with
  // ERR_PNPM_RESOLUTION_POLICY_VIOLATIONS_UNHANDLED. Re-canonicalise the list at
  // start, whatever route installed the version. While an install runs, the after-exit
  // script writes build approvals into the same file, so this waits for the outcome
  // rather than racing it (see the wait branch below).
  if (own !== undefined && !installing) exemptReleaseAge(store.dir, own.name)
  const tcc = new TccMonitor()
  const runtime = new OrbRuntime(ctx, store, { tcc })
  imageDebug(`boot attachments=${typeof ctx.attachments} saveImage=${typeof ctx.attachments?.saveImage} get=${typeof ctx.get}`)
  // Character card and this turn's screenshots reach the model through this hook. Both are
  // appended to the step the rest of the plugin stack already admitted, and the card is only
  // injected into the ball's own conversation — the main window and background agents keep
  // their own prompts.
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    try {
      if (decision.kind === 'reject' || !Array.isArray(decision.messages)) return decision
      const session = payload.agent?.session
      const rawId = session?.id ?? session?.sessionId
      const sessionId = typeof rawId === 'string' ? rawId : undefined
      const extras: PreStepMessage[] = []
      const persona = sessionId !== undefined && sessionId === runtime.currentSessionId() ? runtime.personaForPrompt() : ''
      if (persona !== '') imageDebug(`persona inject chars=${persona.length} session=${sessionId}`)
      if (persona !== '') {
        extras.push({
          role: 'user',
          id: randomUUID(),
          content: [{
            type: 'text',
            text: `【角色卡·长期设定，优先级高于默认语气】始终按下面的人设称呼和说话（这不是用户的新指令，也不要复述它）：\n${persona}`,
          }],
          source: { kind: 'computer-use', form: 'notice', summary: 'Persona card' },
        })
      }
      const pending = runtime.peekPendingImages(sessionId)
      if (pending !== undefined) {
        const blocks = pending.blocks
        imageDebug(`pre-step attach images=${blocks.length} session=${sessionId}`)
        const paths = pending.paths
        // Naming the staged copies is what lets the agent file them into the experience
        // library by path instead of guessing where the bytes live.
        const intro = paths.length === 0
          ? '用户这一轮附带的截图：'
          : `用户这一轮附带的截图（原图已存到：${paths.join('；')}。写经验库时请把它们复制进 <经验库>/<流程名>/screenshots/ 并改成有含义的名字）：`
        extras.push({
          role: 'user',
          id: randomUUID(),
          content: [{ type: 'text', text: intro }, ...blocks],
          source: { kind: 'computer-use', form: 'notice', summary: 'User attached screenshots' },
        })
      }
      if (extras.length === 0) return decision
      return { ...decision, messages: [...decision.messages, ...extras] }
    } catch (error) {
      imageDebug(`pre-step failed: ${error instanceof Error ? error.message : String(error)}`)
      return decision
    }
  })
  // Warm the unpicked-track fallback before anything reads a model, so the settings page
  // shows what a session would use even when the ball never starts.
  void runtime.refreshModelDefaults()
  installOrbServices(ctx, store)
  // The official plugin manager mounts after this plugin, so it is read live and an
  // absent one only costs the one-click upgrade: the check and the notice stay.
  const updater = new UpdateChecker({
    store,
    manager: () => ctx.get('pluginManager'),
    notify: (version) => { runtime.setUpdateAvailable(version) },
  })
  runtime.useUpdater(updater)
  console.error(`dsh-agi: profile ${store.dir}`)
  console.error(`dsh-agi: version ${updater.state().currentVersion || 'unknown'}`)
  ctx.effect(() => {
    const detachQuestions = runtime.attachQuestions()
    const detachPermissions = watchOrbPermissions(ctx, store)
    const detachRoutes = registerOrbRoutes({ ctx, store, tcc, control: runtime })
    // Theme and locale follow the official settings document; a missing
    // settings service leaves the ball on its system defaults.
    const detachAppearance = watchAppearance(ctx, (appearance) => { runtime.setAppearance(appearance) })
    const detachUpdates = updater.start()
    const detachHistory = runtime.startHistory()
    const start = process.platform !== 'linux' && config.autoStart !== false && store.ballEnabled()
    let cancelled = false
    if (installing) {
      void waitForInstall(store.dir, () => cancelled).then(() => {
        if (cancelled) return
        // The outcome (and a stalled status) is collected the way every start collects it.
        updater.adoptDeferredOutcome()
        // The install owns `pnpm-workspace.yaml` until it writes its outcome; the
        // release-age exemption goes in only now, so neither write can drop the other.
        if (own !== undefined) exemptReleaseAge(store.dir, own.name)
        if (process.platform === 'win32' && own !== undefined) {
          // The gate above skipped staging: this start must not map koffi from inside the
          // package, or the next update is locked out of replacing it again. The package is
          // final now, so staging is safe.
          stageNativeImages()
        }
        if (!start) return
        return runtime.start()
      }).catch((error: unknown) => {
        // The chain must never reject: an unhandled rejection exits the official host.
        console.error(`dsh-agi: ${error instanceof Error ? error.message : String(error)}`)
      })
    } else if (start) {
      void runtime.start().catch((error: unknown) => {
        console.error(`dsh-agi: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
    return () => {
      cancelled = true
      detachQuestions()
      detachPermissions()
      detachRoutes()
      detachAppearance()
      detachUpdates()
      detachHistory()
      runtime.halt()
    }
  })
}

/**
 * Wait for the after-exit install to write its outcome, at most as long as the script itself
 * can run. A status file past that ceiling is collected as a failed outcome by
 * {@link deferredInstallInProgress}, so the wait always ends.
 * @param profileDir - profile that scheduled the install.
 * @param cancelled - true once the plugin was disposed; the wait then stops without starting.
 */
async function waitForInstall(profileDir: string, cancelled: () => boolean): Promise<void> {
  const deadline = Date.now() + DEFERRED_INSTALL_CEILING_MS
  while (!cancelled() && Date.now() < deadline && deferredInstallInProgress(profileDir)) {
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
}

/** Point every koffi loader at a copy outside the package and clear what failed updates left. */
function stageNativeImages(): void {
  const root = ownPackageRoot()
  try {
    const dir = stageKoffi(root, dshHomePath('dsh-agi', 'native'))
    if (dir !== undefined) process.env[KOFFI_DIR_ENV] = dir
  } catch (error) {
    console.error(`dsh-agi: koffi stays in the package: ${error instanceof Error ? error.message : String(error)}`)
  }
  removeStaleStages(root)
}

/** Print the loopback port. The authenticated URL contains credentials, so it is never logged. */
function logWebPort(ctx: OrbContext): void {
  const port = ctx.webServer.port
  try {
    const authed = ctx.connection.authenticatedUrl(`http://127.0.0.1:${port}`)
    const hostname = new URL(authed).hostname
    if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '[::1]') {
      console.error('dsh-agi: authenticated URL is not loopback')
    }
  } catch {
    console.error('dsh-agi: authenticated URL is unavailable')
  }
  console.error(`dsh-agi: host web port ${port}`)
}
