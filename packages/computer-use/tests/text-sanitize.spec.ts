import { describe, expect, it } from 'vitest'
import {
  formatObservationStatus,
  observationState,
  safeJsonStringify,
  sanitizeJsonValue,
  sanitizeModelText,
} from '../src/text-sanitize.ts'

describe('model text sanitization', () => {
  it('strips BMP and supplementary private-use characters', () => {
    expect(sanitizeModelText('A\uE000B\u{F0001}C')).toBe('ABC')
  })

  it('repairs a lone surrogate instead of emitting invalid UTF-16', () => {
    const repaired = sanitizeModelText('x\uD800y')
    expect(repaired).toBe('x\uFFFDy')
    expect([...repaired].every(character => character.codePointAt(0) !== 0xd800)).toBe(true)
  })

  it('escapes line breaks and tabs', () => {
    expect(sanitizeModelText('a\r\nb\nc\td')).toBe('a\\nb\\nc\\td')
  })

  it('truncates by code point and states how much was cut', () => {
    const text = sanitizeModelText('abcdefghij', { maxChars: 16 })
    expect(text).toBe('abcdefghij')
    const cut = sanitizeModelText('x'.repeat(40), { maxChars: 16 })
    expect(cut).toBe(`${'x'.repeat(16)}…[truncated 24 chars]`)
    expect(cut).toContain('truncated 24 chars')
  })

  it('does not split an emoji surrogate pair when truncating', () => {
    const cut = sanitizeModelText('😀😀😀', { maxChars: 16 })
    expect(cut).toBe('😀😀😀')
  })

  it('distinguishes unsampled, empty, and provided', () => {
    expect(observationState(false, true)).toBe('unsampled')
    expect(observationState(true, true)).toBe('empty')
    expect(observationState(true, false)).toBe('provided')
    expect(formatObservationStatus({
      foreground: 'provided',
      windowTitle: 'empty',
      capture: 'provided',
      displayInventory: 'unsampled',
    })).toBe(
      '<observation_status>foreground=provided;window_title=empty;capture=provided;display_inventory=unsampled</observation_status>',
    )
  })
})

describe('safe JSON serialization', () => {
  it('sanitizes strings and survives cycles and bigint', () => {
    const value: Record<string, unknown> = {
      title: 'x\uE000\ny',
      big: 10n,
      bad: Number.NaN,
    }
    value.self = value
    const text = safeJsonStringify(value)
    expect(text).toContain('"title":"x\\\\ny"')
    expect(text).toContain('"big":"10"')
    expect(text).toContain('"bad":null')
    expect(text).toContain('[circular]')
    expect(JSON.parse(text)).toBeTypeOf('object')
  })

  it('sanitizes nested errors and returns a fallback when serialization fails', () => {
    expect(sanitizeJsonValue(new Error('bad\nthing'))).toEqual({
      name: 'Error',
      message: 'bad\\nthing',
    })
    expect(safeJsonStringify(new Error('x'))).toContain('"message"')
  })
})
