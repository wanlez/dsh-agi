/**
 * Uninstall this plugin from the profile it is installed in.
 *
 * Double-click `uninstall.cmd` (Windows), or run `node uninstall.mjs` from this directory.
 * It removes the package, its loader entries and the data it regenerates, and it keeps the
 * experience library (wherever the operator moved it), the ball workspace, the conversation
 * archive and every DSH file.
 *
 * Flags: --yes (no prompt), --profile <dir> (override), --home <dir> (override DSH home),
 *        --skip-process-check (only for automated tests).
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const value = (name) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? undefined : args[index + 1]
}

function say(line) {
  process.stdout.write(`${line}\n`)
}

function die(message) {
  say(`\n[卸载中止] ${message}`)
  process.exit(2)
}

// ── locate the profile ────────────────────────────────────────────────────────
const packageDir = here
if (basename(packageDir) !== 'dsh-agi' || basename(dirname(packageDir)) !== 'node_modules') {
  die(`这个文件必须留在插件目录里运行（当前是 ${packageDir}）。`)
}
const profileDir = resolve(value('profile') ?? join(packageDir, '..', '..'))
if (!existsSync(join(profileDir, 'package.json'))) die(`找不到 profile 清单：${join(profileDir, 'package.json')}`)
const dshHome = resolve(value('home') ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'))
const dataDir = join(dshHome, 'dsh-agi')

/**
 * The library may have been moved by the operator: the profile config and the data pointer both
 * record where it went, so read them instead of assuming the default folder.
 */
function libraryDir() {
  for (const file of [join(profileDir, 'agi-knowledge-graph.json'), join(dataDir, 'ACTIVE_GRAPH')]) {
    try {
      const text = readFileSync(file, 'utf8')
      if (file.endsWith('.json')) {
        const parsed = JSON.parse(text)
        if (typeof parsed?.dir === 'string' && parsed.dir !== '') return resolve(parsed.dir)
        continue
      }
      const pointed = text.trim()
      if (pointed !== '') return resolve(pointed)
    } catch {
      // Try the next pointer.
    }
  }
  return join(profileDir, 'dsh-agi', 'knowledge-graph')
}

const keptLibrary = libraryDir()

/**
 * The ball workspace, resolved the same way the plugin does: `agi-workspace.json` may name any
 * absolute directory, and the shipped default is `~/.dsh/dsh_agi`. Its content is never deleted.
 */
function workspaceDir() {
  try {
    const stored = JSON.parse(readFileSync(join(profileDir, 'agi-workspace.json'), 'utf8'))?.path
    if (typeof stored === 'string' && isAbsolute(stored)) return resolve(stored)
  } catch {
    // No override recorded: the shipped default applies.
  }
  return resolve(join(dshHome, 'dsh_agi'))
}

const keptWorkspace = workspaceDir()

/**
 * Paths that survive whatever the delete list says: the experience library, the ball workspace
 * and the conversation archive. A delete landing in one of them is refused, not carried out.
 */
const protectedPaths = [
  keptLibrary,
  keptWorkspace,
  join(dataDir, 'knowledge'),
  join(dataDir, 'workspace'),
  join(dataDir, 'records'),
]

function isProtected(target) {
  const resolved = resolve(target)
  for (const guarded of protectedPaths) {
    const root = resolve(guarded)
    if (resolved === root || resolved.startsWith(`${root}${sep}`)) return true
  }
  return false
}

const notes = { removed: [], failed: [], skipped: [] }

/** Remove a path when it exists; never throw: one locked file must not stop the rest. */
function remove(target) {
  if (!existsSync(target)) return
  if (isProtected(target)) {
    notes.skipped.push(`${target}（受保护，未删除）`)
    return
  }
  try {
    rmSync(target, { recursive: true, force: true })
    notes.removed.push(target)
  } catch (error) {
    notes.failed.push(`${target}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

// ── refuse to run while DSH holds the files ───────────────────────────────────
if (!flag('skip-process-check') && process.platform === 'win32') {
  const list = spawnSync('tasklist', ['/FI', 'IMAGENAME eq DeepSeek Harness.exe', '/NH'], { encoding: 'utf8', windowsHide: true })
  if ((list.stdout ?? '').includes('DeepSeek Harness.exe')) {
    die('DeepSeek Harness 正在运行。请先完全退出它，再双击 uninstall.cmd。')
  }
}

// ── what will be removed, and what stays ──────────────────────────────────────
const manifestPath = join(profileDir, 'package.json')
let manifest
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
} catch (error) {
  die(`profile 清单读不出来：${error instanceof Error ? error.message : String(error)}`)
}

const dataSubdirs = ['voice', 'electron-runtime', 'helper-data', 'native']
const dataFiles = ['helper-debug.log', 'image-debug.log', 'floating-session.json', 'shared-anchor.json', 'post-click-apps.json']
const profileSettings = readdirSync(profileDir).filter((name) => /^agi-.*\.json$/.test(name) && !name.startsWith('agi-knowledge'))

say('将删除：')
say(`  插件包        ${packageDir}`)
say('  profile 清单里的 dsh-agi 依赖与 bundle 条目')
for (const dir of dataSubdirs) say(`  插件数据      ${join(dataDir, dir)}`)
for (const file of dataFiles) say(`  插件数据      ${join(dataDir, file)}`)
for (const file of profileSettings) say(`  插件设置      ${join(profileDir, file)}`)
say(`  临时日志      ${join(process.env.TEMP ?? '', 'dsh-agi-*')}`)
say('\n会保留：')
say(`  经验库        ${keptLibrary}（以及 agi-knowledge*.json）`)
say(`  球工作区      ${keptWorkspace}（内容一个文件都不动）`)
for (const name of ['knowledge', 'records']) say(`  个人数据      ${join(dataDir, name)}`)
say('  DSH 本体、其它插件、会话与附件：一概不动。')

if (!flag('yes')) {
  const answer = await new Promise((done) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    rl.question('\n确认卸载请输入 yes：', (typed) => {
      rl.close()
      done((typed ?? '').trim().toLowerCase())
    })
  })
  if (answer !== 'yes') die('已取消，什么都没改。')
}

// ── profile: drop the loader entries first, so a half-removed install cannot load ──
try {
  let changed = false
  const bundles = manifest?.dsh?.profile?.bundles
  if (Array.isArray(bundles)) {
    const kept = bundles.filter((item) => typeof item !== 'string' || (item !== 'dsh-agi' && !item.startsWith('@dsh-agi/')))
    if (kept.length !== bundles.length) {
      manifest.dsh.profile.bundles = kept
      changed = true
    }
  }
  if (manifest?.dependencies !== undefined && typeof manifest.dependencies === 'object') {
    for (const name of Object.keys(manifest.dependencies)) {
      if (name === 'dsh-agi' || name.startsWith('@dsh-agi/')) {
        delete manifest.dependencies[name]
        changed = true
      }
    }
  }
  if (changed) {
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    notes.removed.push(`${manifestPath} 里的 dsh-agi 条目`)
  }
} catch (error) {
  notes.failed.push(`profile 清单: ${error instanceof Error ? error.message : String(error)}`)
}

// ── data: caches and settings only ────────────────────────────────────────────
for (const dir of dataSubdirs) remove(join(dataDir, dir))
for (const file of dataFiles) remove(join(dataDir, file))
for (const file of profileSettings) remove(join(profileDir, file))

const temp = process.env.TEMP ?? process.env.TMP
if (temp !== undefined && existsSync(temp)) {
  for (const name of readdirSync(temp)) {
    if (name.startsWith('dsh-agi-') && (name.endsWith('.log') || name.endsWith('.on'))) {
      remove(join(temp, name))
    }
  }
}

// ── the package itself last: while it exists, this script exists ──────────────
let selfRemoved = false
try {
  if (isProtected(packageDir)) {
    notes.skipped.push(`${packageDir}（受保护，未删除）`)
  } else {
    rmSync(packageDir, { recursive: true, force: true })
    selfRemoved = true
  }
} catch (error) {
  notes.failed.push(`${packageDir}: ${error instanceof Error ? error.message : String(error)}`)
}

// ── report ────────────────────────────────────────────────────────────────────
say(`\n已删除 ${notes.removed.length} 项${selfRemoved ? '（含插件包本身）' : ''}。`)
for (const line of notes.skipped) say(`  跳过：${line}`)
if (notes.failed.length > 0) {
  say('以下内容删不掉（通常是文件被占用），退出 DSH 后重试，或手动删除：')
  for (const line of notes.failed) say(`  ${line}`)
}
say('保留：经验库、球工作区、会话截图留档、DSH 本体与其它插件。')
say('重新安装：在 DSH 插件管理里安装 dsh-agi 即可，经验库会自动沿用。')
