/**
 * `install.mjs` must add the loader entry a command-line install leaves out, and stay
 * idempotent. The native check is allowed to fail here: the fake profile carries no packages.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const source = dirname(fileURLToPath(import.meta.url))
const bundle = join(source, '..')

function build() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-agi-install-'))
  const profile = join(root, 'profiles', 'desktop')
  const pkg = join(profile, 'node_modules', 'dsh-agi')
  mkdirSync(pkg, { recursive: true })
  cpSync(join(bundle, 'install.mjs'), join(pkg, 'install.mjs'))
  cpSync(join(bundle, 'package.json'), join(pkg, 'package.json'))
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    name: 'profile',
    dsh: { profile: { bundles: ['other-bundle'] } },
    dependencies: { zod: '4.0.0' },
  }, null, 2))
  return { profile, pkg }
}

function run(script) {
  return spawnSync(process.execPath, [script], { encoding: 'utf8' })
}

test('adds the bundle entry and the dependency, then does nothing on a second run', () => {
  const { profile, pkg } = build()
  const first = run(join(pkg, 'install.mjs'))
  assert.equal(first.status, 0, first.stdout + first.stderr)

  const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))
  assert.deepEqual(manifest.dsh.profile.bundles, ['other-bundle', 'dsh-agi'])
  assert.match(manifest.dependencies['dsh-agi'], /^\d+\.\d+\.\d+$/)
  assert.equal(manifest.dependencies.zod, '4.0.0', 'other dependencies stay')

  const second = run(join(pkg, 'install.mjs'))
  assert.equal(second.status, 0, second.stdout + second.stderr)
  assert.match(second.stdout, /无需改动/)
  const after = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))
  assert.deepEqual(after.dsh.profile.bundles, ['other-bundle', 'dsh-agi'], 'no duplicate entry')
})

test('refuses to run outside the package directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-agi-install-bad-'))
  const stray = join(root, 'install.mjs')
  cpSync(join(bundle, 'install.mjs'), stray)
  const result = run(stray)
  assert.equal(result.status, 2)
  assert.match(result.stdout, /插件目录/)
  assert.equal(existsSync(join(root, 'package.json')), false)
})
