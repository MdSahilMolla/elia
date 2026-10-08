/**
 * Who is allowed to write which event, once a workspace has more than one node.
 *
 * Elia was strictly single-writer regardless of how many people and agents were
 * connected, and the two-node design breaks that: the second machine is a real
 * writer. Writing the same objective from both machines would corrupt the
 * tamper-evident audit chain, because `appendAudit` reads the current head as
 * `prevHash` — two concurrent appends read the same head, and the chain then
 * verifies as *tampered* when it is merely interleaved.
 *
 * So authorship is partitioned, and every event falls into exactly one of four
 * classes:
 *
 * | Class        | Writer rule |
 * | ------------ | ----------- |
 * | `owner`      | the objective's owner node (or, for workspace-level facts, the workspace's owner node) |
 * | `executor`   | the node holding an unreleased grant for that task |
 * | `coordination` | either node; carries `actorNode` so a reader can attribute it |
 * | `local`      | this process only, and never replicated |
 *
 * The classification is data rather than scattered `if` statements so the guard
 * in `store.append`, the replication filter, and the tests all read the same
 * table. A new event type that is not listed here fails loudly in `classifyEvent`
 * rather than defaulting to "anyone may write this".
 */

import type { WorkspaceEventType } from './events.ts'

export type EventAuthority = 'owner' | 'executor' | 'coordination' | 'local'

/**
 * Owner-authoritative: the plan and everything that shapes it. The objective's
 * owner node is the only writer, which is what makes its local order a valid
 * total order for the audit chain.
 *
 * `TaskStatusChanged` belongs here rather than with the executor events even
 * though it names a task: it is the control plane moving a task's status (the
 * lease reconciler returning an expired lease to `ready`, an admin cancelling or
 * reopening), not a running process reporting on its own work. That is
 * `TaskProgress` / `TaskCompleted` / `TaskFailed`, which are executor-scoped.
 * Putting it here also keeps lease recovery single-writer, which is what stops
 * two nodes reconciling the same expired task into contradictory states.
 */
const OWNER_EVENTS: ReadonlySet<WorkspaceEventType> = new Set([
  'ObjectiveCreated', 'ObjectivePlanned', 'ObjectiveStatusChanged',
  'TaskCreated', 'TaskStatusChanged', 'TaskAssigned', 'TaskReassigned',
  'TaskBlocked', 'TaskUnblocked', 'TaskCancelled', 'TaskInstructionAdded',
  'ReviewRequested', 'ReviewCompleted', 'ChangesRequested',
  'ReservationAcquired', 'ReservationReleased', 'ReservationExpired', 'ReservationRenewed',
  'ApprovalRequired', 'ApprovalGranted', 'ApprovalRejected',
  'DecisionRecorded',
  'WorkspaceCreated', 'MemberAdded', 'MemberRemoved',
  'TokenMinted', 'TokenRevoked',
  'AgentIdentityRegistered', 'AgentIdentityRemoved',
])

/**
 * Executor-scoped: writing the record of one task actually running.
 *
 * Agent events carry no task, so they are checked against the agent's own node
 * instead — an agent is a process on a machine, and only that machine may report
 * what it is doing. That is a refinement of the design note's wording, which
 * grouped them under "the node holding an active grant for that task"; there is
 * no task to name for `AgentStarted`.
 */
const EXECUTOR_EVENTS: ReadonlySet<WorkspaceEventType> = new Set([
  'TaskStarted', 'TaskProgress', 'TaskCompleted', 'TaskFailed',
  'AgentStarted', 'AgentStateChanged', 'AgentStopped', 'AgentHeartbeat',
])

/** Either node may write these; `actorNode` says which. */
const COORDINATION_EVENTS: ReadonlySet<WorkspaceEventType> = new Set([
  'FileChanged', 'ConflictDetected', 'AgentMessageCreated', 'CommentPosted',
  'NodeRegistered', 'NodeHeartbeat',
])

/**
 * Process-local: this machine's WebSocket connections. Never replicated, because
 * the other machine's connections mean nothing here — that is why node-level
 * presence exists alongside it (design note §6.3).
 */
const LOCAL_EVENTS: ReadonlySet<WorkspaceEventType> = new Set([
  'PresenceJoined', 'PresenceUpdated', 'PresenceLeft',
])

/** Events that name a task, and so resolve their authority against a grant. */
const TASK_SCOPED: ReadonlySet<WorkspaceEventType> = new Set([
  'TaskStarted', 'TaskProgress', 'TaskCompleted', 'TaskFailed',
])

/** Events naming an agent, and so resolve their authority against that agent's node. */
const AGENT_SCOPED: ReadonlySet<WorkspaceEventType> = new Set([
  'AgentStarted', 'AgentStateChanged', 'AgentStopped', 'AgentHeartbeat',
])

export function classifyEvent(type: WorkspaceEventType): EventAuthority {
  if (LOCAL_EVENTS.has(type)) return 'local'
  if (COORDINATION_EVENTS.has(type)) return 'coordination'
  if (EXECUTOR_EVENTS.has(type)) return 'executor'
  if (OWNER_EVENTS.has(type)) return 'owner'
  throw new Error(`event type ${type} has no authority class — add it to src/workspace/authority.ts`)
}

/** Whether the authority check for this event resolves against a task grant. */
export function isTaskScoped(type: WorkspaceEventType): boolean {
  return TASK_SCOPED.has(type)
}

/** Whether the authority check for this event resolves against the agent's node. */
export function isAgentScoped(type: WorkspaceEventType): boolean {
  return AGENT_SCOPED.has(type)
}

/**
 * Whether an event of this type ever crosses to the other node.
 *
 * `local` is the only class that does not, and that is the whole reason
 * connection-scoped presence is not replicated: "this WebSocket is open" is a
 * fact about one process, and forwarding it would have the peer show a stranger
 * as online.
 */
export function isReplicated(type: WorkspaceEventType): boolean {
  return classifyEvent(type) !== 'local'
}

/**
 * The agent id an agent-scoped event names, or undefined when the event does not
 * name one. `AgentStarted` carries it as `id`; the rest carry it as `id` too.
 */
export function agentIdOf(payload: Record<string, unknown>): string | undefined {
  const id = payload['id']
  return typeof id === 'string' && id !== '' ? id : undefined
}