import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  KEYWORD_FLOOR,
  keywordMatch,
  keywordScore,
  longestCommonSubstringLength,
  normalizeKeywordText,
} from '../src/knowledge-graph/keyword.ts'
import { KnowledgeGraphService } from '../src/knowledge-graph/service.ts'
import { KnowledgeGraphStore } from '../src/knowledge-graph/store.ts'
import { legacyFixture } from './fixtures/legacy-graph.ts'

const roots: string[] = []
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function temporary(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orb-graph-keyword-'))
  roots.push(dir)
  return dir
}

/** Seed the legacy fixture and return key → node id, plus the service. */
async function seeded(): Promise<{
  service: KnowledgeGraphService
  ids: Map<string, string>
}> {
  const service = new KnowledgeGraphService(new KnowledgeGraphStore(temporary()))
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
  return { service, ids }
}

describe('keyword channel', () => {
  it('normalizes case, spaces, and punctuation', () => {
    assert.equal(normalizeKeywordText('  天翼 Cloud，云电脑！ '), '天翼cloud云电脑')
    assert.equal(normalizeKeywordText('（企业门户）\u3000v2.0'), '企业门户v20')
    assert.equal(normalizeKeywordText('   '), '')
  })

  it('scores a contained query at 1 and returns a verbatim fragment', () => {
    const hit = keywordMatch('天翼云电脑', [
      { field: 'title', text: '进入天翼云电脑' },
      { field: 'description', text: '登录天翼云电脑并确认远端桌面' },
    ])
    assert.ok(hit)
    assert.equal(hit.score, 1)
    assert.equal(hit.field, 'title')
    assert.equal(hit.fragment, '天翼云电脑')
    assert.match(hit.snippet, /天翼云电脑/u)
    assert.equal(keywordScore('天翼云电脑', '进入天翼云电脑'), 1)
  })

  it('keeps the score monotonic as the contained query grows', () => {
    const text = '进入天翼云电脑'
    const scores = ['云电脑', '天翼云', '天翼云电脑', '进入天翼云电脑'].map((query) => keywordScore(query, text))
    for (let index = 1; index < scores.length; index += 1) {
      assert.ok((scores[index] as number) >= (scores[index - 1] as number), `scores must not fall: ${scores.join(', ')}`)
    }
    assert.equal(scores[scores.length - 1], 1)
  })

  it('uses the bigram Dice score when characters match but not in one run', () => {
    // LCS is "ab" (2/4 = 0.5); Dice is 2·2/(3+4) ≈ 0.5714.
    const score = keywordScore('abcd', 'abXcd')
    assert.ok(score > 0.5 && score < 0.6, `expected Dice to win, got ${score}`)
    assert.equal(longestCommonSubstringLength('abcd', 'abXcd'), 2)
  })

  it('stays cheap on long notes and still finds the hit', () => {
    const long = `${'啊'.repeat(20_000)}云电脑`
    assert.equal(keywordScore('云电脑', long), 1)
  })

  it('keeps unrelated text below the noise floor', () => {
    assert.ok(keywordScore('完全不存在的词xyz', '进入天翼云电脑') < KEYWORD_FLOOR)
    assert.ok(keywordScore('给猫洗一次澡', '填写并发送福利积分') < KEYWORD_FLOOR)
    assert.equal(keywordScore('云电脑', ''), 0)
  })

  it('keeps a short query the old threshold would have hidden as an unconfirmed candidate', async () => {
    const { service, ids } = await seeded()
    // 0.99 leaves the cloud node below the threshold but above the floor: it stays visible
    // as "未达阈值 · 最接近" while the keyword channel also answers it at full score.
    const search = await service.searchNodes('云电脑', 0.99)
    assert.equal(search.semantic_floor, 0.3)
    assert.ok(search.candidates.length >= 1)
    assert.ok(search.candidates.every((candidate) => candidate.similarity >= 0.3))
    assert.ok(search.candidates.every((candidate) => candidate.meets_threshold === false))
    const cloud = search.candidates.find((candidate) => candidate.node.id === ids.get('cloud'))
    assert.ok(cloud)
    assert.ok(cloud.similarity >= 0.3 && cloud.similarity < 0.99)
    assert.equal(search.empty, false)
    assert.equal(search.keyword[0]?.node.id, ids.get('cloud'))
    assert.equal(search.keyword[0]?.score, 1)
    assert.equal(search.keyword_threshold, KEYWORD_FLOOR)
    assert.ok(search.keyword.every((candidate) => candidate.score >= KEYWORD_FLOOR))
  })

  it('returns a node hit by both channels once, with both scores', async () => {
    const { service, ids } = await seeded()
    const search = await service.searchNodes('进入天翼云电脑', 0)
    const cloud = search.candidates.find((candidate) => candidate.node.id === ids.get('cloud'))
    assert.ok(cloud)
    assert.equal(cloud.scores.semantic, cloud.similarity)
    assert.equal(cloud.scores.keyword, 1)
    // The keyword block only carries the nodes the semantic block did not show.
    assert.equal(search.keyword.some((candidate) => candidate.node.id === ids.get('cloud')), false)
    const idsSeen = [...search.candidates.map((candidate) => candidate.node.id), ...search.keyword.map((candidate) => candidate.node.id)]
    assert.equal(new Set(idsSeen).size, idsSeen.length)
  })

  it('finds the welfare node from a short colloquial query', async () => {
    const { service, ids } = await seeded()
    const search = await service.searchNodes('发积分', 0.99)
    const welfare = search.keyword.find((candidate) => candidate.node.id === ids.get('welfare'))
    assert.ok(welfare)
    assert.ok(welfare.score > 0.6)
    assert.match(welfare.fragment, /积分/u)
  })

  it('answers empty only when the semantic and keyword channels are both empty', async () => {
    const { service } = await seeded()
    const search = await service.searchNodes('完全不存在的词xyz', 0.75)
    assert.equal(search.semantic_floor, 0.3)
    assert.equal(search.candidates.length, 0)
    assert.equal(search.keyword.length, 0)
    assert.equal(search.empty, true)
    // A below-threshold but above-floor candidate is enough to leave the empty state.
    const low = await service.searchNodes('云电脑', 0.99)
    assert.equal(low.empty, false)
    assert.ok(low.candidates.length > 0)
  })

  it('matches indexes through name and summary without the threshold', async () => {
    const { service } = await seeded()
    const search = await service.searchPaths('发积分', 0.99)
    // The semantic channel is no longer emptied: the filler is above the floor but
    // unconfirmed, so it must not be auto-executable.
    assert.equal(search.semantic_floor, 0.3)
    assert.equal(search.candidates.length, 1)
    assert.equal(search.candidates[0]?.path.name, '发福利积分')
    assert.equal(search.candidates[0]?.meets_threshold, false)
    assert.equal(search.candidates[0]?.auto_executable, false)
    assert.equal(search.empty, false)
    const hit = search.keyword.find((candidate) => candidate.path.name === '发福利积分')
    assert.ok(hit)
    assert.equal(hit.field, 'name')
    assert.equal(hit.runnable, true)
    // The confirmation still names one path id; the object is not duplicated.
    assert.equal(new Set(search.keyword.map((candidate) => candidate.path.id)).size, search.keyword.length)
  })

  it('shows both scores on one index hit by both channels', async () => {
    const { service } = await seeded()
    const search = await service.searchPaths('发福利积分', 0.3)
    const candidate = search.candidates.find((entry) => entry.path.name === '发福利积分')
    assert.ok(candidate)
    assert.equal(candidate.scores.semantic, candidate.similarity)
    assert.equal(candidate.scores.keyword, 1)
    assert.equal(search.keyword.some((entry) => entry.path.id === candidate.path.id), false)
  })
})
