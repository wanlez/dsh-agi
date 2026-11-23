/**
 * Web flows: the deterministic runner.
 *
 * A flow is a list of steps with a target name and an expectation. The runner resolves every
 * target by rule (the same normalization web_find uses), acts only on a unique hit, and checks
 * every expectation before moving on. No model is involved: a successful run costs only local
 * page reads.
 *
 * Flows live beside the experience library, so they survive an uninstall (the library folder is
 * kept) and travel with a moved library.
 * @module web/flow
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { BrowserChannel } from './tools.ts'

/** One step of a flow. */
export interface FlowStep {
  /** click / type / select / hover / press / wait / open / back */
  action: 'click' | 'type' | 'select' | 'hover' | 'press' | 'wait' | 'open' | 'back'
  /** Control name for click/type/select/hover; URL for open; key for press. */
  target?: string
  /** Text to type, or the option to select. */
  value?: string
  /** Optional role filter for resolution. */
  role?: string
  /** What must be true after the step; missing means "no check", which the runner flags. */
  expect?: {
    urlContains?: string
    text?: string
    timeoutMs?: number
  }
}

/** A saved flow. */
export interface WebFlow {
  id: string
  name: string
  /** The experience-library path this flow belongs to, when it has one. */
  path_id?: string
  createdAt: number
  updatedAt: number
  steps: FlowStep[]
}

/** What one step did. */
export interface FlowStepResult {
  index: number
  action: FlowStep['action']
  target: string
  ok: boolean
  resolved?: string
  detail?: string
  elapsedMs: number
}

/** The runner's answer for a whole flow. */
export interface FlowRun {
  flow: string
  dryRun: boolean
  ok: boolean
  stoppedAt?: number
  reason?: string
  steps: FlowStepResult[]
  elapsedMs: number
}

const FILE = 'web-flows.json'

interface FlowFile {
  flows: WebFlow[]
}

function flowFile(dir: string): string {
  return join(dir, FILE)
}

/** Read every saved flow; a broken file reads as none rather than failing the tool. */
export function listFlows(dir: string): WebFlow[] {
  try {
    const parsed = JSON.parse(readFileSync(flowFile(dir), 'utf8')) as Partial<FlowFile>
    return Array.isArray(parsed.flows) ? parsed.flows.filter((flow) => typeof flow?.id === 'string' && typeof flow?.name === 'string') : []
  } catch {
    return []
  }
}

/** Save (create or replace by name/id) one flow. */
export function saveFlow(dir: string, flow: { id?: string, name: string, path_id?: string, steps: FlowStep[] }): WebFlow {
  const flows = listFlows(dir)
  const now = Date.now()
  const existing = flows.find((item) => (flow.id !== undefined && item.id === flow.id) || item.name === flow.name)
  const next: WebFlow = existing === undefined
    ? { id: randomUUID(), name: flow.name, ...flow.path_id === undefined ? {} : { path_id: flow.path_id }, createdAt: now, updatedAt: now, steps: flow.steps }
    : { ...existing, name: flow.name, ...flow.path_id === undefined ? {} : { path_id: flow.path_id }, updatedAt: now, steps: flow.steps }
  const index = flows.findIndex((item) => item.id === next.id)
  if (index >= 0) flows[index] = next
  else flows.push(next)
  mkdirSync(dir, { recursive: true })
  writeFileSync(flowFile(dir), `${JSON.stringify({ flows }, null, 2)}\n`)
  return next
}

/** Find a flow by id or exact name. */
export function findFlow(dir: string, idOrName: string): WebFlow | undefined {
  return listFlows(dir).find((flow) => flow.id === idOrName || flow.name === idOrName)
}

/**
 * Run a flow against the browser channel.
 *
 * `dryRun` only resolves each target (and reports duplicates) so the operator can confirm what
 * would be clicked before anything happens. Every real step must carry `expect`; a step without
 * one is refused because "clicked and assumed success" is exactly the failure mode this runner
 * exists to prevent.
 */
export async function runFlow(
  channel: BrowserChannel,
  flow: WebFlow,
  options: { dryRun?: boolean } = {},
): Promise<FlowRun> {
  const dryRun = options.dryRun === true
  const started = Date.now()
  const results: FlowStepResult[] = []
  for (const [index, step] of flow.steps.entries()) {
    const stepStarted = Date.now()
    const target = step.target ?? ''
    try {
      // Preparation actions (hover a menu, press a key, go back) have no page-visible result of
      // their own; the next step's expect covers them. Everything else must prove it worked.
      const expectRequired = step.action === 'click' || step.action === 'type' || step.action === 'select'
        || step.action === 'open' || step.action === 'wait'
      if (!dryRun && step.expect === undefined && expectRequired) {
        throw new Error('这一步没有 expect，不允许直接执行（会"点完就当成功"）。请在流程里补上校验。')
      }
      if (dryRun) {
        if (step.action === 'click' || step.action === 'type' || step.action === 'select' || step.action === 'hover') {
          // A dry run stops before the steps that would reveal hidden controls, so hidden
          // matches are reported as such instead of as a failure.
          const found = await channel.find(target, { ...step.role === undefined ? {} : { role: step.role }, includeHidden: true })
          results.push({
            index,
            action: step.action,
            target,
            ok: found.total === 1,
            resolved: found.candidates[0]?.name,
            detail: found.total === 0 ? '找不到' : found.total > 1 ? `命中 ${String(found.total)} 个：${found.candidates.map((item) => item.name).join('、')}` : (found.candidates[0]?.visible === false ? '单一命中，但当前不可见（依赖前一步让它出现）' : '唯一命中'),
            elapsedMs: Date.now() - stepStarted,
          })
          if (found.total !== 1) return { flow: flow.name, dryRun, ok: false, stoppedAt: index, reason: 'target-not-unique', steps: results, elapsedMs: Date.now() - started }
          continue
        }
        results.push({ index, action: step.action, target, ok: true, detail: dryRun ? 'dry-run：不对 URL/按键类步骤做预演' : '', elapsedMs: Date.now() - stepStarted })
        continue
      }
      if (step.action === 'click') await channel.clickTarget({ text: target, ...step.role === undefined ? {} : { role: step.role } })
      else if (step.action === 'hover') await channel.hoverTarget({ text: target, ...step.role === undefined ? {} : { role: step.role } })
      else if (step.action === 'type') await channel.typeTarget({ text: target, ...step.role === undefined ? {} : { role: step.role }, value: step.value ?? '' })
      else if (step.action === 'select') await channel.selectTarget({ text: target, ...step.role === undefined ? {} : { role: step.role }, value: step.value ?? '' })
      else if (step.action === 'press') await channel.press(target)
      else if (step.action === 'open') await channel.navigate(target)
      else if (step.action === 'back') await channel.back()
      else if (step.action === 'wait') {
        const waited = await channel.wait({
          ...step.expect?.urlContains === undefined ? {} : { urlContains: step.expect.urlContains },
          ...step.expect?.text === undefined ? {} : { text: step.expect.text },
          ...step.expect?.timeoutMs === undefined ? {} : { timeoutMs: step.expect.timeoutMs },
        })
        if (waited.ok !== true) throw new Error(`等待条件未满足（${String(waited.elapsedMs)}ms）`)
      }
      if (step.expect !== undefined) {
        const checked = await channel.wait({
          ...step.expect.urlContains === undefined ? {} : { urlContains: step.expect.urlContains },
          ...step.expect.text === undefined ? {} : { text: step.expect.text },
          ...step.expect.timeoutMs === undefined ? {} : { timeoutMs: step.expect.timeoutMs },
        })
        if (checked.ok !== true) throw new Error(`校验未通过：${step.expect.text ?? step.expect.urlContains ?? '（空条件）'} 在 ${String(checked.elapsedMs)}ms 内未出现`)
      }
      results.push({ index, action: step.action, target, ok: true, elapsedMs: Date.now() - stepStarted })
    } catch (error) {
      results.push({
        index,
        action: step.action,
        target,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
        elapsedMs: Date.now() - stepStarted,
      })
      return { flow: flow.name, dryRun, ok: false, stoppedAt: index, reason: 'step-failed', steps: results, elapsedMs: Date.now() - started }
    }
  }
  return { flow: flow.name, dryRun, ok: true, steps: results, elapsedMs: Date.now() - started }
}

/** A quick check for a flow file path, used by diagnostics. */
export function flowFileExists(dir: string): boolean {
  return existsSync(flowFile(dir))
}
