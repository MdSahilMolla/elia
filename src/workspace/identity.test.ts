import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WorkspaceStore } from './store.ts'
import { addMember, createWorkspace, registerAgentIdentity } from './admin.ts'
import { AuthorizationError, requireCapability, resolveCaller, revokeToken } from './identity.ts'

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
  const dir = mkdtempSync(join(tmpdir(), 'elia-ws-id-'))
  dirs.push(dir)
  const store = WorkspaceStore.open(join(dir, 'workspace.sqlite'))
  stores.push(store)
  return store
}

test('the owner token resolves to an owner caller with every capability', () => {
  const store = open()
  const created = createWorkspace(store, { name: 'demo' })
  const caller = resolveCaller(store, created.ownerToken.plaintext)
  expect(caller?.kind).toBe('member')
  expect(caller?.role).toBe('owner')
  requireCapability(caller!, 'manage_members')
  requireCapability(caller!, 'approve_plan')
})

test('a contributor token cannot approve plans or manage agents', () => {
  const store = open()
  const created = createWorkspace(store, { name: 'demo' })
  const { token } = addMember(store, { name: 'dev', role: 'contributor', actorId: created.ownerMemberId })
  const caller = resolveCaller(store, token.plaintext)!
  requireCapability(caller, 'create_task')
  expect(() => requireCapability(caller, 'approve_plan')).toThrow(AuthorizationError)
  expect(() => requireCapability(caller, 'manage_agents')).toThrow(AuthorizationError)
})

test('an agent service token resolves to an agent caller with only view and comment', () => {
  const store = open()
  const created = createWorkspace(store, { name: 'demo' })
  const { token } = registerAgentIdentity(store, { name: 'fe', role: 'frontend', actorId: created.ownerMemberId })
  const caller = resolveCaller(store, token.plaintext)!
  expect(caller.kind).toBe('agent')
  requireCapability(caller, 'comment')
  expect(() => requireCapability(caller, 'assign_task')).toThrow(AuthorizationError)
})

test('a revoked token stops resolving', () => {
  const store = open()
  const created = createWorkspace(store, { name: 'demo' })
  const { token } = addMember(store, { name: 'dev', role: 'maintainer', actorId: created.ownerMemberId })
  expect(resolveCaller(store, token.plaintext)).toBeDefined()
  revokeToken(store, token.tokenId, created.ownerMemberId)
  expect(resolveCaller(store, token.plaintext)).toBeUndefined()
})

test('an unknown or empty token never resolves', () => {
  const store = open()
  createWorkspace(store, { name: 'demo' })
  expect(resolveCaller(store, 'wst_not-a-real-token')).toBeUndefined()
  expect(resolveCaller(store, '')).toBeUndefined()
  expect(resolveCaller(store, undefined)).toBeUndefined()
})

test('only the token hash is persisted, never the plaintext', () => {
  const store = open()
  const created = createWorkspace(store, { name: 'demo' })
  const stored = store.tokens()[0]!
  expect(stored.hash).not.toContain(created.ownerToken.plaintext)
  expect(stored.hash).toHaveLength(64)
  const dump = JSON.stringify(store.events())
  expect(dump).not.toContain(created.ownerToken.plaintext)
})
