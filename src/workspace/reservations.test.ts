import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WorkspaceStore } from './store.ts'
import { createWorkspace } from './admin.ts'
import { acquireForTask, globsOverlap, reconcileReservations, releaseForTask, renewForTask } from './reservations.ts'

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
  const dir = mkdtempSync(join(tmpdir(), 'elia-ws-rsv-'))
  dirs.push(dir)
  const store = WorkspaceStore.open(join(dir, 'workspace.sqlite'))
  stores.push(store)
  const created = createWorkspace(store, { name: 'demo' })
  const objectiveId = 'obj_1'
  store.append({ type: 'ObjectiveCreated', actorKind: 'member', actorId: created.ownerMemberId, objectiveId, payload: { id: objectiveId, workspaceId: store.workspace()!.id, projectId: created.projectId, goal: 'g', runId: 'r' } })
  return { store, objectiveId, ownerId: created.ownerMemberId }
}

test('globsOverlap catches directory-glob and prefix collisions', () => {
  expect(globsOverlap('src/ui/App.tsx', 'src/ui/App.tsx')).toBe(true)
  expect(globsOverlap('src/ui/**', 'src/ui/App.tsx')).toBe(true)
  expect(globsOverlap('src/ui', 'src/ui/App.tsx')).toBe(true)
  expect(globsOverlap('src/api/**', 'src/ui/App.tsx')).toBe(false)
  expect(globsOverlap('api/login.ts', 'api/logout.ts')).toBe(false)
})

test('a second task cannot reserve a file the first still holds', () => {
  const { store, objectiveId } = bootstrap()
  const first = acquireForTask(store, { taskId: 't1', objectiveId, holderKind: 'agent', holderId: 'a1', resources: ['api/login.ts'] })
  expect('acquired' in first).toBe(true)

  const second = acquireForTask(store, { taskId: 't2', objectiveId, holderKind: 'agent', holderId: 'a2', resources: ['api/login.ts'] })
  expect('conflicts' in second).toBe(true)
  if ('conflicts' in second) expect(second.conflicts[0]!.taskId).toBe('t1')
})

test('disjoint files are both reservable', () => {
  const { store, objectiveId } = bootstrap()
  expect('acquired' in acquireForTask(store, { taskId: 't1', objectiveId, holderKind: 'agent', holderId: 'a1', resources: ['api/login.ts'] })).toBe(true)
  expect('acquired' in acquireForTask(store, { taskId: 't2', objectiveId, holderKind: 'agent', holderId: 'a2', resources: ['ui/Login.tsx'] })).toBe(true)
})

test('releasing a task frees its files for the next', () => {
  const { store, objectiveId } = bootstrap()
  acquireForTask(store, { taskId: 't1', objectiveId, holderKind: 'agent', holderId: 'a1', resources: ['api/login.ts'] })
  releaseForTask(store, 't1')
  expect('acquired' in acquireForTask(store, { taskId: 't2', objectiveId, holderKind: 'agent', holderId: 'a2', resources: ['api/login.ts'] })).toBe(true)
})

test('an expired reservation is reclaimed and does not block', () => {
  const { store, objectiveId } = bootstrap()
  const past = Date.now() - 10 * 60_000
  acquireForTask(store, { taskId: 't1', objectiveId, holderKind: 'agent', holderId: 'a1', resources: ['api/login.ts'], now: past })
  expect(reconcileReservations(store)).toHaveLength(1)
  expect('acquired' in acquireForTask(store, { taskId: 't2', objectiveId, holderKind: 'agent', holderId: 'a2', resources: ['api/login.ts'] })).toBe(true)
})

test('renewForTask pushes the lease out', () => {
  const { store, objectiveId } = bootstrap()
  acquireForTask(store, { taskId: 't1', objectiveId, holderKind: 'agent', holderId: 'a1', resources: ['api/login.ts'] })
  const before = store.reservations(true)[0]!.expiresAt
  renewForTask(store, 't1', Date.now() + 1_000)
  expect(store.reservations(true)[0]!.expiresAt).toBeGreaterThan(before)
})
