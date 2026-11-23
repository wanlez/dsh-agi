import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { KnowledgeGraphStore } from '../src/knowledge-graph/store.ts'
import { KnowledgeGraphService } from '../src/knowledge-graph/service.ts'

describe('knowledge graph path updates', () => {
  it('persists a rename and a reordered flow in the path file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'graph-update-'))
    const service = new KnowledgeGraphService(new KnowledgeGraphStore(dir))
    const first = await service.createNode({ title: '打开网页', description: '打开目标网页' })
    const second = await service.createNode({ title: '提交表单', description: '填写并提交' })
    const path = await service.createPath({ name: '原路径', summary: '测试', node_sequence: [first.id, second.id] })
    await service.updatePath({
      pathId: path.id,
      name: '改名后',
      summary: '测试',
      node_sequence: [second.id, first.id],
      graph: {
        nodes: [{ key: 'n0', node_id: second.id }, { key: 'n1', node_id: first.id }],
        edges: [{ from: 'n0', to: 'n1' }],
      },
    })
    // A fresh service reads from disk: the old code updated only index.json, so this failed.
    const reread = await new KnowledgeGraphService(new KnowledgeGraphStore(dir)).pathDetail(path.id)
    assert.equal(reread.path.name, '改名后')
    assert.deepEqual(reread.graph.nodes.map(node => node.node_id), [second.id, first.id])
  })
})
