import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const tts = join(homedir(), '.dsh', 'dsh-agi', 'voice', 'tts')
const ready = existsSync(join(tts, 'matcha-icefall-zh-baker', 'model-steps-3.onnx'))
const childPath = join(import.meta.dirname, '../src/child.ts')

describe('voice child playback', () => {
  it('ends a segment that is stopped before the speaker starts', { skip: !ready }, async () => {
    const child = spawn(process.execPath, [
      '--experimental-transform-types',
      '--disable-warning=ExperimentalWarning',
      childPath,
    ], { stdio: ['pipe', 'pipe', 'pipe'] })
    const lines: string[] = []
    let buffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      let cut = buffer.indexOf('\n')
      while (cut >= 0) {
        lines.push(buffer.slice(0, cut))
        buffer = buffer.slice(cut + 1)
        cut = buffer.indexOf('\n')
      }
    })
    const waitFor = (match: (message: Record<string, unknown>) => boolean, timeoutMs = 15_000) => {
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const deadline = Date.now() + timeoutMs
        let timer: NodeJS.Timeout
        const poll = () => {
          const index = lines.findIndex((line) => {
            try {
              return match(JSON.parse(line) as Record<string, unknown>)
            } catch {
              return false
            }
          })
          if (index >= 0) {
            const [line] = lines.splice(index, 1)
            clearTimeout(timer)
            resolve(JSON.parse(line ?? '{}') as Record<string, unknown>)
            return
          }
          if (Date.now() >= deadline) {
            clearTimeout(timer)
            reject(new Error('timed out waiting for a child message'))
            return
          }
          timer = setTimeout(poll, 20)
        }
        timer = setTimeout(poll, 0)
      })
    }
    const send = (message: unknown) => { child.stdin.write(`${JSON.stringify(message)}\n`) }
    try {
      send({
        type: 'configure',
        settings: { ttsEnabled: true, ttsSpeed: 1.5, wakeEnabled: false, commandEnabled: false },
        paths: { tts },
      })
      // Both listening columns are off: the child must not open the microphone,
      // so no `mic` message arrives at all.
      await new Promise((resolve) => setTimeout(resolve, 400))
      assert.deepEqual(lines, [], 'no microphone is opened when wake and voice input are both off')
      send({ type: 'speak', id: 'cut', text: '我去查一下今天的天气，然后告诉你要不要带伞，再看看明天适不适合出门。' })
      const started = Date.now()
      send({ type: 'stop-speak' })
      const end = await waitFor((message) => message.type === 'playback' && message.phase === 'end')
      const elapsed = Date.now() - started
      assert.equal(end.id, 'cut')
      assert.equal(end.stopped, true)
      // Starting the TTS worker can take a couple of seconds under a loaded test
      // run; the point is that stop does not wait for the sentence to synthesize.
      assert.ok(elapsed < 5000, `stop waited ${elapsed}ms for synthesis`)
    } finally {
      child.kill()
    }
  })

  it('stops the previous sentence when a new speak arrives', { skip: !ready }, async () => {
    const child = spawn(process.execPath, [
      '--experimental-transform-types',
      '--disable-warning=ExperimentalWarning',
      childPath,
    ], { stdio: ['pipe', 'pipe', 'pipe'] })
    const lines: string[] = []
    let buffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      let cut = buffer.indexOf('\n')
      while (cut >= 0) {
        lines.push(buffer.slice(0, cut))
        buffer = buffer.slice(cut + 1)
        cut = buffer.indexOf('\n')
      }
    })
    const waitFor = (match: (message: Record<string, unknown>) => boolean, timeoutMs = 15_000) => {
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const deadline = Date.now() + timeoutMs
        let timer: NodeJS.Timeout
        const poll = () => {
          const index = lines.findIndex((line) => {
            try {
              return match(JSON.parse(line) as Record<string, unknown>)
            } catch {
              return false
            }
          })
          if (index >= 0) {
            const [line] = lines.splice(index, 1)
            clearTimeout(timer)
            resolve(JSON.parse(line ?? '{}') as Record<string, unknown>)
            return
          }
          if (Date.now() >= deadline) {
            clearTimeout(timer)
            reject(new Error('timed out waiting for a child message'))
            return
          }
          timer = setTimeout(poll, 20)
        }
        timer = setTimeout(poll, 0)
      })
    }
    const send = (message: unknown) => { child.stdin.write(`${JSON.stringify(message)}\n`) }
    try {
      send({
        type: 'configure',
        settings: { ttsEnabled: true, ttsSpeed: 1.5, wakeEnabled: false, commandEnabled: false },
        paths: { tts },
      })
      send({ type: 'speak', id: 'first', text: '我去查一下今天的天气，然后告诉你要不要带伞，再看看明天适不适合出门。' })
      await waitFor((message) => message.type === 'playback' && message.id === 'first' && message.phase === 'start')
      send({ type: 'speak', id: 'second', text: '好的。' })
      const firstEnd = await waitFor((message) => message.type === 'playback' && message.id === 'first' && message.phase === 'end')
      assert.equal(firstEnd.stopped, true)
      await waitFor((message) => message.type === 'playback' && message.id === 'second' && message.phase === 'start')
      const secondEnd = await waitFor((message) => message.type === 'playback' && message.id === 'second' && message.phase === 'end')
      assert.notEqual(secondEnd.stopped, true)
    } finally {
      child.kill()
    }
  })
})
