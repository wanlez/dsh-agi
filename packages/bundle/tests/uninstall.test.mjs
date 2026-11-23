/**
 * The uninstaller runs against a fake profile: it must remove the package and its regenerable
 * data, keep the experience library and personal data, and leave other entries alone.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const source = join(dirname(fileURLToPath(import.meta.url)), '..', 'uninstall.mjs')

function build() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-agi-uninstall-'))
  const profile = join(root, 'profiles', 'desktop')
  const dshHome = join(root, 'home')
  const home = join(dshHome, 'dsh-agi')
  const pkg = join(profile, 'node_modules', 'dsh-agi')
  mkdirSync(join(pkg, 'dist'), { recursive: true })
  cpSync(source, join(pkg, 'uninstall.mjs'))
  writeFileSync(join(pkg, 'dist', 'host.js'), 'x')
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    name: 'profile',
    dependencies: { 'dsh-agi': '0.6.15', zod: '4.0.0' },
    dsh: { profile: { bundles: ['dsh-agi', 'other-bundle'] } },
  }, null, 2))
  writeFileSync(join(profile, 'agi-voice.json'), '{}')
  const library = join(root, 'MovedLibrary')
  mkdirSync(library, { recursive: true })
  writeFileSync(join(library, 'node.json'), '{}')
  writeFileSync(join(profile, 'agi-knowledge-graph.json'), JSON.stringify({ dir: library }))
  for (const dir of ['voice', 'electron-runtime', 'knowledge', 'workspace', 'records']) {
    mkdirSync(join(home, dir), { recursive: true })
    writeFileSync(join(home, dir, 'keep.txt'), 'x')
  }
  writeFileSync(join(home, 'helper-debug.log'), 'x')
  writeFileSync(join(home, 'ACTIVE_GRAPH'), 'x')
  writeFileSync(join(root, 'dsh-agi-image-debug.log'), 'x')
  return { root, profile, home, dshHome, pkg, library }
}

test('removes the plugin and its caches, keeps the library and personal data', () => {
  const { root, profile, home, dshHome, pkg, library } = build()
  const result = spawnSync(process.execPath, [
    join(pkg, 'uninstall.mjs'),
    '--yes',
    '--skip-process-check',
    '--home',
    dshHome,
  ], { encoding: 'utf8', env: { ...process.env, TEMP: tmpdir() } })
  assert.equal(result.status, 0, result.stdout + result.stderr)

  assert.equal(existsSync(pkg), false, 'the package directory is gone')
  const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))
  assert.equal(manifest.dependencies['dsh-agi'], undefined)
  assert.equal(manifest.dependencies.zod, '4.0.0', 'other dependencies stay')
  assert.deepEqual(manifest.dsh.profile.bundles, ['other-bundle'], 'other bundles stay')

  assert.equal(existsSync(join(profile, 'agi-voice.json')), false, 'plugin settings are removed')
  assert.equal(existsSync(join(profile, 'agi-knowledge-graph.json')), true, 'the library binding stays')
  assert.equal(existsSync(join(home, 'voice')), false, 'voice models are removed')
  assert.equal(existsSync(join(home, 'electron-runtime')), false, 'the runtime is removed')
  assert.equal(existsSync(join(home, 'helper-debug.log')), false, 'logs are removed')
  for (const keep of ['knowledge', 'workspace', 'records']) {
    assert.equal(existsSync(join(home, keep)), true, `${keep} is kept`)
  }
  assert.equal(existsSync(join(home, 'ACTIVE_GRAPH')), true, 'the library pointer is kept')
  assert.equal(existsSync(library), true, 'a moved library survives')
  assert.match(result.stdout, new RegExp('会保留'), 'the summary is printed')
  assert.ok(result.stdout.includes('MovedLibrary'), 'the summary names the library it kept')
  assert.equal(existsSync(root), true, 'nothing outside the profile and data dir is touched')
})
