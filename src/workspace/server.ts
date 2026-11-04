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
import { setTimeout as sleep } from 'node:timers/promises'
import { rmSync } from 'node:fs'
import { writeNotice } from '../ui/stream.ts'
import { canonicalCwd, paths } from '../statePaths.ts'
import { ensureSecureDirectory, writeSecureFile } from '../securePersistence.ts'
import { startMeshSupervisor, startReplication, type MeshFileChange, type MeshSupervisorHandle, type MeshSupervisorOptions, type ReplicationHandle } from '../mesh/index.ts'
import { isMeshEventNotice, meshObservationEvents } from '../mesh/observation.ts'
import { WorkspaceStore, DEFAULT_WORKSPACE_DB } from './store.ts'
import { resolveCaller, type Caller } from './identity.ts'
import { Orchestrator } from './orchestrator.ts'
import { dispatchRpc, RpcError, type RpcContext } from './rpc.ts'
import { isWorkspaceRpcRequest, WORKSPACE_PROTOCOL_VERSION, type WorkspaceServerMessage } from './protocol.ts'
import { HEARTBEAT_INTERVAL_MS } from './types.ts'


const MAX_MESSAGE_LENGTH = 200_000

/**
 * Cursor key for a sidecar that named no peer.
 *
 * The sidecar tells a host its peers' transport ids in the `ready` frame but
 * tells a member only the host's certificate fingerprint, so a member has no
 * transport id to key its cursor on. It has exactly one peer anyway, so the key
 * only has to be stable within this store — not unique across the workspace.
 */
const ATTACHED_PEER = 'attached-peer'

interface ConnectionData {
  connectionId: string
  caller: Caller
}

export interface WorkspaceServerOptions {
  port?: number
  hostname?: string
  dbPath?: string
  /** Origins permitted to open a WebSocket. Any connection sending an `Origin`
   * header (i.e. any browser) is refused unless listed; a non-browser client
   * sends no Origin and is judged by its bearer token alone. Default: refuse
   * every Origin-bearing connection. */
  allowedOrigins?: string[]
  /** Injected in tests; defaults to opening `dbPath`. */
  store?: WorkspaceStore
  /** Objective planner override; defaults to the model-backed planner. */
  planner?: import('./decompose.ts').ObjectivePlanner
  /** Run the orchestration reactor in-process (default true). */
  orchestrate?: boolean
  /** Ceiling on concurrently dispatched tasks (default 8). */
  maxConcurrentDispatch?: number
  /** Orchestrator safety-net sweep cadence in ms (default 5000). */
  sweepMs?: number
  /** Project root the file-plane sidecar synchronises. Defaults to the current directory. */
  root?: string
  /** Set false to serve without starting the mesh (tests, or serving a folder Elia should not sync). */
  mesh?: boolean
  /**
   * Test seam: stands in for the sidecar supervisor.
   *
   * The mesh callbacks are the one part of this server with no way to exercise
   * without a real sidecar on a real network, which is why the whole inbound
   * path went untested and a member could silently drop everything it was sent.
   * A stand-in receives the options the server would have used, so a test can
   * drive `onReady` and `onControl` directly.
   */
  startMesh?: (options: MeshSupervisorOptions) => MeshSupervisorHandle
}

export interface RunningWorkspaceServer {
  url: string
  port: number
  store: WorkspaceStore
  orchestrator?: Orchestrator
  /** The file-plane supervisor, when one was started. Gated by `ELIA_WORKSPACE_MESH`. */
  mesh?: MeshSupervisorHandle
  /**
   * The replication handle, or undefined when the mesh is off.
   *
   * A getter rather than a captured value: the handle is re-keyed when the
   * sidecar finally names its peer, and a snapshot would keep pointing at the
   * one that was replaced.
   */
  readonly replication?: ReplicationHandle
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
    // Snapshot: a failed `ws.send` can synchronously run the close handler, which
    // appends `PresenceLeft` and re-enters this fan-out, mutating `connections`.
    for (const ws of [...connections]) {
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
      // Piggybacks on the same sweep rather than its own timer: with the
      // conservative defaults (90 days / 200k events) this is a cheap no-op on
      // almost every tick once the table is within the window, so there is no
      // need for a separate, slower-cadence scheduler just for this.
      store.pruneOldEvents()
      // This machine's own node presence.
      //
      // Written locally as well as replicated, so the local node shows up in the
      // same list as the peer rather than needing a special case in every view.
      // It is the mechanism by which "who is online" is answerable at all: the
      // peer's `presence` table is about WebSocket connections to *this* server
      // and says nothing about the other machine.
      store.append({
        type: 'NodeHeartbeat', actorKind: 'system', actorId: 'workspace-server',
        payload: { id: store.localNodeId, name: nodeLabelFor(store), kind: options.mesh === false ? 'local' : 'mesh' },
      })
    } catch {
      // A transient lock; the next tick retries.
    }
  }, HEARTBEAT_INTERVAL_MS)
  // Announce this node immediately, so a freshly started server is visible to the
  // peer without waiting a whole interval — and is visible at all if it dies
  // before the first tick.
  try {
    store.append({
      type: 'NodeHeartbeat', actorKind: 'system', actorId: 'workspace-server',
      payload: { id: store.localNodeId, name: nodeLabelFor(store), kind: options.mesh === false ? 'local' : 'mesh' },
    })
  } catch {
    // A brand-new store that cannot record its own presence is not fatal.
  }

  const orchestrator = options.orchestrate === false
    ? undefined
    : new Orchestrator({ store, maxConcurrentDispatch: options.maxConcurrentDispatch, sweepMs: options.sweepMs })
  orchestrator?.start()

  // The file plane runs beside the coordination server: the server is the
  // long-lived per-project process and owns the store the observations land in.
  // It stays off unless ELIA_WORKSPACE_MESH enables it, and `auto` starts only
  // an already-paired workspace, so serving a folder never silently begins
  // syncing it.
  // The control plane rides the same process and the same authenticated link as
  // the file plane, so it is started from inside the supervisor's callbacks: the
  // peer node id is only knowable once the sidecar reports it in its ready
  // frame, and the transport only exists once a process is running.
  let replication: ReplicationHandle | undefined
  const mesh = options.mesh === false
    ? undefined
    : (options.startMesh ?? startMeshSupervisor)({
        root: options.root ?? process.env.ELIA_WORKSPACE_ROOT ?? process.env.WORKSPACE_ROOT ?? canonicalCwd(),
        onFileChange: (change) => recordMeshChange(store, change),
        onInvite: (invite) =>
          writeNotice(
            `Workspace mesh: pairing code ${invite.code}${invite.expiresAt ? ` (expires ${invite.expiresAt})` : ''} — copy this to the other machine to join`,
          ),
        onEvent: (event) => {
          if (isMeshEventNotice(event.kind)) writeNotice(`Workspace mesh: ${event.message}`)
        },
        onReady: (ready) => {
          // The sidecar's certificate fingerprint is the node's identity: the
          // transport has already authenticated it against this node's pin, so
          // binding to it here gives the control plane one identity per machine
          // rather than a second one minted here.
          store.bindNodeFingerprint(ready.fingerprint)
          startPeerReplication(ready.peers[0]?.peerId)
        },
        onControl: (control) => {
          const applied = replication?.receive(control) ?? 0
          if (applied > 0) writeNotice(`Workspace mesh: applied ${applied} event(s) from the peer`)
          const error = store.replicationError()
          if (error !== undefined) writeNotice(`Workspace mesh: refused an inbound event — ${error}`)
        },
        onLine: (line) => {
          // Opt-in: the sidecar narrates continuously once a file watcher is
          // running, and this is a debugging aid rather than something to read.
          if (process.env.ELIA_WORKSPACE_MESH_TRACE === '1') writeNotice(`Workspace mesh | ${line}`)
        },
        onFailure: (message) => writeNotice(`Workspace mesh: ${message}`),
        onRestart: (restart) =>
          writeNotice(
            `Workspace mesh: restarting in ${Math.max(1, Math.round(restart.delayMs / 1000))}s (attempt ${restart.attempt}) — ${restart.reason}`,
          ),
      })

  /**
   * Starts relaying this store's events to the attached peer, and makes this
   * store ready to apply the ones that arrive back.
   *
   * Started unconditionally, on both roles. It used to require the sidecar's
   * transport peer id and so only ever ran on the host, because only the host
   * lists peers in its `ready` frame — a member's is empty, and it is told its
   * host by certificate fingerprint instead. That meant a member created no
   * replication handle at all, so `onControl` had nothing to hand an inbound
   * frame to and every event the host sent was dropped on the floor. The
   * member looked connected, and nothing arrived.
   *
   * The peer id is only a bookkeeping key for the cursor, never an address: the
   * sidecar relays control to whichever peer is attached. A member has exactly
   * one peer, so it uses a fixed key rather than inventing an id.
   */
  function startPeerReplication(transportPeerId: string | undefined): void {
    const key = transportPeerId !== undefined && transportPeerId !== '' ? transportPeerId : ATTACHED_PEER
    if (replication?.peerNodeId === key) return
    // Re-keying restarts the cursor, which makes the next flush re-send from the
    // beginning. That is deliberate. A host that comes up before its member
    // otherwise pushes its backlog into the void: the sidecar accepts the frame,
    // the member's store has no handle to apply it with, and the cursor advances
    // past events that were never applied. Re-sending is free of consequence
    // because the receiver deduplicates on event id.
    replication?.stop()
    replication = startReplication({
      store,
      peerNodeId: key,
      send: (control) => mesh?.sendControl(control) ?? false,
    })
  }

  // Started here rather than in `onReady`. The sidecar attaches to a peer that
  // already has events waiting for it, and can relay one before it has finished
  // announcing anything; with the handle created only at `onReady` that first
  // frame had nowhere to go and was discarded. It is keyed by a placeholder until
  // the real transport id is known, which costs one re-send and nothing else.
  startPeerReplication(undefined)

  let stopping = false
  const server = Bun.serve<ConnectionData>({
    port: options.port ?? 0,
    hostname,
    fetch(request, srv) {
      const url = new URL(request.url)
      if (url.pathname !== '/workspace') {
        return new Response('elia workspace server: connect over WebSocket at /workspace', { status: 404 })
      }
      // Same browser cross-origin rule as the bridge: a browser's Origin is
      // refused unless explicitly allowed. Local CLI/TUI clients send none.
      const origin = request.headers.get('origin')
      if (origin && !(options.allowedOrigins ?? []).includes(origin)) {
        return new Response('Forbidden: this Origin is not allowed to open a workspace connection', { status: 403 })
      }
      // Bearer header only. A token in the query string lands in proxy/access
      // logs, shell history and process listings, and outlives its revocation
      // there — refuse it loudly rather than accept it, so a client doing it
      // gets fixed instead of silently working.
      if (url.searchParams.has('token')) {
        return new Response('Bad Request: send the workspace token in an "Authorization: Bearer" header, not the ?token= query string', { status: 400 })
      }
      const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || undefined
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
    replication?.stop()
    mesh?.stop()
    orchestrator?.stop()
    unsubscribe()
    for (const ws of [...connections]) {
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
  return {
    url,
    port,
    store,
    orchestrator,
    mesh,
    get replication() {
      return replication
    },
    stop,
  }
}

/**
 * Records one file-plane observation on the event spine.
 *
 * A change the sidecar reports is a node-level fact, not a member's or an
 * agent's action, so it is attributed to `system` with the originating node id.
 * The payload is the persistable metadata from `buildFileChangedPayload` — the
 * diff body was already withheld there and is deliberately not carried here,
 * because the event log is durable, replicated and audited.
 */
/**
 * This node's display name, taken from the `nodes` row rather than recomputed,
 * so the name shown in a heartbeat is the same one the row already carries.
 */
function nodeLabelFor(store: WorkspaceStore): string {
  return store.node(store.localNodeId)?.name ?? 'this node'
}

function recordMeshChange(store: WorkspaceStore, change: MeshFileChange): void {
  try {
    for (const input of meshObservationEvents(change)) store.append(input)
  } catch {
    // The store may be shutting down. A dropped observation is preferable to
    // letting one failed append take the mesh reader down with it, which would
    // stop every change that followed.
  }
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

  if (options.mesh !== false && process.stdout.isTTY) {
    try {
      const start = Date.now()
      const timeoutMs = 10 * 60_000
      while (Date.now() - start < timeoutMs) {
        const presence = running.store.nodePresence()
        const peers = running.store.nodes().filter((n) => !n.isLocal)
        if (peers.length > 0 || presence.some((p) => p.nodeId !== running.store.localNodeId && p.online)) {
          process.off('SIGINT', shutdown)
          process.off('SIGTERM', shutdown)
          running.stop()
          clearServerInfo()
          const { runWatch } = await import('./cli.ts')
          await runWatch()
          return
        }
        await sleep(1000)
      }
    } catch {
      // fall through to blocking serve
    }
  }

  await new Promise<void>(() => {
    // Bun.serve keeps the loop alive; resolve never — the signal handlers exit.
  })
}
