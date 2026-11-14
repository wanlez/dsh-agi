/**
 * The experience graph: nodes, edges, and saved paths whose file form is plain JSON.
 *
 * The rules live here so the file store, the HTTP layer, and the tests all enforce the
 * same invariants: one edge per ordered pair, no cycles, soft deletion only, and a path
 * that can be executed only while every in-edge of every step is already satisfied.
 *
 * Multiple predecessors are AND: a node may start only after every one of its in-edges
 * has a satisfied source. There is no `required` flag and no OR.
 */

import { KEYWORD_FLOOR, KEYWORD_TOP } from './keyword.ts'

/**
 * Lifecycle of one node. Only soft deletion is offered now: new writes are `active` or
 * `deleted`. `deprecated` and `merged` stay in the union so a library written by an
 * older build still loads and reads correctly.
 */
export type NodeStatus = 'active' | 'deprecated' | 'merged' | 'deleted'

/** Every status a node file may carry; `deprecated` and `merged` are history only. */
export const NODE_STATUSES: readonly NodeStatus[] = ['active', 'deprecated', 'merged', 'deleted']

/** Statuses this build may write. */
export const WRITABLE_NODE_STATUSES: readonly NodeStatus[] = ['active', 'deleted']

/** One screenshot attached to a node, with the caption the judge reads. */
export interface NodeScreenshot {
  /** Stable local id, unique inside the node. */
  readonly id: string
  /** File name under `screenshots/<node-id>/`; never an absolute path. */
  readonly file: string
  /** One line saying what this screenshot proves (the accuracy reference). */
  readonly caption: string
}

/** One experience step. `embedding` is a cache; a missing value is recomputed on read. */
export interface GraphNode {
  readonly id: string
  readonly title: string
  /** Pure prose. Both the embedding and the model read this field. */
  readonly description: string
  readonly embedding: readonly number[] | null
  readonly status: NodeStatus
  readonly created_at: string
  readonly created_by: string
  /** Source node for a copy (and for a search variant); copies never inherit edges. */
  readonly derived_from: string | null
  readonly screenshots: readonly NodeScreenshot[]
}

/** The only edge type the editor creates today. */
export type EdgeType = 'sequence'

/** One directed edge. `from → to`; the type field is reserved for later kinds. */
export interface GraphEdge {
  readonly from: string
  readonly to: string
  readonly type: EdgeType
  readonly created_at: string
}

/** One prepared path: the execution entry named by the index. */
export interface GraphPath {
  readonly id: string
  /** Human-facing name; the matcher never relies on it alone. */
  readonly name: string
  /** The prose the matcher reads. */
  readonly summary: string
  readonly embedding: readonly number[] | null
  readonly start_node: string
  readonly end_node: string
  /** Ordered node ids; consecutive pairs are edges. */
  readonly node_sequence: readonly string[]
}

/**
 * Actions recorded in `decision_log.jsonl`.
 *
 * `merge` and `judge_same` are history only: this build never writes them, but the log
 * stays readable for a library written by an older one. New writes are `create`,
 * `update`, `copy`, `reuse`, `split`, `delete_edge`, `delete_node`, and `restore`.
 */
export type DecisionAction =
  | 'create'
  | 'update'
  | 'reuse'
  | 'merge'
  | 'copy'
  | 'split'
  | 'delete_edge'
  | 'delete_node'
  | 'restore'
  | 'judge_same'

/** Which editable field an `update` action touched, in the order the editor shows them. */
export type DecisionField = 'title' | 'description'

/** One candidate considered while making a decision. */
export interface DecisionCandidate {
  readonly node_id: string
  readonly similarity: number | null
}

/** One line of the append-only decision log. */
export interface DecisionLogEntry {
  readonly node_id: string
  readonly action: DecisionAction
  readonly candidates: readonly DecisionCandidate[]
  readonly similarity: number | null
  readonly diff_summary: string
  readonly chosen: string | null
  readonly operator: string
  readonly ts: string
  /** `update` only: the fields that changed. Absent on every older line. */
  readonly fields?: readonly DecisionField[]
}

/** The whole library as one immutable snapshot. */
export interface GraphSnapshot {
  readonly nodes: ReadonlyMap<string, GraphNode>
  readonly edges: readonly GraphEdge[]
  readonly paths: readonly GraphPath[]
  readonly decisions: readonly DecisionLogEntry[]
}

/** Library-wide settings persisted in the manifest. */
export interface GraphSettings {
  /** Cosine threshold; reaching it marks a candidate as a confirmed match (达标). */
  readonly searchThreshold: number
  /**
   * Lowest cosine similarity the semantic channel may return. Candidates below the floor
   * never appear; candidates between the floor and the threshold appear as "未达阈值 · 最接近".
   */
  readonly semanticFloor: number
  /** Legacy node candidate count, kept so older manifests still load. The channel is TOP3. */
  readonly topK: number
  /** Legacy confirmation count, kept so older manifests still load. The channel is TOP3. */
  readonly confirmTop: number
  /** How many keyword candidates the second channel returns, independent of the threshold. */
  readonly keywordTop: number
  /** Lowest keyword score that is not treated as noise. */
  readonly keywordFloor: number
}

/** Default similarity floor for the semantic channel; below it no candidate appears. */
export const DEFAULT_SEMANTIC_FLOOR = 0.3

/**
 * Defaults the user approved: 0.75 threshold and a 0.30 semantic floor. The semantic
 * channel always returns its top three, so `topK` and `confirmTop` are legacy fields the
 * stored manifests may still carry. The keyword channel never sees the threshold; its
 * own top and floor are in settings.
 */
export const DEFAULT_GRAPH_SETTINGS: GraphSettings = {
  searchThreshold: 0.75,
  semanticFloor: DEFAULT_SEMANTIC_FLOOR,
  topK: 5,
  confirmTop: 3,
  keywordTop: KEYWORD_TOP,
  keywordFloor: KEYWORD_FLOOR,
}

/** A user-facing rejection with an HTTP status and a stable code. */
export class GraphError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message)
  }
}

/** Whether a node takes part in search, edges, and execution. */
export function isNodePresent(node: GraphNode | undefined): boolean {
  return node !== undefined && (node.status === 'active' || node.status === 'deprecated')
}

/** Whether a node may appear in a search result. Merged and deleted nodes stay hidden. */
export function isNodeSearchable(node: GraphNode): boolean {
  return node.status === 'active'
}

/** One stable key for an ordered pair. */
export function edgeKey(from: string, to: string): string {
  return `${from}->${to}`
}

/** The edge from `from` to `to`, when it exists. */
export function findEdge(edges: readonly GraphEdge[], from: string, to: string): GraphEdge | undefined {
  return edges.find((edge) => edge.from === from && edge.to === to)
}

/** Every in-edge of one node. */
export function incomingEdges(edges: readonly GraphEdge[], nodeId: string): readonly GraphEdge[] {
  return edges.filter((edge) => edge.to === nodeId)
}

/** Every out-edge of one node. */
export function outgoingEdges(edges: readonly GraphEdge[], nodeId: string): readonly GraphEdge[] {
  return edges.filter((edge) => edge.from === nodeId)
}

/** The ids of all nodes that currently take part in the graph. */
export function presentNodeIds(nodes: ReadonlyMap<string, GraphNode>): Set<string> {
  const ids = new Set<string>()
  for (const node of nodes.values()) if (isNodePresent(node)) ids.add(node.id)
  return ids
}

/**
 * Depth-first reachability following edge direction.
 * @param edges - all edges, filtered by `allowed` while walking.
 * @param from - start node id.
 * @param to - target node id.
 * @param allowed - nodes that may be traversed; edges through soft entries are ignored.
 * @returns the traversed path (including both ends), or undefined when `to` is unreachable.
 */
export function reachablePath(
  edges: readonly GraphEdge[],
  from: string,
  to: string,
  allowed: ReadonlySet<string>,
): string[] | undefined {
  if (!allowed.has(from) || !allowed.has(to)) return undefined
  if (from === to) return [from]
  const stack: string[][] = [[from]]
  const seen = new Set<string>([from])
  while (stack.length > 0) {
    const path = stack.pop() ?? []
    const current = path[path.length - 1] as string
    for (const edge of edges) {
      if (edge.from !== current || !allowed.has(edge.to) || seen.has(edge.to)) continue
      const next = [...path, edge.to]
      if (edge.to === to) return next
      seen.add(edge.to)
      stack.push(next)
    }
  }
  return undefined
}

/** What a dry-run edge check answers. */
export type EdgeCheck =
  | { readonly ok: true }
  | {
    readonly ok: false
    readonly code: 'self-loop' | 'node-missing' | 'node-removed' | 'duplicate' | 'cycle'
    readonly message: string
    /** For `cycle`: the existing route that makes the new edge a loop. */
    readonly cycle?: readonly string[]
  }

/**
 * Check an edge before it is written. This is the only place the editor, the drag
 * preview, and the HTTP route decide whether an edge is legal.
 * @param nodes - every node in the library.
 * @param edges - every existing edge.
 * @param from - proposed source.
 * @param to - proposed target.
 * @returns ok, or a Chinese reason the caller shows as-is.
 */
export function validateNewEdge(
  nodes: ReadonlyMap<string, GraphNode>,
  edges: readonly GraphEdge[],
  from: string,
  to: string,
): EdgeCheck {
  const source = nodes.get(from)
  const target = nodes.get(to)
  if (source === undefined || target === undefined) {
    return { ok: false, code: 'node-missing', message: '节点不存在，无法建边。' }
  }
  if (!isNodePresent(source) || !isNodePresent(target)) {
    return { ok: false, code: 'node-removed', message: '已删除的节点不能建边。' }
  }
  if (from === to) {
    return { ok: false, code: 'self-loop', message: '不能连到自己：一个节点不能指向自身。' }
  }
  if (findEdge(edges, from, to) !== undefined) {
    return { ok: false, code: 'duplicate', message: `已存在「${source.title} → ${target.title}」的边，不能重复添加。` }
  }
  const allowed = presentNodeIds(nodes)
  // The new edge would close a loop exactly when the target can already reach the source.
  const cycle = reachablePath(edges, to, from, allowed)
  if (cycle !== undefined) {
    const titles = cycle.map((id) => nodes.get(id)?.title ?? id)
    return {
      ok: false,
      code: 'cycle',
      message: `会形成环：「${target.title}」已能到达「${source.title}」（${titles.join(' → ')}），拒绝添加。`,
      cycle,
    }
  }
  return { ok: true }
}

/** One defect that makes a path unrunnable. */
export interface PathProblem {
  readonly code:
    | 'empty'
    | 'missing-node'
    | 'node-removed'
    | 'duplicate-node'
    | 'start-mismatch'
    | 'end-mismatch'
    | 'missing-edge'
    | 'missing-predecessor'
  readonly message: string
  readonly node_id?: string
  /** The unsatisfied predecessor for `missing-predecessor`. */
  readonly predecessor_id?: string
}

/**
 * Validate a saved path against the current graph. Every consecutive pair must be an
 * edge, and every in-edge of a step must come from a step that appears earlier in the
 * sequence — otherwise the AND precondition can never be met by executing this path.
 * @param nodes - every node.
 * @param edges - every edge.
 * @param path - the saved path.
 * @returns all problems; empty means the path can be executed as written.
 */
export function pathProblems(
  nodes: ReadonlyMap<string, GraphNode>,
  edges: readonly GraphEdge[],
  path: GraphPath,
): PathProblem[] {
  const problems: PathProblem[] = []
  const sequence = path.node_sequence
  if (sequence.length === 0) {
    problems.push({ code: 'empty', message: '收藏路径为空。' })
    return problems
  }
  const positions = new Map<string, number>()
  sequence.forEach((nodeId, index) => {
    if (!positions.has(nodeId)) positions.set(nodeId, index)
  })
  for (const [index, nodeId] of sequence.entries()) {
    const node = nodes.get(nodeId)
    if (node === undefined) {
      problems.push({ code: 'missing-node', message: `路径第 ${index + 1} 步的节点不存在（${nodeId}）。`, node_id: nodeId })
      continue
    }
    if (!isNodePresent(node)) {
      problems.push({ code: 'node-removed', message: `路径第 ${index + 1} 步「${node.title}」已删除。`, node_id: nodeId })
      continue
    }
    if (positions.get(nodeId) !== index) {
      problems.push({ code: 'duplicate-node', message: `路径重复出现「${node.title}」。`, node_id: nodeId })
    }
    if (index > 0) {
      const previous = sequence[index - 1] as string
      if (findEdge(edges, previous, nodeId) === undefined) {
        const fromTitle = nodes.get(previous)?.title ?? previous
        problems.push({
          code: 'missing-edge',
          message: `路径缺少「${fromTitle} → ${node.title}」的边。`,
          node_id: nodeId,
        })
      }
    }
    for (const edge of edges) {
      if (edge.to !== nodeId) continue
      const source = nodes.get(edge.from)
      if (!isNodePresent(source)) continue
      const sourcePosition = positions.get(edge.from)
      // The graph has no root: any node may start a saved path. A predecessor that is
      // not part of the path therefore belongs to the caller's situation, not to this
      // sequence — it is allowed for the first step only. Later steps must carry every
      // in-edge inside the path, which is what makes the AND check enforceable.
      if (index === 0 && sourcePosition === undefined) continue
      if (sourcePosition === undefined || sourcePosition >= index) {
        problems.push({
          code: 'missing-predecessor',
          message: `「${node.title}」的前置「${source?.title ?? edge.from}」不在路径前面。`,
          node_id: nodeId,
          predecessor_id: edge.from,
        })
      }
    }
  }
  if (sequence[0] !== path.start_node) {
    problems.push({ code: 'start-mismatch', message: '收藏的起始节点与路径首步不一致。' })
  }
  if (sequence[sequence.length - 1] !== path.end_node) {
    problems.push({ code: 'end-mismatch', message: '收藏的结束节点与路径末步不一致。' })
  }
  return problems
}

/** One node in a one-hop neighborhood. */
export interface NeighborhoodNode {
  readonly node: GraphNode
  readonly role: 'anchor' | 'parent' | 'child' | 'sibling'
}

/** The one-hop view the editor renders after an anchor is chosen. */
export interface Neighborhood {
  readonly anchor: GraphNode
  readonly nodes: readonly NeighborhoodNode[]
  readonly edges: readonly GraphEdge[]
  /** True when there is nothing around the anchor yet. */
  readonly isolated: boolean
}

/**
 * Direct predecessors, direct successors, and the other children of those predecessors.
 * Exactly one hop; the editor renders non-anchor entries translucent and clickable.
 * @throws GraphError when the anchor is missing or no longer present.
 */
export function neighborhood(
  nodes: ReadonlyMap<string, GraphNode>,
  edges: readonly GraphEdge[],
  anchorId: string,
): Neighborhood {
  const anchor = nodes.get(anchorId)
  if (anchor === undefined) throw new GraphError('node-missing', '锚点节点不存在。', 404)
  if (!isNodePresent(anchor)) throw new GraphError('node-removed', '已删除的节点不能作为锚点。', 409)
  const allowed = presentNodeIds(nodes)
  const parents = new Set<string>()
  const children = new Set<string>()
  for (const edge of edges) {
    if (!allowed.has(edge.from) || !allowed.has(edge.to)) continue
    if (edge.to === anchorId) parents.add(edge.from)
    if (edge.from === anchorId) children.add(edge.to)
  }
  const siblings = new Set<string>()
  for (const edge of edges) {
    if (!allowed.has(edge.from) || !allowed.has(edge.to)) continue
    if (parents.has(edge.from) && edge.to !== anchorId) siblings.add(edge.to)
  }
  const roleOf = (id: string): NeighborhoodNode['role'] | undefined => {
    if (id === anchorId) return 'anchor'
    if (parents.has(id)) return 'parent'
    if (children.has(id)) return 'child'
    if (siblings.has(id)) return 'sibling'
    return undefined
  }
  const ids = new Set<string>([anchorId, ...parents, ...children, ...siblings])
  const entries: NeighborhoodNode[] = []
  for (const id of ids) {
    const node = nodes.get(id)
    const role = roleOf(id)
    if (node !== undefined && role !== undefined && isNodePresent(node)) entries.push({ node, role })
  }
  const kept = new Set(entries.map((entry) => entry.node.id))
  const visibleEdges = edges.filter((edge) => {
    if (!kept.has(edge.from) || !kept.has(edge.to)) return false
    if (edge.to === anchorId || edge.from === anchorId) return true
    // Parent → sibling is the only other edge the one-hop view needs; sibling → sibling
    // edges belong to a different anchor and would only add noise.
    return parents.has(edge.from) && siblings.has(edge.to)
  })
  return {
    anchor,
    nodes: entries.sort((left, right) => roleOrder(left.role) - roleOrder(right.role) || left.node.title.localeCompare(right.node.title)),
    edges: visibleEdges,
    isolated: entries.length === 1,
  }
}

/** Stable drawing order for the neighborhood legend. */
function roleOrder(role: NeighborhoodNode['role']): number {
  return role === 'anchor' ? 0 : role === 'parent' ? 1 : role === 'child' ? 2 : 3
}

/** The text an embedding is computed from: title, prose, screenshot captions. */
export function nodeSearchText(node: Pick<GraphNode, 'title' | 'description' | 'screenshots'>): string {
  const captions = node.screenshots.map((shot) => shot.caption)
  return [node.title, node.description, ...captions].filter((part) => part.trim() !== '').join('\n')
}

/** The text a path embedding is computed from: name, summary, and each step's title. */
export function pathSearchText(path: Pick<GraphPath, 'name' | 'summary' | 'node_sequence'>, nodes: ReadonlyMap<string, GraphNode>): string {
  const titles = path.node_sequence.map((id) => nodes.get(id)?.title ?? id)
  return [path.name, path.summary, ...titles].join('\n')
}
