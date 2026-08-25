import { createBridgeSession, type BridgeSession } from './vscodeBridge.ts'
import { isBridgeRequest, type BridgeRequest } from './vscodeBridgeProtocol.ts'
import { loadSkills } from './skills/loader.ts'
import { writeNotice } from './ui/stream.ts'

const MAX_MESSAGE_LENGTH = 200_000

export interface HttpBridgeOptions {
  port: number
  /** Defaults to localhost-only. Passing a non-default value is the caller's explicit choice to expose this on the network. */
  hostname?: string
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
export async function runHttpBridge(options: HttpBridgeOptions): Promise<void> {
  try {
    await loadSkills()
  } catch {
    // Skill discovery remains best-effort, matching the stdio bridge.
  }

  const sessions = new WeakMap<object, BridgeSession>()
  const hostname = options.hostname ?? '127.0.0.1'

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
      if (new URL(req.url).pathname !== '/bridge') return new Response('elia bridge: connect over WebSocket at /bridge', { status: 404 })
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
        sessions.delete(ws)
      },
    },
  })

  writeNotice(
    `Elia HTTP bridge listening on ws://${server.hostname}:${server.port}/bridge` +
      (hostname === '127.0.0.1' ? ' (localhost-only)' : ' — reachable beyond this machine; only bind a non-default host deliberately'),
  )
  await new Promise<void>(() => {}) // Serves until the process receives a shutdown signal.
}
