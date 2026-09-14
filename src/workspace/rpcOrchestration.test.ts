import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WorkspaceStore } from './store.ts'
import { createWorkspace } from './admin.ts'
import { resolveCaller, type Caller } from './identity.ts'
import { dispatchOrchestrationRpc } from './rpcOrchestration.ts'
import { RpcError, type RpcContext } from './rpc.ts'

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
  const dir = mkdtempSync(join(tmpdir(), 'elia-ws-rpc-'))
  dirs.push(dir)
  const store = WorkspaceStore.open(join(dir, 'workspace.sqlite'))
  stores.push(store)
  return store
}

function ctxFor(store: WorkspaceStore, caller: Caller): RpcContext {
  return { store, caller, connectionId: 'test-conn', requestShutdown: () => {} }
}

test('task.add rejects a dependsOn that names a task from a different objective', async () => {
  const store = open()
  const created = createWorkspace(store, { name: 'demo', ownerName: 'sam' })
  const caller = resolveCaller(store, created.ownerToken.plaintext)
  if (!caller) throw new Error('caller did not resolve')
  const ctx = ctxFor(store, caller)

  const objA = 'obj_a'
  const objB = 'obj_b'
  for (const objectiveId of [objA, objB]) {
    store.append({
      type: 'ObjectiveCreated', actorKind: 'member', actorId: created.ownerMemberId, objectiveId,
      payload: { id: objectiveId, workspaceId: store.workspace()!.id, projectId: created.projectId, goal: 'goal', runId: `run_${objectiveId}` },
    })
  }
  store.append({
    type: 'TaskCreated', actorKind: 'member', actorId: created.ownerMemberId, objectiveId: objA,
    payload: { id: 't_in_a', objectiveId: objA, projectId: created.projectId, title: 'A task', role: 'backend', dependsOn: [], files: [] },
  })

  await expect(
    dispatchOrchestrationRpc(ctx, 'task.add', { objectiveId: objB, role: 'backend', title: 'B task', dependsOn: ['t_in_a'] }),
  ).rejects.toThrow(RpcError)

  // A same-objective dependency is unaffected.
  const result = await dispatchOrchestrationRpc(ctx, 'task.add', { objectiveId: objA, role: 'backend', title: 'A follow-up', dependsOn: ['t_in_a'] }) as { id: string }
  expect(result.id).toBeTruthy()
})
