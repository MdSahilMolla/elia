/**
 * RPC handlers for objectives, tasks, reviews, and agent-runtime coordination.
 *
 * These are split out from `rpc.ts` because they depend on the decomposition,
 * scheduler, and agent-runtime machinery that land in later milestones. Until
 * then the methods are reachable on the protocol but report that they are not
 * yet wired, so a client gets a clear message rather than an "unknown method".
 */

import { RpcError, type RpcContext } from './rpc.ts'
import type { WorkspaceRpcMethod } from './protocol.ts'

const PENDING: Partial<Record<WorkspaceRpcMethod, string>> = {
  'objective.add': 'M3 (decomposition)',
  'objective.list': 'M3 (decomposition)',
  'objective.show': 'M3 (decomposition)',
  'objective.approve': 'M3 (decomposition)',
  'objective.reject': 'M3 (decomposition)',
  'task.list': 'M3 (task graph)',
  'task.show': 'M3 (task graph)',
  'task.add': 'M3 (task graph)',
  'task.assign': 'M4 (orchestrator)',
  'task.reassign': 'M4 (orchestrator)',
  'task.comment': 'M3 (task graph)',
  'task.instruct': 'M4 (orchestrator)',
  'task.block': 'M3 (task graph)',
  'task.unblock': 'M3 (task graph)',
  'review.submit': 'M5 (reviews)',
  'agent.connect': 'M4 (agent runtime)',
  'agent.control': 'M4 (agent runtime)',
  'agent.claim': 'M4 (agent runtime)',
  'agent.progress': 'M4 (agent runtime)',
  'agent.complete': 'M4 (agent runtime)',
  'agent.explain': 'M4 (agent runtime)',
}

export async function dispatchOrchestrationRpc(
  _ctx: RpcContext,
  method: WorkspaceRpcMethod,
  _params: Record<string, unknown>,
): Promise<unknown> {
  const milestone = PENDING[method]
  if (milestone) throw new RpcError(`${method} is defined but not yet implemented — arrives in ${milestone}`)
  throw new RpcError(`unknown workspace RPC method: ${method}`)
}
