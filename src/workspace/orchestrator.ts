/**
 * The orchestration reactor.
 *
 * It watches the event spine and, on anything that could change what is runnable
 * (approval, completion, an agent connecting, a lease expiring), recomputes the
 * dispatchable set and assigns tasks:
 *
 *   ready task  ->  an idle, connected, in-scope agent of the right role
 *               ->  reserve its files  ->  TaskAssigned + AgentStateChanged
 *
 * Dependencies are already encoded as `pending` vs `ready` by the projection;
 * file collisions are caught by the reservation ledger; role and path scope are
 * checked against the agent's service identity. Failures come back as
 * `TaskFailed` and are retried, reassigned, or escalated to a human here.
 *
 * One instance runs inside the workspace server, bound to its store.
 */

import { posix } from 'node:path'
import { randomUUID } from 'node:crypto'
import { classifyFailure } from '../autonomy/goalGraph.ts'
import { acquireForTask, reconcileReservations, releaseForTask } from './reservations.ts'
import { REVIEWER_ROLES } from './rpcAgents.ts'
import type { WorkspaceStore } from './store.ts'
import type { PersistedEvent } from './events.ts'
import type { AgentRecord, TaskRecord } from './types.ts'
import type { RoleName } from '../autonomy/types.ts'

const BUILDER_COVERS: RoleName[] = ['builder', 'frontend', 'backend', 'polisher', 'scribe', 'tester']

const REACT_TO = new Set<PersistedEvent['type']>([
  'ObjectiveStatusChanged', 'TaskCreated', 'TaskCompleted', 'TaskFailed', 'TaskUnblocked',
  'TaskStatusChanged', 'ReviewCompleted', 'AgentStarted', 'AgentStateChanged', 'AgentStopped',
  'ReservationReleased', 'ReservationExpired', 'ApprovalGranted',
])

export interface OrchestratorOptions {
  store: WorkspaceStore
  /** Ceiling on tasks in `assigned` + `in-progress` across the whole workspace. */
  maxConcurrentDispatch?: number
  /** Poll cadence as a safety net behind the event-driven ticks. */
  sweepMs?: number
}

export class Orchestrator {
  private readonly store: WorkspaceStore
  private readonly maxConcurrent: number
  private readonly sweepMs: number
  private unsubscribe: (() => void) | undefined
  private sweepTimer: ReturnType<typeof setInterval> | undefined
  private ticking = false
  private tickQueued = false

  constructor(options: OrchestratorOptions) {
    this.store = options.store
    this.maxConcurrent = Math.max(1, options.maxConcurrentDispatch ?? 8)
    this.sweepMs = Math.max(1_000, options.sweepMs ?? 5_000)
  }

  start(): void {
    this.unsubscribe = this.store.subscribe((event) => {
      if (event.actorId === 'orchestrator') return
      if (REACT_TO.has(event.type)) this.scheduleTick()
    })
    this.sweepTimer = setInterval(() => this.scheduleTick(), this.sweepMs)
    this.scheduleTick()
  }

  stop(): void {
    this.unsubscribe?.()
    if (this.sweepTimer) clearInterval(this.sweepTimer)
  }

  private scheduleTick(): void {
    if (this.ticking) {
      this.tickQueued = true
      return
    }
    queueMicrotask(() => this.runTick())
  }

  private runTick(): void {
    if (this.ticking) {
      this.tickQueued = true
      return
    }
    this.ticking = true
    try {
      this.tick()
    } catch {
      // A tick failure must not kill the reactor; the next event or sweep retries.
    } finally {
      this.ticking = false
      if (this.tickQueued) {
        this.tickQueued = false
        this.scheduleTick()
      }
    }
  }

  /** One reconciliation pass. Public for tests and for the server's manual sweep. */
  tick(now = Date.now()): void {
    reconcileReservations(this.store, now)
    this.reconcileAgents()
    this.handleFailures(now)
    this.requeueRevisions()

    const objectives = this.store.objectives().filter((objective) => objective.status === 'active')
    if (objectives.length === 0) return

    const idleAgents = this.store.agents().filter((agent) => agent.status === 'idle' && agent.connectionId)

    // Pass 1 — route in-review tasks to a reviewer. Read-only, no reservation,
    // never counted against the dispatch ceiling, so it runs for every objective
    // before any dispatch: a saturated objective earlier in the list must not
    // starve a later one's reviews.
    for (const objective of objectives) {
      for (const task of this.store.tasks({ objectiveId: objective.id, status: 'in-review' })) {
        if (task.assigneeId && this.store.agent(task.assigneeId)?.status === 'reviewing') continue
        const reviewer = idleAgents.find((agent) => {
          const identity = this.store.agentIdentity(agent.identityId)
          return identity && REVIEWER_ROLES.has(identity.role)
        })
        if (!reviewer) continue
        // TaskReassigned keeps the in-review status (unlike TaskAssigned).
        this.store.append({
          type: 'TaskReassigned', actorKind: 'system', actorId: 'orchestrator',
          objectiveId: objective.id, taskId: task.id,
          payload: { assigneeKind: 'agent', assigneeId: reviewer.id },
        })
        this.store.append({ type: 'AgentStateChanged', actorKind: 'system', actorId: 'orchestrator', payload: { id: reviewer.id, status: 'assigned', currentTaskId: task.id } })
        idleAgents.splice(idleAgents.indexOf(reviewer), 1)
      }
    }

    // Pass 2 — dispatch ready work up to the concurrency ceiling. `break`, not
    // `return`: hitting the ceiling inside one objective must not abandon the
    // objectives after it (they may free up within this same tick as reviews
    // complete, and a later sweep is not guaranteed to reach them first).
    let inFlight = this.store.tasks({ status: ['assigned', 'in-progress'] }).length
    for (const objective of objectives) {
      if (inFlight >= this.maxConcurrent) break

      const ready = this.store.tasks({ objectiveId: objective.id, status: 'ready' })
        .sort((a, b) => (a.wave ?? 99) - (b.wave ?? 99) || a.createdAt.localeCompare(b.createdAt))

      for (const task of ready) {
        if (inFlight >= this.maxConcurrent) break
        const agent = this.pickAgent(task, idleAgents)
        if (!agent) continue

        const reservation = acquireForTask(this.store, {
          taskId: task.id, objectiveId: objective.id, holderKind: 'agent', holderId: agent.id,
          resources: task.files, now,
        })
        if ('conflicts' in reservation) {
          this.maybeReportConflict(task, reservation.conflicts)
          continue
        }

        this.store.append({
          type: 'TaskAssigned', actorKind: 'system', actorId: 'orchestrator',
          objectiveId: objective.id, taskId: task.id,
          payload: { assigneeKind: 'agent', assigneeId: agent.id, wave: task.wave },
        })
        this.store.append({
          type: 'AgentStateChanged', actorKind: 'system', actorId: 'orchestrator',
          payload: { id: agent.id, status: 'assigned', currentTaskId: task.id },
        })
        idleAgents.splice(idleAgents.indexOf(agent), 1)
        inFlight += 1
      }
    }
  }

  private pickAgent(task: TaskRecord, idleAgents: AgentRecord[]): AgentRecord | undefined {
    return idleAgents.find((agent) => {
      const identity = this.store.agentIdentity(agent.identityId)
      if (!identity) return false
      if (!roleMatches(identity.role as RoleName, task.role)) return false
      return filesWithinScopes(task.files, identity.pathScopes)
    })
  }

  private maybeReportConflict(task: TaskRecord, conflicts: { resource: string; taskId: string }[]): void {
    // Only surface a conflict when the blocking task is itself active work the
    // planner failed to order — not the ordinary "another wave holds it" case.
    for (const conflict of conflicts) {
      const other = this.store.task(conflict.taskId)
      if (!other || (other.status !== 'in-progress' && other.status !== 'assigned')) continue
      if (task.dependsOn.includes(other.id) || other.dependsOn.includes(task.id)) continue
      const already = this.store.events({ types: ['ConflictDetected'], objectiveId: task.objectiveId })
        .some((event) => event.taskId === task.id && event.payload.withTaskId === other.id)
      if (already) continue
      this.store.append({
        type: 'ConflictDetected', actorKind: 'system', actorId: 'orchestrator',
        objectiveId: task.objectiveId, taskId: task.id,
        payload: { resource: conflict.resource, withTaskId: other.id, detail: `tasks ${task.id} and ${other.id} both claim ${conflict.resource} with no ordering between them` },
      })
    }
  }

  /** Free an agent whose task already reached a terminal or re-queued state. */
  private reconcileAgents(): void {
    const busy = new Set(['assigned', 'planning', 'working', 'waiting', 'reviewing'])
    for (const agent of this.store.agents()) {
      if (!busy.has(agent.status) || !agent.currentTaskId) continue
      const task = this.store.task(agent.currentTaskId)
      const stillOurs = task && task.assigneeId === agent.id && (task.status === 'assigned' || task.status === 'in-progress' || task.status === 'in-review')
      if (!stillOurs) {
        this.store.append({
          type: 'AgentStateChanged', actorKind: 'system', actorId: 'orchestrator',
          payload: { id: agent.id, status: 'idle', currentTaskId: null },
        })
      }
    }
  }

  /** A task a reviewer sent back re-enters the queue with the review notes attached. */
  private requeueRevisions(): void {
    for (const task of this.store.tasks({ status: 'changes-requested' })) {
      this.store.append({
        type: 'TaskStatusChanged', actorKind: 'system', actorId: 'orchestrator',
        objectiveId: task.objectiveId, taskId: task.id, payload: { status: 'ready' },
      })
      this.store.append({
        type: 'AgentMessageCreated', actorKind: 'system', actorId: 'orchestrator', objectiveId: task.objectiveId, taskId: task.id,
        payload: { topic: `task:${task.id}`, kind: 'warning', body: `review sent "${task.title}" back: ${(task.reviewNotes ?? '').slice(0, 400)}`, refs: { taskId: task.id } },
      })
    }
  }

  private handleFailures(now = Date.now()): void {
    for (const task of this.store.tasks({ status: 'failed' })) {
      releaseForTask(this.store, task.id, 'orchestrator')
      const failure = classifyFailure(task.lastError ?? 'task failed', { source: 'report' })
      const canRetry = failure.class === 'retryable' && task.attemptCount < task.maxAttempts
      // Free the agent that was on it.
      const agent = this.store.agents().find((candidate) => candidate.currentTaskId === task.id)
      if (agent && agent.status !== 'idle') {
        this.store.append({ type: 'AgentStateChanged', actorKind: 'system', actorId: 'orchestrator', payload: { id: agent.id, status: 'idle', currentTaskId: null } })
      }
      if (canRetry) {
        // Some failures — a rate limit above all — describe the next few seconds,
        // not the request. Requeuing instantly burns one of the task's few
        // attempts against a wall that has not moved. Wait out the delay the
        // failure classifier worked out; `task.updatedAt` is the TaskFailed
        // projection time, and the periodic sweep revisits.
        const retryAfter = failure.retryAfter ?? 0
        if (retryAfter > 0) {
          const readyAt = Date.parse(task.updatedAt) + retryAfter
          if (Number.isFinite(readyAt) && now < readyAt) continue
        }
        this.store.append({
          type: 'TaskStatusChanged', actorKind: 'system', actorId: 'orchestrator',
          objectiveId: task.objectiveId, taskId: task.id, payload: { status: 'ready' },
        })
        this.store.append({
          type: 'AgentMessageCreated', actorKind: 'system', actorId: 'orchestrator', objectiveId: task.objectiveId, taskId: task.id,
          payload: { topic: `task:${task.id}`, kind: 'warning', body: `retrying ${task.title} after: ${task.lastError?.slice(0, 300) ?? 'failure'}`, refs: { taskId: task.id } },
        })
      } else {
        this.escalate(task, failure.class)
      }
    }
  }

  private escalate(task: TaskRecord, failureClass: string): void {
    const open = this.store.approvals('pending').some((approval) => approval.kind === 'review' && approval.taskId === task.id)
    if (open) return
    this.store.append({
      type: 'ApprovalRequired', actorKind: 'system', actorId: 'orchestrator',
      objectiveId: task.objectiveId, taskId: task.id,
      payload: {
        id: `apr_${randomUUID().replaceAll('-', '')}`, kind: 'review', subject: task.id,
        reason: `task "${task.title}" needs a human — ${failureClass} failure after ${task.attemptCount} attempt(s): ${task.lastError?.slice(0, 400) ?? 'no detail'}`,
      },
    })
  }
}

export function roleMatches(identityRole: RoleName, taskRole: RoleName): boolean {
  if (identityRole === taskRole) return true
  if (identityRole === 'builder') return BUILDER_COVERS.includes(taskRole)
  return false
}

export function filesWithinScopes(files: string[], scopes: string[]): boolean {
  if (scopes.length === 0) return true
  if (files.length === 0) return true
  return files.every((file) => scopes.some((scope) => fileMatchesGlob(normalize(file), normalize(scope))))
}

function normalize(value: string): string {
  return posix.normalize(value.replace(/\\/g, '/')).replace(/^\.\//, '')
}

/** Minimal glob: `**` spans path segments, `*` spans one segment. */
function fileMatchesGlob(file: string, glob: string): boolean {
  if (!glob.includes('*')) return file === glob || file.startsWith(`${glob}/`)
  const pattern = glob
    .split('/')
    .map((segment) => segment === '**' ? '.*' : segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'))
    .join('/')
    .replace(/\.\*\//g, '(?:.*/)?')
  return new RegExp(`^${pattern}$`).test(file)
}
