import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_VOICE_SETTINGS, hasWakeWord, parseVoiceSettings } from '../src/settings.ts'
import { ASR_MODEL_BYTES, WAKE_MODEL_NPM_MIRROR, absentVoiceModels } from '../src/manifest.ts'

describe('voice settings', () => {
  it('uses the factory values when the file is missing or unreadable', () => {
    assert.deepEqual(parseVoiceSettings(undefined), DEFAULT_VOICE_SETTINGS)
    assert.deepEqual(parseVoiceSettings(null), DEFAULT_VOICE_SETTINGS)
    assert.deepEqual(parseVoiceSettings([]), DEFAULT_VOICE_SETTINGS)
    assert.equal(parseVoiceSettings(undefined).voiceEnabled, false, 'a fresh profile starts with voice off')
    assert.equal(parseVoiceSettings({}).voiceEnabled, false)
    assert.equal(parseVoiceSettings({}).wakeWords[0], '你好大肥鱼')
    assert.equal(parseVoiceSettings({}).idleMs, 30_000)
    assert.equal(parseVoiceSettings({}).ttsSpeed, 1.5)
    assert.equal(parseVoiceSettings({}).ttsVolume, 1)
  })

  it('reads a voice file written before the master switch as on', () => {
    assert.equal(parseVoiceSettings({ wakeEnabled: true }, { legacyMaster: true }).voiceEnabled, true)
    assert.equal(parseVoiceSettings({ wakeEnabled: false }, { legacyMaster: true }).voiceEnabled, true)
    assert.equal(parseVoiceSettings({ voiceEnabled: false }, { legacyMaster: true }).voiceEnabled, false, 'an explicit value wins')
    assert.equal(parseVoiceSettings({ wakeEnabled: true }).voiceEnabled, false, 'without the legacy hint, a missing field is off')
  })

  it('keeps a valid field and pulls the others back into range', () => {
    const parsed = parseVoiceSettings({
      voiceEnabled: true,
      wakeEnabled: false,
      commandEnabled: false,
      ttsEnabled: false,
      wakeWords: ['  小鱼 ', '小鱼', ''],
      wakeThreshold: 9,
      wakeScore: 0,
      wakeChunk: 32,
      wakeCooldownMs: 100,
      wakeReply: '  在的  ',
      dismissPhrases: [],
      dismissReply: '',
      questionPrompt: '选一下',
      ttsSpeed: 1.54,
      ttsVolume: 0.37,
      idleMs: 1000,
    })
    assert.equal(parsed.voiceEnabled, true)
    assert.equal(parsed.wakeEnabled, false)
    assert.equal(parsed.commandEnabled, false)
    assert.equal(parsed.ttsEnabled, false)
    assert.deepEqual(parsed.wakeWords, ['小鱼'])
    assert.equal(parsed.wakeThreshold, 0.9)
    assert.equal(parsed.wakeScore, 0.5)
    assert.equal(parsed.wakeChunk, 8)
    assert.equal(parsed.wakeCooldownMs, 500)
    assert.equal(parsed.wakeReply, '在的')
    assert.deepEqual(parsed.dismissPhrases, [])
    assert.equal(parsed.dismissReply, '')
    assert.equal(parsed.questionPrompt, '选一下')
    assert.equal(parsed.ttsSpeed, 1.5)
    assert.equal(parsed.ttsVolume, 0.37)
    assert.equal(parsed.idleMs, 5000)
    assert.equal(parseVoiceSettings({ wakeChunk: 16, ttsSpeed: 3, idleMs: 600_000 }).wakeChunk, 16)
    assert.equal(parseVoiceSettings({ ttsSpeed: 3, idleMs: 600_000 }).ttsSpeed, 3)
    assert.equal(parseVoiceSettings({ idleMs: 600_000 }).idleMs, 600_000)
  })

  it('keeps the speech volume inside 0–2 at two decimals', () => {
    assert.equal(parseVoiceSettings({ ttsVolume: 0 }).ttsVolume, 0)
    assert.equal(parseVoiceSettings({ ttsVolume: -0.4 }).ttsVolume, 0)
    assert.equal(parseVoiceSettings({ ttsVolume: 1.234 }).ttsVolume, 1.23)
    assert.equal(parseVoiceSettings({ ttsVolume: 2.5 }).ttsVolume, 2)
    assert.equal(parseVoiceSettings({ ttsVolume: Number.NaN }).ttsVolume, 1)
    assert.equal(parseVoiceSettings({ ttsVolume: 'loud' }).ttsVolume, 1)
  })

  it('keeps the interject keyword separate from the wake word', () => {
    assert.equal(parseVoiceSettings({}).interjectKeyword, '大肥鱼')
    assert.equal(parseVoiceSettings({ interjectKeyword: '  ' }).interjectKeyword, '')
    assert.equal(parseVoiceSettings({ interjectKeyword: '鱼'.repeat(41) }).interjectKeyword, '鱼'.repeat(40))
    assert.equal(parseVoiceSettings({ interjectKeyword: 1 }).interjectKeyword, '大肥鱼')
    assert.equal(parseVoiceSettings({ wakeWords: ['别的'] }).interjectKeyword, '大肥鱼')
    assert.deepEqual(parseVoiceSettings({ interjectKeyword: '小鱼' }).wakeWords, ['你好大肥鱼'])
  })

  it('reads an empty or blank wake list as no wake word', () => {
    assert.equal(hasWakeWord(['你好大肥鱼']), true)
    assert.equal(hasWakeWord([]), false)
    assert.equal(hasWakeWord(['   ']), false)
  })

  it('describes the three official downloads while the files are absent', () => {
    const models = absentVoiceModels()
    assert.equal(models.wake.present, false)
    assert.match(models.wake.sources[0] ?? '', /registry\.npmmirror\.com\/dsh-agi-kws\//)
    assert.equal(models.wake.sources[0], WAKE_MODEL_NPM_MIRROR)
    assert.equal(models.tts.sources.length, 3)
    assert.equal(models.asr.bytes, ASR_MODEL_BYTES)
    assert.equal(Math.round(models.asr.bytes / (1024 * 1024)), 230)
    // The registry serves the wake model as an 8.6 MB tarball, not the 31 MB GitHub release.
    assert.equal(Math.round(models.wake.bytes / (1024 * 1024)), 9)
    assert.equal(Math.round(models.tts.bytes / (1024 * 1024)), 197)
  })
})