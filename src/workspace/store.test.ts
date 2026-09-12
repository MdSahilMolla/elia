import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WorkspaceStore } from './store.ts'
import { createWorkspace } from './admin.ts'
import { applyProjection, type PersistedEvent } from './events.ts'

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
      // Windows can hold a brief lock on a just-closed SQLite file; the OS temp dir is reaped anyway.
    }
  }
})

function open(): WorkspaceStore {
  const dir = mkdtempSync(join(tmpdir(), 'elia-ws-'))
  dirs.push(dir)
  const store = WorkspaceStore.open(join(dir, 'workspace.sqlite'))
  stores.push(store)
  return store
}

function bootstrap(): { store: WorkspaceStore; ownerId: string; projectId: string } {
  const store = open()
  const created = createWorkspace(store, { name: 'demo', ownerName: 'sam' })
  return { store, ownerId: created.ownerMemberId, projectId: created.projectId }
}

function seedObjective(store: WorkspaceStore, ownerId: string, projectId: string): string {
  const objectiveId = 'obj_1'
  store.append({
    type: 'ObjectiveCreated', actorKind: 'member', actorId: ownerId, objectiveId,
    payload: { id: objectiveId, workspaceId: store.workspace()!.id, projectId, goal: 'build auth', runId: 'run_1' },
  })
  return objectiveId
}

test('creating a workspace projects a workspace, default project, owner, and token', () => {
  const { store } = bootstrap()
  expect(store.workspace()?.name).toBe('demo')
  expect(store.projects()).toHaveLength(1)
  const members = store.members()
  expect(members).toHaveLength(1)
  expect(members[0]!.role).toBe('owner')
  expect(store.tokens()).toHaveLength(1)
})

test('the event spine records every mutation in order', () => {
  const { store } = bootstrap()
  const events = store.events()
  expect(events.map((event) => event.type)).toEqual(['WorkspaceCreated', 'MemberAdded', 'TokenMinted'])
  expect(events.map((event) => event.seq)).toEqual([1, 2, 3])
})

test('task readiness follows dependencies: dependent tasks stay pending until deps are done', () => {
  const { store, ownerId, projectId } = bootstrap()
  const objectiveId = seedObjective(store, ownerId, projectId)
  store.append({ type: 'TaskCreated', actorKind: 'member', actorId: ownerId, objectiveId, payload: { id: 't_api', objectiveId, projectId, title: 'API', role: 'backend', dependsOn: [], files: ['api/login.ts'] } })
  store.append({ type: 'TaskCreated', actorKind: 'member', actorId: ownerId, objectiveId, payload: { id: 't_tests', objectiveId, projectId, title: 'Tests', role: 'tester', dependsOn: ['t_api'], files: ['api/login.test.ts'] } })

  expect(store.task('t_api')!.status).toBe('ready')
  expect(store.task('t_tests')!.status).toBe('pending')

  store.append({ type: 'ObjectiveStatusChanged', actorKind: 'member', actorId: ownerId, objectiveId, payload: { status: 'awaiting-approval' } })
  store.append({ type: 'ObjectiveStatusChanged', actorKind: 'member', actorId: ownerId, objectiveId, payload: { status: 'active', approvedBy: ownerId } })
  store.append({ type: 'TaskAssigned', actorKind: 'system', actorId: 'orchestrator', objectiveId, taskId: 't_api', payload: { assigneeKind: 'agent', assigneeId: 'a1', wave: 1 } })
  store.append({ type: 'TaskStarted', actorKind: 'agent', actorId: 'a1', objectiveId, taskId: 't_api', payload: { leaseOwner: 'a1' } })
  store.append({ type: 'TaskCompleted', actorKind: 'agent', actorId: 'a1', objectiveId, taskId: 't_api', payload: {} })

  expect(store.task('t_api')!.status).toBe('done')
  expect(store.task('t_tests')!.status).toBe('ready')
})

test('unblocking a task with satisfied dependencies makes it ready, not stranded pending', () => {
  const { store, ownerId, projectId } = bootstrap()
  const objectiveId = seedObjective(store, ownerId, projectId)
  store.append({ type: 'TaskCreated', actorKind: 'member', actorId: ownerId, objectiveId, payload: { id: 't_api', objectiveId, projectId, title: 'API', role: 'backend', dependsOn: [], files: [] } })
  store.append({ type: 'TaskCreated', actorKind: 'member', actorId: ownerId, objectiveId, payload: { id: 't_tests', objectiveId, projectId, title: 'Tests', role: 'tester', dependsOn: ['t_api'], files: [] } })
  store.append({ type: 'ObjectiveStatusChanged', actorKind: 'member', actorId: ownerId, objectiveId, payload: { status: 'awaiting-approval' } })
  store.append({ type: 'ObjectiveStatusChanged', actorKind: 'member', actorId: ownerId, objectiveId, payload: { status: 'active', approvedBy: ownerId } })
  store.append({ type: 'TaskAssigned', actorKind: 'system', actorId: 'orch', objectiveId, taskId: 't_api', payload: { assigneeKind: 'agent', assigneeId: 'a1' } })
  store.append({ type: 'TaskStarted', actorKind: 'agent', actorId: 'a1', objectiveId, taskId: 't_api', payload: {} })
  store.append({ type: 'TaskCompleted', actorKind: 'agent', actorId: 'a1', objectiveId, taskId: 't_api', payload: {} })
  expect(store.task('t_tests')!.status).toBe('ready')

  // A member blocks then unblocks the dependent task. Its one dependency is done,
  // so it must return to `ready` — not sit in `pending` with nothing to re-derive it.
  store.append({ type: 'TaskBlocked', actorKind: 'member', actorId: ownerId, objectiveId, taskId: 't_tests', payload: { reason: 'hold' } })
  expect(store.task('t_tests')!.status).toBe('blocked')
  store.append({ type: 'TaskUnblocked', actorKind: 'member', actorId: ownerId, objectiveId, taskId: 't_tests', payload: {} })
  expect(store.task('t_tests')!.status).toBe('ready')
})

test('blocking then unblocking the last open task still lets the objective complete', () => {
  const { store, ownerId, projectId } = bootstrap()
  const objectiveId = seedObjective(store, ownerId, projectId)
  store.append({ type: 'TaskCreated', actorKind: 'member', actorId: ownerId, objectiveId, payload: { id: 't1', objectiveId, projectId, title: 'One', role: 'builder', dependsOn: [], files: [] } })
  store.append({ type: 'ObjectiveStatusChanged', actorKind: 'member', actorId: ownerId, objectiveId, payload: { status: 'awaiting-approval' } })
  store.append({ type: 'ObjectiveStatusChanged', actorKind: 'member', actorId: ownerId, objectiveId, payload: { status: 'active', approvedBy: ownerId } })
  store.append({ type: 'TaskBlocked', actorKind: 'member', actorId: ownerId, objectiveId, taskId: 't1', payload: { reason: 'hold' } })
  store.append({ type: 'TaskUnblocked', actorKind: 'member', actorId: ownerId, objectiveId, taskId: 't1', payload: {} })
  expect(store.task('t1')!.status).toBe('ready')
  store.append({ type: 'TaskAssigned', actorKind: 'system', actorId: 'orch', objectiveId, taskId: 't1', payload: { assigneeKind: 'agent', assigneeId: 'a1' } })
  store.append({ type: 'TaskStarted', actorKind: 'agent', actorId: 'a1', objectiveId, taskId: 't1', payload: {} })
  store.append({ type: 'TaskCompleted', actorKind: 'agent', actorId: 'a1', objectiveId, taskId: 't1', payload: {} })
  expect(store.objective(objectiveId)!.status).toBe('completed')
})

test('a task that names an unknown dependency is never dispatched (not treated as satisfied)', () => {
  const { store, ownerId, projectId } = bootstrap()
  const objectiveId = seedObjective(store, ownerId, projectId)
  store.append({ type: 'TaskCreated', actorKind: 'member', actorId: ownerId, objectiveId, payload: { id: 't_real', objectiveId, projectId, title: 'Real', role: 'backend', dependsOn: [], files: [] } })
  store.append({ type: 'TaskCreated', actorKind: 'member', actorId: ownerId, objectiveId, payload: { id: 't_bad', objectiveId, projectId, title: 'Bad dep', role: 'tester', dependsOn: ['t_typo'], files: [] } })
  store.append({ type: 'ObjectiveStatusChanged', actorKind: 'member', actorId: ownerId, objectiveId, payload: { status: 'awaiting-approval' } })
  store.append({ type: 'ObjectiveStatusChanged', actorKind: 'member', actorId: ownerId, objectiveId, payload: { status: 'active', approvedBy: ownerId } })
  // Complete the real task — this triggers a readiness refresh that, under the old
  // `?? 'done'` default, would have flipped t_bad to `ready`.
  store.append({ type: 'TaskAssigned', actorKind: 'system', actorId: 'orch', objectiveId, taskId: 't_real', payload: { assigneeKind: 'agent', assigneeId: 'a1' } })
  store.append({ type: 'TaskStarted', actorKind: 'agent', actorId: 'a1', objectiveId, taskId: 't_real', payload: {} })
  store.append({ type: 'TaskCompleted', actorKind: 'agent', actorId: 'a1', objectiveId, taskId: 't_real', payload: {} })
  expect(store.task('t_bad')!.status).toBe('pending')
})

test('an objective completes once all its tasks are done', () => {
  const { store, ownerId, projectId } = bootstrap()
  const objectiveId = seedObjective(store, ownerId, projectId)
  store.append({ type: 'TaskCreated', actorKind: 'member', actorId: ownerId, objectiveId, payload: { id: 't1', objectiveId, projectId, title: 'One', role: 'builder', dependsOn: [], files: [] } })
  store.append({ type: 'ObjectiveStatusChanged', actorKind: 'member', actorId: ownerId, objectiveId, payload: { status: 'awaiting-approval' } })
  store.append({ type: 'ObjectiveStatusChanged', actorKind: 'member', actorId: ownerId, objectiveId, payload: { status: 'active', approvedBy: ownerId } })
  store.append({ type: 'TaskAssigned', actorKind: 'system', actorId: 'orch', objectiveId, taskId: 't1', payload: { assigneeKind: 'agent', assigneeId: 'a1' } })
  store.append({ type: 'TaskStarted', actorKind: 'agent', actorId: 'a1', objectiveId, taskId: 't1', payload: {} })
  store.append({ type: 'TaskCompleted', actorKind: 'agent', actorId: 'a1', objectiveId, taskId: 't1', payload: {} })
  expect(store.objective(objectiveId)!.status).toBe('completed')
})

test('illegal state transitions are rejected and roll back the whole append', () => {
  const { store, ownerId, projectId } = bootstrap()
  const objectiveId = seedObjective(store, ownerId, projectId)
  store.append({ type: 'TaskCreated', actorKind: 'member', actorId: ownerId, objectiveId, payload: { id: 't1', objectiveId, projectId, title: 'One', role: 'builder', dependsOn: [], files: [] } })
  const before = store.latestSeq()
  // ready -> done is not a legal task transition.
  expect(() => store.append({ type: 'TaskCompleted', actorKind: 'agent', actorId: 'a1', objectiveId, taskId: 't1', payload: {} })).toThrow()
  expect(store.latestSeq()).toBe(before)
  expect(store.task('t1')!.status).toBe('ready')
})

test('the audit hash chain stays intact across many appends', () => {
  const { store, ownerId, projectId } = bootstrap()
  const objectiveId = seedObjective(store, ownerId, projectId)
  for (let i = 0; i < 5; i += 1) {
    store.append({ type: 'DecisionRecorded', actorKind: 'member', actorId: ownerId, objectiveId, payload: { title: `d${i}`, detail: 'x' } })
  }
  expect(store.auditChainIntact()).toBe(true)
  expect(store.decisions(objectiveId)).toHaveLength(5)
})

test('pruneOldEvents deletes only events outside both the age and count windows, never audit_log', () => {
  const { store, ownerId, projectId } = bootstrap()
  const objectiveId = seedObjective(store, ownerId, projectId)
  for (let i = 0; i < 5; i += 1) {
    store.append({ type: 'DecisionRecorded', actorKind: 'member', actorId: ownerId, objectiveId, payload: { title: `d${i}`, detail: 'x' } })
  }
  const totalBefore = store.events({ limit: 5000 }).length
  const auditBefore = (store.raw().query('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n

  // Nothing is old enough or beyond the count ceiling yet — a no-op.
  expect(store.pruneOldEvents()).toBe(0)
  expect(store.events({ limit: 5000 })).toHaveLength(totalBefore)

  // Keep only the most recent 2 events; everything older is "too old" too, so both gates pass.
  const deleted = store.pruneOldEvents({ keepEvents: 2, maxAgeMs: 0, now: Date.now() + 1 })
  expect(deleted).toBe(totalBefore - 2)
  expect(store.events({ limit: 5000 })).toHaveLength(2)
  // The tamper-evident chain is never touched by pruning workspace_events.
  expect((store.raw().query('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n).toBe(auditBefore)
  expect(store.auditChainIntact()).toBe(true)
})

test('auditChainIntact verifies the chain across more than one internal page', () => {
  const { store, ownerId, projectId } = bootstrap()
  const objectiveId = seedObjective(store, ownerId, projectId)
  // Small enough to run fast, large enough to exercise pagination logic if the
  // batch size is ever tuned down in a test-only build.
  for (let i = 0; i < 40; i += 1) {
    store.append({ type: 'DecisionRecorded', actorKind: 'member', actorId: ownerId, objectiveId, payload: { title: `d${i}`, detail: 'x' } })
  }
  expect(store.auditChainIntact()).toBe(true)
})

test('reconcileLeases requeues a task whose lease expired', () => {
  const { store, ownerId, projectId } = bootstrap()
  const objectiveId = seedObjective(store, ownerId, projectId)
  store.append({ type: 'TaskCreated', actorKind: 'member', actorId: ownerId, objectiveId, payload: { id: 't1', objectiveId, projectId, title: 'One', role: 'builder', dependsOn: [], files: [] } })
  store.append({ type: 'ObjectiveStatusChanged', actorKind: 'member', actorId: ownerId, objectiveId, payload: { status: 'awaiting-approval' } })
  store.append({ type: 'ObjectiveStatusChanged', actorKind: 'member', actorId: ownerId, objectiveId, payload: { status: 'active', approvedBy: ownerId } })
  store.append({ type: 'TaskAssigned', actorKind: 'system', actorId: 'orch', objectiveId, taskId: 't1', payload: { assigneeKind: 'agent', assigneeId: 'a1' } })
  store.append({ type: 'TaskStarted', actorKind: 'agent', actorId: 'a1', objectiveId, taskId: 't1', payload: { leaseOwner: 'a1', leaseExpiresAt: Date.now() - 1000 } })

  const recovered = store.reconcileLeases(Date.now())
  expect(recovered.tasks).toEqual(['t1'])
  expect(store.task('t1')!.status).toBe('ready')
})

test('agent messages are scoped: a directed message is visible to its recipient and broadcasts to all', () => {
  const { store, ownerId, projectId } = bootstrap()
  const objectiveId = seedObjective(store, ownerId, projectId)
  store.append({ type: 'AgentMessageCreated', actorKind: 'agent', actorId: 'a1', objectiveId, payload: { topic: 'auth', kind: 'claim', body: 'API done', refs: {} } })
  store.append({ type: 'AgentMessageCreated', actorKind: 'agent', actorId: 'a1', objectiveId, payload: { toId: 'a2', topic: 'auth', kind: 'handoff', body: 'over to you', refs: {} } })

  expect(store.messages({ objectiveId })).toHaveLength(2)
  expect(store.messages({ objectiveId, toId: 'a2' })).toHaveLength(2)
  expect(store.messages({ objectiveId, toId: 'a3' })).toHaveLength(1)
})

test('the hot read paths are index-backed, not full scans', () => {
  const { store, ownerId, projectId } = bootstrap()
  const objectiveId = seedObjective(store, ownerId, projectId)
  const plan = (sql: string, ...params: unknown[]): string =>
    (store.raw().query(`EXPLAIN QUERY PLAN ${sql}`).all(...params as never[]) as Array<{ detail: string }>)
      .map((row) => row.detail)
      .join(' | ')

  // messages() — always ORDER BY seq DESC LIMIT, usually per-objective.
  const messagesPlan = plan('SELECT * FROM agent_messages WHERE objective_id = ? ORDER BY seq DESC LIMIT 200', objectiveId)
  expect(messagesPlan).toContain('idx_messages_objective_seq')
  expect(messagesPlan).not.toContain('SCAN agent_messages')

  // events() — the server's per-objective catch-up since a sequence number.
  // seq IS the rowid here, so idx_events_objective already carries the seq range
  // and returns rows in seq order: an index range scan with no sort.
  const eventsPlan = plan('SELECT * FROM workspace_events WHERE seq > ? AND objective_id = ? ORDER BY seq ASC LIMIT 500', 0, objectiveId)
  expect(eventsPlan).toContain('idx_events_objective')
  expect(eventsPlan).not.toContain('SCAN workspace_events')
  expect(eventsPlan).not.toContain('USE TEMP B-TREE')

  // tasks({ objectiveId, status }) — the board view / orchestrator readiness query.
  const tasksPlan = plan("SELECT * FROM tasks WHERE objective_id = ? AND status IN ('ready') ORDER BY created_at", objectiveId)
  expect(tasksPlan).toContain('idx_tasks_objective_status')
})

test('redactPayload scrubs secrets nested inside arrays, not just top-level free-text strings', () => {
  const { store, ownerId, projectId } = bootstrap()
  const objectiveId = seedObjective(store, ownerId, projectId)
  const secret = 'sk-abcdefghijklmnopqrstuvwxyz012345'
  store.append({
    type: 'TaskCreated', actorKind: 'member', actorId: ownerId, objectiveId,
    payload: {
      id: 't_sec', objectiveId, projectId, title: 'Secret task', role: 'backend', dependsOn: [], files: [],
      acceptanceCriteria: [`token is ${secret}`],
      verificationCommands: [`curl -H "Authorization: ${secret}" https://api`],
    },
  })
  const event = store.events({ types: ['TaskCreated'] })[0]!
  const serialized = JSON.stringify(event.payload)
  expect(serialized).not.toContain(secret)
  expect(serialized).toContain('[REDACTED]')
})

test('redactPayload recurses into a plain-object field (refs) but preserves an id-shaped key used for equality matching', () => {
  const { store, ownerId, projectId } = bootstrap()
  const objectiveId = seedObjective(store, ownerId, projectId)
  const secret = 'sk-abcdefghijklmnopqrstuvwxyz012345'
  store.append({ type: 'TaskCreated', actorKind: 'member', actorId: ownerId, objectiveId, payload: { id: 't_ref', objectiveId, projectId, title: 'Ref task', role: 'backend', dependsOn: [], files: [] } })
  store.append({
    type: 'AgentMessageCreated', actorKind: 'agent', actorId: 'a1', objectiveId, taskId: 't_ref',
    payload: { topic: 'auth', kind: 'info', body: 'note', refs: { taskId: 't_ref', note: `carries ${secret}` } },
  })
  const event = store.events({ types: ['AgentMessageCreated'] })[0]!
  const refs = event.payload.refs as Record<string, unknown>
  // rpcOrchestration.ts filters messages with `m.refs?.taskId === task.id` — an
  // id-shaped nested field must survive redaction untouched, or that lookup breaks.
  expect(refs.taskId).toBe('t_ref')
  // A free-text-keyed nested field is still scrubbed.
  expect(String(refs.note)).toContain('[REDACTED]')
  expect(String(refs.note)).not.toContain(secret)
})

test('redactPayload does not crash on a deeply nested / adversarial refs object', () => {
  const { store, ownerId, projectId } = bootstrap()
  const objectiveId = seedObjective(store, ownerId, projectId)
  let deep: Record<string, unknown> = { leaf: 'x' }
  for (let i = 0; i < 50; i += 1) deep = { nested: deep }
  expect(() => store.append({
    type: 'AgentMessageCreated', actorKind: 'agent', actorId: 'a1', objectiveId,
    payload: { topic: 'auth', kind: 'info', body: 'note', refs: deep },
  })).not.toThrow()
})

test('applyProjection derives updated_at from the event\'s own timestamp, not wall-clock time', async () => {
  const { store, ownerId, projectId } = bootstrap()
  const objectiveId = seedObjective(store, ownerId, projectId)
  store.append({ type: 'TaskCreated', actorKind: 'member', actorId: ownerId, objectiveId, payload: { id: 't1', objectiveId, projectId, title: 'One', role: 'builder', dependsOn: [], files: [] } })
  store.append({ type: 'TaskCreated', actorKind: 'member', actorId: ownerId, objectiveId, payload: { id: 't2', objectiveId, projectId, title: 'Two', role: 'builder', dependsOn: [], files: [] } })

  // A fixed, arbitrary `at` — replaying the log must reproduce this exactly,
  // no matter when (real wall-clock time) the replay happens.
  const fixedAt = new Date('2020-01-01T00:00:00.000Z').toISOString()
  const eventFor = (taskId: string, seq: number): PersistedEvent => ({
    seq, id: `evt_test_${seq}`, type: 'TaskStatusChanged', actorKind: 'member', actorId: ownerId,
    objectiveId, taskId, payload: { status: 'blocked' }, at: fixedAt,
  })

  applyProjection(store.raw(), eventFor('t1', 9001))
  await Bun.sleep(20) // let real wall-clock time move between the two applications
  applyProjection(store.raw(), eventFor('t2', 9002))

  // Both rows get the event's own `at`, not two different `Date.now()` stamps —
  // that byte-identical result is exactly what `eventMs`'s doc comment promises.
  expect(store.task('t1')!.updatedAt).toBe(fixedAt)
  expect(store.task('t2')!.updatedAt).toBe(fixedAt)
})

test('listeners are not notified for appends inside a transact() that later rolls back', () => {
  const { store, ownerId, projectId } = bootstrap()
  const objectiveId = seedObjective(store, ownerId, projectId)
  store.append({ type: 'TaskCreated', actorKind: 'member', actorId: ownerId, objectiveId, payload: { id: 't1', objectiveId, projectId, title: 'One', role: 'builder', dependsOn: [], files: [] } })

  const seen: string[] = []
  store.subscribe((event) => seen.push(event.type))

  expect(() => store.transact(() => {
    // Succeeds inside the outer transaction — as a savepoint, not yet committed.
    store.append({ type: 'DecisionRecorded', actorKind: 'member', actorId: ownerId, objectiveId, payload: { title: 'd1', detail: 'x' } })
    // Illegal transition (ready -> done skips in-progress) — throws, rolling
    // back the whole `transact()` call, including the DecisionRecorded above.
    store.append({ type: 'TaskCompleted', actorKind: 'agent', actorId: 'a1', objectiveId, taskId: 't1', payload: {} })
  })).toThrow()

  expect(store.decisions(objectiveId)).toHaveLength(0)
  // No listener was ever told about the DecisionRecorded that got rolled back.
  expect(seen).toEqual([])
})

test('transact() flushes every buffered notification, in order, once it actually commits', () => {
  const { store, ownerId, projectId } = bootstrap()
  const objectiveId = seedObjective(store, ownerId, projectId)
  const seen: string[] = []
  store.subscribe((event) => seen.push(event.type))

  store.transact(() => {
    store.append({ type: 'DecisionRecorded', actorKind: 'member', actorId: ownerId, objectiveId, payload: { title: 'd1', detail: 'x' } })
    store.append({ type: 'DecisionRecorded', actorKind: 'member', actorId: ownerId, objectiveId, payload: { title: 'd2', detail: 'y' } })
  })

  expect(seen).toEqual(['DecisionRecorded', 'DecisionRecorded'])
  expect(store.decisions(objectiveId)).toHaveLength(2)
})

test('projections survive a reopen — SQLite is the source of truth', () => {
  const dir = mkdtempSync(join(tmpdir(), 'elia-ws-'))
  dirs.push(dir)
  const path = join(dir, 'workspace.sqlite')
  const first = WorkspaceStore.open(path)
  const created = createWorkspace(first, { name: 'persist', ownerName: 'sam' })
  first.close()

  const second = WorkspaceStore.open(path)
  expect(second.workspace()?.name).toBe('persist')
  expect(second.member(created.ownerMemberId)?.role).toBe('owner')
  second.close()
})
