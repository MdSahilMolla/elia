import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WorkspaceStore } from './store.ts'
import { createWorkspace } from './admin.ts'

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
