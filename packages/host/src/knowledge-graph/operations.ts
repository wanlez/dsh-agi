/**
 * The editor's 操作记录 tab, in Chinese.
 *
 * The append-only `decision_log.jsonl` stores ids (stable, machine-readable). The tab must
 * never show one: every row here is built from the node titles in the snapshot, so a line
 * such as `node-1a2b3c4d` can never leak into the rendered HTML. A title that is empty
 * reads 未命名节点, a node whose status is `deleted` reads 『标题』（已删除）, and an operator
 * recorded as the default `human` reads 本机用户.
 *
 * `merge` / `judge_same` lines are history: this build does not write them any more, but
 * a log written by an older build still renders as a readable Chinese sentence.
 */

import type { DecisionField, DecisionLogEntry, GraphNode } from './model.ts'

/** One node a row refers to, already reduced to display text. */
export interface OperationTitle {
  /** Chinese title, or 未命名节点 when the node is missing or its title is blank. */
  readonly title: string
  /** True when the node is soft deleted, so the row appends （已删除）. */
  readonly deleted: boolean
}

/** One candidate in the 参考候选 line. */
export interface OperationCandidateRow extends OperationTitle {
  /** Similarity at the time of the decision; null when the channel had no score. */
  readonly similarity: number | null
}

/** One display row; it deliberately carries no node, path, or decision ids. */
export interface OperationRow {
  /** ISO timestamp the row was recorded. */
  readonly ts: string
  /** Stable action code, kept for tests and for styling; never an id. */
  readonly action: string
  /** Short Chinese verb phrase, e.g. 新建节点. */
  readonly action_label: string
  /** Full Chinese sentence, e.g. 新建节点『进入天翼云电脑』. */
  readonly sentence: string
  /** Node the row is about, already display-ready. */
  readonly node_title: string
  /** True when that node is soft deleted. */
  readonly node_deleted: boolean
  /** Original Chinese detail line from the log (rendered as-is). */
  readonly diff_summary: string
  /** Candidates that were considered, with Chinese titles only. */
  readonly candidates: readonly OperationCandidateRow[]
  /** Similarity recorded for the row itself, when any. */
  readonly similarity: number | null
  /** Chinese title of the chosen node, when the action chose one. */
  readonly chosen_title: string | null
  /** Operator name, or 本机用户 for the default `human` / `unknown` values. */
  readonly operator: string
  /** Fields an `update` touched, in display order. */
  readonly fields: readonly DecisionField[]
}

/** Placeholder for an empty or missing title. */
export const UNNAMED_NODE = '未命名节点'

/** Placeholder for the default operator recorded by the editor. */
export const LOCAL_OPERATOR = '本机用户'

const ACTION_LABELS: Readonly<Record<string, string>> = {
  create: '新建节点',
  update: '修改节点',
  reuse: '复用节点',
  copy: '复制节点',
  split: '拆分节点',
  delete_edge: '删除连线',
  delete_node: '删除节点',
  restore: '恢复节点',
  merge: '合并节点',
  judge_same: '判定同一节点',
}

const FIELD_WORDS: Readonly<Record<DecisionField, string>> = {
  title: '标题',
  description: '说明',
}

/** Reduce one node (or a missing one) to its display title. */
function titleOf(node: GraphNode | undefined): OperationTitle {
  if (node === undefined) return { title: UNNAMED_NODE, deleted: false }
  const title = node.title.trim()
  return { title: title === '' ? UNNAMED_NODE : title, deleted: node.status === 'deleted' }
}

/** 『标题』, with （已删除） outside the bracket when the node is soft deleted. */
function quoted(value: OperationTitle): string {
  return `『${value.title}』${value.deleted ? '（已删除）' : ''}`
}

/** Resolve one id without ever echoing it back. */
function resolve(nodes: ReadonlyMap<string, GraphNode>, id: string | null | undefined): OperationTitle | undefined {
  if (id === undefined || id === null || id === '') return undefined
  return titleOf(nodes.get(id))
}

/** 标题 / 说明 / 标题和说明. */
function fieldWords(fields: readonly DecisionField[]): string {
  const known = fields.filter((field) => field in FIELD_WORDS)
  if (known.length === 0) return '内容'
  return known.map((field) => FIELD_WORDS[field]).join('和')
}

/** The operator shown to the user. */
function operatorName(raw: string): string {
  const trimmed = raw.trim()
  // `human` is the editor's default, `unknown` is a corrupt line, `legacy-import` is the
  // one-shot importer — all three ran locally, so they read as the local operator.
  if (trimmed === '' || trimmed === 'human' || trimmed === 'unknown' || trimmed === 'legacy-import') return LOCAL_OPERATOR
  return trimmed
}

/**
 * Build the Chinese sentence for one log line.
 * @param entry - the raw log line.
 * @param nodes - every node in the snapshot, including soft deleted ones.
 */
function sentenceOf(entry: DecisionLogEntry, nodes: ReadonlyMap<string, GraphNode>): string {
  const node = resolve(nodes, entry.node_id)
  const subject = node === undefined ? quoted({ title: UNNAMED_NODE, deleted: false }) : quoted(node)
  const chosen = resolve(nodes, entry.chosen)
  const source = entry.candidates.length === 0 ? undefined : resolve(nodes, (entry.candidates[0] as { node_id: string }).node_id)
  switch (entry.action) {
    case 'create':
      return source === undefined
        ? `新建节点${subject}`
        : `新建节点${subject}（以${quoted(source)}为起点）`
    case 'update':
      return `修改节点${subject}的${fieldWords(entry.fields ?? [])}`
    case 'copy':
      return source === undefined
        ? `复制节点${subject}`
        : `复制节点${subject}（来源${quoted(source)}）`
    case 'reuse':
      return `复用节点${subject}`
    case 'split':
      return `拆分节点${subject}`
    case 'delete_edge':
      return chosen === undefined ? `删除连线：${subject}` : `删除连线：${subject}→${quoted(chosen)}`
    case 'delete_node':
      return `删除节点${subject}`
    case 'restore':
      return `恢复节点${subject}`
    case 'merge':
      return chosen === undefined ? `合并节点${subject}` : `把${subject}合并到${quoted(chosen)}`
    case 'judge_same':
      return chosen === undefined ? `判定同一节点${subject}` : `判定${subject}与${quoted(chosen)}为同一节点`
    default:
      return `节点操作${subject}`
  }
}

/**
 * Turn raw decision lines into the rows the 操作记录 tab renders.
 * @param decisions - entries in log order (oldest first).
 * @param nodes - every node in the snapshot, so deleted titles still resolve.
 * @param limit - newest rows to keep; the log is read tail-first like the old tab.
 * @returns newest first, Chinese only, with no ids.
 */
export function operationRows(
  decisions: readonly DecisionLogEntry[],
  nodes: ReadonlyMap<string, GraphNode>,
  limit = 100,
): OperationRow[] {
  const tail = decisions.slice(-Math.max(1, limit)).reverse()
  return tail.map((entry) => {
    const node = resolve(nodes, entry.node_id) ?? { title: UNNAMED_NODE, deleted: false }
    const candidates: OperationCandidateRow[] = entry.candidates.map((candidate) => {
      const title = resolve(nodes, candidate.node_id) ?? { title: UNNAMED_NODE, deleted: false }
      return { title: title.title, deleted: title.deleted, similarity: candidate.similarity }
    })
    const chosen = resolve(nodes, entry.chosen)
    return {
      ts: entry.ts,
      action: entry.action,
      action_label: ACTION_LABELS[entry.action] ?? '节点操作',
      sentence: sentenceOf(entry, nodes),
      node_title: node.title,
      node_deleted: node.deleted,
      diff_summary: entry.diff_summary,
      candidates,
      similarity: entry.similarity,
      chosen_title: chosen === undefined ? null : chosen.title,
      operator: operatorName(entry.operator),
      fields: entry.fields ?? [],
    }
  })
}
