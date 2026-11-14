import { describe, expect, it } from 'vitest'
import {
  buildActionReceipt,
  detectModalFromFacts,
  type ActionSnapshot,
  type ModalWindowFact,
} from '../src/action-receipt.ts'

function fact(overrides: Partial<ModalWindowFact> = {}): ModalWindowFact {
  return {
    hwnd: 10,
    ownerHwnd: 0,
    className: 'Notepad',
    title: 'notes',
    visible: true,
    enabled: true,
    child: false,
    ...overrides,
  }
}

function snapshot(overrides: Partial<ActionSnapshot> = {}): ActionSnapshot {
  return {
    windowId: 10,
    windowRect: { x: 10, y: 20, width: 800, height: 600 },
    foregroundWindowId: 10,
    focusWindowId: 11,
    focusOnTarget: true,
    targetEnabled: true,
    ...overrides,
  }
}

describe('modal detection', () => {
  it('reports an owned dialog when the foreground is disabled', () => {
    const modal = detectModalFromFacts(10, [
      fact({ hwnd: 10, title: 'Main', enabled: false }),
      fact({ hwnd: 20, ownerHwnd: 10, className: '#32770', title: 'Sign in', child: true }),
    ])
    expect(modal).toMatchObject({
      present: true,
      windowId: 20,
      title: 'Sign in',
      className: '#32770',
      parentWindowId: 10,
      reason: 'owned-dialog',
    })
    expect(modal?.suggestedActions).toEqual(['press-esc', 'focus-modal', 'ask-user'])
  })

  it('does not flag a modeless dialog on an enabled foreground', () => {
    expect(detectModalFromFacts(10, [
      fact({ hwnd: 10, title: 'Main' }),
      fact({ hwnd: 20, ownerHwnd: 10, className: '#32770', title: 'Find' }),
    ])).toBeUndefined()
  })

  it('reports a dialog whose owner is disabled', () => {
    const modal = detectModalFromFacts(20, [
      fact({ hwnd: 10, className: 'Main', enabled: false }),
      fact({ hwnd: 20, ownerHwnd: 10, className: '#32770', title: 'Confirm' }),
    ])
    expect(modal).toMatchObject({ windowId: 20, parentWindowId: 10, reason: 'owned-dialog' })
  })

  it('accepts a UIA modal probe result when supplied', () => {
    const modal = detectModalFromFacts(10, [
      fact({ hwnd: 10 }),
      fact({ hwnd: 30, className: 'CustomDialog', title: 'UIA modal', child: true }),
    ], 30)
    expect(modal).toMatchObject({ windowId: 30, reason: 'uia-modal' })
  })

  it('reports the disabled foreground when no dialog can be resolved', () => {
    expect(detectModalFromFacts(10, [
      fact({ hwnd: 10, title: 'Busy', enabled: false }),
    ])).toMatchObject({ windowId: 10, reason: 'foreground-disabled' })
  })
})

describe('action receipt', () => {
  it('records all four checks and their issues', () => {
    const receipt = buildActionReceipt({
      action: 'click',
      performed: true,
      before: snapshot(),
      after: snapshot({
        focusOnTarget: false,
        foregroundWindowId: 99,
        targetEnabled: false,
        windowRect: { x: 20, y: 30, width: 800, height: 600 },
      }),
      checkedAt: new Date('2026-11-14T00:00:00.000Z'),
    })
    expect(receipt.checks).toEqual({
      focusRetained: false,
      foregroundUnchanged: false,
      targetEnabled: false,
      windowRectStable: false,
    })
    expect(receipt.issues.map(issue => issue.code).sort()).toEqual([
      'focus-lost',
      'foreground-changed',
      'rect-moved',
      'target-disabled',
    ])
    expect(receipt.performed).toBe(true)
    expect(receipt.checkedAt).toBe('2026-11-14T00:00:00.000Z')
  })

  it('omits unavailable checks and says so instead of passing them silently', () => {
    const receipt = buildActionReceipt({ action: 'click', performed: false })
    expect(receipt.checks).toEqual({})
    expect(receipt.issues).toMatchObject([{ code: 'snapshot-unavailable', severity: 'info' }])
  })

  it('does not call a never-focused target a focus loss', () => {
    const receipt = buildActionReceipt({
      action: 'click',
      performed: true,
      before: snapshot({ focusOnTarget: false }),
      after: snapshot({ focusOnTarget: false }),
    })
    expect(receipt.checks.focusRetained).toBeUndefined()
    expect(receipt.issues.some(issue => issue.code === 'focus-lost')).toBe(false)
  })

  it('flags a modal that appears in the after snapshot', () => {
    const receipt = buildActionReceipt({
      action: 'click',
      performed: false,
      before: snapshot(),
      after: snapshot({
        modal: {
          present: true,
          windowId: 20,
          title: 'Confirm',
          className: '#32770',
          parentWindowId: 10,
          reason: 'owned-dialog',
          suggestedActions: ['press-esc'],
        },
      }),
    })
    expect(receipt.modal?.windowId).toBe(20)
    expect(receipt.issues.map(issue => issue.code)).toContain('modal-present')
  })
})
