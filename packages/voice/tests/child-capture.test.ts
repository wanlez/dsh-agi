import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const childPath = join(import.meta.dirname, '../src/child.ts')
const fakePath = join(import.meta.dirname, 'fixtures', 'fake-capture.mjs')
const asrRoot = join(homedir(), '.dsh', 'speech-to-text', 'sensevoice', 'models')
const asrModel = join(asrRoot, 'sensevoice-onnx', 'model.int8.onnx')
const asrTokens = join(asrRoot, 'sensevoice-onnx', 'tokens.txt')
const asrVad = join(asrRoot, 'silero', 'silero_vad.onnx')
const asrReady = existsSync(asrModel) && existsSync(asrTokens) && existsSync(asrVad)

function launch(env: Record<string, string | undefined>) {
  const child = spawn(process.execPath, [
    '--experimental-transform-types',
    '--disable-warning=ExperimentalWarning',
    childPath,
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, DSH_AGI_CAPTURE_BIN: fakePath, ...env },
  })
  const stdout: string[] = []
  const stderr: string[] = []
  let outBuf = ''
  let errBuf = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    outBuf += chunk
    let cut = outBuf.indexOf('\n')
    while (cut >= 0) {
      stdout.push(outBuf.slice(0, cut))
      outBuf = outBuf.slice(cut + 1)
      cut = outBuf.indexOf('\n')
    }
  })
  child.stderr.on('data', (chunk: string) => {
    errBuf += chunk
    let cut = errBuf.indexOf('\n')
    while (cut >= 0) {
      stderr.push(errBuf.slice(0, cut))
      errBuf = errBuf.slice(cut + 1)
      cut = errBuf.indexOf('\n')
    }
  })
  const send = (message: unknown) => { child.stdin.write(`${JSON.stringify(message)}\n`) }
  return { child, stdout, stderr, send }
}

function messages(lines: string[]): Record<string, unknown>[] {
  return lines.flatMap((line) => {
    try { return [JSON.parse(line) as Record<string, unknown>] } catch { return [] }
  })
}

function pids(lines: string[]): number[] {
  return lines.flatMap((line) => {
    const match = /^pid (\d+)$/.exec(line)
    return match ? [Number(match[1])] : []
  })
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function until(check: () => boolean, detail: () => string, timeout = 8000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error(`timed out\n${detail()}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function close(child: ChildProcess): void {
  child.stdin.end()
  child.kill()
}

const settings = {
  wakeEnabled: false,
  wakeWords: [] as string[],
  wakeChunk: 8,
  commandEnabled: true,
  interjectKeyword: '大肥鱼',
  dismissPhrases: ['退下吧'],
  ttsEnabled: false,
  ttsSpeed: 1.5,
}

describe('voice capture source', () => {
  const paths = { asrModel, asrTokens, asrVad }

  it('does not open the capture before the first listen, and reopens it when the device is held again', { skip: !asrReady }, async () => {
    const session = launch({})
    try {
      session.send({ type: 'configure', settings, paths })
      await new Promise((resolve) => setTimeout(resolve, 400))
      assert.deepEqual(pids(session.stderr), [], 'configure must not start the capture')
      session.send({ type: 'listen', mode: 'command', device: true })
      await until(
        () => pids(session.stderr).length === 1 && messages(session.stdout).some((item) => item.type === 'mic' && item.open === true && item.aec === true),
        () => `${session.stderr.join('\n')}\n${session.stdout.join('\n')}`,
        20_000,
      )
      const first = pids(session.stderr)[0]
      assert.ok(first)
      session.send({ type: 'listen', mode: 'off', device: false })
      await until(() => !alive(first), () => `pid ${first} still alive`)
      session.send({ type: 'listen', mode: 'interject', device: true })
      await until(() => pids(session.stderr).length >= 2, () => session.stderr.join('\n'), 20_000)
      const second = pids(session.stderr).at(-1)
      assert.ok(second)
      assert.notEqual(second, first)
    } finally {
      close(session.child)
    }
  })

  it('reports a denied microphone and does not fall back to node-cpal', { skip: !asrReady }, async () => {
    const session = launch({ FAKE_CAPTURE: 'denied' })
    try {
      session.send({ type: 'configure', settings, paths })
      session.send({ type: 'listen', mode: 'command', device: true })
      await until(
        () => messages(session.stdout).some((item) => item.type === 'mic' && item.open === false),
        () => `${session.stderr.join('\n')}\n${session.stdout.join('\n')}`,
        20_000,
      )
      await new Promise((resolve) => setTimeout(resolve, 300))
      assert.equal(session.stderr.some((line) => line.includes('capture fallback')), false)
      assert.equal(pids(session.stderr).length, 1)
    } finally {
      close(session.child)
    }
  })

  it('kills a capture that never becomes ready', { skip: !asrReady, timeout: 40_000 }, async () => {
    const session = launch({ FAKE_CAPTURE: 'silent' })
    try {
      session.send({ type: 'configure', settings, paths })
      session.send({ type: 'listen', mode: 'command', device: true })
      await until(() => pids(session.stderr).length === 1, () => session.stderr.join('\n'), 20_000)
      const pid = pids(session.stderr)[0]
      assert.ok(pid)
      await until(
        () => !alive(pid) && session.stderr.some((line) => line.includes('capture fallback')),
        () => session.stderr.join('\n'),
        20_000,
      )
    } finally {
      close(session.child)
    }
  })

  it('keeps one spoken phrase across command and interject', { skip: !asrReady, timeout: 90_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orb-capture-speech-'))
    const aiff = join(dir, 'line.aiff')
    const pcm = join(dir, 'line.f32')
    execFileSync('say', ['-v', 'Tingting', '-o', aiff, '查一下今天的天气'])
    execFileSync('ffmpeg', ['-y', '-i', aiff, '-f', 'f32le', '-ac', '1', '-ar', '16000', pcm], { stdio: 'ignore' })
    const session = launch({ FAKE_PCM: pcm })
    try {
      session.send({
        type: 'configure',
        settings,
        paths: { asrModel, asrTokens, asrVad },
      })
      session.send({ type: 'listen', mode: 'command', seedMs: 0, device: true })
      await until(() => messages(session.stdout).some((item) => item.type === 'speech' && item.open === true), () => session.stdout.join('\n'), 30_000)
      session.send({ type: 'listen', mode: 'interject', device: true })
      await until(() => messages(session.stdout).some((item) => item.type === 'utterance'), () => session.stdout.join('\n'), 60_000)
      const uttered = messages(session.stdout).filter((item) => item.type === 'utterance')
      assert.equal(uttered.length, 1)
      assert.equal(uttered[0]?.mode, 'command')
    } finally {
      close(session.child)
    }
  })
})
