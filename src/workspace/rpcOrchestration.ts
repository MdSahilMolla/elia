/**
 * RPC handlers for objectives, tasks, and reviews.
 *
 * Split from `rpc.ts` because these depend on the decomposition and (later)
 * scheduler / agent-runtime machinery. M3 implements objective creation +
 * approval and the task graph; agent-runtime and review methods still report
 * the milestone that will wire them.
 */

import { randomUUID } from 'node:crypto'
import { RpcError, type RpcContext } from './rpc.ts'
import { requireCapability } from './identity.ts'
import { decomposeObjective } from './decompose.ts'
import { dispatchAgentRpc } from './rpcAgents.ts'
import { isRoleName } from '../autonomy/types.ts'
import { OPEN_TASK_STATUSES, type TaskRecord } from './types.ts'
import type { WorkspaceRpcMethod } from './protocol.ts'

const AGENT_METHODS = new Set<WorkspaceRpcMethod>([
  'agent.connect', 'agent.claim', 'agent.progress', 'agent.complete', 'agent.explain', 'agent.control',
  'task.assign', 'task.reassign', 'task.instruct',
])

const PENDING: Partial<Record<WorkspaceRpcMethod, string>> = {}

type Params = Record<string, unknown>

function reqStr(params: Params, key: string, max = 8_000): string {
  const value = params[key]
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new RpcError(`${key} must be a non-empty string of at most ${max} characters`)
  return value.trim()
}

function optStr(params: Params, key: string, max = 8_000): string | undefined {
  return params[key] === undefined || params[key] === null || params[key] === '' ? undefined : reqStr(params, key, max)
}

function objectiveView(ctx: RpcContext, objectiveId: string) {
  const objective = ctx.store.objective(objectiveId)
  if (!objective) throw new RpcError(`unknown objective ${objectiveId}`)
  const tasks = ctx.store.tasks({ objectiveId })
  return {
    objective,
    tasks,
    decisions: ctx.store.decisions(objectiveId),
    approvals: ctx.store.approvals().filter((a) => a.objectiveId === objectiveId),
    remaining: tasks.filter((task) => OPEN_TASK_STATUSES.has(task.status)).length,
  }
}

export async function dispatchOrchestrationRpc(
  ctx: RpcContext,
  method: WorkspaceRpcMethod,
  params: Params,
): Promise<unknown> {
  const { store, caller } = ctx

  if (AGENT_METHODS.has(method)) return dispatchAgentRpc(ctx, method, params)

  switch (method) {
    case 'objective.list':
      requireCapability(caller, 'view')
      return store.objectives().map((objective) => ({
        ...objective,
        taskCount: store.tasks({ objectiveId: objective.id }).length,
      }))

    case 'objective.show':
      requireCapability(caller, 'view')
      return objectiveView(ctx, reqStr(params, 'objectiveId', 100))

    case 'objective.add': {
      requireCapability(caller, 'create_objective')
      const result = await decomposeObjective(
        store,
        { goal: reqStr(params, 'goal', 10_000), projectId: optStr(params, 'projectId', 100), actorId: caller.id, signal: ctx.signal },
        ctx.planner,
      )
      return {
        objectiveId: result.objectiveId,
        runId: result.runId,
        taskIds: result.taskIds,
        waves: result.waves,
        steps: result.proposal.steps.map((step) => ({ id: step.id, title: step.title, role: step.role, dependsOn: step.dependsOn })),
        status: 'awaiting-approval',
      }
    }

    case 'objective.approve': {
      requireCapability(caller, 'approve_plan')
      const objectiveId = reqStr(params, 'objectiveId', 100)
      const objective = store.objective(objectiveId)
      if (!objective) throw new RpcError(`unknown objective ${objectiveId}`)
      if (objective.status !== 'awaiting-approval') throw new RpcError(`objective ${objectiveId} is ${objective.status}, not awaiting approval`)
      const approval = store.approvals('pending').find((a) => a.kind === 'plan' && a.subject === objectiveId)
      if (approval) store.append({ type: 'ApprovalGranted', actorKind: 'member', actorId: caller.id, objectiveId, payload: { id: approval.id } })
      store.append({ type: 'ObjectiveStatusChanged', actorKind: 'member', actorId: caller.id, objectiveId, payload: { status: 'active', approvedBy: caller.id } })
      return objectiveView(ctx, objectiveId)
    }

    case 'objective.reject': {
      requireCapability(caller, 'approve_plan')
      const objectiveId = reqStr(params, 'objectiveId', 100)
      const objective = store.objective(objectiveId)
      if (!objective) throw new RpcError(`unknown objective ${objectiveId}`)
      const approval = store.approvals('pending').find((a) => a.kind === 'plan' && a.subject === objectiveId)
      if (approval) {
        store.append({ type: 'ApprovalRejected', actorKind: 'member', actorId: caller.id, objectiveId, payload: { id: approval.id, reason: optStr(params, 'reason', 2_000) } })
      }
      store.append({ type: 'ObjectiveStatusChanged', actorKind: 'member', actorId: caller.id, objectiveId, payload: { status: 'rejected' } })
      return { objectiveId, status: 'rejected' }
    }

    case 'task.list': {
      requireCapability(caller, 'view')
      const objectiveId = optStr(params, 'objectiveId', 100)
      const status = optStr(params, 'status', 40) as TaskRecord['status'] | undefined
      return store.tasks({ objectiveId, status })
    }

    case 'task.show': {
      requireCapability(caller, 'view')
      const task = store.task(reqStr(params, 'taskId', 100))
      if (!task) throw new RpcError(`unknown task ${params.taskId}`)
      const objective = store.objective(task.objectiveId)
      return {
        task,
        objective,
        dependencies: task.dependsOn.map((id) => store.task(id)).filter(Boolean),
        blockedBy: task.dependsOn.map((id) => store.task(id)).filter((dep) => dep && dep.status !== 'done').map((dep) => dep!.id),
        messages: store.messages({ objectiveId: task.objectiveId, toId: undefined }).filter((m) => m.refs?.taskId === task.id),
      }
    }

    case 'task.add': {
      requireCapability(caller, 'create_task')
      const objectiveId = reqStr(params, 'objectiveId', 100)
      if (!store.objective(objectiveId)) throw new RpcError(`unknown objective ${objectiveId}`)
      const role = reqStr(params, 'role', 40)
      if (!isRoleName(role)) throw new RpcError('role must be a valid worker role')
      const dependsOn = Array.isArray(params.dependsOn) ? params.dependsOn.map(String) : []
      for (const dep of dependsOn) if (!store.task(dep)) throw new RpcError(`dependsOn references unknown task ${dep}`)
      const id = `tsk_${randomUUID().replaceAll('-', '').slice(0, 20)}`
      store.append({
        type: 'TaskCreated',
        actorKind: 'member',
        actorId: caller.id,
        objectiveId,
        payload: {
          id, objectiveId,
          projectId: store.objective(objectiveId)!.projectId,
          title: reqStr(params, 'title', 200),
          instructions: optStr(params, 'instructions', 20_000) ?? '',
          role,
          dependsOn,
          files: Array.isArray(params.files) ? params.files.map(String).slice(0, 100) : [],
          acceptanceCriteria: Array.isArray(params.acceptanceCriteria) ? params.acceptanceCriteria.map(String).slice(0, 20) : [],
          verificationCommands: Array.isArray(params.verificationCommands) ? params.verificationCommands.map(String).slice(0, 20) : [],
          maxAttempts: 2,
        },
      })
      return store.task(id)
    }

    case 'task.comment': {
      requireCapability(caller, 'comment')
      const taskId = reqStr(params, 'taskId', 100)
      const task = store.task(taskId)
      if (!task) throw new RpcError(`unknown task ${taskId}`)
      const event = store.append({
        type: 'AgentMessageCreated',
        actorKind: caller.kind,
        actorId: caller.id,
        objectiveId: task.objectiveId,
        taskId,
        payload: { topic: `task:${taskId}`, kind: 'info', body: reqStr(params, 'body', 8_000), refs: { taskId } },
      })
      return { seq: event.seq }
    }

    case 'task.block': {
      requireCapability(caller, 'assign_task')
      const taskId = reqStr(params, 'taskId', 100)
      store.append({ type: 'TaskBlocked', actorKind: caller.kind, actorId: caller.id, taskId, objectiveId: store.task(taskId)?.objectiveId, payload: { reason: optStr(params, 'reason', 2_000) ?? 'blocked by a member' } })
      return store.task(taskId)
    }

    case 'task.unblock': {
      requireCapability(caller, 'assign_task')
      const taskId = reqStr(params, 'taskId', 100)
      store.append({ type: 'TaskUnblocked', actorKind: caller.kind, actorId: caller.id, taskId, objectiveId: store.task(taskId)?.objectiveId, payload: {} })
      return store.task(taskId)
    }

    case 'review.submit': {
      requireCapability(caller, 'review_ai_work')
      const taskId = reqStr(params, 'taskId', 100)
      const task = store.task(taskId)
      if (!task) throw new RpcError(`unknown task ${taskId}`)
      if (task.status !== 'in-review') throw new RpcError(`task ${taskId} is ${task.status}, not in review`)
      const verdict = reqStr(params, 'verdict', 20).toLowerCase()
      if (!['approve', 'revise'].includes(verdict)) throw new RpcError('verdict must be approve or revise')
      store.append({
        type: 'ReviewCompleted', actorKind: 'member', actorId: caller.id, objectiveId: task.objectiveId, taskId,
        payload: { passed: verdict === 'approve', notes: optStr(params, 'notes', 8_000) ?? (verdict === 'approve' ? 'approved' : 'changes requested') },
      })
      // Free a reviewer agent that was assigned this job.
      const reviewer = store.agents().find((agent) => agent.currentTaskId === taskId)
      if (reviewer) store.append({ type: 'AgentStateChanged', actorKind: 'member', actorId: caller.id, payload: { id: reviewer.id, status: 'idle', currentTaskId: null } })
      return store.task(taskId)
    }

    default: {
      const milestone = PENDING[method]
      if (milestone) throw new RpcError(`${method} is defined but not yet implemented — arrives in ${milestone}`)
      throw new RpcError(`unknown workspace RPC method: ${method}`)
    }
  }
}
