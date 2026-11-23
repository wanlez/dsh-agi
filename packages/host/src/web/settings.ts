/**
 * The web-control settings, stored beside the other profile settings.
 *
 * Defaults are deliberately inert: the channel is off, and nothing is launched until the
 * operator turns it on. Every value is a plain absolute path or a boolean, so a hand-edited
 * file stays readable.
 * @module web/settings
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Where the browser comes from. */
export type WebMode = 'chromium' | 'chrome' | 'attach'

/** Persisted shape of `agi-web.json`. */
export interface WebSettings {
  /** The master switch. Off means no browser tools exist and nothing is launched. */
  enabled: boolean
  mode: WebMode
  /** A Chrome the operator picked by hand; never discovered automatically. */
  chromePath: string
  /** A Chromium build we downloaded; empty until the download ran. */
  chromiumPath: string
  /** Where Chromium builds are kept; empty means the plugin's own data folder. */
  chromiumDir: string
  /** CDP endpoint for `attach`, for a browser the operator started themselves. */
  cdpUrl: string
  /** Where each mode keeps its persistent profile; empty means the default under the plugin data. */
  profileDir: string
}

const FILE = 'agi-web.json'

/** The shipped defaults: off, bundled Chromium, nothing filled in. */
export function defaultWebSettings(): WebSettings {
  return { enabled: false, mode: 'chromium', chromePath: '', chromiumPath: '', chromiumDir: '', cdpUrl: '', profileDir: '' }
}

function isMode(value: unknown): value is WebMode {
  return value === 'chromium' || value === 'chrome' || value === 'attach'
}

/** Read the settings, filling anything missing from the defaults. */
export function readWebSettings(profileDir: string): WebSettings {
  const fallback = defaultWebSettings()
  try {
    const parsed = JSON.parse(readFileSync(join(profileDir, FILE), 'utf8')) as Partial<Record<keyof WebSettings, unknown>>
    return {
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : fallback.enabled,
      mode: isMode(parsed.mode) ? parsed.mode : fallback.mode,
      chromePath: typeof parsed.chromePath === 'string' ? parsed.chromePath : fallback.chromePath,
      chromiumPath: typeof parsed.chromiumPath === 'string' ? parsed.chromiumPath : fallback.chromiumPath,
      chromiumDir: typeof parsed.chromiumDir === 'string' ? parsed.chromiumDir : fallback.chromiumDir,
      cdpUrl: typeof parsed.cdpUrl === 'string' ? parsed.cdpUrl : fallback.cdpUrl,
      profileDir: typeof parsed.profileDir === 'string' ? parsed.profileDir : fallback.profileDir,
    }
  } catch {
    return fallback
  }
}

/** Persist a whole settings object; the caller owns validation. */
export function writeWebSettings(profileDir: string, next: WebSettings): void {
  writeFileSync(join(profileDir, FILE), `${JSON.stringify(next, null, 2)}\n`)
}

/**
 * Merge a partial update coming from the settings page.
 * @param current - the settings already on disk.
 * @param patch - only the fields the page changed.
 */
export function mergeWebSettings(current: WebSettings, patch: Partial<WebSettings>): WebSettings {
  const next: WebSettings = { ...current }
  if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled
  if (isMode(patch.mode)) next.mode = patch.mode
  for (const key of ['chromePath', 'chromiumPath', 'chromiumDir', 'cdpUrl', 'profileDir'] as const) {
    const value = patch[key]
    if (typeof value === 'string') next[key] = value
  }
  return next
}
