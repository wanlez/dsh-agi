/**
 * Owns the web-control switch: reads the settings, refuses to start on a remote or virtual
 * desktop, and registers or disposes the browser tools so the switch takes effect without a
 * restart. Nothing here launches a browser; `BrowserChannel` does that on the first tool call.
 * @module web/control
 */

import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { knowledgeGraphDirFor } from '../knowledge-graph/store.ts'
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { CHROMIUM_VERSION, chromiumStatus, installChromium, type ChromiumStatus } from './chromium.ts'
import { detectRemoteEnvironment, type RemoteEnvironment } from './env.ts'
import { prepareTakeover } from './handoff.ts'
import { defaultWebSettings, mergeWebSettings, readWebSettings, writeWebSettings, type WebSettings } from './settings.ts'
import { BrowserChannel, registerWebTools } from './tools.ts'

/** What the settings page shows about the channel. */
export interface WebState {
  readonly settings: WebSettings
  /** True when the tools are registered right now. */
  readonly active: boolean
  /** Why the channel could not even register; empty in the normal case. */
  readonly blockedReason: string
  /** True when the selected mode has everything it needs to launch or attach. */
  readonly modeReady: boolean
  /** What the selected mode still needs; empty when ready. Web steps then fall back to the keyhole. */
  readonly modeHint: string
  /** The probe evidence, so the operator can judge the detection themselves. */
  readonly evidence: readonly string[]
  /** The bundled browser: installed or not, and any download progress. */
  readonly chromium: ChromiumStatus
  /** Where Chromium builds live (empty means the plugin's own folder). */
  readonly chromiumDir: string
  /** The last failure from enabling or downloading, for the page to show instead of silence. */
  readonly error: string
  /** The last successful action's summary (takeover, move, download), for the page to show. */
  readonly notice: string
}

/** A tool registry as the Host exposes it. */
interface ToolRegistry {
  register(tool: unknown): () => void
}

/** Whether the selected mode can actually produce a browser right now. */
function modeReady(settings: WebSettings, chromiumPresent: boolean): boolean {
  if (settings.mode === 'attach') return settings.cdpUrl.trim() !== ''
  if (settings.mode === 'chrome') return settings.chromePath.trim() !== ''
  return settings.chromiumPath.trim() !== '' || chromiumPresent
}

/** The sentence the page shows when the mode is selected but not usable yet. */
function modeUnavailable(settings: WebSettings): string {
  if (settings.mode === 'attach') return '连接模式还没填 CDP 地址：网页步骤会直接走键鼠，不会中断任务。'
  if (settings.mode === 'chrome') return '系统 Chrome 模式还没选 chrome.exe：网页步骤会直接走键鼠，不会中断任务。'
  return '内置 Chromium 还没下载：网页步骤会直接走键鼠，不会中断任务。'
}

/** The web-control channel: settings, environment gate and tool lifetime. */
export class WebControl {
  private dispose: (() => void) | undefined
  private channel: BrowserChannel | undefined
  /** Probed once, and only after the switch was ever turned on: the probe spawns processes. */
  private env: RemoteEnvironment | undefined
  /** Last enable failure; cleared by the next successful refresh. */
  private lastError = ''
  /** Last successful action's summary, shown once by the page. */
  private lastNotice = ''

  constructor(
    private readonly registry: ToolRegistry,
    private readonly profileDir: string,
  ) {}

  private environment(): RemoteEnvironment {
    this.env = this.env ?? detectRemoteEnvironment()
    return this.env
  }

  /** Where Chromium builds are kept. */
  private baseDir(): string {
    const configured = this.settings().chromiumDir
    return configured !== '' ? configured : dshHomePath('dsh-agi', 'web')
  }

  /** The persisted settings, without changing anything. */
  settings(): WebSettings {
    return readWebSettings(this.profileDir)
  }

  /** Register or dispose the tools to match the settings and the environment. */
  refresh(): WebState {
    const settings = this.settings()
    this.stop()
    this.lastError = ''
    if (settings.enabled) {
      // The channel re-reads the settings per call, so a mode change applies to the next call.
      this.channel = new BrowserChannel(() => readWebSettings(this.profileDir), dshHomePath('dsh-agi', 'web'))
      try {
        this.dispose = registerWebTools(this.registry, this.channel, knowledgeGraphDirFor(this.profileDir))
      } catch (error) {
        // A registry that refuses a definition must not leave the switch pretending to be on.
        this.lastError = error instanceof Error ? error.message : String(error)
        this.dispose = undefined
        console.error(`dsh-agi: web tools failed to register: ${this.lastError}`)
      }
    }
    return this.state()
  }

  /** Everything the settings page needs, plus the current registration state. */
  state(): WebState {
    const settings = this.settings()
    const active = this.dispose !== undefined
    const env = this.environment()
    const chromium = chromiumStatus(this.baseDir())
    const ready = modeReady(settings, chromium.present)
    const modeHint = ready ? '' : modeUnavailable(settings)
    // The environment is never a reason to switch off: the browser is always this machine's own.
    const blockedReason = settings.enabled && !active ? '网页通道未能注册，请查看日志' : ''
    return { settings, active, modeReady: ready, modeHint, blockedReason, evidence: env.evidence, chromium, chromiumDir: this.baseDir(), error: this.lastError, notice: this.lastNotice }
  }

  /**
   * Apply a partial update from the settings page and make it effective immediately.
   * @param patch - only the fields the operator changed.
   */
  update(patch: Partial<WebSettings>): WebState {
    const next = mergeWebSettings(this.settings() ?? defaultWebSettings(), patch)
    writeWebSettings(this.profileDir, next)
    return this.refresh()
  }

  /** Download the pinned build and point the settings at it. */
  async downloadChromium(): Promise<WebState> {
    const exe = await installChromium(this.baseDir())
    const next = mergeWebSettings(this.settings(), { chromiumPath: exe, mode: 'chromium' })
    writeWebSettings(this.profileDir, next)
    return this.refresh()
  }

  /** Ask for a folder with the system dialog, for where builds should live. */
  async pickDirectory(): Promise<WebState> {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
      '$d.Description = "选择内置浏览器的存放位置"',
      'if ($d.ShowDialog() -eq "OK") { $d.SelectedPath }',
    ].join('; ')
    if (process.platform !== 'win32') return this.state()
    const picked = (await promisify(execFile)('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 120_000 })).stdout.trim()
    if (picked === '') return this.state()
    return this.moveChromium(picked)
  }

  /**
   * Move the existing Chromium folder to `target` and remember the new place.
   * A build already at the target is left alone; nothing is copied twice.
   */
  moveChromium(target: string): WebState {
    const from = this.baseDir()
    if (target === from) return this.state()
    try {
      mkdirSync(target, { recursive: true })
      for (const name of existsSync(from) ? readdirSync(from) : []) {
        if (!name.startsWith('chromium')) continue
        const src = join(from, name)
        const dest = join(target, name)
        if (existsSync(dest)) continue
        try {
          renameSync(src, dest)
        } catch {
          // Different volume: copy, then drop the old copy.
          cpSync(src, dest, { recursive: true })
          rmSync(src, { recursive: true, force: true })
        }
      }
      const next = mergeWebSettings(this.settings(), { chromiumDir: target })
      const exe = join(target, 'chromium', CHROMIUM_VERSION, 'chrome-win64', 'chrome.exe')
      if (existsSync(exe)) next.chromiumPath = exe
      writeWebSettings(this.profileDir, next)
    } catch (error) {
      this.lastError = `迁移失败：${error instanceof Error ? error.message : String(error)}`
    }
    return this.refresh()
  }

  /**
   * Ask the operator for a chrome.exe with the system dialog. Nothing is discovered: whatever
   * the dialog returns is what gets used.
   */
  /**
   * Restart the operator's own Chrome with a loopback debug port and attach to it.
   *
   * This is the one flow the operator authorized that touches their browser: Chrome is asked to
   * close politely, its own profile is reused (so logins and extensions come back), and the port
   * lives only for this attached session. Nothing is copied or deleted.
   */
  async takeoverChrome(): Promise<WebState> {
    const settings = this.settings()
    const chromePath = settings.chromePath
    if (chromePath === '') {
      this.lastError = '先选择 chrome.exe，再用「接管当前 Chrome」。'
      return this.state()
    }
    try {
      const prepared = await prepareTakeover(chromePath)
      if (prepared.ok !== true) {
        this.lastError = prepared.reason
        return this.state()
      }
      this.lastNotice = `已用你的 Chrome 配置重启并接管（端口 ${String(prepared.port)}）。关闭网页通道时会一并关掉这个实例。`
      this.lastError = ''
      return await this.update({ mode: 'attach', cdpUrl: `http://127.0.0.1:${String(prepared.port)}`, cdpOwned: true, enabled: true })
    } catch (error) {
      this.lastError = `接管失败：${error instanceof Error ? error.message : String(error)}`
      return this.state()
    }
  }

  async pickChrome(): Promise<WebState> {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$d = New-Object System.Windows.Forms.OpenFileDialog',
      "$d.Filter = 'Chrome (chrome.exe)|chrome.exe|所有程序 (*.exe)|*.exe'",
      '$d.Title = "选择 chrome.exe"',
      'if ($d.ShowDialog() -eq "OK") { $d.FileName }',
    ].join('; ')
    const picked = process.platform === 'win32'
      ? (await promisify(execFile)('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 120_000 })).stdout.trim()
      : ''
    if (picked === '') return this.state()
    const next = mergeWebSettings(this.settings(), { chromePath: picked, mode: 'chrome' })
    writeWebSettings(this.profileDir, next)
    return this.refresh()
  }

  /** Close the browser (the switch turning off must not leave a window behind). */
  async shutdown(): Promise<void> {
    this.stop()
    await this.channel?.close().catch(() => undefined)
    this.channel = undefined
  }

  private stop(): void {
    this.dispose?.()
    this.dispose = undefined
  }
}
