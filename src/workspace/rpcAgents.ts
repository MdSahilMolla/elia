/**
 * RPC handlers for an agent runtime and for human interventions on agents.
 *
 * A runtime authenticates with its service token (an {@link AgentCaller}),
 * announces itself with `agent.connect`, then drives one task at a time:
 * `agent.claim` -> work -> `agent.progress` (heartbeat) -> `agent.complete`.
 * The orchestrator, reacting to the events these append, does the assigning.
 *
 * Humans use `task.assign` / `task.reassign` / `task.instruct` and
 * `agent.control` (pause / resume / stop) / `agent.explain`.
 */

import { RpcError, type RpcContext } from './rpc.ts'
import { requireAgent, requireCapability } from './identity.ts'
import { buildContextPack } from './coordination.ts'
import { releaseForTask, renewForTask } from './reservations.ts'
import { LEASE_TTL_MS, type AgentStatus } from './types.ts'
import type { WorkspaceRpcMethod } from './protocol.ts'

type Params = Record<string, unknown>

/** Agent runtime instance id derived 1:1 from its service identity (one runtime per identity for now). */
export function agentInstanceId(identityId: string): string {
  return `agt_${identityId.replace(/^aid_/, '')}`
}

function reqStr(params: Params, key: string, max = 8_000): string {
  const value = params[key]
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new RpcError(`${key} must be a non-empty string of at most ${max} characters`)
  return value.trim()
}

function optStr(params: Params, key: string, max = 8_000): string | undefined {
  return params[key] === undefined || params[key] === null || params[key] === '' ? undefined : reqStr(params, key, max)
}

export async function dispatchAgentRpc(
  ctx: RpcContext,
  method: WorkspaceRpcMethod,
  params: Params,
): Promise<unknown> {
  const { store, caller } = ctx

  switch (method) {
    case 'agent.connect': {
      const agent = requireAgent(caller)
      const identity = store.agentIdentity(agent.id)
      if (!identity || identity.removedAt) throw new RpcError('this agent identity has been removed')
      const id = agentInstanceId(agent.id)
      store.append({
        type: 'AgentStarted', actorKind: 'agent', actorId: agent.id,
        payload: { id, identityId: agent.id, name: agent.name, role: agent.role, connectionId: ctx.connectionId },
      })
      return { agentId: id, identity }
    }

    case 'agent.claim': {
      const agent = requireAgent(caller)
      const id = agentInstanceId(agent.id)
      const instance = store.agent(id)
      if (!instance) throw new RpcError('call agent.connect before agent.claim')
      if (instance.status === 'paused') throw new RpcError('this agent is paused')
      // A build task the orchestrator assigned, or a review job (an in-review
      // task the orchestrator routed to this reviewer).
      const task = store.tasks({ status: ['assigned', 'in-review'] }).find((candidate) => candidate.assigneeId === id)
      if (!task) return { task: null }

      store.append({ type: 'AgentStateChanged', actorKind: 'agent', actorId: agent.id, payload: { id, status: task.status === 'in-review' ? 'reviewing' : 'working', currentTaskId: task.id } })
      if (task.status === 'assigned') {
        store.append({
          type: 'TaskStarted', actorKind: 'agent', actorId: agent.id, objectiveId: task.objectiveId, taskId: task.id,
          payload: { leaseOwner: id, leaseExpiresAt: Date.now() + LEASE_TTL_MS, worktreeRef: optStr(params, 'worktreeRef', 200) },
        })
      }
      const project = store.project(task.projectId)
      return { task: store.task(task.id), pack: buildContextPack(store, task.id, id), repoRoot: project?.repoRoot }
    }

    case 'agent.progress': {
      const agent = requireAgent(caller)
      const id = agentInstanceId(agent.id)
      const taskId = reqStr(params, 'taskId', 100)
      const task = store.task(taskId)
      if (!task || task.assigneeId !== id) throw new RpcError('that task is not assigned to you')
      store.append({ type: 'AgentHeartbeat', actorKind: 'agent', actorId: agent.id, payload: { id, connectionId: ctx.connectionId } })
      store.append({ type: 'TaskProgress', actorKind: 'agent', actorId: agent.id, objectiveId: task.objectiveId, taskId, payload: { leaseExpiresAt: Date.now() + LEASE_TTL_MS, note: optStr(params, 'note', 400) } })
      renewForTask(store, taskId)
      if (optStr(params, 'note', 400)) {
        store.append({ type: 'AgentMessageCreated', actorKind: 'agent', actorId: agent.id, objectiveId: task.objectiveId, taskId, payload: { topic: `task:${taskId}`, kind: 'info', body: reqStr(params, 'note', 400), refs: { taskId } } })
      }
      return { ok: true }
    }

    case 'agent.complete': {
      const agent = requireAgent(caller)
      const id = agentInstanceId(agent.id)
      const taskId = reqStr(params, 'taskId', 100)
      const task = store.task(taskId)
      if (!task || task.assigneeId !== id) throw new RpcError('that task is not assigned to you')
      const ok = params.ok === true
      const report = optStr(params, 'report', 8_000) ?? (ok ? 'completed' : 'failed without a report')
      const filesChanged = Array.isArray(params.filesChanged) ? params.filesChanged.map(String).slice(0, 200) : []

      // A verdict on a review job.
      if (task.status === 'in-review') {
        const passed = params.verdict !== undefined
          ? String(params.verdict).toLowerCase().startsWith('approv')
          : ok && !/\b(revis|reject|blocker|must fix|change[sd]? request)/i.test(report)
        store.append({ type: 'ReviewCompleted', actorKind: 'agent', actorId: agent.id, objectiveId: task.objectiveId, taskId, payload: { passed, notes: report } })
        store.append({ type: 'AgentStateChanged', actorKind: 'agent', actorId: agent.id, payload: { id, status: 'idle', currentTaskId: null } })
        return { status: passed ? 'done' : 'changes-requested' }
      }

      for (const file of filesChanged) {
        store.append({ type: 'FileChanged', actorKind: 'agent', actorId: agent.id, objectiveId: task.objectiveId, taskId, payload: { path: file } })
      }
      releaseForTask(store, taskId, 'orchestrator')

      const identity = store.agentIdentity(agent.id)
      const reviewerAvailable = store.agentIdentities().some((i) => REVIEWER_ROLES.has(i.role))
      const wantsReview = ok && !task.reviewNotes && !identity?.canMergeWithoutReview
        && REVIEWABLE_ROLES.has(task.role) && (params.requestReview === true || reviewerAvailable)

      if (ok && wantsReview) {
        store.append({ type: 'ReviewRequested', actorKind: 'agent', actorId: agent.id, objectiveId: task.objectiveId, taskId, payload: { report } })
      } else if (ok) {
        store.append({ type: 'TaskCompleted', actorKind: 'agent', actorId: agent.id, objectiveId: task.objectiveId, taskId, payload: { report, filesChanged } })
      } else {
        store.append({ type: 'TaskFailed', actorKind: 'agent', actorId: agent.id, objectiveId: task.objectiveId, taskId, payload: { error: report } })
      }
      store.append({ type: 'AgentStateChanged', actorKind: 'agent', actorId: agent.id, payload: { id, status: 'idle', currentTaskId: null } })
      return { status: ok ? (wantsReview ? 'in-review' : 'done') : 'failed' }
    }

    case 'agent.explain': {
      requireCapability(caller, 'view')
      const target = store.agentByName(reqStr(params, 'agent', 80)) ?? store.agent(reqStr(params, 'agent', 80))
      if (!target) throw new RpcError(`unknown agent ${params.agent}`)
      const task = target.currentTaskId ? store.task(target.currentTaskId) : undefined
      const recent = store.messages({ objectiveId: task?.objectiveId }).filter((message) => message.fromId === target.id).slice(-8)
      return {
        agent: target,
        task: task ? { id: task.id, title: task.title, status: task.status, instructions: task.instructions } : null,
        pack: task ? buildContextPack(store, task.id, target.id) : null,
        recentMessages: recent,
      }
    }

    case 'agent.control': {
      requireCapability(caller, 'control_agent')
      const target = store.agentByName(reqStr(params, 'agent', 80)) ?? store.agent(reqStr(params, 'agent', 80))
      if (!target) throw new RpcError(`unknown agent ${params.agent}`)
      const action = reqStr(params, 'action', 20)
      const next: AgentStatus | undefined = action === 'pause' ? 'paused' : action === 'resume' ? 'idle' : action === 'stop' ? 'cancelled' : undefined
      if (!next) throw new RpcError('action must be pause, resume, or stop')
      if (next !== 'idle' && target.currentTaskId) {
        // Return the in-flight task to the pool.
        store.append({ type: 'TaskStatusChanged', actorKind: 'member', actorId: caller.id, objectiveId: store.task(target.currentTaskId)?.objectiveId, taskId: target.currentTaskId, payload: { status: 'ready' } })
        releaseForTask(store, target.currentTaskId, caller.id)
      }
      if (action === 'stop') {
        store.append({ type: 'AgentStopped', actorKind: 'member', actorId: caller.id, payload: { id: target.id } })
      } else {
        store.append({ type: 'AgentStateChanged', actorKind: 'member', actorId: caller.id, payload: { id: target.id, status: next, currentTaskId: null } })
      }
      return { agent: target.id, action }
    }

    case 'task.assign': {
      requireCapability(caller, 'assign_task')
      const taskId = reqStr(params, 'taskId', 100)
      const task = store.task(taskId)
      if (!task) throw new RpcError(`unknown task ${taskId}`)
      const memberId = optStr(params, 'memberId', 100)
      const agentName = optStr(params, 'agent', 80)
      if (memberId) {
        if (!store.member(memberId)) throw new RpcError(`unknown member ${memberId}`)
        store.append({ type: 'TaskAssigned', actorKind: 'member', actorId: caller.id, objectiveId: task.objectiveId, taskId, payload: { assigneeKind: 'member', assigneeId: memberId } })
        return store.task(taskId)
      }
      if (agentName) {
        const identity = store.agentIdentity(agentName)
        if (!identity) throw new RpcError(`unknown agent identity ${agentName}`)
        store.append({ type: 'TaskAssigned', actorKind: 'member', actorId: caller.id, objectiveId: task.objectiveId, taskId, payload: { assigneeKind: 'agent', assigneeId: agentInstanceId(identity.id) } })
        return store.task(taskId)
      }
      throw new RpcError('task.assign requires either memberId or agent')
    }

    case 'task.reassign': {
      requireCapability(caller, 'reassign_task')
      const taskId = reqStr(params, 'taskId', 100)
      const task = store.task(taskId)
      if (!task) throw new RpcError(`unknown task ${taskId}`)
      releaseForTask(store, taskId, caller.id)
      const agentName = optStr(params, 'agent', 80)
      const memberId = optStr(params, 'memberId', 100)
      if (agentName) {
        const identity = store.agentIdentity(agentName)
        if (!identity) throw new RpcError(`unknown agent identity ${agentName}`)
        store.append({ type: 'TaskReassigned', actorKind: 'member', actorId: caller.id, objectiveId: task.objectiveId, taskId, payload: { assigneeKind: 'agent', assigneeId: agentInstanceId(identity.id) } })
      } else if (memberId) {
        store.append({ type: 'TaskReassigned', actorKind: 'member', actorId: caller.id, objectiveId: task.objectiveId, taskId, payload: { assigneeKind: 'member', assigneeId: memberId } })
      } else {
        // Reassign to the pool.
        store.append({ type: 'TaskReassigned', actorKind: 'member', actorId: caller.id, objectiveId: task.objectiveId, taskId, payload: { assigneeKind: 'agent', assigneeId: '' } })
        store.append({ type: 'TaskStatusChanged', actorKind: 'member', actorId: caller.id, objectiveId: task.objectiveId, taskId, payload: { status: 'ready' } })
      }
      return store.task(taskId)
    }

    case 'task.instruct': {
      requireCapability(caller, 'comment')
      const taskId = reqStr(params, 'taskId', 100)
      const task = store.task(taskId)
      if (!task) throw new RpcError(`unknown task ${taskId}`)
      store.append({ type: 'TaskInstructionAdded', actorKind: caller.kind, actorId: caller.id, objectiveId: task.objectiveId, taskId, payload: { instruction: reqStr(params, 'instruction', 20_000) } })
      if (task.assigneeKind === 'agent' && task.assigneeId) {
        store.append({ type: 'AgentMessageCreated', actorKind: caller.kind, actorId: caller.id, objectiveId: task.objectiveId, taskId, payload: { toId: task.assigneeId, topic: `task:${taskId}`, kind: 'info', body: `New instruction from ${caller.name}: ${reqStr(params, 'instruction', 20_000).slice(0, 500)}`, refs: { taskId } } })
      }
      return store.task(taskId)
    }

    default:
      throw new RpcError(`unhandled agent RPC method: ${method}`)
  }
}

/** Roles whose output is worth an adversarial review pass. */
export const REVIEWABLE_ROLES: ReadonlySet<string> = new Set(['builder', 'frontend', 'backend', 'tester', 'polisher'])
/** Roles that can perform a review job. */
export const REVIEWER_ROLES: ReadonlySet<string> = new Set(['critic', 'security', 'bughunter'])
