/**
 * Pure row <-> record mappers for the workspace SQLite projections. No database
 * handle, no side effects — just shape translation, kept in one place so the
 * store and the projection reducer never disagree about column names.
 */

import type {
  AgentIdentityRecord, AgentRecord, ApprovalRecord, DecisionRecord, MemberRecord,
  ObjectiveRecord, PresenceRecord, ProjectRecord, ReservationRecord, TaskRecord,
  TokenRecord, WorkspaceRecord, AgentMessageRecord,
} from './types.ts'
import type { RoleName } from '../autonomy/types.ts'
import type { MemberRole } from './types.ts'

export type Row = Record<string, unknown>

const str = (value: unknown): string => (value == null ? '' : String(value))
const opt = (value: unknown): string | undefined => (value == null || value === '' ? undefined : String(value))
const num = (value: unknown): number => (typeof value === 'number' ? value : Number(value) || 0)
const optNum = (value: unknown): number | undefined => (value == null ? undefined : Number(value))
const bool = (value: unknown): boolean => value === 1 || value === true || value === '1'
const arr = (value: unknown): string[] => {
  if (typeof value !== 'string' || !value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

export function toWorkspace(row: Row): WorkspaceRecord {
  return { id: str(row.id), name: str(row.name), defaultProjectId: str(row.default_project_id), createdAt: str(row.created_at) }
}

export function toProject(row: Row): ProjectRecord {
  return {
    id: str(row.id), workspaceId: str(row.workspace_id), name: str(row.name),
    repoRoot: str(row.repo_root), branch: str(row.branch), createdAt: str(row.created_at),
  }
}

export function toMember(row: Row): MemberRecord {
  return { id: str(row.id), name: str(row.name), role: str(row.role) as MemberRole, createdAt: str(row.created_at), removedAt: opt(row.removed_at) }
}

export function toToken(row: Row): TokenRecord {
  return {
    id: str(row.id), kind: str(row.kind) as TokenRecord['kind'], subjectId: str(row.subject_id),
    hash: str(row.hash), label: str(row.label), createdAt: str(row.created_at),
    lastUsedAt: opt(row.last_used_at), revokedAt: opt(row.revoked_at),
  }
}

export function toAgentIdentity(row: Row): AgentIdentityRecord {
  return {
    id: str(row.id), name: str(row.name), role: str(row.role) as RoleName,
    pathScopes: arr(row.path_scopes_json), allowedTools: arr(row.allowed_tools_json),
    maxConcurrentTasks: num(row.max_concurrent_tasks), canMergeWithoutReview: bool(row.can_merge_without_review),
    createdAt: str(row.created_at), removedAt: opt(row.removed_at),
  }
}

export function toAgent(row: Row): AgentRecord {
  return {
    id: str(row.id), identityId: str(row.identity_id), name: str(row.name), role: str(row.role) as RoleName,
    status: str(row.status) as AgentRecord['status'], currentTaskId: opt(row.current_task_id),
    connectionId: opt(row.connection_id), startedAt: str(row.started_at), lastHeartbeatAt: str(row.last_heartbeat_at),
    stoppedAt: opt(row.stopped_at), lastError: opt(row.last_error),
  }
}

export function toObjective(row: Row): ObjectiveRecord {
  return {
    id: str(row.id), workspaceId: str(row.workspace_id), projectId: str(row.project_id), goal: str(row.goal),
    status: str(row.status) as ObjectiveRecord['status'], runId: str(row.run_id), createdBy: str(row.created_by),
    createdAt: str(row.created_at), updatedAt: str(row.updated_at), approvedBy: opt(row.approved_by), approvedAt: opt(row.approved_at),
  }
}

export function toTask(row: Row): TaskRecord {
  return {
    id: str(row.id), objectiveId: str(row.objective_id), projectId: str(row.project_id), title: str(row.title),
    instructions: str(row.instructions), role: str(row.role) as RoleName, status: str(row.status) as TaskRecord['status'],
    assigneeKind: opt(row.assignee_kind) as TaskRecord['assigneeKind'], assigneeId: opt(row.assignee_id),
    dependsOn: arr(row.depends_on_json), files: arr(row.files_json), wave: optNum(row.wave),
    acceptanceCriteria: arr(row.acceptance_json), verificationCommands: arr(row.verification_json),
    attemptCount: num(row.attempt_count), maxAttempts: num(row.max_attempts), goalNodeId: opt(row.goal_node_id),
    worktreeRef: opt(row.worktree_ref), leaseOwner: opt(row.lease_owner), leaseExpiresAt: optNum(row.lease_expires_at),
    createdBy: str(row.created_by), createdAt: str(row.created_at), updatedAt: str(row.updated_at),
    startedAt: opt(row.started_at), finishedAt: opt(row.finished_at), lastError: opt(row.last_error), reviewNotes: opt(row.review_notes),
  }
}

export function toReservation(row: Row): ReservationRecord {
  return {
    id: str(row.id), resource: str(row.resource), mode: str(row.mode) as ReservationRecord['mode'],
    holderKind: str(row.holder_kind) as ReservationRecord['holderKind'], holderId: str(row.holder_id),
    taskId: str(row.task_id), acquiredAt: num(row.acquired_at), expiresAt: num(row.expires_at), releasedAt: optNum(row.released_at),
  }
}

export function toAgentMessage(row: Row): AgentMessageRecord {
  let refs: AgentMessageRecord['refs'] = {}
  try {
    refs = row.refs_json ? JSON.parse(String(row.refs_json)) : {}
  } catch {
    refs = {}
  }
  return {
    id: str(row.id), seq: num(row.seq), objectiveId: opt(row.objective_id),
    fromKind: str(row.from_kind) as AgentMessageRecord['fromKind'], fromId: str(row.from_id), toId: opt(row.to_id),
    topic: str(row.topic), kind: str(row.kind) as AgentMessageRecord['kind'], body: str(row.body), refs, at: str(row.at),
  }
}

export function toDecision(row: Row): DecisionRecord {
  return {
    id: str(row.id), objectiveId: str(row.objective_id), title: str(row.title), detail: str(row.detail),
    decidedByKind: str(row.decided_by_kind) as DecisionRecord['decidedByKind'], decidedById: str(row.decided_by_id), at: str(row.at),
  }
}

export function toApproval(row: Row): ApprovalRecord {
  return {
    id: str(row.id), kind: str(row.kind) as ApprovalRecord['kind'], subject: str(row.subject),
    objectiveId: opt(row.objective_id), taskId: opt(row.task_id), status: str(row.status) as ApprovalRecord['status'],
    reason: opt(row.reason), requestedAt: str(row.requested_at), resolvedBy: opt(row.resolved_by), resolvedAt: opt(row.resolved_at),
  }
}

export function toPresence(row: Row): PresenceRecord {
  return {
    connectionId: str(row.connection_id), subjectKind: str(row.subject_kind) as PresenceRecord['subjectKind'],
    subjectId: str(row.subject_id), name: str(row.name), focus: opt(row.focus),
    connectedAt: str(row.connected_at), lastSeenAt: str(row.last_seen_at),
  }
}
