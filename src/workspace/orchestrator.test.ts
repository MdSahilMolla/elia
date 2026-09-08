import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WorkspaceStore } from './store.ts'
import { createWorkspace, registerAgentIdentity } from './admin.ts'
import { decomposeObjective } from './decompose.ts'
import { Orchestrator, filesWithinScopes, roleMatches } from './orchestrator.ts'
import { agentInstanceId } from './rpcAgents.ts'
import type { Proposal } from '../autonomy/types.ts'

const dirs: string[] = []
const stores: WorkspaceStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close()
    } catch {
      /* closed */
    }
  }
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* windows lock */
    }
  }
})

test('roleMatches: exact, with builder as a wildcard for implementation roles', () => {
  expect(roleMatches('backend', 'backend')).toBe(true)
  expect(roleMatches('backend', 'frontend')).toBe(false)
  expect(roleMatches('builder', 'frontend')).toBe(true)
  expect(roleMatches('builder', 'security')).toBe(false)
  expect(roleMatches('scout', 'backend')).toBe(false)
})

test('filesWithinScopes: empty scope allows anything, globs are respected', () => {
  expect(filesWithinScopes(['api/x.ts'], [])).toBe(true)
  expect(filesWithinScopes(['api/x.ts'], ['api/**'])).toBe(true)
  expect(filesWithinScopes(['api/x.ts', 'api/deep/y.ts'], ['api/**'])).toBe(true)
  expect(filesWithinScopes(['ui/x.tsx'], ['api/**'])).toBe(false)
  expect(filesWithinScopes(['src/a.ts'], ['src/*.ts'])).toBe(true)
  expect(filesWithinScopes(['src/deep/a.ts'], ['src/*.ts'])).toBe(false)
})

const plan: Proposal = {
  goal: 'g', understanding: 'u', assumptions: [], risks: [], verification: [], outOfScope: [],
  steps: [
    { id: 'a', title: 'Backend A', role: 'backend', instructions: 'x', files: ['api/a.ts'], dependsOn: [] },
    { id: 'b', title: 'Frontend B', role: 'frontend', instructions: 'x', files: ['ui/b.tsx'], dependsOn: [] },
    { id: 'c', title: 'Tests C', role: 'tester', instructions: 'x', files: ['api/a.test.ts'], dependsOn: ['a'] },
  ],
}

async function scenario() {
  const dir = mkdtempSync(join(tmpdir(), 'elia-ws-orch-'))
  dirs.push(dir)
  const store = WorkspaceStore.open(join(dir, 'workspace.sqlite'))
  stores.push(store)
  const created = createWorkspace(store, { name: 'demo' })
  registerAgentIdentity(store, { name: 'be', role: 'backend', pathScopes: ['api/**'], actorId: created.ownerMemberId })
  registerAgentIdentity(store, { name: 'fe', role: 'frontend', pathScopes: ['ui/**'], actorId: created.ownerMemberId })
  const result = await decomposeObjective(store, { goal: 'g', actorId: created.ownerMemberId }, async () => structuredClone(plan))
  store.append({ type: 'ObjectiveStatusChanged', actorKind: 'member', actorId: created.ownerMemberId, objectiveId: result.objectiveId, payload: { status: 'active', approvedBy: created.ownerMemberId } })
  // Bring both agent runtimes "online".
  for (const name of ['be', 'fe']) {
    const identity = store.agentIdentity(name)!
    store.append({ type: 'AgentStarted', actorKind: 'agent', actorId: identity.id, payload: { id: agentInstanceId(identity.id), identityId: identity.id, name, role: identity.role, connectionId: `conn_${name}` } })
  }
  const orchestrator = new Orchestrator({ store })
  return { store, created, result, orchestrator }
}

test('a manual tick dispatches wave-1 tasks to matching agents and leaves the dependent one pending', async () => {
  const { store, result, orchestrator } = await scenario()
  orchestrator.tick()

  const tasks = store.tasks({ objectiveId: result.objectiveId })
  const a = tasks.find((t) => t.title === 'Backend A')!
  const b = tasks.find((t) => t.title === 'Frontend B')!
  const c = tasks.find((t) => t.title === 'Tests C')!
  expect(a.status).toBe('assigned')
  expect(b.status).toBe('assigned')
  expect(a.assigneeId).toBe(agentInstanceId(store.agentIdentity('be')!.id))
  expect(b.assigneeId).toBe(agentInstanceId(store.agentIdentity('fe')!.id))
  expect(c.status).toBe('pending')
  // Each assigned task holds an exclusive reservation on its file.
  expect(store.reservations(true).map((r) => r.resource).sort()).toEqual(['path:api/a.ts', 'path:ui/b.tsx'])
})

test('a rate-limited failure waits out its backoff before being re-queued', async () => {
  const { store, result, orchestrator } = await scenario()
  orchestrator.tick()
  const a = store.tasks({ objectiveId: result.objectiveId }).find((t) => t.title === 'Backend A')!
  expect(a.status).toBe('assigned')

  store.append({ type: 'TaskStarted', actorKind: 'agent', actorId: a.assigneeId!, objectiveId: result.objectiveId, taskId: a.id, payload: {} })
  store.append({ type: 'TaskFailed', actorKind: 'agent', actorId: a.assigneeId!, objectiveId: result.objectiveId, taskId: a.id, payload: { error: 'rate limit exceeded (429), retry later' } })
  const failedAt = Date.parse(store.task(a.id)!.updatedAt)

  const requeues = () => store.events({ objectiveId: result.objectiveId, types: ['TaskStatusChanged'] })
    .filter((event) => event.taskId === a.id && (event.payload as { status?: string }).status === 'ready').length

  orchestrator.tick(failedAt + 1_000)
  expect(store.task(a.id)!.status).toBe('failed') // still inside the 30s rate-limit backoff
  expect(requeues()).toBe(0)

  orchestrator.tick(failedAt + 31_000)
  expect(store.task(a.id)!.status).not.toBe('failed') // backoff elapsed — re-queued (and re-dispatched)
  expect(requeues()).toBe(1)
})

test('a saturated objective does not starve a later objective of reviewer routing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'elia-ws-orch-'))
  dirs.push(dir)
  const store = WorkspaceStore.open(join(dir, 'workspace.sqlite'))
  stores.push(store)
  const created = createWorkspace(store, { name: 'demo' })
  registerAgentIdentity(store, { name: 'be', role: 'backend', pathScopes: [], actorId: created.ownerMemberId })
  registerAgentIdentity(store, { name: 'rev', role: 'security', pathScopes: [], actorId: created.ownerMemberId })
  for (const name of ['be', 'rev']) {
    const identity = store.agentIdentity(name)!
    store.append({ type: 'AgentStarted', actorKind: 'agent', actorId: identity.id, payload: { id: agentInstanceId(identity.id), identityId: identity.id, name, role: identity.role, connectionId: `conn_${name}` } })
  }
  const projectId = store.projects()[0]!.id
  const seed = (objectiveId: string, tasks: Array<{ id: string; role: string }>) => {
    store.append({ type: 'ObjectiveCreated', actorKind: 'member', actorId: created.ownerMemberId, objectiveId, payload: { id: objectiveId, workspaceId: store.workspace()!.id, projectId, goal: 'g', runId: 'r' } })
    for (const task of tasks) {
      store.append({ type: 'TaskCreated', actorKind: 'member', actorId: created.ownerMemberId, objectiveId, payload: { id: task.id, objectiveId, projectId, title: task.id, role: task.role, dependsOn: [], files: [] } })
    }
    store.append({ type: 'ObjectiveStatusChanged', actorKind: 'member', actorId: created.ownerMemberId, objectiveId, payload: { status: 'awaiting-approval' } })
    store.append({ type: 'ObjectiveStatusChanged', actorKind: 'member', actorId: created.ownerMemberId, objectiveId, payload: { status: 'active', approvedBy: created.ownerMemberId } })
  }

  // Objective A (first in the list) has two ready tasks but a dispatch ceiling of 1.
  seed('obj_a', [{ id: 'a1', role: 'backend' }, { id: 'a2', role: 'backend' }])
  // Objective B (later) has a task waiting on review.
  seed('obj_b', [{ id: 'b1', role: 'backend' }])
  store.append({ type: 'TaskAssigned', actorKind: 'system', actorId: 'orch', objectiveId: 'obj_b', taskId: 'b1', payload: { assigneeKind: 'agent', assigneeId: 'x' } })
  store.append({ type: 'TaskStarted', actorKind: 'agent', actorId: 'x', objectiveId: 'obj_b', taskId: 'b1', payload: {} })
  store.append({ type: 'ReviewRequested', actorKind: 'agent', actorId: 'x', objectiveId: 'obj_b', taskId: 'b1', payload: {} })
  expect(store.task('b1')!.status).toBe('in-review')

  new Orchestrator({ store, maxConcurrentDispatch: 1 }).tick()

  // A's ceiling is hit, but B's review still gets routed to the idle reviewer.
  expect(store.task('b1')!.assigneeId).toBe(agentInstanceId(store.agentIdentity('rev')!.id))
})

test('an exclusive reservation stops a second task from being dispatched onto the same file', async () => {
  const { store, created, result, orchestrator } = await scenario()
  // Add a rogue second backend task on the same file as Backend A, no dependency.
  store.append({
    type: 'TaskCreated', actorKind: 'member', actorId: created.ownerMemberId, objectiveId: result.objectiveId,
    payload: { id: 'tsk_rogue', objectiveId: result.objectiveId, projectId: store.objective(result.objectiveId)!.projectId, title: 'Rogue', role: 'backend', dependsOn: [], files: ['api/a.ts'], acceptanceCriteria: [], verificationCommands: [], maxAttempts: 2 },
  })
  registerAgentIdentity(store, { name: 'be2', role: 'backend', pathScopes: ['api/**'], actorId: created.ownerMemberId })
  const be2 = store.agentIdentity('be2')!
  store.append({ type: 'AgentStarted', actorKind: 'agent', actorId: be2.id, payload: { id: agentInstanceId(be2.id), identityId: be2.id, name: 'be2', role: 'backend', connectionId: 'conn_be2' } })

  orchestrator.tick()
  const rogue = store.task('tsk_rogue')!
  expect(rogue.status).toBe('ready') // could not acquire api/a.ts
  const conflicts = store.events({ types: ['ConflictDetected'], objectiveId: result.objectiveId })
  expect(conflicts.length).toBe(1)
})
