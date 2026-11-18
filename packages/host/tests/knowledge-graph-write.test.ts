/**
 * The reflection flow writes through `updateNodeAi`; this pins the behaviour it relies on:
 * the note reaches disk, survives a fresh store, and never touches what the operator wrote.
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { KnowledgeGraphService } from '../src/knowledge-graph/service.ts'
import { KnowledgeGraphStore } from '../src/knowledge-graph/store.ts'

async function withLibrary(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-agi-graph-write-'))
  try {
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('an AI note written for a node survives a fresh store', async () => {
  await withLibrary(async (dir) => {
    const service = new KnowledgeGraphService(new KnowledgeGraphStore(dir))
    const node = await service.createNode({
      title: '测试节点-邮件签名',
      description: '这是人写的说明，AI 不能改。',
      created_by: 'ball',
    })

    const note = '邮件的签名要保留，不能删掉'
    await service.updateNodeAi(node.id, note)

    // A second service reads the directory from scratch, exactly like a restart.
    const reloaded = new KnowledgeGraphService(new KnowledgeGraphStore(dir))
    const detail = await reloaded.nodeDetail(node.id)
    assert.equal(detail.node.ai_notes, note)
  })
})

test('writing an AI note leaves the operator text untouched', async () => {
  await withLibrary(async (dir) => {
    const service = new KnowledgeGraphService(new KnowledgeGraphStore(dir))
    const description = '人写的说明：先点设置，再点保存。'
    const node = await service.createNode({
      title: '测试节点-保留人写内容',
      description,
      created_by: 'ball',
    })

    await service.updateNodeAi(node.id, '补充：保存按钮是绿色的。')

    const detail = await service.nodeDetail(node.id)
    assert.equal(detail.node.description, description)
    assert.equal(detail.node.title, '测试节点-保留人写内容')
  })
})

test('an AI note longer than 600 characters is refused', async () => {
  await withLibrary(async (dir) => {
    const service = new KnowledgeGraphService(new KnowledgeGraphStore(dir))
    const node = await service.createNode({
      title: '测试节点-超长备注',
      description: '',
      created_by: 'ball',
    })

    await assert.rejects(() => service.updateNodeAi(node.id, '坑'.repeat(601)), /600/)
  })
})
