import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ORB_PROMPT_LIMIT, readOrbPrompt } from '../src/orb-prompt.ts'

describe('ball prompt frames', () => {
  it('reads a typed line as an interrupt, the gesture every earlier page sent', () => {
    assert.deepEqual(readOrbPrompt({ type: 'prompt', text: '停止并改成打开设置' }), {
      text: '停止并改成打开设置',
      mode: 'interrupt',
    })
    assert.deepEqual(readOrbPrompt({ type: 'prompt', text: '继续', mode: 'unknown' }), {
      text: '继续',
      mode: 'interrupt',
    })
  })

  it('carries the steering gesture through', () => {
    assert.deepEqual(readOrbPrompt({ type: 'prompt', text: '改成点保存按钮', mode: 'steer' }), {
      text: '改成点保存按钮',
      mode: 'steer',
    })
  })

  it('trims the text and refuses an empty one', () => {
    assert.equal(readOrbPrompt({ type: 'prompt', text: '  \n ' }), undefined)
    assert.equal(readOrbPrompt({ type: 'prompt', text: '  看看桌面  ' })?.text, '看看桌面')
  })

  it('refuses frames outside the prompt contract', () => {
    assert.equal(readOrbPrompt(undefined), undefined)
    assert.equal(readOrbPrompt('看看桌面'), undefined)
    assert.equal(readOrbPrompt({ type: 'question-cancel', id: 'q' }), undefined)
    assert.equal(readOrbPrompt({ type: 'prompt', text: 42 }), undefined)
    assert.equal(readOrbPrompt({ type: 'prompt', text: 'x'.repeat(ORB_PROMPT_LIMIT + 1) }), undefined)
    assert.equal(readOrbPrompt({ type: 'prompt', text: 'x'.repeat(ORB_PROMPT_LIMIT) })?.text.length, ORB_PROMPT_LIMIT)
  })
})
