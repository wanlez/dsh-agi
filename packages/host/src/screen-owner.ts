/**
 * Host-side view of the process-global desktop owner.
 *
 * The preset's tool layer refuses GUI and shell calls from any session that is not the owner; the
 * orb host is the only component that knows which conversation the ball panel shows, so it publishes
 * that here. The record itself lives on `globalThis` under a `Symbol.for` key — the host package and
 * `@dsh-agi/computer-use` are separate builds sharing one process, and duplicating the four lines
 * that touch a symbol-keyed global is the same trade `@dsh-agi/computer-use/src/gui-lock.ts` makes
 * for the screen mutex. Keep the key in step with that module.
 */

const SCREEN_OWNER = Symbol.for('dsh-agi.screen-owner')

interface ScreenOwnerState {
  /** Session id of the conversation the ball currently shows, or empty when unrestricted. */
  ownerId: string
}

function state(): ScreenOwnerState {
  const holder = globalThis as { [SCREEN_OWNER]?: ScreenOwnerState }
  holder[SCREEN_OWNER] ??= { ownerId: '' }
  return holder[SCREEN_OWNER]!
}

/**
 * Publish the session the ball shows. Every ball conversation except this one loses GUI and shell
 * access; an empty id (no ball, or the helper stopped) leaves every session unrestricted.
 * @param sessionId - the displayed conversation, or undefined to lift the restriction.
 */
export function publishScreenOwner(sessionId: string | undefined): void {
  state().ownerId = typeof sessionId === 'string' ? sessionId : ''
}
