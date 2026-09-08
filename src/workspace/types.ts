/**
 * Domain vocabulary for the multi-user, multi-agent collaborative workspace.
 *
 * A workspace is a shared, durable project context that many humans and many
 * autonomous agents work inside at once. Everything is event-sourced: the
 * `workspace_events` table is the append-only spine (see store.ts / events.ts),
 * and every row here is a *projection* the store keeps in step with that spine
 * inside one transaction.
 *
 * The finite-state-machine transition tables in this file are the single source
 * of truth for what a status change is allowed to be — `applyEvent` in events.ts
 * rejects any transition not listed here rather than trusting the caller.
 */

import type { RoleName } from '../autonomy/types.ts'

// --- Members, agents, permissions ---

/** A human participant's authority level within a workspace. */
export type MemberRole = 'owner' | 'maintainer' | 'contributor' | 'viewer'

export const MEMBER_ROLES: MemberRole[] = ['owner', 'maintainer', 'contributor', 'viewer']

export function isMemberRole(value: unknown): value is MemberRole {
  return typeof value === 'string' && (MEMBER_ROLES as string[]).includes(value)
}

/**
 * A single permission checked on the RPC surface. A capability is coarse on
 * purpose — it gates a *kind* of action, not a specific resource; resource-level
 * scoping (which files an agent may touch) lives on the agent identity.
 */
export type Capability =
  | 'view'
  | 'comment'
  | 'create_objective'
  | 'approve_plan'
  | 'create_task'
  | 'assign_task'
  | 'reassign_task'
  | 'review_ai_work'
  | 'control_agent'
  | 'manage_agents'
  | 'manage_members'

export const ALL_CAPABILITIES: Capability[] = [
  'view', 'comment', 'create_objective', 'approve_plan', 'create_task', 'assign_task',
  'reassign_task', 'review_ai_work', 'control_agent', 'manage_agents', 'manage_members',
]

/**
 * Role → capability set. Higher roles are supersets of lower ones, but that is a
 * property of this table, not something the checker assumes.
 */
export const CAPABILITIES_BY_ROLE: Record<MemberRole, ReadonlySet<Capability>> = {
  viewer: new Set(['view']),
  contributor: new Set(['view', 'comment', 'create_objective', 'create_task', 'assign_task', 'review_ai_work']),
  maintainer: new Set([
    'view', 'comment', 'create_objective', 'create_task', 'assign_task', 'reassign_task',
    'approve_plan', 'review_ai_work', 'control_agent', 'manage_agents',
  ]),
  owner: new Set(ALL_CAPABILITIES),
}

export function roleHasCapability(role: MemberRole, capability: Capability): boolean {
  return CAPABILITIES_BY_ROLE[role].has(capability)
}

// --- Records (projections of the event spine) ---

export interface WorkspaceRecord {
  id: string
  name: string
  defaultProjectId: string
  createdAt: string
}

export interface ProjectRecord {
  id: string
  workspaceId: string
  name: string
  /** Absolute path to the git repository this project's agents work in. */
  repoRoot: string
  branch: string
  createdAt: string
}

export interface MemberRecord {
  id: string
  name: string
  role: MemberRole
  createdAt: string
  removedAt?: string
}

export type TokenKind = 'member' | 'agent'

export interface TokenRecord {
  id: string
  kind: TokenKind
  /** Member id or agent-identity id. */
  subjectId: string
  /** sha256 of the plaintext token; the plaintext is shown once at mint and never stored. */
  hash: string
  label: string
  createdAt: string
  lastUsedAt?: string
  revokedAt?: string
}

/**
 * A service identity for an autonomous agent. This is the *contract* an agent
 * runs under — which role it may take, which files it may touch, how many tasks
 * it may hold — registered once and reused every time a runtime attaches.
 */
export interface AgentIdentityRecord {
  id: string
  name: string
  role: RoleName
  /** Glob patterns the agent's file tools are confined to. Empty = the whole project tree. */
  pathScopes: string[]
  /** Tool-name allowlist intersected with the role's own allowlist. Empty = the role's full set. */
  allowedTools: string[]
  maxConcurrentTasks: number
  /** When false (default), the agent's work always lands in a review task before merge. */
  canMergeWithoutReview: boolean
  createdAt: string
  removedAt?: string
}

/** A live agent runtime instance bound to an identity. */
export type AgentStatus =
  | 'idle'
  | 'assigned'
  | 'planning'
  | 'working'
  | 'waiting'
  | 'reviewing'
  | 'completed'
  | 'blocked'
  | 'failed'
  | 'paused'
  | 'cancelled'
  | 'needs-human'

export const AGENT_STATUSES: AgentStatus[] = [
  'idle', 'assigned', 'planning', 'working', 'waiting', 'reviewing',
  'completed', 'blocked', 'failed', 'paused', 'cancelled', 'needs-human',
]

/**
 * Allowed agent status transitions. The happy path is
 * idle→assigned→planning→working→waiting→reviewing→completed→idle; the rest are
 * interventions (pause/resume/stop) and failure edges.
 */
export const AGENT_TRANSITIONS: Record<AgentStatus, AgentStatus[]> = {
  idle: ['assigned', 'reviewing', 'cancelled', 'paused'],
  assigned: ['planning', 'working', 'reviewing', 'idle', 'paused', 'cancelled', 'failed'],
  planning: ['working', 'waiting', 'idle', 'blocked', 'failed', 'paused', 'cancelled', 'needs-human'],
  working: ['waiting', 'reviewing', 'completed', 'idle', 'blocked', 'failed', 'paused', 'cancelled', 'needs-human'],
  waiting: ['working', 'reviewing', 'idle', 'blocked', 'failed', 'paused', 'cancelled', 'needs-human'],
  reviewing: ['completed', 'working', 'idle', 'blocked', 'failed', 'paused', 'cancelled', 'needs-human'],
  completed: ['idle'],
  blocked: ['idle', 'working', 'failed', 'cancelled', 'needs-human'],
  failed: ['idle', 'cancelled'],
  paused: ['idle', 'assigned', 'working', 'cancelled'],
  cancelled: ['idle'],
  'needs-human': ['idle', 'working', 'cancelled', 'failed'],
}

export function agentCanTransition(from: AgentStatus, to: AgentStatus): boolean {
  return from === to || (AGENT_TRANSITIONS[from]?.includes(to) ?? false)
}

export interface AgentRecord {
  id: string
  identityId: string
  name: string
  role: RoleName
  status: AgentStatus
  currentTaskId?: string
  /** Set while a runtime's connection is open; cleared on disconnect. */
  connectionId?: string
  startedAt: string
  lastHeartbeatAt: string
  stoppedAt?: string
  lastError?: string
}

// --- Objectives and tasks ---

export type ObjectiveStatus =
  | 'planning'
  | 'awaiting-approval'
  | 'active'
  | 'blocked'
  | 'completed'
  | 'rejected'
  | 'cancelled'

export const OBJECTIVE_TRANSITIONS: Record<ObjectiveStatus, ObjectiveStatus[]> = {
  planning: ['awaiting-approval', 'cancelled', 'rejected'],
  'awaiting-approval': ['active', 'rejected', 'cancelled', 'planning'],
  active: ['blocked', 'completed', 'cancelled'],
  blocked: ['active', 'cancelled'],
  completed: [],
  rejected: ['planning'],
  cancelled: [],
}

export function objectiveCanTransition(from: ObjectiveStatus, to: ObjectiveStatus): boolean {
  return from === to || (OBJECTIVE_TRANSITIONS[from]?.includes(to) ?? false)
}

export interface ObjectiveRecord {
  id: string
  workspaceId: string
  projectId: string
  goal: string
  status: ObjectiveStatus
  /** The run id of the durable GoalGraph seeded from this objective's proposal. */
  runId: string
  createdBy: string
  createdAt: string
  updatedAt: string
  approvedBy?: string
  approvedAt?: string
}

export type TaskStatus =
  | 'pending'
  | 'ready'
  | 'assigned'
  | 'in-progress'
  | 'blocked'
  | 'in-review'
  | 'changes-requested'
  | 'done'
  | 'failed'
  | 'cancelled'

export const TASK_STATUSES: TaskStatus[] = [
  'pending', 'ready', 'assigned', 'in-progress', 'blocked', 'in-review',
  'changes-requested', 'done', 'failed', 'cancelled',
]

/**
 * Allowed task status transitions. `pending` means dependencies are unmet;
 * `ready` means schedulable; the orchestrator drives ready→assigned→in-progress,
 * and reviews add the in-review / changes-requested loop.
 */
export const TASK_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  pending: ['ready', 'blocked', 'cancelled'],
  ready: ['assigned', 'blocked', 'cancelled', 'pending'],
  assigned: ['in-progress', 'ready', 'blocked', 'failed', 'cancelled'],
  'in-progress': ['in-review', 'done', 'blocked', 'failed', 'changes-requested', 'ready', 'cancelled'],
  blocked: ['ready', 'pending', 'failed', 'cancelled'],
  'in-review': ['done', 'changes-requested', 'failed', 'cancelled'],
  'changes-requested': ['ready', 'assigned', 'in-progress', 'cancelled'],
  done: ['changes-requested'],
  failed: ['ready', 'cancelled'],
  cancelled: [],
}

export function taskCanTransition(from: TaskStatus, to: TaskStatus): boolean {
  return from === to || (TASK_TRANSITIONS[from]?.includes(to) ?? false)
}

/** Task statuses that still represent outstanding work for the objective. */
export const OPEN_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  'pending', 'ready', 'assigned', 'in-progress', 'blocked', 'in-review', 'changes-requested',
])

export type AssigneeKind = 'agent' | 'member'

export interface TaskRecord {
  id: string
  objectiveId: string
  projectId: string
  title: string
  instructions: string
  role: RoleName
  status: TaskStatus
  assigneeKind?: AssigneeKind
  assigneeId?: string
  /** Task ids that must reach `done` before this one becomes `ready`. */
  dependsOn: string[]
  /** Repo-relative paths this task expects to own — drives collision-free wave planning. */
  files: string[]
  /** One-based dependency wave, filled by the scheduler at dispatch time. */
  wave?: number
  acceptanceCriteria: string[]
  verificationCommands: string[]
  attemptCount: number
  maxAttempts: number
  /** Node id inside the objective's GoalGraph, when this task came from decomposition. */
  goalNodeId?: string
  /** Branch name of the worktree an agent is using for this task. */
  worktreeRef?: string
  leaseOwner?: string
  leaseExpiresAt?: number
  createdBy: string
  createdAt: string
  updatedAt: string
  startedAt?: string
  finishedAt?: string
  lastError?: string
  /** Set by a review verdict; the agent must clear these before re-completing. */
  reviewNotes?: string
  /** The completing agent's final report — fed to dependent tasks as scoped context. */
  resultReport?: string
}

// --- Coordination: reservations, messages, decisions, approvals, presence ---

export type ReservationMode = 'exclusive' | 'shared'

export interface ReservationRecord {
  id: string
  /** `path:<glob>`, `component:<name>`, or `task:<id>`. */
  resource: string
  mode: ReservationMode
  holderKind: AssigneeKind
  holderId: string
  taskId: string
  acquiredAt: number
  expiresAt: number
  releasedAt?: number
}

export type AgentMessageKind = 'info' | 'question' | 'claim' | 'handoff' | 'warning' | 'blocker'

export const AGENT_MESSAGE_KINDS: AgentMessageKind[] = ['info', 'question', 'claim', 'handoff', 'warning', 'blocker']

export interface AgentMessageRecord {
  id: string
  seq: number
  objectiveId?: string
  fromKind: AssigneeKind
  fromId: string
  /** Agent or member id this is addressed to; absent = broadcast to the objective. */
  toId?: string
  topic: string
  kind: AgentMessageKind
  body: string
  refs: { taskId?: string; filePath?: string; eventSeq?: number }
  at: string
}

export interface DecisionRecord {
  id: string
  objectiveId: string
  title: string
  detail: string
  decidedByKind: AssigneeKind
  decidedById: string
  at: string
}

export type ApprovalKind = 'plan' | 'action' | 'review' | 'merge'
export type ApprovalStatus = 'pending' | 'granted' | 'rejected'

export interface ApprovalRecord {
  id: string
  kind: ApprovalKind
  /** Objective, task, or action key this approval guards. */
  subject: string
  objectiveId?: string
  taskId?: string
  status: ApprovalStatus
  reason?: string
  requestedAt: string
  resolvedBy?: string
  resolvedAt?: string
}

export interface PresenceRecord {
  connectionId: string
  subjectKind: AssigneeKind
  subjectId: string
  name: string
  /** Free-text "what I'm looking at", e.g. "Authentication" or a task id. */
  focus?: string
  connectedAt: string
  lastSeenAt: string
}

// --- Shared limits ---

export const LEASE_TTL_MS = 120_000
export const HEARTBEAT_INTERVAL_MS = 30_000
export const MAX_GOAL_LENGTH = 10_000
export const MAX_INSTRUCTION_LENGTH = 20_000
export const MAX_MESSAGE_BODY_LENGTH = 8_000
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/
