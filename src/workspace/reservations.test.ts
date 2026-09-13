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

test('globsOverlap stays segment-aligned: siblings and name-prefixes are not collisions', () => {
  // Used to collide: the literal side was cut back to its parent (`src`), and
  // any glob anywhere under `src/` "overlapped" it.
  expect(globsOverlap('src/ui', 'src/other/**')).toBe(false)
  expect(globsOverlap('src/ui/App.tsx', 'src/api/*.ts')).toBe(false)
  // A shared character prefix is not a shared directory.
  expect(globsOverlap('a.b', 'a.bc/**')).toBe(false)
  expect(globsOverlap('src/ui', 'src/uix/**')).toBe(false)
  // A bare path may be a directory (dots and all), so these stay collisions.
  expect(globsOverlap('a.b', 'a.b/**')).toBe(true)
  expect(globsOverlap('lib.d', 'lib.d/types.ts')).toBe(true)
})

test('globsOverlap matches a literal path against a glob exactly', () => {
  // Used to be missed: a pattern with no literal directory prefix was ignored.
  expect(globsOverlap('**/*.ts', 'src/a.ts')).toBe(true)
  expect(globsOverlap('src/**/*.test.ts', 'src/deep/x.test.ts')).toBe(true)
  expect(globsOverlap('src/**/*.test.ts', 'src/x.test.ts')).toBe(true)
  expect(globsOverlap('src/**/*.test.ts', 'src/deep/x.ts')).toBe(false)
  // `*` does not cross a directory boundary.
  expect(globsOverlap('src/*.ts', 'src/ui/a.ts')).toBe(false)
  // A literal directory that a glob's matches live under collides with it.
  expect(globsOverlap('src', 'src/ui/*.tsx')).toBe(true)
  // Regex metacharacters in a path are literal.
  expect(globsOverlap('src/a+b.ts', 'src/*.ts')).toBe(true)
  expect(globsOverlap('src/a+b.ts', 'src/aab.ts')).toBe(false)
})

test('globsOverlap catches a "?" single-char wildcard collision', () => {
  expect(globsOverlap('src/a?.ts', 'src/ab.ts')).toBe(true)
  expect(globsOverlap('src/a?.ts', 'src/az.ts')).toBe(true)
})

test('globsOverlap expands "{a,b}" brace alternation instead of treating it as a literal', () => {
  expect(globsOverlap('src/{a,b}.ts', 'src/a.ts')).toBe(true)
  expect(globsOverlap('src/{a,b}.ts', 'src/b.ts')).toBe(true)
  expect(globsOverlap('src/{a,b}.ts', 'src/c.ts')).toBe(false)
  // Both sides braced, disjoint option sets on both.
  expect(globsOverlap('src/{a,b}.ts', 'src/{c,d}.ts')).toBe(false)
  expect(globsOverlap('src/{a,b}.ts', 'src/{b,c}.ts')).toBe(true)
  // Multiple brace groups in one pattern.
  expect(globsOverlap('src/{a,b}/{x,y}.ts', 'src/b/y.ts')).toBe(true)
  expect(globsOverlap('src/{a,b}/{x,y}.ts', 'src/c/y.ts')).toBe(false)
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

test('acquireForTask notifies listeners for every reservation it acquires (buffered fan-out still fires on a normal commit)', () => {
  const { store, objectiveId } = bootstrap()
  const seen: string[] = []
  store.subscribe((event) => seen.push(event.type))

  const result = acquireForTask(store, { taskId: 't1', objectiveId, holderKind: 'agent', holderId: 'a1', resources: ['api/login.ts', 'api/logout.ts'] })
  expect('acquired' in result).toBe(true)

  // `acquireForTask` wraps its whole loop in `store.transact()`, so each
  // `ReservationAcquired` append is only a savepoint until that transaction
  // commits. Notification must still reach listeners once it does — the fix for
  // deferred-until-commit fan-out must not turn into "never fan out".
  expect(seen).toEqual(['ReservationAcquired', 'ReservationAcquired'])
})

test('renewForTask pushes the lease out — on the event spine, not a raw write', () => {
  const { store, objectiveId } = bootstrap()
  acquireForTask(store, { taskId: 't1', objectiveId, holderKind: 'agent', holderId: 'a1', resources: ['api/login.ts'] })
  const before = store.reservations(true)[0]!.expiresAt
  renewForTask(store, 't1', Date.now() + 1_000)
  expect(store.reservations(true)[0]!.expiresAt).toBeGreaterThan(before)
  // The renewal is a durable event — a projection rebuilt from the log keeps it,
  // instead of every live lease reverting to its acquire-time expiry.
  expect(store.events({ types: ['ReservationRenewed'] })).toHaveLength(1)
  expect(store.auditChainIntact()).toBe(true)
})
