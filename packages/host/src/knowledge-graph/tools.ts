/**
 * The experience-library tools the input box can drive.
 *
 * The installable host cannot resolve `@deepseek-ai/dsh-tools` — the DSH runtime keeps that
 * package outside the profile — so these definitions are plain registry-compatible objects
 * instead of `defineTool()` wrappers. `parameters` is a JSON Schema and every result renders
 * as one text block, which is exactly the shape the tool registry validates on register.
 * @module knowledge-graph/tools
 */

import { readFile } from 'node:fs/promises'
import { GraphError, type GraphNode, type GraphPath } from './model.ts'
import { KnowledgeGraphService } from './service.ts'

/** One text block as the tool registry renders it. */
interface TextBlock { readonly type: 'text'; readonly text: string }

function block(text: string): TextBlock { return { type: 'text', text } }

/** JSON-safe copy so a tool result satisfies the registry's value contract. */
function json(value: unknown): unknown { return JSON.parse(JSON.stringify(value)) }

/** Raw model-supplied arguments. */
interface ToolArgs { readonly [key: string]: unknown }

function asString(args: ToolArgs, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' ? value : undefined
}

function asStringArray(args: ToolArgs, key: string): string[] {
  const value = args[key]
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function asBoolean(args: ToolArgs, key: string): boolean | undefined {
  const value = args[key]
  return typeof value === 'boolean' ? value : undefined
}

/** One `[from, to]` pair of 0-based positions in `steps`. */
type EdgePair = readonly [number, number]

/**
 * Read the optional `edges` argument used by the path tools.
 *
 * Each entry is `[from, to]`, both 0-based indices into `steps` (the instance list), so the same
 * node id may appear at several positions. Omitting `edges` builds one linear chain `0→1→2…`;
 * an explicit list is rejected when an index is out of range or points at itself.
 * @param args - raw model-supplied arguments.
 * @param stepCount - how many instances `steps` declares.
 * @returns validated instance pairs, in the caller's order.
 */
function asEdgePairs(args: ToolArgs, stepCount: number): readonly EdgePair[] {
  const raw = args.edges
  if (raw === undefined || raw === null) {
    return Array.from({ length: Math.max(stepCount - 1, 0) }, (_, index): EdgePair => [index, index + 1])
  }
  if (!Array.isArray(raw)) throw new GraphError('edges-invalid', 'edges 必须是 [from, to] 下标对的数组。', 400)
  const pairs: EdgePair[] = []
  raw.forEach((item, index) => {
    if (!Array.isArray(item) || item.length !== 2) {
      throw new GraphError('edges-invalid', `edges 第 ${index + 1} 项不是 [from, to] 两个下标。`, 400)
    }
    const from = item[0]
    const to = item[1]
    if (typeof from !== 'number' || typeof to !== 'number' || !Number.isInteger(from) || !Number.isInteger(to)) {
      throw new GraphError('edges-invalid', `edges 第 ${index + 1} 项的下标必须是整数。`, 400)
    }
    if (from < 0 || from >= stepCount || to < 0 || to >= stepCount) {
      throw new GraphError(
        'edge-out-of-range',
        `edges 第 ${index + 1} 项 [${from}, ${to}] 越界：下标必须落在 0..${stepCount - 1}（对应 steps 的位置）。`,
        400,
      )
    }
    if (from === to) {
      throw new GraphError('edge-self-loop', `edges 第 ${index + 1} 项 [${from}, ${from}] 是自己连自己，路径里不存在这一步。`, 400)
    }
    pairs.push([from, to])
  })
  return pairs
}

/**
 * Reject instance edges that close a loop.
 *
 * Repetition is not a cycle: the same node id at two positions is just two instances. Only an
 * edge path that actually leads back does, and a saved flow has to stay a DAG.
 * @param pairs - validated instance pairs.
 * @param stepCount - instance count.
 * @throws GraphError when Kahn's algorithm cannot visit every instance.
 */
function assertNoCycle(pairs: readonly EdgePair[], stepCount: number): void {
  const outgoing = new Map<number, number[]>()
  const indegree = new Map<number, number>()
  for (let index = 0; index < stepCount; index += 1) {
    outgoing.set(index, [])
    indegree.set(index, 0)
  }
  for (const [from, to] of pairs) {
    outgoing.get(from)?.push(to)
    indegree.set(to, (indegree.get(to) ?? 0) + 1)
  }
  const queue = [...indegree.keys()].filter(key => (indegree.get(key) ?? 0) === 0)
  const visited = new Set<number>()
  while (queue.length > 0) {
    const key = queue.shift() as number
    if (visited.has(key)) continue
    visited.add(key)
    for (const next of outgoing.get(key) ?? []) {
      indegree.set(next, (indegree.get(next) ?? 1) - 1)
      if ((indegree.get(next) ?? 0) === 0) queue.push(next)
    }
  }
  if (visited.size === stepCount) return
  const loop = [...Array(stepCount).keys()].filter(key => !visited.has(key)).map(key => key + 1)
  throw new GraphError(
    'path-cycle',
    `路径里有环：第 ${loop.join('、')} 步沿着 edges 能绕回来。分支路径必须是有向无环图；删掉绕回来的边再保存。`,
    400,
  )
}

/** One JSON-Schema object parameter block. */
function schema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false }
}

/** Build one registry-compatible tool definition. */
function graphTool(options: {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly execute: (args: ToolArgs) => Promise<unknown>
  readonly isConcurrencySafe?: () => boolean
}): unknown {
  return {
    name: options.name,
    description: options.description,
    parameters: options.parameters,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: unknown, value: unknown) => [block(JSON.stringify(value, null, 2))],
    },
    ...options.isConcurrencySafe === undefined ? {} : { isConcurrencySafe: options.isConcurrencySafe },
    async execute(args: ToolArgs) { return json(await options.execute(args)) },
  }
}

/** Minimal tools surface the Host context carries. */
export interface GraphToolContext {
  readonly tools: { register(tool: unknown): void }
}

/** Compact node row for search results. */
function nodeRow(node: GraphNode): Record<string, string> {
  return {
    node_id: node.id,
    title: node.title,
    status: node.status,
    description: node.description.length > 160 ? `${node.description.slice(0, 160)}…` : node.description,
  }
}

/**
 * Register the library tools on the Host context.
 * @param ctx - Host context with the tool registry.
 * @param resolve - returns the service bound to the active library directory (the editor can
 *   switch that directory at runtime, so the service is resolved per call, not cached).
 */
export function registerGraphTools(ctx: GraphToolContext, resolve: () => KnowledgeGraphService): void {
  ctx.tools.register(graphTool({
    name: 'knowledge_graph_search',
    description:
      'Search the local experience library for existing nodes and saved paths. Call this first for any '
      + 'create-node or create-path request: show the candidates to the operator and let THEM decide whether '
      + 'an existing node is a reuse or whether a new one is needed. Never pick a similar node yourself and '
      + 'treat it as the same action — the operator always decides. Returns node ids (pass them to the other '
      + 'tools) and path summaries.',
    parameters: schema({
      query: { type: 'string', description: 'Keywords or a one-sentence description of the action or flow.' },
      kind: { type: 'string', enum: ['node', 'path', 'both'], description: 'What to search. Default: both.' },
    }, ['query']),
    isConcurrencySafe: () => true,
    async execute(args) {
      const service = resolve()
      const query = asString(args, 'query') ?? ''
      const kindRaw = asString(args, 'kind')
      const kind = kindRaw === 'node' || kindRaw === 'path' ? kindRaw : 'both'
      const result: Record<string, unknown> = {}
      if (kind !== 'path') {
        const nodes = await service.searchNodes(query, 0)
        const seen = new Set<string>()
        const rows: Record<string, string>[] = []
        const addNode = (node: GraphNode): void => {
          if (seen.has(node.id)) return
          seen.add(node.id)
          rows.push(nodeRow(node))
        }
        for (const candidate of nodes.candidates) addNode(candidate.node)
        for (const candidate of nodes.keyword) addNode(candidate.node)
        result.nodes = rows.slice(0, 8)
      }
      if (kind !== 'node') {
        const paths = await service.searchPaths(query, 0)
        const seen = new Set<string>()
        const rows: Record<string, unknown>[] = []
        type PathCandidate = { readonly path: GraphPath }
        const addPath = (candidate: PathCandidate): void => {
          if (seen.has(candidate.path.id)) return
          seen.add(candidate.path.id)
          const stepCount = candidate.path.node_sequence.length
          rows.push({
            path_id: candidate.path.id,
            name: candidate.path.name,
            summary: candidate.path.summary,
            steps: stepCount,
            node_count: stepCount,
            // A path saved without its own graph is one linear chain.
            edge_count: candidate.path.graph?.edges.length ?? Math.max(stepCount - 1, 0),
          })
        }
        for (const candidate of paths.candidates) addPath(candidate)
        for (const candidate of paths.keyword) addPath(candidate)
        result.paths = rows.slice(0, 6)
      }
      return result
    },
  }))

  ctx.tools.register(graphTool({
    name: 'knowledge_graph_get_node',
    description:
      'Read one library node: title, human-written description, agent-maintained ai_notes, status, '
      + 'screenshot captions with their source, and the saved paths that reference it. Use it before '
      + 'editing a node or when the operator asks what a node contains.',
    parameters: schema({
      node_id: { type: 'string', description: 'Node id returned by knowledge_graph_search.' },
    }, ['node_id']),
    isConcurrencySafe: () => true,
    async execute(args) {
      const service = resolve()
      const nodeId = asString(args, 'node_id') ?? ''
      const detail = await service.nodeDetail(nodeId)
      return {
        node_id: detail.node.id,
        title: detail.node.title,
        description: detail.node.description,
        ai_notes: detail.node.ai_notes ?? '',
        ai_updated_at: detail.node.ai_updated_at ?? '',
        status: detail.node.status,
        screenshots: detail.screenshots.map(shot => ({ caption: shot.caption, source: shot.source })),
        used_by_paths: detail.paths.map(path => ({ path_id: path.id, name: path.name })),
      }
    },
  }))

  ctx.tools.register(graphTool({
    name: 'knowledge_graph_create_node',
    description:
      'Create one node in the experience library. Before calling it, ask the operator for the title and a '
      + 'short description (they know the real action; you do not). If the operator only said "帮我创建一个节点，内容：xxx", '
      + 'confirm the title in one short question, and tell them screenshots can be added later in the library editor. '
      + 'This tool searches for a near-duplicate first and refuses to create when one exists unless '
      + 'confirm_duplicate=true. The operator decides: list the candidates and ask clearly whether to reuse '
      + 'an existing node or create a new one; call with confirm_duplicate=true only after they explicitly '
      + 'said to create a new node.',
    parameters: schema({
      title: { type: 'string', description: 'Short action title, e.g. 进入天翼云电脑.' },
      description: { type: 'string', description: 'What the operator does in this step, in their own words.' },
      confirm_duplicate: { type: 'boolean', description: 'Set true only after the operator confirmed they still want a new node although a similar one exists.' },
      screenshot_paths: { type: 'array', items: { type: 'string' }, description: 'Optional local image paths the operator attached this turn (the screenshot notice lists them). They are stored as this node\'s screenshots right away.' },
      screenshot_captions: { type: 'array', items: { type: 'string' }, description: 'One short caption per screenshot_paths entry, same order. The caption is what the judge reads later.' },
    }, ['title', 'description']),
    isConcurrencySafe: () => false,
    async execute(args) {
      const service = resolve()
      const title = (asString(args, 'title') ?? '').trim()
      if (title === '') throw new GraphError('title-required', '节点标题不能为空。', 400)
      const similar = await service.searchNodes(title, 0)
      const candidates = new Map<string, GraphNode>()
      const collect = (node: GraphNode): void => {
        if (node.title.trim() === title) candidates.set(node.id, node)
      }
      for (const candidate of similar.candidates) collect(candidate.node)
      for (const candidate of similar.keyword) collect(candidate.node)
      const existing = [...candidates.values()].slice(0, 5)
      if (existing.length > 0 && asBoolean(args, 'confirm_duplicate') !== true) {
        return {
          created: false,
          reason: '同名或高度相似的节点已存在，先与操作者确认是复用还是仍要新建。',
          existing_nodes: existing.map(nodeRow),
        }
      }
      const node = await service.createNode({
        title,
        description: asString(args, 'description') ?? '',
        created_by: 'ball',
      })
      // Attached screenshots belong to the node from the first write: an operator who sends a
      // picture while saying "创建这个节点" should not have to open the editor again.
      const stored: Record<string, string>[] = []
      const failed: string[] = []
      const screenshotPaths = asStringArray(args, 'screenshot_paths')
      const captions = asStringArray(args, 'screenshot_captions')
      for (let index = 0; index < screenshotPaths.length; index += 1) {
        const file = screenshotPaths[index]
        if (file === undefined || file.trim() === '') continue
        const caption = (captions[index] ?? '').trim() || '用户提供的截图'
        try {
          const bytes = await readFile(file)
          await service.addScreenshot(node.id, { caption, data: bytes.toString('base64'), file_name: file })
          stored.push({ caption })
        } catch (error) {
          failed.push(`${file}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      return {
        created: true,
        node_id: node.id,
        title: node.title,
        screenshots: stored,
        screenshot_errors: failed,
        next_step: '告诉用户节点已创建；若还有截图可随时在经验库补，或让他把图片发到输入框。',
      }
    },
  }))

  ctx.tools.register(graphTool({
    name: 'knowledge_graph_create_path',
    description:
      'Save one flow into the experience library. CALL ONLY AFTER ALL OF THESE HAPPENED: '
      + '(1) you told the operator "路径创建较复杂，请务必打开经验库核对每个细节" when the request is a new path; '
      + '(2) you matched every step they named against knowledge_graph_search and created missing nodes with '
      + 'knowledge_graph_create_node; (3) you listed the final ordered steps (and branches) back to the operator '
      + 'and they confirmed each one (set confirm_checked=true only then). The same node may appear more than once: '
      + 'different positions are different instances, and a repeated node is not a cycle by itself - only edges '
      + 'that actually lead back form one, and a cycle is rejected. For a branching flow pass steps (the instance '
      + 'list) plus optional edges ([from, to] pairs of 0-based positions in steps); omit edges for one straight '
      + 'line. Out-of-range indices, self edges, cycles and missing nodes are rejected, and the saved path is '
      + 'checked afterwards.',
    parameters: schema({
      name: { type: 'string', description: 'Path name the operator will recognize, e.g. 发福利积分.' },
      summary: { type: 'string', description: 'One sentence: what this flow does, for whom, and when.' },
      steps: { type: 'array', items: { type: 'string' }, description: 'Node instances in flow order (node ids from knowledge_graph_search / knowledge_graph_create_node). The same node id may repeat at different positions.' },
      edges: {
        type: 'array',
        items: { type: 'array', items: { type: 'integer' }, minItems: 2, maxItems: 2 },
        description: 'Optional [from, to] pairs of 0-based positions in steps. Omit for one linear chain 0→1→2…; pass only when the flow branches or merges.',
      },
      confirm_checked: { type: 'boolean', description: 'True only after the operator confirmed the ordered list.' },
    }, ['name', 'summary', 'steps']),
    isConcurrencySafe: () => false,
    async execute(args) {
      const service = resolve()
      const steps = asStringArray(args, 'steps').filter(step => step.trim() !== '')
      if (steps.length === 0) throw new GraphError('path-empty', '路径至少需要一个节点。', 400)
      // The flow is a DAG of instances, not a repeat-free list: `edges` decides what follows
      // what, and only a real loop is a cycle.
      const pairs = asEdgePairs(args, steps.length)
      assertNoCycle(pairs, steps.length)
      for (const id of steps) {
        const detail = await service.nodeDetail(id).catch(() => undefined)
        if (detail === undefined) throw new GraphError('node-missing', `节点 ${id} 不存在，先用 knowledge_graph_search 找它。`, 404)
        if (detail.node.status === 'deleted') throw new GraphError('node-removed', `节点「${detail.node.title}」已删除，不能放入路径。`, 409)
      }
      const graph = {
        nodes: steps.map((id, index) => ({ key: `n${index}`, node_id: id })),
        edges: pairs.map(([from, to]) => ({ from: `n${from}`, to: `n${to}` })),
      }
      if (asBoolean(args, 'confirm_checked') !== true) {
        const review: Record<string, unknown>[] = []
        for (let index = 0; index < steps.length; index += 1) {
          const id = steps[index] as string
          const detail = await service.nodeDetail(id)
          review.push({ order: index + 1, node_id: id, title: detail.node.title })
        }
        return {
          created: false,
          reason: '每个引入路径的节点都要操作者确认后才能写入。把下面的顺序清单和连线原样给操作者核对，确认后再用 confirm_checked=true 调用。',
          edges: pairs.map(([from, to]) => `${from + 1} → ${to + 1}`),
          review,
        }
      }
      const path = await service.createPath({
        name: asString(args, 'name') ?? '',
        summary: asString(args, 'summary') ?? '',
        node_sequence: steps,
        graph,
        operator: 'ball',
      })
      const check = await service.checkPath(path.id)
      return { created: true, path_id: path.id, name: path.name, step_count: steps.length, edge_count: pairs.length, check }
    },
  }))

  ctx.tools.register(graphTool({
    name: 'knowledge_graph_check_path',
    description:
      'Run the static check on one saved path: every step exists, the flow graph has no cycle, start/end match, '
      + 'and required fields are filled. It never touches the desktop. Use it after creating or editing a path, '
      + 'and report any finding back to the operator.',
    parameters: schema({
      path_id: { type: 'string', description: 'Path id returned by knowledge_graph_search or create_path.' },
    }, ['path_id']),
    isConcurrencySafe: () => true,
    async execute(args) {
      return await resolve().checkPath(asString(args, 'path_id') ?? '')
    },
  }))

  ctx.tools.register(graphTool({
    name: 'knowledge_graph_learn_node',
    description:
      'Update the agent-maintained part of one node after a real run: ai_notes and/or AI screenshots. '
      + 'The operator\'s title/description and their screenshots are read-only here. Call it only when you '
      + 'actually learned something reliable this run (a pit, a better prompt, the target screen you matched); '
      + 'skip when the node is already complete, and never rewrite the same notes again. Keep ai_notes short: '
      + 'at most 3 bullet points under 600 characters, no essays. The operator reads their own text first as '
      + 'the base, then follows your notes as the refined guidance.',
    parameters: schema({
      node_id: { type: 'string', description: 'Node id.' },
      ai_notes: { type: 'string', description: 'New supplement as short bullet points (≤600 chars). Omit when only adding a screenshot.' },
      screenshot_paths: { type: 'array', items: { type: 'string' }, description: 'Local image paths you matched to this step this run.' },
      screenshot_captions: { type: 'array', items: { type: 'string' }, description: 'One caption per screenshot, same order.' },
    }, ['node_id']),
    isConcurrencySafe: () => false,
    async execute(args) {
      const service = resolve()
      const nodeId = asString(args, 'node_id') ?? ''
      const notes = (asString(args, 'ai_notes') ?? '').trim()
      const paths = asStringArray(args, 'screenshot_paths')
      const captions = asStringArray(args, 'screenshot_captions')
      if (notes === '' && paths.length === 0) {
        return { updated: false, reason: '没有新的内容可写；不要为了更新而更新。' }
      }
      if (notes !== '' && notes.length > 600) {
        throw new GraphError('ai-notes-too-long', 'AI 补充太长：压缩到 600 字以内（最多 3 条要点）。', 400)
      }
      const detail = await service.nodeDetail(nodeId)
      if (notes !== '' && notes !== (detail.node.ai_notes ?? '')) {
        await service.updateNodeAi(nodeId, notes)
      }
      const stored: Record<string, string>[] = []
      const failed: string[] = []
      for (let index = 0; index < paths.length; index += 1) {
        const file = paths[index]
        if (file === undefined || file.trim() === '') continue
        const caption = (captions[index] ?? '').trim() || 'AI 匹配到的目标截图'
        try {
          const bytes = await readFile(file)
          await service.addScreenshot(nodeId, { caption, data: bytes.toString('base64'), file_name: file, source: 'ai' })
          stored.push({ caption, source: 'ai' })
        } catch (error) {
          failed.push(`${file}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      return {
        updated: notes !== '' || stored.length > 0,
        ai_notes: notes,
        screenshots: stored,
        screenshot_errors: failed,
      }
    },
  }))

  ctx.tools.register(graphTool({
    name: 'knowledge_graph_update_node',
    description:
      'Edit one node\'s title or description. Use it only for real corrections the operator asked for; '
      + 'keep their wording unless they ask for a rewrite. Pass only the fields that change.',
    parameters: schema({
      node_id: { type: 'string', description: 'Node id from knowledge_graph_search.' },
      title: { type: 'string', description: 'New title; omit to keep the current one.' },
      description: { type: 'string', description: 'New description; omit to keep the current one.' },
    }, ['node_id']),
    isConcurrencySafe: () => false,
    async execute(args) {
      const service = resolve()
      const nodeId = asString(args, 'node_id') ?? ''
      const title = asString(args, 'title')
      const description = asString(args, 'description')
      const node = await service.updateNode(nodeId, {
        ...title === undefined ? {} : { title },
        ...description === undefined ? {} : { description },
      }, 'ball')
      return { updated: true, node_id: node.id, title: node.title }
    },
  }))
}
