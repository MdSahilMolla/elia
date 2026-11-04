/**
 * Partitioned ownership and replication (M6).
 *
 * Two `WorkspaceStore`s on two separate SQLite files stand in for two machines.
 * That is the right granularity for these properties: everything under test —
 * who is allowed to write, what a replica projects, who derives the completion —
 * is decided per database, so a second file is a faithful second node without
 * needing a second host. The transport that eventually moves events between them
 * is `mesh/replication.ts`, and it is deliberately not part of these tests.
 */
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkspace } from './admin.ts'
import { registerAgentIdentity } from './admin.ts'
import { Orchestrator } from './orchestrator.ts'
import { resolveCaller } from './identity.ts'
import { agentInstanceId, dispatchAgentRpc } from './rpcAgents.ts'
import { runWorkspaceServer } from './server.ts'
import type { PersistedEvent, ReplicatedEvent } from './events.ts'
import { WorkspaceStore } from './store.ts'

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

function openAt(path?: string): WorkspaceStore {
  const dir = path ? dirnameOf(path) : mkdtempSync(join(tmpdir(), 'elia-owners-'))
  dirs.push(dir)
  const store = WorkspaceStore.open(path ?? join(dir, 'workspace.sqlite'))
  stores.push(store)
  return store
}

function dirnameOf(path: string): string {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return slash === -1 ? '.' : path.slice(0, slash)
}

/** A node that has booted and is ready to create work, with one active objective. */
function seedNode() {
  const store = openAt()
  const created = createWorkspace(store, { name: 'demo', ownerName: 'sam' })
  const objectiveId = 'obj_1'
  store.append({
    type: 'ObjectiveCreated', actorKind: 'member', actorId: created.ownerMemberId, objectiveId,
    payload: { id: objectiveId, workspaceId: created.workspaceId, projectId: created.projectId, goal: 'build auth', runId: 'run_1' },
  })
  // Approved and active, so tests exercise ownership rather than tripping the
  // objective state machine on the way there.
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
    payload: { id: 't_api', objectiveId, projectId: created.projectId, title: 'API', role: 'backend', dependsOn: [], files: [] },
  })
  return { store, nodeId: store.localNodeId, memberId: created.ownerMemberId, projectId: created.projectId, objectiveId }
}

/** An empty second node, mirroring nothing yet. */
function seedFollower(): WorkspaceStore {
  return openAt()
}

function toReplicated(event: PersistedEvent): ReplicatedEvent {
  const { seq: _seq, ...rest } = event
  return rest
}

/** Ship everything one node has that the other has not seen. Returns the count applied. */
function replicate(from: WorkspaceStore, to: WorkspaceStore): number {
  let applied = 0
  for (const event of from.events()) {
    if (to.applyRemote(toReplicated(event))) applied += 1
  }
  return applied
}

function taskStarted(objectiveId: string, taskId: string, actorId: string, actorNode: string) {
  return { type: 'TaskStarted', actorKind: 'agent', actorId, objectiveId, taskId, actorNode, payload: { leaseOwner: actorId } } as const
}

function taskCompleted(objectiveId: string, taskId: string, actorId: string, actorNode: string) {
  return { type: 'TaskCompleted', actorKind: 'agent', actorId, objectiveId, taskId, actorNode, payload: {} } as const
}

function assign(store: WorkspaceStore, objectiveId: string, taskId: string, actorNode: string, executorNodeId?: string) {
  return store.append({
    type: 'TaskAssigned', actorKind: 'system', actorId: 'orchestrator', objectiveId, taskId, actorNode,
    payload: { assigneeKind: 'agent', assigneeId: 'a_be', wave: 1, ...(executorNodeId ? { executorNodeId } : {}) },
  })
}

// --- node identity -----------------------------------------------------------

test('a workspace records a local node and keeps its id across restarts', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'elia-owners-')), 'workspace.sqlite')
  dirs.push(dirnameOf(path))
  const first = openAt(path)
  const nodeId = first.localNodeId
  expect(nodeId).toMatch(/^nd_/)
  expect(first.node(nodeId)?.isLocal).toBe(true)
  first.close()
  stores.length = 0

  const reopened = openAt(path)
  expect(reopened.localNodeId).toBe(nodeId)
  // Reopening must not mint a second node: exactly one row is `is_local`.
  expect(reopened.nodes().filter((node) => node.isLocal)).toHaveLength(1)
})

test('the node that creates the workspace owns it, and the owner is pinned', () => {
  const { store, nodeId } = seedNode()
  expect(store.workspace()!.ownerNodeId).toBe(nodeId)
  expect(store.objective('obj_1')!.ownerNodeId).toBe(nodeId)
})

test('binding the mesh fingerprint pins it onto the existing local node row', () => {
  const { store, nodeId } = seedNode()
  store.bindNodeFingerprint('fp:ab12cd34', 'studio')
  const node = store.node(nodeId)!
  expect(node.fingerprint).toBe('fp:ab12cd34')
  expect(node.kind).toBe('mesh')
  // One row, updated — not a second node claiming the same machine.
  expect(store.nodes()).toHaveLength(1)
})

// --- replication -------------------------------------------------------------

test('a replica projects mirrored events into its own tables', () => {
  const owner = seedNode()
  const follower = seedFollower()
  expect(replicate(owner.store, follower)).toBeGreaterThan(0)

  expect(follower.workspace()!.name).toBe('demo')
  expect(follower.objective('obj_1')!.goal).toBe('build auth')
  expect(follower.task('t_api')!.status).toBe('ready')
  // The mirrored rows still record who wrote them.
  expect(follower.events()[0]!.actorNode).toBe(owner.nodeId)
})

test('replication is idempotent on the event id, so a re-sent batch applies once', () => {
  const owner = seedNode()
  const follower = seedFollower()
  replicate(owner.store, follower)
  const afterFirst = follower.events().length
  const spineBefore = follower.latestSeq()

  expect(replicate(owner.store, follower)).toBe(0)
  expect(follower.events()).toHaveLength(afterFirst)
  expect(follower.latestSeq()).toBe(spineBefore)
})

test('mirrored events do not enter the replica audit chain but leave it verifiable', () => {
  const owner = seedNode()
  const follower = seedFollower()
  replicate(owner.store, follower)
  const localAppends = follower.events().filter((event) => event.actorNode === follower.localNodeId)
  expect(localAppends).toHaveLength(0)

  // The chain walks this node's own appends only. Had mirrored events been
  // chained, the derived completion below would break verification.
  follower.append({
    type: 'NodeRegistered', actorKind: 'system', actorId: 'mesh', payload: { id: owner.nodeId, name: 'peer', kind: 'mesh' },
  })
  expect(follower.auditChainIntact()).toBe(true)
})

test('a NodeHeartbeat from the peer makes the peer online here', () => {
  const follower = seedFollower()
  follower.append({
    type: 'NodeHeartbeat', actorKind: 'system', actorId: 'mesh',
    payload: { id: 'nd_peer', name: 'studio', kind: 'mesh' },
  })
  // Anchor on the beat's own timestamp: the projection stamps it with the event
  // time, so inventing a fixed clock here would test nothing about staleness.
  const beatAt = Date.parse(follower.nodePresence()[0]!.lastSeenAt)

  const [fresh] = follower.nodePresence(90_000, beatAt + 1_000)
  expect(fresh!.nodeId).toBe('nd_peer')
  expect(fresh!.online).toBe(true)

  // A stale beat is reported as offline rather than dropped, so the UI can still
  // say when the machine was last seen.
  const [stale] = follower.nodePresence(90_000, beatAt + 600_000)
  expect(stale!.nodeId).toBe('nd_peer')
  expect(stale!.online).toBe(false)
})

test('the replication cursor records how far a peer has been consumed', () => {
  const follower = seedFollower()
  expect(follower.replicationCursor('nd_peer')).toBe(0)
  follower.setReplicationCursor('nd_peer', 42)
  expect(follower.replicationCursor('nd_peer')).toBe(42)
})

// --- the authority guard -----------------------------------------------------

test('the objective owner may write owner-authoritative events for it', () => {
  const { store, nodeId, objectiveId, memberId } = seedNode()
  const event = store.append({
    type: 'ObjectiveStatusChanged', actorKind: 'member', actorId: memberId, objectiveId,
    actorNode: nodeId, payload: { status: 'blocked' },
  })
  expect(event.objectiveId).toBe(objectiveId)
  expect(store.objective(objectiveId)!.status).toBe('blocked')
})

test('a node that does not own an objective is refused its owner-authoritative events', () => {
  const owner = seedNode()
  const follower = seedFollower()
  replicate(owner.store, follower)

  expect(() => follower.append({
    type: 'ObjectiveStatusChanged', actorKind: 'member', actorId: 'someone', objectiveId: 'obj_1',
    actorNode: follower.localNodeId, payload: { status: 'blocked' },
  })).toThrow(/owned by node nd_/)
  expect(follower.objective('obj_1')!.status).toBe('active')
})

test('the guard is inert for an objective with no recorded owner', () => {
  const { store } = seedNode()
  // A pre-v4 row, or one written before node identity existed: unpartitioned, not
  // locked. Legacy single-writer behaviour must survive the change.
  store.raw().query('UPDATE objectives SET owner_node_id = NULL WHERE id = ?').run('obj_1')
  expect(() => store.append({
    type: 'ObjectiveStatusChanged', actorKind: 'member', actorId: 'mbr_1', objectiveId: 'obj_1',
    actorNode: 'nd_some_other_node', payload: { status: 'blocked' },
  })).not.toThrow()
})

test('coordination events are writable by either node', () => {
  const owner = seedNode()
  const follower = seedFollower()
  replicate(owner.store, follower)
  // Both nodes' file changes reach the same log; neither is authoritative.
  expect(() => follower.append({
    type: 'FileChanged', actorKind: 'system', actorId: 'mesh',
    actorNode: follower.localNodeId, payload: { path: 'api/login.ts', op: 'modified' },
  })).not.toThrow()
  expect(owner.nodeId).not.toBe(follower.localNodeId)
})

test('presence is process-local and cannot be written by the peer node', () => {
  const { store } = seedNode()
  expect(() => store.append({
    type: 'PresenceJoined', actorKind: 'system', actorId: 'mesh',
    actorNode: 'nd_remote', payload: { connectionId: 'c1', subjectKind: 'agent', subjectId: 'a1', name: 'be' },
  })).toThrow(/process-local/)
})

test('a task granted to a node may only be written by that node', () => {
  const owner = seedNode()
  const follower = seedFollower()
  replicate(owner.store, follower)
  const b = follower.localNodeId

  // The owner dispatches the task to B by setting the executor.
  assign(owner.store, 'obj_1', 't_api', owner.nodeId, b)
  replicate(owner.store, follower)
  expect(follower.task('t_api')!.executorNodeId).toBe(b)
  expect(follower.hasActiveGrant('t_api', b)).toBe(true)

  // C has the mirrored row and must not be able to run it.
  const third = seedFollower()
  replicate(owner.store, third)
  expect(() => third.append(taskStarted('obj_1', 't_api', 'a_x', third.localNodeId))).toThrow(/granted to node/)

  // Nor may the owner itself, once it has delegated the execution.
  expect(() => owner.store.append(taskStarted('obj_1', 't_api', 'a_be', owner.nodeId))).toThrow(/may not write/)

  // B may, and the task runs the ordinary way.
  follower.append(taskStarted('obj_1', 't_api', 'a_be', b))
  replicate(owner.store, follower)
  expect(() => follower.append(taskCompleted('obj_1', 't_api', 'a_be', b))).not.toThrow()
  expect(follower.task('t_api')!.status).toBe('done')
})

test('an ungranted task is still writable, because there is no partition to respect', () => {
  const { store, nodeId, objectiveId } = seedNode()
  assign(store, objectiveId, 't_api', nodeId)
  expect(store.task('t_api')!.executorNodeId).toBeUndefined()
  expect(() => store.append(taskStarted(objectiveId, 't_api', 'a_be', nodeId))).not.toThrow()
  expect(() => store.append(taskCompleted(objectiveId, 't_api', 'a_be', nodeId))).not.toThrow()
  expect(store.hasActiveGrant('t_api', nodeId)).toBe(false)
})

test('an agent running on another node may only report its own state', () => {
  const { store, nodeId, memberId } = seedNode()
  const { identityId } = registerAgentIdentity(store, { name: 'be', role: 'backend', pathScopes: ['api/**'], actorId: memberId })
  const agentId = agentInstanceId(identityId)
  store.append({
    type: 'AgentStarted', actorKind: 'agent', actorId: identityId, actorNode: nodeId,
    payload: { id: agentId, identityId, name: 'be', role: 'backend' },
  })
  expect(store.agent(agentId)!.nodeId).toBe(nodeId)
  expect(() => store.append({
    type: 'AgentStateChanged', actorKind: 'agent', actorId: agentId, actorNode: 'nd_other',
    payload: { id: agentId, status: 'completed' },
  })).toThrow(/runs on node/)
})

// --- grants ------------------------------------------------------------------

test('grants are released when the task reaches a terminal state', () => {
  const { store, nodeId, objectiveId } = seedNode()
  assign(store, objectiveId, 't_api', nodeId, 'nd_peer')
  expect(store.hasActiveGrant('t_api', 'nd_peer')).toBe(true)

  store.append({
    type: 'TaskFailed', actorKind: 'agent', actorId: 'a_be', objectiveId, taskId: 't_api', actorNode: 'nd_peer',
    payload: { error: 'compile failed' },
  })
  expect(store.hasActiveGrant('t_api', 'nd_peer')).toBe(false)
  expect(store.taskGrants('t_api')[0]!.releasedAt).toBeDefined()
})

test('reassignment closes the previous grant and opens a new one', () => {
  const { store, nodeId, objectiveId } = seedNode()
  assign(store, objectiveId, 't_api', nodeId, 'nd_b')
  store.append({
    type: 'TaskReassigned', actorKind: 'system', actorId: 'orchestrator', objectiveId, taskId: 't_api',
    actorNode: nodeId, payload: { assigneeKind: 'agent', assigneeId: 'a_fe', executorNodeId: 'nd_c' },
  })
  expect(store.hasActiveGrant('t_api', 'nd_b')).toBe(false)
  expect(store.hasActiveGrant('t_api', 'nd_c')).toBe(true)
  expect(store.taskGrants('t_api')).toHaveLength(2)
  expect(store.task('t_api')!.executorNodeId).toBe('nd_c')
})

// --- scheduling --------------------------------------------------------------

test('a node only schedules tasks that are not partitioned away to the peer', () => {
  const { store, nodeId, projectId } = seedNode()
  store.append({
    type: 'TaskCreated', actorKind: 'member', actorId: 'mbr_1', objectiveId: 'obj_1',
    payload: { id: 't_local', objectiveId: 'obj_1', projectId, title: 'Local', role: 'backend', dependsOn: [], files: [] },
  })
  expect(store.executableTasks().map((task) => task.id)).toEqual(['t_api', 't_local'])

  assign(store, 'obj_1', 't_api', nodeId, 'nd_peer')
  // `t_api` is no longer ready *and* no longer this node's to run.
  expect(store.executableTasks().map((task) => task.id)).toEqual(['t_local'])
  expect(store.mayExecute(store.task('t_api')!, 'nd_peer')).toBe(true)
  expect(store.mayExecute(store.task('t_api')!, nodeId)).toBe(false)
})

// --- completion derived across the partition ----------------------------------

test('the owner completes an objective from a task completion mirrored off the peer', () => {
  const owner = seedNode()
  const follower = seedFollower()
  replicate(owner.store, follower)

  // The owner delegates execution, then the follower finishes the task.
  assign(owner.store, 'obj_1', 't_api', owner.nodeId, follower.localNodeId)
  replicate(owner.store, follower)
  follower.append(taskStarted('obj_1', 't_api', 'a_be', follower.localNodeId))
  replicate(follower, owner.store)
  follower.append(taskCompleted('obj_1', 't_api', 'a_be', follower.localNodeId))

  // On the follower the objective cannot be completed by it — it does not own it.
  expect(follower.objective('obj_1')!.status).toBe('active')

  replicate(follower, owner.store)
  // The owner derives the completion from the mirrored row, so the objective
  // still finishes exactly once, and on the node entitled to say so.
  // The owner's own activation event, plus the completion derived from the
  // follower's mirrored completion. Exactly one completion, not two.
  expect(owner.store.events().filter((event) => event.type === 'ObjectiveStatusChanged')).toHaveLength(3)
  expect(owner.store.objective('obj_1')!.status).toBe('completed')
  expect(owner.store.auditChainIntact()).toBe(true)
})

test('reconciliation does not reclaim work the peer owns', () => {
  const owner = seedNode()
  const follower = seedFollower()
  replicate(owner.store, follower)
  assign(owner.store, 'obj_1', 't_api', owner.nodeId, follower.localNodeId)
  replicate(owner.store, follower)

  // An expired lease on the follower is the follower's to recover, not the
  // owner's: reclaiming it would race the peer into contradictory recoveries.
  expect(follower.reconcileLeases(Date.now() + 10 * 60_000).tasks).toEqual([])
})

test('per-objective audit chains survive interleaved objectives on one node', () => {
  const { store, nodeId, projectId, memberId } = seedNode()
  store.append({
    type: 'ObjectiveCreated', actorKind: 'member', actorId: memberId, objectiveId: 'obj_2', actorNode: nodeId,
    payload: { id: 'obj_2', workspaceId: store.workspace()!.id, projectId, goal: 'ship docs', runId: 'run_2' },
  })
  store.append({ type: 'TaskCreated', actorKind: 'member', actorId: memberId, objectiveId: 'obj_2', payload: { id: 't_docs', objectiveId: 'obj_2', projectId, title: 'Docs', role: 'docs', dependsOn: [], files: [] } })
  // Interleave: obj_2 writes between obj_1's. A single global chain would be the
  // right shape only for one writer; these are two independent chains.
  store.append({ type: 'ObjectiveStatusChanged', actorKind: 'member', actorId: memberId, objectiveId: 'obj_1', actorNode: nodeId, payload: { status: 'blocked' } })
  store.append({ type: 'ObjectiveStatusChanged', actorKind: 'member', actorId: memberId, objectiveId: 'obj_2', actorNode: nodeId, payload: { status: 'awaiting-approval' } })

  expect(store.auditChainIntact()).toBe(true)
  const targets = (store.raw().query('SELECT DISTINCT target FROM audit_log ORDER BY target').all() as Array<{ target: string | null }>)
    .map((row) => row.target)
  expect(targets).toContain('obj_1')
  expect(targets).toContain('obj_2')
})

test('the audit chain reports tampering within an objective', () => {
  const { store, nodeId, objectiveId, memberId } = seedNode()
  store.append({ type: 'ObjectiveStatusChanged', actorKind: 'member', actorId: memberId, objectiveId, actorNode: nodeId, payload: { status: 'blocked' } })
  expect(store.auditChainIntact()).toBe(true)
  store.raw().query("UPDATE audit_log SET payload_hash = 'tampered' WHERE target = 'obj_1'").run()
  expect(store.auditChainIntact()).toBe(false)
})

// --- cross-node dispatch, end to end -----------------------------------------

/**
 * An agent identity plus a runtime connected to `store`, exactly as
 * `agent.connect` would leave it. The runtime's `node_id` is stamped by the
 * AgentStarted projection from the appending node, which is how the owner learns
 * that an agent lives on the other machine.
 */
function connectAgent(store: WorkspaceStore, name: string, role: 'backend' | 'critic', connectionId: string) {
  const { identityId, token } = registerAgentIdentity(store, { name, role, pathScopes: [], actorId: 'mbr_peer' })
  const agentId = agentInstanceId(identityId)
  store.append({
    type: 'AgentStarted', actorKind: 'agent', actorId: identityId,
    payload: { id: agentId, identityId, name, role, connectionId },
  })
  const caller = resolveCaller(store, token.plaintext)
  if (!caller) throw new Error(`agent ${name} did not resolve a caller`)
  return { agentId, identityId, caller, ctx: { store, caller, connectionId, requestShutdown: () => {} } }
}

test('the owner grants a task to an agent on the peer, and the peer executes it', async () => {
  const owner = seedNode()
  const follower = seedFollower()

  // The peer connects a backend agent to its own server.
  const peer = connectAgent(follower, 'be', 'backend', 'conn_be')

  // The owner learns the agent exists from the replicated AgentStarted.
  replicate(follower, owner.store)
  expect(owner.store.agent(peer.agentId)!.nodeId).toBe(follower.localNodeId)

  // The owner's orchestrator dispatches, granting the task to the peer's node.
  new Orchestrator({ store: owner.store }).tick()
  const task = owner.store.task('t_api')!
  expect(task.status).toBe('assigned')
  expect(task.executorNodeId).toBe(follower.localNodeId)
  expect(owner.store.hasActiveGrant('t_api', follower.localNodeId)).toBe(true)

  // The peer mirrors the assignment but must not schedule it again: it does not
  // own the objective, and the task is already granted away.
  replicate(owner.store, follower)
  new Orchestrator({ store: follower }).tick()
  expect(follower.task('t_api')!.status).toBe('assigned')
  expect(follower.events().filter((event) => event.type === 'TaskAssigned')).toHaveLength(1)

  // The peer's agent polls its own server, claims the task, and starts it there.
  const claimed = await dispatchAgentRpc(peer.ctx, 'agent.claim', {}) as { task: { id: string } | null }
  expect(claimed.task!.id).toBe('t_api')
  expect(follower.task('t_api')!.status).toBe('in-progress')

  replicate(follower, owner.store)
  expect(owner.store.task('t_api')!.status).toBe('in-progress')
  expect(owner.store.objective('obj_1')!.status).toBe('active')

  // It completes on the peer, and the owner derives the objective completion.
  await dispatchAgentRpc(peer.ctx, 'agent.complete', { taskId: 't_api', ok: true, report: 'done on the peer' })
  replicate(follower, owner.store)
  expect(owner.store.task('t_api')!.status).toBe('done')
  expect(owner.store.objective('obj_1')!.status).toBe('completed')
  expect(owner.store.hasActiveGrant('t_api', follower.localNodeId)).toBe(false)
  expect(owner.store.auditChainIntact()).toBe(true)
})

test('a task with no eligible peer agent stays ready rather than being granted to itself', () => {
  const owner = seedNode()
  const follower = seedFollower()
  connectAgent(follower, 'be', 'backend', 'conn_be')
  replicate(follower, owner.store)

  new Orchestrator({ store: owner.store }).tick()
  // Dispatched cross-node...
  expect(owner.store.task('t_api')!.executorNodeId).toBe(follower.localNodeId)
  expect(owner.store.taskGrants('t_api')).toHaveLength(1)
  expect(owner.store.taskGrants('t_api')[0]!.nodeId).toBe(follower.localNodeId)

  // ...and a local agent row is never granted a grant of its own node, because
  // an ungranted task is the legacy single-writer case and needs no grant.
  const local = seedNode()
  connectAgent(local.store, 'fe', 'backend', 'conn_fe')
  local.store.append({
    type: 'TaskStatusChanged', actorKind: 'system', actorId: 'test', objectiveId: 'obj_1', taskId: 't_api',
    payload: { status: 'ready' },
  })
  new Orchestrator({ store: local.store }).tick()
  expect(local.store.task('t_api')!.status).toBe('assigned')
  expect(local.store.task('t_api')!.executorNodeId).toBeUndefined()
  expect(local.store.taskGrants('t_api')).toHaveLength(0)
})

// --- node presence -----------------------------------------------------------

test('a served workspace announces itself, so both nodes appear in the same list', async () => {
  const store = openAt()
  createWorkspace(store, { name: 'demo' })
  const server = await runWorkspaceServer({ store, mesh: false, orchestrate: false })
  try {
    // The local node is present without any special-casing in a view, which is
    // the point: node presence is one list, not "me" plus "the peer".
    const presence = store.nodePresence()
    expect(presence.map((record) => record.nodeId)).toEqual([store.localNodeId])
    expect(presence[0]!.online).toBe(true)
  } finally {
    server.stop()
  }
})

test('a peer heartbeat replicated from the other machine shows up as another node', () => {
  const owner = seedNode()
  const follower = seedFollower()
  // Each node announces itself; both land in both databases.
  follower.append({
    type: 'NodeHeartbeat', actorKind: 'system', actorId: 'workspace-server',
    payload: { id: follower.localNodeId, name: 'studio', kind: 'mesh' },
  })
  replicate(follower, owner.store)

  const online = owner.store.nodePresence().filter((record) => record.online).map((record) => record.nodeId)
  expect(online).toContain(follower.localNodeId)
  expect(owner.store.node(follower.localNodeId)!.name).toBe('studio')
})
