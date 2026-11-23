import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { normalizeLabel } from '../src/web/tools.ts'

describe('control label matching', () => {
  it('folds width, case and whitespace so a name matches what the page shows', () => {
    assert.equal(normalizeLabel('  保存 '), '保存')
    assert.equal(normalizeLabel('ＳＡＶＥ'), 'save')
    assert.equal(normalizeLabel('  Search   Orders '), 'search orders')
  })

  it('keeps distinct names distinct', () => {
    assert.notEqual(normalizeLabel('保存'), normalizeLabel('保存草稿'))
  })
})
