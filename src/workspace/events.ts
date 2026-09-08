/**
 * The workspace event vocabulary and its projection reducer.
 *
 * Every mutation in the workspace is one row appended to `workspace_events` plus
 * the projection updates `applyProjection` derives from it — both inside a single
 * transaction owned by `WorkspaceStore.append`. Events are never mutated or
 * replayed selectively; the projection tables are simply the forward fold of the
 * spine, and can be rebuilt by replaying every event through `applyProjection`.
 */

import type { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import {
  agentCanTransition, objectiveCanTransition, taskCanTransition,
  type AgentStatus, type AssigneeKind, type ObjectiveStatus, type TaskStatus,
} from './types.ts'
import { toAgent, toObjective, toTask, type Row } from './rows.ts'

export const WORKSPACE_EVENT_TYPES = [
  'WorkspaceCreated',
  'MemberAdded', 'MemberRemoved',
  'TokenMinted', 'TokenRevoked',
  'AgentIdentityRegistered', 'AgentIdentityRemoved',
  'AgentStarted', 'AgentStateChanged', 'AgentStopped', 'AgentHeartbeat',
  'ObjectiveCreated', 'ObjectivePlanned', 'ObjectiveStatusChanged',
  'TaskCreated', 'TaskStatusChanged', 'TaskAssigned', 'TaskReassigned',
  'TaskStarted', 'TaskProgress', 'TaskCompleted', 'TaskFailed',
  'TaskBlocked', 'TaskUnblocked', 'TaskCancelled', 'TaskInstructionAdded',
  'ReviewRequested', 'ReviewCompleted', 'ChangesRequested',
  'FileChanged', 'ReservationAcquired', 'ReservationReleased', 'ReservationExpired', 'ReservationRenewed', 'ConflictDetected',
  'AgentMessageCreated', 'DecisionRecorded', 'CommentPosted',
  'ApprovalRequired', 'ApprovalGranted', 'ApprovalRejected',
  'PresenceJoined', 'PresenceUpdated', 'PresenceLeft',
] as const

export type WorkspaceEventType = (typeof WORKSPACE_EVENT_TYPES)[number]

export function isWorkspaceEventType(value: unknown): value is WorkspaceEventType {
  return typeof value === 'string' && (WORKSPACE_EVENT_TYPES as readonly string[]).includes(value)
}

/** What a caller hands to `store.append`. */
export interface WorkspaceEventInput {
  type: WorkspaceEventType
  actorKind: AssigneeKind | 'system'
  actorId: string
  objectiveId?: string
  taskId?: string
  payload?: Record<string, unknown>
}

/** An event as stored and streamed. */
export interface PersistedEvent {
  seq: number
  id: string
  type: WorkspaceEventType
  actorKind: AssigneeKind | 'system'
  actorId: string
  objectiveId?: string
  taskId?: string
  payload: Record<string, unknown>
  at: string
}

export function newEventId(): string {
  return `evt_${randomUUID().replaceAll('-', '')}`
}

// --- Ergonomic constructors for the common events (optional; append accepts raw input too) ---

export const events = {
  memberAdded: (actorId: string, member: { id: string; name: string; role: string }): WorkspaceEventInput => ({
    type: 'MemberAdded', actorKind: 'member', actorId, payload: member,
  }),
  agentMessage: (input: {
    fromKind: AssigneeKind; fromId: string; toId?: string; objectiveId?: string; taskId?: string
    topic: string; kind: string; body: string; refs?: Record<string, unknown>
  }): WorkspaceEventInput => ({
    type: 'AgentMessageCreated', actorKind: input.fromKind, actorId: input.fromId,
    objectiveId: input.objectiveId, taskId: input.taskId,
    payload: { toId: input.toId, topic: input.topic, kind: input.kind, body: input.body, refs: input.refs ?? {} },
  }),
  decisionRecorded: (input: {
    decidedByKind: AssigneeKind; decidedById: string; objectiveId: string; title: string; detail: string
  }): WorkspaceEventInput => ({
    type: 'DecisionRecorded', actorKind: input.decidedByKind, actorId: input.decidedById, objectiveId: input.objectiveId,
    payload: { title: input.title, detail: input.detail },
  }),
}

// --- Projection reducer ---

const nowIso = (): string => new Date().toISOString()
const jstr = (value: unknown): string => JSON.stringify(Array.isArray(value) ? value : value ?? [])

/** Epoch ms for an event's own timestamp — used wherever a projection needs a
 * clock, so replaying the same log twice yields byte-identical projections. */
const eventMs = (event: PersistedEvent): number => {
  const parsed = Date.parse(event.at)
  return Number.isFinite(parsed) ? parsed : Date.now()
}

/** A dependency is satisfied once it reaches a terminal state. `cancelled` counts:
 * a dependent that waited on `done` only would strand forever behind a cancel. */
const TERMINAL_DEP_STATUSES: ReadonlySet<TaskStatus> = new Set(['done', 'cancelled'])

function requireTaskRow(db: Database, taskId: string): Row {
  const row = db.query('SELECT * FROM tasks WHERE id = ?').get(taskId) as Row | null
  if (!row) throw new Error(`unknown task ${taskId}`)
  return row
}

function requireAgentRow(db: Database, agentId: string): Row {
  const row = db.query('SELECT * FROM agents WHERE id = ?').get(agentId) as Row | null
  if (!row) throw new Error(`unknown agent ${agentId}`)
  return row
}

function setObjectiveStatus(db: Database, objectiveId: string, next: ObjectiveStatus, extra: Row = {}): void {
  const row = db.query('SELECT * FROM objectives WHERE id = ?').get(objectiveId) as Row | null
  if (!row) throw new Error(`unknown objective ${objectiveId}`)
  const current = toObjective(row).status
  if (!objectiveCanTransition(current, next)) throw new Error(`objective ${objectiveId}: illegal transition ${current} -> ${next}`)
  const columns = ['status = ?', 'updated_at = ?']
  const values: unknown[] = [next, nowIso()]
  for (const [key, value] of Object.entries(extra)) {
    columns.push(`${key} = ?`)
    values.push(value)
  }
  values.push(objectiveId)
  db.query(`UPDATE objectives SET ${columns.join(', ')} WHERE id = ?`).run(...values as never[])
}

function setTaskStatus(db: Database, taskId: string, next: TaskStatus, extra: Row = {}): void {
  const row = requireTaskRow(db, taskId)
  const current = toTask(row).status
  if (!taskCanTransition(current, next)) throw new Error(`task ${taskId}: illegal transition ${current} -> ${next}`)
  const columns = ['status = ?', 'updated_at = ?']
  const values: unknown[] = [next, nowIso()]
  for (const [key, value] of Object.entries(extra)) {
    columns.push(`${key} = ?`)
    values.push(value)
  }
  values.push(taskId)
  db.query(`UPDATE tasks SET ${columns.join(', ')} WHERE id = ?`).run(...values as never[])
}

function setAgentStatus(db: Database, agentId: string, next: AgentStatus, extra: Row = {}): void {
  const row = requireAgentRow(db, agentId)
  const current = toAgent(row).status
  if (!agentCanTransition(current, next)) throw new Error(`agent ${agentId}: illegal transition ${current} -> ${next}`)
  const columns = ['status = ?', 'last_heartbeat_at = ?']
  const values: unknown[] = [next, nowIso()]
  for (const [key, value] of Object.entries(extra)) {
    columns.push(`${key} = ?`)
    values.push(value)
  }
  values.push(agentId)
  db.query(`UPDATE agents SET ${columns.join(', ')} WHERE id = ?`).run(...values as never[])
}

/** Recompute pending<->ready for every open task in an objective from its dependencies' statuses. */
export function refreshTaskReadiness(db: Database, objectiveId: string): string[] {
  const rows = db.query('SELECT * FROM tasks WHERE objective_id = ?').all(objectiveId) as Row[]
  const byId = new Map(rows.map((row) => [String(row.id), toTask(row)]))
  const changed: string[] = []
  for (const task of byId.values()) {
    if (task.status !== 'pending' && task.status !== 'ready') continue
    // An unknown dependency id (typo, stale ref after a re-plan) is NOT treated
    // as satisfied — a task that can never be scheduled correctly is a louder,
    // more debuggable failure than one dispatched before its real prerequisite.
    const depsDone = task.dependsOn.every((depId) => {
      const dep = byId.get(depId)
      return dep ? TERMINAL_DEP_STATUSES.has(dep.status) : false
    })
    const next: TaskStatus = depsDone ? 'ready' : 'pending'
    if (next !== task.status) {
      db.query('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run(next, nowIso(), task.id)
      changed.push(task.id)
    }
  }
  return changed
}

/**
 * Apply one event's effect to the projection tables. Throws on an illegal state
 * transition or a reference to a row that does not exist — the enclosing
 * transaction then rolls back and the event is not appended.
 */
export function applyProjection(db: Database, event: PersistedEvent): void {
  const p = event.payload
  switch (event.type) {
    case 'WorkspaceCreated': {
      db.query('INSERT INTO workspaces (id, name, default_project_id, created_at) VALUES (?, ?, ?, ?)')
        .run(String(p.id), String(p.name), String(p.defaultProjectId), event.at)
      db.query('INSERT INTO projects (id, workspace_id, name, repo_root, branch, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(String(p.defaultProjectId), String(p.id), String(p.projectName ?? 'default'), String(p.repoRoot), String(p.branch ?? 'main'), event.at)
      return
    }
    case 'MemberAdded': {
      db.query('INSERT INTO members (id, name, role, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET role = excluded.role, removed_at = NULL')
        .run(String(p.id), String(p.name), String(p.role), event.at)
      return
    }
    case 'MemberRemoved': {
      db.query('UPDATE members SET removed_at = ? WHERE id = ?').run(event.at, String(p.id))
      return
    }
    case 'TokenMinted': {
      db.query('INSERT INTO tokens (id, kind, subject_id, hash, label, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(String(p.id), String(p.kind), String(p.subjectId), String(p.hash), String(p.label ?? ''), event.at)
      return
    }
    case 'TokenRevoked': {
      db.query('UPDATE tokens SET revoked_at = ? WHERE id = ?').run(event.at, String(p.id))
      return
    }
    case 'AgentIdentityRegistered': {
      db.query(`INSERT INTO agent_identities
        (id, name, role, path_scopes_json, allowed_tools_json, max_concurrent_tasks, can_merge_without_review, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET role = excluded.role, path_scopes_json = excluded.path_scopes_json,
          allowed_tools_json = excluded.allowed_tools_json, max_concurrent_tasks = excluded.max_concurrent_tasks,
          can_merge_without_review = excluded.can_merge_without_review, removed_at = NULL`)
        .run(String(p.id), String(p.name), String(p.role), jstr(p.pathScopes), jstr(p.allowedTools),
          Number(p.maxConcurrentTasks ?? 1), p.canMergeWithoutReview ? 1 : 0, event.at)
      return
    }
    case 'AgentIdentityRemoved': {
      db.query('UPDATE agent_identities SET removed_at = ? WHERE id = ?').run(event.at, String(p.id))
      return
    }
    case 'AgentStarted': {
      db.query(`INSERT INTO agents (id, identity_id, name, role, status, started_at, last_heartbeat_at, connection_id)
        VALUES (?, ?, ?, ?, 'idle', ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET status = 'idle', connection_id = excluded.connection_id,
          last_heartbeat_at = excluded.last_heartbeat_at, stopped_at = NULL, last_error = NULL`)
        .run(String(p.id), String(p.identityId), String(p.name), String(p.role), event.at, event.at, p.connectionId == null ? null : String(p.connectionId))
      return
    }
    case 'AgentStateChanged': {
      setAgentStatus(db, String(p.id), String(p.status) as AgentStatus, {
        ...(p.currentTaskId !== undefined ? { current_task_id: p.currentTaskId == null ? null : String(p.currentTaskId) } : {}),
        ...(p.lastError !== undefined ? { last_error: p.lastError == null ? null : String(p.lastError) } : {}),
      })
      return
    }
    case 'AgentStopped': {
      db.query("UPDATE agents SET status = 'cancelled', connection_id = NULL, stopped_at = ?, current_task_id = NULL WHERE id = ?")
        .run(event.at, String(p.id))
      return
    }
    case 'AgentHeartbeat': {
      db.query('UPDATE agents SET last_heartbeat_at = ?, connection_id = COALESCE(?, connection_id) WHERE id = ?')
        .run(event.at, p.connectionId == null ? null : String(p.connectionId), String(p.id))
      return
    }
    case 'ObjectiveCreated': {
      db.query(`INSERT INTO objectives (id, workspace_id, project_id, goal, status, run_id, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'planning', ?, ?, ?, ?)`)
        .run(String(p.id), String(p.workspaceId), String(p.projectId), String(p.goal), String(p.runId),
          String(event.actorId), event.at, event.at)
      return
    }
    case 'ObjectivePlanned': {
      setObjectiveStatus(db, String(event.objectiveId), 'awaiting-approval')
      return
    }
    case 'ObjectiveStatusChanged': {
      const next = String(p.status) as ObjectiveStatus
      const extra: Row = {}
      if (next === 'active' && p.approvedBy) {
        extra.approved_by = String(p.approvedBy)
        extra.approved_at = event.at
      }
      setObjectiveStatus(db, String(event.objectiveId), next, extra)
      if (next === 'active') refreshTaskReadiness(db, String(event.objectiveId))
      return
    }
    case 'TaskCreated': {
      const depsMet = (Array.isArray(p.dependsOn) ? p.dependsOn : []).length === 0
      db.query(`INSERT INTO tasks
        (id, objective_id, project_id, title, instructions, role, status, depends_on_json, files_json, wave,
         acceptance_json, verification_json, attempt_count, max_attempts, goal_node_id, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`)
        .run(String(p.id), String(p.objectiveId), String(p.projectId), String(p.title), String(p.instructions ?? ''),
          String(p.role), depsMet ? 'ready' : 'pending', jstr(p.dependsOn), jstr(p.files),
          p.wave == null ? null : Number(p.wave), jstr(p.acceptanceCriteria), jstr(p.verificationCommands),
          Number(p.maxAttempts ?? 2), p.goalNodeId == null ? null : String(p.goalNodeId), String(event.actorId), event.at, event.at)
      return
    }
    case 'TaskStatusChanged': {
      setTaskStatus(db, String(event.taskId), String(p.status) as TaskStatus)
      return
    }
    case 'TaskAssigned': {
      setTaskStatus(db, String(event.taskId), 'assigned', {
        assignee_kind: String(p.assigneeKind), assignee_id: String(p.assigneeId),
        wave: p.wave == null ? null : Number(p.wave),
        worktree_ref: p.worktreeRef == null ? null : String(p.worktreeRef),
      })
      return
    }
    case 'TaskReassigned': {
      const row = requireTaskRow(db, String(event.taskId))
      const status = toTask(row).status
      db.query('UPDATE tasks SET assignee_kind = ?, assignee_id = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?')
        .run(String(p.assigneeKind), String(p.assigneeId), event.at, String(event.taskId))
      if (status === 'assigned' || status === 'in-progress') setTaskStatus(db, String(event.taskId), 'ready')
      return
    }
    case 'TaskStarted': {
      setTaskStatus(db, String(event.taskId), 'in-progress', {
        started_at: event.at,
        lease_owner: p.leaseOwner == null ? null : String(p.leaseOwner),
        lease_expires_at: Number(p.leaseExpiresAt ?? eventMs(event) + 120_000),
        attempt_count: Number(toTask(requireTaskRow(db, String(event.taskId))).attemptCount) + 1,
      })
      return
    }
    case 'TaskProgress': {
      db.query('UPDATE tasks SET lease_expires_at = ?, updated_at = ? WHERE id = ?')
        .run(Number(p.leaseExpiresAt ?? eventMs(event) + 120_000), event.at, String(event.taskId))
      return
    }
    case 'TaskCompleted': {
      setTaskStatus(db, String(event.taskId), 'done', {
        finished_at: event.at, lease_owner: null, lease_expires_at: null, last_error: null, review_notes: null,
        ...(p.report !== undefined ? { result_report: String(p.report) } : {}),
      })
      const task = toTask(requireTaskRow(db, String(event.taskId)))
      refreshTaskReadiness(db, task.objectiveId)
      maybeCompleteObjective(db, task.objectiveId)
      return
    }
    case 'TaskFailed': {
      setTaskStatus(db, String(event.taskId), 'failed', { lease_owner: null, lease_expires_at: null, last_error: String(p.error ?? 'task failed') })
      return
    }
    case 'TaskBlocked': {
      setTaskStatus(db, String(event.taskId), 'blocked', { last_error: String(p.reason ?? 'blocked') })
      return
    }
    case 'TaskUnblocked': {
      const task = toTask(requireTaskRow(db, String(event.taskId)))
      // Back to `pending`, then let the shared readiness pass promote it if its
      // dependencies are in fact complete. Deciding readiness inline here — and
      // only for zero-dependency tasks — stranded any task with a *satisfied*
      // ordering edge in `pending` forever, because nothing re-derives it.
      setTaskStatus(db, String(event.taskId), 'pending', { last_error: null })
      refreshTaskReadiness(db, task.objectiveId)
      return
    }
    case 'TaskCancelled': {
      setTaskStatus(db, String(event.taskId), 'cancelled', { lease_owner: null, lease_expires_at: null })
      return
    }
    case 'TaskInstructionAdded': {
      db.query("UPDATE tasks SET instructions = instructions || char(10) || char(10) || '## Added instruction' || char(10) || ?, updated_at = ? WHERE id = ?")
        .run(String(p.instruction), event.at, String(event.taskId))
      return
    }
    case 'ReviewRequested': {
      setTaskStatus(db, String(event.taskId), 'in-review', p.report !== undefined ? { result_report: String(p.report) } : {})
      return
    }
    case 'ReviewCompleted': {
      if (p.passed) {
        setTaskStatus(db, String(event.taskId), 'done', { finished_at: event.at, lease_owner: null, lease_expires_at: null })
        const task = toTask(requireTaskRow(db, String(event.taskId)))
        refreshTaskReadiness(db, task.objectiveId)
        maybeCompleteObjective(db, task.objectiveId)
      } else {
        setTaskStatus(db, String(event.taskId), 'changes-requested', { review_notes: String(p.notes ?? 'changes requested') })
      }
      return
    }
    case 'ChangesRequested': {
      setTaskStatus(db, String(event.taskId), 'changes-requested', { review_notes: String(p.notes ?? 'changes requested') })
      return
    }
    case 'FileChanged': {
      return
    }
    case 'ReservationAcquired': {
      db.query(`INSERT INTO reservations (id, resource, mode, holder_kind, holder_id, task_id, acquired_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(String(p.id), String(p.resource), String(p.mode ?? 'exclusive'), String(p.holderKind), String(p.holderId),
          String(event.taskId), Number(p.acquiredAt ?? eventMs(event)), Number(p.expiresAt ?? eventMs(event) + 120_000))
      return
    }
    case 'ReservationReleased':
    case 'ReservationExpired': {
      db.query('UPDATE reservations SET released_at = ? WHERE id = ? AND released_at IS NULL').run(eventMs(event), String(p.id))
      return
    }
    case 'ReservationRenewed': {
      // Heartbeat lease renewal. On the event spine (not a raw UPDATE) so a
      // projection rebuilt from the log keeps every renewal — otherwise every
      // live reservation reverts to its acquire-time expiry and the next
      // reconcile frees files that are still actively held.
      db.query('UPDATE reservations SET expires_at = ? WHERE id = ? AND released_at IS NULL')
        .run(Number(p.expiresAt ?? eventMs(event) + 120_000), String(p.id))
      return
    }
    case 'ConflictDetected': {
      return
    }
    case 'AgentMessageCreated': {
      db.query(`INSERT INTO agent_messages (id, seq, objective_id, from_kind, from_id, to_id, topic, kind, body, refs_json, at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(newEventId().replace('evt_', 'msg_'), event.seq, event.objectiveId ?? null, String(event.actorKind),
          String(event.actorId), p.toId == null ? null : String(p.toId), String(p.topic ?? 'general'),
          String(p.kind ?? 'info'), String(p.body ?? ''), JSON.stringify(p.refs ?? {}), event.at)
      return
    }
    case 'DecisionRecorded': {
      db.query(`INSERT INTO decisions (id, objective_id, title, detail, decided_by_kind, decided_by_id, at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(newEventId().replace('evt_', 'dec_'), String(event.objectiveId), String(p.title), String(p.detail ?? ''),
          String(event.actorKind), String(event.actorId), event.at)
      return
    }
    case 'CommentPosted': {
      return
    }
    case 'ApprovalRequired': {
      db.query(`INSERT INTO approvals (id, kind, subject, objective_id, task_id, status, reason, requested_at)
        VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`)
        .run(String(p.id), String(p.kind), String(p.subject), event.objectiveId ?? null, event.taskId ?? null,
          p.reason == null ? null : String(p.reason), event.at)
      return
    }
    case 'ApprovalGranted':
    case 'ApprovalRejected': {
      db.query('UPDATE approvals SET status = ?, resolved_by = ?, resolved_at = ?, reason = COALESCE(?, reason) WHERE id = ?')
        .run(event.type === 'ApprovalGranted' ? 'granted' : 'rejected', String(event.actorId), event.at,
          p.reason == null ? null : String(p.reason), String(p.id))
      return
    }
    case 'PresenceJoined': {
      db.query(`INSERT INTO presence (connection_id, subject_kind, subject_id, name, focus, connected_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(connection_id) DO UPDATE SET last_seen_at = excluded.last_seen_at, focus = excluded.focus`)
        .run(String(p.connectionId), String(p.subjectKind), String(p.subjectId), String(p.name),
          p.focus == null ? null : String(p.focus), event.at, event.at)
      return
    }
    case 'PresenceUpdated': {
      db.query('UPDATE presence SET focus = ?, last_seen_at = ? WHERE connection_id = ?')
        .run(p.focus == null ? null : String(p.focus), event.at, String(p.connectionId))
      return
    }
    case 'PresenceLeft': {
      db.query('DELETE FROM presence WHERE connection_id = ?').run(String(p.connectionId))
      return
    }
    default: {
      const exhaustive: never = event.type
      throw new Error(`unhandled workspace event ${String(exhaustive)}`)
    }
  }
}

/** An objective goes `completed` once every one of its tasks is `done` or `cancelled`. */
function maybeCompleteObjective(db: Database, objectiveId: string): void {
  const open = db.query(
    "SELECT COUNT(*) AS n FROM tasks WHERE objective_id = ? AND status NOT IN ('done','cancelled')",
  ).get(objectiveId) as Row
  const total = db.query('SELECT COUNT(*) AS n FROM tasks WHERE objective_id = ?').get(objectiveId) as Row
  if (Number(total.n) > 0 && Number(open.n) === 0) {
    const row = db.query('SELECT status FROM objectives WHERE id = ?').get(objectiveId) as Row | null
    if (row && objectiveCanTransition(String(row.status) as ObjectiveStatus, 'completed')) {
      db.query('UPDATE objectives SET status = ?, updated_at = ? WHERE id = ?').run('completed', nowIso(), objectiveId)
    }
  }
}
