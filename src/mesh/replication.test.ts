/**
 * Control-frame decoding and the replication pump (M7).
 *
 * The pump is driven here through an in-memory pair of "transports" rather than
 * through the sidecar, because what is being tested is *what Elia decides to
 * send and how it applies what arrives* — not the Go relay, which is covered by
 * its own two-process tests.
 */
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkspace } from '../workspace/admin.ts'
import type { ReplicatedEvent } from '../workspace/events.ts'
import { WorkspaceStore } from '../workspace/store.ts'
import { encodeMeshControl, parseMeshFrame, type MeshControl } from './frames.ts'
import { shouldReplicate, startReplication } from './replication.ts'

const dirs: string[] = []
const stores: WorkspaceStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close()
    } catch {
      // already closed
    }
  }
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Windows can hold a brief lock on a just-closed SQLite file
    }
  }
})

function open(): WorkspaceStore {
  const dir = mkdtempSync(join(tmpdir(), 'elia-repl-'))
  dirs.push(dir)
  const store = WorkspaceStore.open(join(dir, 'workspace.sqlite'))
  stores.push(store)
  return store
}

function seed(store: WorkspaceStore): string {
  const created = createWorkspace(store, { name: 'demo', ownerName: 'sam' })
  const objectiveId = 'obj_1'
  store.append({
    type: 'ObjectiveCreated', actorKind: 'member', actorId: created.ownerMemberId, objectiveId,
    payload: { id: objectiveId, workspaceId: created.workspaceId, projectId: created.projectId, goal: 'ship', runId: 'run_1' },
  })
  store.append({
    type: 'ObjectiveStatusChanged', actorKind: 'member', actorId: created.ownerMemberId, objectiveId,
    payload: { status: 'awaiting-approval' },
  })
  store.append({
    type: 'ObjectiveStatusChanged', actorKind: 'member', actorId: created.ownerMemberId, objectiveId,
    payload: { status: 'active', approvedBy: created.ownerMemberId },
  })
  store.append({
    type: 'TaskCreated', actorKind: 'member', actorId: created.ownerMemberId, objectiveId,
    payload: { id: 't_1', objectiveId, projectId: created.projectId, title: 'T', role: 'backend', dependsOn: [], files: [] },
  })
  return created.ownerMemberId
}

// --- frame decoding ----------------------------------------------------------

const EVENT: ReplicatedEvent = {
  id: 'evt_1',
  type: 'ObjectiveStatusChanged',
  actorKind: 'member',
  actorId: 'mbr_1',
  actorNode: 'nd_peer',
  objectiveId: 'obj_1',
  payload: { status: 'active' },
  at: '2026-03-01T12:00:00.000Z',
}

test('a control frame round-trips through encode and parse', () => {
  const frame = parseMeshFrame(encodeMeshControl({ node: 'nd_me', events: [EVENT] }))
  expect(frame?.type).toBe('control')
  if (frame?.type !== 'control') throw new Error('expected a control frame')
  expect(frame.control).toEqual({ node: 'nd_me', events: [EVENT] })
})

test('a control event with no seq, as it must be on the wire, is accepted', () => {
  // `seq` is local to the sending database, so it is absent here by design.
  expect('seq' in EVENT).toBe(false)
  const frame = parseMeshFrame(JSON.stringify({ type: 'control', events: [EVENT] }))
  expect(frame?.type).toBe('control')
})

test('one malformed event does not discard the rest of the batch', () => {
  const frame = parseMeshFrame(JSON.stringify({
    type: 'control',
    events: [EVENT, { type: 'NotAnEventType', id: 'evt_2', actorKind: 'member', actorId: 'm', at: 'x' }, { nope: true }, { ...EVENT, id: 'evt_3' }],
  }))
  if (frame?.type !== 'control') throw new Error('expected a control frame')
  // A newer peer sending a type this build does not know must not stall
  // replication permanently, so the bad entries drop and the good ones apply.
  expect(frame.control.events.map((event) => event.id)).toEqual(['evt_1', 'evt_3'])
})

test('a control frame is bounded', () => {
  const events = Array.from({ length: 900 }, (_, index) => ({ ...EVENT, id: `evt_${index}` }))
  const frame = parseMeshFrame(JSON.stringify({ type: 'control', events }))
  if (frame?.type !== 'control') throw new Error('expected a control frame')
  expect(frame.control.events).toHaveLength(500)
})

test('a non-object payload is normalised rather than trusted', () => {
  const frame = parseMeshFrame(JSON.stringify({ type: 'control', events: [{ ...EVENT, payload: 'nope' }] }))
  if (frame?.type !== 'control') throw new Error('expected a control frame')
  expect(frame.control.events[0]!.payload).toEqual({})
})

// --- the send filter ---------------------------------------------------------

test('local presence is never sent to the peer', () => {
  const store = open()
  const event = store.append({
    type: 'PresenceJoined', actorKind: 'system', actorId: 'mesh',
    payload: { connectionId: 'c1', subjectKind: 'agent', subjectId: 'a1', name: 'be' },
  })
  expect(event.actorNode).toBe(store.localNodeId)
  expect(shouldReplicate(event)).toBe(false)
})

test('a node heartbeat is sent, because node presence is shared', () => {
  const store = open()
  const event = store.append({
    type: 'NodeHeartbeat', actorKind: 'system', actorId: 'mesh', payload: { id: 'nd_peer', name: 'studio' },
  })
  expect(shouldReplicate(event)).toBe(true)
})

test('a mirrored event is not sent back to the peer that sent it', () => {
  const owner = open()
  const follower = open()
  seed(owner)
  const pumpO = startReplication({ store: owner, peerNodeId: 'nd_peer', send: () => true, intervalMs: 3_600_000 })
  const pumpF = startReplication({ store: follower, peerNodeId: owner.localNodeId, send: () => true, intervalMs: 3_600_000 })

  // Deliver the owner's history to the follower...
  const batch = { events: owner.events().map((event) => { const { seq: _seq, ...rest } = event; return rest }) }
  expect(pumpF.receive(batch)).toBe(owner.events().length)
  // ...and the follower must have nothing to say back. Without the arrival
  // filter it would return all of them, and the two nodes would trade the same
  // events back and forth for as long as both were running.
  expect(pumpF.flush()).toBe(true)
  let resent = 0
  const pumpSpy = startReplication({ store: follower, peerNodeId: owner.localNodeId, send: () => { resent += 1; return true }, intervalMs: 3_600_000 })
  pumpSpy.flush()
  expect(resent).toBe(0)
  pumpO.stop()
  pumpF.stop()
  pumpSpy.stop()
})

// --- the pump ----------------------------------------------------------------

test('flush sends unseen events and the cursor only advances past what was delivered', () => {
  const a = open()
  seed(a)
  const sent: MeshControl[] = []
  const pump = startReplication({ store: a, peerNodeId: 'nd_peer', send: (c) => { sent.push(c); return true }, intervalMs: 3_600_000 })

  expect(pump.flush()).toBe(true)
  expect(sent).toHaveLength(1)
  expect(sent[0]!.node).toBe(a.localNodeId)
  expect(sent[0]!.events.map((event) => event.type)).toEqual(['WorkspaceCreated', 'MemberAdded', 'TokenMinted', 'ObjectiveCreated', 'ObjectiveStatusChanged', 'ObjectiveStatusChanged', 'TaskCreated'])
  // No `seq` on the wire: it is local to this database.
  expect('seq' in sent[0]!.events[0]!).toBe(false)
  expect(a.replicationCursor('nd_peer')).toBe(a.latestSeq())

  // A second flush has nothing left to say.
  expect(pump.flush()).toBe(true)
  expect(sent).toHaveLength(1)
  pump.stop()
})

test('a batch the transport refuses is retried rather than skipped', () => {
  const a = open()
  seed(a)
  let online = false
  const sent: MeshControl[] = []
  const pump = startReplication({ store: a, peerNodeId: 'nd_peer', send: (c) => { sent.push(c); return online }, intervalMs: 3_600_000 })
  const before = a.replicationCursor('nd_peer')

  expect(pump.flush()).toBe(false)
  expect(a.replicationCursor('nd_peer')).toBe(before)
  expect(sent).toHaveLength(1)

  online = true
  expect(pump.flush()).toBe(true)
  expect(a.replicationCursor('nd_peer')).toBe(a.latestSeq())
  // The retry resends the same events; the peer's idempotence is what makes that
  // safe, so nothing is lost and nothing is duplicated.
  expect(sent).toHaveLength(2)
  expect(sent[1]!.events.map((event) => event.id)).toEqual(sent[0]!.events.map((event) => event.id))
  pump.stop()
})

test('the pump converges a peer, and re-delivery changes nothing', () => {
  const a = open()
  const b = open()
  seed(a)
  const queue: MeshControl[] = []
  const pumpA = startReplication({ store: a, peerNodeId: 'nd_peer', send: (c) => { queue.push(c); return true }, intervalMs: 3_600_000 })
  const pumpB = startReplication({ store: b, peerNodeId: a.localNodeId, send: () => true, intervalMs: 3_600_000 })

  pumpA.flush()
  expect(pumpB.receive(queue.shift()!)).toBe(a.events().length)
  expect(b.objective('obj_1')!.goal).toBe('ship')
  expect(b.objective('obj_1')!.status).toBe('active')
  expect(b.tasks()).toHaveLength(1)

  // At-least-once: the same batch again is a no-op, not a duplicate row.
  const replay = a.events({ limit: 5000 }).map((event) => {
    const { seq: _seq, ...rest } = event
    return rest
  })
  expect(pumpB.receive({ events: replay })).toBe(0)
  expect(b.events()).toHaveLength(a.events().length)
  expect(b.auditChainIntact()).toBe(true)

  // A's event, mirrored into B. Its `actorNode` is still A's, so attribution is
  // preserved for display — and arrival is the only thing that keeps B from
  // returning it.
  const mirrored = b.events().find((event) => event.id === replay[0]!.id)!
  expect(mirrored.actorNode).toBe(a.localNodeId)
  expect(shouldReplicate(mirrored)).toBe(true)
  expect(shouldReplicate(mirrored, b.inboundEventIds([mirrored.id]).has(mirrored.id))).toBe(false)
  pumpA.stop()
  pumpB.stop()
})

test('a peer cannot overwrite history by reusing an event id', () => {
  const a = open()
  const b = open()
  seed(a)
  const pumpB = startReplication({ store: b, peerNodeId: a.localNodeId, send: () => true, intervalMs: 3_600_000 })
  const batch = { events: a.events().map((event) => { const { seq: _seq, ...rest } = event; return rest }) }
  expect(pumpB.receive(batch)).toBe(a.events().length)
  const objectiveBefore = b.objective('obj_1')!.goal

  // Same id, different meaning. Idempotence on the id is what makes this safe,
  // so a peer cannot rewrite an event this node has already applied.
  const first = batch.events[0]!
  expect(pumpB.receive({ events: [{ ...first, payload: { name: 'hijacked' } }] })).toBe(0)
  expect(b.objective('obj_1')!.goal).toBe(objectiveBefore)
  expect(b.workspace()!.name).toBe('demo')
  pumpB.stop()
})

test('an event the peer cannot project is skipped alone, not fatal to the batch', () => {
  const b = open()
  const pumpB = startReplication({ store: b, peerNodeId: 'nd_peer', send: () => true, intervalMs: 3_600_000 })
  // An objective this node has never seen, followed by one it can apply. The
  // first must not stall the second, and must not throw out of `receive` —
  // which would kill the transport from inside a network callback.
  expect(() => pumpB.receive({ events: [{ ...EVENT, id: 'evt_bad' }] })).not.toThrow()
  expect(b.events()).toHaveLength(0)
  expect(b.replicationError()).toContain('evt_bad')

  // And the stream keeps working: the refusal did not wedge the batch, and the
  // next success clears the error so it always describes the latest outcome.
  const registrable: ReplicatedEvent = { ...EVENT, id: 'evt_node', type: 'NodeRegistered', objectiveId: undefined, payload: { id: 'nd_far', name: 'laptop' } }
  expect(pumpB.receive({ events: [registrable] })).toBe(1)
  expect(b.node('nd_far')).toBeDefined()
  expect(b.replicationError()).toBeUndefined()

  const good = open()
  seed(good)
  const batch = good.events().map((event) => { const { seq: _seq, ...rest } = event; return rest })
  expect(pumpB.receive({ events: batch })).toBe(batch.length)
  expect(b.objective('obj_1')!.status).toBe('active')
  pumpB.stop()
})

test('stop halts the periodic flush', () => {
  const a = open()
  seed(a)
  const sent: MeshControl[] = []
  const pump = startReplication({ store: a, peerNodeId: 'nd_peer', send: (c) => { sent.push(c); return true }, intervalMs: 1 })
  pump.stop()
  expect(pump.flush()).toBe(false)
  expect(sent).toHaveLength(0)
})

test('a handle reports the cursor key it is keeping', async () => {
  // The key is what the server re-keys on when a sidecar finally names its peer,
  // so a handle that did not report its own key could not be compared, and the
  // restart that makes the re-send happen would have had nothing to test.
  const store = WorkspaceStore.open(join(mkdtempSync(join(tmpdir(), 'elia-repl-key-')), 'peer.sqlite'))
  stores.push(store)
  const handle = startReplication({ store, peerNodeId: 'transport-1', send: () => true })
  try {
    expect(handle.peerNodeId).toBe('transport-1')
  } finally {
    handle.stop()
  }
})
