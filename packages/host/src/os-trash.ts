/**
 * Move one path to the operating system's trash: the macOS Trash or the Windows
 * Recycle Bin. The user restores it from there; this module never keeps a copy.
 */

import { spawn } from 'node:child_process'

/** Whether this platform has a user-facing trash this plugin can put a directory into. */
export function osTrashAvailable(): boolean {
  return process.platform === 'darwin' || process.platform === 'win32'
}

/**
 * Put one file or directory into the system trash.
 * @param path - absolute path to move.
 * @throws when the platform is unsupported or the system refuses the move.
 */
export async function moveToOsTrash(path: string): Promise<void> {
  if (process.platform === 'darwin') return trashOnMac(path)
  if (process.platform === 'win32') return trashOnWindows(path)
  throw new Error('os-trash-unavailable')
}

/** Finder/NSFileManager records the original location, so Put Back works. */
const MAC_SCRIPT = `ObjC.import('Foundation');
function run(argv) {
  const fm = $.NSFileManager.defaultManager;
  if (!fm.fileExistsAtPath(argv[0])) throw new Error('missing path');
  const ok = fm.trashItemAtURLResultingItemURLError($.NSURL.fileURLWithPath(argv[0]), $(), $());
  if (!ok) throw new Error('the system trash refused the item');
  return 'ok';
}`

function trashOnMac(path: string): Promise<void> {
  return run('osascript', ['-l', 'JavaScript', '-e', MAC_SCRIPT, path], 30_000)
}

/** Microsoft.VisualBasic moves through the Shell, so Explorer can restore it. */
const WINDOWS_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'Add-Type -AssemblyName Microsoft.VisualBasic',
  "[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($env:DSH_AGI_TRASH_PATH, 'OnlyErrorDialogs', 'SendToRecycleBin')",
].join('; ')

function trashOnWindows(path: string): Promise<void> {
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_SCRIPT], 60_000, { DSH_AGI_TRASH_PATH: path })
}

function run(command: string, args: readonly string[], timeoutMs: number, extraEnv: Record<string, string> = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`os trash timed out after ${String(timeoutMs)}ms`))
    }, timeoutMs)
    timer.unref()
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(stderr.trim() || `os trash exited with ${String(code)}`))
    })
  })
}
