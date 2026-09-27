import { createBridgeSession, type BridgeSession } from './vscodeBridge.ts'
import { isBridgeRequest, type BridgeRequest } from './vscodeBridgeProtocol.ts'
import { loadSkills } from './skills/loader.ts'
import { writeNotice } from './ui/stream.ts'
import { randomBytes } from 'node:crypto'

const MAX_MESSAGE_LENGTH = 200_000

export interface HttpBridgeOptions {
  port: number
  /** Defaults to localhost-only. Passing a non-default value is the caller's explicit choice to expose this on the network. */
  hostname?: string
  /** Require `?token=` on every WebSocket upgrade. Always on for a
   * non-loopback bind; on loopback it defaults off so an in-process caller
   * that does not opt in is unaffected. */
  requireToken?: boolean
  /** The token to require. When `requireToken` is set and this is omitted, a
   * random token is generated and reported in the startup notice so the
   * operator (or the extension it serves) can pass it on. */
  token?: string
  /** Origins permitted to open a connection. Any connection that *sends* an
   * `Origin` header (i.e. any browser) is refused unless it is listed here —
   * a non-browser client sends no Origin and is judged by its token alone.
   * Default: refuse every Origin-bearing connection. */
  allowedOrigins?: string[]
}

/**
 * The HTTP/WebSocket transport for elia's bridge protocol — same
 * BridgeRequest/BridgeResponse/BridgeEvent envelope and the same
 * createBridgeSession core the stdio transport (vscodeBridge.ts) uses, just
 * reachable over the network instead of only by whatever process spawned
 * elia. Each WebSocket connection gets its own isolated BridgeSession (own
 * chat history, own pending approvals, own autonomous-run tracking) — nothing
 * is shared between concurrent clients.
 */
export async function runHttpBridge(options: HttpBridgeOptions) {
  try {
    await loadSkills()
  } catch {
    // Skill discovery remains best-effort, matching the stdio bridge.
  }

  const sessions = new WeakMap<object, BridgeSession>()
  const hostname = options.hostname ?? '127.0.0.1'
  const loopback = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1'
  const requireToken = options.requireToken === true || !loopback
  const token = options.token ?? (requireToken ? randomBytes(24).toString('hex') : undefined)
  const allowedOrigins = options.allowedOrigins ?? []

  const send = (ws: { send(data: string): void }, message: unknown): void => {
    try {
      ws.send(JSON.stringify(message))
    } catch {
      // The connection may already be closing — nothing to do.
    }
  }

  const server = Bun.serve<Record<string, never>>({
    port: options.port,
    hostname,
    fetch(req, srv) {
      const url = new URL(req.url)
      if (url.pathname !== '/bridge') return new Response('elia bridge: connect over WebSocket at /bridge', { status: 404 })
      // A browser cross-origin WebSocket can be driven by any site the victim
      // visits. Server binds loopback, but a browser still reaches it — refuse
      // any Origin that is not explicitly allowed.
      const origin = req.headers.get('origin')
      if (origin && !allowedOrigins.includes(origin)) {
        return new Response('Forbidden: this Origin is not allowed to open a bridge connection', { status: 403 })
      }
      // Token plus localhost: a random 192-bit token is not guessable, so the
      // loopback filter is the reachability story and the token is the
      // authorization story for anything (browser, remote) that does reach it.
      if (requireToken && url.searchParams.get('token') !== token) {
        return new Response('Unauthorized: a matching ?token= is required', { status: 401 })
      }
      if (srv.upgrade(req, { data: {} })) return undefined
      return new Response('Expected a WebSocket upgrade', { status: 400 })
    },
    websocket: {
      open(ws) {
        const session = createBridgeSession({
          output: (message) => send(ws, message),
          onShutdown: () => {
            try {
              ws.close()
            } catch {
              // Already closing.
            }
          },
        })
        sessions.set(ws, session)
      },
      message(ws, raw) {
        const session = sessions.get(ws)
        if (!session) return
        if (typeof raw !== 'string' || raw.length > MAX_MESSAGE_LENGTH) {
          send(ws, { type: 'response', id: 'unknown', ok: false, error: `message must be a JSON string under ${MAX_MESSAGE_LENGTH} characters` })
          return
        }
        let parsed: unknown
        try {
          parsed = JSON.parse(raw)
        } catch {
          send(ws, { type: 'response', id: 'unknown', ok: false, error: 'message must be valid JSON' })
          return
        }
        if (session.isShuttingDown()) return
        if (!isBridgeRequest(parsed)) {
          send(ws, { type: 'response', id: 'unknown', ok: false, error: 'Invalid bridge request envelope' })
          return
        }
        void session.handleRequest(parsed as BridgeRequest)
      },
      close(ws) {
        sessions.get(ws)?.cancelPendingApprovals('Bridge connection closed')
        sessions.delete(ws)
      },
    },
  })

  writeNotice(
    `Elia HTTP bridge listening on ws://${server.hostname}:${server.port}/bridge` +
      (loopback ? ' (localhost-only)' : ' — reachable beyond this machine; only bind a non-default host deliberately') +
      (requireToken ? ` — provide ?token=${token}` : ' — no token required; pass requireToken to demand one'),
  )
  // Bun.serve's own active listener keeps the process alive — no need to block
  // here. Returning the server (rather than awaiting forever) is what lets a
  // test start one on an ephemeral port and call server.stop() afterward.
  return server
}
