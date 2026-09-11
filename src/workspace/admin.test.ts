import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WorkspaceStore } from './store.ts'
import { addMember, createWorkspace, registerAgentIdentity, removeAgentIdentity, removeMember } from './admin.ts'
import { resolveCaller } from './identity.ts'

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

function open(): WorkspaceStore {
  const dir = mkdtempSync(join(tmpdir(), 'elia-ws-admin-'))
  dirs.push(dir)
  const store = WorkspaceStore.open(join(dir, 'workspace.sqlite'))
  stores.push(store)
  return store
}

test('a workspace can only be created once per database', () => {
  const store = open()
  createWorkspace(store, { name: 'demo' })
  expect(() => createWorkspace(store, { name: 'again' })).toThrow()
})

test('addMember rejects an unknown role', () => {
  const store = open()
  const created = createWorkspace(store, { name: 'demo' })
  expect(() => addMember(store, { name: 'x', role: 'superuser', actorId: created.ownerMemberId })).toThrow()
})

test('the last owner cannot be removed', () => {
  const store = open()
  const created = createWorkspace(store, { name: 'demo' })
  expect(() => removeMember(store, created.ownerMemberId, created.ownerMemberId)).toThrow()
})

test('removing a member revokes their tokens', () => {
  const store = open()
  const created = createWorkspace(store, { name: 'demo' })
  const { memberId, token } = addMember(store, { name: 'dev', role: 'contributor', actorId: created.ownerMemberId })
  removeMember(store, memberId, created.ownerMemberId)
  expect(resolveCaller(store, token.plaintext)).toBeUndefined()
  expect(store.member(memberId)?.removedAt).toBeDefined()
})

test('registerAgentIdentity validates the role and stores the scope', () => {
  const store = open()
  const created = createWorkspace(store, { name: 'demo' })
  expect(() => registerAgentIdentity(store, { name: 'bad', role: 'nonsense', actorId: created.ownerMemberId })).toThrow()

  const { identityId } = registerAgentIdentity(store, {
    name: 'be', role: 'backend', pathScopes: ['api/**'], maxConcurrentTasks: 1, actorId: created.ownerMemberId,
  })
  const identity = store.agentIdentity(identityId)!
  expect(identity.role).toBe('backend')
  expect(identity.pathScopes).toEqual(['api/**'])
  expect(identity.maxConcurrentTasks).toBe(1)
})

test('registerAgentIdentity rejects maxConcurrentTasks > 1 — dispatch has no multi-task-per-runtime support', () => {
  const store = open()
  const created = createWorkspace(store, { name: 'demo' })
  expect(() => registerAgentIdentity(store, {
    name: 'be', role: 'backend', maxConcurrentTasks: 3, actorId: created.ownerMemberId,
  })).toThrow(/maxConcurrentTasks/)
  // The rejected registration must not have partially applied.
  expect(store.agentIdentity('be')).toBeUndefined()
})

test('re-registering an agent updates it in place and keeps the existing token', () => {
  const store = open()
  const created = createWorkspace(store, { name: 'demo' })
  const first = registerAgentIdentity(store, { name: 'fe', role: 'frontend', actorId: created.ownerMemberId })
  const second = registerAgentIdentity(store, { name: 'fe', role: 'frontend', pathScopes: ['ui/**'], actorId: created.ownerMemberId })
  expect(second.identityId).toBe(first.identityId)
  expect(resolveCaller(store, first.token.plaintext)?.name).toBe('fe')
  expect(store.agentIdentity('fe')?.pathScopes).toEqual(['ui/**'])
  expect(store.agentIdentities()).toHaveLength(1)
})

test('removeAgentIdentity soft-deletes and revokes the service token', () => {
  const store = open()
  const created = createWorkspace(store, { name: 'demo' })
  const { identityId, token } = registerAgentIdentity(store, { name: 'sec', role: 'security', actorId: created.ownerMemberId })
  removeAgentIdentity(store, identityId, created.ownerMemberId)
  expect(store.agentIdentity(identityId)?.removedAt).toBeDefined()
  expect(resolveCaller(store, token.plaintext)).toBeUndefined()
})
