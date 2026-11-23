/**
 * The bundled Chromium: one pinned build, fetched from this project's own GitHub release.
 *
 * The version is a constant because the browser is driven by protocol: `playwright-core` is
 * pinned to the release that shipped this exact build, and every later change targets the same
 * pair. Nothing here asks a search engine or an official CDN for "latest".
 * @module web/chromium
 */

import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** The pinned build; it must match the `playwright-core` version in the manifest. */
export const CHROMIUM_VERSION = '159.0.8154.6'

/** The asset this project publishes for that build. */
export const CHROMIUM_ASSET = `chromium-win64-${CHROMIUM_VERSION}.zip`

/** Where the download comes from: this project's release, never an upstream CDN. */
export const CHROMIUM_URL = `https://github.com/wanlez/dsh-agi/releases/download/web-chromium-${CHROMIUM_VERSION}/${CHROMIUM_ASSET}`

/** A transfer with no new bytes for this long is treated as dead. */
const STALL_MS = 30_000

/** Expected digest of the asset; filled in after the release upload and enforced when set. */
export const CHROMIUM_SHA256: string = '3e2514fddb71f6727e2079369e03a6a4e105adcb28f05a6bfd875b782bddc431'

/** State written while a download runs, so the page can show progress. */
export interface ChromiumStatus {
  readonly version: string
  readonly present: boolean
  readonly path: string
  readonly phase: 'idle' | 'downloading' | 'extracting' | 'failed'
  readonly received: number
  readonly total: number
  readonly error: string
}

interface StatusFile {
  phase: ChromiumStatus['phase']
  received: number
  total: number
  error: string
}

function statusFile(dataDir: string): string {
  return join(dataDir, 'web-chromium.json')
}

function readStatusFile(dataDir: string): StatusFile {
  try {
    const parsed = JSON.parse(readFileSync(statusFile(dataDir), 'utf8')) as Partial<StatusFile>
    return {
      phase: parsed.phase === 'downloading' || parsed.phase === 'extracting' || parsed.phase === 'failed' ? parsed.phase : 'idle',
      received: typeof parsed.received === 'number' ? parsed.received : 0,
      total: typeof parsed.total === 'number' ? parsed.total : 0,
      error: typeof parsed.error === 'string' ? parsed.error : '',
    }
  } catch {
    return { phase: 'idle', received: 0, total: 0, error: '' }
  }
}

function writeStatus(dataDir: string, status: Partial<StatusFile>): void {
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(statusFile(dataDir), JSON.stringify({ ...readStatusFile(dataDir), ...status }, null, 2))
}

/** The folder a build unpacks into. */
export function chromiumRoot(dataDir: string): string {
  return join(dataDir, 'chromium', CHROMIUM_VERSION)
}

/** The executable of the unpacked build, or '' when it is not there yet. */
export function chromiumExecutable(dataDir: string): string {
  const candidates = [
    join(chromiumRoot(dataDir), 'chrome-win64', 'chrome.exe'),
    join(chromiumRoot(dataDir), 'chrome-linux', 'chrome'),
    join(chromiumRoot(dataDir), 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return ''
}

/** What the settings page shows about the bundled browser. */
export function chromiumStatus(dataDir: string): ChromiumStatus {
  const file = readStatusFile(dataDir)
  const path = chromiumExecutable(dataDir)
  return {
    version: CHROMIUM_VERSION,
    present: path !== '',
    path,
    phase: file.phase,
    received: file.received,
    total: file.total,
    error: file.error,
  }
}

/** Stream the release asset to disk and report progress as it goes. */
async function fetchAsset(target: string, dataDir: string): Promise<void> {
  // A stalled transfer must fail visibly instead of hanging the page forever: GitHub is not
  // always reachable at full speed, and the operator can switch to system Chrome meanwhile.
  const controller = new AbortController()
  let stall = setTimeout(() => controller.abort(), STALL_MS)
  const bump = (): void => {
    clearTimeout(stall)
    stall = setTimeout(() => controller.abort(), STALL_MS)
  }
  let response: Response
  try {
    response = await fetch(CHROMIUM_URL, { redirect: 'follow', signal: controller.signal })
  } catch {
    throw new Error('连不上 GitHub 下载地址（网络被拦或太慢）。请改用系统 Chrome 模式，或稍后重试。')
  }
  if (!response.ok || response.body === null) {
    throw new Error(`下载失败：HTTP ${response.status}。可以先改用系统 Chrome 模式。`)
  }
  const total = Number(response.headers.get('content-length') ?? 0)
  writeStatus(dataDir, { phase: 'downloading', received: 0, total, error: '' })
  const hash = createHash('sha256')
  const sink = createWriteStream(target)
  let received = 0
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      bump()
      received += chunk.length
      hash.update(chunk)
      if (!sink.write(chunk)) await new Promise<void>((resolve) => { sink.once('drain', () => resolve()) })
      // The page polls the status file; one write per megabyte is plenty.
      if (received % (1024 * 1024) < chunk.length) writeStatus(dataDir, { received })
    }
  } catch {
    clearTimeout(stall)
    throw new Error(`下载中断（超过 ${Math.round(STALL_MS / 1000)} 秒没有新数据）。请改用系统 Chrome 模式，或稍后重试。`)
  } finally {
    clearTimeout(stall)
  }
  await new Promise<void>((resolve, reject) => sink.end((error?: Error | null) => (error === undefined || error === null ? resolve() : reject(error))))
  if (CHROMIUM_SHA256 !== '' && hash.digest('hex') !== CHROMIUM_SHA256) {
    throw new Error('下载文件校验失败（sha256 不符），已放弃。请重试，或改用系统 Chrome 模式。')
  }
}

/** Unpack the zip with the platform's own tool; no extra dependency is worth a native module. */
async function extract(zip: string, destination: string): Promise<void> {
  mkdirSync(destination, { recursive: true })
  if (process.platform === 'win32') {
    const escapedZip = zip.replace(/'/g, "''")
    const escapedDest = destination.replace(/'/g, "''")
    await run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath '${escapedZip}' -DestinationPath '${escapedDest}' -Force`], { timeout: 10 * 60 * 1000 })
    return
  }
  await run('unzip', ['-o', '-q', zip, '-d', destination], { timeout: 10 * 60 * 1000 })
}

/**
 * Download, verify and unpack the pinned build.
 * @returns the executable path to persist in the settings.
 */
export async function installChromium(dataDir: string): Promise<string> {
  const root = chromiumRoot(dataDir)
  const zip = join(dataDir, `chromium-${CHROMIUM_VERSION}.zip`)
  try {
    mkdirSync(dataDir, { recursive: true })
    if (existsSync(zip) && statSync(zip).size > 0) rmSync(zip, { force: true })
    await fetchAsset(zip, dataDir)
    writeStatus(dataDir, { phase: 'extracting' })
    rmSync(root, { recursive: true, force: true })
    await extract(zip, root)
    rmSync(zip, { force: true })
    const exe = chromiumExecutable(dataDir)
    if (exe === '') throw new Error('解压后没找到浏览器可执行文件，下载可能不完整。')
    writeStatus(dataDir, { phase: 'idle', received: 0, total: 0, error: '' })
    return exe
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    writeStatus(dataDir, { phase: 'failed', error: message })
    rmSync(zip, { force: true })
    throw error
  }
}
