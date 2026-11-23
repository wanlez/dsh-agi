/**
 * Read-only UI Automation inventory.
 *
 * This is a targeting aid, not an input channel: it lists what a window exposes so the agent
 * can aim by name, and every click still goes through the normal pointer tools. Nothing here
 * invokes a control, sets a value, or reads a value from the target — a read-only client is
 * the whole safety argument, and the missing write patterns keep it that way.
 *
 * The tree quality varies wildly per toolkit (Chromium with accessibility on: hundreds of
 * elements; Qt, Flutter and classic Win32 dialogs: one or two), so the result always says how
 * usable it is and the caller falls back to screenshots when it is not.
 * @module uia
 */

import { execFile } from 'node:child_process'
import { release } from 'node:os'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** One control the window exposes. */
export interface UiaControl {
  readonly name: string
  readonly type: string
  readonly automationId: string
  readonly className: string
  /** Center in 0–1000 fractions of the window, ready for the click tool's position argument. */
  readonly center: number[]
  /** Physical pixels: [left, top, width, height] on the virtual desktop. */
  readonly rect: number[]
  readonly enabled: boolean
  readonly offscreen: boolean
  readonly password: boolean
}

/** What the probe found for one window. */
export interface UiaSnapshot {
  readonly window: string
  readonly className: string
  readonly process: string
  readonly count: number
  readonly elapsedMs: number
  readonly controls: UiaControl[]
  /** True when the tree is too thin to aim by; the caller should use screenshots. */
  readonly unusable: boolean
  readonly notice: string
}

/** Windows that must never be inspected: games, anti-cheat and credential managers. */
const SENSITIVE = /game|anticheat|anti-cheat|nprotect|xigncode|bank|金融|证券|1password|keepass|bitwarden|lastpass/i

/**
 * The probe script. It walks one window's descendants, keeps only elements with a usable
 * rectangle, and reports fractions relative to that window so the click tool can use them.
 */
const SCRIPT = `$ErrorActionPreference = 'Stop'
try { Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes } catch { '{"error":"uia-assembly-missing"}'; exit 0 }
$csharp = @'
using System;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out uint pid);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
'@
Add-Type -TypeDefinition $csharp
[void][W]::SetProcessDPIAware()
$h = [W]::GetForegroundWindow()
if ($h -eq [IntPtr]::Zero) { '{"error":"no-foreground-window"}'; exit 0 }
$rect = New-Object W+RECT
[void][W]::GetWindowRect($h, [ref]$rect)
$wpid = 0
[void][W]::GetWindowThreadProcessId($h, [ref]$wpid)
$proc = ''
try { $proc = (Get-Process -Id $wpid).ProcessName } catch {}
$el = [System.Windows.Automation.AutomationElement]::FromHandle($h)
if ($null -eq $el) { '{"error":"no-element"}'; exit 0 }
$width = [Math]::Max(1, $rect.Right - $rect.Left)
$height = [Math]::Max(1, $rect.Bottom - $rect.Top)
$sw = [Diagnostics.Stopwatch]::StartNew()
$all = $el.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
$out = New-Object System.Collections.ArrayList
$limit = __LIMIT__
foreach ($c in $all) {
  if ($out.Count -ge $limit) { break }
  try {
    $r = $c.Current.BoundingRectangle
    if ($r.IsEmpty) { continue }
    if ($r.Width -le 1 -or $r.Height -le 1) { continue }
    $cx = [int](($r.Left + $r.Width / 2 - $rect.Left) * 1000 / $width)
    $cy = [int](($r.Top + $r.Height / 2 - $rect.Top) * 1000 / $height)
    if ($cx -lt 0 -or $cx -gt 1000 -or $cy -lt 0 -or $cy -gt 1000) { continue }
    $name = $c.Current.Name
    if ([string]::IsNullOrWhiteSpace($name)) { $name = $c.Current.AutomationId }
    if ([string]::IsNullOrWhiteSpace($name)) { continue }
    $typeName = $c.Current.ControlType.ProgrammaticName
    $dot = $typeName.IndexOf('.')
    if ($dot -ge 0) { $typeName = $typeName.Substring($dot + 1) }
    [void]$out.Add([pscustomobject]@{
      name = $name
      type = $typeName
      automationId = $c.Current.AutomationId
      className = $c.Current.ClassName
      center = @($cx, $cy)
      rect = @([int]$r.Left, [int]$r.Top, [int]$r.Width, [int]$r.Height)
      enabled = $c.Current.IsEnabled
      offscreen = $c.Current.IsOffscreen
      password = $c.Current.IsPassword
    })
  } catch {}
}
$sw.Stop()
$payload = [pscustomobject]@{
  window = $el.Current.Name
  className = $el.Current.ClassName
  process = $proc
  count = $all.Count
  elapsedMs = $sw.ElapsedMilliseconds
  controls = @($out)
}
$payload | ConvertTo-Json -Depth 6 -Compress
`

/** How long a failure is remembered before the next call tries again. */
const FAILURE_TTL_MS = 60_000

/**
 * First rung, free: the OS gate. `System.Windows.Automation` through PowerShell needs Windows 10
 * or newer here — the desktop app itself does not run below that — so an older build answers
 * immediately instead of paying for a PowerShell start.
 */
function osGate(): string {
  if (process.platform !== 'win32') return 'uia-unavailable'
  const major = Number(release().split('.')[0] ?? '0')
  // NT 10.0 covers Windows 10, 11 and Server 2016+; 6.x is 8.1 and older.
  if (!Number.isFinite(major) || major < 10) return 'uia-os-too-old'
  return ''
}

/** A busy target can block a cross-process accessibility call; one attempt is bounded by this. */
const TIMEOUT_MS = 2500

/** Deterministic failures: retrying the same read cannot change the answer. */
const RETRY_WORTHLESS = new Set(['uia-assembly-missing', 'uia-os-too-old', 'uia-unavailable', 'uia-sensitive-window'])

/** One spawn: probe the surface and read the tree in the same process. */
async function attempt(limit: number): Promise<UiaSnapshot | { error: string }> {
  const script = SCRIPT.replace('__LIMIT__', String(limit))
  let stdout = ''
  try {
    const result = await run('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      timeout: TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      encoding: 'utf8',
    })
    stdout = result.stdout
  } catch (error) {
    const timeout = (error as { killed?: boolean; signal?: string } | undefined)?.killed === true
    return { error: timeout ? 'uia-timeout' : 'uia-probe-failed' }
  }
  const line = stdout.trim().split('\n').filter((item) => item.trim().startsWith('{')).pop()
  if (line === undefined) return { error: 'uia-empty-output' }
  let parsed: {
    error?: string
    window?: string
    className?: string
    process?: string
    count?: number
    elapsedMs?: number
    controls?: UiaControl[]
  }
  try {
    parsed = JSON.parse(line) as typeof parsed
  } catch {
    return { error: 'uia-bad-json' }
  }
  if (parsed.error !== undefined) return { error: parsed.error }
  const processName = parsed.process ?? ''
  if (SENSITIVE.test(processName) || SENSITIVE.test(parsed.window ?? '')) {
    return { error: 'uia-sensitive-window' }
  }
  const controls = Array.isArray(parsed.controls) ? parsed.controls : []
  const password = controls.some((control) => control.password === true)
  const unusable = password || controls.length < 8
  return {
    window: parsed.window ?? '',
    className: parsed.className ?? '',
    process: processName,
    count: parsed.count ?? controls.length,
    elapsedMs: parsed.elapsedMs ?? 0,
    controls: controls.filter((control) => control.password !== true),
    unusable,
    notice: password
      ? '这个窗口有密码框，UIA 只读也按敏感处理：不返回密码字段，其余字段仅供粗定位。'
      : unusable
        ? '这个窗口的 UIA 树太小（Qt/Flutter/旧 Win32 常见，或目标以管理员运行而本进程没有同等权限），按名字定位不可用，请改用截图。'
        : 'center 是相对窗口的 0–1000 比例，可直接作为 click 的 position；点击仍走两段瞄准。',
  }
}

/**
 * List the frontmost window's controls.
 *
 * One retry per call, no cross-call memory: a transient timeout gets a second chance, and a
 * deterministic failure (no .NET surface, no window, sensitive process) answers at once.
 * @param limit - maximum controls returned; the tree itself is still counted in full.
 */
export async function uiaSnapshot(limit = 200): Promise<UiaSnapshot | { error: string }> {
  const gated = osGate()
  if (gated !== '') return { error: gated }
  const bounded = Math.max(10, Math.min(limit, 300))
  let last: { error: string } = { error: 'uia-probe-failed' }
  for (let attemptNumber = 1; attemptNumber <= 2; attemptNumber += 1) {
    const outcome = await attempt(bounded)
    if (!('error' in outcome)) return outcome
    last = outcome
    if (RETRY_WORTHLESS.has(outcome.error)) return outcome
  }
  return last
}
