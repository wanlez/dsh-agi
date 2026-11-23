import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { CHROMIUM_ASSET, CHROMIUM_URL, CHROMIUM_VERSION, chromiumExecutable, chromiumStatus } from '../src/web/chromium.ts'
import { detectRemoteEnvironment } from '../src/web/env.ts'
import { defaultWebSettings, mergeWebSettings, readWebSettings, writeWebSettings } from '../src/web/settings.ts'

describe('web settings', () => {
  it('defaults to off with a bundled browser and no paths', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agi-web-'))
    assert.deepEqual(readWebSettings(dir), defaultWebSettings())
    assert.equal(readWebSettings(dir).enabled, false)
  })

  it('round-trips a partial update and ignores unknown values', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agi-web-'))
    const base = defaultWebSettings()
    const next = mergeWebSettings(base, { enabled: true, mode: 'chrome', chromePath: 'C:\\chrome.exe' })
    writeWebSettings(dir, next)
    const read = readWebSettings(dir)
    assert.equal(read.enabled, true)
    assert.equal(read.mode, 'chrome')
    assert.equal(read.chromePath, 'C:\\chrome.exe')
    // A hand-edited file with a bogus mode keeps the default instead of breaking the channel.
    writeFileSync(join(dir, 'agi-web.json'), JSON.stringify({ mode: 'netscape', enabled: true }))
    assert.equal(readWebSettings(dir).mode, 'chromium')
    assert.equal(readWebSettings(dir).enabled, true)
    // A broken file reads as the shipped defaults.
    writeFileSync(join(dir, 'agi-web.json'), '{')
    assert.deepEqual(readWebSettings(dir), defaultWebSettings())
  })

  it('merging keeps untouched fields', () => {
    const base = { ...defaultWebSettings(), chromiumPath: 'D:\\chromium.exe' }
    const next = mergeWebSettings(base, { enabled: true })
    assert.equal(next.chromiumPath, 'D:\\chromium.exe', 'an unrelated field survives')
    assert.equal(next.mode, 'chromium')
  })
})

describe('remote environment probe', () => {
  it('reports evidence in a shape the settings page can render', () => {
    const env = detectRemoteEnvironment()
    assert.equal(typeof env.blocked, 'boolean')
    assert.equal(typeof env.reason, 'string')
    assert.ok(Array.isArray(env.evidence))
    if (env.blocked) assert.notEqual(env.reason, '')
  })
})

describe('bundled chromium', () => {
  it('downloads from this project, never an upstream CDN', () => {
    assert.match(CHROMIUM_URL, /^https:\/\/github\.com\/wanlez\/dsh-agi\/releases\/download\/web-chromium-/)
    assert.ok(CHROMIUM_URL.endsWith(CHROMIUM_ASSET))
    assert.ok(CHROMIUM_ASSET.includes(CHROMIUM_VERSION))
  })

  it('reports a missing build instead of a fake path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agi-chromium-'))
    assert.equal(chromiumExecutable(dir), '')
    const status = chromiumStatus(dir)
    assert.equal(status.present, false)
    assert.equal(status.version, CHROMIUM_VERSION)
    assert.equal(status.phase, 'idle')
  })
})
