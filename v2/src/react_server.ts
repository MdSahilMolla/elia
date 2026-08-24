import { serve } from 'bun'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { assertSafeFileAccess } from './autonomy/sensitivePaths.ts'
import { resolveWorkspacePath } from './autonomy/context.ts'

const DEFAULT_PORT = 0
const DEFAULT_STATIC_DIR = join(process.cwd(), 'workspace', 'react_site')

export interface ReactSiteServer {
  server: ReturnType<typeof serve>
  root: string
  baseUrl: string
}

/** Resolve a URL path through real filesystem containment, including symlink checks. */
export function resolveReactStaticPath(root: string, pathname: string): string | undefined {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return undefined
  }
  if (decoded.includes('\u0000')) return undefined
  const relativePath = decoded === '/' || decoded === '' ? 'index.html' : decoded.replace(/^[/\\]+/, '')
  try {
    const path = resolveWorkspacePath(relativePath, root)
    assertSafeFileAccess(path)
    return path
  } catch {
    return undefined
  }
}

/** Start a private local React site server. It never binds a public interface by default. */
export function startReactServer(options: { root?: string; port?: number } = {}): ReactSiteServer {
  const root = resolve(options.root ?? DEFAULT_STATIC_DIR)
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const requestedPort = options.port ?? readPortFromEnvironment()
  const server = serve({
    hostname: '127.0.0.1',
    port: requestedPort,
    async fetch(request) {
      const url = new URL(request.url)
      const filePath = resolveReactStaticPath(root, url.pathname)
      if (!filePath) return new Response('Forbidden', { status: 403 })
      const file = Bun.file(filePath)
      if (!(await file.exists())) return new Response('Not found', { status: 404 })

      const headers = new Headers({
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      })
      const extension = filePath.toLocaleLowerCase()
      if (extension.endsWith('.html')) headers.set('Content-Type', 'text/html; charset=utf-8')
      else if (extension.endsWith('.css')) headers.set('Content-Type', 'text/css; charset=utf-8')
      else if (extension.endsWith('.js')) headers.set('Content-Type', 'application/javascript; charset=utf-8')
      else if (extension.endsWith('.json')) headers.set('Content-Type', 'application/json; charset=utf-8')
      else if (extension.endsWith('.svg')) headers.set('Content-Type', 'image/svg+xml')
      return new Response(file, { headers })
    },
  })
  return { server, root, baseUrl: `http://127.0.0.1:${server.port}` }
}

function readPortFromEnvironment(): number {
  const value = process.env.ELIA_REACT_PORT?.trim()
  if (!value) return DEFAULT_PORT
  const port = Number.parseInt(value, 10)
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('ELIA_REACT_PORT must be an integer between 0 and 65535')
  return port
}

if (import.meta.main) {
  const started = startReactServer()
  console.log(`React site server listening on ${started.baseUrl}`)
}
