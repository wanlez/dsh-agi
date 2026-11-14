/**
 * Read-only Computer Use diagnostics exposed to the host.
 *
 * The observation envelope is for the model; this service is for the settings page and
 * troubleshooting. It never posts input or changes the screen.
 *
 * A preset plugin may not `ctx.provide` a Cordis service: the Host cannot see a preset realm, and
 * the preset registry rejects the composition ("Preset services require isolate realms"). The Host
 * plugin and this preset tool layer are separate builds composed into one process, so the live
 * service travels on a `Symbol.for` global key — the same trade `screen-owner.ts` makes.
 * @module @deepseek-ai/dsh-experimental-tool-computer-use/src/diagnostics
 */

import type { Context } from '@deepseek-ai/cordis'
import type { DesktopBackend } from './backend.ts'
import type { DisplayInventory } from './display-inventory.ts'

/** Cordis service key the Host diagnostics route looks up first. */
export const COMPUTER_USE_DIAGNOSTICS = 'computerUseDiagnostics'

/**
 * Process-global key shared with the Host package.
 * Both sides spell the same `Symbol.for` string, exactly as `screen-owner.ts` does.
 */
const DIAGNOSTICS_KEY = Symbol.for('dsh-agi.computer-use.diagnostics')

/** Read-only diagnostics contract. */
export interface ComputerUseDiagnostics {
  /**
   * Sample the current display inventory.
   * @returns the inventory, or `undefined` when the platform backend cannot enumerate displays.
   */
  displayInventory(): Promise<DisplayInventory | undefined>
}

/** The global holder. */
function holder(): Record<symbol, ComputerUseDiagnostics | undefined> {
  return globalThis as Record<symbol, ComputerUseDiagnostics | undefined>
}

/**
 * The published diagnostics, or `undefined` when Computer Use is not mounted.
 * @returns the live service.
 */
export function computerUseDiagnostics(): ComputerUseDiagnostics | undefined {
  return holder()[DIAGNOSTICS_KEY]
}

/**
 * Publish the diagnostics service for the current desktop backend, and unpublish it on dispose.
 * @param ctx - plugin context.
 * @param backend - wrapped backend used by the tools.
 */
export function installComputerUseDiagnostics(ctx: Context, backend: DesktopBackend): void {
  const service: ComputerUseDiagnostics = {
    async displayInventory() {
      if (backend.displayInventory === undefined) return undefined
      return backend.displayInventory()
    },
  }
  holder()[DIAGNOSTICS_KEY] = service
  ctx.effect(() => () => {
    if (holder()[DIAGNOSTICS_KEY] === service) delete holder()[DIAGNOSTICS_KEY]
  })
}
