/**
 * Wire protocol between workspace clients (CLI, agent runtimes) and the
 * workspace server. One request/response envelope plus a server-pushed event
 * stream, mirroring `src/vscodeBridgeProtocol.ts`.
 *
 * The connection carries a bearer token (Authorization header or `?token=`).
 * Every method is authorized against the caller that token resolves to.
 */

import type { PersistedEvent, WorkspaceEventType } from './events.ts'

/** RPC methods. M2 covers identity, presence, messaging, and the feed; later
 * milestones add objective/task/agent/review methods without a protocol break. */
export type WorkspaceRpcMethod =
  | 'workspace.status'
  | 'member.add'
  | 'member.list'
  | 'member.remove'
  | 'token.revoke'
  | 'agent.register'
  | 'agent.list'
  | 'agent.remove'
  | 'objective.add'
  | 'objective.list'
  | 'objective.show'
  | 'objective.approve'
  | 'objective.reject'
  | 'task.list'
  | 'task.show'
  | 'task.add'
  | 'task.assign'
  | 'task.reassign'
  | 'task.comment'
  | 'task.instruct'
  | 'task.block'
  | 'task.unblock'
  | 'review.submit'
  | 'agent.connect'
  | 'agent.control'
  | 'agent.claim'
  | 'agent.progress'
  | 'agent.complete'
  | 'agent.explain'
  | 'message.post'
  | 'message.list'
  | 'decision.record'
  | 'decision.list'
  | 'events.query'
  | 'presence.update'
  | 'shutdown'

export const WORKSPACE_PROTOCOL_VERSION = 1

export interface WorkspaceRpcRequest {
  id: string
  method: WorkspaceRpcMethod
  params?: Record<string, unknown>
}

export interface WorkspaceRpcResponse {
  type: 'response'
  id: string
  ok: boolean
  result?: unknown
  error?: string
}

/** A projected workspace event, pushed to every subscribed connection. */
export interface WorkspaceStreamEvent {
  type: 'event'
  event: PersistedEvent
}

/** Sent once, right after a successful connection. */
export interface WorkspaceHello {
  type: 'hello'
  protocol: number
  caller: { kind: 'member' | 'agent'; id: string; name: string; role: string }
  latestSeq: number
}

export type WorkspaceServerMessage = WorkspaceRpcResponse | WorkspaceStreamEvent | WorkspaceHello

export function isWorkspaceRpcRequest(value: unknown): value is WorkspaceRpcRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const request = value as Partial<WorkspaceRpcRequest>
  return typeof request.id === 'string' && request.id.length > 0 && typeof request.method === 'string'
}

export interface WorkspaceStatusResult {
  workspace: { id: string; name: string } | null
  members: number
  agents: { total: number; byStatus: Record<string, number> }
  objectives: { total: number; byStatus: Record<string, number> }
  tasks: { total: number; byStatus: Record<string, number> }
  pendingApprovals: number
  activeReservations: number
  presence: { name: string; kind: string; focus?: string }[]
  latestSeq: number
}

export type { PersistedEvent, WorkspaceEventType }
