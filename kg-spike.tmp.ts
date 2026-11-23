import { KnowledgeGraphStore, knowledgeGraphDirFor } from './packages/host/src/knowledge-graph/store.ts'
import { KnowledgeGraphService } from './packages/host/src/knowledge-graph/service.ts'
import { startGraphEditorServer } from './packages/host/src/knowledge-graph/editor-server.ts'

const profile = process.env.USERPROFILE + '/.dsh/profiles/desktop'
const dir = knowledgeGraphDirFor(profile)
const service = new KnowledgeGraphService(new KnowledgeGraphStore(dir))
console.log('库目录:', dir)
const nodes = await service.listNodes()
const paths = await service.paths()
console.log('节点:', nodes.length, '| 路径:', paths.length)
if (paths.length > 0) {
  const detail = await service.pathDetail(paths[0]!.id)
  console.log('示例路径:', detail.path.name, '步骤:', detail.graph.nodes.length, '边:', detail.graph.edges.length, '问题:', detail.problems.length)
  console.log('节点标题链:', detail.graph.nodes.map(n => n.node_id.slice(0, 8)).join(' → '))
}
if (nodes.length > 0) {
  const around = await service.neighborhood(nodes[0]!.id)
  console.log('邻接示例:', nodes[0]!.title, '→', around.nodes.filter(n => n.role !== 'anchor').length, '个邻居')
}
const editor = await startGraphEditorServer({ baseDir: profile })
console.log('编辑器:', editor.url, '复用:', editor.reused)
const probe = await fetch(editor.url.replace(/\/$/, '') + '/').then(r => r.status).catch(() => 0)
console.log('页面状态:', probe, '| 深链示例:', editor.url + '#/node/' + (nodes[0]?.id ?? 'x'))
