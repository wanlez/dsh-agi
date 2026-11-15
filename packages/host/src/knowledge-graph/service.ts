/**
 * Operations the editor and the execution panel call.
 *
 * Every mutation reloads the snapshot, applies one rule from `model.ts`, writes only
 * the files it touched, regenerates `index.json` and the manifest, and appends one
 * decision line when the action is one the user asked to audit.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  createExecutionRun,
  judgeStep,
  resetStep,
  skipStep,
  viewExecutionRun,
  type ExecutionRun,
  type RunView,
} from './execution.ts'
import {
  GraphError,
  isNodePresent,
  neighborhood,
  nodeSearchText,
  linearPathGraph,
  pathProblems,
  pathSearchText,
  validateNewEdge,
  type DecisionAction,
  type DecisionField,
  type DecisionLogEntry,
  type GraphEdge,
  type GraphNode,
  type GraphPath,
  type GraphSettings,
  type GraphSnapshot,
  type NodeScreenshot,
  type NodeStatus,
  type Neighborhood,
  type PathGraph,
} from './model.ts'
import { operationRows, type OperationRow } from './operations.ts'
import { checkPath as checkPathStatic, type PathCheckResult } from './path-check.ts'
import { pathView as resolvePathView, type PathView } from './path-view.ts'
import {
  cosineSimilarity,
  embedText,
  searchNodes,
  searchPaths,
  type GraphCompletion,
  type NodeSearchResult,
  type PathSearchResult,
} from './search.ts'
import {
  KnowledgeGraphStore,
  normalizeSettings,
  screenshotDigest,
  type GraphManifest,
} from './store.ts'

/** Optional query-string overrides for the keyword channel. */
export interface KeywordQueryOptions {
  /** Keyword candidates to return; clamped to 1..100. */
  readonly top?: number
  /** Lowest non-noise keyword score; clamped to 0..1. */
  readonly floor?: number
}

/**
 * Apply the per-request overrides on top of the saved settings. Omitted fields keep the
 * manifest value, so setting only the threshold never resets the keyword configuration.
 */
function searchSettings(
  settings: GraphSettings,
  threshold?: number,
  keyword?: KeywordQueryOptions,
): GraphSettings {
  return {
    ...settings,
    ...threshold === undefined || !Number.isFinite(threshold)
      ? {}
      : { searchThreshold: Math.min(1, Math.max(0, threshold)) },
    ...keyword?.top === undefined || !Number.isFinite(keyword.top)
      ? {}
      : { keywordTop: Math.min(100, Math.max(1, Math.trunc(keyword.top))) },
    ...keyword?.floor === undefined || !Number.isFinite(keyword.floor)
      ? {}
      : { keywordFloor: Math.min(1, Math.max(0, keyword.floor)) },
  }
}

/** Caller-supplied fields for a new node. */
export interface CreateNodeInput {
  readonly title: string
  readonly description: string
  readonly created_by?: string
  readonly derived_from?: string | null
}

/** Caller-supplied fields for a new path. */
export interface CreatePathInput {
  readonly name: string
  readonly summary: string
  readonly node_sequence: readonly string[]
  /** Graph form of the flow. When present it is the source of truth; the sequence is derived. */
  readonly graph?: PathGraph
  readonly operator?: string
}

/** Input for replacing one saved path's name, summary and sequence. */
export interface UpdatePathInput extends CreatePathInput {
  readonly pathId: string
}

/** One node row in the detail drawer. */
export interface EdgeRow {
  readonly from: string
  readonly to: string
  readonly from_title: string
  readonly to_title: string
  readonly created_at: string
}

/** Node detail, enough for the drawer without a second fetch. */
export interface NodeDetail {
  readonly node: GraphNode
  readonly incoming: readonly EdgeRow[]
  readonly outgoing: readonly EdgeRow[]
  readonly paths: readonly { readonly id: string; readonly name: string; readonly runnable: boolean }[]
  readonly screenshots: readonly {
    readonly id: string
    readonly name: string
    readonly caption: string
    readonly source: 'human' | 'ai'
    readonly url: string
  }[]
}

/** One path row in the index panel. */
export interface PathRow {
  readonly id: string
  readonly name: string
  readonly summary: string
  readonly start_node: string
  readonly end_node: string
  readonly start_title: string
  readonly end_title: string
  readonly node_titles: readonly string[]
  readonly node_count: number
  readonly runnable: boolean
  readonly problems: readonly string[]
  /** False when the operator removed it from the favorites list; the path itself still exists. */
  readonly favorite: boolean
}

/** The full path the executor loads after the operator confirms an index. */
export interface PathDetail {
  readonly path: GraphPath
  /** The owned flow graph; older paths are projected from their linear sequence. */
  readonly graph: PathGraph
  readonly nodes: readonly GraphNode[]
  readonly problems: readonly { readonly code: string; readonly message: string }[]
  /** A compact text rendering suitable for a model prompt. */
  readonly text: string
}

/** Library overview for the dashboard. */
export interface GraphStats {
  readonly dir: string
  readonly settings: GraphSettings
  readonly counts: {
    readonly nodes: number
    readonly active: number
    readonly deprecated: number
    readonly merged: number
    readonly deleted: number
    readonly edges: number
    readonly paths: number
    readonly runnable_paths: number
    readonly decisions: number
  }
  readonly nodes: readonly {
    readonly id: string
    readonly title: string
    readonly status: NodeStatus
    readonly in_degree: number
    readonly out_degree: number
  }[]
  readonly paths: readonly PathRow[]
  readonly recent_decisions: readonly DecisionLogEntry[]
}

/** One screenshot upload. */
export interface ScreenshotInput {
  readonly caption: string
  /** Optional display name; renaming never changes the content-hash file name. */
  readonly name?: string
  /** Raw base64 or a `data:image/...;base64,` URL. */
  readonly data: string
  readonly media_type?: string
  readonly file_name?: string
  /** Who supplied it; the agent's learning pass sets `ai`. Defaults to the operator. */
  readonly source?: 'human' | 'ai'
}

const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024

/** Require an existing, empty target folder for an export. */
async function assertEmptyDirectory(dir: string): Promise<void> {
  const info = await stat(dir).catch(() => undefined)
  if (info === undefined || !info.isDirectory()) {
    throw new GraphError('export-dir-invalid', '请选择一个已经存在的文件夹。', 400)
  }
  const entries = await readdir(dir)
  if (entries.length > 0) {
    throw new GraphError('export-dir-not-empty', '目标文件夹不是空的；请选择一个空文件夹。', 400)
  }
}

/** Read one JSON file, or undefined when it is missing or unparseable. */
async function readJsonFile(file: string): Promise<Record<string, unknown> | undefined> {
  const text = await readFile(file, 'utf8').catch(() => undefined)
  if (text === undefined) return undefined
  try {
    const parsed = JSON.parse(text) as unknown
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/** The service owns one library directory and one in-memory run table. */
export class KnowledgeGraphService {
  private readonly runs = new Map<string, ExecutionRun>()
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    readonly store: KnowledgeGraphStore,
    private readonly completion?: GraphCompletion,
  ) {}

  /** Serialize mutations; a failed operation releases the queue. */
  private locked<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task)
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  /** Load with settings. */
  private async loaded(): Promise<{ snapshot: GraphSnapshot; settings: GraphSettings; manifest: GraphManifest }> {
    const loaded = await this.store.load()
    return { snapshot: loaded.snapshot, settings: loaded.settings, manifest: loaded.manifest }
  }

  /** Log one decision line. */
  private async log(
    snapshot: GraphSnapshot,
    entry: {
      node_id: string
      action: DecisionAction
      candidates?: readonly { node_id: string; similarity: number | null }[]
      similarity?: number | null
      diff_summary?: string
      chosen?: string | null
      operator?: string
      fields?: readonly DecisionField[]
    },
  ): Promise<void> {
    const record: DecisionLogEntry = {
      node_id: entry.node_id,
      action: entry.action,
      candidates: entry.candidates ?? [],
      similarity: entry.similarity ?? null,
      diff_summary: entry.diff_summary ?? '',
      chosen: entry.chosen ?? null,
      operator: entry.operator ?? 'human',
      ts: new Date().toISOString(),
      ...entry.fields === undefined ? {} : { fields: entry.fields },
    }
    await this.store.appendDecision(record)
    ;(snapshot.decisions as DecisionLogEntry[]).push(record)
  }

  /** Settings plus read-only counts, no full graph. */
  async stats(): Promise<GraphStats> {
    const { snapshot, settings } = await this.loaded()
    const counts = { active: 0, deprecated: 0, merged: 0, deleted: 0 }
    for (const node of snapshot.nodes.values()) counts[node.status] += 1
    const inDegree = new Map<string, number>()
    const outDegree = new Map<string, number>()
    for (const edge of snapshot.edges) {
      outDegree.set(edge.from, (outDegree.get(edge.from) ?? 0) + 1)
      inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1)
    }
    const rows = [...snapshot.nodes.values()]
      .filter((node) => isNodePresent(node))
      .map((node) => ({
        id: node.id,
        title: node.title,
        status: node.status,
        in_degree: inDegree.get(node.id) ?? 0,
        out_degree: outDegree.get(node.id) ?? 0,
      }))
      .sort((left, right) => (right.in_degree + right.out_degree) - (left.in_degree + left.out_degree) || left.title.localeCompare(right.title))
    const paths = this.pathRows(snapshot)
    return {
      dir: this.store.dir,
      settings,
      counts: {
        nodes: snapshot.nodes.size,
        ...counts,
        edges: snapshot.edges.length,
        paths: snapshot.paths.length,
        runnable_paths: paths.filter((path) => path.runnable).length,
        decisions: snapshot.decisions.length,
      },
      nodes: rows,
      paths,
      recent_decisions: snapshot.decisions.slice(-20).reverse(),
    }
  }

  /** Path rows used by both the index panel and the stats dashboard. */
  private pathRows(snapshot: GraphSnapshot): PathRow[] {
    return snapshot.paths.map((path) => {
      const problems = pathProblems(snapshot.nodes, snapshot.edges, path)
      return {
        id: path.id,
        name: path.name,
        summary: path.summary,
        start_node: path.start_node,
        end_node: path.end_node,
        start_title: snapshot.nodes.get(path.start_node)?.title ?? path.start_node,
        end_title: snapshot.nodes.get(path.end_node)?.title ?? path.end_node,
        node_titles: path.node_sequence.map((id) => snapshot.nodes.get(id)?.title ?? id),
        node_count: path.node_sequence.length,
        runnable: problems.length === 0,
        problems: problems.map((problem) => problem.message),
        favorite: path.favorite !== false,
      }
    })
  }

  /** The path list without the rest of the dashboard. */
  async paths(): Promise<PathRow[]> {
    return this.pathRows((await this.loaded()).snapshot)
  }

  /** Newest decision lines, at most `limit`. */
  async decisionLog(limit = 100): Promise<DecisionLogEntry[]> {
    const { snapshot } = await this.loaded()
    return snapshot.decisions.slice(-limit).reverse()
  }

  /**
   * The 操作记录 tab: newest first, Chinese only, with no ids in the payload at all.
   * @param limit - rows to return; the log is read tail-first like the old tab.
   */
  async operations(limit = 100): Promise<OperationRow[]> {
    const { snapshot } = await this.loaded()
    return operationRows(snapshot.decisions, snapshot.nodes, limit)
  }

  /**
   * Node rows for one status. `deleted` is what the 已删除 filter lists so a soft
   * deletion can be undone; omitted means every node still taking part in the graph.
   * @param status - optional status filter.
   */
  async listNodes(status?: NodeStatus): Promise<GraphNode[]> {
    const { snapshot } = await this.loaded()
    const nodes = [...snapshot.nodes.values()]
    const filtered = status === undefined
      ? nodes.filter((node) => isNodePresent(node))
      : nodes.filter((node) => node.status === status)
    return filtered.sort((left, right) => left.title.localeCompare(right.title))
  }

  /** Node search: TOP3 semantic (threshold + floor) plus keyword (independent). */
  async searchNodes(query: string, threshold?: number, keyword?: KeywordQueryOptions): Promise<NodeSearchResult> {
    const { snapshot, settings } = await this.loaded()
    return searchNodes(snapshot.nodes, query, searchSettings(settings, threshold, keyword), this.completion)
  }

  /** Index matching: semantic TOP3 (confirmed first, floor-only fillers marked) plus keyword. */
  async searchPaths(query: string, threshold?: number, keyword?: KeywordQueryOptions): Promise<PathSearchResult> {
    const { snapshot, settings } = await this.loaded()
    return searchPaths(snapshot.nodes, snapshot.paths, query, searchSettings(settings, threshold, keyword), (path) => {
      return pathProblems(snapshot.nodes, snapshot.edges, path).length === 0
    })
  }

  /** One-hop neighborhood for the anchor. */
  async neighborhood(nodeId: string): Promise<Neighborhood> {
    const { snapshot } = await this.loaded()
    return neighborhood(snapshot.nodes, snapshot.edges, nodeId)
  }

  /** Node drawer payload. */
  async nodeDetail(nodeId: string): Promise<NodeDetail> {
    const { snapshot } = await this.loaded()
    const node = snapshot.nodes.get(nodeId)
    if (node === undefined) throw new GraphError('node-missing', '节点不存在。', 404)
    const edgeRow = (edge: GraphEdge): EdgeRow => ({
      from: edge.from,
      to: edge.to,
      from_title: snapshot.nodes.get(edge.from)?.title ?? edge.from,
      to_title: snapshot.nodes.get(edge.to)?.title ?? edge.to,
      created_at: edge.created_at,
    })
    return {
      node,
      incoming: snapshot.edges.filter((edge) => edge.to === nodeId).map(edgeRow),
      outgoing: snapshot.edges.filter((edge) => edge.from === nodeId).map(edgeRow),
      paths: snapshot.paths
        .filter((path) => path.node_sequence.includes(nodeId))
        .map((path) => ({
          id: path.id,
          name: path.name,
          runnable: pathProblems(snapshot.nodes, snapshot.edges, path).length === 0,
        })),
      screenshots: node.screenshots.map((shot) => ({
        id: shot.id,
        name: shot.name ?? shot.caption,
        caption: shot.caption,
        source: shot.source === 'ai' ? 'ai' : 'human',
        url: `api/screenshots/${encodeURIComponent(nodeId)}/${encodeURIComponent(shot.file)}`,
      })),
    }
  }

  /** Create one node. */
  async createNode(input: CreateNodeInput): Promise<GraphNode> {
    const title = input.title.trim()
    if (title === '') throw new GraphError('node-title-required', '节点标题不能为空。', 400)
    return this.locked(async () => {
      const { snapshot, settings } = await this.loaded()
      const source = input.derived_from === undefined || input.derived_from === null
        ? undefined
        : snapshot.nodes.get(input.derived_from)
      if (input.derived_from !== undefined && input.derived_from !== null && source === undefined) {
        throw new GraphError('node-missing', '作为起点的源节点不存在。', 404)
      }
      if (source !== undefined && !isNodePresent(source)) {
        throw new GraphError('node-removed', '已删除的节点不能作为起点。', 409)
      }
      const now = new Date().toISOString()
      const node: GraphNode = {
        id: `node-${randomUUID().slice(0, 8)}`,
        title,
        description: input.description.trim(),
        embedding: null,
        status: 'active',
        created_at: now,
        created_by: (input.created_by ?? 'human').slice(0, 80),
        derived_from: source?.id ?? null,
        screenshots: [],
      }
      const withEmbedding: GraphNode = { ...node, embedding: embedText(nodeSearchText(node)) }
      await this.store.saveNode(withEmbedding)
      ;(snapshot.nodes as Map<string, GraphNode>).set(withEmbedding.id, withEmbedding)
      await this.log(snapshot, {
        node_id: withEmbedding.id,
        action: 'create',
        candidates: source === undefined ? [] : [{ node_id: source.id, similarity: 1 }],
        similarity: source === undefined ? null : 1,
        diff_summary: source === undefined ? '' : `以变体方式新建，不复制任何边（来源说明未复制）`,
        chosen: withEmbedding.id,
        operator: withEmbedding.created_by,
      })
      await this.store.commit(snapshot, settings)
      return withEmbedding
    })
  }

  /**
   * Update the editable fields; recompute the embedding when search text changed, and
   * append one `update` decision line naming the fields that actually changed.
   * @param nodeId - the node to edit.
   * @param patch - title and/or description; omitted fields keep their value.
   * @param operator - recorded on the decision line.
   */
  async updateNode(nodeId: string, patch: {
    title?: string
    description?: string
  }, operator = 'human'): Promise<GraphNode> {
    return this.locked(async () => {
      const { snapshot, settings } = await this.loaded()
      const node = snapshot.nodes.get(nodeId)
      if (node === undefined) throw new GraphError('node-missing', '节点不存在。', 404)
      if (!isNodePresent(node)) throw new GraphError('node-removed', '已删除的节点不能编辑；先在「已删除」里恢复。', 409)
      const title = patch.title === undefined ? node.title : patch.title.trim()
      if (title === '') throw new GraphError('node-title-required', '节点标题不能为空。', 400)
      const description = patch.description === undefined ? node.description : patch.description.trim()
      const next: GraphNode = { ...node, title, description }
      const fields: DecisionField[] = []
      if (title !== node.title) fields.push('title')
      if (description !== node.description) fields.push('description')
      const changed = fields.length > 0
      const saved: GraphNode = changed ? { ...next, embedding: embedText(nodeSearchText(next)) } : next
      await this.store.saveNode(saved)
      ;(snapshot.nodes as Map<string, GraphNode>).set(nodeId, saved)
      if (changed) {
        await this.log(snapshot, {
          node_id: nodeId,
          action: 'update',
          fields,
          chosen: nodeId,
          operator,
        })
      }
      await this.store.commit(snapshot, settings)
      return saved
    })
  }

  /**
   * Copy the node content (title, description, screenshots); no edge travels and no io
   * exists any more. The copy is isolated and always records `derived_from`.
   */
  async copyNode(nodeId: string, operator = 'human'): Promise<GraphNode> {
    return this.locked(async () => {
      const { snapshot, settings } = await this.loaded()
      const source = snapshot.nodes.get(nodeId)
      if (source === undefined) throw new GraphError('node-missing', '要复制的节点不存在。', 404)
      if (!isNodePresent(source)) throw new GraphError('node-removed', '已删除的节点不能复制。', 409)
      const now = new Date().toISOString()
      const stamp = now.slice(0, 16).replace('T', '-').replace(':', '')
      const id = `node-${randomUUID().slice(0, 8)}`
      const screenshots = source.screenshots.map((shot) => ({
        id: `shot-${randomUUID().slice(0, 8)}`,
        file: shot.file,
        caption: shot.caption,
        ...shot.name === undefined ? {} : { name: shot.name },
        ...shot.source === undefined ? {} : { source: shot.source },
      }))
      for (const shot of screenshots) {
        await this.store.copyScreenshot(source.id, shot.file, id, shot.file)
      }
      const node: GraphNode = {
        id,
        title: `${source.title}_复制版_${stamp}`,
        description: source.description,
        embedding: null,
        status: 'active',
        created_at: now,
        created_by: operator.slice(0, 80),
        derived_from: source.id,
        screenshots,
        ...source.ai_notes === undefined ? {} : { ai_notes: source.ai_notes, ai_updated_at: now },
        ...source.favorite === undefined ? {} : { favorite: source.favorite },
      }
      const saved: GraphNode = { ...node, embedding: embedText(nodeSearchText(node)) }
      await this.store.saveNode(saved)
      ;(snapshot.nodes as Map<string, GraphNode>).set(saved.id, saved)
      await this.log(snapshot, {
        node_id: saved.id,
        action: 'copy',
        candidates: [{ node_id: source.id, similarity: 1 }],
        similarity: 1,
        diff_summary: '内容复制，不复制任何连线；副本初始孤立，连线需要自己重建',
        chosen: saved.id,
        operator,
      })
      await this.store.commit(snapshot, settings)
      return saved
    })
  }

  /** Record a search-result reuse without touching the node. */
  async logReuse(nodeId: string, query: string, similarity: number | null, operator = 'human'): Promise<void> {
    await this.locked(async () => {
      const { snapshot } = await this.loaded()
      if (!snapshot.nodes.has(nodeId)) throw new GraphError('node-missing', '要复用的节点不存在。', 404)
      await this.log(snapshot, {
        node_id: nodeId,
        action: 'reuse',
        candidates: [],
        similarity,
        diff_summary: `复用已有节点，检索词：${query.slice(0, 200)}`,
        chosen: nodeId,
        operator,
      })
    })
  }

  /**
   * The one delete the editor offers: soft delete. The file and every edge stay on disk;
   * the node disappears from search, edges, and paths until `restoreNode` brings it back.
   * Deleting an already deleted node is a no-op (no second log line).
   * @param nodeId - the node to delete.
   * @param operator - recorded on the decision line.
   */
  async deleteNode(nodeId: string, operator = 'human'): Promise<GraphNode> {
    return this.locked(async () => {
      const { snapshot, settings } = await this.loaded()
      const node = snapshot.nodes.get(nodeId)
      if (node === undefined) throw new GraphError('node-missing', '节点不存在。', 404)
      if (node.status === 'deleted') return node
      const saved: GraphNode = { ...node, status: 'deleted' }
      await this.store.saveNode(saved)
      ;(snapshot.nodes as Map<string, GraphNode>).set(nodeId, saved)
      await this.log(snapshot, {
        node_id: nodeId,
        action: 'delete_node',
        diff_summary: '状态改为「已删除」，文件和连线保留，可在「已删除」筛选里恢复',
        chosen: nodeId,
        operator,
      })
      await this.store.commit(snapshot, settings)
      return saved
    })
  }

  /**
   * Undo a soft delete: the node becomes `active` again and rejoins search, edges, and
   * paths exactly as before, because nothing was removed in the first place.
   * @param nodeId - the node to restore.
   * @param operator - recorded on the decision line.
   */
  async restoreNode(nodeId: string, operator = 'human'): Promise<GraphNode> {
    return this.locked(async () => {
      const { snapshot, settings } = await this.loaded()
      const node = snapshot.nodes.get(nodeId)
      if (node === undefined) throw new GraphError('node-missing', '节点不存在。', 404)
      if (node.status === 'active') return node
      const saved: GraphNode = { ...node, status: 'active' }
      await this.store.saveNode(saved)
      ;(snapshot.nodes as Map<string, GraphNode>).set(nodeId, saved)
      await this.log(snapshot, {
        node_id: nodeId,
        action: 'restore',
        diff_summary: '状态改回「在用」，重新参与检索、连线和路径执行',
        chosen: nodeId,
        operator,
      })
      await this.store.commit(snapshot, settings)
      return saved
    })
  }

  /** Dry-run an edge; the drag preview and the relation dialog call this first. */
  async validateEdge(from: string, to: string): Promise<void> {
    const { snapshot } = await this.loaded()
    const check = validateNewEdge(snapshot.nodes, snapshot.edges, from, to)
    if (!check.ok) throw new GraphError(check.code, check.message, 409)
  }

  /** Add one edge after the same validation the drag preview used. */
  async addEdge(from: string, to: string): Promise<GraphEdge> {
    return this.locked(async () => {
      const { snapshot, settings } = await this.loaded()
      const check = validateNewEdge(snapshot.nodes, snapshot.edges, from, to)
      if (!check.ok) throw new GraphError(check.code, check.message, 409)
      const edge: GraphEdge = { from, to, type: 'sequence', created_at: new Date().toISOString() }
      const edges = [...snapshot.edges, edge]
      await this.store.saveEdges(edges)
      ;(snapshot.edges as GraphEdge[]).push(edge)
      await this.store.commit(snapshot, settings)
      return edge
    })
  }

  /** Remove one edge and record the decision. */
  async deleteEdge(from: string, to: string, operator = 'human'): Promise<void> {
    await this.locked(async () => {
      const { snapshot, settings } = await this.loaded()
      const existing = snapshot.edges.find((edge) => edge.from === from && edge.to === to)
      if (existing === undefined) throw new GraphError('edge-missing', '这条边不存在。', 404)
      const edges = snapshot.edges.filter((edge) => !(edge.from === from && edge.to === to))
      await this.store.saveEdges(edges)
      ;(snapshot.edges as GraphEdge[]).splice(0, snapshot.edges.length, ...edges)
      await this.log(snapshot, {
        node_id: from,
        action: 'delete_edge',
        candidates: [{ node_id: to, similarity: null }],
        diff_summary: '',
        chosen: to,
        operator,
      })
      await this.store.commit(snapshot, settings)
    })
  }

  /** Create one prepared path; a sequence that does not validate is refused. */
  async createPath(input: CreatePathInput): Promise<GraphPath> {
    return this.locked(async () => {
      const { snapshot, settings } = await this.loaded()
      const name = input.name.trim()
      if (name === '') throw new GraphError('path-name-required', '收藏名不能为空。', 400)
      const graph = input.graph ?? linearPathGraph(input.node_sequence)
      const sequence = input.graph === undefined ? [...input.node_sequence] : graph.nodes.map((entry) => entry.node_id)
      if (sequence.length === 0) throw new GraphError('path-empty', '收藏路径至少需要一个节点。', 400)
      if (input.graph === undefined && new Set(sequence).size !== sequence.length) {
        throw new GraphError('path-duplicate', '收藏路径不能重复同一个节点。', 400)
      }
      const path: GraphPath = {
        id: `path-${randomUUID().slice(0, 8)}`,
        name,
        summary: input.summary.trim(),
        embedding: null,
        start_node: input.graph === undefined ? (sequence[0] as string) : (graph.nodes[0]?.node_id ?? ''),
        end_node: input.graph === undefined
          ? (sequence[sequence.length - 1] as string)
          : (graph.nodes[graph.nodes.length - 1]?.node_id ?? ''),
        node_sequence: sequence,
        graph,
      }
      const problems = pathProblems(snapshot.nodes, snapshot.edges, path)
      if (problems.length > 0) {
        throw new GraphError('path-invalid', `这条路径当前不可用：${problems.map((problem) => problem.message).join('；')}`, 409)
      }
      const saved: GraphPath = { ...path, embedding: embedText(pathSearchText(path, snapshot.nodes)) }
      await this.store.savePath(saved)
      ;(snapshot.paths as GraphPath[]).push(saved)
      await this.store.commit(snapshot, settings)
      return saved
    })
  }

  /** Delete one path file. */
  async deletePath(pathId: string): Promise<void> {
    await this.locked(async () => {
      const { snapshot, settings } = await this.loaded()
      const index = snapshot.paths.findIndex((path) => path.id === pathId)
      if (index === -1) throw new GraphError('path-missing', '收藏不存在。', 404)
      await this.store.removePathFile(pathId)
      ;(snapshot.paths as GraphPath[]).splice(index, 1)
      await this.store.commit(snapshot, settings)
    })
  }

  /**
   * Toggle the favorites flag for one node.
   *
   * "Remove from favorites" only hides the node from the favorites list: the node file, its
   * screenshots and every path that references it stay exactly as they are.
   */
  async setNodeFavorite(nodeId: string, favorite: boolean): Promise<GraphNode> {
    return this.locked(async () => {
      const { snapshot, settings } = await this.loaded()
      const node = snapshot.nodes.get(nodeId)
      if (node === undefined) throw new GraphError('node-missing', '节点不存在。', 404)
      const saved: GraphNode = { ...node, favorite }
      await this.store.saveNode(saved)
      ;(snapshot.nodes as Map<string, GraphNode>).set(nodeId, saved)
      await this.store.commit(snapshot, settings)
      return saved
    })
  }

  /** Duplicate one saved path as an independent copy; names get a copy stamp, ids are new. */
  async copyPath(pathId: string, operator = 'human'): Promise<GraphPath> {
    return this.locked(async () => {
      const { snapshot, settings } = await this.loaded()
      const source = snapshot.paths.find((path) => path.id === pathId)
      if (source === undefined) throw new GraphError('path-missing', '要复制的路径不存在。', 404)
      const stamp = new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '')
      const graph = source.graph === undefined
        ? undefined
        : {
            nodes: source.graph.nodes.map((entry) => ({ key: entry.key, node_id: entry.node_id })),
            edges: source.graph.edges.map((edge) => ({ from: edge.from, to: edge.to })),
          }
      const path: GraphPath = {
        id: `path-${randomUUID().slice(0, 8)}`,
        name: `${source.name}_复制版_${stamp}`,
        summary: source.summary,
        embedding: null,
        start_node: source.start_node,
        end_node: source.end_node,
        node_sequence: [...source.node_sequence],
        ...graph === undefined ? {} : { graph },
      }
      const saved: GraphPath = { ...path, embedding: embedText(pathSearchText(path, snapshot.nodes)) }
      await this.store.savePath(saved)
      ;(snapshot.paths as GraphPath[]).push(saved)
      await this.store.commit(snapshot, settings)
      return saved
    })
  }

  /** Export one node and its screenshots into an empty folder. */
  async exportNode(nodeId: string, dir: string): Promise<{ dir: string; screenshots: number }> {
    const { snapshot } = await this.loaded()
    const node = snapshot.nodes.get(nodeId)
    if (node === undefined) throw new GraphError('node-missing', '节点不存在。', 404)
    if (!isNodePresent(node)) throw new GraphError('node-removed', '已删除的节点不能导出。', 409)
    await assertEmptyDirectory(dir)
    await mkdir(join(dir, 'screenshots'), { recursive: true })
    const screenshots: NodeScreenshot[] = []
    for (const shot of node.screenshots) {
      const bytes = await this.store.readScreenshot(nodeId, shot.file)
      if (bytes === undefined) continue
      await writeFile(join(dir, 'screenshots', shot.file), bytes)
      screenshots.push({ ...shot })
    }
    await writeFile(join(dir, 'node.json'), JSON.stringify({ ...node, embedding: null, screenshots }, null, 2), 'utf8')
    await writeFile(join(dir, 'manifest.json'), JSON.stringify({ format: 'dsh-agi.node', version: 1, exported_at: new Date().toISOString() }, null, 2), 'utf8')
    return { dir, screenshots: screenshots.length }
  }

  /** Export one path plus every node it references into an empty folder. */
  async exportPath(pathId: string, dir: string): Promise<{ dir: string; nodes: number }> {
    const { snapshot } = await this.loaded()
    const path = snapshot.paths.find((item) => item.id === pathId)
    if (path === undefined) throw new GraphError('path-missing', '路径不存在。', 404)
    await assertEmptyDirectory(dir)
    await mkdir(join(dir, 'nodes'), { recursive: true })
    const ids = new Set<string>(path.node_sequence)
    for (const entry of path.graph?.nodes ?? []) ids.add(entry.node_id)
    let count = 0
    for (const nodeId of ids) {
      const node = snapshot.nodes.get(nodeId)
      if (node === undefined) continue
      await writeFile(join(dir, 'nodes', `${nodeId}.json`), JSON.stringify({ ...node, embedding: null }, null, 2), 'utf8')
      for (const shot of node.screenshots) {
        const bytes = await this.store.readScreenshot(nodeId, shot.file)
        if (bytes === undefined) continue
        await mkdir(join(dir, 'screenshots', nodeId), { recursive: true })
        await writeFile(join(dir, 'screenshots', nodeId, shot.file), bytes)
      }
      count += 1
    }
    await writeFile(join(dir, 'path.json'), JSON.stringify({ ...path, embedding: null }, null, 2), 'utf8')
    await writeFile(join(dir, 'manifest.json'), JSON.stringify({ format: 'dsh-agi.path', version: 1, exported_at: new Date().toISOString() }, null, 2), 'utf8')
    return { dir, nodes: count }
  }

  /** Rebuild one node from an exported folder; a colliding id becomes a fresh id. */
  private async importNodeRecord(raw: Record<string, unknown>, shotDir: string, snapshot: GraphSnapshot): Promise<GraphNode> {
    const title = typeof raw.title === 'string' ? raw.title.trim() : ''
    if (title === '') throw new GraphError('import-invalid', 'node.json 缺少标题。', 400)
    const description = typeof raw.description === 'string' ? raw.description : ''
    const originalId = typeof raw.id === 'string' && raw.id !== '' ? raw.id : `node-${randomUUID().slice(0, 8)}`
    const id = snapshot.nodes.has(originalId) ? `node-${randomUUID().slice(0, 8)}` : originalId
    const shotsRaw = Array.isArray(raw.screenshots) ? raw.screenshots : []
    const screenshots: NodeScreenshot[] = []
    for (const item of shotsRaw) {
      if (typeof item !== 'object' || item === null) continue
      const shot = item as Record<string, unknown>
      if (typeof shot.file !== 'string' || typeof shot.caption !== 'string') continue
      const bytes = await readFile(join(shotDir, shot.file)).catch(() => undefined)
      if (bytes === undefined) continue
      await this.store.writeScreenshot(id, shot.file, bytes)
      screenshots.push({
        id: `shot-${randomUUID().slice(0, 8)}`,
        file: shot.file,
        caption: shot.caption,
        ...typeof shot.name === 'string' && shot.name !== '' ? { name: shot.name } : {},
        ...shot.source === 'ai' ? { source: 'ai' as const } : {},
      })
    }
    const node: GraphNode = {
      id,
      title,
      description,
      embedding: null,
      status: 'active',
      created_at: new Date().toISOString(),
      created_by: 'import',
      derived_from: typeof raw.derived_from === 'string' ? raw.derived_from : null,
      screenshots,
      ...typeof raw.ai_notes === 'string' && raw.ai_notes !== '' ? { ai_notes: raw.ai_notes } : {},
      ...typeof raw.favorite === 'boolean' ? { favorite: raw.favorite } : {},
    }
    return { ...node, embedding: embedText(nodeSearchText(node)) }
  }

  /** Import one node folder into the library. */
  async importNode(dir: string): Promise<GraphNode> {
    const record = await readJsonFile(join(dir, 'node.json'))
    if (record === undefined) throw new GraphError('import-invalid', '文件夹里没有可读的 node.json。', 400)
    return this.locked(async () => {
      const { snapshot, settings } = await this.loaded()
      const node = await this.importNodeRecord(record, join(dir, 'screenshots'), snapshot)
      await this.store.saveNode(node)
      ;(snapshot.nodes as Map<string, GraphNode>).set(node.id, node)
      await this.store.commit(snapshot, settings)
      return node
    })
  }

  /** Import one path folder, restoring the nodes it references when they are missing. */
  async importPath(dir: string): Promise<GraphPath> {
    const record = await readJsonFile(join(dir, 'path.json'))
    if (record === undefined) throw new GraphError('import-invalid', '文件夹里没有可读的 path.json。', 400)
    return this.locked(async () => {
      const { snapshot, settings } = await this.loaded()
      const sequence = Array.isArray(record.node_sequence)
        ? record.node_sequence.filter((item): item is string => typeof item === 'string')
        : []
      const ids = new Set<string>(sequence)
      const graphRaw = typeof record.graph === 'object' && record.graph !== null ? record.graph as Record<string, unknown> : undefined
      if (graphRaw !== undefined && Array.isArray(graphRaw.nodes)) {
        for (const item of graphRaw.nodes) {
          if (typeof item !== 'object' || item === null) continue
          const entry = item as Record<string, unknown>
          if (typeof entry.node_id === 'string') ids.add(entry.node_id)
        }
      }
      for (const nodeId of ids) {
        if (snapshot.nodes.has(nodeId)) continue
        const raw = await readJsonFile(join(dir, 'nodes', `${nodeId}.json`))
        if (raw === undefined) continue
        const node = await this.importNodeRecord(raw, join(dir, 'screenshots', nodeId), snapshot)
        await this.store.saveNode(node)
        ;(snapshot.nodes as Map<string, GraphNode>).set(node.id, node)
      }
      const graph = graphRaw === undefined
        ? undefined
        : {
            nodes: (Array.isArray(graphRaw.nodes) ? graphRaw.nodes : []).flatMap((item) => {
              if (typeof item !== 'object' || item === null) return []
              const entry = item as Record<string, unknown>
              return typeof entry.key === 'string' && typeof entry.node_id === 'string' ? [{ key: entry.key, node_id: entry.node_id }] : []
            }),
            edges: (Array.isArray(graphRaw.edges) ? graphRaw.edges : []).flatMap((item) => {
              if (typeof item !== 'object' || item === null) return []
              const entry = item as Record<string, unknown>
              return typeof entry.from === 'string' && typeof entry.to === 'string' ? [{ from: entry.from, to: entry.to }] : []
            }),
          }
      const pathId = typeof record.id === 'string' ? record.id : `path-${randomUUID().slice(0, 8)}`
      const path: GraphPath = {
        id: snapshot.paths.some((item) => item.id === pathId) ? `path-${randomUUID().slice(0, 8)}` : pathId,
        name: typeof record.name === 'string' ? record.name : '导入的路径',
        summary: typeof record.summary === 'string' ? record.summary : '',
        embedding: null,
        start_node: typeof record.start_node === 'string' ? record.start_node : (sequence[0] ?? ''),
        end_node: typeof record.end_node === 'string' ? record.end_node : (sequence[sequence.length - 1] ?? ''),
        node_sequence: sequence,
        ...graph === undefined ? {} : { graph },
      }
      const hard = pathProblems(snapshot.nodes, snapshot.edges, path)
        .filter((problem) => problem.code === 'cycle' || problem.code === 'missing-node' || problem.code === 'broken-edge')
      if (hard.length > 0) throw new GraphError('import-invalid', `导入失败：${hard.map((problem) => problem.message).join('；')}`, 409)
      const saved: GraphPath = { ...path, embedding: embedText(pathSearchText(path, snapshot.nodes)) }
      await this.store.savePath(saved)
      ;(snapshot.paths as GraphPath[]).push(saved)
      await this.store.commit(snapshot, settings)
      return saved
    })
  }

  /** Toggle the favorites flag for one path; the path file and its nodes stay untouched. */  async setPathFavorite(pathId: string, favorite: boolean): Promise<GraphPath> {
    return this.locked(async () => {
      const { snapshot, settings } = await this.loaded()
      const index = snapshot.paths.findIndex((path) => path.id === pathId)
      if (index === -1) throw new GraphError('path-missing', '收藏不存在。', 404)
      const previous = snapshot.paths[index] as GraphPath
      const saved: GraphPath = { ...previous, favorite }
      await this.store.savePath(saved)
      ;(snapshot.paths as GraphPath[])[index] = saved
      await this.store.commit(snapshot, settings)
      return saved
    })
  }

  /**
   * Replace one saved path's name, summary and sequence.
   *
   * A path owns its own order: editing it never touches another path or the node library.
   * The same structural rules apply as on creation (non-empty, no repeated node, every node
   * exists), and the search embedding follows the new text.
   */
  async updatePath(input: UpdatePathInput): Promise<GraphPath> {
    return this.locked(async () => {
      const { snapshot, settings } = await this.loaded()
      const index = snapshot.paths.findIndex((path) => path.id === input.pathId)
      if (index === -1) throw new GraphError('path-missing', '收藏不存在。', 404)
      const name = input.name.trim()
      if (name === '') throw new GraphError('path-name-required', '收藏名不能为空。', 400)
      const graph = input.graph ?? linearPathGraph(input.node_sequence)
      const sequence = input.graph === undefined ? [...input.node_sequence] : graph.nodes.map((entry) => entry.node_id)
      if (sequence.length === 0) throw new GraphError('path-empty', '收藏路径至少需要一个节点。', 400)
      if (input.graph === undefined && new Set(sequence).size !== sequence.length) {
        throw new GraphError('path-duplicate', '收藏路径不能重复同一个节点。', 400)
      }
      const previous = snapshot.paths[index] as GraphPath
      const path: GraphPath = {
        ...previous,
        name,
        summary: input.summary.trim(),
        start_node: input.graph === undefined ? (sequence[0] as string) : (graph.nodes[0]?.node_id ?? ''),
        end_node: input.graph === undefined
          ? (sequence[sequence.length - 1] as string)
          : (graph.nodes[graph.nodes.length - 1]?.node_id ?? ''),
        node_sequence: sequence,
        graph,
        embedding: embedText(pathSearchText({ ...previous, name, summary: input.summary.trim() }, snapshot.nodes)),
      }
      // Hard data faults must never reach the file; softer findings stay visible through the
      // check button instead of blocking a save.
      const hard = pathProblems(snapshot.nodes, snapshot.edges, path)
        .filter((problem) => problem.code === 'cycle' || problem.code === 'missing-node' || problem.code === 'broken-edge')
      if (hard.length > 0) throw new GraphError('path-invalid', `不能保存：${hard.map((problem) => problem.message).join('；')}`, 409)
      ;(snapshot.paths as GraphPath[])[index] = path
      await this.store.commit(snapshot, settings)
      return path
    })
  }

  /** Load the complete path and a prompt-ready text rendering. */
  async pathDetail(pathId: string): Promise<PathDetail> {
    const { snapshot } = await this.loaded()
    const path = snapshot.paths.find((item) => item.id === pathId)
    if (path === undefined) throw new GraphError('path-missing', '收藏不存在。', 404)
    const nodes = path.node_sequence.map((id) => snapshot.nodes.get(id))
    const problems = pathProblems(snapshot.nodes, snapshot.edges, path)
    const lines = [
      `收藏：${path.name}（${path.id}）`,
      `摘要：${path.summary}`,
      `起始节点：${snapshot.nodes.get(path.start_node)?.title ?? path.start_node}`,
      `结束节点：${snapshot.nodes.get(path.end_node)?.title ?? path.end_node}`,
      '完整路径：',
    ]
    path.node_sequence.forEach((id, index) => {
      const node = snapshot.nodes.get(id)
      lines.push(`${index + 1}. ${node?.title ?? id}`)
      if (node !== undefined && node.description !== '') lines.push(`   说明：${node.description}`)
      for (const shot of node?.screenshots ?? []) lines.push(`   校验截图：${shot.caption}`)
    })
    if (problems.length > 0) {
      lines.push(`当前问题：${problems.map((problem) => problem.message).join('；')}`)
    }
    return {
      path,
      graph: path.graph ?? linearPathGraph(path.node_sequence),
      nodes: nodes.filter((node): node is GraphNode => node !== undefined),
      problems,
      text: lines.join('\n'),
    }
  }

  /**
   * Static pre-flight check for one saved path.
   *
   * This is what the editor's 检查 button runs. It never starts a run: no desktop action, no
   * model verdict, only data, edges and fields.
   */
  async checkPath(pathId: string): Promise<PathCheckResult> {
    const { snapshot } = await this.loaded()
    const path = snapshot.paths.find((item) => item.id === pathId)
    if (path === undefined) throw new GraphError('path-missing', '收藏不存在。', 404)
    return checkPathStatic(path, snapshot.nodes, snapshot.edges)
  }

  /** Resolve one saved path into ordered, titled steps for any display surface. */
  async pathView(pathId: string): Promise<PathView> {
    const { snapshot } = await this.loaded()
    const path = snapshot.paths.find((item) => item.id === pathId)
    if (path === undefined) throw new GraphError('path-missing', '收藏不存在。', 404)
    return resolvePathView(path, snapshot.nodes)
  }

  /** Start one run. The path must validate against the graph as it is now. */
  async startRun(pathId: string): Promise<RunView> {
    const { snapshot } = await this.loaded()
    const path = snapshot.paths.find((item) => item.id === pathId)
    if (path === undefined) throw new GraphError('path-missing', '收藏不存在。', 404)
    const run = createExecutionRun(path, snapshot.nodes, snapshot.edges, `run-${randomUUID().slice(0, 8)}`)
    while (this.runs.size >= 50) {
      const oldest = this.runs.keys().next().value
      if (oldest === undefined) break
      this.runs.delete(oldest)
    }
    this.runs.set(run.id, run)
    return viewExecutionRun(run, snapshot.nodes, snapshot.edges)
  }

  /** Current view of one run. */
  async runView(runId: string): Promise<RunView> {
    const { snapshot } = await this.loaded()
    return viewExecutionRun(this.requireRun(runId), snapshot.nodes, snapshot.edges)
  }

  /** Record one model verdict. */
  async judge(runId: string, nodeId: string, verdict: 'met' | 'unmet' | 'skipped', reason: string): Promise<RunView> {
    const { snapshot } = await this.loaded()
    const result = judgeStep(this.requireRun(runId), nodeId, verdict, reason.slice(0, 1000), snapshot.nodes, snapshot.edges)
    this.runs.set(runId, result.run)
    return result.view
  }

  /** Re-run one step: the "补执行" option. */
  async reset(runId: string, nodeId: string): Promise<RunView> {
    const { snapshot } = await this.loaded()
    const result = resetStep(this.requireRun(runId), nodeId, snapshot.nodes, snapshot.edges)
    this.runs.set(runId, result.run)
    return result.view
  }

  /** Mark one step skipped: the "标记跳过" option, explicitly human. */
  async skip(runId: string, nodeId: string, reason = '人工标记跳过'): Promise<RunView> {
    const { snapshot } = await this.loaded()
    const result = skipStep(this.requireRun(runId), nodeId, reason, snapshot.nodes, snapshot.edges)
    this.runs.set(runId, result.run)
    return result.view
  }

  /**
   * Ask the configured chat model whether the current step met its description, using
   * the node prose, its screenshot captions, and the executor's observation text.
   * Images themselves stay out of this prompt; the captions are the node's own
   * accuracy reference and the human sees the full screenshots in the drawer.
   */
  async judgeWithLlm(runId: string, nodeId: string, evidence: string): Promise<RunView> {
    if (this.completion === undefined) {
      throw new GraphError('judge-unavailable', '当前没有可用的模型通道，请人工判定。', 503)
    }
    const { snapshot } = await this.loaded()
    const run = this.requireRun(runId)
    const view = viewExecutionRun(run, snapshot.nodes, snapshot.edges)
    if (view.current_node_id !== nodeId) throw new GraphError('run-blocked', view.message, 409)
    const node = snapshot.nodes.get(nodeId)
    if (node === undefined) throw new GraphError('node-missing', '节点不存在。', 404)
    const prompt = [
      '你在执行经验库里的一条操作路径，现在只需要判定当前这一步是否达标。',
      `步骤标题：${node.title}`,
      `步骤说明：${node.description}`,
      `该步骤的校验截图说明：${node.screenshots.length === 0 ? '（无）' : node.screenshots.map((shot) => shot.caption).join('；')}`,
      '如果附带了截图，请把截图与说明一起作为判定依据。',
      `执行者的观察/操作结果：${evidence.trim() === '' ? '（未提供）' : evidence}`,
      '只输出一行 JSON：{"met":true或false,"reason":"不超过30字的原因"}。不要输出别的文字。',
    ].join('\n')
    const images: { mediaType: string; data: Uint8Array; name: string }[] = []
    for (const shot of node.screenshots.slice(0, 4)) {
      const bytes = await this.store.readScreenshot(nodeId, shot.file)
      if (bytes === undefined) continue
      images.push({ mediaType: imageMediaType(shot.file), data: bytes, name: shot.file })
    }
    let answer: string
    try {
      answer = await this.completion(prompt, AbortSignal.timeout(30_000), images)
    } catch (error) {
      throw new GraphError('judge-failed', `模型判定失败：${error instanceof Error ? error.message : String(error)}`, 502)
    }
    const parsed = parseJudgeAnswer(answer)
    if (parsed === undefined) throw new GraphError('judge-failed', '模型没有给出可解析的判定，请人工选择。', 502)
    return this.judge(runId, nodeId, parsed.met ? 'met' : 'unmet', parsed.reason)
  }

  /** Pop one run. */
  private requireRun(runId: string): ExecutionRun {
    const run = this.runs.get(runId)
    if (run === undefined) throw new GraphError('run-missing', '执行会话不存在或已过期。', 404)
    return run
  }

  /**
   * Write the agent-maintained supplement and bump its timestamp.
   *
   * The human title/description and their screenshots are never touched here: the operator's
   * text stays the base, and this field is only the agent's refined guidance from real runs.
   * The size rule is enforced here so a runaway model cannot turn a node into an essay.
   */
  async updateNodeAi(nodeId: string, notes: string): Promise<GraphNode> {
    const trimmed = notes.trim()
    if (trimmed === '') throw new GraphError('ai-notes-empty', 'AI 补充不能为空；没有新内容就不要写。', 400)
    if (trimmed.length > 1200) throw new GraphError('ai-notes-too-long', 'AI 补充太长：压缩到 1200 字以内，只留要点。', 400)
    return this.locked(async () => {
      const { snapshot, settings } = await this.loaded()
      const node = snapshot.nodes.get(nodeId)
      if (node === undefined) throw new GraphError('node-missing', '节点不存在。', 404)
      if (!isNodePresent(node)) throw new GraphError('node-removed', '已删除的节点不能更新。', 409)
      if (trimmed === (node.ai_notes ?? '')) return node
      const saved: GraphNode = { ...node, ai_notes: trimmed, ai_updated_at: new Date().toISOString() }
      await this.store.saveNode(saved)
      ;(snapshot.nodes as Map<string, GraphNode>).set(nodeId, saved)
      await this.store.commit(snapshot, settings)
      return saved
    })
  }

  /** Add one screenshot; the caption feeds both search and the judge. */
  async addScreenshot(nodeId: string, input: ScreenshotInput): Promise<GraphNode> {
    const caption = input.caption.trim()
    if (caption === '') throw new GraphError('caption-required', '截图必须写一句说明（caption）。', 400)
    const parsed = decodeImage(input)
    if (parsed === undefined) throw new GraphError('image-invalid', '截图必须是 PNG/JPEG/WebP/GIF，且不超过 8MB。', 400)
    return this.locked(async () => {
      const { snapshot, settings } = await this.loaded()
      const node = snapshot.nodes.get(nodeId)
      if (node === undefined) throw new GraphError('node-missing', '节点不存在。', 404)
      // The file name IS the content hash: the same bytes are stored once per node.
      const file = `${screenshotDigest(parsed.bytes)}.${parsed.extension}`
      if (node.screenshots.some((item) => item.file === file)) return node
      await this.store.writeScreenshot(nodeId, file, parsed.bytes)
      const shot = {
        id: `shot-${randomUUID().slice(0, 8)}`,
        file,
        caption,
        ...input.name === undefined || input.name.trim() === '' ? {} : { name: input.name.trim() },
        ...(input.source === 'ai' ? { source: 'ai' as const } : {}),
      }
      const saved: GraphNode = {
        ...node,
        screenshots: [...node.screenshots, shot],
        embedding: embedText(nodeSearchText({ ...node, screenshots: [...node.screenshots, shot] })),
      }
      await this.store.saveNode(saved)
      ;(snapshot.nodes as Map<string, GraphNode>).set(nodeId, saved)
      await this.store.commit(snapshot, settings)
      return saved
    })
  }

  /**
   * Rename or re-caption one screenshot.
   *
   * The display name is free text; the file itself keeps its content-hash name, so the binding
   * "this image is for X" survives any rename.
   */
  async updateScreenshot(nodeId: string, shotId: string, patch: {
    readonly name?: string
    readonly caption?: string
  }): Promise<GraphNode> {
    return this.locked(async () => {
      const { snapshot, settings } = await this.loaded()
      const node = snapshot.nodes.get(nodeId)
      if (node === undefined) throw new GraphError('node-missing', '节点不存在。', 404)
      const shot = node.screenshots.find((item) => item.id === shotId)
      if (shot === undefined) throw new GraphError('screenshot-missing', '截图不存在。', 404)
      const caption = patch.caption === undefined ? shot.caption : patch.caption.trim()
      if (caption === '') throw new GraphError('caption-required', '截图说明不能为空。', 400)
      const name = patch.name === undefined ? shot.name : patch.name.trim()
      const screenshots = node.screenshots.map((item) => item.id !== shotId
        ? item
        : { ...item, caption, ...(name === undefined || name === '' ? { name: undefined } : { name }) })
      const saved: GraphNode = { ...node, screenshots, embedding: embedText(nodeSearchText({ ...node, screenshots })) }
      await this.store.saveNode(saved)
      ;(snapshot.nodes as Map<string, GraphNode>).set(nodeId, saved)
      await this.store.commit(snapshot, settings)
      return saved
    })
  }

  /** Remove one screenshot and its caption. */
  async deleteScreenshot(nodeId: string, shotId: string): Promise<GraphNode> {
    return this.locked(async () => {
      const { snapshot, settings } = await this.loaded()
      const node = snapshot.nodes.get(nodeId)
      if (node === undefined) throw new GraphError('node-missing', '节点不存在。', 404)
      const shot = node.screenshots.find((item) => item.id === shotId)
      if (shot === undefined) throw new GraphError('screenshot-missing', '截图不存在。', 404)
      await this.store.removeScreenshotFile(nodeId, shot.file)
      const screenshots = node.screenshots.filter((item) => item.id !== shotId)
      const saved: GraphNode = { ...node, screenshots, embedding: embedText(nodeSearchText({ ...node, screenshots })) }
      await this.store.saveNode(saved)
      ;(snapshot.nodes as Map<string, GraphNode>).set(nodeId, saved)
      await this.store.commit(snapshot, settings)
      return saved
    })
  }

  /** Update threshold / semantic floor / keyword channel settings; untouched fields persist. */
  async updateSettings(patch: unknown): Promise<GraphSettings> {
    return this.locked(async () => {
      const { snapshot, settings: current } = await this.loaded()
      const settings = normalizeSettings({ ...current, ...(patch as object) })
      await this.store.saveSettings(settings, snapshot)
      return settings
    })
  }

  /** Similarity helper used when the editor asks the model for a difference. */
  similarityTo(node: GraphNode, query: string): number {
    return cosineSimilarity(embedText(query), node.embedding ?? embedText(nodeSearchText(node)))
  }

  /** Keep the cached path vectors fresh after an import or a bulk edit. */
  async warmEmbeddings(): Promise<number> {
    return this.locked(async () => {
      const { snapshot, settings } = await this.loaded()
      let changed = 0
      for (const node of snapshot.nodes.values()) {
        if (node.embedding !== null) continue
        const saved: GraphNode = { ...node, embedding: embedText(nodeSearchText(node)) }
        await this.store.saveNode(saved)
        ;(snapshot.nodes as Map<string, GraphNode>).set(node.id, saved)
        changed += 1
      }
      for (const path of snapshot.paths) {
        if (path.embedding !== null) continue
        const saved: GraphPath = { ...path, embedding: embedText(pathSearchText(path, snapshot.nodes)) }
        await this.store.savePath(saved)
        const index = snapshot.paths.findIndex((item) => item.id === path.id)
        if (index !== -1) (snapshot.paths as GraphPath[])[index] = saved
        changed += 1
      }
      if (changed > 0) await this.store.commit(snapshot, settings)
      return changed
    })
  }
}

/** Media type from the stored extension; the upload path already sniffed the bytes. */
function imageMediaType(file: string): string {
  const extension = file.toLowerCase().split('.').pop() ?? ''
  if (extension === 'png') return 'image/png'
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg'
  if (extension === 'webp') return 'image/webp'
  if (extension === 'gif') return 'image/gif'
  return 'image/png'
}

/** Parse the small JSON verdict the judge model returns. */
export function parseJudgeAnswer(answer: string): { met: boolean; reason: string } | undefined {
  const match = /\{[\s\S]*\}/u.exec(answer)
  if (match === null) return undefined
  try {
    const parsed = JSON.parse(match[0]) as { met?: unknown; reason?: unknown }
    if (typeof parsed.met !== 'boolean') return undefined
    return { met: parsed.met, reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 200) : '' }
  } catch {
    return undefined
  }
}

/** Decode a base64 image and pick a safe extension. */
function decodeImage(input: ScreenshotInput): { bytes: Buffer; extension: string } | undefined {
  const raw = input.data.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/u, '')
  let bytes: Buffer
  try {
    bytes = Buffer.from(raw, 'base64')
  } catch {
    return undefined
  }
  if (bytes.length === 0 || bytes.length > MAX_SCREENSHOT_BYTES) return undefined
  const sniffed = sniffImage(bytes)
  if (sniffed === undefined) return undefined
  return { bytes, extension: sniffed }
}

/** Magic-byte sniffing, independent of the browser-supplied MIME. */
function sniffImage(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg'
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'webp'
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'gif'
  return undefined
}

