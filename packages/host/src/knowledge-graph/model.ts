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
  /**
   * Operator-facing name for this screenshot (rename freely). The file name stays the content
   * hash, so renaming never breaks the binding between "this image is for X" and the bytes.
   */
  readonly name?: string
  /**
   * Who supplied it: the operator (absent or `human`) or the agent's own learning pass (`ai`).
   * Human screenshots are the accuracy standard; AI screenshots only guide the next run.
   */
  readonly source?: 'human' | 'ai'
}

/**
 * One node instance inside a saved path. The same library node may appear more than once:
 * two instances are two positions in the flow, and whether they form a cycle depends on the
 * edges, not on the repetition.
 */
export interface PathGraphNode {
  /** Unique instance key inside this path; never a library id. */
  readonly key: string
  readonly node_id: string
}

/** One directed edge between two instances of the same path. */
export interface PathGraphEdge {
  readonly from: string
  readonly to: string
}

/** The DAG a saved path owns: node instances and the edges between them. */
export interface PathGraph {
  readonly nodes: readonly PathGraphNode[]
  readonly edges: readonly PathGraphEdge[]
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
  /**
   * Agent-maintained supplement, written from real runs: pits, better prompts, and what the
   * next run should watch for. The operator reads the human `description` first as the base,
   * then follows this as the refined guidance. The operator never edits this by hand.
   */
  readonly ai_notes?: string
  /** When the agent last touched {@link ai_notes}. */
  readonly ai_updated_at?: string
  /**
   * Whether the operator keeps this node in the favorites list. Absent means `true`; clearing it
   * only hides the node from the list — the node, its screenshots and every path that references
   * it stay exactly as they are.
   */
  readonly favorite?: boolean
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
  /**
   * Whether the operator keeps this path in the favorites list. Absent means `true`; clearing it
   * only hides the favorite — the path file and the nodes it references stay untouched.
   */
  readonly favorite?: boolean
  /** The owned flow graph. Absent on older paths; `node_sequence` is then the linear fallback. */
  readonly graph?: PathGraph
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
    | 'cycle'
    | 'broken-edge'
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
/** Turn a legacy linear sequence into a path graph (one chain, one entry). */
export function linearPathGraph(sequence: readonly string[]): PathGraph {
  const nodes = sequence.map((nodeId, index) => ({ key: `n${index}`, node_id: nodeId }))
  const edges = nodes.slice(1).map((entry, index) => ({ from: nodes[index]?.key ?? '', to: entry.key }))
  return { nodes, edges }
}

/**
 * Problems in a path's owned graph.
 *
 * A path is a DAG of node *instances*: the same library node may sit at two positions, and that
 * only becomes a cycle when the edges actually lead back. The check is therefore a real cycle
 * detection over the instance graph, not a "did this node repeat" test.
 */
export function pathGraphProblems(
  nodes: ReadonlyMap<string, GraphNode>,
  graph: PathGraph,
  path: GraphPath,
): PathProblem[] {
  const problems: PathProblem[] = []
  if (graph.nodes.length === 0) {
    problems.push({ code: 'empty', message: '路径里还没有节点。' })
    return problems
  }
  const keys = new Set<string>()
  for (const entry of graph.nodes) {
    if (keys.has(entry.key)) problems.push({ code: 'duplicate-node', message: `路径里有重复的节点实例（${entry.key}）。` })
    keys.add(entry.key)
    const node = nodes.get(entry.node_id)
    if (node === undefined) {
      problems.push({ code: 'missing-node', message: `路径引用的节点 ${entry.node_id} 不存在。`, node_id: entry.node_id })
      continue
    }
    if (!isNodePresent(node)) {
      problems.push({ code: 'node-removed', message: `路径引用的节点「${node.title}」已删除。`, node_id: entry.node_id })
    }
  }
  const outgoing = new Map<string, string[]>()
  const indegree = new Map<string, number>()
  for (const entry of graph.nodes) {
    outgoing.set(entry.key, [])
    indegree.set(entry.key, 0)
  }
  for (const edge of graph.edges) {
    if (!keys.has(edge.from) || !keys.has(edge.to)) {
      problems.push({ code: 'broken-edge', message: '路径里有一条边指向不存在的节点。' })
      continue
    }
    if (edge.from === edge.to) {
      problems.push({ code: 'cycle', message: '节点不能连向自己。' })
      continue
    }
    outgoing.get(edge.from)?.push(edge.to)
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1)
  }
  // Kahn's algorithm: unvisited nodes mean the flow contains a cycle.
  const queue = graph.nodes.map(entry => entry.key).filter(key => (indegree.get(key) ?? 0) === 0)
  const visited = new Set<string>()
  while (queue.length > 0) {
    const key = queue.shift() as string
    if (visited.has(key)) continue
    visited.add(key)
    for (const next of outgoing.get(key) ?? []) {
      indegree.set(next, (indegree.get(next) ?? 1) - 1)
      if ((indegree.get(next) ?? 0) === 0) queue.push(next)
    }
  }
  if (visited.size !== graph.nodes.length) {
    problems.push({ code: 'cycle', message: '路径里存在环：沿着箭头走能绕回已经走过的节点。' })
  }
  if (path.start_node !== '' && !graph.nodes.some(entry => entry.node_id === path.start_node)) {
    problems.push({ code: 'start-mismatch', message: '记录的起点不在路径里。' })
  }
  if (path.end_node !== '' && !graph.nodes.some(entry => entry.node_id === path.end_node)) {
    problems.push({ code: 'end-mismatch', message: '记录的终点不在路径里。' })
  }
  return problems
}

/**
 * Problems that keep a saved path from being usable.
 *
 * A path is an independently stored reference list: it names an ordered run of nodes and owns
 * nothing else. Consecutive steps are *not* required to share a graph edge — the saved order is
 * the relation — so the structural rules are only that every step still exists, no step repeats
 * (a repeat is a cycle inside the path), and the recorded start/end match the sequence.
 * Node edges stay in the library for the relationship view; a saved path no longer depends on
 * them.
 * @param nodes - every node.
 * @param _edges - every edge (kept for signature compatibility; paths no longer read them).
 * @param path - the saved path.
 * @returns all problems; empty means the sequence is usable as written.
 */
export function pathProblems(
  nodes: ReadonlyMap<string, GraphNode>,
  _edges: readonly GraphEdge[],
  path: GraphPath,
): PathProblem[] {
  if (path.graph !== undefined) return pathGraphProblems(nodes, path.graph, path)
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
      problems.push({ code: 'duplicate-node', message: `路径重复出现「${node.title}」，形成环。`, node_id: nodeId })
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

/** One operator-editable common-sense entry: global guidance the ball reads before any path. */
export interface CommonSenseEntry {
  readonly id: string
  /** Operator text, at most 100 characters. */
  readonly text: string
  /** Illustrations for this entry; only the operator edits them, from the library page. */
  readonly images?: readonly CommonSenseImage[]
}

/** One image attached to a common-sense entry. */
export interface CommonSenseImage {
  /** File name inside the library's `common-sense/` folder. */
  readonly file: string
  readonly name?: string
}

/** The whole common-sense area, edited only by the operator. */
export interface CommonSense {
  readonly entries: readonly CommonSenseEntry[]
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
