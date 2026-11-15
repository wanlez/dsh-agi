/**
 * The loopback editor server the settings page opens instead of `window.open`.
 *
 * The process keeps one server and one port; the library folder is resolved per request,
 * so switching the library in settings reaches a tab that is already open.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  graphEditorPort,
  isLoopbackAddress,
  startGraphEditorServer,
  stopGraphEditorServer,
} from '../src/knowledge-graph/editor-server.ts'
import { graphLibraryState } from '../src/knowledge-graph/library.ts'
import { GRAPH_PREFIX } from '../src/knowledge-graph/routes.ts'
import { GRAPH_CONFIG, knowledgeGraphDirFor } from '../src/knowledge-graph/store.ts'

const root = mkdtempSync(join(tmpdir(), 'orb-graph-editor-'))
const baseDir = join(root, 'profile')
mkdirSync(baseDir, { recursive: true })

after(async () => {
  await stopGraphEditorServer()
  rmSync(root, { recursive: true, force: true })
})

interface StateBody {
  ok: boolean
  dir: string
  llm: boolean
}

describe('graph editor loopback server', () => {
  it('serves the editor page and API on 127.0.0.1 without the DSH cookie', async () => {
    await stopGraphEditorServer()
    const editor = await startGraphEditorServer({ baseDir })
    assert.equal(editor.reused, false)
    assert.equal(editor.baseDir, resolve(baseDir))
    assert.match(editor.url, /^http:\/\/127\.0\.0\.1:\d+\/\.dsh-agi\/knowledge-graph\/$/)
    assert.ok(editor.port > 0)

    // `/` is not the page path; the server redirects it instead of answering there.
    const redirected = await fetch(`http://127.0.0.1:${editor.port}/`, { redirect: 'manual' })
    assert.equal(redirected.status, 302)
    assert.equal(redirected.headers.get('location'), `${GRAPH_PREFIX}/`)

    const page = await fetch(editor.url)
    assert.equal(page.status, 200)
    assert.match(page.headers.get('content-type') ?? '', /text\/html/)
    assert.match(await page.text(), /从搜索开始/)

    const state = await fetch(new URL('api/state', editor.url))
    assert.equal(state.status, 200)
    const body = await state.json() as StateBody
    assert.equal(body.dir, knowledgeGraphDirFor(baseDir))
    assert.equal(body.llm, false, 'the loopback server has no model channel')
  })

  it('reuses the one server and port when the button is clicked again', async () => {
    const first = await startGraphEditorServer({ baseDir })
    const second = await startGraphEditorServer({ baseDir })
    assert.equal(second.reused, true)
    assert.equal(second.port, first.port)
    assert.equal(second.url, first.url)
    assert.equal(graphEditorPort(), first.port)
  })

  it('resolves the library on every request so a folder switch reaches the open editor', async () => {
    const editor = await startGraphEditorServer({ baseDir })
    const other = join(root, 'other-library')
    mkdirSync(other, { recursive: true })
    // This is exactly what setGraphLibraryDir writes: the profile remembers the folder,
    // and every reader resolves it again instead of caching the startup value.
    writeFileSync(join(baseDir, GRAPH_CONFIG), `${JSON.stringify({ dir: other })}\n`, 'utf8')

    const body = await (await fetch(new URL('api/state', editor.url))).json() as StateBody
    assert.equal(body.dir, resolve(other))
    assert.equal((await graphLibraryState(baseDir)).dir, resolve(other), 'the DSH route sees the same library')
    assert.equal(editor.url, `http://127.0.0.1:${editor.port}${GRAPH_PREFIX}/`, 'the address itself never changes')
  })

  it('moves to another free port when the requested one is already taken', async () => {
    await stopGraphEditorServer()
    const occupied: Server = createServer((_req, res) => { res.end() })
    await new Promise<void>((done) => occupied.listen(0, '127.0.0.1', () => done()))
    const address = occupied.address()
    const taken = typeof address === 'object' && address !== null ? address.port : 0
    try {
      const editor = await startGraphEditorServer({ baseDir, port: taken })
      assert.notEqual(editor.port, taken)
      assert.equal(editor.reused, false)
      const page = await fetch(editor.url)
      assert.equal(page.status, 200)
      assert.match(await page.text(), /从搜索开始/)
    } finally {
      await new Promise<void>((done) => occupied.close(() => done()))
      await stopGraphEditorServer()
    }
  })

  it('recognises only loopback peers', () => {
    assert.equal(isLoopbackAddress('127.0.0.1'), true)
    assert.equal(isLoopbackAddress('::1'), true)
    assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true)
    assert.equal(isLoopbackAddress('192.168.1.7'), false)
    assert.equal(isLoopbackAddress('10.0.0.2'), false)
    assert.equal(isLoopbackAddress(undefined), false)
  })
})
