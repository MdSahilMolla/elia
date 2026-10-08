/**
 * The wire contract of `workspace attach` — the sidecar's newline-delimited
 * JSON stream — turned into typed values Elia can act on.
 *
 * The producer is Go (`internal/cli/stdio.go`, `internal/sync/changes.go`);
 * this file mirrors it and is the only place field names are translated. The
 * protocol is versioned because a consumer binds node identity to the ready
 * frame's full certificate fingerprints, and a silent change to what those
 * bytes mean would be a security bug rather than a display bug.
 *
 * Parsing is total and never throws: a malformed line yields `undefined`, so a
 * single bad frame cannot take down the reader. The supervisor treats that as
 * "ignore the line", not "the stream is broken".
 */

import { isWorkspaceEventType, type ReplicatedEvent } from '../workspace/events.ts'
import type { FileChangeOp, IncomingFileChange } from '../workspace/fileChange.ts'

/** Bumped on any breaking change to a frame's fields or their meaning. */
export const MESH_PROTOCOL_VERSION = 1

/** One peer listed in the ready frame. The fingerprint is the full hex digest. */
export interface MeshPeer {
  peerId: string
  role: string
  certSha256: string
  lastSeen?: string
}

/**
 * The first frame of a session: the identity a supervisor binds to.
 *
 * `fingerprint` is this node's own certificate, and `hostFingerprint` the pinned
 * host's when this node is a member. Both are full 64-character digests; the
 * human `status` command truncates to twelve, which is unusable for binding.
 */
export interface MeshReady {
  protocol: number
  workspaceId: string
  peerId: string
  role: string
  root: string
  listenAddr?: string
  fingerprint: string
  hostFingerprint?: string
  peers: MeshPeer[]
}

/** A fresh join code, so a supervisor with no terminal can still show it. */
export interface MeshInvite {
  code: string
  url: string
  expiresAt?: string
}

/** A human-facing diagnostic, structured rather than prose. */
export interface MeshEvent {
  kind: string
  message: string
  time?: string
}

/**
 * The control plane: workspace events riding the file plane's authenticated
 * link.
 *
 * There is deliberately no second identity, keypair or listener for this. The
 * sidecar already authenticates both machines against pinned certificates, so
 * the control frame is relayed over that same connection and gets the same
 * guarantee — one identity per machine rather than two independent ones to keep
 * in sync. `seq` is absent because it is local to the sending database; the peer
 * orders by arrival and deduplicates on the event `id`.
 */
export interface MeshControl {
  /** The sending workspace's node id, for diagnostics and cursor attribution. */
  node?: string
  events: ReplicatedEvent[]
}

/** Bounds one batch, so a peer cannot make this node buffer without limit. */
const MAX_CONTROL_EVENTS = 500

/**
 * One file change, in the wire's snake_case form, normalised.
 *
 * Kept separate from `IncomingFileChange` because it carries the conflict
 * detail (`conflict`, `keptPath`, `reason`) that the persistable
 * `FileChanged` payload deliberately does not.
 */
export interface MeshChange {
  path: string
  op: FileChangeOp
  originNode: string
  oldSha: string
  newSha: string
  added: number
  removed: number
  size: number
  /** Unified diff text for display only; never persisted. */
  patch?: string
  conflict: boolean
  keptPath?: string
  reason?: string
}

export type MeshFrame =
  | { type: 'ready'; ready: MeshReady }
  | { type: 'invite'; invite: MeshInvite }
  | { type: 'change'; change: MeshChange }
  | { type: 'event'; event: MeshEvent }
  | { type: 'control'; control: MeshControl }
  | { type: 'error'; message: string; time?: string }

/** Parses one NDJSON line. Returns `undefined` for anything unrecognised. */
export function parseMeshFrame(line: string): MeshFrame | undefined {
  const trimmed = line.trim()
  if (trimmed === '') return undefined
  let raw: unknown
  try {
    raw = JSON.parse(trimmed)
  } catch {
    return undefined
  }
  if (!isRecord(raw)) return undefined

  switch (raw['type']) {
    case 'ready': {
      const ready = readReady(raw)
      return ready === undefined ? undefined : { type: 'ready', ready }
    }
    case 'invite': {
      const invite = readInvite(raw)
      return invite === undefined ? undefined : { type: 'invite', invite }
    }
    case 'change': {
      const change = readChange(raw['change'])
      return change === undefined ? undefined : { type: 'change', change }
    }
    case 'event': {
      const kind = str(raw['kind']) ?? 'event'
      const message = str(raw['message']) ?? ''
      return { type: 'event', event: { kind, message, ...optional('time', str(raw['time'])) } }
    }
    case 'control':
      return { type: 'control', control: readControl(raw) }
    case 'error': {
      const message = str(raw['message']) ?? 'unknown sidecar error'
      return { type: 'error', message, ...optional('time', str(raw['time'])) }
    }
    default:
      return undefined
  }
}

function readReady(raw: Record<string, unknown>): MeshReady | undefined {
  const protocol = num(raw['protocol'])
  const workspaceId = str(raw['workspace_id'])
  const peerId = str(raw['peer_id'])
  const root = str(raw['root'])
  const fingerprint = str(raw['fingerprint'])
  const role = str(raw['role'])
  if (protocol === undefined || workspaceId === undefined || peerId === undefined || root === undefined || fingerprint === undefined || role === undefined) {
    return undefined
  }
  return {
    protocol,
    workspaceId,
    peerId,
    role,
    root,
    fingerprint,
    ...optional('listenAddr', str(raw['listen_addr'])),
    ...optional('hostFingerprint', str(raw['host_fingerprint'])),
    peers: readPeers(raw['peers']),
  }
}

function readPeers(value: unknown): MeshPeer[] {
  if (!Array.isArray(value)) return []
  const peers: MeshPeer[] = []
  for (const entry of value) {
    if (!isRecord(entry)) continue
    const peerId = str(entry['peer_id'])
    const certSha256 = str(entry['cert_sha256'])
    if (peerId === undefined || certSha256 === undefined) continue
    peers.push({
      peerId,
      certSha256,
      role: str(entry['role']) ?? '',
      ...optional('lastSeen', str(entry['last_seen'])),
    })
  }
  return peers
}

function readInvite(raw: Record<string, unknown>): MeshInvite | undefined {
  const code = str(raw['code'])
  const url = str(raw['url'])
  if (code === undefined || url === undefined) return undefined
  return { code, url, ...optional('expiresAt', str(raw['expires_at'])) }
}

function readChange(value: unknown): MeshChange | undefined {
  if (!isRecord(value)) return undefined
  const path = str(value['path'])
  if (path === undefined) return undefined
  const patch = str(value['patch'])
  return {
    path,
    op: fileChangeOp(value['op']),
    originNode: str(value['origin_node']) ?? 'unknown',
    oldSha: str(value['old_hash']) ?? '',
    newSha: str(value['new_hash']) ?? '',
    added: num(value['added']) ?? 0,
    removed: num(value['removed']) ?? 0,
    size: num(value['size']) ?? 0,
    ...(patch !== undefined && patch !== '' ? { patch } : {}),
    conflict: value['conflict'] === true,
    ...optional('keptPath', str(value['kept_path'])),
    ...optional('reason', str(value['reason'])),
  }
}

/**
 * The component's operations are richer than the persisted vocabulary. A
 * rename is already sent to peers as a delete plus a create, so it should not
 * arrive here; if one does, it is treated as a write rather than dropped, so a
 * reader still learns the path changed.
 */
function fileChangeOp(value: unknown): FileChangeOp {
  switch (value) {
    case 'create':
      return 'create'
    case 'delete':
      return 'delete'
    case 'update':
    case 'rename':
    default:
      return 'write'
  }
}

/** The change as `buildFileChangedPayload` expects it, diff body included. */
export function toIncomingFileChange(change: MeshChange): IncomingFileChange {
  return {
    path: change.path,
    op: change.op,
    originNode: change.originNode,
    oldSha: change.oldSha,
    newSha: change.newSha,
    added: change.added,
    removed: change.removed,
    size: change.size,
    ...(change.patch !== undefined ? { diff: change.patch } : {}),
  }
}

/**
 * Decode a relayed control batch.
 *
 * Total by construction: an unrecognised event type or a malformed field drops
 * that event and keeps the rest, because a batch is a convenience and must not
 * be an all-or-nothing gate — one unknown type from a newer peer would
 * otherwise stall replication permanently. `node` is only a label here; the
 * authoritative node id is the one each event carries.
 */
function readControl(raw: Record<string, unknown>): MeshControl {
  const node = str(raw['node'])
  const events: ReplicatedEvent[] = []
  const list = raw['events']
  if (Array.isArray(list)) {
    for (const entry of list.slice(0, MAX_CONTROL_EVENTS)) {
      const event = readReplicatedEvent(entry)
      if (event !== undefined) events.push(event)
    }
  }
  return { ...optional('node', node), events }
}

function readReplicatedEvent(value: unknown): ReplicatedEvent | undefined {
  if (!isRecord(value)) return undefined
  const id = str(value['id'])
  const type = str(value['type'])
  const actorKind = str(value['actorKind'])
  const actorId = str(value['actorId'])
  const at = str(value['at'])
  if (id === undefined || type === undefined || actorKind === undefined || actorId === undefined || at === undefined) {
    return undefined
  }
  if (!isWorkspaceEventType(type)) return undefined
  const payload = value['payload']
  return {
    id,
    type,
    actorKind: actorKind as ReplicatedEvent['actorKind'],
    actorId,
    ...optional('actorNode', str(value['actorNode'])),
    ...optional('objectiveId', str(value['objectiveId'])),
    ...optional('taskId', str(value['taskId'])),
    ...(isRecord(payload) ? { payload } : { payload: {} }),
    at,
  }
}

/** Encodes a control batch for the sidecar's stdin. The mirror of `readControl`. */
export function encodeMeshControl(control: MeshControl): string {
  return `${JSON.stringify({
    type: 'control',
    ...(control.node !== undefined ? { node: control.node } : {}),
    events: control.events,
  })}\n`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Spreads `{ [key]: value }` only when the value is present, so an absent wire field stays absent. */
function optional<K extends string>(key: K, value: string | undefined): { [P in K]?: string } {
  return value === undefined ? {} : ({ [key]: value } as { [P in K]?: string })
}
