import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { findFlow, listFlows, saveFlow } from '../src/web/flow.ts'

describe('web flow store', () => {
  it('saves, updates by name and finds a flow', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flow-test-'))
    const created = saveFlow(dir, { name: '每日对账', steps: [{ action: 'click', target: '对账', expect: { text: '完成' } }] })
    assert.equal(listFlows(dir).length, 1)
    assert.equal(findFlow(dir, '每日对账')?.id, created.id)

    const updated = saveFlow(dir, { name: '每日对账', steps: [{ action: 'back' }] })
    assert.equal(updated.id, created.id)
    assert.equal(listFlows(dir)[0]?.steps.length, 1)
    assert.equal(listFlows(dir)[0]?.steps[0]?.action, 'back')
  })

  it('reads a broken file as no flows instead of throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flow-test-'))
    saveFlow(dir, { name: 'x', steps: [] })
    assert.deepEqual(findFlow(dir, 'missing'), undefined)
  })
})
