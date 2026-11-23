/**
 * Enable this plugin in the profile it sits in.
 *
 * `dsh plugin add` installs the package but does not register the bundle, so a command-line
 * install looks done and the ball never appears. This adds the loader entry (idempotently)
 * and checks the native loader, then asks for a restart.
 *
 * Double-click `install.cmd` (Windows), or run `node install.mjs` from this directory.
 * Flags: --profile <dir>, --home <dir> (unused today, kept symmetric with uninstall.mjs).
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const value = (name) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? undefined : args[index + 1]
}

function say(line) {
  process.stdout.write(`${line}\n`)
}

function die(message) {
  say(`\n[安装中止] ${message}`)
  process.exit(2)
}

const packageDir = here
if (basename(packageDir) !== 'dsh-agi' || basename(dirname(packageDir)) !== 'node_modules') {
  die(`这个文件必须留在插件目录里运行（当前是 ${packageDir}）。`)
}
const profileDir = resolve(value('profile') ?? join(packageDir, '..', '..'))
const manifestPath = join(profileDir, 'package.json')

let manifest
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
} catch (error) {
  die(`profile 清单读不出来：${error instanceof Error ? error.message : String(error)}`)
}

// ── the loader entry the CLI install leaves out ───────────────────────────────
const BUNDLE = 'dsh-agi'
let changed = false
try {
  manifest.dsh = manifest.dsh ?? {}
  manifest.dsh.profile = manifest.dsh.profile ?? {}
  const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : []
  if (!bundles.includes(BUNDLE)) {
    manifest.dsh.profile.bundles = [...bundles, BUNDLE]
    changed = true
  }
  manifest.dependencies = manifest.dependencies ?? {}
  if (manifest.dependencies[BUNDLE] === undefined) {
    const own = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
    manifest.dependencies[BUNDLE] = String(own.version ?? '')
    changed = true
  }
  if (changed) {
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    say(`已在 profile 清单里启用 ${BUNDLE}。`)
  } else {
    say(`${BUNDLE} 已经在 profile 清单里，无需改动。`)
  }
} catch (error) {
  die(`写入 profile 清单失败：${error instanceof Error ? error.message : String(error)}`)
}

// ── the native loader the plugin needs at runtime ─────────────────────────────
function koffiPackage() {
  if (process.platform === 'win32') return '@koromix/koffi-win32-x64'
  if (process.platform === 'darwin') return process.arch === 'arm64' ? '@koromix/koffi-darwin-arm64' : '@koromix/koffi-darwin-x64'
  if (process.platform === 'linux') return process.arch === 'arm64' ? '@koromix/koffi-linux-arm64' : '@koromix/koffi-linux-x64'
  return 'koffi'
}

let native = 'unknown'
try {
  const load = createRequire(join(packageDir, 'index.js'))
  const koffi = load(koffiPackage())
  native = typeof koffi?.load === 'function' ? 'ok' : 'missing load()'
} catch (error) {
  native = error instanceof Error ? error.message.split('\n')[0] : String(error)
}

say(`原生模块 ${koffiPackage()}: ${native}`)
if (native !== 'ok') {
  say('提示：原生模块没加载成功，键鼠与窗口识别可能不可用；可重新安装本插件，或把这段输出发给作者。')
}

say('')
say('现在完全退出 DeepSeek Harness 并重新打开，悬浮球与设置里的「悬浮球」页就会出现。')
say('首次启动会下载语音运行时（约 366 MB）；不用语音可以忽略。')
