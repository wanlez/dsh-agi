import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { legacyFixture } from './fixtures/legacy-graph.ts'
import { GraphError, type GraphNode } from '../src/knowledge-graph/model.ts'
import { KnowledgeGraphService } from '../src/knowledge-graph/service.ts'
import { KnowledgeGraphStore, knowledgeGraphDirFor } from '../src/knowledge-graph/store.ts'

const roots: string[] = []
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function temporary(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orb-graph-'))
  roots.push(dir)
  return dir
}

function newService(dir = temporary()): KnowledgeGraphService {
  return new KnowledgeGraphService(new KnowledgeGraphStore(dir))
}

/** Seed one service with the legacy-note fixture and return key → node id. */
async function seed(service: KnowledgeGraphService): Promise<Map<string, string>> {
  const fixture = legacyFixture()
  const ids = new Map<string, string>()
  for (const node of fixture.nodes) {
    const created = await service.createNode({ title: node.title, description: node.description, created_by: 'fixture' })
    ids.set(node.key, created.id)
  }
  for (const [from, to] of fixture.edges) {
    await service.addEdge(ids.get(from) as string, ids.get(to) as string)
  }
  for (const path of fixture.paths) {
    await service.createPath({
      name: path.name,
      summary: path.summary,
      node_sequence: path.sequence.map((key) => ids.get(key) as string),
    })
  }
  return ids
}

/** One valid 1x1 PNG for screenshot-oriented tests. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nQAAAABJRU5ErkJggg==',
  'base64',
)

describe('knowledge graph invariants', () => {
  it('defaults the library under the profile and accepts an absolute override', () => {
    const profile = temporary()
    assert.equal(knowledgeGraphDirFor(profile), join(profile, 'dsh-agi', 'knowledge-graph'))
    const custom = join(profile, 'elsewhere', 'graph')
    const config = join(profile, 'agi-knowledge-graph.json')
    // The profile override is read with fs; write it directly as the settings page does.
    writeFileSync(config, JSON.stringify({ dir: custom }), 'utf8')
    assert.equal(knowledgeGraphDirFor(profile), custom)
  })

  it('refuses self loops, duplicate edges, and cycles', async () => {
    const service = newService()
    const a = await service.createNode({ title: 'A 打开系统', description: '打开系统' })
    const b = await service.createNode({ title: 'B 填表', description: '填写表单' })
    const c = await service.createNode({ title: 'C 提交', description: '提交表单' })
    await service.addEdge(a.id, b.id)
    await service.addEdge(b.id, c.id)

    await assert.rejects(() => service.addEdge(a.id, a.id), (error: unknown) => {
      assert.ok(error instanceof GraphError)
      assert.equal(error.code, 'self-loop')
      return true
    })
    await assert.rejects(() => service.addEdge(a.id, b.id), (error: unknown) => {
      assert.ok(error instanceof GraphError)
      assert.equal(error.code, 'duplicate')
      assert.match(error.message, /已存在/)
      return true
    })
    await assert.rejects(() => service.addEdge(c.id, a.id), (error: unknown) => {
      assert.ok(error instanceof GraphError)
      assert.equal(error.code, 'cycle')
      assert.match(error.message, /会形成环/)
      return true
    })
    // The rejected edge was never written.
    const detail = await service.nodeDetail(a.id)
    assert.deepEqual(detail.incoming, [])
  })

  it('soft deletes without removing the file or its edges', async () => {
    const dir = temporary()
    const service = newService(dir)
    const a = await service.createNode({ title: '起点', description: '第一步' })
    const b = await service.createNode({ title: '第二步', description: '在起点之后执行' })
    await service.addEdge(a.id, b.id)
    const deleted = await service.deleteNode(a.id, 'tester')
    assert.equal(deleted.status, 'deleted')
    assert.equal(existsSync(join(dir, 'nodes', `${a.id}.json`)), true)
    assert.match(readFileSync(join(dir, 'edges.jsonl'), 'utf8'), new RegExp(`${a.id}`))
    const search = await service.searchNodes('起点', 0)
    assert.equal(search.candidates.some((candidate) => candidate.node.id === a.id), false)
    const log = await service.decisionLog(10)
    assert.equal(log[0]?.action, 'delete_node')
  })

  it('copies node content but never an edge, and records derived_from', async () => {
    const dir = temporary()
    const service = newService(dir)
    const source = await service.createNode({ title: '发送福利', description: '填表并发送', created_by: 'tester' })
    const before = await service.createNode({ title: '登录', description: '先登录' })
    const afterNode = await service.createNode({ title: '复核', description: '发送后复核' })
    await service.addEdge(before.id, source.id)
    await service.addEdge(source.id, afterNode.id)
    await service.addScreenshot(source.id, { caption: '发送成功的绿色提示', data: PNG.toString('base64') })

    const copy = await service.copyNode(source.id, 'tester')
    assert.equal(copy.derived_from, source.id)
    assert.match(copy.title, /副本/)
    assert.equal(copy.screenshots.length, 1)
    const copyRaw = JSON.parse(readFileSync(join(dir, 'nodes', `${copy.id}.json`), 'utf8')) as Record<string, unknown>
    assert.equal('io' in copyRaw, false, 'a copy never writes an io field')
    const copyFile = join(dir, 'screenshots', copy.id, copy.screenshots[0]?.file as string)
    assert.equal(existsSync(copyFile), true)
    assert.deepEqual(readFileSync(copyFile), PNG)

    const copyDetail = await service.nodeDetail(copy.id)
    assert.deepEqual(copyDetail.incoming, [])
    assert.deepEqual(copyDetail.outgoing, [])
    const sourceDetail = await service.nodeDetail(source.id)
    assert.equal(sourceDetail.incoming.length, 1)
    assert.equal(sourceDetail.outgoing.length, 1)
    const log = await service.decisionLog(10)
    assert.equal(log[0]?.action, 'copy')
    assert.equal(log[0]?.chosen, copy.id)
  })

  it('soft deletes a node and restores it with its edges intact', async () => {
    const dir = temporary()
    const service = newService(dir)
    const ids = await seed(service)
    const portal = ids.get('portal') as string
    const welfareBefore = (await service.paths()).find((path) => path.name === '发福利积分')
    assert.equal(welfareBefore?.runnable, true)

    const deleted = await service.deleteNode(portal, 'tester')
    assert.equal(deleted.status, 'deleted')
    // The default views lose it; the file and every edge stay on disk.
    const search = await service.searchNodes('薪酬辅助系统', 0)
    assert.equal(search.candidates.some((candidate) => candidate.node.id === portal), false)
    assert.equal((await service.paths()).find((path) => path.name === '发福利积分')?.runnable, false)
    assert.equal(existsSync(join(dir, 'nodes', `${portal}.json`)), true)
    assert.match(readFileSync(join(dir, 'edges.jsonl'), 'utf8'), new RegExp(portal))
    assert.deepEqual((await service.listNodes('deleted')).map((node) => node.id), [portal])
    assert.equal((await service.listNodes()).some((node) => node.id === portal), false)

    // Restore is the same node: title, edges, and the saved path work again.
    const restored = await service.restoreNode(portal, 'tester')
    assert.equal(restored.status, 'active')
    assert.equal(restored.title, '打开企业门户的薪酬辅助系统')
    assert.deepEqual(await service.listNodes('deleted'), [])
    assert.equal((await service.paths()).find((path) => path.name === '发福利积分')?.runnable, true)
    assert.equal((await service.searchNodes('薪酬辅助系统', 0)).candidates.some((candidate) => candidate.node.id === portal), true)

    const actions = (await service.decisionLog(5)).map((entry) => entry.action)
    assert.deepEqual(actions.slice(0, 2), ['restore', 'delete_node'])
  })

  it('ignores a legacy io field on read and drops it on the next save', async () => {
    const dir = temporary()
    const service = newService(dir)
    const created = await service.createNode({ title: '老节点', description: '旧的 io 字段应该被忽略' })
    const file = join(dir, 'nodes', `${created.id}.json`)
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    raw.io = { input: '一段输入', output: '一段输出' }
    writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, 'utf8')

    const detail = await service.nodeDetail(created.id)
    assert.equal('io' in (detail.node as unknown as Record<string, unknown>), false, 'io is not exposed on read')
    const saved = await service.updateNode(created.id, { description: '改过说明' })
    assert.equal('io' in (saved as unknown as Record<string, unknown>), false, 'io is not produced on write')
    const after = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    assert.equal('io' in after, false, 'the legacy io field is not written back')
  })

  it('records one update action naming the changed field', async () => {
    const service = newService()
    const node = await service.createNode({ title: '启动浏览器', description: '打开默认浏览器' })
    await service.updateNode(node.id, { description: '打开默认浏览器并进入内网' }, 'tester')
    const log = await service.decisionLog(3)
    assert.equal(log[0]?.action, 'update')
    assert.deepEqual(log[0]?.fields, ['description'])
    assert.equal(log[0]?.operator, 'tester')

    const rows = await service.operations(3)
    assert.equal(rows[0]?.sentence, '修改节点『启动浏览器』的说明')
    assert.equal(rows[0]?.operator, 'tester')
  })

  it('renders 操作记录 in Chinese with titles and without any id', async () => {
    const service = newService()
    const ids = await seed(service)
    const cloud = ids.get('cloud') as string
    const mail = ids.get('mail') as string
    const confirm = ids.get('confirm-mail') as string
    await service.logReuse(cloud, '进入云电脑', 0.82)
    const copy = await service.copyNode(mail, 'tester')
    await service.deleteEdge(cloud, mail, 'tester')
    await service.deleteNode(confirm, 'tester')

    const rows = await service.operations(50)
    const text = JSON.stringify(rows)
    for (const prefix of ['node-', 'path-', 'decision-']) {
      assert.equal(text.includes(prefix), false, `the payload leaks a ${prefix} id`)
    }
    const sentences = rows.map((row) => row.sentence)
    assert.ok(sentences.includes('新建节点『进入天翼云电脑』'))
    assert.ok(sentences.includes(`复制节点『${copy.title}』（来源『在 Foxmail 里写邮件』）`))
    assert.ok(sentences.includes('删除连线：『进入天翼云电脑』→『在 Foxmail 里写邮件』'))
    assert.ok(sentences.includes('删除节点『确认内容并发送邮件』（已删除）'))
    const reuse = rows.find((row) => row.action === 'reuse')
    assert.ok(reuse)
    assert.equal(reuse.operator, '本机用户')
    assert.equal(reuse.node_title, '进入天翼云电脑')
    const copyRow = rows.find((row) => row.action === 'copy')
    assert.equal(copyRow?.candidates[0]?.title, '在 Foxmail 里写邮件')
    assert.equal(copyRow?.candidates[0]?.similarity, 1)
    assert.equal(copyRow?.action_label, '复制节点')
  })

  it('rejects a saved path whose sequence is not executable', async () => {
    const service = newService()
    const a = await service.createNode({ title: 'A', description: 'A' })
    const b = await service.createNode({ title: 'B', description: 'B' })
    const c = await service.createNode({ title: 'C', description: 'C' })
    await service.addEdge(a.id, b.id)
    await service.addEdge(b.id, c.id)
    // A → C is missing, so this sequence is not a prepared path.
    await assert.rejects(() => service.createPath({ name: '坏路径', summary: '缺边', node_sequence: [a.id, c.id] }), (error: unknown) => {
      assert.ok(error instanceof GraphError)
      assert.equal(error.code, 'path-invalid')
      assert.match(error.message, /缺少/)
      return true
    })
    const ok = await service.createPath({ name: '好路径', summary: '三步', node_sequence: [a.id, b.id, c.id] })
    const detail = await service.pathDetail(ok.id)
    assert.equal(detail.nodes.length, 3)
    assert.match(detail.text, /完整路径/)
    assert.match(detail.text, /1\. A/)
    assert.equal(detail.problems.length, 0)
  })

  it('stops with a message when no index matches', async () => {
    const service = newService()
    await seed(service)
    const result = await service.searchPaths('给猫洗一次澡', 0.75)
    assert.equal(result.empty, true)
    assert.equal(result.candidates.length, 0)
    assert.match(result.message ?? '', /补充/)
  })

  it('carries the legacy notes from index match to path load to an AND blocker', async () => {
    const service = newService()
    const ids = await seed(service)
    const matched = await service.searchPaths('给同事发福利积分', 0.75)
    assert.equal(matched.empty, false)
    assert.equal(matched.candidates[0]?.path.name, '发福利积分')
    assert.equal(matched.candidates[0]?.runnable, true)

    const detail = await service.pathDetail(matched.candidates[0]?.path.id as string)
    assert.equal(detail.nodes.length, 3)
    assert.match(detail.text, /进入天翼云电脑/)
    assert.match(detail.text, /填写并发送福利积分/)

    let view = await service.startRun(detail.path.id)
    assert.equal(view.steps.length, 3)
    assert.equal(view.ready, true)
    view = await service.judge(view.id, ids.get('cloud') as string, 'met', '已进入远端桌面，工具栏显示延迟 4ms')
    assert.equal(view.ready, true)
    view = await service.judge(view.id, ids.get('portal') as string, 'unmet', '门户里点薪酬辅助系统没有跳转，没进入系统')
    assert.equal(view.current_node_id, ids.get('portal'))
    assert.equal(view.blocked, true)
    const blocker = view.blockers.find((entry) => entry.node_id === ids.get('welfare'))
    assert.ok(blocker)
    assert.match(blocker.message, /需要「打开企业门户的薪酬辅助系统」的产出/)
    assert.match(blocker.message, /补执行/)
    assert.match(blocker.message, /标记/)
    assert.match(blocker.message, /修改/)
    await assert.rejects(
      () => service.judge(view.id, ids.get('welfare') as string, 'met', '试图越过未达标的前置'),
      (error: unknown) => {
        assert.ok(error instanceof GraphError)
        assert.equal(error.code, 'run-blocked')
        return true
      },
    )
    view = await service.skip(view.id, ids.get('portal') as string, '老板决定先跳过门户这步')
    assert.equal(view.ready, true)
    assert.equal(view.current_node_id, ids.get('welfare'))
    view = await service.judge(view.id, ids.get('welfare') as string, 'met', '出现「发送关爱成功~」')
    assert.equal(view.complete, true)
    assert.match(view.message, /执行完毕/)
  })

  it('matches the email index, loads its path, and reports both unmet prerequisites', async () => {
    const service = newService()
    const ids = await seed(service)
    const matched = await service.searchPaths('用 Foxmail 发邮件给同事', 0.75)
    assert.equal(matched.empty, false)
    assert.equal(matched.candidates[0]?.path.name, '用 Foxmail 发邮件')
    assert.equal(matched.candidates[0]?.runnable, true)

    const detail = await service.pathDetail(matched.candidates[0]?.path.id as string)
    assert.deepEqual(detail.nodes.map((node) => node.title), ['进入天翼云电脑', '在 Foxmail 里写邮件', '确认内容并发送邮件'])
    assert.match(detail.text, /进入天翼云电脑/)
    assert.match(detail.text, /确认内容并发送邮件/)
    assert.equal(detail.problems.length, 0)

    let view = await service.startRun(detail.path.id)
    assert.equal(view.steps.length, 3)
    assert.equal(view.ready, true)
    // Sending needs the cloud desktop AND a written draft: both are still missing, so the
    // blocker must name both, not just the immediate predecessor.
    view = await service.judge(view.id, ids.get('cloud') as string, 'unmet', '还没进入云桌面')
    assert.equal(view.blocked, true)
    const blocker = view.blockers.find((entry) => entry.node_id === ids.get('confirm-mail'))
    assert.ok(blocker)
    assert.equal(blocker.missing.length, 2)
    assert.deepEqual(
      blocker.missing.map((entry) => entry.title).sort(),
      ['在 Foxmail 里写邮件', '进入天翼云电脑'].sort(),
    )
    assert.match(blocker.message, /需要/)
    assert.match(blocker.message, /进入天翼云电脑/)
    assert.match(blocker.message, /在 Foxmail 里写邮件/)
    assert.match(blocker.message, /产出/)
    assert.match(blocker.message, /补执行/)
    assert.match(blocker.message, /标记/)
    assert.match(blocker.message, /修改/)

    view = await service.skip(view.id, ids.get('cloud') as string, '老板确认已在云桌面')
    assert.equal(view.ready, true)
    assert.equal(view.current_node_id, ids.get('mail'))
    view = await service.judge(view.id, ids.get('mail') as string, 'met', '写邮件窗口已打开，四项已填')
    assert.deepEqual(view.current_missing, [])
    assert.equal(view.current_node_id, ids.get('confirm-mail'))
    view = await service.judge(view.id, ids.get('confirm-mail') as string, 'met', '用户确认后已发送')
    assert.equal(view.complete, true)
    assert.match(view.message, /执行完毕/)
  })

  it('requires every predecessor (AND) before a step may run', async () => {
    const service = newService()
    const a = await service.createNode({ title: 'A', description: 'A' })
    const b = await service.createNode({ title: 'B', description: 'B' })
    const c = await service.createNode({ title: 'C', description: 'C' })
    await service.addEdge(a.id, b.id)
    await service.addEdge(a.id, c.id)
    await service.addEdge(b.id, c.id)
    const path = await service.createPath({ name: '汇合', summary: 'A、B 都完成后才能 C', node_sequence: [a.id, b.id, c.id] })

    let view = await service.startRun(path.id)
    view = await service.judge(view.id, a.id, 'met', 'A 达标')
    view = await service.judge(view.id, b.id, 'unmet', 'B 未达标')
    assert.equal(view.blocked, true)
    assert.equal(view.current_node_id, b.id)
    const blocker = view.blockers.find((entry) => entry.node_id === c.id)
    assert.ok(blocker)
    assert.equal(blocker.missing.length, 1)
    assert.equal(blocker.missing[0]?.node_id, b.id)
    // Skipping the missing predecessor is the explicit human override; then C is ready.
    view = await service.skip(view.id, b.id, '人工确认跳过 B')
    assert.equal(view.ready, true)
    assert.equal(view.current_node_id, c.id)
  })

  it('lets any node start a path; predecessors outside that start are the caller\'s situation', async () => {
    const service = newService()
    const first = await service.createNode({ title: '先登录', description: '登录门户' })
    const second = await service.createNode({ title: '再打开薪酬系统', description: '打开薪酬系统' })
    await service.addEdge(first.id, second.id)
    // The graph has no root: the second node may begin its own prepared path.
    const path = await service.createPath({ name: '只做第二步', summary: '假定已登录，直接打开薪酬系统', node_sequence: [second.id] })
    const view = await service.startRun(path.id)
    assert.equal(view.ready, true)
    assert.equal(view.current_node_id, second.id)
  })

  it('writes the manifest and the path index the model reads first', async () => {
    const dir = temporary()
    const service = newService(dir)
    await seed(service)
    const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as {
      usage: string[]
      paths: { id: string; name: string; summary: string; node_sequence: string[]; node_titles: string[]; runnable: boolean }[]
    }
    assert.equal(index.paths.length, 2)
    assert.ok(index.paths.every((path) => path.runnable))
    assert.ok(index.paths.every((path) => path.node_sequence.length === 3))
    assert.ok(index.paths.every((path) => path.node_titles.length === 3))
    // The entry file the model reads first speaks the 收藏 vocabulary now.
    assert.equal(index.usage.some((line) => line.includes('索引')), false, 'index.json still says 索引')
    assert.ok(index.usage.some((line) => line.includes('收藏')))
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as {
      settings: { searchThreshold: number; semanticFloor: number }
      counts: { nodes: number; edges: number; paths: number }
    }
    assert.equal(manifest.settings.searchThreshold, 0.75)
    assert.equal(manifest.settings.semanticFloor, 0.3)
    assert.equal(manifest.counts.nodes, 5)
    assert.equal(manifest.counts.edges, 5)
    assert.equal(manifest.counts.paths, 2)
  })

  it('uses the model difference when available and degrades to null when it fails', async () => {
    const dir = temporary()
    const service = new KnowledgeGraphService(new KnowledgeGraphStore(dir), async () => '对象不同：门户 vs Foxmail')
    const node = await service.createNode({ title: '打开门户', description: '在浏览器打开 my.gdtel.com 企业门户' })
    const good = await service.searchNodes('在浏览器打开企业门户', 0)
    assert.equal(good.candidates[0]?.node.id, node.id)
    assert.equal(good.candidates[0]?.meets_threshold, true)
    assert.equal(good.candidates[0]?.diff, '对象不同：门户 vs Foxmail')

    const failing = new KnowledgeGraphService(new KnowledgeGraphStore(dir), async () => {
      throw new Error('model down')
    })
    const degraded = await failing.searchNodes('在浏览器打开企业门户', 0)
    assert.equal(degraded.candidates[0]?.diff, null)
    assert.ok(degraded.candidates[0]?.similarity !== undefined)
  })

  it('passes node screenshots to the judge model when the route accepts images', async () => {
    const dir = temporary()
    let seen: readonly { mediaType: string; data: Uint8Array }[] = []
    const service = new KnowledgeGraphService(new KnowledgeGraphStore(dir), async (_prompt, _signal, images) => {
      seen = images ?? []
      return '{"met":true,"reason":"截图与成功判据一致"}'
    })
    const node = await service.createNode({ title: '发送成功', description: '出现绿色对勾' })
    await service.addScreenshot(node.id, { caption: '绿色对勾', data: PNG.toString('base64') })
    const path = await service.createPath({ name: '单步', summary: '只做一步', node_sequence: [node.id] })
    const run = await service.startRun(path.id)
    const view = await service.judgeWithLlm(run.id, node.id, '页面顶部出现绿色对勾')
    assert.equal(view.steps[0]?.status, 'met')
    assert.equal(seen.length, 1)
    assert.equal(seen[0]?.mediaType, 'image/png')
    assert.deepEqual(Buffer.from(seen[0]?.data as Uint8Array), PNG)
  })

  it('keeps a readable one-node node record and no hierarchy', async () => {
    const dir = temporary()
    const service = newService(dir)
    const node = await service.createNode({ title: '孤立起点', description: '任何节点都可以是起点', created_by: 'tester' })
    const raw = JSON.parse(readFileSync(join(dir, 'nodes', `${node.id}.json`), 'utf8')) as GraphNode
    assert.equal(raw.id, node.id)
    assert.equal(raw.status, 'active')
    assert.equal(raw.derived_from, null)
    assert.equal(raw.created_by, 'tester')
    assert.ok(Array.isArray(raw.screenshots))
    assert.ok(Array.isArray(raw.embedding))
    const neighborhood = await service.neighborhood(node.id)
    assert.equal(neighborhood.isolated, true)
    assert.equal(neighborhood.nodes.length, 1)
  })
})
