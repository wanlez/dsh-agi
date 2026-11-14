/**
 * Local editor server for verification without restarting DSH.
 *
 *   node --experimental-transform-types \
 *     packages/host/src/knowledge-graph/dev-server.ts \
 *     --dir "C:\path\to\library" --port 47831
 *
 * It serves the same page and API as the plugin route. The model channel is absent
 * here, so search differences fall back to similarity plus both descriptions.
 */

import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { GRAPH_PREFIX, handleKnowledgeGraph, isKnowledgeGraphPath } from './routes.ts'

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return fallback
  return process.argv[index + 1] ?? fallback
}

const dir = resolve(argument('dir', resolve(process.cwd(), '.knowledge-graph')))
const port = Number(argument('port', '47831'))
const host = argument('host', '127.0.0.1')

if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
  console.error(`dsh-agi graph: invalid port ${port}`)
  process.exit(1)
}

const server = createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
  if (!isKnowledgeGraphPath(path)) {
    res.writeHead(302, { location: `${GRAPH_PREFIX}/` })
    res.end()
    return
  }
  void handleKnowledgeGraph({ dir, req, res }).catch((error: unknown) => {
    console.error(`dsh-agi graph: ${error instanceof Error ? error.message : String(error)}`)
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: { code: 'internal-error', message: 'request failed' } }))
    }
  })
})

server.listen(port, host, () => {
  console.log(`dsh-agi graph editor: http://${host}:${port}${GRAPH_PREFIX}/`)
  console.log(`library: ${dir}`)
})

process.on('SIGINT', () => {
  server.close(() => process.exit(0))
})
