/**
 * Semantic-channel rules the user settled on:
 *   TOP3 above the floor, a 0.30 floor (configurable), a `meets_threshold` flag on every
 *   candidate, the same rule for index matching, and no auto-execution below the threshold.
 *
 * These tests use their own temporary libraries; the legacy fixture keeps the realistic
 * short query ("云电脑" vs "进入天翼云电脑") that the old threshold used to hide.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { legacyFixture } from './fixtures/legacy-graph.ts'
import { DEFAULT_SEMANTIC_FLOOR } from '../src/knowledge-graph/model.ts'
import { SEMANTIC_TOP } from '../src/knowledge-graph/search.ts'
import { KnowledgeGraphService } from '../src/knowledge-graph/service.ts'
import { KnowledgeGraphStore } from '../src/knowledge-graph/store.ts'

const roots: string[] = []
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function temporary(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orb-graph-semantic-'))
  roots.push(dir)
  return dir
}

function newService(dir = temporary()): KnowledgeGraphService {
  return new KnowledgeGraphService(new KnowledgeGraphStore(dir))
}

/** Seed the legacy fixture and return key → node id. */
async function seeded(service: KnowledgeGraphService): Promise<Map<string, string>> {
  const fixture = legacyFixture()
  const ids = new Map<string, string>()
  for (const node of fixture.nodes) {
    const created = await service.createNode({ title: node.title, description: node.description, created_by: 'fixture' })
    ids.set(node.key, created.id)
  }
  for (const [from, to] of fixture.edges) {
    await service.addEdge(ids.get(from) as string, ids.get(to) as string)
  }
  for (const path of fixture.paths) {
    await service.createPath({
      name: path.name,
      summary: path.summary,
      node_sequence: path.sequence.map((key) => ids.get(key) as string),
    })
  }
  return ids
}

/** Five near-identical nodes, so the TOP3 cap has something to cut. */
async function seededIdentical(service: KnowledgeGraphService): Promise<void> {
  for (const index of [1, 2, 3, 4, 5]) {
    await service.createNode({ title: `打开福利系统 ${index}`, description: '登录福利系统并打开积分页面' })
  }
}

describe('semantic floor and TOP3', () => {
  it('defaults the floor to 0.30 and caps the semantic channel at three', async () => {
    assert.equal(DEFAULT_SEMANTIC_FLOOR, 0.3)
    assert.equal(SEMANTIC_TOP, 3)
    const service = newService()
    await seededIdentical(service)
    const result = await service.searchNodes('登录福利系统并打开积分页面')
    assert.equal(result.threshold, 0.75)
    assert.equal(result.semantic_floor, 0.3)
    assert.equal(result.candidates.length, SEMANTIC_TOP)
    assert.ok(result.candidates.every((candidate) => candidate.similarity >= 0.3))
    assert.ok(result.candidates.every((candidate) => candidate.meets_threshold === (candidate.similarity >= 0.75)))
  })

  it('filters the floor before TOP3: a raised floor empties the list without touching the threshold', async () => {
    const service = newService()
    await seededIdentical(service)
    const relaxed = await service.searchNodes('登录福利系统')
    assert.ok(relaxed.best_similarity !== null && relaxed.best_similarity < 0.9)
    assert.ok(relaxed.candidates.length >= 1)

    await service.updateSettings({ semanticFloor: 0.9 })
    const strict = await service.searchNodes('登录福利系统')
    assert.equal(strict.semantic_floor, 0.9)
    assert.equal(strict.candidates.length, 0)
    assert.equal(strict.keyword.length > 0, true)
    assert.equal(strict.empty, false)
  })

  it('never returns a candidate below the floor and never more than three', async () => {
    const service = newService()
    await seeded(service)
    for (const query of ['云电脑', '天翼云电脑', '发福利积分', '给同事发福利积分', 'zzzqqq']) {
      const result = await service.searchNodes(query)
      assert.ok(result.candidates.length <= SEMANTIC_TOP, `${query}: ${result.candidates.length}`)
      assert.ok(result.candidates.every((candidate) => candidate.similarity >= result.semantic_floor), query)
    }
  })

  it('marks the 0.30–threshold band as 未达阈值 and keeps the confirmed node unmarked', async () => {
    const service = newService()
    const ids = await seeded(service)

    const low = await service.searchNodes('云电脑')
    const cloudLow = low.candidates.find((candidate) => candidate.node.id === ids.get('cloud'))
    assert.ok(cloudLow)
    assert.equal(cloudLow.meets_threshold, false)
    assert.ok(cloudLow.similarity >= 0.3 && cloudLow.similarity < low.threshold)
    assert.equal(low.empty, false)

    const high = await service.searchNodes('天翼云电脑')
    const cloudHigh = high.candidates.find((candidate) => candidate.node.id === ids.get('cloud'))
    assert.ok(cloudHigh)
    assert.equal(cloudHigh.meets_threshold, true)
    assert.ok(cloudHigh.similarity >= high.threshold)
    assert.equal(high.candidates[0]?.node.id, ids.get('cloud'))
    // Every candidate's flag agrees with the threshold the response carries.
    for (const candidate of low.candidates) assert.equal(candidate.meets_threshold, candidate.similarity >= low.threshold)
    for (const candidate of high.candidates) assert.equal(candidate.meets_threshold, candidate.similarity >= high.threshold)
  })

  it('answers empty only when TOP3 are all below the floor and the keyword channel is empty', async () => {
    const service = newService()
    await seeded(service)
    const miss = await service.searchNodes('zzzqqq')
    assert.equal(miss.candidates.length, 0)
    assert.equal(miss.keyword.length, 0)
    assert.equal(miss.empty, true)
    assert.ok(miss.best_similarity !== null && miss.best_similarity < miss.semantic_floor)

    const belowThreshold = await service.searchNodes('云电脑')
    assert.equal(belowThreshold.empty, false)

    await service.updateSettings({ semanticFloor: 0 })
    const noFloor = await service.searchNodes('zzzqqq')
    assert.ok(noFloor.candidates.length > 0)
    assert.equal(noFloor.empty, false)
  })
})

describe('index matching under the same rule', () => {
  /** Four saved paths whose summaries form a clean ranking. */
  async function seededPaths(service: KnowledgeGraphService): Promise<void> {
    const items = [
      ['发福利积分', '在薪酬辅助系统里给同事发放福利积分'],
      ['发节日礼品', '在薪酬辅助系统里给同事发放节日礼品'],
      ['登记福利积分', '在薪酬辅助系统里给同事登记福利积分'],
      ['报销差旅费', '在财务系统提交差旅报销单'],
    ] as const
    for (const [name, summary] of items) {
      const node = await service.createNode({ title: name, description: summary })
      await service.createPath({ name, summary, node_sequence: [node.id] })
    }
  }

  it('puts confirmed paths first, fills to three with floor-only paths, and forbids auto-run', async () => {
    const service = newService()
    await seededPaths(service)
    const result = await service.searchPaths('给同事发福利积分')
    assert.equal(result.semantic_floor, 0.3)
    assert.equal(result.candidates.length, SEMANTIC_TOP)
    assert.equal(result.candidates[0]?.path.name, '发福利积分')
    assert.equal(result.candidates[0]?.meets_threshold, true)
    assert.equal(result.candidates[0]?.auto_executable, true)
    const fillers = result.candidates.slice(1)
    assert.ok(fillers.length > 0)
    assert.ok(fillers.every((candidate) => candidate.meets_threshold === false))
    assert.ok(fillers.every((candidate) => candidate.auto_executable === false))
    assert.ok(result.candidates.every((candidate) => candidate.similarity >= 0.3))
    // The below-threshold paths are exactly the ones that must not run unattended.
    assert.ok(result.candidates.every((candidate) => candidate.auto_executable === (candidate.meets_threshold && candidate.runnable)))
  })

  it('stops with the stop message when both channels are empty', async () => {
    const service = newService()
    await seededPaths(service)
    const result = await service.searchPaths('zzzqqq')
    assert.equal(result.candidates.length, 0)
    assert.equal(result.keyword.length, 0)
    assert.equal(result.empty, true)
    assert.match(result.message ?? '', /补充/)
    assert.equal(result.semantic_floor, 0.3)
  })

  it('uses the same floor for every returned index candidate', async () => {
    const service = newService()
    await seeded(service)
    for (const query of ['云电脑', '天翼云电脑', '发积分']) {
      const result = await service.searchPaths(query)
      assert.ok(result.candidates.length <= SEMANTIC_TOP)
      assert.ok(result.candidates.every((candidate) => candidate.similarity >= result.semantic_floor))
    }
  })
})

describe('settings persistence', () => {
  it('changes one setting without resetting the threshold or the keyword configuration', async () => {
    const dir = temporary()
    const service = newService(dir)
    const initial = (await service.stats()).settings
    assert.equal(initial.searchThreshold, 0.75)
    assert.equal(initial.semanticFloor, DEFAULT_SEMANTIC_FLOOR)
    assert.equal(initial.keywordTop, 20)
    assert.equal(initial.keywordFloor, 0.2)

    const threshold = await service.updateSettings({ searchThreshold: 0.8 })
    assert.equal(threshold.searchThreshold, 0.8)
    assert.equal(threshold.semanticFloor, 0.3)
    assert.equal(threshold.keywordTop, 20)

    const floor = await service.updateSettings({ semanticFloor: 0.42 })
    assert.equal(floor.semanticFloor, 0.42)
    assert.equal(floor.searchThreshold, 0.8)
    assert.equal(floor.keywordFloor, 0.2)

    const keyword = await service.updateSettings({ keywordTop: 7, keywordFloor: 0.35 })
    assert.equal(keyword.keywordTop, 7)
    assert.equal(keyword.keywordFloor, 0.35)
    assert.equal(keyword.semanticFloor, 0.42)
    assert.equal(keyword.searchThreshold, 0.8)

    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as {
      settings: { searchThreshold: number; semanticFloor: number; keywordTop: number; keywordFloor: number }
    }
    assert.deepEqual(manifest.settings, {
      searchThreshold: 0.8,
      semanticFloor: 0.42,
      topK: 5,
      confirmTop: 3,
      keywordTop: 7,
      keywordFloor: 0.35,
    })
  })

  it('clamps an out-of-range floor instead of dropping it', async () => {
    const service = newService()
    assert.equal((await service.updateSettings({ semanticFloor: 5 })).semanticFloor, 1)
    assert.equal((await service.updateSettings({ semanticFloor: -1 })).semanticFloor, 0)
  })
})
