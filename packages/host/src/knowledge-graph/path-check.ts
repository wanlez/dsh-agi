/**
 * Static pre-flight check for one saved path.
 *
 * This is the only "test" the editor offers: it never starts a run, touches the desktop, or
 * asks a model for a verdict. The structural rules (a step may not repeat, every step's
 * predecessors must appear earlier, the first and last step must match the recorded start and
 * end, consecutive steps must be connected) already live in `pathProblems`; this module reuses
 * that single source instead of re-implementing it, and adds the field checks a run needs.
 * @module knowledge-graph/path-check
 */

import { pathProblems, type GraphEdge, type GraphNode, type GraphPath, type PathProblem } from './model.ts'

/** One problem the static check found. */
export interface PathCheckIssue {
  /** A structural problem code from the graph model, or a field problem this module owns. */
  readonly code: PathProblem['code'] | 'empty-title' | 'empty-description' | 'empty-name' | 'empty-summary'
  /** Node the issue belongs to, when it belongs to one. */
  readonly node_id?: string
  /** Operator-facing sentence. */
  readonly message: string
}

/** Result of checking one path against the current graph. */
export interface PathCheckResult {
  readonly path_id: string
  readonly name: string
  /** True when the path has no issue at all. */
  readonly runnable: boolean
  readonly step_count: number
  readonly issues: readonly PathCheckIssue[]
}

/**
 * Check a path without touching anything.
 * @param path - saved path to inspect.
 * @param nodes - every live node in the library.
 * @param edges - every live edge in the library.
 * @returns the issues found, and whether the path is runnable.
 */
export function checkPath(
  path: GraphPath,
  nodes: ReadonlyMap<string, GraphNode>,
  edges: readonly GraphEdge[],
): PathCheckResult {
  // Structure first: empty sequence, missing or deleted steps, a repeated step (which is what a
  // cycle inside one saved path would look like), a missing edge between consecutive steps, a
  // predecessor that is not earlier in the path, and a start/end that no longer matches.
  const issues: PathCheckIssue[] = pathProblems(nodes, edges, path).map(problem => ({
    code: problem.code,
    message: problem.message,
    ...problem.node_id === undefined ? {} : { node_id: problem.node_id },
  }))

  // Fields the run reads but the graph model does not judge.
  for (const nodeId of path.node_sequence) {
    const node = nodes.get(nodeId)
    if (node === undefined) continue
    if (node.title.trim() === '') {
      issues.push({ code: 'empty-title', node_id: nodeId, message: `节点 ${nodeId} 的标题为空。` })
    }
    if (node.description.trim() === '') {
      issues.push({ code: 'empty-description', node_id: nodeId, message: `「${node.title}」没有填写说明。` })
    }
  }
  if (path.name.trim() === '') issues.push({ code: 'empty-name', message: '收藏没有名称。' })
  if (path.summary.trim() === '') issues.push({ code: 'empty-summary', message: '收藏没有摘要（检索会读它）。' })

  return {
    path_id: path.id,
    name: path.name,
    runnable: issues.length === 0,
    step_count: path.node_sequence.length,
    issues,
  }
}
