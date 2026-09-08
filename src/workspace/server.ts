/**
 * The workspace server — the authenticated, single-writer coordination point
 * that many human clients and many agent runtimes connect to.
 *
 * Transport mirrors `src/bridgeHttp.ts`: one `Bun.serve` upgrading `/workspace`
 * to WebSocket. The difference is that every connection shares one
 * `WorkspaceStore`; the server subscribes to that store once and fans every
 * committed event out to all connections, so a change one participant makes is
 * visible to the others with no polling.
 *
 * Binds `127.0.0.1` unless a host is passed explicitly.
 */

import type { ServerWebSocket } from 'bun'
import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { writeNotice } from '../ui/stream.ts'
import { paths } from '../statePaths.ts'
import { ensureSecureDirectory, writeSecureFile } from '../securePersistence.ts'
import { WorkspaceStore, DEFAULT_WORKSPACE_DB } from './store.ts'
import { resolveCaller, type Caller } from './identity.ts'
import { dispatchRpc, RpcError, type RpcContext } from './rpc.ts'
import { isWorkspaceRpcRequest, WORKSPACE_PROTOCOL_VERSION, type WorkspaceServerMessage } from './protocol.ts'
import { HEARTBEAT_INTERVAL_MS } from './types.ts'
import type { PersistedEvent } from './events.ts'

const MAX_MESSAGE_LENGTH = 200_000

interface ConnectionData {
  connectionId: string
  caller: Caller
}

export interface WorkspaceServerOptions {
  port?: number
  hostname?: string
  dbPath?: string
  /** Injected in tests; defaults to opening `dbPath`. */
  store?: WorkspaceStore
  /** Objective planner override; defaults to the model-backed planner. */
  planner?: import('./decompose.ts').ObjectivePlanner
}

export interface RunningWorkspaceServer {
  url: string
  port: number
  store: WorkspaceStore
  stop(): void
}

export function runWorkspaceServer(options: WorkspaceServerOptions = {}): RunningWorkspaceServer {
  const store = options.store ?? WorkspaceStore.open(options.dbPath ?? DEFAULT_WORKSPACE_DB)
  const ownsStore = !options.store
  const hostname = options.hostname ?? '127.0.0.1'
  const connections = new Set<ServerWebSocket<ConnectionData>>()

  // One store subscription, fanned out to every socket.
  const unsubscribe = store.subscribe((event) => {
    const frame = JSON.stringify({ type: 'event', event } satisfies WorkspaceServerMessage)
    for (const ws of connections) {
      try {
        ws.send(frame)
      } catch {
        // Closing socket — the close handler will clean it up.
      }
    }
  })

  // Recover anything a previous process left mid-flight, then keep leases honest.
  store.reconcileLeases()
  const reconcileTimer = setInterval(() => {
    try {
      store.reconcileLeases()
    } catch {
      // A transient lock; the next tick retries.
    }
  }, HEARTBEAT_INTERVAL_MS)

  let stopping = false
  const server = Bun.serve<ConnectionData>({
    port: options.port ?? 0,
    hostname,
    fetch(request, srv) {
      const url = new URL(request.url)
      if (url.pathname !== '/workspace') {
        return new Response('elia workspace server: connect over WebSocket at /workspace', { status: 404 })
      }
      const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? url.searchParams.get('token') ?? undefined
      const caller = resolveCaller(store, token)
      if (!caller) return new Response('Unauthorized: a valid workspace bearer token is required', { status: 401 })
      const connectionId = `conn_${randomUUID().replaceAll('-', '')}`
      if (srv.upgrade(request, { data: { connectionId, caller } })) return undefined
      return new Response('Expected a WebSocket upgrade', { status: 400 })
    },
    websocket: {
      open(ws) {
        connections.add(ws)
        const { connectionId, caller } = ws.data
        store.append({
          type: 'PresenceJoined',
          actorKind: caller.kind,
          actorId: caller.id,
          payload: { connectionId, subjectKind: caller.kind, subjectId: caller.id, name: caller.name },
        })
        send(ws, {
          type: 'hello',
          protocol: WORKSPACE_PROTOCOL_VERSION,
          caller: { kind: caller.kind, id: caller.id, name: caller.name, role: caller.role },
          latestSeq: store.latestSeq(),
        })
      },
      async message(ws, raw) {
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
        if (!isWorkspaceRpcRequest(parsed)) {
          send(ws, { type: 'response', id: 'unknown', ok: false, error: 'invalid workspace RPC envelope' })
          return
        }
        const ctx: RpcContext = {
          store,
          caller: ws.data.caller,
          connectionId: ws.data.connectionId,
          requestShutdown: () => queueMicrotask(() => stop()),
          planner: options.planner,
        }
        try {
          const result = await dispatchRpc(ctx, parsed.method, parsed.params ?? {})
          send(ws, { type: 'response', id: parsed.id, ok: true, result })
        } catch (error) {
          const message = error instanceof RpcError || error instanceof Error ? error.message : String(error)
          send(ws, { type: 'response', id: parsed.id, ok: false, error: message.slice(0, 4_000) })
        }
      },
      close(ws) {
        connections.delete(ws)
        try {
          store.append({
            type: 'PresenceLeft',
            actorKind: ws.data.caller.kind,
            actorId: ws.data.caller.id,
            payload: { connectionId: ws.data.connectionId },
          })
        } catch {
          // Store may already be closing during shutdown.
        }
      },
    },
  })

  function stop(): void {
    if (stopping) return
    stopping = true
    clearInterval(reconcileTimer)
    unsubscribe()
    for (const ws of connections) {
      try {
        ws.close(1001, 'server shutting down')
      } catch {
        /* already closing */
      }
    }
    server.stop(true)
    if (ownsStore) store.close()
  }

  const port = server.port ?? options.port ?? 0
  const url = `ws://${hostname}:${port}/workspace`
  return { url, port, store, stop }
}

function send(ws: ServerWebSocket<ConnectionData>, message: WorkspaceServerMessage): void {
  try {
    ws.send(JSON.stringify(message))
  } catch {
    // The connection may already be closing.
  }
}

export interface WorkspaceServerInfo {
  url: string
  pid: number
  startedAt: string
}

/** Where a locally running server advertises its address for client auto-attach. */
export function writeServerInfo(url: string): void {
  ensureSecureDirectory(paths.workspaceState)
  const info: WorkspaceServerInfo = { url, pid: process.pid, startedAt: new Date().toISOString() }
  writeSecureFile(paths.workspaceServerInfo, JSON.stringify(info, null, 2))
}

export function clearServerInfo(): void {
  try {
    rmSync(paths.workspaceServerInfo, { force: true })
  } catch {
    // Nothing to clear.
  }
}

/** CLI entry: start a long-lived server and keep the process alive until Ctrl+C. */
export async function serveWorkspace(options: WorkspaceServerOptions): Promise<void> {
  const running = runWorkspaceServer(options)
  const localhost = (options.hostname ?? '127.0.0.1') === '127.0.0.1'
  writeServerInfo(running.url)
  writeNotice(
    `Elia workspace server listening on ${running.url}` +
      (localhost ? ' (localhost-only)' : ' — reachable beyond this machine; bind a non-default host deliberately'),
  )
  const shutdown = () => {
    clearServerInfo()
    running.stop()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  await new Promise<void>(() => {
    // Bun.serve keeps the loop alive; resolve never — the signal handlers exit.
  })
}
