/**
 * An update that has to wait until this process exits.
 * When a native image inside the package is still mapped (see `native-images.ts`),
 * asking pnpm to replace the package now would fail and take the live package
 * apart. The update is handed to a small detached script outside the package
 * instead: it waits for this process to exit, then runs the same pnpm the
 * official plugin manager uses. A status file marks the install as running so the
 * next start does not load a package that is being replaced; its outcome is read
 * back once the script writes one.
 */

import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** What the detached script installs, and whose exit it waits for. */
export interface DeferredInstall {
  readonly profileDir: string
  readonly spec: string
  /** Version the spec installs, for the page that shows the queued update after a reload. */
  readonly version?: string
  readonly registry: string
  readonly parentPid: number
  /** Approvals the settings page granted; the script merges them into the profile before pnpm runs. */
  readonly approvedBuilds: readonly string[]
  /** Package name and version, so the script can leave a stable npm spec behind. */
  readonly name?: string
  /** Bundle list before the install: the script merges it back into the profile afterwards. */
  readonly bundles?: readonly string[]
}

/** A queued after-exit install, read back by a plugin instance that did not schedule it. */
export interface PendingDeferredInstall {
  readonly spec: string
  /** Version the job installs; absent on a job written before this field existed. */
  readonly version: string | undefined
}

/** How the last deferred install ended. */
export interface DeferredOutcome {
  readonly spec: string
  readonly ok: boolean
  readonly detail: string
}

/** Marks an install the after-exit script is running right now. */
interface DeferredStatus {
  readonly phase: 'installing'
  readonly spec?: unknown
  readonly version?: unknown
  readonly pid?: unknown
  readonly startedAt?: unknown
}

/**
 * How long a status file without an outcome is still trusted. The script runs at most three
 * 15-minute pnpm attempts plus its waits (~45 minutes), so anything older cannot be live.
 * The ceiling exists because the script runs pnpm as its own child: killing the script
 * orphans that pnpm, which keeps replacing the package with nobody left to write an outcome.
 */
export const DEFERRED_INSTALL_CEILING_MS = 47 * 60 * 1000

/**
 * How long a job file whose owner has exited still counts as an install about to run. The
 * script touches the job file every 500 ms while it waits for that exit, so a fresh job file
 * means the script is in the seconds before it writes its status; a stale one means the
 * script died before pnpm ever started, and nothing is being replaced.
 */
export const DEFERRED_INSTALL_PENDING_MS = 30 * 1000

/** Folder under the profile that holds the job, the script, its log, and its outcome. */
export function deferredDir(profileDir: string): string {
  return join(profileDir, '.dsh-agi-update')
}

/**
 * Write the job and start the detached script. It runs on this executable with
 * `ELECTRON_RUN_AS_NODE`, so it needs no Node on PATH, and from the profile folder,
 * so it holds nothing open inside the package it replaces.
 */
export function scheduleInstallAfterExit(job: DeferredInstall): void {
  const dir = deferredDir(job.profileDir)
  mkdirSync(dir, { recursive: true })
  rmSync(join(dir, 'result.json'), { force: true })
  const jobFile = join(dir, 'job.json')
  const script = join(dir, 'apply.mjs')
  writeFileSync(jobFile, `${JSON.stringify(job, null, 2)}\n`)
  writeFileSync(script, APPLY_SCRIPT)
  const child = spawn(process.execPath, [script, jobFile], {
    cwd: job.profileDir,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
}

/** The outcome a previous run's script left, removed once read. */
export function takeDeferredOutcome(profileDir: string): DeferredOutcome | undefined {
  const file = join(deferredDir(profileDir), 'result.json')
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
  try {
    rmSync(file, { force: true })
  } catch (error) {
    // A locked result (indexer, antivirus) is read again next start; the outcome is
    // reported now either way, and a throw here would fail the caller's start path.
    console.error(`dsh-agi: could not clear the install outcome: ${errorDetail(error)}`)
  }
  try {
    const parsed = JSON.parse(raw) as Partial<DeferredOutcome>
    if (typeof parsed.spec !== 'string' || typeof parsed.ok !== 'boolean') return undefined
    return { spec: parsed.spec, ok: parsed.ok, detail: typeof parsed.detail === 'string' ? parsed.detail : '' }
  } catch {
    return undefined
  }
}

/**
 * Whether the after-exit script is installing right now. The script's own status file is
 * the signal: it exists while pnpm runs and is removed once the outcome is written. Before
 * that file exists the script is either still waiting for its owner (the package is
 * untouched, the ball may run) or in the seconds between that exit and pnpm, which
 * {@link installPendingAfterExit} covers. A status whose script died is only trusted until
 * the script's own ceiling passes; then the leftover is collected as a failed outcome so
 * the host can start.
 * @param profileDir - profile that scheduled the install.
 * @returns true while a live install is running.
 */
export function deferredInstallInProgress(profileDir: string): boolean {
  const dir = deferredDir(profileDir)
  let raw: string
  try {
    raw = readFileSync(join(dir, 'status.json'), 'utf8')
  } catch {
    // No status yet: the script may be in its pre-status window — unless the outcome is already
    // on disk, which means it is not in that window at all. The script writes `result.json`
    // last, and `scheduleInstallAfterExit` clears any earlier one before it writes the job, so
    // a lingering outcome belongs to this job: on Windows a lock on `job.json` can leave the
    // pending latch fresh after the script has finished, and reading that as "installing"
    // reports a finished install as running and holds the start path back.
    return outcomeWritten(dir) ? false : installPendingAfterExit(dir)
  }
  if (outcomeWritten(dir)) return false
  let status: DeferredStatus | undefined
  try {
    status = JSON.parse(raw) as DeferredStatus
  } catch {
    status = undefined
  }
  if (scriptAlive(Number(status?.pid))) return true
  // The status file is written by the script itself, so a dead pid means the script was
  // killed before pnpm finished and no outcome will ever arrive. Collect it now instead of
  // holding the plugin back for the ceiling: a killed updater must not hide the ball.
  try {
    rmSync(join(dir, 'status.json'), { force: true })
  } catch (error) {
    console.error(`dsh-agi: could not clear the stalled install status: ${errorDetail(error)}`)
    return false
  }
  const spec = typeof status?.spec === 'string' ? status.spec : ''
  try {
    writeFileSync(join(dir, 'result.json'), `${JSON.stringify({ spec, ok: false, detail: 'deferred-install-stalled' })}\n`)
  } catch {
    // The profile folder is gone; nothing to report.
  }
  return false
}

/**
 * Whether the folder already holds an outcome for its install. The pair `status.json` /
 * `result.json` is the whole state: the script writes the status first and the outcome last,
 * and the outcome outlives the status file.
 * @param dir - the profile's `.dsh-agi-update` folder.
 * @returns true once the install has written its result.
 */
function outcomeWritten(dir: string): boolean {
  try {
    return statSync(join(dir, 'result.json')).isFile()
  } catch {
    // No outcome yet: the install is still running or the script died.
    return false
  }
}

/**
 * Whether a scheduled install's owner has exited, so its script is in the ~2 s before it
 * writes its status file. The script touches the job file every 500 ms while it waits, so a
 * fresh job file plus a dead owner is an install about to run; a stale one is a script that
 * died before pnpm ever started, which replaced nothing.
 * @param dir - the profile's `.dsh-agi-update` folder.
 * @returns true while the install is about to touch the package.
 */
function installPendingAfterExit(dir: string): boolean {
  const file = join(dir, 'job.json')
  let parentPid: unknown
  try {
    parentPid = (JSON.parse(readFileSync(file, 'utf8')) as { parentPid?: unknown }).parentPid
  } catch {
    return false
  }
  const pid = Number(parentPid)
  // The owner is alive: the install waits for its exit and the package is untouched.
  if (!Number.isInteger(pid) || pid <= 0 || scriptAlive(pid)) return false
  try {
    return Date.now() - statSync(file).mtimeMs <= DEFERRED_INSTALL_PENDING_MS
  } catch {
    return false
  }
}

/**
 * The after-exit install queued for this profile, when it is still going to run.
 * The job file outlives the plugin instance that wrote it, so a page reloaded by
 * a bundle toggle can still say "installs once the app quits" instead of offering
 * the same update again. A finished install (result on disk) and a job whose
 * script never started (stale heartbeat) are not pending.
 * @param profileDir - profile that scheduled the install.
 * @returns the queued spec and version, or undefined when nothing is waiting.
 */
export function pendingDeferredInstall(profileDir: string): PendingDeferredInstall | undefined {
  const dir = deferredDir(profileDir)
  if (outcomeWritten(dir)) return undefined
  // A live status means the script is installing, which `deferredInstallInProgress`
  // reports as `installing`; only the wait before that is the deferred state.
  const status = readDeferredStatus(dir)
  if (status !== undefined && statusIsLive(status)) return undefined
  const job = readDeferredJob(dir)
  if (job === undefined) return undefined
  const pid = Number(job.parentPid)
  if (Number.isInteger(pid) && pid > 0 && scriptAlive(pid)) {
    return { spec: job.spec, version: textField(job.version) ?? versionFromSpec(job.spec) }
  }
  // The owner is gone. Only a job its script still touches is about to run.
  try {
    if (Date.now() - statSync(join(dir, 'job.json')).mtimeMs > DEFERRED_INSTALL_PENDING_MS) return undefined
  } catch {
    return undefined
  }
  return { spec: job.spec, version: textField(job.version) ?? versionFromSpec(job.spec) }
}

/** The job a {@link scheduleInstallAfterExit} call wrote, when it is readable. */
function readDeferredJob(dir: string): DeferredInstall | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, 'job.json'), 'utf8')) as Partial<DeferredInstall>
    if (typeof parsed.spec !== 'string' || parsed.spec === '') return undefined
    return parsed as DeferredInstall
  } catch {
    return undefined
  }
}

/** The status file of a running script, when it is readable. */
function readDeferredStatus(dir: string): DeferredStatus | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8')) as DeferredStatus | null
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

/** A status whose script is alive, or whose start is inside the script's own ceiling. */
function statusIsLive(status: DeferredStatus): boolean {
  if (scriptAlive(Number(status.pid))) return true
  const started = Number(status.startedAt)
  return Number.isFinite(started) && Date.now() - started <= DEFERRED_INSTALL_CEILING_MS
}

/** A non-empty string field, or undefined for anything else. */
function textField(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** The version a `name@version` spec ends with; undefined for a URL or an unscoped path. */
function versionFromSpec(spec: string): string | undefined {
  const at = spec.lastIndexOf('@')
  return at > 0 && at < spec.length - 1 ? spec.slice(at + 1) : undefined
}

/** Message of an unknown error, for the log lines that must never throw. */
function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The script's own `alive()`: a process that answers EPERM is running under another user. */
function scriptAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as { code?: unknown } | undefined)?.code === 'EPERM'
  }
}

/**
 * Merge `builds` into the profile's top-level `allowBuilds` mapping, the key the shipped
 * pnpm 11 reads for install-script approvals (the official plugin manager writes the same
 * shape: `allowBuilds: { name: true }`). An existing `false` for an approved name is set
 * back to `true` — the user just approved that build. Other keys, including the release-age
 * exemption, are left exactly as they are. Unfamiliar shapes are left alone: pnpm's next
 * write repairs them.
 * @param text - current `pnpm-workspace.yaml`, empty when the profile has none.
 * @param builds - approved package names.
 * @returns the updated file, or undefined when nothing needs to change.
 */
export function mergeApprovedBuilds(text: string, builds: readonly string[]): string | undefined {
  if (builds.length === 0) return undefined
  const lines = text.split('\n')
  let key = -1
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (line === 'allowBuilds:') {
      key = index
      break
    }
    // Flow mappings and shorthand are not pnpm's own output: leave them alone.
    if (/^allowBuilds\s*:/.test(line)) return undefined
  }
  if (key === -1) {
    const head = text === '' || text.endsWith('\n') ? text : text + '\n'
    return head + 'allowBuilds:\n' + builds.map((name) => '  ' + yamlScalar(name) + ': true').join('\n') + '\n'
  }
  const kept: string[] = []
  const values: string[] = []
  const at = new Map<string, number>()
  let indent = '  '
  let index = key + 1
  for (; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    // A block-mapping entry: `  name: true`, with an optional trailing comment.
    const written = /^([ \t]+)(\S.*?)\s*:\s*([^\s#]*)\s*(?:#.*)?$/u.exec(line)
    if (written === null) break
    indent = written[1] ?? indent
    at.set(unquote(written[2] ?? ''), kept.length)
    values.push(written[3] ?? '')
    kept.push(line)
  }
  let changed = false
  const added: string[] = []
  for (const name of builds) {
    const position = at.get(name)
    if (position === undefined) {
      added.push(indent + yamlScalar(name) + ': true')
      changed = true
      continue
    }
    // Only a written-out `false` is flipped; a nested or shorthand value stays untouched.
    if (values[position] === 'false') {
      kept[position] = indent + yamlScalar(name) + ': true'
      changed = true
    }
  }
  if (!changed) return undefined
  return [...lines.slice(0, key + 1), ...kept, ...added, ...lines.slice(index)].join('\n')
}

/** `@` cannot start a plain YAML scalar, so a scoped name is quoted the way pnpm writes one. */
function yamlScalar(name: string): string {
  return name.startsWith('@') ? "'" + name.replaceAll("'", "''") + "'" : name
}

function unquote(entry: string): string {
  const first = entry.slice(0, 1)
  const last = entry.slice(-1)
  if ((first === "'" || first === '"') && last === first) return entry.slice(1, -1)
  return entry
}

/**
 * The detached script. Self-contained: the package it replaces may be gone by the
 * time it runs. On the desktop it uses the pnpm the app ships in `resources/runtime`
 * with the environment the plugin manager gives it; elsewhere (`dsh web`) the `pnpm`
 * on PATH.
 * The approval helpers below are embedded as their own source, so the script and the
 * tested functions cannot drift apart.
 */
const APPLY_SCRIPT = `import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'

const jobFile = process.argv[2]
const dir = dirname(jobFile)
const job = JSON.parse(readFileSync(jobFile, 'utf8'))
const log = (line) => appendFileSync(join(dir, 'apply.log'), new Date().toISOString() + ' ' + line + '\\n')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/** Replace a profile file atomically: a concurrent reader never sees a half-written YAML. */
function writeAtomic(file, text) {
  const staged = file + '.dsh-agi-tmp'
  writeFileSync(staged, text)
  renameSync(staged, file)
}

${yamlScalar.toString()}

${unquote.toString()}

${mergeApprovedBuilds.toString()}

function pnpm() {
  const support = join(dirname(process.execPath), 'resources', 'runtime')
  const bundled = join(support, 'pnpm', 'bin', 'pnpm.mjs')
  if (existsSync(bundled)) {
    return {
      command: process.execPath,
      args: ['--expose-internals', bundled],
      shell: false,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        DSH_DESKTOP_NODE_EXECUTABLE: process.execPath,
        PATH: join(support, 'bin') + delimiter + (process.env.PATH ?? ''),
      },
    }
  }
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  return { command: 'pnpm', args: [], shell: process.platform === 'win32', env }
}

log('waiting for process ' + job.parentPid + ' to exit before installing ' + job.spec)
while (alive(job.parentPid)) {
  // Touch the job file while waiting: a start that finds a dead owner and a fresh job knows
  // pnpm is about to run, which closes the gap before status.json exists. A stale job means
  // this script died before pnpm started, so nothing was replaced.
  try { utimesSync(jobFile, new Date(), new Date()) } catch (error) { log('could not touch the job file: ' + String(error)) }
  await sleep(500)
}
await sleep(1500)

// The status file marks this install as running before pnpm touches the profile, so a start
// during the install knows not to load the package being replaced. It goes away with the
// outcome: the pair is the whole state, and neither half is ever read alone.
writeFileSync(join(dir, 'status.json'), JSON.stringify({ phase: 'installing', spec: job.spec, version: job.version, pid: process.pid, startedAt: Date.now() }) + '\\n')
try {
  const approved = job.approvedBuilds ?? []
  if (approved.length > 0) {
    const file = join(job.profileDir, 'pnpm-workspace.yaml')
    const before = existsSync(file) ? readFileSync(file, 'utf8') : ''
    const after = mergeApprovedBuilds(before, approved)
    if (after !== undefined) writeAtomic(file, after)
    log('approved builds: ' + approved.join(', '))
  }
} catch (error) {
  log('could not write approved builds: ' + String(error))
}

const { command, args, shell, env } = pnpm()
const argv = [...args, 'add', job.spec, '--save-exact', '--registry=' + job.registry]
let ok = false
let detail = ''
for (let attempt = 1; attempt <= 3 && !ok; attempt += 1) {
  const run = spawnSync(command, argv, { cwd: job.profileDir, env, shell, encoding: 'utf8', windowsHide: true, timeout: 15 * 60 * 1000 })
  const output = (run.stdout ?? '') + (run.stderr ?? '') + (run.error ? String(run.error) : '')
  log('attempt ' + attempt + ' exited ' + run.status + '\\n' + output)
  ok = run.status === 0
  if (!ok) {
    detail = output.split('\\n').map((line) => line.trim()).find((line) => line.includes('ERR_PNPM_')) ?? output.trim().split('\\n').pop() ?? 'pnpm failed'
    await sleep(3000)
  }
}
if (ok) {
  // The app is gone: do not launch it for the user (a client started by the installer
  // inherits its console and breaks the next update). Show a clear prompt instead.
  try {
    // Timeout 0: the dialog stays until the user acknowledges it. They may have stepped
    // away while the install ran; a message that auto-closes can be missed entirely.
    const popup = "$ws = New-Object -ComObject WScript.Shell; $ws.Popup('更新完成，现在可以启动 DeepSeek Harness 了。',0,'dsh-agi',64) | Out-Null"
    const encoded = Buffer.from(popup, 'utf16le').toString('base64')
    spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: 60 * 1000 })
  } catch (error) {
    log('notification failed: ' + String(error))
  }
}
if (ok) {
  // pnpm rewrites the profile manifest. Put back the bundle entries that were there before
  // the install, and keep an npm version instead of the temporary tarball path it records.
  try {
    const file = join(job.profileDir, 'package.json')
    const current = JSON.parse(readFileSync(file, 'utf8'))
    const bundles = current?.dsh?.profile?.bundles
    const list = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [])
    if (job.bundles !== undefined) {
      current.dsh = current.dsh ?? {}
      current.dsh.profile = current.dsh.profile ?? {}
      current.dsh.profile.bundles = [...new Set([...list(bundles), ...list(job.bundles)])]
    }
    if (typeof job.name === 'string' && typeof job.version === 'string' && job.version !== '') {
      current.dependencies = current.dependencies ?? {}
      current.dependencies[job.name] = job.version.replace(/^v/, '')
    }
    writeFileSync(file, JSON.stringify(current, null, 2) + String.fromCharCode(10))
    log('profile restored: bundles=' + list(current?.dsh?.profile?.bundles).length)
  } catch (error) {
    log('profile restore failed: ' + String(error))
  }
}
writeFileSync(join(dir, 'result.json'), JSON.stringify({ spec: job.spec, ok, detail: detail.slice(0, 200) }) + '\\n')
// The outcome is on disk now, so a lock on either leftover must not take the script down:
// status.json without result.json would read as a dead install, and job.json has to go or it
// reads as a pending one until its mtime ages out.
try { rmSync(join(dir, 'status.json'), { force: true }) } catch (error) { log('could not clear the status file: ' + String(error)) }
try { rmSync(jobFile, { force: true }) } catch (error) { log('could not clear the job file: ' + String(error)) }
log(ok ? 'installed ' + job.spec : 'gave up on ' + job.spec)
`
