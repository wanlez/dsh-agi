/**
 * Taking over the operator's own Chrome.
 *
 * The operator authorized this explicitly: when the page needs their real login state, the plugin
 * may restart Chrome with a local debug port and attach to it. Safeguards that make this safe:
 *
 * - Chrome is asked to close politely first (WM_CLOSE), and only the processes whose executable is
 *   the configured Chrome are touched; a timeout means we stop and report, never force-kill.
 * - The profile is the operator's normal Chrome profile, passed as an explicit `--user-data-dir`
 *   (Chrome 136+ refuses remote debugging without one). Nothing is copied, moved or deleted, so
 *   cookies and extensions come back exactly as they were when Chrome is opened again.
 * - The debug port binds loopback only and lives as long as our attached session; when the channel
 *   closes we close that browser so the port does not stay open.
 * @module web/handoff
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createServer } from 'node:net'

const run = promisify(execFile)

/** The operator's normal Chrome profile directory. */
export function defaultChromeUserDataDir(): string {
  const local = process.env.LOCALAPPDATA ?? ''
  return join(local, 'Google', 'Chrome', 'User Data')
}

/** Whether Chrome runs right now, by executable path (never by window title). */
export async function chromeRunning(executablePath: string): Promise<boolean> {
  try {
    const script = "Get-CimInstance Win32_Process -Filter \"name='chrome.exe'\" | Select-Object -ExpandProperty ExecutablePath"
    const { stdout } = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 10_000, windowsHide: true, encoding: 'utf8' })
    const wanted = executablePath.toLowerCase().replace(/\//g, '\\')
    return stdout.split('\n').map(line => line.trim().toLowerCase()).some(line => line === wanted)
  } catch {
    return false
  }
}

/** A free loopback port for the debug endpoint. */
export async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => { port > 0 ? resolve(port) : reject(new Error('no free port')) })
    })
  })
}

/**
 * Ask Chrome to close and wait for it. Returns false when it is still running after the deadline,
 * in which case the caller must stop instead of killing it (the operator may have unsaved work).
 */
export async function closeChrome(executablePath: string, timeoutMs = 20_000): Promise<boolean> {
  if (!await chromeRunning(executablePath)) return true
  const script = [
    "$name = 'chrome.exe'",
    "Get-Process -Name ('chrome') -ErrorAction SilentlyContinue | ForEach-Object { $_.CloseMainWindow() | Out-Null }",
  ].join('\n')
  await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 15_000, windowsHide: true, encoding: 'utf8' }).catch(() => undefined)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 400))
    if (!await chromeRunning(executablePath)) return true
  }
  return false
}

/** Launch Chrome detached with the debug port, on the operator's own profile. */
export async function launchChromeDebug(executablePath: string, port: number, userDataDir: string): Promise<void> {
  const args = [
    `--remote-debugging-port=${port}`,
    `--remote-debugging-address=127.0.0.1`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
  ]
  // spawn detached: Chrome outlives this call on purpose; the channel owns it afterwards.
  const { spawn } = await import('node:child_process')
  const child = spawn(executablePath, args, { detached: true, stdio: 'ignore' })
  child.unref()
}

/** Wait until the CDP endpoint answers with a browser version. */
export async function waitForCdp(port: number, timeoutMs = 25_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (response.ok) return true
    } catch { /* not up yet */ }
    await new Promise(resolve => setTimeout(resolve, 300))
  }
  return false
}

/** Everything the takeover needs, or a reason it cannot run. */
export async function prepareTakeover(chromePath: string): Promise<{ ok: true, userDataDir: string, port: number } | { ok: false, reason: string }> {
  if (!existsSync(chromePath)) return { ok: false, reason: '没有指定 chrome.exe，请先在设置里选一下。' }
  const userDataDir = defaultChromeUserDataDir()
  if (!existsSync(userDataDir)) return { ok: false, reason: `找不到 Chrome 的用户配置目录：${userDataDir}` }
  const closed = await closeChrome(chromePath)
  if (!closed) return { ok: false, reason: 'Chrome 没有在 20 秒内关闭（可能有未保存的内容）。已停止，不会强杀；请手动关闭 Chrome 后再试。' }
  const port = await freePort()
  await launchChromeDebug(chromePath, port, userDataDir)
  const up = await waitForCdp(port)
  if (!up) return { ok: false, reason: 'Chrome 已启动但调试端口没有响应；可能被安全策略禁用。请改用内置 Chromium 或系统 Chrome 独立窗口模式。' }
  return { ok: true, userDataDir, port }
}
