/**
 * Build `dsh-agi-kws-<version>.tgz`: the eight model files the spotter opens, under
 * `package/kws/`, plus the license, notice and readme the registry page shows.
 *
 * The plugin pins this tarball's sha256, so the file built here is the file to publish.
 * Repacking changes mtimes and therefore the hash, and an installed plugin would refuse it.
 *
 * Usage: node models/kws/scripts/pack.mjs [--from <dir>] [--version x.y.z]
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { createGzip } from 'node:zlib'

const pkgRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const repoRoot = resolve(pkgRoot, '../..')

/** Every entry gets this mtime, so rebuilding the same files reproduces the same tarball. */
const FIXED_MTIME = new Date('2025-12-20T00:00:00Z')

/** Exactly what `kwsPresent()` and `kwsFiles()` in the plugin look for, and nothing else. */
const FILES = [
  'tokens.txt',
  'en.phone',
  ...[8, 16].flatMap((chunk) => {
    const tag = `chunk-${chunk}`
    return [
      `encoder-epoch-13-avg-2-${tag}-left-64.int8.onnx`,
      `decoder-epoch-13-avg-2-${tag}-left-64.onnx`,
      `joiner-epoch-13-avg-2-${tag}-left-64.int8.onnx`,
    ]
  }),
]

function arg(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

const from = resolve(arg('--from') ?? join(homedir(), '.dsh', 'dsh-agi', 'voice', 'kws'))
const versionOverride = arg('--version')

const missing = []
for (const name of FILES) {
  try {
    await stat(join(from, name))
  } catch {
    missing.push(name)
  }
}
if (missing.length > 0) {
  throw new Error(`pack: ${from} is missing ${missing.join(', ')}\n  Pass --from <dir> if the model lives elsewhere.`)
}

const stage = await mkdtemp(join(tmpdir(), 'dsh-agi-kws-pack-'))
const pkgDir = join(stage, 'package')
const kwsDir = join(pkgDir, 'kws')

try {
  await mkdir(kwsDir, { recursive: true })
  let bytes = 0
  for (const name of FILES) {
    await copyFile(join(from, name), join(kwsDir, name))
    bytes += (await stat(join(kwsDir, name))).size
  }
  for (const name of ['LICENSE', 'NOTICE.md', 'README.md']) {
    await copyFile(join(pkgRoot, name), join(pkgDir, name))
  }

  const manifest = JSON.parse(await readFile(join(pkgRoot, 'package.json'), 'utf8'))
  // The published manifest describes the data, not the build: no script ships with it.
  delete manifest.scripts
  if (versionOverride !== undefined) manifest.version = versionOverride
  await writeFile(join(pkgDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  // Pinning a hash only works if the same inputs give the same bytes, so every entry is
  // stamped with one fixed mtime. tar copies it into the header; nothing else varies.
  for (const name of [
    ...FILES.map((file) => join(kwsDir, file)),
    join(pkgDir, 'package.json'),
    join(pkgDir, 'LICENSE'),
    join(pkgDir, 'NOTICE.md'),
    join(pkgDir, 'README.md'),
  ]) {
    await utimes(name, FIXED_MTIME, FIXED_MTIME)
  }
  await utimes(kwsDir, FIXED_MTIME, FIXED_MTIME)
  await utimes(pkgDir, FIXED_MTIME, FIXED_MTIME)

  // `tar` rather than `npm pack`: the packlist would honour `files` but also rewrite mtimes
  // and owners, and the hash pinned in the plugin has to match this exact file.
  // Everything tar sees stays relative — GNU tar (Git for Windows) reads a drive-letter
  // `C:\...` argument as a remote host.
  // gzip is done in Node, not with `tar -z`: the system gzip stamps the current time into
  // the header, so two builds of identical input would hash differently.
  const stagedTar = join(stage, 'package.tar')
  const packed = spawnSync('tar', ['-cf', basename(stagedTar), 'package'], {
    cwd: stage, stdio: 'inherit', env: { ...process.env, COPYFILE_DISABLE: '1' },
  })
  if (packed.status !== 0) process.exit(packed.status ?? 1)
  const staged = join(stage, 'package.tgz')
  await pipeline(createReadStream(stagedTar), createGzip({ level: 9 }), createWriteStream(staged))

  const tarball = join(repoRoot, `${manifest.name}-${manifest.version}.tgz`)
  try {
    await rename(staged, tarball)
  } catch (error) {
    // Temp and repo can sit on different volumes; tar must not see either absolute path.
    if (error.code !== 'EXDEV') throw error
    await copyFile(staged, tarball)
    await rm(staged)
  }

  const size = (await stat(tarball)).size
  const hash = createHash('sha256')
  await new Promise((done, fail) => {
    createReadStream(tarball).on('data', (chunk) => hash.update(chunk)).on('end', done).on('error', fail)
  })

  console.log(`dsh-agi-kws: packed ${tarball}`)
  console.log(`  source   ${from}`)
  console.log(`  files    ${FILES.length} (${mb(bytes)} unpacked)`)
  console.log(`  tarball  ${size} bytes (${mb(size)})`)
  console.log(`  sha256   ${hash.digest('hex')}`)
  console.log('Next: record the sha256 and size in packages/voice/src/manifest.ts, then')
  console.log(`      npm publish ${basename(tarball)}`)
} finally {
  await rm(stage, { recursive: true, force: true })
}

function mb(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
