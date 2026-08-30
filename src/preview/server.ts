import { mkdirSync, statSync, watch } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { ServerWebSocket } from 'bun'
import { paths } from '../config.ts'

const RELOAD_PATH = '/__reload'
const RELOAD_DEBOUNCE_MS = 100

export interface PreviewServer {
  baseUrl: string
  root: string
}

let singleton: PreviewServer | undefined
let singletonCleanup: (() => void) | undefined

/**
 * Starts (once — subsequent calls reuse it) a localhost-only static server over
 * `root` with push-based live-reload: any change under `root` broadcasts a
 * "reload" message over WebSocket to every connected tab, which then reloads
 * itself. This is the actual "streaming" preview — a push, not the browser
 * polling for changes.
 */
export function ensurePreviewServer(root: string = paths.workspace): PreviewServer {
  const resolvedRoot = resolve(root)
  if (singleton && resolve(singleton.root) === resolvedRoot) return singleton
  if (singleton) resetPreviewServerForTests()

  mkdirSync(resolvedRoot, { recursive: true })

  const sockets = new Set<ServerWebSocket<unknown>>()

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req, srv) {
      const url = new URL(req.url)
      if (url.pathname === RELOAD_PATH) {
        return srv.upgrade(req) ? undefined : new Response('Upgrade failed', { status: 400 })
      }
      return serveStatic(resolvedRoot, url.pathname)
    },
    websocket: {
      open(ws) {
        sockets.add(ws)
      },
      close(ws) {
        sockets.delete(ws)
      },
      message() {
        // Clients never send anything meaningful; this exists only so Bun accepts the connection.
      },
    },
  })

  let debounceTimer: ReturnType<typeof setTimeout> | undefined
  const watcher = watch(resolvedRoot, { recursive: true }, () => {
    clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      for (const ws of sockets) ws.send('reload')
    }, RELOAD_DEBOUNCE_MS)
  })

  singleton = { baseUrl: `http://127.0.0.1:${server.port}`, root: resolvedRoot }
  singletonCleanup = () => {
    clearTimeout(debounceTimer)
    watcher.close()
    for (const ws of sockets) {
      try {
        ws.close()
      } catch {
        // A socket may already be closed while the server is stopping.
      }
    }
    sockets.clear()
    server.stop(true)
  }
  return singleton
}

/** Stops the active preview resources so repeated runs do not leak servers or watchers. */
export function resetPreviewServerForTests(): void {
  singletonCleanup?.()
  singletonCleanup = undefined
  singleton = undefined
}

async function serveStatic(root: string, pathname: string): Promise<Response> {
  let resolvedPath = resolveWithinRoot(root, pathname)
  if (!resolvedPath) return new Response('Forbidden', { status: 403 })

  // A request for a directory (`/car-racing`) serves that directory's
  // index.html, the way every static server does — otherwise it 404s and the
  // browser falls back to the root, which is how a preview ends up showing a
  // sibling project's leftover page.
  try {
    if (statSync(resolvedPath).isDirectory()) resolvedPath = join(resolvedPath, 'index.html')
  } catch {
    // Not a real path — the exists() check below returns the 404.
  }

  const file = Bun.file(resolvedPath)
  if (!(await file.exists())) return new Response('Not found', { status: 404 })

  if (resolvedPath.endsWith('.html') || resolvedPath.endsWith('.htm')) {
    const html = await file.text()
    return new Response(injectReloadScript(html), { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
  }

  return new Response(file)
}

/** Resolves a request path against `root`, rejecting anything that would escape it. Exported for direct testing. */
export function resolveWithinRoot(root: string, pathname: string): string | undefined {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return undefined
  }
  const relative = decoded === '/' || decoded === '' ? 'index.html' : decoded.replace(/^\/+/, '')
  const resolvedRoot = resolve(root)
  const resolvedPath = resolve(resolvedRoot, relative)
  const rootWithSep = resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(rootWithSep)) return undefined
  return resolvedPath
}

/** Exported for direct testing. */
export function injectReloadScript(html: string): string {
  const script = `<script>(function(){var ws=new WebSocket('ws://'+location.host+'${RELOAD_PATH}');ws.onmessage=function(){location.reload();};})();</script>`
  if (html.includes('</body>')) return html.replace('</body>', `${script}</body>`)
  return `${html}\n${script}`
}
