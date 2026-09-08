/**
 * Workspace identity and authorization.
 *
 * There are no passwords and no account creation. An operator mints a bearer
 * token per human member and per agent service identity; the plaintext is shown
 * once and only its sha256 is stored. On every connection the token resolves to
 * a {@link Caller} — a member with a role-derived capability set, or an agent
 * with a deliberately small fixed set — and every mutating RPC is gated by
 * {@link requireCapability}.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  CAPABILITIES_BY_ROLE, isMemberRole,
  type Capability, type MemberRole,
} from './types.ts'
import type { RoleName } from '../autonomy/types.ts'
import type { WorkspaceStore } from './store.ts'

export interface MemberCaller {
  kind: 'member'
  id: string
  name: string
  role: MemberRole
  tokenId: string
  capabilities: ReadonlySet<Capability>
}

export interface AgentCaller {
  kind: 'agent'
  /** Agent-identity id. A runtime binds a concrete agent instance separately. */
  id: string
  name: string
  role: RoleName
  tokenId: string
  capabilities: ReadonlySet<Capability>
}

export type Caller = MemberCaller | AgentCaller

/** An agent can see the workspace and speak on the wire; it cannot govern it. */
const AGENT_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>(['view', 'comment'])

const TOKEN_PREFIX = 'wst_'

export function generateTokenPlaintext(): string {
  return `${TOKEN_PREFIX}${randomBytes(30).toString('base64url')}`
}

export function hashToken(plaintext: string): string {
  return createHash('sha256').update(plaintext.trim()).digest('hex')
}

export interface MintedToken {
  plaintext: string
  tokenId: string
}

/** Mint a member bearer token. Appends `TokenMinted`; returns the one-time plaintext. */
export function mintMemberToken(
  store: WorkspaceStore,
  input: { memberId: string; label: string; actorId: string },
): MintedToken {
  const member = store.member(input.memberId)
  if (!member || member.removedAt) throw new Error(`unknown member ${input.memberId}`)
  return mint(store, { kind: 'member', subjectId: member.id, label: input.label, actorId: input.actorId })
}

/** Mint an agent service token for a registered agent identity. */
export function mintAgentToken(
  store: WorkspaceStore,
  input: { identityId: string; label: string; actorId: string },
): MintedToken {
  const identity = store.agentIdentity(input.identityId)
  if (!identity || identity.removedAt) throw new Error(`unknown agent identity ${input.identityId}`)
  return mint(store, { kind: 'agent', subjectId: identity.id, label: input.label, actorId: input.actorId })
}

function mint(
  store: WorkspaceStore,
  input: { kind: 'member' | 'agent'; subjectId: string; label: string; actorId: string },
): MintedToken {
  const plaintext = generateTokenPlaintext()
  const tokenId = `tok_${randomUUID().replaceAll('-', '')}`
  store.append({
    type: 'TokenMinted',
    actorKind: 'member',
    actorId: input.actorId,
    payload: { id: tokenId, kind: input.kind, subjectId: input.subjectId, hash: hashToken(plaintext), label: input.label },
  })
  return { plaintext, tokenId }
}

export function revokeToken(store: WorkspaceStore, tokenId: string, actorId: string): void {
  const token = store.tokens().find((item) => item.id === tokenId)
  if (!token) throw new Error(`unknown token ${tokenId}`)
  store.append({ type: 'TokenRevoked', actorKind: 'member', actorId, payload: { id: tokenId } })
}

/** Resolve a bearer token to a caller, or `undefined` if it is unknown or revoked. */
export function resolveCaller(store: WorkspaceStore, plaintext: string | undefined): Caller | undefined {
  if (typeof plaintext !== 'string' || !plaintext.trim()) return undefined
  const token = store.tokenByHash(hashToken(plaintext))
  if (!token || token.revokedAt) return undefined

  if (token.kind === 'member') {
    const member = store.member(token.subjectId)
    if (!member || member.removedAt || !isMemberRole(member.role)) return undefined
    store.touchToken(token.id)
    return {
      kind: 'member', id: member.id, name: member.name, role: member.role, tokenId: token.id,
      capabilities: CAPABILITIES_BY_ROLE[member.role],
    }
  }

  const identity = store.agentIdentity(token.subjectId)
  if (!identity || identity.removedAt) return undefined
  store.touchToken(token.id)
  return {
    kind: 'agent', id: identity.id, name: identity.name, role: identity.role, tokenId: token.id,
    capabilities: AGENT_CAPABILITIES,
  }
}

export class AuthorizationError extends Error {
  constructor(public readonly capability: Capability, callerName: string) {
    super(`${callerName} is not permitted to ${capability.replace(/_/g, ' ')}`)
    this.name = 'AuthorizationError'
  }
}

export function hasCapability(caller: Caller, capability: Capability): boolean {
  return caller.capabilities.has(capability)
}

export function requireCapability(caller: Caller, capability: Capability): void {
  if (!hasCapability(caller, capability)) throw new AuthorizationError(capability, caller.name)
}

export function requireAgent(caller: Caller): AgentCaller {
  if (caller.kind !== 'agent') throw new Error('this operation is only available to an agent runtime')
  return caller
}

export function requireMember(caller: Caller): MemberCaller {
  if (caller.kind !== 'member') throw new Error('this operation is only available to a workspace member')
  return caller
}
