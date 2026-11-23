import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installChromium, chromiumStatus } from './packages/host/src/web/chromium.ts'

const dataDir = mkdtempSync(join(tmpdir(), 'webdl-'))
console.log('start download into', dataDir)
const exe = await installChromium(dataDir)
const status = chromiumStatus(dataDir)
console.log('exe:', exe)
console.log('present:', status.present, '| phase:', status.phase, '| error:', status.error)
