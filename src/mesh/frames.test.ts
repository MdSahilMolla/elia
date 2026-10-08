import { expect, test } from 'bun:test'
import { MESH_PROTOCOL_VERSION, encodeMeshControl, parseMeshFrame, toIncomingFileChange } from './frames.ts'
import type { ReplicatedEvent } from '../workspace/events.ts'

test('parses a ready frame with full fingerprints and peers', () => {
  const line = JSON.stringify({
    type: 'ready',
    protocol: MESH_PROTOCOL_VERSION,
    workspace_id: 'ws_1',
    peer_id: 'peer_a',
    role: 'host',
    root: '/proj',
    listen_addr: '127.0.0.1:5000',
    fingerprint: 'aa'.repeat(32),
    host_fingerprint: 'bb'.repeat(32),
    peers: [{ peer_id: 'peer_b', role: 'member', cert_sha256: 'cc'.repeat(32), last_seen: '2026-01-01T00:00:00Z' }],
  })
  const frame = parseMeshFrame(line)
  expect(frame?.type).toBe('ready')
  if (frame?.type !== 'ready') return
  expect(frame.ready.protocol).toBe(MESH_PROTOCOL_VERSION)
  expect(frame.ready.workspaceId).toBe('ws_1')
  // The full 64-char digest survives; a truncation here would let two peers
  // sharing a prefix collide.
  expect(frame.ready.fingerprint).toBe('aa'.repeat(32))
  expect(frame.ready.hostFingerprint).toBe('bb'.repeat(32))
  expect(frame.ready.peers[0]?.certSha256).toBe('cc'.repeat(32))
})

test('a ready frame without an identity is rejected rather than half-trusted', () => {
  expect(parseMeshFrame(JSON.stringify({ type: 'ready', protocol: 1 }))).toBeUndefined()
})

test('maps a change frame from snake_case and normalises the operation', () => {
  const line = JSON.stringify({
    type: 'change',
    change: {
      path: 'src/a.ts',
      op: 'update',
      origin_node: 'peer_b',
      base_version: 3,
      version: 4,
      old_hash: 'old',
      new_hash: 'new',
      size: 42,
      added: 2,
      removed: 1,
      patch: '@@ -1 +1 @@\n-a\n+b',
    },
  })
  const frame = parseMeshFrame(line)
  expect(frame?.type).toBe('change')
  if (frame?.type !== 'change') return
  // "update" is the component's name; Elia's persisted vocabulary says "write".
  expect(frame.change.op).toBe('write')
  expect(frame.change.originNode).toBe('peer_b')
  expect(frame.change.oldSha).toBe('old')
  expect(frame.change.newSha).toBe('new')
  expect(frame.change.added).toBe(2)
  expect(frame.change.patch).toBe('@@ -1 +1 @@\n-a\n+b')
  expect(frame.change.conflict).toBe(false)
})

test('an absent line count is zero, not a missing field', () => {
  const frame = parseMeshFrame(JSON.stringify({ type: 'change', change: { path: 'img.png', op: 'create', size: 900 } }))
  if (frame?.type !== 'change') throw new Error('expected a change frame')
  expect(frame.change.added).toBe(0)
  expect(frame.change.removed).toBe(0)
  expect(frame.change.patch).toBeUndefined()
})

test('a conflict carries its kept path and reason', () => {
  const frame = parseMeshFrame(
    JSON.stringify({
      type: 'change',
      change: { path: 'src/a.ts', op: 'write', conflict: true, kept_path: 'src/a.ts.conflict-1', reason: 'both sides edited' },
    }),
  )
  if (frame?.type !== 'change') throw new Error('expected a change frame')
  expect(frame.change.conflict).toBe(true)
  expect(frame.change.keptPath).toBe('src/a.ts.conflict-1')
  expect(frame.change.reason).toBe('both sides edited')
})

test('parses invite, event and error frames', () => {
  const invite = parseMeshFrame(JSON.stringify({ type: 'invite', code: 'ABCD-EFGH', url: 'elia://join/ABCD-EFGH', expires_at: '2026-01-01T00:15:00Z' }))
  expect(invite?.type).toBe('invite')
  if (invite?.type === 'invite') expect(invite.invite.expiresAt).toBe('2026-01-01T00:15:00Z')

  const event = parseMeshFrame(JSON.stringify({ type: 'event', kind: 'info', message: 'watching', time: '2026-01-01T00:00:00Z' }))
  expect(event?.type).toBe('event')
  if (event?.type === 'event') expect(event.event.kind).toBe('info')

  const error = parseMeshFrame(JSON.stringify({ type: 'error', message: 'no workspace' }))
  expect(error?.type).toBe('error')
  if (error?.type === 'error') expect(error.message).toBe('no workspace')
})

test('malformed and unknown lines are ignored, never thrown', () => {
  expect(parseMeshFrame('not json')).toBeUndefined()
  expect(parseMeshFrame('')).toBeUndefined()
  expect(parseMeshFrame('[]')).toBeUndefined()
  expect(parseMeshFrame(JSON.stringify({ type: 'something-new' }))).toBeUndefined()
  expect(parseMeshFrame(JSON.stringify({ type: 'change' }))).toBeUndefined()
})

test('toIncomingFileChange carries the diff body for display only when present', () => {
  const withPatch = toIncomingFileChange({
    path: 'src/a.ts',
    op: 'write',
    originNode: 'local',
    oldSha: 'o',
    newSha: 'n',
    added: 1,
    removed: 1,
    size: 10,
    patch: '@@ -1 +1 @@',
    conflict: false,
  })
  expect(withPatch.diff).toBe('@@ -1 +1 @@')

  const withoutPatch = toIncomingFileChange({
    path: 'img.png',
    op: 'create',
    originNode: 'local',
    oldSha: '',
    newSha: 'n',
    added: 0,
    removed: 0,
    size: 10,
    conflict: false,
  })
  expect(withoutPatch.diff).toBeUndefined()
})

// The event body below is a realistic replicated event, and that matters: this
// parser drops an entry it cannot read rather than failing the frame, so a
// capture taken from a test that only cared about relaying bytes would prove
// nothing. It has to be a shape a real node actually sends.
//
// The two halves of the relay are separate programs in separate languages, and
// neither one owns the other's serialiser. That makes the exact bytes a contract
// in the way an ordinary function signature is not: a field renamed on the Go
// side, or a change to how it orders keys, would produce a frame that decodes
// cleanly and carries nothing.
//
// So the line below is a literal capture of what the sidecar's stdout writer
// emits, keys included in the order Go's map marshalling produces. If either side
// changes shape, this is the test that says so.
const EVENT: ReplicatedEvent = {
  id: 'evt_1', type: 'AgentHeartbeat', actorKind: 'system', actorId: 'workspace-server',
  payload: { agentId: 'agt_1' }, at: '2026-10-02T10:00:00.000Z',
}

test('a relayed control frame written by the sidecar parses here', () => {
  const line =
    '{"events":[{"actorId":"m_1","actorKind":"member","at":"2026-10-02T10:00:00.000Z","id":"evt_h2m","payload":{"status":"active"},"type":"ObjectiveStatusChanged"}],"node":"nd_host","type":"control"}\n'
  const frame = parseMeshFrame(line)
  expect(frame).toBeDefined()
  if (frame?.type !== 'control') throw new Error(`expected a control frame, got ${frame?.type}`)
  // The relay forwards the supervisor's object field for field, so `node` and
  // `events` sit at the top level rather than nested under a body this side
  // would have to know the name of.
  expect(frame.control.node).toBe('nd_host')
  expect(frame.control.events).toHaveLength(1)
  expect(frame.control.events[0]!.id).toBe('evt_h2m')
  expect(frame.control.events[0]!.type).toBe('ObjectiveStatusChanged')
  expect(frame.control.events[0]!.actorNode).toBeUndefined()
})

// The relay strips the stdio discriminator before it goes on the wire and the
// envelope re-adds its own. A `type` that survived from the supervisor's line
// would be indistinguishable from the envelope's, and the wrong one would win.
test('a control frame survives the relay without carrying the stdio discriminator', () => {
  // `encodeMeshControl` is what this node writes into the sidecar's stdin; the
  // sidecar relays the same object with `type` swapped for the wire envelope's.
  const outbound = JSON.parse(encodeMeshControl({ node: 'nd_host', events: [EVENT] })) as Record<string, unknown>
  expect(outbound['type']).toBe('control')
  delete outbound['type']

  const frame = parseMeshFrame(JSON.stringify({ ...outbound, type: 'control' }))
  if (frame?.type !== 'control') throw new Error('control frame did not survive the round trip')
  expect(frame.control.node).toBe('nd_host')
  expect(frame.control.events[0]!.id).toBe(EVENT.id)
})
