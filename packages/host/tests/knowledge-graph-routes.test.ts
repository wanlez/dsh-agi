import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { GRAPH_PREFIX, handleKnowledgeGraph } from '../src/knowledge-graph/routes.ts'
import { KNOWLEDGE_GRAPH_PAGE } from '../src/knowledge-graph/page.ts'

const root = mkdtempSync(join(tmpdir(), 'orb-graph-http-'))
let server: Server
let base = ''

before(async () => {
  server = createServer((req, res) => {
    void handleKnowledgeGraph({ dir: join(root, 'library'), req, res })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (typeof address === 'object' && address !== null) base = `http://127.0.0.1:${address.port}${GRAPH_PREFIX}`
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(root, { recursive: true, force: true })
})

interface Json { ok: boolean; error?: { code: string; message: string }; [key: string]: unknown }

async function request(method: string, path: string, body?: unknown): Promise<{ status: number; json: Json; text: string; contentType: string }> {
  const response = await fetch(base + path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let json: Json = { ok: false }
  try {
    json = JSON.parse(text) as Json
  } catch {
    // The page is HTML; callers that need it read `text`.
  }
  return { status: response.status, json, text, contentType: response.headers.get('content-type') ?? '' }
}

describe('knowledge graph HTTP surface', () => {
  it('serves the search-first editor and a parseable client script', async () => {
    const page = await request('GET', '/')
    assert.equal(page.status, 200)
    assert.match(page.contentType, /text\/html/)
    assert.match(page.text, /从搜索开始/)
    assert.match(page.text, /搜索一条路径查看整条流程/)
    assert.match(page.text, /统计看板/)
    assert.match(page.text, /\+ 新建节点/)
    assert.match(page.text, /\+ 新建路径/)
    assert.match(page.text, /搜索节点关键词或描述/)
    assert.match(page.text, /搜索路径 \/ 整条流程/)
    assert.match(page.text, /收藏节点/)
    assert.match(page.text, /收藏路径/)
    const script = /<script>([\s\S]*)<\/script>/u.exec(page.text)?.[1]
    assert.ok(script !== undefined)
    assert.doesNotThrow(() => new Function(script as string))
    // The canvas and its anchor/stack vocabulary are gone: the page is a search-first browser.
    assert.doesNotMatch(KNOWLEDGE_GRAPH_PAGE, /id="graph"/)
    assert.doesNotMatch(KNOWLEDGE_GRAPH_PAGE, /路径栈/)
    assert.doesNotMatch(KNOWLEDGE_GRAPH_PAGE, /建立关系/)
  })

  it('renames 索引 to 收藏 and 变更记录 to 操作记录 everywhere the user reads it', async () => {
    const page = await request('GET', '/')
    const text = page.text
    // The old vocabulary is gone from the page source.
    assert.doesNotMatch(text, /索引/)
    assert.doesNotMatch(text, /变更记录/)
    assert.doesNotMatch(text, /合并|废弃/)
    assert.doesNotMatch(text, /io\.input|io\.output/)
    assert.match(text, /收藏节点/)
    assert.match(text, /收藏路径/)
    assert.match(text, /操作记录/)
    assert.match(text, /被这些路径引用/)
    assert.match(text, /没有路径引用它/)
    // Paths carry their own favorite toggle; the node copy affordance was removed.
    assert.match(text, /data-action="toggle-path-favorite"/)
    // The node copy affordance is back (copies are independent), alongside the favorite star.
    assert.match(text, /复制节点/)
    assert.match(text, /删除节点/)
  })

  it('renders the two search boxes, the path editor and the insert dialog', async () => {
    const page = await request('GET', '/')
    assert.equal(page.status, 200)
    const text = page.text

    // Left column: one trigger per surface, both opening the shared picker dialog.
    assert.match(text, /data-action="open-node-picker"/)
    assert.match(text, /data-action="open-path-picker"/)
    assert.match(text, /function openPicker/)
    assert.match(text, /id="pickerList"/)
    assert.match(text, /function pickerMore/)
    assert.match(text, /id="nodeFavorites"/)
    assert.match(text, /id="pathFavorites"/)

    // A path is shown and edited in place: name, summary, ordered steps, check and save.
    assert.match(text, /function renderPathEditor/)
    assert.match(text, /function savePathEditor/)
    assert.match(text, /function checkPathEditor/)
    assert.match(text, /data-action="save-path-editor"/)
    assert.match(text, /data-action="check-path-editor"/)
    assert.match(text, /路径至少需要一个节点/)

    // Inserting a node is a path-only affordance with three sources and a topology-aware guard.
    assert.match(text, /function insertNodeAt/)
    assert.match(text, /function pathGraphHasCycle/)
    assert.match(text, /本路径内节点/)
    assert.match(text, /这样连接会形成环/)
    assert.match(text, /function applyInsert/)

    // The node side edits content only: no edge editing, no family-tree copy.
    assert.match(text, /id="detailTitle"/)
    assert.match(text, /id="detailDesc"/)
    assert.match(text, /data-action="save-node"/)
    assert.doesNotMatch(text, /data-action="open-relation"/)
    const family = ['\u7236', '\u5b50', '\u5144']
    const banned = family.map((prefix) => `${prefix}节点`).concat(['\u524d\u9a71', '\u540e\u7ee7', '\u7236 ·', '\u5b50 ·', '\u5144 ·'])
    assert.deepEqual(banned.filter((term) => text.includes(term)), [], 'visible copy still uses family-tree terms')
  })

  it('offers a path-only insert dialog with cycle protection', async () => {
    const page = await request('GET', '/')
    const text = page.text
    assert.match(text, /insertCols/)
    assert.match(text, /insertLocal/)
    assert.match(text, /insertResults/)
    assert.match(text, /insertFavorites/)
    assert.match(text, /data-pick-node/)
    assert.match(text, /pathGraphHasCycle\(nextGraph\)/)
    assert.match(text, /id="pathCanvas"/)
    // The node side never posts edges any more; edges are library data, not an editor surface.
    assert.doesNotMatch(text, /\/api\/edges/)

    // Drawer keeps its resize contract.
    assert.match(text, /id="detail" class="drawer"/)
    assert.match(text, /function bindDrawerResize/)
    assert.match(text, /id="detailResize"/)
  })

  it('reports an empty library without sending the graph', async () => {
    const state = await request('GET', '/api/state')
    assert.equal(state.status, 200)
    assert.equal(state.json.llm, false)
    assert.equal((state.json.settings as { searchThreshold: number }).searchThreshold, 0.75)
    assert.equal((state.json.settings as { semanticFloor: number }).semanticFloor, 0.3)
    assert.equal((state.json.counts as { nodes: number }).nodes, 0)
  })

  it('creates nodes, searches, and explains a rejected cycle', async () => {
    const a = await request('POST', '/api/nodes', { title: '登录门户', description: '打开企业门户并登录' })
    assert.equal(a.status, 200)
    const b = await request('POST', '/api/nodes', { title: '打开薪酬系统', description: '在门户里打开薪酬辅助系统' })
    const aid = (a.json.node as { id: string }).id
    const bid = (b.json.node as { id: string }).id

    const search = await request('GET', `/api/search?q=${encodeURIComponent('登录门户')}&threshold=0`)
    assert.equal(search.status, 200)
    assert.equal((search.json.candidates as { node: { id: string } }[])[0]?.node.id, aid)

    const self = await request('POST', '/api/edges/validate', { from: aid, to: aid })
    assert.equal(self.status, 409)
    assert.equal(self.json.error?.code, 'self-loop')

    assert.equal((await request('POST', '/api/edges', { from: aid, to: bid })).status, 200)
    const duplicate = await request('POST', '/api/edges', { from: aid, to: bid })
    assert.equal(duplicate.status, 409)
    assert.equal(duplicate.json.error?.code, 'duplicate')

    const cycle = await request('POST', '/api/edges', { from: bid, to: aid })
    assert.equal(cycle.status, 409)
    assert.equal(cycle.json.error?.code, 'cycle')
    assert.match(cycle.json.error?.message ?? '', /会形成环/)
  })

  it('accepts no io field on create or update and never writes one back', async () => {
    const created = await request('POST', '/api/nodes', {
      title: '无 io 节点',
      description: '请求体里的 io 应该被忽略',
      io: { input: '旧输入', output: '旧输出' },
    })
    assert.equal(created.status, 200)
    const node = created.json.node as Record<string, unknown>
    assert.equal('io' in node, false, 'create must not produce io')

    const patched = await request('PATCH', `/api/nodes/${String(node.id)}`, {
      description: '改过说明',
      io: { input: '新输入' },
    })
    assert.equal(patched.status, 200)
    assert.equal('io' in (patched.json.node as Record<string, unknown>), false, 'update must not produce io')

    const detail = await request('GET', `/api/nodes/${String(node.id)}`)
    assert.equal('io' in (detail.json.node as Record<string, unknown>), false)
  })

  it('takes the merge and deprecate routes out of service', async () => {
    const stats = await request('GET', '/api/stats')
    const rows = (stats.json.stats as { nodes: { id: string }[] }).nodes
    const first = rows[0]?.id as string
    const second = rows[1]?.id as string
    assert.equal((await request('POST', '/api/merge/preview', { source_id: first, target_id: second })).status, 404)
    assert.equal((await request('POST', '/api/merge', { source_id: first, target_id: second })).status, 404)
    assert.equal((await request('POST', `/api/nodes/${first}/deprecate`, {})).status, 404)
  })

  it('soft deletes over HTTP and restores the node from the deleted filter', async () => {
    const created = await request('POST', '/api/nodes', { title: '临时节点', description: '用完就删' })
    const id = (created.json.node as { id: string }).id
    const deleted = await request('POST', `/api/nodes/${id}/delete`, {})
    assert.equal(deleted.status, 200)
    assert.equal((deleted.json.node as { status: string }).status, 'deleted')

    const list = await request('GET', '/api/nodes?status=deleted')
    assert.equal(list.status, 200)
    assert.ok((list.json.nodes as { id: string; title: string }[]).some((row) => row.id === id && row.title === '临时节点'))
    const search = await request('GET', `/api/search?q=${encodeURIComponent('临时节点')}&threshold=0`)
    assert.equal((search.json.candidates as { node: { id: string } }[]).some((row) => row.node.id === id), false)

    const restored = await request('POST', `/api/nodes/${id}/restore`, {})
    assert.equal((restored.json.node as { status: string }).status, 'active')
    const after = await request('GET', '/api/nodes?status=deleted')
    assert.equal((after.json.nodes as { id: string }[]).some((row) => row.id === id), false)
  })

  it('answers the operation log in Chinese with no raw ids', async () => {
    const log = await request('GET', '/api/log?limit=50')
    assert.equal(log.status, 200)
    const payload = JSON.stringify(log.json)
    for (const prefix of ['node-', 'path-', 'decision-']) {
      assert.equal(payload.includes(prefix), false, `the operation log leaks a ${prefix} id`)
    }
    const entries = log.json.entries as {
      sentence: string
      action_label: string
      node_title: string
      operator: string
      candidates: { title: string; similarity: number | null }[]
    }[]
    assert.ok(entries.length > 0)
    assert.ok(entries.some((entry) => entry.sentence === '新建节点『登录门户』'))
    assert.ok(entries.every((entry) => !/node-|path-|decision-/u.test(entry.sentence)))
    assert.ok(entries.some((entry) => entry.operator === '本机用户'))
    assert.ok(entries.some((entry) => entry.action_label === '新建节点'))
  })

  it('keeps below-threshold semantics visible while the keyword channel still answers', async () => {
    const created = await request('POST', '/api/nodes', { title: '进入天翼云电脑', description: '登录天翼云电脑并进入远端桌面' })
    assert.equal(created.status, 200)
    const id = (created.json.node as { id: string }).id

    // A high threshold no longer empties the semantic channel: the cloud node is above the
    // floor, so it stays as "未达阈值 · 最接近" while its keyword hit keeps its own block.
    const low = await request('GET', `/api/search?q=${encodeURIComponent('云电脑')}&threshold=0.99`)
    assert.equal(low.status, 200)
    assert.equal(low.json.threshold, 0.99)
    assert.equal(low.json.semantic_floor, 0.3)
    const lowCandidates = low.json.candidates as {
      node: { id: string }
      similarity: number
      meets_threshold: boolean
    }[]
    assert.ok(lowCandidates.length >= 1 && lowCandidates.length <= 3)
    assert.ok(lowCandidates.every((candidate) => candidate.meets_threshold === false))
    assert.ok(lowCandidates.every((candidate) => candidate.similarity >= 0.3))
    assert.equal(lowCandidates.some((candidate) => candidate.node.id === id), true)
    assert.equal(low.json.empty, false)

    const keyword = low.json.keyword as {
      node: { id: string }
      score: number
      field: string
      fragment: string
      scores: { keyword?: number }
    }[]
    const hit = keyword.find((candidate) => candidate.node.id === id)
    assert.ok(hit)
    assert.equal(hit.field, 'title')
    assert.equal(hit.score, 1)
    assert.equal(hit.fragment, '云电脑')
    assert.equal(hit.scores.keyword, 1)
    // The same node may sit in the below-threshold group and in the keyword block, because
    // only confirmed candidates are deduplicated.
    assert.equal((lowCandidates.find((candidate) => candidate.node.id === id) as { scores: { keyword?: number } }).scores.keyword, 1)

    // keywordTop / keywordFloor are per-request overrides; 0.99 drops the description hits.
    const limited = await request(
      'GET',
      `/api/search?q=${encodeURIComponent('云电脑')}&threshold=0.99&keywordTop=1&keywordFloor=0.99`,
    )
    const limitedKeyword = limited.json.keyword as { node: { id: string } }[]
    assert.equal(limitedKeyword.length, 1)
    assert.equal(limitedKeyword[0]?.node.id, id)

    // A meeting threshold marks the node as confirmed and deduplicates the keyword block.
    const both = await request('GET', `/api/search?q=${encodeURIComponent('进入天翼云电脑')}&threshold=0`)
    const candidate = (both.json.candidates as {
      node: { id: string }
      similarity: number
      meets_threshold: boolean
      scores: { semantic?: number; keyword?: number }
    }[]).find((entry) => entry.node.id === id)
    assert.ok(candidate)
    assert.equal(candidate.meets_threshold, true)
    assert.equal(candidate.scores.semantic, candidate.similarity)
    assert.equal(candidate.scores.keyword, 1)
    assert.equal((both.json.keyword as { node: { id: string } }[]).some((entry) => entry.node.id === id), false)
  })

  it('saves an index, matches it, starts a run, and enforces the blocker over HTTP', async () => {
    const nodes = await request('GET', '/api/stats')
    const rows = (nodes.json.stats as { nodes: { id: string; title: string }[] }).nodes
    const a = rows.find((row) => row.title === '登录门户')?.id as string
    const b = rows.find((row) => row.title === '打开薪酬系统')?.id as string
    const c = await request('POST', '/api/nodes', { title: '填写福利积分', description: '填表并确认发送' })
    const cid = (c.json.node as { id: string }).id
    assert.equal((await request('POST', '/api/edges', { from: b, to: cid })).status, 200)

    const path = await request('POST', '/api/paths', {
      name: '发福利',
      summary: '登录企业门户，打开薪酬辅助系统，填写福利积分并发送',
      node_sequence: [a, b, cid],
    })
    assert.equal(path.status, 200)
    const pathId = (path.json.path as { id: string }).id

    const match = await request('GET', `/api/index/match?q=${encodeURIComponent('登录企业门户打开薪酬辅助系统发福利')}&threshold=0.1`)
    assert.equal(match.status, 200)
    assert.equal(match.json.empty, false)
    assert.equal((match.json.candidates as { path: { id: string } }[])[0]?.path.id, pathId)

    const run = await request('POST', `/api/paths/${pathId}/run`, {})
    assert.equal(run.status, 200)
    const runId = (run.json.view as { id: string }).id
    let view = (await request('POST', `/api/runs/${runId}/judge`, { node_id: a, verdict: 'met', reason: '门户已登录' })).json.view as {
      current_node_id: string
      blocked: boolean
      blockers: { node_id: string; message: string }[]
    }
    assert.equal(view.current_node_id, b)
    view = (await request('POST', `/api/runs/${runId}/judge`, { node_id: b, verdict: 'unmet', reason: '图标点不开' })).json.view as typeof view
    assert.equal(view.blocked, true)
    assert.match(view.blockers.find((blocker) => blocker.node_id === cid)?.message ?? '', /需要「打开薪酬系统」的产出/)
    const blocked = await request('POST', `/api/runs/${runId}/judge`, { node_id: cid, verdict: 'met', reason: '越过' })
    assert.equal(blocked.status, 409)
    assert.equal(blocked.json.error?.code, 'run-blocked')
  })

  it('matches an index through the keyword channel too', async () => {
    const both = await request('GET', `/api/index/match?q=${encodeURIComponent('发福利')}&threshold=0.3`)
    assert.equal(both.status, 200)
    assert.equal(typeof both.json.keyword_threshold, 'number')
    const candidates = both.json.candidates as {
      path: { id: string; name: string }
      scores: { semantic?: number; keyword?: number }
    }[]
    const keyword = both.json.keyword as {
      path: { id: string; name: string }
      score: number
      field: string
      fragment: string
    }[]
    const candidate = candidates.find((entry) => entry.path.name === '发福利')
    assert.ok(candidate)
    // The same index is listed once, in the semantic block, with the keyword score beside it.
    assert.equal(candidate.scores.keyword, 1)
    assert.equal(keyword.some((entry) => entry.path.id === candidate.path.id), false)
    assert.equal(new Set(keyword.map((entry) => entry.path.id)).size, keyword.length)
  })

  it('stores and serves a screenshot with the caption', async () => {
    const stats = await request('GET', '/api/stats')
    const nodeId = ((stats.json.stats as { nodes: { id: string }[] }).nodes[0]).id
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nQAAAABJRU5ErkJggg=='
    const uploaded = await request('POST', `/api/nodes/${nodeId}/screenshots`, { caption: '登录成功的首页', data: png })
    assert.equal(uploaded.status, 200)
    const detail = await request('GET', `/api/nodes/${nodeId}`)
    const shots = detail.json.screenshots as { caption: string; url: string }[]
    assert.equal(shots[0]?.caption, '登录成功的首页')
    assert.equal(shots[0]?.url.startsWith('api/screenshots/'), true)
    const image = await fetch(`${base}/${shots[0]?.url}`)
    assert.equal(image.status, 200)
    assert.match(image.headers.get('content-type') ?? '', /image\/png/)
    assert.equal((await image.arrayBuffer()).byteLength, Buffer.from(png, 'base64').length)
  })

  it('persists the screenshot source and moves it between the human and AI shelves', async () => {
    const created = await request('POST', '/api/nodes', { title: '来源测试节点', description: '人工写的原文' })
    const nodeId = (created.json.node as { id: string }).id
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nQAAAABJRU5ErkJggg=='

    const uploaded = await request('POST', `/api/nodes/${nodeId}/screenshots`, {
      caption: 'AI 执行指导图',
      data: png,
      source: 'ai',
    })
    assert.equal(uploaded.status, 200)
    let shots = (await request('GET', `/api/nodes/${nodeId}`)).json.screenshots as { id: string; source: string }[]
    assert.equal(shots[0]?.source, 'ai')

    const moved = await request('PATCH', `/api/nodes/${nodeId}/screenshots/${shots[0]?.id}`, {
      caption: '人工复核图',
      source: 'human',
    })
    assert.equal(moved.status, 200)
    shots = (await request('GET', `/api/nodes/${nodeId}`)).json.screenshots as { id: string; source: string }[]
    assert.equal(shots[0]?.source, 'human')

    const invalid = await request('POST', `/api/nodes/${nodeId}/screenshots`, {
      caption: '错误来源',
      data: png,
      source: 'robot',
    })
    assert.equal(invalid.status, 400)
    assert.equal(invalid.json.error?.code, 'screenshot-source-invalid')
  })

  it('writes ai_notes without touching the human description', async () => {
    const created = await request('POST', '/api/nodes', { title: '备注测试节点', description: '人的原始描述' })
    const nodeId = (created.json.node as { id: string }).id

    const patch = await request('PATCH', `/api/nodes/${nodeId}`, { ai_notes: '第一条 AI 补充' })
    assert.equal(patch.status, 200)
    assert.equal((patch.json.node as { ai_notes?: string }).ai_notes, '第一条 AI 补充')

    const posted = await request('POST', `/api/nodes/${nodeId}/ai-notes`, { ai_notes: '第二条 AI 补充' })
    assert.equal(posted.status, 200)

    const detail = await request('GET', `/api/nodes/${nodeId}`)
    assert.equal((detail.json.node as { ai_notes?: string }).ai_notes, '第二条 AI 补充')
    assert.equal((detail.json.node as { description: string }).description, '人的原始描述')

    // The agent path may only touch ai_notes, never rewrite the operator's prose.
    const denied = await request('PATCH', `/api/nodes/${nodeId}?operator=ai`, { description: 'AI 想改描述' })
    assert.equal(denied.status, 403)
    assert.equal(denied.json.error?.code, 'human-field-readonly')
  })

  it('deletes a path over HTTP and leaves no reference in index.json', async () => {
    const created = await request('POST', '/api/nodes', { title: '待删路径节点', description: '独立节点' })
    const nodeId = (created.json.node as { id: string }).id
    const saved = await request('POST', '/api/paths', {
      name: '待删路径',
      summary: '删除后 index 不应残留',
      node_sequence: [nodeId],
    })
    assert.equal(saved.status, 200)
    const pathId = (saved.json.path as { id: string }).id

    const removed = await request('DELETE', `/api/paths/${pathId}`)
    assert.equal(removed.status, 200)
    assert.equal((await request('GET', `/api/paths/${pathId}`)).status, 404)

    const index = JSON.parse(await readFile(join(root, 'library', 'index.json'), 'utf8')) as {
      paths: { id: string }[]
    }
    assert.equal(index.paths.some((entry) => entry.id === pathId), false)
  })

  it('serializes concurrent writes so a screenshot delete and a node patch both survive', async () => {
    const created = await request('POST', '/api/nodes', { title: '并发节点', description: '并发前的描述' })
    const nodeId = (created.json.node as { id: string }).id
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nQAAAABJRU5ErkJggg=='
    const uploaded = await request('POST', `/api/nodes/${nodeId}/screenshots`, { caption: '并发截图', data: png })
    const shotId = ((uploaded.json.node as { screenshots: { id: string }[] }).screenshots[0]).id

    await Promise.all([
      request('DELETE', `/api/nodes/${nodeId}/screenshots/${shotId}`),
      request('PATCH', `/api/nodes/${nodeId}`, { title: '并发后的标题' }),
      request('PATCH', `/api/nodes/${nodeId}`, { description: '并发后的描述' }),
    ])

    const detail = await request('GET', `/api/nodes/${nodeId}`)
    const node = detail.json.node as { title: string; description: string; screenshots: unknown[] }
    assert.equal(node.title, '并发后的标题')
    assert.equal(node.description, '并发后的描述')
    assert.equal(node.screenshots.length, 0)
  })

  it('stores a path independently of graph edges and rejects a repeated node', async () => {
    const stats = await request('GET', '/api/stats')
    const first = (stats.json.stats as { nodes: { id: string }[] }).nodes[0].id
    const isolated = await request('POST', '/api/nodes', { title: '孤立节点', description: '没有任何边' })
    const isolatedId = (isolated.json.node as { id: string }).id
    // A saved path is its own reference list: consecutive steps need no edge between them.
    const saved = await request('POST', '/api/paths', {
      name: '独立路径',
      summary: '不依赖图上的边',
      node_sequence: [first, isolatedId],
    })
    assert.equal(saved.status, 200)
    // A repeated node inside one path is a cycle, so it is still refused.
    const repeated = await request('POST', '/api/paths', {
      name: '重复路径',
      summary: '同一节点出现两次',
      node_sequence: [first, isolatedId, first],
    })
    assert.equal(repeated.status, 400)
    assert.equal(repeated.json.error?.code, 'path-duplicate')
  })

  it('builds an edge from a search hit for a node the canvas never shows', async () => {
    // The relation dialog and the toolbar both pick a target from /api/search and then
    // post the two ids; an isolated node is never part of the anchor's 1-hop view.
    const created = await request('POST', '/api/nodes', { title: '画布外节点', description: '只通过搜索才找得到' })
    const target = (created.json.node as { id: string }).id
    const search = await request('GET', `/api/search?q=${encodeURIComponent('画布外节点')}&threshold=0`)
    const hit = (search.json.candidates as { node: { id: string } }[]).find((entry) => entry.node.id === target)
    assert.ok(hit, 'the dialog results must contain the node')

    const stats = await request('GET', '/api/stats')
    const start = ((stats.json.stats as { nodes: { id: string }[] }).nodes
      .find((row) => row.id !== target))?.id as string
    const check = await request('POST', '/api/edges/validate', { from: start, to: target })
    assert.equal(check.status, 200)
    const createdEdge = await request('POST', '/api/edges', { from: start, to: target })
    assert.equal(createdEdge.status, 200)
    assert.equal((createdEdge.json.edge as { from: string; to: string }).to, target)

    const duplicate = await request('POST', '/api/edges/validate', { from: start, to: target })
    assert.equal(duplicate.status, 409)
    assert.equal(duplicate.json.error?.code, 'duplicate')
  })
})
