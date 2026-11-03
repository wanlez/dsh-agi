/** Host half of the settings page. The browser half is `./client`. */

/** Cordis plugin name. The patch id matches this. */
export const name = 'ui-settings-agi'

/** No host services. The page talks to `/.dsh-agi` from the browser. */
export const inject: string[] = []

/** The browser plugin registers the settings section. */
export function apply(): void {}
