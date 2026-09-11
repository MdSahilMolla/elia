/**
 * Composite administrative operations over {@link WorkspaceStore}: create the
 * workspace, add members, register agent identities. Each is a thin wrapper that
 * validates input and appends the relevant event(s); the projection reducer does
 * the rest.
 */

import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { isRoleName, type RoleName } from '../autonomy/types.ts'
import { isMemberRole, ID_PATTERN, type MemberRole } from './types.ts'
import { mintAgentToken, mintMemberToken, type MintedToken } from './identity.ts'
import type { WorkspaceStore } from './store.ts'

function text(value: unknown, name: string, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new Error(`${name} must be a non-empty string of at most ${max} characters`)
  }
  return value.trim()
}

function identifier(prefix: string, value: unknown, name: string): string {
  if (value === undefined) return `${prefix}_${randomUUID().replaceAll('-', '')}`
  const result = text(value, name, 100)
  if (!ID_PATTERN.test(result)) throw new Error(`${name} may contain only letters, numbers, dot, underscore, colon, or hyphen`)
  return result
}

export interface CreateWorkspaceResult {
  workspaceId: string
  projectId: string
  ownerMemberId: string
  ownerToken: MintedToken
}

/** Create the workspace, its default project, an owner member, and the owner token. */
export function createWorkspace(
  store: WorkspaceStore,
  input: { name: string; ownerName?: string; repoRoot?: string; branch?: string; projectName?: string },
): CreateWorkspaceResult {
  const workspaceId = `ws_${randomUUID().replaceAll('-', '')}`
  const projectId = `prj_${randomUUID().replaceAll('-', '')}`
  const ownerMemberId = `mbr_${randomUUID().replaceAll('-', '')}`
  const repoRoot = resolve(input.repoRoot ?? process.cwd())

  // The emptiness check and the two appends must be one atomic unit: without a
  // transaction, two concurrent `elia workspace init` calls against the same
  // fresh db can both pass `store.workspace()` before either commits, and both
  // go on to append a WorkspaceCreated event.
  store.transact(() => {
    if (store.workspace()) throw new Error('this workspace database already has a workspace; use a fresh path')

    store.append({
      type: 'WorkspaceCreated',
      actorKind: 'member',
      actorId: ownerMemberId,
      objectiveId: undefined,
      payload: {
        id: workspaceId,
        name: text(input.name, 'name'),
        defaultProjectId: projectId,
        projectName: input.projectName ? text(input.projectName, 'projectName') : 'default',
        repoRoot,
        branch: input.branch ? text(input.branch, 'branch', 200) : 'main',
      },
    })
    store.append({
      type: 'MemberAdded',
      actorKind: 'member',
      actorId: ownerMemberId,
      payload: { id: ownerMemberId, name: text(input.ownerName ?? 'owner', 'ownerName'), role: 'owner' satisfies MemberRole },
    })
  })
  const ownerToken = mintMemberToken(store, { memberId: ownerMemberId, label: 'owner', actorId: ownerMemberId })
  return { workspaceId, projectId, ownerMemberId, ownerToken }
}

export interface AddMemberResult {
  memberId: string
  token: MintedToken
}

export function addMember(
  store: WorkspaceStore,
  input: { name: string; role: string; actorId: string; memberId?: string },
): AddMemberResult {
  if (!isMemberRole(input.role)) throw new Error(`role must be one of owner, maintainer, contributor, viewer`)
  const memberId = identifier('mbr', input.memberId, 'memberId')
  store.append({
    type: 'MemberAdded',
    actorKind: 'member',
    actorId: input.actorId,
    payload: { id: memberId, name: text(input.name, 'name'), role: input.role },
  })
  const token = mintMemberToken(store, { memberId, label: `${input.role}:${input.name}`.slice(0, 120), actorId: input.actorId })
  return { memberId, token }
}

export function removeMember(store: WorkspaceStore, memberId: string, actorId: string): void {
  const member = store.member(memberId)
  if (!member) throw new Error(`unknown member ${memberId}`)
  if (member.role === 'owner' && store.members().filter((item) => item.role === 'owner').length <= 1) {
    throw new Error('cannot remove the last owner')
  }
  store.append({ type: 'MemberRemoved', actorKind: 'member', actorId, payload: { id: memberId } })
  for (const token of store.tokens(memberId)) {
    if (!token.revokedAt) store.append({ type: 'TokenRevoked', actorKind: 'member', actorId, payload: { id: token.id } })
  }
}

export interface RegisterAgentInput {
  name: string
  role: RoleName | string
  pathScopes?: string[]
  allowedTools?: string[]
  maxConcurrentTasks?: number
  canMergeWithoutReview?: boolean
  actorId: string
}

export interface RegisterAgentResult {
  identityId: string
  token: MintedToken
}

export function registerAgentIdentity(store: WorkspaceStore, input: RegisterAgentInput): RegisterAgentResult {
  if (!isRoleName(input.role)) throw new Error(`role must be a valid worker role (e.g. frontend, backend, tester, scout)`)
  const name = text(input.name, 'name', 80)
  const existing = store.agentIdentity(name)
  const identityId = existing?.id ?? `aid_${randomUUID().replaceAll('-', '')}`
  const pathScopes = (input.pathScopes ?? []).map((glob) => text(glob, 'pathScopes[]', 400)).slice(0, 50)
  const allowedTools = (input.allowedTools ?? []).map((tool) => text(tool, 'allowedTools[]', 80)).slice(0, 100)
  // `agentInstanceId` (rpcAgents.ts) derives exactly one runtime row per identity, and the
  // orchestrator's dispatch loop (orchestrator.ts) only ever assigns a task to an `idle`
  // runtime — there is no per-runtime task count anywhere. A value above 1 would silently
  // do nothing, so reject it here rather than accept and ignore it.
  if (input.maxConcurrentTasks !== undefined && input.maxConcurrentTasks > 1) {
    throw new Error(
      'maxConcurrentTasks > 1 is not supported yet — each agent identity runs a single runtime that processes one task at a time (see agentInstanceId in rpcAgents.ts). Omit maxConcurrentTasks or set it to 1.',
    )
  }
  const maxConcurrentTasks = 1

  store.append({
    type: 'AgentIdentityRegistered',
    actorKind: 'member',
    actorId: input.actorId,
    payload: {
      id: identityId, name, role: input.role, pathScopes, allowedTools,
      maxConcurrentTasks, canMergeWithoutReview: Boolean(input.canMergeWithoutReview),
    },
  })

  // Re-registering keeps the existing service token; a fresh identity gets one.
  const activeToken = store.tokens(identityId).find((item) => !item.revokedAt)
  const token: MintedToken = existing && activeToken
    ? { plaintext: '(unchanged — existing token still valid)', tokenId: activeToken.id }
    : mintAgentToken(store, { identityId, label: `agent:${name}`, actorId: input.actorId })

  return { identityId, token }
}

export function removeAgentIdentity(store: WorkspaceStore, identityId: string, actorId: string): void {
  const identity = store.agentIdentity(identityId)
  if (!identity) throw new Error(`unknown agent identity ${identityId}`)
  store.append({ type: 'AgentIdentityRemoved', actorKind: 'member', actorId, payload: { id: identity.id } })
  for (const token of store.tokens(identity.id)) {
    if (!token.revokedAt) store.append({ type: 'TokenRevoked', actorKind: 'member', actorId, payload: { id: token.id } })
  }
}
