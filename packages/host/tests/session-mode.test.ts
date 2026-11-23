import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { ProfileStore } from '../src/preferences.ts'

function fresh(): string {
  return mkdtempSync(join(tmpdir(), 'agi-mode-'))
}

describe('ball session mode default', () => {
  it('starts isolated on a profile that never chose', () => {
    assert.equal(new ProfileStore(fresh()).sessionMode(), 'isolated')
  })

  it('ignores a mode file the pre-rename plugin left behind', () => {
    const dir = fresh()
    writeFileSync(join(dir, 'agi-session-mode.json'), JSON.stringify({ mode: 'shared' }))
    assert.equal(new ProfileStore(dir).sessionMode(), 'isolated', 'legacy shared is not a choice')
  })

  it('keeps what the operator picked, and marks it as theirs', () => {
    const dir = fresh()
    const store = new ProfileStore(dir)
    store.setSessionMode('shared')
    const saved = JSON.parse(readFileSync(join(dir, 'agi-session-mode.json'), 'utf8'))
    assert.deepEqual(saved, { mode: 'shared', source: 'operator' })
    assert.equal(new ProfileStore(dir).sessionMode(), 'shared')
    store.setSessionMode('isolated')
    assert.equal(new ProfileStore(dir).sessionMode(), 'isolated')
  })
})
