/**
 * koffi, loaded from the copy the Orb host names in `DSH_AGI_KOFFI_DIR`, outside the
 * installed package: on Windows a loaded addon inside the package blocks the next
 * update from replacing it. Without that copy, koffi resolves beside this file.
 * @module @deepseek-ai/dsh-experimental-tool-computer-use/src/koffi
 */

import { createRequire } from 'node:module'
import { join } from 'node:path'

type Koffi = typeof import('koffi')

/** The prebuilt platform package; `koffi` itself needs an install script this install skips. */
function koffiPackage(): string {
  if (process.platform === 'win32') return '@koromix/koffi-win32-x64'
  if (process.platform === 'darwin') return process.arch === 'arm64' ? '@koromix/koffi-darwin-arm64' : '@koromix/koffi-darwin-x64'
  if (process.platform === 'linux') return process.arch === 'arm64' ? '@koromix/koffi-linux-arm64' : '@koromix/koffi-linux-x64'
  return 'koffi'
}

function requireKoffi(): Koffi {
  const specifier = koffiPackage()
  const dir = process.env.DSH_AGI_KOFFI_DIR
  if (dir !== undefined && dir !== '') {
    try {
      return createRequire(join(dir, 'index.js'))(specifier) as Koffi
    } catch {
      // A copy that does not load: the packaged one still works, it only blocks updates.
    }
  }
  return createRequire(import.meta.url)(specifier) as Koffi
}

const koffi: Koffi = requireKoffi()

export default koffi
