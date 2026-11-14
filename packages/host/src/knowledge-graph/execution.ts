/**
 * Execution-time validation for one saved path.
 *
 * A run walks the saved sequence in order. After each step the model (the caller) says
 * whether it met its description; this module never inspects the screen itself. Every
 * in-edge of the next step must come from a step that is `met` or `skipped` — that is
 * the AND rule. While one is missing the run refuses to advance and reports the
 * concrete choices: re-run the missing step, mark it skipped, or edit the consumer's
 * in-edge.
 */

import {
  GraphError,
  incomingEdges,
  isNodePresent,
  pathProblems,
  type GraphEdge,
  type GraphNode,
  type GraphPath,
} from './model.ts'

/** What one executed step is waiting for. */
export type StepStatus = 'pending' | 'met' | 'unmet' | 'skipped'

/** One step of a run. */
export interface RunStep {
  readonly node_id: string
  readonly title: string
  readonly status: StepStatus
  /** The model's sentence for the latest verdict. */
  readonly reason: string | null
  /** Unix milliseconds of the latest verdict. */
  readonly judged_at: number | null
}

/** A missing predecessor that keeps a step from running. */
export interface MissingPredecessor {
  readonly node_id: string
  readonly title: string
  readonly status: StepStatus
}

/** One blocked consumer and the predecessors it is still missing. */
export interface StepBlocker {
  readonly node_id: string
  readonly title: string
  readonly missing: readonly MissingPredecessor[]
  /** The sentence the operator sees, options included. */
  readonly message: string
}

/** The snapshot the editor renders for one run. */
export interface RunView {
  readonly id: string
  readonly path_id: string
  readonly path_name: string
  readonly steps: readonly RunStep[]
  /** The first step that is not met/skipped, or null when the run is complete. */
  readonly current_node_id: string | null
  readonly current_title: string | null
  readonly ready: boolean
  readonly blocked: boolean
  readonly complete: boolean
  /** Why the current step cannot start; empty when it is ready. */
  readonly current_missing: readonly MissingPredecessor[]
  /** Every pending step whose in-edges are still unsatisfied. */
  readonly blockers: readonly StepBlocker[]
  /** The one sentence shown at the top of the execution panel. */
  readonly message: string
}

/** In-memory state of one run. */
export interface ExecutionRun {
  readonly id: string
  readonly path_id: string
  readonly path_name: string
  readonly sequence: readonly string[]
  readonly statuses: Readonly<Record<string, StepStatus>>
  readonly reasons: Readonly<Record<string, string | null>>
  readonly judged_at: Readonly<Record<string, number | null>>
  readonly created_at: number
}

/** Render one node name in corner quotes. */
function quoted(title: string): string {
  return `「${title}」`
}

/** The approved blocker sentence for one consumer. */
function blockerSentence(consumerTitle: string, missing: readonly MissingPredecessor[]): string {
  const names = missing.map((entry) => quoted(entry.title)).join('、')
  return `${quoted(consumerTitle)}需要${names}的产出，当前缺失；可选：补执行${names} / 标记${names}跳过 / 修改${quoted(consumerTitle)}的入边`
}

/** Predecessors of a step that are present in the graph. */
function presentPredecessors(
  nodes: ReadonlyMap<string, GraphNode>,
  edges: readonly GraphEdge[],
  nodeId: string,
): GraphNode[] {
  return incomingEdges(edges, nodeId)
    .map((edge) => nodes.get(edge.from))
    .filter((node): node is GraphNode => node !== undefined && isNodePresent(node))
}

/**
 * Create one run for a path. Refuses a path whose saved sequence no longer matches the
 * graph, so a broken index never starts half-way.
 * @param path - the saved path.
 * @param nodes - current nodes.
 * @param edges - current edges.
 * @param id - run id minted by the caller.
 * @throws GraphError `path-unrunnable` listing every problem.
 */
export function createExecutionRun(
  path: GraphPath,
  nodes: ReadonlyMap<string, GraphNode>,
  edges: readonly GraphEdge[],
  id: string,
): ExecutionRun {
  const problems = pathProblems(nodes, edges, path)
  if (problems.length > 0) {
    throw new GraphError(
      'path-unrunnable',
      `收藏「${path.name}」当前不可执行：${problems.map((problem) => problem.message).join('；')}`,
      409,
    )
  }
  const statuses: Record<string, StepStatus> = {}
  const reasons: Record<string, string | null> = {}
  const judgedAt: Record<string, number | null> = {}
  for (const nodeId of path.node_sequence) {
    statuses[nodeId] = 'pending'
    reasons[nodeId] = null
    judgedAt[nodeId] = null
  }
  return {
    id,
    path_id: path.id,
    path_name: path.name,
    sequence: path.node_sequence,
    statuses,
    reasons,
    judged_at: judgedAt,
    created_at: Date.now(),
  }
}

/** A satisfied source: the step actually met its description or the human skipped it. */
function satisfied(status: StepStatus | undefined): boolean {
  return status === 'met' || status === 'skipped'
}

/** Build the current view of a run against the graph as it is now. */
export function viewExecutionRun(
  run: ExecutionRun,
  nodes: ReadonlyMap<string, GraphNode>,
  edges: readonly GraphEdge[],
): RunView {
  const steps: RunStep[] = run.sequence.map((nodeId) => ({
    node_id: nodeId,
    title: nodes.get(nodeId)?.title ?? nodeId,
    status: run.statuses[nodeId] ?? 'pending',
    reason: run.reasons[nodeId] ?? null,
    judged_at: run.judged_at[nodeId] ?? null,
  }))
  const currentIndex = steps.findIndex((step) => step.status !== 'met' && step.status !== 'skipped')
  const current = currentIndex === -1 ? undefined : steps[currentIndex]
  const missingOf = (nodeId: string): MissingPredecessor[] => presentPredecessors(nodes, edges, nodeId)
    // A predecessor outside this path is part of the caller's situation; pathProblems
    // allows that only on the first step, where it cannot be judged by this run. A
    // later external predecessor is still a hard blocker.
    .filter((node) => run.sequence.includes(node.id) || nodeId !== run.sequence[0])
    .filter((node) => !satisfied(run.statuses[node.id]))
    .map((node) => ({
      node_id: node.id,
      title: node.title,
      status: run.statuses[node.id] ?? 'pending',
    }))
  const currentMissing = current === undefined ? [] : current.status === 'unmet' ? [] : missingOf(current.node_id)
  const blockers: StepBlocker[] = []
  for (const step of steps) {
    if (step.status === 'met' || step.status === 'skipped') continue
    if (step.status === 'unmet') continue
    const missing = missingOf(step.node_id)
    if (missing.length === 0) continue
    blockers.push({
      node_id: step.node_id,
      title: step.title,
      missing,
      message: blockerSentence(step.title, missing),
    })
  }
  const failed = current !== undefined && current.status === 'unmet'
  let message: string
  if (current === undefined) {
    message = `收藏「${run.path_name}」已执行完毕（所有步骤达标或跳过）。`
  } else if (failed) {
    const dependent = blockers.find((blocker) => blocker.missing.some((entry) => entry.node_id === current.node_id))
    message = dependent === undefined
      ? `${quoted(current.title)}未达标，收藏在此停止；可以先补执行该步，或人工确认后标记跳过。`
      : `${quoted(current.title)}未达标，${dependent.message}`
  } else if (currentMissing.length > 0) {
    message = blockerSentence(current.title, currentMissing)
  } else {
    message = `轮到${quoted(current.title)}：执行完成后由模型判定是否达标。`
  }
  return {
    id: run.id,
    path_id: run.path_id,
    path_name: run.path_name,
    steps,
    current_node_id: current?.node_id ?? null,
    current_title: current?.title ?? null,
    ready: current !== undefined && current.status === 'pending' && currentMissing.length === 0,
    blocked: current !== undefined && (failed || currentMissing.length > 0),
    complete: current === undefined,
    current_missing: currentMissing,
    blockers,
    message,
  }
}

/** Why a verdict cannot be recorded right now. */
function assertCurrent(run: ExecutionRun, nodeId: string, nodes: ReadonlyMap<string, GraphNode>, edges: readonly GraphEdge[]): void {
  const view = viewExecutionRun(run, nodes, edges)
  if (view.complete) throw new GraphError('run-complete', '这条收藏已经执行完毕。', 409)
  if (view.current_node_id !== nodeId) {
    throw new GraphError(
      'run-blocked',
      `当前只能判定${quoted(view.current_title ?? '')}；只有它的入边全部满足后才能继续往后执行。`,
      409,
    )
  }
  if (view.blocked) throw new GraphError('run-blocked', view.message, 409)
}

/**
 * Record the model's verdict for the current step.
 * @param run - current run.
 * @param nodeId - step being judged; must be the current step.
 * @param verdict - `met`, `unmet`, or `skipped` (a human override).
 * @param reason - one sentence from the model / operator.
 * @param nodes - current nodes.
 * @param edges - current edges.
 * @param now - timestamp injection for tests.
 * @returns the next run state and its view.
 * @throws GraphError when the step is not the current ready step.
 */
export function judgeStep(
  run: ExecutionRun,
  nodeId: string,
  verdict: 'met' | 'unmet' | 'skipped',
  reason: string,
  nodes: ReadonlyMap<string, GraphNode>,
  edges: readonly GraphEdge[],
  now = Date.now(),
): { run: ExecutionRun; view: RunView } {
  assertCurrent(run, nodeId, nodes, edges)
  const next: ExecutionRun = {
    ...run,
    statuses: { ...run.statuses, [nodeId]: verdict },
    reasons: { ...run.reasons, [nodeId]: reason },
    judged_at: { ...run.judged_at, [nodeId]: now },
  }
  return { run: next, view: viewExecutionRun(next, nodes, edges) }
}

/**
 * Put a step back to `pending`. This is the "补执行" option: an earlier failed or
 * skipped step is resent, and the run stops at it again.
 */
export function resetStep(
  run: ExecutionRun,
  nodeId: string,
  nodes: ReadonlyMap<string, GraphNode>,
  edges: readonly GraphEdge[],
): { run: ExecutionRun; view: RunView } {
  if (!(nodeId in run.statuses)) throw new GraphError('step-missing', '这个节点不在这条收藏里。', 404)
  const next: ExecutionRun = {
    ...run,
    statuses: { ...run.statuses, [nodeId]: 'pending' },
    reasons: { ...run.reasons, [nodeId]: null },
    judged_at: { ...run.judged_at, [nodeId]: null },
  }
  return { run: next, view: viewExecutionRun(next, nodes, edges) }
}

/**
 * The approved human option "标记 B 跳过". Only the current step or an unsatisfied
 * predecessor named by a blocker may be skipped.
 */
export function skipStep(
  run: ExecutionRun,
  nodeId: string,
  reason: string,
  nodes: ReadonlyMap<string, GraphNode>,
  edges: readonly GraphEdge[],
  now = Date.now(),
): { run: ExecutionRun; view: RunView } {
  if (!(nodeId in run.statuses)) throw new GraphError('step-missing', '这个节点不在这条收藏里。', 404)
  const view = viewExecutionRun(run, nodes, edges)
  const allowed = nodeId === view.current_node_id || view.blockers.some((blocker) => blocker.missing.some((entry) => entry.node_id === nodeId))
  if (!allowed) {
    throw new GraphError('skip-not-allowed', '只能跳过当前步骤，或跳过阻塞提示里缺失的前置步骤。', 409)
  }
  const next: ExecutionRun = {
    ...run,
    statuses: { ...run.statuses, [nodeId]: 'skipped' },
    reasons: { ...run.reasons, [nodeId]: reason },
    judged_at: { ...run.judged_at, [nodeId]: now },
  }
  return { run: next, view: viewExecutionRun(next, nodes, edges) }
}
