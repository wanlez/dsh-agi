/**
 * Release preflight. Every check here exists because one of them was missed at least once and
 * shipped a broken tag; run it before `git tag`, never after.
 *
 *   pnpm release:check
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bundle = join(root, 'packages', 'bundle')
const problems = []
const notes = []

function fail(message) {
  problems.push(message)
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function newestMtime(dir) {
  let newest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestMtime(path))
      continue
    }
    if (entry.name.endsWith('.test.ts')) continue
    newest = Math.max(newest, statSync(path).mtimeMs)
  }
  return newest
}

// 1. The manifest this publishes must be the bundle, not the private workspace root.
const manifest = readJson(join(bundle, 'package.json'))
if (manifest.name !== 'dsh-agi') fail(`bundle package name is ${manifest.name}, expected dsh-agi`)
if (manifest.private === true) fail('bundle package is private: the release cannot be installed')
if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) fail(`version is not a release semver: ${manifest.version}`)
notes.push(`version ${manifest.version}`)

// 2. Every artifact the plugin loads at runtime has to be present and newer than its sources.
const artifacts = [
  join(bundle, 'dist', 'host', 'index.js'),
  join(bundle, 'lib', 'index.js'),
  join(bundle, 'client.js'),
]
for (const artifact of artifacts) {
  if (!existsSync(artifact)) fail(`missing build artifact: ${artifact.slice(root.length + 1)}`)
}
const sources = [
  join(root, 'packages', 'host', 'src'),
  join(root, 'packages', 'client-settings', 'src'),
]
const builtAt = existsSync(artifacts[0]) ? statSync(artifacts[0]).mtimeMs : 0
const sourcedAt = Math.max(...sources.map((dir) => (existsSync(dir) ? newestMtime(dir) : 0)))
if (builtAt > 0 && sourcedAt > builtAt) fail('build is older than the sources: run pnpm build')

// 3. Both readmes must carry this version's section, since the tag links straight to them.
for (const file of ['README.md', 'README.zh-CN.md']) {
  const text = readFileSync(join(root, file), 'utf8')
  if (!text.includes(`### ${manifest.version}`)) fail(`${file} has no "### ${manifest.version}" section`)
}

// 4. Every package the built code imports must be declared, or a clean install breaks at runtime.
//    A missing declaration is invisible on a development checkout and fatal on a fresh profile.
{
  // `electron` is built into the helper's preload runtime, so it is never a package dependency.
  const declared = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    'electron',
  ])
  const roots = [join(bundle, 'dist'), join(bundle, 'lib')]
  const files = []
  const walk = (dir) => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/\.(js|mjs|cjs)$/.test(entry.name)) files.push(path)
    }
  }
  for (const root of roots) walk(root)
  const bare = new Map()
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(/(?:from\s*|require\(\s*|import\(\s*)["']([^"'.][^"']*)["']/g)) {
      const specifier = match[1]
      if (specifier.startsWith('node:') || specifier.startsWith('data:')) continue
      // Minified code contains English prose inside strings; only a real package name passes.
      if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9._-]+)*$/.test(specifier)) continue
      const name = specifier.startsWith('@')
        ? specifier.split('/').slice(0, 2).join('/')
        : specifier.split('/')[0]
      if (declared.has(name)) continue
      bare.set(name, file.slice(root.length + 1))
    }
  }
  for (const [name, file] of bare) fail(`undeclared runtime dependency ${name} (imported by ${file})`)
  if (bare.size === 0) notes.push(`${files.length} built files import only declared packages`)
}

// 5. What npm would actually publish: the runtime files in, the workspace and tests out.
let packed
try {
  const output = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: bundle, encoding: 'utf8', shell: process.platform === 'win32' })
  packed = JSON.parse(output)[0]
} catch (error) {
  fail(`npm pack --dry-run failed: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
}
if (packed !== undefined) {
  const files = new Set(packed.files.map((file) => file.path.replaceAll('\\', '/')))
  for (const required of ['dist/host/index.js', 'lib/index.js', 'client.js', 'package.json']) {
    if (!files.has(required)) fail(`published package misses ${required}`)
  }
  for (const forbidden of [...files]) {
    if (forbidden.startsWith('node_modules/')) fail(`published package carries ${forbidden}`)
    if (forbidden.endsWith('.test.ts') || forbidden.endsWith('.test.mjs')) fail(`published package carries ${forbidden}`)
  }
  notes.push(`${packed.files.length} files, ${(packed.size / 1024 / 1024).toFixed(1)} MB`)
}

// 6. The tag this release is about to create must not exist yet.
const tag = `plugin-v${manifest.version}`
try {
  const existing = execFileSync('git', ['tag', '--list', tag], { cwd: root, encoding: 'utf8' }).trim()
  if (existing !== '') fail(`${tag} already exists: bump the version instead of re-tagging`)
} catch {
  fail('could not run git: is this a release checkout?')
}

if (problems.length > 0) {
  console.error('release:check FAILED')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log(`release:check OK  (${notes.join(', ')})`)
