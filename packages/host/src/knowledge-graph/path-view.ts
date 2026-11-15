/**
 * The one shape every "show me this path" surface renders.
 *
 * A saved path is an ordered list of node ids; the editor's path view, the operator's review
 * screen, and any future surface all want the same ordered, titled steps with the context a
 * person needs to read the flow. Resolving it here keeps the rendering dumb and the ordering
 * identical everywhere.
 * @module knowledge-graph/path-view
 */

import type { GraphNode, GraphPath } from './model.ts'

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

/** A saved path resolved for display. */
export interface PathView {
  readonly path_id: string
  readonly name: string
  readonly summary: string
  readonly step_count: number
  readonly steps: readonly PathStepView[]
}

/**
 * Resolve one saved path into ordered, titled steps.
 * @param path - saved path.
 * @param nodes - every live node in the library.
 * @returns the display shape; missing nodes keep their position with `missing: true`.
 */
export function pathView(path: GraphPath, nodes: ReadonlyMap<string, GraphNode>): PathView {
  const steps = path.node_sequence.map((nodeId, offset): PathStepView => {
    const node = nodes.get(nodeId)
    return {
      index: offset + 1,
      node_id: nodeId,
      title: node?.title ?? '（节点已不存在）',
      description: node?.description ?? '',
      missing: node === undefined,
      screenshots: (node?.screenshots ?? []).map(shot => shot.caption),
    }
  })
  return {
    path_id: path.id,
    name: path.name,
    summary: path.summary,
    step_count: steps.length,
    steps,
  }
}
