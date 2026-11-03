/** Compile the macOS voice-capture helper as a universal macOS 13 binary. Install does not run this script. */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const swiftSource = resolve(packageRoot, 'native/macos-voice-capture.swift')
const output = resolve(packageRoot, 'prebuilds/darwin-universal/dsh-agi-voice-capture')
const targets = ['arm64-apple-macos13', 'x86_64-apple-macos13']

if (process.platform !== 'darwin') {
  console.error('macos voice capture: skip, not Darwin')
  process.exit(0)
}

mkdirSync(resolve(packageRoot, 'prebuilds/darwin-universal'), { recursive: true })
const scratch = mkdtempSync(join(tmpdir(), 'dsh-agi-voice-capture-'))
try {
  const parts = targets.map((target) => {
    const out = join(scratch, target)
    const result = spawnSync('swiftc', [
      '-O',
      '-target', target,
      '-parse-as-library',
      '-o', out,
      swiftSource,
      '-framework', 'AudioToolbox',
      '-framework', 'CoreAudio',
      '-framework', 'AVFoundation',
    ], { cwd: packageRoot, stdio: 'inherit' })
    if (result.error !== undefined) throw result.error
    if (result.status !== 0) {
      throw new Error(`dsh-agi-voice-capture ${target}: swiftc exited with ${String(result.status ?? result.signal)}`)
    }
    return out
  })
  const linked = spawnSync('lipo', ['-create', ...parts, '-output', output], { stdio: 'inherit' })
  if (linked.error !== undefined) throw linked.error
  if (linked.status !== 0) {
    throw new Error(`dsh-agi-voice-capture lipo exited with ${String(linked.status ?? linked.signal)}`)
  }
  const signed = spawnSync('codesign', ['--force', '--sign', '-', output], { stdio: 'inherit' })
  if (signed.error !== undefined) throw signed.error
  if (signed.status !== 0) {
    throw new Error(`dsh-agi-voice-capture codesign exited with ${String(signed.status ?? signed.signal)}`)
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
console.error(`dsh-agi-voice-capture: ${output}`)
