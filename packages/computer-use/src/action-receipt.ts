/**
 * Structured pre-click modal warning and post-action verification.
 *
 * A click is never posted while a modal dialog owns the interaction. The native layer
 * reports the disabled foreground, its enabled popup, and owned/dialog children; this
 * module turns those facts into one structured warning and gives the caller actions it can
 * choose from instead of silently clicking into a blocked window.
 *
 * After an action the backend samples the same target and {@link buildActionReceipt}
 * records four checks: focus retention, foreground stability, whether the target became
 * disabled, and whether the window moved enough to invalidate the point.
 * @module @deepseek-ai/dsh-experimental-tool-computer-use/src/action-receipt
 */

import type { DisplayRect } from './display-inventory.ts'
import type { HoverFeedback } from './hover.ts'
import { sanitizeModelText } from './text-sanitize.ts'

/** Reason a modal warning was raised. */
export type ModalReason = 'foreground-disabled' | 'owned-dialog' | 'dialog-child' | 'uia-modal'

/** Action the caller may take after a modal warning; coordinates are never guessed. */
export type ModalSuggestedAction = 'press-esc' | 'focus-modal' | 'ask-user'

/** Structured modal warning returned instead of a blind click. */
export interface ModalState {
  readonly present: true
  /** Modal window, or the disabled foreground when its popup cannot be resolved. */
  readonly windowId: number
  /** Sanitized modal title; may be empty. */
  readonly title: string
  /** Sanitized Win32 class name. */
  readonly className: string
  /** Disabled foreground window. */
  readonly parentWindowId: number
  readonly reason: ModalReason
  readonly suggestedActions: ModalSuggestedAction[]
}

/** One window fact used by the pure modal heuristic. */
export interface ModalWindowFact {
  readonly hwnd: number
  readonly ownerHwnd: number
  readonly className: string
  readonly title: string
  readonly visible: boolean
  readonly enabled: boolean
  /** True for a child window; child dialogs belong to their parent. */
  readonly child: boolean
}

/** Cursor kind reported by the native probe. */
export type CursorKind = 'arrow' | 'hand' | 'ibeam' | 'cross' | 'wait' | 'resize' | 'other' | 'hidden'

/** Cursor signal used as an auxiliary hover check. */
export interface ActionCursor {
  readonly handle: string
  readonly kind: CursorKind
}

/** Point-in-time environment around one pointer target. */
export interface ActionSnapshot {
  /** Window the action targeted; omitted when the point had no resolvable top-level window. */
  readonly windowId?: number
  /** Window rectangle in physical pixels. */
  readonly windowRect?: DisplayRect
  readonly foregroundWindowId: number
  readonly focusWindowId: number
  /** True when the focus window is the target or a descendant of it. */
  readonly focusOnTarget: boolean
  readonly targetEnabled: boolean
  readonly modal?: ModalState
  readonly cursor?: ActionCursor
}

/** One failed or informational post-action check. */
export interface ActionIssue {
  readonly code:
    | 'focus-lost'
    | 'foreground-changed'
    | 'target-disabled'
    | 'rect-moved'
    | 'modal-present'
    | 'snapshot-unavailable'
  readonly severity: 'info' | 'warn'
  readonly message: string
}

/** Four-check result written into the action receipt. Missing checks are omitted. */
export interface ActionChecks {
  readonly focusRetained?: boolean
  readonly foregroundUnchanged?: boolean
  readonly targetEnabled?: boolean
  readonly windowRectStable?: boolean
}

/** Structured receipt attached to a tool result. */
export interface ActionReceipt {
  readonly action: string
  readonly performed: boolean
  readonly checkedAt: string
  readonly checks: ActionChecks
  readonly issues: ActionIssue[]
  readonly modal?: ModalState
  readonly hover?: HoverFeedback
}

/** Input to {@link buildActionReceipt}. */
export interface ActionReceiptInput {
  readonly action: string
  readonly performed: boolean
  readonly before?: ActionSnapshot
  readonly after?: ActionSnapshot
  readonly modal?: ModalState
  readonly hover?: HoverFeedback
  /** Window movement tolerance in physical pixels. Default: 2. */
  readonly rectTolerancePx?: number
  readonly checkedAt?: Date
}

function includesDialogClass(className: string): boolean {
  const lower = className.toLowerCase()
  return className === '#32770' || lower.includes('dialog') || lower.includes('modal')
}

function byHwnd(facts: readonly ModalWindowFact[]): ReadonlyMap<number, ModalWindowFact> {
  return new Map(facts.map(fact => [fact.hwnd, fact]))
}

function ownerChainReaches(
  facts: ReadonlyMap<number, ModalWindowFact>,
  candidate: ModalWindowFact,
  rootHwnd: number,
): boolean {
  let current = candidate.ownerHwnd
  const seen = new Set<number>()
  while (current !== 0 && !seen.has(current)) {
    if (current === rootHwnd) return true
    seen.add(current)
    current = facts.get(current)?.ownerHwnd ?? 0
  }
  return false
}

function modalOf(fact: ModalWindowFact, parentWindowId: number, reason: ModalReason): ModalState {
  return {
    present: true,
    windowId: fact.hwnd,
    title: sanitizeModelText(fact.title, { maxChars: 200 }),
    className: sanitizeModelText(fact.className, { maxChars: 120 }),
    parentWindowId,
    reason,
    suggestedActions: ['press-esc', 'focus-modal', 'ask-user'],
  }
}

/**
 * Pure modal heuristic over a foreground window and its visible relatives.
 *
 * Strong signal: the foreground root is disabled. The enabled popup (`GW_ENABLEDPOPUP`)
 * or an owned visible dialog is then the modal window. A foreground dialog whose owner is
 * disabled is also treated as modal. A modeless dialog on an enabled owner is deliberately
 * not reported, which keeps Find/Replace and other modeless tool windows usable.
 * @param foregroundHwnd - root foreground window, or `0`.
 * @param facts - top-level and child window facts.
 * @param uiaModalHwnd - optional HWND a UIA `IsModal` probe identified.
 * @returns a modal warning, or `undefined` when the click may proceed.
 */
export function detectModalFromFacts(
  foregroundHwnd: number,
  facts: readonly ModalWindowFact[],
  uiaModalHwnd?: number,
): ModalState | undefined {
  if (foregroundHwnd <= 0) return undefined
  const index = byHwnd(facts)
  const root = index.get(foregroundHwnd) ?? facts.find(fact => !fact.child && fact.hwnd === foregroundHwnd)
  if (root === undefined) return undefined
  if (uiaModalHwnd !== undefined && uiaModalHwnd !== 0) {
    const uiaModal = index.get(uiaModalHwnd)
    if (uiaModal !== undefined) return modalOf(uiaModal, root.hwnd, 'uia-modal')
  }
  if (!root.enabled) {
    const candidates = facts.filter(fact => fact.visible && fact.enabled && fact.hwnd !== root.hwnd)
    const owned = candidates.find(fact => includesDialogClass(fact.className)
      && (fact.child || ownerChainReaches(index, fact, root.hwnd)))
    const popup = owned ?? candidates.find(fact => includesDialogClass(fact.className))
    return modalOf(popup ?? root, root.hwnd, popup === undefined ? 'foreground-disabled' : 'owned-dialog')
  }
  const ownedDialog = facts.find(fact => fact.hwnd !== root.hwnd
    && fact.visible
    && includesDialogClass(fact.className)
    && ownerChainReaches(index, fact, root.hwnd)
    && (fact.child || fact.ownerHwnd === root.hwnd))
  if (ownedDialog !== undefined) {
    // A dialog whose owner is enabled is modeless unless Windows disabled that owner;
    // this branch is reached only for a child/owner dialog, so keep it informational.
    return undefined
  }
  if (includesDialogClass(root.className) && root.ownerHwnd !== 0) {
    const owner = index.get(root.ownerHwnd)
    if (owner !== undefined && !owner.enabled) return modalOf(root, owner.hwnd, 'owned-dialog')
  }
  return undefined
}

function rectChanged(before: DisplayRect | undefined, after: DisplayRect | undefined, tolerance: number): boolean {
  if (before === undefined || after === undefined) return false
  return Math.abs(before.x - after.x) > tolerance
    || Math.abs(before.y - after.y) > tolerance
    || Math.abs(before.width - after.width) > tolerance
    || Math.abs(before.height - after.height) > tolerance
}

function formatRect(rect: DisplayRect): string {
  return `${String(Math.round(rect.x))},${String(Math.round(rect.y))} ${String(Math.round(rect.width))}x${String(Math.round(rect.height))}`
}

/**
 * Build the four-check receipt.
 *
 * Checks with no snapshot are `null` and produce one `snapshot-unavailable` issue so an
 * absent check is never mistaken for a passing check. The function never throws on missing
 * optional fields; calling code can attach the receipt without blocking the action result.
 * @param input - snapshots, action name, and whether input was performed.
 * @returns structured receipt.
 */
export function buildActionReceipt(input: ActionReceiptInput): ActionReceipt {
  const tolerance = Math.max(0, Math.round(input.rectTolerancePx ?? 2))
  const before = input.before
  const after = input.after
  const issues: ActionIssue[] = []
  if (before === undefined || after === undefined) {
    issues.push({
      code: 'snapshot-unavailable',
      severity: 'info',
      message: 'Action environment could not be sampled on both sides of the action.',
    })
  }
  const focusRetained = before === undefined || after === undefined
    ? undefined
    : before.focusOnTarget
      ? after.focusOnTarget
      : after.focusOnTarget
        ? true
        : undefined
  if (focusRetained === false) {
    issues.push({
      code: 'focus-lost',
      severity: 'warn',
      message: 'The target lost keyboard focus after the action.',
    })
  }
  const foregroundUnchanged = before === undefined || after === undefined
    ? undefined
    : before.foregroundWindowId === after.foregroundWindowId
  if (foregroundUnchanged === false) {
    issues.push({
      code: 'foreground-changed',
      severity: 'info',
      message: `Foreground changed from ${String(before?.foregroundWindowId ?? 0)} to ${String(after?.foregroundWindowId ?? 0)}.`,
    })
  }
  const targetEnabled = after === undefined ? undefined : after.targetEnabled
  if (targetEnabled === false) {
    issues.push({
      code: 'target-disabled',
      severity: 'warn',
      message: 'The target window is disabled, so further input would be discarded.',
    })
  }
  const moved = rectChanged(before?.windowRect, after?.windowRect, tolerance)
  const windowRectStable = before === undefined || after === undefined ? undefined : !moved
  if (moved) {
    const from = before?.windowRect
    const to = after?.windowRect
    issues.push({
      code: 'rect-moved',
      severity: 'warn',
      message: `Window rectangle moved (${from === undefined ? 'unknown' : formatRect(from)} → ${to === undefined ? 'unknown' : formatRect(to)}); the painted point may be stale.`,
    })
  }
  const modal = input.modal ?? after?.modal
  if (modal !== undefined) {
    issues.push({
      code: 'modal-present',
      severity: 'warn',
      message: `A modal window is present: ${modal.title || modal.className || 'untitled dialog'}.`,
    })
  }
  return {
    action: sanitizeModelText(input.action, { maxChars: 80 }),
    performed: input.performed,
    checkedAt: (input.checkedAt ?? new Date()).toISOString(),
    checks: {
      ...focusRetained === undefined ? {} : { focusRetained },
      ...foregroundUnchanged === undefined ? {} : { foregroundUnchanged },
      ...targetEnabled === undefined ? {} : { targetEnabled },
      ...windowRectStable === undefined ? {} : { windowRectStable },
    },
    issues,
    ...modal === undefined ? {} : { modal },
    ...input.hover === undefined ? {} : { hover: input.hover },
  }
}

/**
 * One-line summary for the tool result intro.
 * @param receipt - structured receipt.
 * @returns sanitized summary.
 */
export function actionReceiptText(receipt: ActionReceipt): string {
  if (receipt.issues.length === 0) return 'Action check: focus, foreground, enabled state, and window rectangle are unchanged.'
  const warnings = receipt.issues.filter(issue => issue.severity === 'warn').length
  return `Action check: ${String(receipt.issues.length)} issue(s), ${String(warnings)} warning(s).`
}
