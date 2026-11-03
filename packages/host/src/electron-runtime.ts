/**
 * Locate the generic Electron binary used to open the ball.
 * Official DeepSeek Harness is not a usable helper runtime: it has its own app payload and a single-instance lock.
 */

import { spawn } from 'node:child_process'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, basename } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** Matches the official app's Electron framework and the fork's desktop package. */
const ELECTRON_VERSION = '44.0.0'

const RELEASE_BASE = `https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}`

/** Official SHASUMS256.txt for Electron 44.0.0. The download is rejected when it disagrees. */
export const PINNED_SHA256: Readonly<Record<string, string>> = {
  'electron-v44.0.0-darwin-arm64.zip': '076d79742986e1b100b69ebecc691cb07368045e54c9087cef631b8622b76a80',
  'electron-v44.0.0-darwin-x64.zip': '28429e700ad68d9624aaa90b6543ffe891a48c14121fd904cd294e5edcee63ff',
  'electron-v44.0.0-linux-arm64.zip': '74b6f18bc29c0d52cf8e963c45d476800419097c6f3d53b27c5df335207e52bb',
  'electron-v44.0.0-linux-x64.zip': 'd65286d812719f2b4c1a1b806a80f288a1058c89c7b058dae1e03ab25e499446',
  'electron-v44.0.0-win32-arm64.zip': '984c8f3b9ffaf3c0a3f3501c96277effc05a9f0df5a5d920b2610c09ebaf4368',
  'electron-v44.0.0-win32-x64.zip': 'e61aa3bcea8152bc0730abd015e47c032d778a0ef10e2a1c78ba3c4ea47942f9',
}

/** What {@link resolveElectronBinary} is busy with, for the settings page's progress line. */
export type ElectronRuntimePhase = 'downloading' | 'extracting'

/**
 * Marker for a step the user aborted with a manual redownload. It is not a download failure:
 * whoever cancelled the attempt owns the next one, so the caller must not count it.
 */
const CANCELLED_CODE = 'dsh-agi-download-cancelled'

/** The one download this process can have in flight; the lock serialises attempts across processes. */
let active: AbortController | undefined

function cancelled(): Error {
  return Object.assign(new Error('dsh-agi: Electron download cancelled'), { code: CANCELLED_CODE })
}

/** Whether a rejection is this module's own cancellation rather than a real download failure. */
export function isRuntimeDownloadCancelled(error: unknown): boolean {
  return (error as { code?: unknown } | undefined)?.code === CANCELLED_CODE
}

/**
 * Drop the download in flight, if any. The attempt unwinds at its next step and deletes its own
 * partial zip and staging folder on the way out.
 */
export function cancelRuntimeDownload(): void {
  const controller = active
  active = undefined
  controller?.abort()
}

/**
 * Delete what a killed process left behind: half-written downloads and `.electron-staging-*`
 * extraction folders. The resumable partial of this version's asset stays — a redownload
 * continues those bytes rather than fetching them twice.
 */
export async function purgeRuntimeArtifacts(): Promise<void> {
  const dir = dshHomePath('dsh-agi')
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return
  }
  const kept = basename(partialPath(dir, assetName()))
  for (const name of entries) {
    if (!name.startsWith('.electron-')) continue
    if (name === kept) continue
    await rm(join(dir, name), { recursive: true, force: true }).catch(() => undefined)
  }
}

/** The file one asset's transfer writes, and the one a later attempt resumes. */
function partialPath(parent: string, fileName: string): string {
  return join(parent, `.electron-${fileName}.partial`)
}

/** Size of a file, or 0 when it is not there: "no bytes to resume from" is not an error. */
async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

/**
 * Resolve the helper executable.
 * `DSH_AGI_ELECTRON_PATH` wins. Otherwise use the cached official zip, downloading it once.
 * @param report - optional phase callback; fires only when a download is actually needed.
 * @returns absolute path to the Electron executable.
 */
export async function resolveElectronBinary(
  report?: (phase: ElectronRuntimePhase) => void,
): Promise<string> {
  const override = process.env.DSH_AGI_ELECTRON_PATH?.trim()
  if (override) {
    await access(override)
    return override
  }
  const dest = dshHomePath('dsh-agi', 'electron-runtime')
  const binary = join(dest, binaryRelative())
  const marker = join(dest, `.complete-${ELECTRON_VERSION}`)
  if (await exists(binary) && await exists(marker)) return binary
  await downloadRuntime(dest, binary, marker, report)
  return binary
}

async function downloadRuntime(
  dest: string,
  binary: string,
  marker: string,
  report?: (phase: ElectronRuntimePhase) => void,
): Promise<void> {
  const parent = dirname(dest)
  await mkdir(parent, { recursive: true })
  const controller = new AbortController()
  active = controller
  const signal = controller.signal
  try {
    await withDownloadLock(parent, async () => {
      if (signal.aborted) throw cancelled()
      if (await exists(binary) && await exists(marker)) return
      const fileName = assetName()
      console.error(`dsh-agi: downloading Electron ${ELECTRON_VERSION} (${fileName})`)
      const sums = await fetchText('SHASUMS256.txt', signal)
      const expected = expectedHash(sums, fileName)
      // One stable partial per asset: a retry continues it instead of paying for the whole
      // 124–150 MB twice. Only the staging folder is stamped, and it never outlives one attempt.
      const zipPath = partialPath(parent, fileName)
      const staging = join(parent, `.electron-staging-${randomBytes(8).toString('hex')}`)
      try {
        report?.('downloading')
        const resumed = await fileSize(zipPath)
        if (resumed > 0) console.error(`dsh-agi: continuing from ${resumed} bytes left by an earlier attempt`)
        await downloadVerifiedZip(fileName, expected, zipPath, signal)
        report?.('extracting')
        await mkdir(staging, { recursive: true })
        await extractZip(zipPath, staging, signal)
        const stagedBinary = join(staging, binaryRelative())
        if (process.platform === 'darwin') {
          await spawnChecked('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', staging]).catch(() => undefined)
        }
        if (signal.aborted) throw cancelled()
        await chmod(stagedBinary, 0o755)
        await access(stagedBinary)
        await writeFile(join(staging, `.complete-${ELECTRON_VERSION}`), `${ELECTRON_VERSION}\n`)
        await replaceDirectory(staging, dest)
      } finally {
        await rm(staging, { recursive: true, force: true })
      }
      // Past the rename the zip has done its job. A failure above leaves it in place instead:
      // those bytes are exactly what the next attempt resumes from.
      await rm(zipPath, { force: true }).catch(() => undefined)
      console.error(`dsh-agi: Electron ${ELECTRON_VERSION} is ready`)
    }, signal)
  } finally {
    if (active === controller) active = undefined
  }
}

/**
 * Take the download lock. The owner file is written in a staging directory first, and the
 * directory is renamed into place: the lock only ever appears with its owner already inside,
 * so a second process can never read a half-made lock. A dead owner, or one past the
 * 20-minute ceiling, can be taken over.
 */
export async function withDownloadLock(
  parent: string,
  task: () => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  const lock = join(parent, 'electron-runtime.download.lock')
  const deadline = Date.now() + 10 * 60 * 1000
  for (;;) {
    // Checked first, so that every path is bounded — including the immediate retry after a stale
    // lock is swept. A rename refused for a reason other than a held lock (a handle on the
    // staging directory, a deny on the parent) must not turn this into an unbounded spin.
    if (Date.now() > deadline) throw new Error('dsh-agi: Electron download is locked by another process')
    if (signal?.aborted) throw cancelled()
    const staging = `${lock}.${randomBytes(6).toString('hex')}.tmp`
    try {
      await mkdir(staging)
      await writeFile(join(staging, 'owner'), `${process.pid}\n${Date.now()}\n`)
    } catch (error) {
      // The staging folder could not even be made: a permissions problem on the parent,
      // not a held lock, so it must surface instead of waiting the deadline out.
      await rm(staging, { recursive: true, force: true })
      throw error
    }
    try {
      // Atomic on one volume. The destination is a directory that already holds its owner,
      // and replacing one is refused: EEXIST/ENOTEMPTY on POSIX, EPERM or EACCES on
      // Windows, where MoveFileEx cannot swap a directory in place. All mean held.
      await rename(staging, lock)
      break
    } catch (error) {
      await rm(staging, { recursive: true, force: true })
      if (!isLockTaken(error)) throw error
      if (await lockExpired(lock)) {
        await rm(lock, { recursive: true, force: true })
        continue
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
  try {
    await task()
  } finally {
    await rm(lock, { recursive: true, force: true })
  }
}

/** Codes a failed rename of the staging directory onto the lock directory answers with when the lock is held. */
export function isLockTaken(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code
  return code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'EPERM' || code === 'EACCES'
}

/**
 * How long a lock's owner is believed before it is treated as a recycled pid. A transfer has no
 * total time limit — a slow line is allowed to finish — so this only has to outlast the longest
 * believable download, not the longest expected one.
 */
const STALE_OWNER_MS = 3 * 60 * 60 * 1000

export async function lockExpired(lock: string): Promise<boolean> {
  let text: string
  try {
    text = await readFile(join(lock, 'owner'), 'utf8')
  } catch (error) {
    if ((error as { code?: unknown } | undefined)?.code !== 'ENOENT') return false
    // An owner-less lock directory is what a crashed build left behind: it cannot belong to
    // a live acquisition (that one appears with its owner inside), so it is only swept once
    // the directory itself has been sitting there for a while.
    try {
      const info = await stat(lock)
      return Date.now() - info.mtimeMs > 30_000
    } catch {
      // The directory is gone: there is nothing to sweep, and "no lock at all" is not "an expired
      // lock". Answering true here would send the caller straight back around with no backoff.
      return false
    }
  }
  const [pidText, startedText] = text.split('\n')
  const pid = Number(pidText)
  const started = Number(startedText)
  if (!Number.isInteger(pid) || pid <= 0) return true
  if (Number.isFinite(started) && Date.now() - started > STALE_OWNER_MS) return true
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    // EPERM means the process is alive under another user; anything else (ESRCH) is gone.
    return (error as { code?: unknown } | undefined)?.code !== 'EPERM'
  }
}

async function replaceDirectory(staging: string, dest: string): Promise<void> {
  const retired = `${dest}.retired-${randomBytes(4).toString('hex')}`
  let moved = false
  if (await exists(dest)) {
    await rename(dest, retired)
    moved = true
  }
  try {
    await rename(staging, dest)
  } catch (error) {
    if (moved) await rename(retired, dest).catch(() => undefined)
    throw error
  }
  if (moved) await rm(retired, { recursive: true, force: true }).catch(() => undefined)
}

function assetName(): string {
  const platform = process.platform
  const arch = process.arch
  if (platform !== 'darwin' && platform !== 'win32' && platform !== 'linux') {
    throw new Error(`dsh-agi: unsupported platform ${platform}`)
  }
  if (arch !== 'arm64' && arch !== 'x64') {
    throw new Error(`dsh-agi: unsupported architecture ${arch}`)
  }
  return `electron-v${ELECTRON_VERSION}-${platform}-${arch}.zip`
}

function binaryRelative(): string {
  if (process.platform === 'darwin') return join('Electron.app', 'Contents', 'MacOS', 'Electron')
  if (process.platform === 'win32') return 'electron.exe'
  return 'electron'
}

/** The hash written in source. `sums` must list the same value or the download stops. */
export function expectedHash(sums: string, fileName: string): string {
  const pinned = PINNED_SHA256[fileName]
  if (pinned === undefined) {
    throw new Error(`dsh-agi: ${fileName} has no pinned Electron ${ELECTRON_VERSION} checksum`)
  }
  const listed = hashFromSums(sums, fileName)
  if (listed !== pinned) {
    throw new Error(`dsh-agi: Electron ${ELECTRON_VERSION} checksum list does not match the pinned hash for ${fileName}`)
  }
  return pinned
}

function hashFromSums(sums: string, fileName: string): string {
  for (const line of sums.split('\n')) {
    const match = /^([a-fA-F0-9]{64})\s+\*?(\S+)\s*$/.exec(line.trim())
    if (match?.[2] === fileName) return match[1].toLowerCase()
  }
  throw new Error(`dsh-agi: ${fileName} is missing from Electron ${ELECTRON_VERSION} checksums`)
}

const CURL_HTTPS = ['--proto', '=https', '--proto-redir', '=https']

/** The Windows schannel backend aborts when a revocation check cannot complete
 * (common behind proxies); every download is checksum-verified anyway. Other
 * TLS backends ignore the flag. */
const CURL_TLS = process.platform === 'win32' ? ['--ssl-no-revoke'] : []

/** How long a dead host may burn before curl gives up and the next source is asked. */
const CONNECT_TIMEOUT_SECONDS = '5'

/**
 * The stall floor, and how long a transfer may sit under it before curl gives up on it.
 * This is the only thing that ends a transfer early: a slow line is not a dead one, and whatever
 * it has already delivered is kept for the next attempt to resume. 20 KB/s for 30 s is a
 * connection that has stopped — the runtime is 124–150 MB, so nothing sane sits below it for long.
 */
const STALL_BYTES_PER_SECOND = '20000'
const STALL_SECONDS = '30'

/**
 * Mirrors of an Electron release, in the order they are asked.
 * npmmirror goes first: github.com is unreachable for a large part of the audience,
 * and a silently dropped connection there would otherwise stall the first ball launch.
 * Every download is checked against the compiled-in SHA-256, so the order costs no trust.
 */
function releaseUrls(path: string): string[] {
  return [
    `https://cdn.npmmirror.com/binaries/electron/v${ELECTRON_VERSION}/${path}`,
    `${RELEASE_BASE}/${path}`,
  ]
}

/** First source that answers wins; a dead host costs one connect timeout, not the whole transfer. */
async function fetchText(path: string, signal: AbortSignal): Promise<string> {
  let lastError: unknown
  for (const url of releaseUrls(path)) {
    try {
      const { stdout } = await run('curl', [
        '-fsSL', ...CURL_HTTPS, ...CURL_TLS,
        '--connect-timeout', CONNECT_TIMEOUT_SECONDS,
        '--max-time', '60', url,
      ], signal)
      return stdout
    } catch (error) {
      // A cancelled attempt stops here; a dead mirror is just the next source's turn.
      if (signal.aborted) throw cancelled()
      lastError = error
      console.error(`dsh-agi: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`dsh-agi: failed to download ${path}`)
}

async function downloadVerifiedZip(fileName: string, expected: string, dest: string, signal: AbortSignal): Promise<void> {
  // An earlier attempt may have finished the transfer and then died before its zip was removed —
  // or failed at the extraction while keeping a complete file. Those bytes are the whole runtime
  // already: hashing them costs a second and saves the user another 124–150 MB.
  if (await matchesHash(dest, expected)) {
    console.error('dsh-agi: the runtime zip on disk is already complete')
    return
  }
  // Official checksums decide what is accepted. The mirror only decides how fast it arrives.
  const urls = releaseUrls(fileName)
  let lastError: unknown
  for (const url of urls) {
    const resume = await fileSize(dest) > 0
    try {
      await run('curl', zipCurlArgs(url, dest, resume), signal)
      const actual = await sha256(dest)
      if (!sameHash(actual, expected)) {
        // Whatever went wrong, the bytes on disk are wrong as a whole. Dropping them here is what
        // keeps a bad resume from being verified again and again: the next attempt starts at zero.
        await rm(dest, { force: true })
        throw new Error(`dsh-agi: Electron ${ELECTRON_VERSION} checksum did not match SHASUMS256.txt`)
      }
      return
    } catch (error) {
      if (signal.aborted) throw cancelled()
      // A mirror that cannot resume (or a partial the server thinks is out of range) must not
      // pin the file: those bytes go, and the next attempt fetches that file from zero.
      if (resume && isResumeRefused(error)) await rm(dest, { force: true }).catch(() => undefined)
      lastError = error
      console.error(`dsh-agi: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`dsh-agi: failed to download Electron ${ELECTRON_VERSION}`)
}

/**
 * The curl that fetches one zip.
 *
 * There is deliberately no total time limit. A 124–150 MB runtime on a slow line can take longer
 * than any cap worth writing, and cutting it off just means paying for the same bytes again —
 * the stall guard (`--speed-limit`/`--speed-time`) is what catches a connection that has actually
 * stopped delivering. `resume` continues an interrupted transfer instead of starting it over.
 *
 * @param url - mirror URL of the zip.
 * @param dest - file the transfer writes; `-C -` appends to whatever is already there.
 * @param resume - true when `dest` already holds bytes worth keeping.
 * @returns argv for curl.
 */
export function zipCurlArgs(url: string, dest: string, resume: boolean): string[] {
  return [
    '-fsSL', ...CURL_HTTPS, ...CURL_TLS, '--retry', '2', '--retry-delay', '1',
    '--connect-timeout', CONNECT_TIMEOUT_SECONDS,
    '--speed-limit', STALL_BYTES_PER_SECOND, '--speed-time', STALL_SECONDS,
    ...(resume ? ['-C', '-'] : []),
    '-o', dest, url,
  ]
}

/**
 * Whether curl refused the resume rather than the transfer. 33/36 are its "cannot resume" exits;
 * a 416 arrives as the generic HTTP-failure exit 22, so the status has to be read out of the
 * message. A 404 must not land here: that mirror is simply down, and the bytes stay for the next one.
 */
export function isResumeRefused(error: unknown): boolean {
  const code = (error as { exitCode?: unknown } | undefined)?.exitCode
  if (code === 33 || code === 36) return true
  return code === 22 && error instanceof Error && error.message.includes('416')
}

function run(command: string, args: string[], signal?: AbortSignal): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(cancelled())
      return
    }
    // `signal` kills the child — curl included — the moment the user asks for a redownload.
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...(signal === undefined ? {} : { signal }) })
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout?.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => err.push(chunk))
    child.once('error', (error) => {
      reject(signal?.aborted ? cancelled() : error)
    })
    child.once('exit', (code) => {
      if (code === 0) {
        resolve({ stdout: Buffer.concat(out).toString('utf8') })
        return
      }
      const detail = Buffer.concat(err).toString('utf8').trim()
      // `exitCode` carries curl's own status: the caller tells a refused resume (33/36/416) from
      // a mirror that is simply down.
      reject(Object.assign(
        new Error(`dsh-agi: ${command} exited ${code ?? 'unknown'}${detail ? `: ${detail}` : ''}`),
        { exitCode: code },
      ))
    })
  })
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

/**
 * Whether a file already holds exactly the bytes the checksum names. A missing file never
 * matches, and an unreadable one only means "not proven complete": the caller downloads.
 */
export async function matchesHash(path: string, expected: string): Promise<boolean> {
  if (await fileSize(path) === 0) return false
  try {
    return sameHash(await sha256(path), expected)
  } catch {
    return false
  }
}

function sameHash(actual: string, expected: string): boolean {
  const left = Buffer.from(actual, 'hex')
  const right = Buffer.from(expected, 'hex')
  return left.length === right.length && timingSafeEqual(left, right)
}

/**
 * Unpack one zip into `dest`.
 *
 * Windows cannot use `Expand-Archive`: the cmdlet refuses any archive whose name does not end in
 * `.zip`, and the transfer deliberately keeps its bytes in `<asset>.zip.partial` so a killed
 * attempt can be resumed instead of paid for twice. The extension describes the download, not the
 * archive, so the extractor must not read anything into it — .NET's `ZipFile` (the same library
 * behind the cmdlet) does not.
 */
export async function extractZip(zipPath: string, dest: string, signal?: AbortSignal): Promise<void> {
  if (process.platform === 'win32') {
    const command = [
      // The error text is the only clue a failed extraction leaves. Force UTF-8 on the way out so
      // a non-English console does not hand the log a page of mojibake.
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      "$ErrorActionPreference = 'Stop'",
      'Add-Type -AssemblyName System.IO.Compression.FileSystem',
      `[System.IO.Compression.ZipFile]::ExtractToDirectory(${singleQuoted(zipPath)}, ${singleQuoted(dest)})`,
    ].join('; ')
    await spawnChecked('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], signal)
    return
  }
  const unzip = process.platform === 'darwin' ? '/usr/bin/unzip' : 'unzip'
  await spawnChecked(unzip, ['-q', '-o', zipPath, '-d', dest], signal)
}

/** A PowerShell single-quoted string: the only character it interprets is `'`, doubled. */
function singleQuoted(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

/** Cap on the extractor's stderr kept for one failure: enough for the reason, not a whole dump. */
const STDERR_LIMIT_BYTES = 4096

function spawnChecked(command: string, args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(cancelled())
      return
    }
    // `exit 1` alone once made a Windows extraction failure look like a download failure for a
    // whole release: the reason was on stderr and went to /dev/null. Keep it.
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], ...(signal === undefined ? {} : { signal }) })
    const err: Buffer[] = []
    let errBytes = 0
    child.stderr?.on('data', (chunk: Buffer) => {
      if (errBytes >= STDERR_LIMIT_BYTES) return
      errBytes += chunk.length
      err.push(chunk)
    })
    child.once('error', (error) => {
      reject(signal?.aborted ? cancelled() : error)
    })
    child.once('exit', (code) => {
      if (signal?.aborted) {
        reject(cancelled())
        return
      }
      if (code === 0) {
        resolve()
        return
      }
      const detail = Buffer.concat(err).toString('utf8').trim().split('\n').slice(0, 6).join('\n')
      reject(new Error(`dsh-agi: ${command} exited ${code ?? 'unknown'}${detail ? `: ${detail}` : ''}`))
    })
  })
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
