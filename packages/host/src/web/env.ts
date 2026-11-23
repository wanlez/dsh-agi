/**
 * Detects environments where a browser channel cannot be trusted: remote desktops, virtual
 * machines and remote-control tools. The browser runs inside the same session the operator
 * watches through a screen that is not the machine's own console, so its windows are either
 * invisible or scaled; keyboard and mouse remain the only channel that works there.
 *
 * This is a runtime decision for the whole process, not a setting: the operator can still ask
 * for the browser explicitly, and that override lives in the session, never in the config.
 * @module web/env
 */

import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

/** What the probe found and what it means for the browser channel. */
export interface RemoteEnvironment {
  /** True when the browser channel must stay off for this process. */
  readonly blocked: boolean
  /** Short Chinese reason shown to the operator and written to the session. */
  readonly reason: string
  /** The concrete evidence, one line per hit; empty when nothing was found. */
  readonly evidence: readonly string[]
}

/** Remote-control tools that make the desktop someone else's screen. */
const REMOTE_TOOLS = [
  'SunloginClient',
  'ToDesk',
  'AnyDesk',
  'TeamViewer',
  'RustDesk',
  'Parsec',
  'winvnc',
  'vncserver',
  'mstsc',
]

/** Virtual-machine vendors that show up in the computer model or BIOS strings. */
const VM_MARKERS = ['vmware', 'virtualbox', 'qemu', 'xen', 'parallels', 'hyper-v', 'virtual machine', 'kvm']

function run(command: string, args: readonly string[], timeout = 4000): string {
  try {
    return execFileSync(command, [...args], { encoding: 'utf8', windowsHide: true, timeout })
  } catch {
    return ''
  }
}

/** Windows: a Remote Desktop session announces itself in the session name and by API. */
function windowsRemoteSession(): string[] {
  const hits: string[] = []
  const sessionName = process.env.SESSIONNAME ?? ''
  if (/^rdp-/i.test(sessionName)) hits.push(`SESSIONNAME=${sessionName}`)
  // RDP sessions answer differently in the registry, and the console session does not.
  const query = run('qwinsta', [])
  if (/rdp-tcp#|rdp-tcp\s/i.test(query)) hits.push('qwinsta 报告 RDP 会话')
  return hits
}

/** Windows: the computer model names the hypervisor, or the system firmware does. */
function windowsVirtualMachine(): string[] {
  const hits: string[] = []
  const probe = run('powershell', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    '(Get-CimInstance Win32_ComputerSystem | Select-Object -ExpandProperty Manufacturer), (Get-CimInstance Win32_ComputerSystem | Select-Object -ExpandProperty Model)',
  ])
  const lowered = probe.toLowerCase()
  for (const marker of VM_MARKERS) {
    if (lowered.includes(marker)) hits.push(`主板信息包含 ${marker}`)
  }
  return hits
}

/** Process names: a remote-control tool owns the screen then. */
function remoteTools(): string[] {
  const list = run('tasklist', ['/FO', 'CSV', '/NH'])
  const lowered = list.toLowerCase()
  const hits: string[] = []
  for (const tool of REMOTE_TOOLS) {
    if (lowered.includes(tool.toLowerCase())) hits.push(`进程 ${tool} 正在运行`)
  }
  return hits
}

/**
 * Probe the machine once per process start.
 * @returns the decision plus the evidence behind it.
 */
export function detectRemoteEnvironment(): RemoteEnvironment {
  const evidence: string[] = []
  if (process.platform === 'win32') {
    evidence.push(...windowsRemoteSession(), ...windowsVirtualMachine(), ...remoteTools())
  }
  if (evidence.length === 0) return { blocked: false, reason: '', evidence }
  const desktop = evidence.some((line) => line.startsWith('SESSIONNAME') || line.includes('RDP') || line.includes('vnc') || line.includes('mstsc'))
  return {
    blocked: true,
    reason: desktop
      ? '检测到远程桌面会话，网页通道已停用，改用键鼠'
      : '检测到虚拟机或远程控制软件，网页通道已停用，改用键鼠',
    evidence,
  }
}

/** Read a small text file without throwing; used by the session pointer probe below. */
export function readPointer(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8').trim() || undefined
  } catch {
    return undefined
  }
}
