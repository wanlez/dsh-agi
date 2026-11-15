/**
 * The one shape every "show me this path" surface renders.
 *
 * A saved path is a directed acyclic graph of node *instances*: the same library node may sit at
 * two positions, and the edges decide how the flow actually runs. Faithful rendering therefore
 * needs both the instance list and the edges; the editor's path view, the operator's review
 * screen, and any future surface all want the same ordered, titled steps with the context a
 * person needs to read the flow. Resolving it here keeps the rendering dumb and the ordering
 * identical everywhere.
 * @module knowledge-graph/path-view
 */

import { linearPathGraph, type GraphNode, type GraphPath } from './model.ts'

/** One step of a path as a reader sees it. */
export interface PathStepView {
  /** 1-based position in the flow. */
  readonly index: number
  readonly node_id: string
  readonly title: string
  readonly description: string
  /** True when the node no longer exists in the library. */
  readonly missing: boolean
  /** Captions of the accuracy screenshots, in stored order. */
  readonly screenshots: readonly string[]
}

/** One flow edge between two step instances, as 0-based indices into {@link PathView.steps}. */
export interface PathEdgeView {
  readonly from: number
  readonly to: number
}

/** A saved path resolved for display. */
export interface PathView {
  readonly path_id: string
  readonly name: string
  readonly summary: string
  readonly step_count: number
  readonly steps: readonly PathStepView[]
  /**
   * Edges between instances, 0-based indices into {@link steps}. A path saved without its own
   * graph is one linear chain, so its edges are `0→1, 1→2, …`.
   */
  readonly edges: readonly PathEdgeView[]
}

/**
 * Resolve one saved path into ordered, titled steps plus the edges between them.
 * @param path - saved path.
 * @param nodes - every live node in the library.
 * @returns the display shape; missing nodes keep their position with `missing: true`.
 */
export function pathView(path: GraphPath, nodes: ReadonlyMap<string, GraphNode>): PathView {
  // Older path files have no owned graph; the linear sequence is then the whole flow. An empty
  // graph is treated the same way so a hand-damaged file still renders its steps.
  const graph = path.graph !== undefined && path.graph.nodes.length > 0
    ? path.graph
    : linearPathGraph(path.node_sequence)
  const positionOf = new Map<string, number>()
  graph.nodes.forEach((entry, offset) => { positionOf.set(entry.key, offset) })
  const steps = graph.nodes.map((entry, offset): PathStepView => {
    const node = nodes.get(entry.node_id)
    return {
      index: offset + 1,
      node_id: entry.node_id,
      title: node?.title ?? '（节点已不存在）',
      description: node?.description ?? '',
      missing: node === undefined,
      screenshots: (node?.screenshots ?? []).map(shot => shot.caption),
    }
  })
  const edges: PathEdgeView[] = []
  for (const edge of graph.edges) {
    const from = positionOf.get(edge.from)
    const to = positionOf.get(edge.to)
    // Broken edges are reported by the model's checks; display simply drops them.
    if (from !== undefined && to !== undefined) edges.push({ from, to })
  }
  return {
    path_id: path.id,
    name: path.name,
    summary: path.summary,
    step_count: steps.length,
    steps,
    edges,
  }
}

/**
 * Render the instance flow as chain lines, e.g. `1 → 2 → 3`.
 *
 * Numbers are 1-based step positions. The flow head starts the line; a branch continues on its
 * own indented line so `steps` (positions) and `edges` (which position follows which) stay
 * readable in a prompt or a plain text panel.
 * @param view - step count and instance edges.
 * @returns one line per chain, branches indented with `↳`.
 */
export function pathFlowText(view: Pick<PathView, 'step_count' | 'edges'>): string[] {
  const outgoing = new Map<number, number[]>()
  const indegree = new Map<number, number>()
  for (let index = 0; index < view.step_count; index += 1) {
    outgoing.set(index, [])
    indegree.set(index, 0)
  }
  for (const edge of view.edges) {
    if (edge.from === edge.to) continue
    const targets = outgoing.get(edge.from)
    if (targets === undefined || !indegree.has(edge.to)) continue
    targets.push(edge.to)
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1)
  }
  const visited = new Set<number>()
  const chains: { readonly depth: number; readonly ids: readonly number[] }[] = []
  const pending: { readonly start: number; readonly depth: number }[] = []
  const walk = (start: number, depth: number): void => {
    visited.add(start)
    const ids: number[] = [start]
    let current = start
    for (;;) {
      const children = outgoing.get(current) ?? []
      const first = children[0]
      // The first successor continues the line; every other one starts a branch of its own.
      for (const branch of children.slice(1)) {
        if (!visited.has(branch)) pending.push({ start: branch, depth: depth + 1 })
      }
      if (first === undefined) break
      if (visited.has(first)) {
        // A merge point or a loop: show where the chain ends without walking it twice.
        ids.push(first)
        break
      }
      visited.add(first)
      ids.push(first)
      current = first
    }
    chains.push({ depth, ids })
  }
  const run = (start: number, depth: number): void => {
    if (visited.has(start)) return
    walk(start, depth)
    while (pending.length > 0) {
      const next = pending.shift() as { readonly start: number; readonly depth: number }
      if (!visited.has(next.start)) walk(next.start, next.depth)
    }
  }
  const roots = [...indegree.keys()]
    .filter(key => (indegree.get(key) ?? 0) === 0)
    .sort((left, right) => left - right)
  for (const root of roots) run(root, 0)
  // A cycle (never saved by the checks, but possible in a hand-edited file) has no root; show
  // its instances anyway instead of hiding them.
  for (let index = 0; index < view.step_count; index += 1) run(index, 0)
  return chains.map((chain) => {
    const prefix = chain.depth === 0 ? '' : `${'  '.repeat(chain.depth)}↳ `
    return `${prefix}${chain.ids.map(id => id + 1).join(' → ')}`
  })
}
