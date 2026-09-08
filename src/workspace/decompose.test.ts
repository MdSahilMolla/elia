import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WorkspaceStore } from './store.ts'
import { createWorkspace } from './admin.ts'
import { decomposeObjective, type ObjectivePlanner } from './decompose.ts'
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

function bootstrap() {
  const dir = mkdtempSync(join(tmpdir(), 'elia-ws-dec-'))
  dirs.push(dir)
  const store = WorkspaceStore.open(join(dir, 'workspace.sqlite'))
  stores.push(store)
  const created = createWorkspace(store, { name: 'demo', ownerName: 'sam' })
  return { store, ownerId: created.ownerMemberId }
}

const authProposal: Proposal = {
  goal: 'Build a complete authentication system',
  understanding: 'Fresh project, no auth yet.',
  assumptions: [],
  steps: [
    { id: 'api', title: 'Auth API', role: 'backend', instructions: 'Build POST /login and POST /logout.', files: ['api/auth.ts'], dependsOn: [] },
    { id: 'ui', title: 'Login form', role: 'frontend', instructions: 'Build the login form.', files: ['ui/Login.tsx'], dependsOn: [] },
    { id: 'tests', title: 'Auth tests', role: 'tester', instructions: 'Test the auth API.', files: ['api/auth.test.ts'], dependsOn: ['api'] },
    { id: 'review', title: 'Security review', role: 'security', instructions: 'Review the auth flow.', files: [], dependsOn: ['api', 'ui'] },
  ],
  risks: [],
  verification: ['bun test'],
  outOfScope: [],
}

const stubPlanner: ObjectivePlanner = async () => structuredClone(authProposal)

test('an objective decomposes into a wave-ordered task graph awaiting approval', async () => {
  const { store, ownerId } = bootstrap()
  const result = await decomposeObjective(store, { goal: authProposal.goal, actorId: ownerId }, stubPlanner)

  const objective = store.objective(result.objectiveId)!
  expect(objective.status).toBe('awaiting-approval')
  expect(store.approvals('pending').some((a) => a.kind === 'plan' && a.subject === result.objectiveId)).toBe(true)

  const tasks = store.tasks({ objectiveId: result.objectiveId })
  expect(tasks).toHaveLength(4)
  const api = tasks.find((t) => t.title === 'Auth API')!
  const tests = tasks.find((t) => t.title === 'Auth tests')!
  expect(tests.dependsOn).toEqual([api.id])
  // api + ui are independent -> wave 1; tests + review depend -> later waves.
  expect(api.wave).toBe(1)
  expect(tests.wave).toBeGreaterThan(1)
})

test('independent tasks are ready but dependents stay pending until approval + completion', async () => {
  const { store, ownerId } = bootstrap()
  const result = await decomposeObjective(store, { goal: authProposal.goal, actorId: ownerId }, stubPlanner)
  const tasksBefore = store.tasks({ objectiveId: result.objectiveId })
  // Before approval the objective is not active; readiness is still computed from deps.
  const api = tasksBefore.find((t) => t.title === 'Auth API')!
  const tests = tasksBefore.find((t) => t.title === 'Auth tests')!
  expect(api.status).toBe('ready')
  expect(tests.status).toBe('pending')

  store.append({ type: 'ObjectiveStatusChanged', actorKind: 'member', actorId: ownerId, objectiveId: result.objectiveId, payload: { status: 'active', approvedBy: ownerId } })

  store.append({ type: 'TaskAssigned', actorKind: 'system', actorId: 'orch', objectiveId: result.objectiveId, taskId: api.id, payload: { assigneeKind: 'agent', assigneeId: 'a1' } })
  store.append({ type: 'TaskStarted', actorKind: 'agent', actorId: 'a1', objectiveId: result.objectiveId, taskId: api.id, payload: {} })
  store.append({ type: 'TaskCompleted', actorKind: 'agent', actorId: 'a1', objectiveId: result.objectiveId, taskId: api.id, payload: {} })

  expect(store.task(tests.id)!.status).toBe('ready')
})

test('the objective seeds a durable goal graph beside the workspace database', async () => {
  const { store, ownerId } = bootstrap()
  const result = await decomposeObjective(store, { goal: authProposal.goal, actorId: ownerId }, stubPlanner)
  const { readGoalGraphSnapshot } = await import('../autonomy/goalGraph.ts')
  const { objectiveGraphDir } = await import('./decompose.ts')
  const snapshot = readGoalGraphSnapshot(objectiveGraphDir(store, result.objectiveId))
  expect(result.runId).toContain('wsrun-')
  expect(snapshot?.proposal?.steps).toHaveLength(4)
  expect(snapshot?.nodes.some((node) => node.id === 'step:api')).toBe(true)
})

test('a planner that returns no steps is rejected', async () => {
  const { store, ownerId } = bootstrap()
  const empty: ObjectivePlanner = async () => ({ ...authProposal, steps: [] })
  await expect(decomposeObjective(store, { goal: 'x', actorId: ownerId }, empty)).rejects.toThrow(/no steps/)
})
