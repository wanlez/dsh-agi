/**
 * End-to-end smoke test for the experience graph editor.
 *
 *   pnpm smoke:graph
 *
 * Starts the same server the settings page mounts (`dev:graph`), then walks the whole
 * surface with HTTP calls: create nodes, add an edge, reject a cycle and a duplicate,
 * search, copy (isolated), soft delete + restore, save a favorite path, match it, load
 * the path, run it and hit the AND blocker, upload a screenshot, and prove the no-match
 * stop message.
 *
 * `--base http://127.0.0.1:47831` talks to an already running dev server instead of
 * spawning one; `--dir` points the spawned server at a real library.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { GRAPH_PREFIX } from '../src/knowledge-graph/routes.ts'

function argument(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return fallback
  return process.argv[index + 1] ?? fallback
}

const port = Number(argument('port', '47831'))
const base = (argument('base') ?? `http://127.0.0.1:${port}${GRAPH_PREFIX}`).replace(/\/+$/u, '')
const library = argument('dir') ?? mkdtempSync(join(tmpdir(), 'graph-smoke-'))
const ownedLibrary = argument('dir') === undefined
let server: ChildProcess | undefined
let checks = 0

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nQAAAABJRU5ErkJggg=='

interface Reply {
  readonly status: number
  readonly json: Record<string, unknown>
  readonly text: string
  readonly type: string
}

async function call(method: string, path: string, body?: unknown): Promise<Reply> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let json: Record<string, unknown> = {}
  try {
    json = JSON.parse(text) as Record<string, unknown>
  } catch {
    // The page is HTML.
  }
  return { status: response.status, json, text, type: response.headers.get('content-type') ?? '' }
}

function pass(name: string): void {
  checks += 1
  console.log(`  ✔ ${name}`)
}

function fail(name: string, detail: string): never {
  console.error(`  ✖ ${name}`)
  console.error(`    ${detail}`)
  process.exitCode = 1
  throw new Error(`${name}: ${detail}`)
}

function expect(condition: unknown, name: string, detail: string): void {
  if (!condition) fail(name, detail)
}

function errorCode(reply: Reply): string {
  return String((reply.json.error as { code?: string } | undefined)?.code ?? '')
}

async function waitForServer(): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const reply = await fetch(`${base}/api/state`)
      if (reply.ok) return
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`dev server did not start: ${base}`)
}

async function start(): Promise<void> {
  if (argument('base') !== undefined) {
    await waitForServer()
    return
  }
  console.log(`启动 dev:graph（库：${library}，端口：${port}）`)
  server = spawn(process.execPath, [
    '--experimental-transform-types',
    '--disable-warning=ExperimentalWarning',
    join(process.cwd(), 'packages/host/src/knowledge-graph/dev-server.ts'),
    '--dir', library,
    '--port', String(port),
  ], { stdio: 'ignore' })
  await waitForServer()
}

async function stop(): Promise<void> {
  if (server !== undefined) {
    server.kill()
    server = undefined
  }
  if (ownedLibrary) {
    try {
      rmSync(library, { recursive: true, force: true })
    } catch {
      // The OS temp folder is cleaned eventually.
    }
  }
}

async function run(): Promise<void> {
  await start()
  console.log(`经验库：${base}`)

  // 1. The page itself.
  const page = await call('GET', '/')
  expect(page.status === 200, '页面 200', `HTTP ${page.status}`)
  expect(/text\/html/u.test(page.type), '页面是 HTML', page.type)
  expect(page.text.includes('首屏是空图'), '页面含首屏空图文案', page.text.slice(0, 120))
  const script = /<script>([\s\S]*)<\/script>/u.exec(page.text)?.[1]
  expect(script !== undefined && (() => { try { new Function(script as string); return true } catch { return false } })(), '页面脚本可解析', 'script parse failed')
  pass('GET / 返回可视化编辑页且内联脚本可解析')

  const empty = await call('GET', '/api/state')
  expect((empty.json.counts as { nodes: number }).nodes === 0, '空库计数为 0', JSON.stringify(empty.json.counts))
  pass('GET /api/state 空库基线')

  // 2. Nodes.
  const a = await call('POST', '/api/nodes', { title: '登录企业门户', description: '打开 my.gdtel.com 并登录' })
  const b = await call('POST', '/api/nodes', { title: '打开薪酬辅助系统', description: '在门户常用应用里打开薪酬辅助系统' })
  const c = await call('POST', '/api/nodes', { title: '填写并发送福利积分', description: '填必填项并点确认发送' })
  const aid = (a.json.node as { id: string }).id
  const bid = (b.json.node as { id: string }).id
  const cid = (c.json.node as { id: string }).id
  expect(a.status === 200 && bid !== aid && cid !== aid, '三个节点创建成功', JSON.stringify([a.status, b.status, c.status]))
  pass(`POST /api/nodes 创建 3 个节点（${[aid, bid, cid].join(', ')}）`)

  // 3. Edges: normal, duplicate, self loop, cycle.
  expect((await call('POST', '/api/edges', { from: aid, to: bid })).status === 200, 'A→B 边', 'edge failed')
  expect((await call('POST', '/api/edges', { from: bid, to: cid })).status === 200, 'B→C 边', 'edge failed')
  pass('POST /api/edges 建 A→B、B→C')

  const duplicate = await call('POST', '/api/edges', { from: aid, to: bid })
  expect(duplicate.status === 409 && errorCode(duplicate) === 'duplicate', '重复边 409 duplicate', JSON.stringify(duplicate.json))
  pass('重复边被拒：409 duplicate')

  const cycle = await call('POST', '/api/edges', { from: cid, to: aid })
  expect(cycle.status === 409 && errorCode(cycle) === 'cycle', '环 409 cycle', JSON.stringify(cycle.json))
  expect(/会形成环/u.test(String((cycle.json.error as { message?: string }).message)), '环提示可读', JSON.stringify(cycle.json))
  pass(`环检测被拒：409 cycle（${(cycle.json.error as { message?: string }).message}）`)

  const self = await call('POST', '/api/edges/validate', { from: aid, to: aid })
  expect(self.status === 409 && errorCode(self) === 'self-loop', '自环 409 self-loop', JSON.stringify(self.json))
  pass('建边前校验：自环 409 self-loop')

  // 4. Search.
  const search = await call('GET', `/api/search?q=${encodeURIComponent('登录企业门户')}&threshold=0`)
  const hits = search.json.candidates as { node: { id: string }; similarity: number }[]
  expect(search.status === 200 && hits[0]?.node.id === aid, '搜索命中 A', JSON.stringify(search.json))
  pass(`GET /api/search 命中「登录企业门户」，相似度 ${Math.round((hits[0]?.similarity ?? 0) * 100)}%`)

  const miss = await call('GET', `/api/search?q=${encodeURIComponent('给猫洗一次澡')}&threshold=0.99`)
  expect(miss.json.empty === true, '搜索无命中', JSON.stringify(miss.json))
  pass('搜索无命中时为空结果（不伪造候选）')

  // 5. Copy: node content only, no edges.
  const copy = await call('POST', `/api/nodes/${encodeURIComponent(bid)}/copy`, {})
  const copyNode = copy.json.node as { id: string; derived_from: string; title: string }
  expect(copy.status === 200 && copyNode.derived_from === bid, '副本 derived_from', JSON.stringify(copy.json))
  const copyDetail = await call('GET', `/api/nodes/${encodeURIComponent(copyNode.id)}`)
  const incoming = copyDetail.json.incoming as unknown[]
  const outgoing = copyDetail.json.outgoing as unknown[]
  expect(incoming.length === 0 && outgoing.length === 0, '副本孤立', JSON.stringify({ incoming, outgoing }))
  pass(`POST /api/nodes/:id/copy 复制为孤立副本「${copyNode.title}」，derived_from=${bid}`)

  // 6. Soft delete + restore (the only delete the editor offers now).
  const deleted = await call('POST', `/api/nodes/${encodeURIComponent(copyNode.id)}/delete`, {})
  expect(deleted.status === 200 && (deleted.json.node as { status: string }).status === 'deleted', '软删除', JSON.stringify(deleted.json))
  const deletedList = await call('GET', '/api/nodes?status=deleted')
  const deletedRows = deletedList.json.nodes as { id: string; title: string }[]
  expect(deletedRows.some((row) => row.id === copyNode.id), '已删除筛选列出节点', JSON.stringify(deletedRows))
  const restored = await call('POST', `/api/nodes/${encodeURIComponent(copyNode.id)}/restore`, {})
  expect(restored.status === 200 && (restored.json.node as { status: string }).status === 'active', '恢复节点', JSON.stringify(restored.json))
  const afterRestore = await call('GET', '/api/nodes?status=deleted')
  expect((afterRestore.json.nodes as { id: string }[]).some((row) => row.id === copyNode.id) === false, '恢复后不在已删除列表', JSON.stringify(afterRestore.json))
  pass(`软删除 → 已删除列表 → 恢复「${copyNode.title}」= active`)

  // 6b. The relation dialog's search entry: a node outside the 1-hop view is findable and
  // can be connected by from/to ids, exactly what the + dialog and the toolbar submit.
  const outside = await call('GET', `/api/search?q=${encodeURIComponent('填写并发送福利积分')}&threshold=0`)
  const outsideHit = (outside.json.candidates as { node: { id: string; title: string } }[])[0]
  expect(outsideHit?.node.id === cid, '搜索可找到画布外节点', JSON.stringify(outside.json))
  const relationCheck = await call('POST', '/api/edges/validate', { from: copyNode.id, to: outsideHit.node.id })
  expect(relationCheck.status === 200, '建立关系前校验通过', JSON.stringify(relationCheck.json))
  const relation = await call('POST', '/api/edges', { from: copyNode.id, to: outsideHit.node.id })
  expect(relation.status === 200, '通过搜索建边', JSON.stringify(relation.json))
  pass(`搜索选中画布外节点并建边：副本 →「${outsideHit.node.title}」`)

  // 7. Path + favorite matching.
  const path = await call('POST', '/api/paths', {
    name: '发福利积分',
    summary: '登录企业门户，打开薪酬辅助系统，填写并发送福利积分',
    node_sequence: [aid, bid, cid],
  })
  expect(path.status === 200, '保存收藏', JSON.stringify(path.json))
  const pathId = (path.json.path as { id: string }).id
  const index = await call('GET', `/api/index/match?q=${encodeURIComponent('给同事发福利积分')}&threshold=0.3`)
  const candidates = index.json.candidates as { path: { id: string } }[]
  expect(index.json.empty === false && candidates[0]?.path.id === pathId, '收藏匹配', JSON.stringify(index.json))
  pass(`GET /api/index/match 命中「发福利积分」（首个候选 ${Math.round(((index.json.candidates as { similarity: number }[])[0]?.similarity ?? 0) * 100)}%）`)

  const detail = await call('GET', `/api/paths/${encodeURIComponent(pathId)}`)
  expect(detail.status === 200 && String(detail.json.text).includes('完整路径'), '路径读入', JSON.stringify(detail.json))
  const nodesInPath = detail.json.nodes as { title: string }[]
  expect(nodesInPath.length === 3, '路径 3 步', JSON.stringify(nodesInPath))
  pass(`GET /api/paths/:id 读入 3 步：${nodesInPath.map((node) => node.title).join(' → ')}`)

  // 8. Run + AND blocker.
  const runReply = await call('POST', `/api/paths/${encodeURIComponent(pathId)}/run`, {})
  const runId = (runReply.json.view as { id: string }).id
  expect(runReply.status === 200 && runId !== undefined, '启动执行', JSON.stringify(runReply.json))
  let view = (await call('POST', `/api/runs/${encodeURIComponent(runId)}/judge`, { node_id: aid, verdict: 'met', reason: '门户已登录' })).json.view as {
    current_node_id: string
    blocked: boolean
    ready: boolean
    blockers: { node_id: string; message: string }[]
    complete: boolean
  }
  expect(view.current_node_id === bid && view.ready === true, '推进到第 2 步', JSON.stringify(view))
  view = (await call('POST', `/api/runs/${encodeURIComponent(runId)}/judge`, { node_id: bid, verdict: 'unmet', reason: '图标点不开' })).json.view as typeof view
  expect(view.blocked === true, '未达标即阻塞', JSON.stringify(view))
  const blocker = view.blockers.find((entry) => entry.node_id === cid)
  expect(blocker !== undefined && /产出/u.test(blocker.message), '阻塞提示说明缺哪个前置', JSON.stringify(view.blockers))
  pass(`判定 step2 未达标 → 阻塞提示：${blocker?.message}`)

  const jumped = await call('POST', `/api/runs/${encodeURIComponent(runId)}/judge`, { node_id: cid, verdict: 'met', reason: '试图越过' })
  expect(jumped.status === 409 && errorCode(jumped) === 'run-blocked', '越过前置 409', JSON.stringify(jumped.json))
  pass('越过未达标前置被拒：409 run-blocked')

  let advanced = (await call('POST', `/api/runs/${encodeURIComponent(runId)}/skip`, { node_id: bid, reason: '人工确认跳过' })).json.view as typeof view
  expect(advanced.ready === true && advanced.current_node_id === cid, '跳过后可继续', JSON.stringify(advanced))
  advanced = (await call('POST', `/api/runs/${encodeURIComponent(runId)}/judge`, { node_id: cid, verdict: 'met', reason: '出现「发送关爱成功~」' })).json.view as typeof view
  expect(advanced.complete === true, '执行完毕', JSON.stringify(advanced))
  pass('标记跳过 → 推进 → 完成（执行完毕提示）')

  // 9. Screenshot upload + serving.
  const uploaded = await call('POST', `/api/nodes/${encodeURIComponent(cid)}/screenshots`, { caption: '发送成功的绿色对勾', data: PNG })
  expect(uploaded.status === 200, '上传截图', JSON.stringify(uploaded.json))
  const shot = ((await call('GET', `/api/nodes/${encodeURIComponent(cid)}`)).json.screenshots as { url: string; caption: string }[])[0]
  expect(shot !== undefined && shot.caption === '发送成功的绿色对勾', '截图 caption', JSON.stringify(shot))
  const image = await fetch(`${base}/${shot?.url}`)
  expect(image.status === 200 && /image\/png/u.test(image.headers.get('content-type') ?? ''), '截图可访问', `${image.status}`)
  pass(`POST /api/nodes/:id/screenshots 上传并读回（${shot?.url}）`)

  // 10. No-match stop message.
  const noMatch = await call('GET', `/api/index/match?q=${encodeURIComponent('给猫洗一次澡')}&threshold=0.99`)
  expect(noMatch.json.empty === true, '无匹配为空', JSON.stringify(noMatch.json))
  expect(/补充/u.test(String(noMatch.json.message ?? '')), '无匹配给出停机提示', JSON.stringify(noMatch.json))
  pass(`无匹配停机提示：${String(noMatch.json.message)}`)

  // 11. Final counts.
  const stats = (await call('GET', '/api/stats')).json.stats as {
    counts: { nodes: number; edges: number; paths: number; decisions: number; runnable_paths: number }
  }
  expect(stats.counts.nodes === 4 && stats.counts.edges === 3 && stats.counts.paths === 1, '统计看板计数', JSON.stringify(stats.counts))
  expect(stats.counts.runnable_paths === 1, '收藏可执行', JSON.stringify(stats.counts))
  pass(`GET /api/stats 计数正确：节点 ${stats.counts.nodes} / 边 ${stats.counts.edges} / 收藏 ${stats.counts.paths} / 决策 ${stats.counts.decisions}`)

  console.log(`\nSMOKE OK：${checks} 项检查全部通过`)
}

try {
  await run()
} catch (error) {
  if (process.exitCode !== 1) {
    console.error(`\nSMOKE FAILED：${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
} finally {
  await stop()
}
