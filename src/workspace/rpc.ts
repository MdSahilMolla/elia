/**
 * The workspace RPC surface, transport-independent.
 *
 * `dispatchRpc` takes a resolved caller and a request, enforces the caller's
 * capabilities, performs the domain operation against the store, and returns a
 * plain result (the transport serializes it). Every store mutation it makes is
 * appended as an event, which the server then fans out to subscribers — so the
 * handlers here never push anything themselves.
 */

import {
  addMember, registerAgentIdentity, removeAgentIdentity, removeMember,
} from './admin.ts'
import { revokeToken, requireCapability, requireMember, type Caller } from './identity.ts'
import { AGENT_MESSAGE_KINDS, MAX_MESSAGE_BODY_LENGTH, type AgentMessageKind } from './types.ts'
import { dispatchOrchestrationRpc } from './rpcOrchestration.ts'
import type { WorkspaceStore } from './store.ts'
import type { WorkspaceRpcMethod, WorkspaceStatusResult } from './protocol.ts'

export interface RpcContext {
  store: WorkspaceStore
  caller: Caller
  /** The connection this request arrived on, for presence attribution. */
  connectionId: string
  /** Ask the transport to shut the server down after this response flushes. */
  requestShutdown: () => void
  /** Objective planner override; defaults to the model-backed planner. */
  planner?: import('./decompose.ts').ObjectivePlanner
  /** Cooperative cancellation for long operations (decomposition). */
  signal?: AbortSignal
}

export class RpcError extends Error {}

type Params = Record<string, unknown>

function str(params: Params, key: string, max = 4_000): string {
  const value = params[key]
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new RpcError(`${key} must be a non-empty string of at most ${max} characters`)
  }
  return value.trim()
}

function optStr(params: Params, key: string, max = 4_000): string | undefined {
  if (params[key] === undefined || params[key] === null || params[key] === '') return undefined
  return str(params, key, max)
}

function strArray(params: Params, key: string, maxItems = 100): string[] | undefined {
  const value = params[key]
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > maxItems || value.some((item) => typeof item !== 'string')) {
    throw new RpcError(`${key} must be an array of at most ${maxItems} strings`)
  }
  return value.map((item) => String(item).trim()).filter(Boolean)
}

function counts<T extends { status: string }>(rows: T[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const row of rows) out[row.status] = (out[row.status] ?? 0) + 1
  return out
}

export async function dispatchRpc(ctx: RpcContext, method: WorkspaceRpcMethod, params: Params = {}): Promise<unknown> {
  const { store, caller } = ctx

  switch (method) {
    case 'workspace.status': {
      requireCapability(caller, 'view')
      const workspace = store.workspace()
      const result: WorkspaceStatusResult = {
        workspace: workspace ? { id: workspace.id, name: workspace.name } : null,
        members: store.members().length,
        agents: { total: store.agents().length, byStatus: counts(store.agents()) },
        objectives: { total: store.objectives().length, byStatus: counts(store.objectives()) },
        tasks: { total: store.tasks().length, byStatus: counts(store.tasks()) },
        pendingApprovals: store.approvals('pending').length,
        activeReservations: store.reservations(true).length,
        presence: store.presence().map((row) => ({ name: row.name, kind: row.subjectKind, focus: row.focus })),
        latestSeq: store.latestSeq(),
      }
      return result
    }

    case 'member.list':
      requireCapability(caller, 'view')
      return store.members(Boolean(params.includeRemoved))

    case 'member.add': {
      requireCapability(caller, 'manage_members')
      const { memberId, token } = addMember(store, {
        name: str(params, 'name', 120),
        role: str(params, 'role', 20),
        actorId: caller.id,
      })
      return { memberId, token: token.plaintext, tokenId: token.tokenId }
    }

    case 'member.remove': {
      requireCapability(caller, 'manage_members')
      removeMember(store, str(params, 'memberId', 100), caller.id)
      return { ok: true }
    }

    case 'token.revoke': {
      requireCapability(caller, 'manage_members')
      revokeToken(store, str(params, 'tokenId', 100), caller.id)
      return { ok: true }
    }

    case 'agent.list':
      requireCapability(caller, 'view')
      return { identities: store.agentIdentities(), runtimes: store.agents() }

    case 'agent.register': {
      requireCapability(caller, 'manage_agents')
      const { identityId, token } = registerAgentIdentity(store, {
        name: str(params, 'name', 80),
        role: str(params, 'role', 40),
        pathScopes: strArray(params, 'pathScopes', 50),
        allowedTools: strArray(params, 'allowedTools', 100),
        maxConcurrentTasks: typeof params.maxConcurrentTasks === 'number' ? params.maxConcurrentTasks : undefined,
        canMergeWithoutReview: Boolean(params.canMergeWithoutReview),
        actorId: caller.id,
      })
      return { identityId, token: token.plaintext, tokenId: token.tokenId }
    }

    case 'agent.remove': {
      requireCapability(caller, 'manage_agents')
      removeAgentIdentity(store, str(params, 'identityId', 100), caller.id)
      return { ok: true }
    }

    case 'message.list': {
      requireCapability(caller, 'view')
      return store.messages({
        objectiveId: optStr(params, 'objectiveId', 100),
        toId: optStr(params, 'toId', 100),
        sinceSeq: typeof params.sinceSeq === 'number' ? params.sinceSeq : undefined,
        limit: typeof params.limit === 'number' ? params.limit : undefined,
      })
    }

    case 'message.post': {
      requireCapability(caller, 'comment')
      const kind = str(params, 'kind', 20) as AgentMessageKind
      if (!AGENT_MESSAGE_KINDS.includes(kind)) throw new RpcError(`kind must be one of ${AGENT_MESSAGE_KINDS.join(', ')}`)
      const event = store.append({
        type: 'AgentMessageCreated',
        actorKind: caller.kind,
        actorId: caller.id,
        objectiveId: optStr(params, 'objectiveId', 100),
        taskId: optStr(params, 'taskId', 100),
        payload: {
          toId: optStr(params, 'toId', 100),
          topic: str(params, 'topic', 120),
          kind,
          body: str(params, 'body', MAX_MESSAGE_BODY_LENGTH),
          refs: typeof params.refs === 'object' && params.refs ? params.refs : {},
        },
      })
      return { seq: event.seq }
    }

    case 'decision.list':
      requireCapability(caller, 'view')
      return store.decisions(str(params, 'objectiveId', 100))

    case 'decision.record': {
      requireCapability(caller, 'comment')
      const event = store.append({
        type: 'DecisionRecorded',
        actorKind: caller.kind,
        actorId: caller.id,
        objectiveId: str(params, 'objectiveId', 100),
        payload: { title: str(params, 'title', 200), detail: optStr(params, 'detail', 8_000) ?? '' },
      })
      return { seq: event.seq }
    }

    case 'events.query': {
      requireCapability(caller, 'view')
      return store.events({
        sinceSeq: typeof params.sinceSeq === 'number' ? params.sinceSeq : undefined,
        limit: typeof params.limit === 'number' ? params.limit : undefined,
        objectiveId: optStr(params, 'objectiveId', 100),
        types: strArray(params, 'types', 60),
      })
    }

    case 'presence.update': {
      requireCapability(caller, 'view')
      store.append({
        type: 'PresenceUpdated',
        actorKind: caller.kind,
        actorId: caller.id,
        payload: { connectionId: ctx.connectionId, focus: optStr(params, 'focus', 200) },
      })
      return { ok: true }
    }

    case 'shutdown': {
      requireMember(caller)
      requireCapability(caller, 'manage_members')
      ctx.requestShutdown()
      return { status: 'stopping' }
    }

    default:
      return dispatchOrchestrationRpc(ctx, method, params)
  }
}
