#!/usr/bin/env node
/**
 * Stand-in for dsh-agi-voice-capture.
 * stdout is 16 kHz mono Float32. stderr is one JSON event per line, plus a
 * `pid <n>` log line. FAKE_CAPTURE=denied exits 3. FAKE_CAPTURE=silent never
 * sends ready. FAKE_PCM is paced out after ready, then one second of silence.
 */
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

process.stderr.write(`pid ${process.pid}\n`)
createInterface({ input: process.stdin }).on('close', () => process.exit(0))

const mode = process.env.FAKE_CAPTURE ?? ''
if (mode === 'denied') {
  process.stderr.write(`${JSON.stringify({ event: 'error', code: 'mic-denied', message: 'denied' })}\n`)
  process.exit(3)
}
if (mode === 'silent') {
  await new Promise(() => {})
}

process.stderr.write(`${JSON.stringify({ event: 'ready', aec: true, input: 'fake', output: 'fake' })}\n`)
const pcm = process.env.FAKE_PCM
const audio = pcm ? readFileSync(pcm) : Buffer.alloc(0)
const bytes = Buffer.concat([audio, Buffer.alloc(16000 * 4)])
for (let offset = 0; offset < bytes.length; offset += 3200) {
  if (!process.stdout.write(bytes.subarray(offset, offset + 3200))) {
    await new Promise((resolve) => process.stdout.once('drain', resolve))
  }
  await new Promise((resolve) => setTimeout(resolve, 50))
}
await new Promise(() => {})
