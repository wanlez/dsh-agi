/**
 * Whether the wake, speech-to-text, and TTS files are complete.
 * A missing file means that column does not run. Hashes are for the update check.
 */

import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ASR_MODEL_BYTES } from '@dsh-agi/voice/manifest'
import { type VoicePresence } from './voice.ts'

const ASR_FILES = [
  ['models/sensevoice-onnx/model.int8.onnx', 239_233_841],
  ['models/sensevoice-onnx/tokens.txt', 315_894],
  ['models/silero/silero_vad.onnx', 1_807_522],
] as const

export function asrPresent(root: string): boolean {
  return ASR_FILES.every(([file, bytes]) => sameSize(join(root, file), bytes))
    && ASR_FILES.reduce((sum, [, bytes]) => sum + bytes, 0) === ASR_MODEL_BYTES
}

export function kwsPresent(root: string): boolean {
  const names = ['tokens.txt', 'en.phone']
  for (const chunk of [8, 16]) {
    const tag = `chunk-${chunk}`
    names.push(
      `encoder-epoch-13-avg-2-${tag}-left-64.int8.onnx`,
      `decoder-epoch-13-avg-2-${tag}-left-64.onnx`,
      `joiner-epoch-13-avg-2-${tag}-left-64.int8.onnx`,
    )
  }
  return names.every((name) => existsSync(join(root, name)))
}

export function ttsPresent(root: string): boolean {
  const zh = join(root, 'matcha-icefall-zh-baker')
  const en = join(root, 'matcha-icefall-en_US-ljspeech')
  const zhFiles = ['model-steps-3.onnx', 'tokens.txt', 'lexicon.txt', 'date.fst', 'number.fst', 'phone.fst']
  const enFiles = ['model-steps-3.onnx', 'tokens.txt']
  return zhFiles.every((name) => existsSync(join(zh, name)))
    && enFiles.every((name) => existsSync(join(en, name)))
    && existsSync(join(en, 'espeak-ng-data'))
    && existsSync(join(root, 'vocos-22khz-univ.onnx'))
}

export function voicePresence(paths: { kws: string, asr: string, tts: string }): VoicePresence {
  return {
    wake: kwsPresent(paths.kws),
    asr: asrPresent(paths.asr),
    tts: ttsPresent(paths.tts),
  }
}

function sameSize(file: string, bytes: number): boolean {
  try {
    return statSync(file).size === bytes
  } catch {
    return false
  }
}
