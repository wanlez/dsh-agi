/**
 * Safe-mode input watch: the low-level hook worker runs real keyboard and mouse events
 * past an injected-event filter, so synthetic input from the agent never reaches this
 * callback. Only the user's own keys and pointer can stop a turn.
 */

import { installWindowsSelectionHooks } from '@dsh-agi/native-selection'

export interface UserInputWatch {
  stop(): void
}

/**
 * Start watching for hardware input.
 * @param onInput - called once per throttled real input event.
 * @returns a handle that unhooks the worker.
 */
export function startUserInputWatch(onInput: () => void): UserInputWatch {
  if (process.platform !== 'win32') return { stop() {} }
  try {
    const stop = installWindowsSelectionHooks((message: unknown) => {
      if (message === null || typeof message !== 'object') return
      if ((message as { type?: unknown }).type === 'user-input') onInput()
    })
    return { stop }
  } catch (error) {
    console.error(`dsh-agi: safe-mode input watch failed: ${error instanceof Error ? error.message : String(error)}`)
    return { stop() {} }
  }
}
