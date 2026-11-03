/**
 * Plain-text trace for the two paths that are hard to see from outside: the
 * composer's image upload and the persona card injection. Every line lands in
 * `<harness home>/dsh-agi/image-debug.log`, which is the file a user can be
 * asked to send back. Diagnostics never take a feature down: a broken log is
 * swallowed here.
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** Append one timestamped line to the plugin's debug log. */
export function imageDebug(line: string): void {
  try {
    const dir = dshHomePath('dsh-agi')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'image-debug.log'), `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch {
    // Never let a log line break the caller.
  }
}
