/**
 * HTTP surface of the experience graph editor.
 *
 * The plugin mounts this under `/.dsh-agi/knowledge-graph` on its existing web port, so
 * the settings page cookie is already enough. The same handler runs from the local
 * development server (`dev-server.ts`) for verification without restarting DSH.
 */

import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { GraphCompletion } from './search.ts'
import type { GraphNode, GraphPath, NodeStatus, PathGraph, PathGraphEdge, PathGraphNode } from './model.ts'
import { KNOWLEDGE_GRAPH_PAGE } from './page.ts'
import { KnowledgeGraphService, type CommonSenseInputEntry } from './service.ts'
import { KnowledgeGraphStore } from './store.ts'
import { GraphError, NODE_STATUSES } from './model.ts'
import { GRAPH_POINTER, publishGraphPointer } from './library.ts'

/** Mount point, shared with the settings page. */
export const GRAPH_PREFIX = '/.dsh-agi/knowledge-graph'

/** Largest JSON body, sized for one 8 MB screenshot as base64. */
const BODY_LIMIT = 12 * 1024 * 1024

/** One service per library directory so run ids survive between requests. */
const SERVICES = new Map<string, KnowledgeGraphService>()

/** Fixed pointer the agent's standing prompt can read whatever profile is active. */
export { GRAPH_POINTER, publishGraphPointer }

/** Whether a request path belongs to the editor. */
export function isKnowledgeGraphPath(pathname: string): boolean {
  return pathname === GRAPH_PREFIX || pathname.startsWith(`${GRAPH_PREFIX}/`)
}

/** Get or create the service for one directory. */
function serviceFor(dir: string, completion: GraphCompletion | undefined): KnowledgeGraphService {
  const existing = SERVICES.get(dir)
  if (existing !== undefined) return existing
  const service = new KnowledgeGraphService(new KnowledgeGraphStore(dir), completion)
  SERVICES.set(dir, service)
  return service
}

/** Options one request needs. */
export interface GraphRequestOptions {
  /** Absolute library directory. */
  readonly dir: string
  readonly req: IncomingMessage
  readonly res: ServerResponse
  /** Optional model channel; absent means the editor uses its fallback layouts. */
  readonly completion?: GraphCompletion
}

/**
 * Answer one request. The caller has already checked authentication and the prefix.
 * @param options - directory, request, response, optional model channel.
 */
export async function handleKnowledgeGraph(options: GraphRequestOptions): Promise<void> {
  const { req, res } = options
  try {
    await dispatch(options)
  } catch (error) {
    if (res.headersSent) {
      res.end()
      return
    }
    if (error instanceof GraphError) {
      sendJson(res, error.status, { ok: false, error: { code: error.code, message: error.message } })
      return
    }
    const message = error instanceof Error ? error.message : String(error)
    console.error(`dsh-agi: knowledge graph failed: ${message}`)
    sendJson(res, 500, { ok: false, error: { code: 'internal-error', message } })
  }
}

async function dispatch(options: GraphRequestOptions): Promise<void> {
  const { req, res, dir } = options
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const method = (req.method ?? 'GET').toUpperCase()
  const sub = url.pathname.slice(GRAPH_PREFIX.length) || '/'
  const service = serviceFor(dir, options.completion)
  const parts = sub.split('/').filter((part) => part !== '')
  const at = (index: number): string => decodeURIComponent(parts[index] ?? '')

  // The page itself.
  if ((method === 'GET' || method === 'HEAD') && (sub === '/' || sub === '/index.html')) {
    const body = Buffer.from(KNOWLEDGE_GRAPH_PAGE, 'utf8')
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': body.length,
    })
    res.end(method === 'HEAD' ? undefined : body)
    return
  }

  if (parts[0] !== 'api') {
    sendJson(res, 404, { ok: false, error: { code: 'not-found', message: '没有这个页面。' } })
    return
  }

  // Summary for the first screen: the path is named, no graph is sent.
  if (method === 'GET' && parts[1] === 'state') {
    const stats = await service.stats()
    sendJson(res, 200, {
      ok: true,
      api_version: 2,
      dir: stats.dir,
      settings: stats.settings,
      counts: stats.counts,
      llm: options.completion !== undefined,
    })
    return
  }

  if (method === 'GET' && parts[1] === 'stats') {
    sendJson(res, 200, { ok: true, stats: await service.stats() })
    return
  }

  if (parts[1] === 'settings') {
    if (method === 'GET') {
      const stats = await service.stats()
      sendJson(res, 200, { ok: true, settings: stats.settings })
      return
    }
    if (method === 'PUT' || method === 'POST') {
      const settings = await service.updateSettings(await readJson(req))
      sendJson(res, 200, { ok: true, settings })
      return
    }
  }

  if (method === 'GET' && parts[1] === 'search') {
    const query = url.searchParams.get('q') ?? ''
    const threshold = numberParam(url.searchParams.get('threshold'))
    const keyword = {
      top: numberParam(url.searchParams.get('keywordTop')),
      floor: numberParam(url.searchParams.get('keywordFloor')),
    }
    const result = await service.searchNodes(query, threshold, keyword)
    sendJson(res, 200, {
      ...result,
      ok: true,
      candidates: result.candidates.map((candidate) => ({ ...candidate, node: publicNode(candidate.node) })),
      keyword: result.keyword.map((candidate) => ({ ...candidate, node: publicNode(candidate.node) })),
    })
    return
  }

  if (method === 'GET' && parts[1] === 'index' && parts[2] === 'match') {
    const query = url.searchParams.get('q') ?? ''
    const threshold = numberParam(url.searchParams.get('threshold'))
    const keyword = {
      top: numberParam(url.searchParams.get('keywordTop')),
      floor: numberParam(url.searchParams.get('keywordFloor')),
    }
    const result = await service.searchPaths(query, threshold, keyword)
    sendJson(res, 200, {
      ...result,
      ok: true,
      candidates: result.candidates.map((candidate) => ({ ...candidate, path: publicPath(candidate.path) })),
      keyword: result.keyword.map((candidate) => ({ ...candidate, path: publicPath(candidate.path) })),
    })
    return
  }

  if (method === 'GET' && parts[1] === 'neighborhood') {
    const id = url.searchParams.get('id') ?? ''
    const view = await service.neighborhood(id)
    sendJson(res, 200, { ok: true, ...view })
    return
  }

  if (method === 'GET' && parts[1] === 'log') {
    const limit = numberParam(url.searchParams.get('limit')) ?? 100
    sendJson(res, 200, { ok: true, entries: await service.operations(Math.min(500, Math.max(1, Math.trunc(limit)))) })
    return
  }

  // Node collection: create, or list by status for the 已删除 filter.
  if (parts[1] === 'nodes' && parts.length === 2) {
    if (method === 'GET') {
      const status = statusParam(url.searchParams.get('status'))
      const nodes = await service.listNodes(status)
      sendJson(res, 200, {
        ok: true,
        nodes: nodes.map((node) => ({
          id: node.id,
          title: publicTitle(node.title),
          status: node.status,
          created_at: node.created_at,
        })),
      })
      return
    }
    if (method === 'POST') {
      const body = asRecord(await readJson(req)) ?? {}
      const node = await service.createNode({
        title: stringField(body, 'title') ?? '',
        description: stringField(body, 'description') ?? '',
        created_by: stringField(body, 'created_by'),
        derived_from: stringField(body, 'derived_from') ?? null,
      })
      sendJson(res, 200, { ok: true, node: publicNode(node) })
      return
    }
  }

  // Node detail and actions.
  if (parts[1] === 'common-sense') {
    if (method === 'GET' && parts.length === 2) {
      sendJson(res, 200, { ok: true, commonSense: await service.commonSense() })
      return
    }
    if (method === 'POST' && parts.length === 2) {
      const body = asRecord(await readJson(req)) ?? {}
      const list = Array.isArray(body.entries) ? body.entries : []
      const input: CommonSenseInputEntry[] = []
      for (const item of list) {
        const record = asRecord(item)
        if (record === undefined) continue
        const text = stringField(record, 'text') ?? ''
        const id = stringField(record, 'id')
        const imagesRaw = Array.isArray(record.images) ? record.images : []
        const images = imagesRaw.flatMap((image) => {
          const entry = asRecord(image)
          if (entry === undefined) return []
          const file = stringField(entry, 'file')
          if (file === undefined) return []
          const name = stringField(entry, 'name')
          return [{ file, ...name === undefined ? {} : { name } }]
        })
        input.push({ text, ...id === undefined ? {} : { id }, ...images.length === 0 ? {} : { images } })
      }
      sendJson(res, 200, { ok: true, commonSense: await service.saveCommonSense(input) })
      return
    }
    if (method === 'GET' && parts[2] === 'images' && parts[3] !== undefined) {
      const file = decodeURIComponent(parts[3])
      const bytes = await service.commonSenseImage(file)
      if (bytes === undefined) {
        sendJson(res, 404, { ok: false, error: { code: 'image-missing', message: '图片不存在。' } })
        return
      }
      const lower = file.toLowerCase()
      const type = lower.endsWith('.jpg') || lower.endsWith('.jpeg') ? 'image/jpeg'
        : lower.endsWith('.webp') ? 'image/webp'
        : lower.endsWith('.gif') ? 'image/gif'
        : 'image/png'
      res.writeHead(200, { 'content-type': type })
      res.end(bytes)
      return
    }
    if (method === 'POST' && parts.length === 4 && parts[3] === 'images') {
      const body = asRecord(await readJson(req)) ?? {}
      const data = stringField(body, 'data') ?? ''
      const caption = stringField(body, 'caption') ?? '常识截图'
      const name = stringField(body, 'name')
      const saved = await service.addCommonSenseImage(parts[2] as string, {
        data,
        caption,
        ...name === undefined ? {} : { name },
      })
      sendJson(res, 200, { ok: true, commonSense: saved })
      return
    }
    if (method === 'DELETE' && parts.length === 4 && parts[3] === 'images') {
      const file = url.searchParams.get('file') ?? ''
      sendJson(res, 200, { ok: true, commonSense: await service.deleteCommonSenseImage(parts[2] as string, file) })
      return
    }
    sendJson(res, 404, { ok: false, error: { code: 'route-missing', message: '没有这个常识区接口。' } })
    return
  }

  if (method === 'POST' && parts[1] === 'nodes' && parts[2] === 'import') {
    const body = asRecord(await readJson(req)) ?? {}
    const dir = stringField(body, 'dir') ?? ''
    sendJson(res, 200, { ok: true, node: publicNode(await service.importNode(dir)) })
    return
  }

  if (method === 'POST' && parts[1] === 'paths' && parts[2] === 'import') {
    const body = asRecord(await readJson(req)) ?? {}
    const dir = stringField(body, 'dir') ?? ''
    sendJson(res, 200, { ok: true, path: publicPath(await service.importPath(dir)) })
    return
  }

  if (parts[1] === 'nodes' && parts.length >= 3) {
    const id = at(2)
    if (method === 'GET' && parts.length === 3) {
      const detail = await service.nodeDetail(id)
      sendJson(res, 200, { ...detail, ok: true, node: publicNode(detail.node) })
      return
    }
    if (method === 'PATCH' && parts.length === 3) {
      const body = asRecord(await readJson(req)) ?? {}
      const operator = operatorOf(req, url)
      const aiNotes = stringField(body, 'ai_notes')
      const title = stringField(body, 'title')
      const description = stringField(body, 'description')
      // The human owns the prose. An agent may refine ai_notes, never rewrite the description.
      if (operator === 'ai' && (title !== undefined || description !== undefined)) {
        throw new GraphError('human-field-readonly', 'description / title 只能由人修改；AI 只能写 ai_notes。', 403)
      }
      let node = aiNotes === undefined ? undefined : await service.updateNodeAi(id, aiNotes)
      if (title !== undefined || description !== undefined) {
        node = await service.updateNode(id, {
          ...title === undefined ? {} : { title },
          ...description === undefined ? {} : { description },
        }, operator)
      }
      // An empty patch stays a no-op read for older clients that send `{}`.
      const resolved = node ?? (await service.nodeDetail(id)).node
      sendJson(res, 200, { ok: true, node: publicNode(resolved) })
      return
    }
    if (method === 'POST' && parts[3] === 'ai-notes') {
      const body = asRecord(await readJson(req)) ?? {}
      const notes = stringField(body, 'ai_notes') ?? stringField(body, 'notes') ?? ''
      sendJson(res, 200, { ok: true, node: publicNode(await service.updateNodeAi(id, notes)) })
      return
    }
    if (method === 'POST' && parts[3] === 'copy') {
      sendJson(res, 200, { ok: true, node: publicNode(await service.copyNode(id, operatorOf(req, url))) })
      return
    }
    if (method === 'POST' && parts[3] === 'export') {
      const body = asRecord(await readJson(req)) ?? {}
      sendJson(res, 200, { ok: true, ...(await service.exportNode(id, stringField(body, 'dir') ?? '')) })
      return
    }
    if (method === 'POST' && parts[3] === 'favorite') {
      const body = asRecord(await readJson(req)) ?? {}
      sendJson(res, 200, { ok: true, node: publicNode(await service.setNodeFavorite(id, body.favorite === true)) })
      return
    }
    if (method === 'PATCH' && parts[3] === 'screenshots' && parts.length === 5) {
      const body = asRecord(await readJson(req)) ?? {}
      const source = screenshotSource(stringField(body, 'source'))
      const node = await service.updateScreenshot(id, at(4), {
        ...stringField(body, 'name') === undefined ? {} : { name: stringField(body, 'name') as string },
        ...stringField(body, 'caption') === undefined ? {} : { caption: stringField(body, 'caption') as string },
        ...source === undefined ? {} : { source },
      })
      sendJson(res, 200, { ok: true, node: publicNode(node) })
      return
    }
    if (method === 'POST' && parts[3] === 'delete') {
      sendJson(res, 200, { ok: true, node: publicNode(await service.deleteNode(id, operatorOf(req, url))) })
      return
    }
    if (method === 'POST' && parts[3] === 'restore') {
      sendJson(res, 200, { ok: true, node: publicNode(await service.restoreNode(id, operatorOf(req, url))) })
      return
    }
    if (method === 'POST' && parts[3] === 'screenshots') {
      const body = asRecord(await readJson(req)) ?? {}
      const source = screenshotSource(stringField(body, 'source'))
      const node = await service.addScreenshot(id, {
        caption: stringField(body, 'caption') ?? '',
        data: stringField(body, 'data') ?? '',
        media_type: stringField(body, 'media_type'),
        file_name: stringField(body, 'file_name'),
        ...source === undefined ? {} : { source },
      })
      sendJson(res, 200, { ok: true, node: publicNode(node) })
      return
    }
    if (method === 'DELETE' && parts[3] === 'screenshots' && parts.length >= 5) {
      sendJson(res, 200, { ok: true, node: publicNode(await service.deleteScreenshot(id, at(4))) })
      return
    }
  }

  // Edges.
  if (parts[1] === 'edges') {
    if (method === 'POST' && parts[2] === 'validate') {
      const body = asRecord(await readJson(req)) ?? {}
      await service.validateEdge(stringField(body, 'from') ?? '', stringField(body, 'to') ?? '')
      sendJson(res, 200, { ok: true })
      return
    }
    if (method === 'POST') {
      const body = asRecord(await readJson(req)) ?? {}
      const edge = await service.addEdge(stringField(body, 'from') ?? '', stringField(body, 'to') ?? '')
      sendJson(res, 200, { ok: true, edge })
      return
    }
    if (method === 'DELETE') {
      const body = asRecord(await readJson(req)) ?? {}
      await service.deleteEdge(stringField(body, 'from') ?? '', stringField(body, 'to') ?? '', operatorOf(req, url))
      sendJson(res, 200, { ok: true })
      return
    }
  }

  // Paths / index.
  if (parts[1] === 'paths' && parts.length === 2) {
    if (method === 'GET') {
      sendJson(res, 200, { ok: true, paths: await service.paths() })
      return
    }
    if (method === 'POST') {
      const body = asRecord(await readJson(req)) ?? {}
      const sequence = Array.isArray(body.node_sequence)
        ? body.node_sequence.filter((item): item is string => typeof item === 'string')
        : []
      const path = await service.createPath({
        name: stringField(body, 'name') ?? '',
        summary: stringField(body, 'summary') ?? '',
        node_sequence: sequence,
        graph: pathGraphFromBody(body),
        operator: operatorOf(req, url),
      })
      sendJson(res, 200, { ok: true, path })
      return
    }
  }

  if (parts[1] === 'paths' && parts.length >= 3) {
    const id = at(2)
    if (method === 'GET' && parts.length === 3) {
      const detail = await service.pathDetail(id)
      sendJson(res, 200, { ...detail, ok: true, path: publicPath(detail.path) })
      return
    }
    if (method === 'GET' && parts[3] === 'check') {
      sendJson(res, 200, { ok: true, check: await service.checkPath(id) })
      return
    }
    if (method === 'GET' && parts[3] === 'view') {
      sendJson(res, 200, { ok: true, view: await service.pathView(id) })
      return
    }
    if (method === 'DELETE') {
      await service.deletePath(id)
      sendJson(res, 200, { ok: true, deleted: id })
      return
    }
    if (method === 'POST' && parts[3] === 'favorite') {
      const body = asRecord(await readJson(req)) ?? {}
      sendJson(res, 200, { ok: true, path: publicPath(await service.setPathFavorite(id, body.favorite === true)) })
      return
    }
    if (method === 'POST' && parts[3] === 'copy') {
      sendJson(res, 200, { ok: true, path: publicPath(await service.copyPath(id, operatorOf(req, url))) })
      return
    }
    if (method === 'POST' && parts[3] === 'export') {
      const body = asRecord(await readJson(req)) ?? {}
      sendJson(res, 200, { ok: true, ...(await service.exportPath(id, stringField(body, 'dir') ?? '')) })
      return
    }
    if (method === 'PUT') {
      const body = asRecord(await readJson(req)) ?? {}
      const sequence = Array.isArray(body.node_sequence)
        ? body.node_sequence.filter((item): item is string => typeof item === 'string')
        : []
      const path = await service.updatePath({
        pathId: id,
        name: stringField(body, 'name') ?? '',
        summary: stringField(body, 'summary') ?? '',
        node_sequence: sequence,
        graph: pathGraphFromBody(body),
        operator: operatorOf(req, url),
      })
      sendJson(res, 200, { ok: true, path: publicPath(path) })
      return
    }
    if (method === 'POST' && parts[3] === 'run') {
      sendJson(res, 200, { ok: true, view: await service.startRun(id) })
      return
    }
  }

  // Runs.
  if (parts[1] === 'runs' && parts.length >= 3) {
    const id = at(2)
    if (method === 'GET' && parts.length === 3) {
      sendJson(res, 200, { ok: true, view: await service.runView(id) })
      return
    }
    if (method === 'POST' && parts[3] === 'judge') {
      const body = asRecord(await readJson(req)) ?? {}
      const verdict = body.verdict
      if (verdict !== 'met' && verdict !== 'unmet' && verdict !== 'skipped') {
        throw new GraphError('judge-invalid', '判定只能是 met / unmet / skipped。', 400)
      }
      const view = await service.judge(id, stringField(body, 'node_id') ?? '', verdict, stringField(body, 'reason') ?? '')
      sendJson(res, 200, { ok: true, view })
      return
    }
    if (method === 'POST' && parts[3] === 'judge-llm') {
      const body = asRecord(await readJson(req)) ?? {}
      const view = await service.judgeWithLlm(id, stringField(body, 'node_id') ?? '', stringField(body, 'evidence') ?? '')
      sendJson(res, 200, { ok: true, view })
      return
    }
    if (method === 'POST' && parts[3] === 'skip') {
      const body = asRecord(await readJson(req)) ?? {}
      const view = await service.skip(id, stringField(body, 'node_id') ?? '', stringField(body, 'reason') ?? '人工标记跳过')
      sendJson(res, 200, { ok: true, view })
      return
    }
    if (method === 'POST' && parts[3] === 'reset') {
      const body = asRecord(await readJson(req)) ?? {}
      const view = await service.reset(id, stringField(body, 'node_id') ?? '')
      sendJson(res, 200, { ok: true, view })
      return
    }
  }

  // Reuse is a logged decision, not a graph mutation.
  if (method === 'POST' && parts[1] === 'reuse') {
    const body = asRecord(await readJson(req)) ?? {}
    await service.logReuse(
      stringField(body, 'node_id') ?? '',
      stringField(body, 'query') ?? '',
      typeof body.similarity === 'number' ? body.similarity : null,
      operatorOf(req, url),
    )
    sendJson(res, 200, { ok: true })
    return
  }

  // Screenshot bytes. Node id and file name are decoded one segment at a time.
  if ((method === 'GET' || method === 'HEAD') && parts[1] === 'screenshots' && parts.length >= 4) {
    const nodeId = at(2)
    const file = parts.slice(3).map((part) => decodeURIComponent(part)).join('/')
    const path = new KnowledgeGraphStore(dir).screenshotPath(nodeId, file)
    if (path === undefined) {
      sendJson(res, 404, { ok: false, error: { code: 'screenshot-missing', message: '截图不存在。' } })
      return
    }
    let bytes: Buffer
    try {
      bytes = await readFile(path)
    } catch {
      sendJson(res, 404, { ok: false, error: { code: 'screenshot-missing', message: '截图不存在。' } })
      return
    }
    res.writeHead(200, {
      'content-type': mimeOf(file),
      'cache-control': 'no-store',
      'content-length': bytes.length,
    })
    res.end(method === 'HEAD' ? undefined : bytes)
    return
  }

  sendJson(res, 404, { ok: false, error: { code: 'not-found', message: '没有这个接口。' } })
}

/** Read one JSON body, 400 for invalid JSON. */
async function readJson(req: IncomingMessage): Promise<unknown> {
  const bytes = await readBody(req)
  if (bytes.length === 0) return undefined
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown
  } catch {
    throw new GraphError('invalid-json', '请求体不是合法 JSON。', 400)
  }
}

/** Read the body with a hard cap. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > BODY_LIMIT) {
        reject(new GraphError('too-large', '请求体太大（上限 12MB）。', 413))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function stringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key]
  return typeof value === 'string' ? value : undefined
}

/** Screenshot shelf from a request body; absent/blank means "keep the current one". */
function screenshotSource(value: string | undefined): 'human' | 'ai' | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  if (trimmed === 'human' || trimmed === 'ai') return trimmed
  throw new GraphError('screenshot-source-invalid', 'source 只能是 human 或 ai。', 400)
}

/** The optional graph form of a saved path; absent keeps the legacy linear shape. */
function pathGraphFromBody(body: Record<string, unknown>): PathGraph | undefined {
  const raw = asRecord(body.graph)
  if (raw === undefined) return undefined
  const nodes: PathGraphNode[] = []
  if (Array.isArray(raw.nodes)) {
    for (const item of raw.nodes) {
      const entry = asRecord(item)
      if (entry === undefined) continue
      const key = stringField(entry, 'key')
      const nodeId = stringField(entry, 'node_id')
      if (key !== undefined && nodeId !== undefined) nodes.push({ key, node_id: nodeId })
    }
  }
  const edges: PathGraphEdge[] = []
  if (Array.isArray(raw.edges)) {
    for (const item of raw.edges) {
      const entry = asRecord(item)
      if (entry === undefined) continue
      const from = stringField(entry, 'from')
      const to = stringField(entry, 'to')
      if (from !== undefined && to !== undefined) edges.push({ from, to })
    }
  }
  return { nodes, edges }
}

/** One node status from the query string; anything else means "no filter". */
function statusParam(value: string | null): NodeStatus | undefined {
  if (value === null) return undefined
  const trimmed = value.trim()
  return (NODE_STATUSES as readonly string[]).includes(trimmed) ? trimmed as NodeStatus : undefined
}

/** A node title for list rows: blank reads 未命名节点. */
function publicTitle(title: string): string {
  const trimmed = title.trim()
  return trimmed === '' ? '未命名节点' : trimmed
}

function numberParam(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function operatorOf(req: IncomingMessage, url: URL): string {
  const header = req.headers['x-dsh-agi-operator']
  if (typeof header === 'string' && header.trim() !== '') return header.trim().slice(0, 80)
  return (url.searchParams.get('operator') ?? 'human').slice(0, 80)
}

/** Drop the cached vector from a node response; the editor never renders it. */
function publicNode(node: GraphNode): Omit<GraphNode, 'embedding'> {
  const { embedding: _embedding, ...rest } = node
  return rest
}

/** Drop the cached vector from a path response. */
function publicPath(path: GraphPath): Omit<GraphPath, 'embedding'> {
  const { embedding: _embedding, ...rest } = path
  return rest
}

function mimeOf(file: string): string {
  const extension = file.toLowerCase().split('.').pop() ?? ''
  if (extension === 'png') return 'image/png'
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg'
  if (extension === 'webp') return 'image/webp'
  if (extension === 'gif') return 'image/gif'
  return 'application/octet-stream'
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}
