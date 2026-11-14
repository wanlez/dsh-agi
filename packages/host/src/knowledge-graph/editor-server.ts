/**
 * Loopback HTTP server for the experience graph editor.
 *
 * The settings page cannot use `window.open('/.dsh-agi/knowledge-graph/')`: the desktop
 * shell denies every new window, and the plugin route needs the DSH login cookie. So the
 * host starts this server on `127.0.0.1` instead, hands its URL to the system browser, and
 * serves the same handler as the plugin route without DSH credentials — the loopback bind
 * is the boundary.
 *
 * There is one server per host process. The library folder is resolved on every request
 * through {@link knowledgeGraphDirFor}, the same resolver the plugin route and
 * `graphLibraryState` use, so switching the library in settings changes what the already
 * open editor tab reads on its next request.
 */

import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { GRAPH_PREFIX, handleKnowledgeGraph, isKnowledgeGraphPath } from './routes.ts'
import { knowledgeGraphDirFor } from './store.ts'

/** The only interface the editor is ever bound to. */
export const EDITOR_HOST = '127.0.0.1'

/** First port tried when the caller does not name one; the OS ephemeral range. */
const EPHEMERAL_FIRST = 49_152
const EPHEMERAL_LAST = 65_535

/** How many random ports to try before asking the OS for any free port. */
const RANDOM_ATTEMPTS = 3

/** Options for {@link startGraphEditorServer}. */
export interface GraphEditorServerOptions {
  /** Profile directory whose `agi-knowledge-graph.json` names the active library. */
  readonly baseDir: string
  /** First port to try. Taken means the server moves on to another free port. */
  readonly port?: number
}

/** What one start (or reuse) hands back to the route. */
export interface GraphEditorServerHandle {
  /** `http://127.0.0.1:<port>/.dsh-agi/knowledge-graph/` */
  readonly url: string
  readonly port: number
  /** True when the process already had the server and this call attached to it. */
  readonly reused: boolean
  /** Profile directory the server resolves the library from. */
  readonly baseDir: string
}

interface RunningEditor {
  readonly baseDir: string
  readonly server: Server
  readonly port: number
  readonly url: string
}

let running: RunningEditor | undefined
let starting: Promise<RunningEditor> | undefined

/** Whether an address belongs to this machine. Accepts the IPv4-mapped IPv6 form. */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false
  const normalized = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address
  return normalized === '127.0.0.1' || normalized === '::1'
}

/** Start the editor server, or reuse the one this process already runs. */
export async function startGraphEditorServer(options: GraphEditorServerOptions): Promise<GraphEditorServerHandle> {
  const baseDir = resolve(options.baseDir)
  for (;;) {
    if (starting !== undefined) {
      // Another click is already binding a port; wait for it, then decide again.
      await starting.catch(() => undefined)
      continue
    }
    if (running !== undefined) {
      if (running.baseDir === baseDir) return handleOf(running, true)
      // A test or an embedded host switched profiles: one editor, pointed at the new one.
      await stopGraphEditorServer()
      continue
    }
    const task = launch(baseDir, options.port)
    starting = task
    try {
      const started = await task
      running = started
      return handleOf(started, false)
    } finally {
      starting = undefined
    }
  }
}

/** Stop the editor server. Tests use it between cases; the live host keeps its one server. */
export async function stopGraphEditorServer(): Promise<void> {
  if (starting !== undefined) {
    try {
      await starting
    } catch {
      // A failed start left nothing to close.
    }
  }
  const current = running
  running = undefined
  if (current === undefined) return
  // An idle keep-alive socket would otherwise hold the close callback open.
  current.server.closeAllConnections()
  await new Promise<void>((done) => current.server.close(() => done()))
}

/** The port the process is serving on, or undefined before the first click. */
export function graphEditorPort(): number | undefined {
  return running?.port
}

function handleOf(editor: RunningEditor, reused: boolean): GraphEditorServerHandle {
  return { url: editor.url, port: editor.port, reused, baseDir: editor.baseDir }
}

/** Bind once, retrying a taken port with random ports and finally with port 0. */
async function launch(baseDir: string, preferred: number | undefined): Promise<RunningEditor> {
  const candidates = candidatePorts(preferred)
  let lastError: unknown
  for (const port of candidates) {
    try {
      const server = await listen(baseDir, port)
      const address = server.address()
      const actual = typeof address === 'object' && address !== null ? address.port : port
      return {
        baseDir,
        server,
        port: actual,
        url: `http://${EDITOR_HOST}:${actual}${GRAPH_PREFIX}/`,
      }
    } catch (error) {
      lastError = error
      // Windows reserves ranges of the ephemeral pool for Hyper-V; binding those is
      // EACCES, which means the same thing here: try the next free port.
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EADDRINUSE' && code !== 'EACCES') throw error
    }
  }
  throw lastError ?? new Error('graph-editor-listen-failed')
}

/** A preferred port, a few random ones, and finally an OS-assigned free port. */
function candidatePorts(preferred: number | undefined): number[] {
  const ports: number[] = []
  if (preferred !== undefined && Number.isSafeInteger(preferred) && preferred > 0 && preferred <= 65_535) {
    ports.push(preferred)
  }
  for (let index = 0; index < RANDOM_ATTEMPTS; index += 1) {
    ports.push(EPHEMERAL_FIRST + Math.floor(Math.random() * (EPHEMERAL_LAST - EPHEMERAL_FIRST + 1)))
  }
  // Port 0 always yields a free port, so this attempt cannot fail with EADDRINUSE.
  ports.push(0)
  return ports
}

function listen(baseDir: string, port: number): Promise<Server> {
  const server = createServer((req, res) => { handleEditorRequest(baseDir, req, res) })
  return new Promise<Server>((resolveListen, rejectListen) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      rejectListen(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      resolveListen(server)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, EDITOR_HOST)
  })
}

function handleEditorRequest(baseDir: string, req: IncomingMessage, res: ServerResponse): void {
  if (!isLoopbackAddress(req.socket.remoteAddress)) {
    sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: '只允许本机访问。' } })
    return
  }
  const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
  // Anything outside the editor prefix (including `/`) lands on the page.
  if (!isKnowledgeGraphPath(pathname)) {
    res.writeHead(302, { location: `${GRAPH_PREFIX}/` })
    res.end()
    return
  }
  if (pathname === GRAPH_PREFIX) {
    res.writeHead(302, { location: `${GRAPH_PREFIX}/` })
    res.end()
    return
  }
  void handleKnowledgeGraph({ dir: knowledgeGraphDirFor(baseDir), req, res }).catch((error: unknown) => {
    console.error(`dsh-agi: graph editor server: ${error instanceof Error ? error.message : String(error)}`)
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: { code: 'internal-error', message: '请求失败。' } })
  })
}

/** Hand the editor URL to the system's default browser. False when no hand-off exists. */
export async function openGraphEditorUrl(url: string): Promise<boolean> {
  // In the desktop build this plugin runs inside Electron's main process, where the same
  // `shell.openExternal` the floating ball uses is available. The DSH host also runs under
  // plain Node, so keep the OS fallback the folder button already uses.
  if (process.versions.electron !== undefined) {
    try {
      const electron = createRequire(import.meta.url)('electron') as {
        shell?: { openExternal?: (target: string) => Promise<void> }
      }
      if (typeof electron === 'object' && electron !== null && typeof electron.shell?.openExternal === 'function') {
        await electron.shell.openExternal(url)
        return true
      }
    } catch (error) {
      console.error(`dsh-agi: shell.openExternal failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  try {
    const opener = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open'
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
    const child = spawn(opener, args, { detached: true, stdio: 'ignore', windowsHide: true })
    await new Promise<void>((spawned, failed) => {
      child.once('spawn', spawned)
      child.once('error', failed)
    })
    child.unref()
    return true
  } catch (error) {
    console.error(`dsh-agi: open editor failed: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}
