/**
 * Moving the experience library between folders.
 *
 * The order is copy → verify → switch the pointer → delete the old folder, so these tests
 * prove three things: a normal move leaves one complete library at the new path, an
 * existing graph target is merged instead of overwritten, and a failure before the switch
 * rolls back to the original folder with the original pointer.
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { GraphError } from '../src/knowledge-graph/model.ts'
import { KnowledgeGraphService } from '../src/knowledge-graph/service.ts'
import { KnowledgeGraphStore, knowledgeGraphDirFor } from '../src/knowledge-graph/store.ts'
import {
  GRAPH_MIGRATION_LOG,
  graphLibraryState,
  setGraphLibraryDir,
  verifyGraphLibrary,
} from '../src/knowledge-graph/library.ts'

const roots: string[] = []
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function temporary(): string {
  const root = mkdtempSync(join(tmpdir(), 'orb-graph-lib-'))
  roots.push(root)
  return root
}

/** One 1x1 PNG, enough to prove screenshot bytes travel. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nQAAAABJRU5ErkJggg==',
  'base64',
)

/** Seed a small but complete library: nodes, edges, one path, one screenshot. */
async function seedLibrary(dir: string, prefix: string): Promise<{ nodes: number; edges: number; paths: number }> {
  const service = new KnowledgeGraphService(new KnowledgeGraphStore(dir))
  const a = await service.createNode({ title: `${prefix} 登录`, description: '打开系统并登录' })
  const b = await service.createNode({ title: `${prefix} 填表`, description: '填写表单并保存' })
  await service.addEdge(a.id, b.id)
  await service.addScreenshot(a.id, { caption: '登录成功的首页', data: PNG.toString('base64') })
  await service.createPath({ name: `${prefix} 流程`, summary: '登录后填表', node_sequence: [a.id, b.id] })
  return { nodes: 2, edges: 1, paths: 1 }
}

function profileOf(root: string): string {
  return join(root, 'profile')
}

describe('knowledge graph library folder', () => {
  it('reports the default folder, the counts, and the last migration', async () => {
    const root = temporary()
    const profile = profileOf(root)
    const dir = knowledgeGraphDirFor(profile)
    await seedLibrary(dir, '默认库')
    const state = await graphLibraryState(profile)
    assert.equal(state.dir, dir)
    assert.equal(state.defaultDir, dir)
    assert.equal(state.isDefault, true)
    assert.equal(state.counts.nodes, 2)
    assert.equal(state.counts.edges, 1)
    assert.equal(state.counts.paths, 1)
    assert.equal(state.counts.screenshots, 1)
    assert.equal(state.lastMigration, null)
  })

  it('moves the whole library, verifies it, switches the pointer, then deletes the old folder', async () => {
    const root = temporary()
    const profile = profileOf(root)
    const from = knowledgeGraphDirFor(profile)
    await seedLibrary(from, '迁移')
    const to = join(root, 'moved-graph')
    const published: string[] = []

    const result = await setGraphLibraryDir(profile, to, {
      operator: 'test',
      publish: (dir) => published.push(dir),
      homeLog: false,
    })

    assert.equal(result.mode, 'move')
    assert.equal(result.deletedOld, true)
    assert.equal(result.leftover, false)
    assert.equal(result.counts.nodes, 2)
    assert.equal(result.counts.edges, 1)
    assert.equal(result.counts.paths, 1)
    assert.deepEqual(published, [to])

    // The new folder is complete and readable.
    const verified = await verifyGraphLibrary(to, { nodes: 2, edges: 1, paths: 1 })
    assert.equal(verified.ok, true, verified.problems.join('；'))
    assert.equal(verified.counts.screenshots, 1)
    assert.match(readFileSync(join(to, 'index.json'), 'utf8'), /迁移 流程/)
    const screenshotFile = readdirSync(join(to, 'screenshots'))[0]
    assert.ok(screenshotFile !== undefined)

    // The profile pointer follows and the old folder is gone.
    assert.equal(knowledgeGraphDirFor(profile), to)
    assert.equal(existsSync(from), false)
    const config = JSON.parse(readFileSync(join(profile, 'agi-knowledge-graph.json'), 'utf8')) as { dir: string }
    assert.equal(config.dir, to)

    // The migration log records the fixed order.
    const log = readFileSync(join(to, GRAPH_MIGRATION_LOG), 'utf8')
      .trim().split(/\r?\n/u).map((line) => JSON.parse(line) as { event: string })
    const events = log.map((entry) => entry.event)
    assert.deepEqual(events, ['start', 'copied', 'switched', 'deleted-old', 'done'])
    const state = await graphLibraryState(profile)
    assert.equal(state.dir, to)
    assert.equal(state.lastMigration?.event, 'done')
  })

  it('merges into an existing graph target instead of overwriting it', async () => {
    const root = temporary()
    const profile = profileOf(root)
    const from = knowledgeGraphDirFor(profile)
    await seedLibrary(from, '源库')
    const to = join(root, 'existing-graph')
    await seedLibrary(to, '目标库')

    const result = await setGraphLibraryDir(profile, to, { homeLog: false, operator: 'test' })
    assert.equal(result.mode, 'merge')
    assert.equal(result.deletedOld, true)

    const verified = await verifyGraphLibrary(to, { nodes: 4, paths: 2 })
    assert.equal(verified.ok, true, verified.problems.join('；'))
    // Both libraries survive; the source folder is removed only after the merged target verified.
    assert.equal(existsSync(from), false)
    assert.equal(knowledgeGraphDirFor(profile), to)
    assert.equal(result.counts.nodes, 4)
    assert.equal(result.counts.paths, 2)
    const titles = JSON.parse(readFileSync(join(to, 'index.json'), 'utf8')) as { paths: { name: string }[] }
    assert.deepEqual(titles.paths.map((path) => path.name).sort(), ['目标库 流程', '源库 流程'].sort())
  })

  it('refuses a target that holds unrelated files and leaves both sides untouched', async () => {
    const root = temporary()
    const profile = profileOf(root)
    const from = knowledgeGraphDirFor(profile)
    await seedLibrary(from, '原库')
    const to = join(root, 'not-a-graph')
    await mkdir(to, { recursive: true })
    writeFileSync(join(to, 'notes.md'), '别人的文件', 'utf8')

    await assert.rejects(() => setGraphLibraryDir(profile, to, { homeLog: false }), (error: unknown) => {
      assert.ok(error instanceof GraphError)
      assert.equal(error.code, 'graph-target-not-empty')
      assert.equal(error.status, 409)
      return true
    })
    assert.equal(knowledgeGraphDirFor(profile), from)
    assert.equal(existsSync(join(to, 'notes.md')), true)
    assert.equal((await verifyGraphLibrary(from)).counts.nodes, 2)
  })

  it('rolls back to the original folder when the migration fails before the pointer switch', async () => {
    const root = temporary()
    const profile = profileOf(root)
    const from = knowledgeGraphDirFor(profile)
    await seedLibrary(from, '回滚')
    const to = join(root, 'never-committed')

    await assert.rejects(
      () => setGraphLibraryDir(profile, to, {
        homeLog: false,
        publish: () => { throw new Error('publish must not run') },
        hooks: {
          afterCopy: () => { throw new Error('模拟：复制校验后磁盘写满') },
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof GraphError)
        assert.equal(error.code, 'graph-migration-failed')
        assert.match(error.message, /已回滚到原目录/)
        assert.match(error.message, /模拟：复制校验后磁盘写满/)
        return true
      },
    )

    // The original library is intact, the pointer never moved, the target was never created.
    const intact = await verifyGraphLibrary(from, { nodes: 2, edges: 1, paths: 1 })
    assert.equal(intact.ok, true, intact.problems.join('；'))
    assert.equal(knowledgeGraphDirFor(profile), from)
    assert.equal(existsSync(to), false)
    assert.equal(existsSync(join(profile, 'agi-knowledge-graph.json')), false)
    // No staging folder survived in the parent.
    assert.deepEqual(readdirSync(root).filter((name) => name.startsWith('.graph-migrate')), [])
    // The failure is in the log, next to the source library.
    const log = readFileSync(join(from, GRAPH_MIGRATION_LOG), 'utf8')
      .trim().split(/\r?\n/u).map((line) => JSON.parse(line) as { event: string })
    assert.deepEqual(log.map((entry) => entry.event), ['start', 'copied', 'failed', 'rollback'])
  })

  it('moves into an existing empty folder and rejects nested targets', async () => {
    const root = temporary()
    const profile = profileOf(root)
    const from = knowledgeGraphDirFor(profile)
    await seedLibrary(from, '空目标')
    const to = join(root, 'empty-target')
    await mkdir(to, { recursive: true })

    const result = await setGraphLibraryDir(profile, to, { homeLog: false })
    assert.equal(result.mode, 'move')
    assert.equal((await verifyGraphLibrary(to)).counts.nodes, 2)
    assert.equal(existsSync(from), false)

    await assert.rejects(() => setGraphLibraryDir(profile, join(to, 'child'), { homeLog: false }), (error: unknown) => {
      assert.ok(error instanceof GraphError)
      assert.equal(error.code, 'graph-nested-path')
      return true
    })
    await assert.rejects(() => setGraphLibraryDir(profile, 'relative/folder', { homeLog: false }), (error: unknown) => {
      assert.ok(error instanceof GraphError)
      assert.equal(error.code, 'graph-invalid-path')
      return true
    })
  })

  it('detects a copy whose counts no longer match', async () => {
    const root = temporary()
    const dir = join(root, 'broken')
    await seedLibrary(dir, '校验')
    // Remove one node file: the folder no longer matches the manifest or the path.
    const nodeFiles = readdirSync(join(dir, 'nodes')).filter((name) => name.endsWith('.json'))
    rmSync(join(dir, 'nodes', nodeFiles[0] as string))
    const verdict = await verifyGraphLibrary(dir)
    assert.equal(verdict.ok, false)
    assert.ok(verdict.problems.some((problem) => /manifest 记录节点|节点文件/.test(problem)))
  })
})
