import { SUBAGENT_SYSTEM_PROMPT, CYBER_SUBAGENT_SYSTEM_PROMPT, autoFallbacksFor, roleConfig } from './config.ts'
import { runAgentLoop, lastAssistantText, type ConversationMessage, type ToolEvent } from './agentLoop.ts'
import type { Usage } from './providers/types.ts'
import type { Tool } from './tools/types.ts'
import { toolsForRole, role as roleDefinition } from './autonomy/roles.ts'
import { currentAgent, withAgentIdentity } from './autonomy/context.ts'
import { activeBlackboard } from './autonomy/blackboard.ts'
import { activeMode } from './autonomy/mode.ts'
import type { RoleName } from './autonomy/types.ts'
import { createToolResultCache } from './speculation/cache.ts'
import { createPrefetcher } from './speculation/prefetch.ts'
import { recordUsage } from './usage.ts'
import { appendActionAudit } from './autonomy/audit.ts'
import { activeActionGovernor, withActionGovernor, type ActionGovernor } from './autonomy/governor.ts'
import { createDelegationTool } from './tools/delegate.ts'
import { activeGoalGraph, withGoalGraph, withGoalNode, type GoalGraphStore } from './autonomy/goalGraph.ts'
import type { Journal } from './autonomy/journal.ts'

export interface SubAgentRequest {
  prompt: string
  role: RoleName
  /** Display name for logs and blackboard attribution, e.g. "scout#2". */
  name: string
  /** Parent autonomous run, when this worker is part of a durable run. */
  runId?: string
  /** Parent governor; omitted for standalone worker calls. */
  governor?: ActionGovernor
  /** Parent durable goal graph. */
  graph?: GoalGraphStore
  /** Durable node for this worker; action identity is scoped to it. */
  nodeId?: string
  /** Extra context injected above the task, typically the blackboard and the run's goal. */
  briefing?: string
  /** Tools granted to this run on top of its role's allowlist — used for the structured-report tools. */
  extraTools?: Tool[]
  /** Replace the role tool set entirely, for constrained environments such as evolution sandboxes. */
  tools?: Tool[]
  /**
   * Working-directory root this sub-agent's file/shell tools resolve relative
   * paths against — set only when running inside an isolated git worktree
   * (see autonomy/variants.ts). Unset inherits the dispatching agent's own
   * root, so a sub-agent spawned from inside a variant automatically stays
   * inside that variant's worktree without every call site having to say so.
   */
  cwd?: string
  onTool?: (event: ToolEvent) => void
  signal?: AbortSignal
  /** Zero for a direct worker; one for a child worker. Children cannot delegate. */
  delegationDepth?: number
  /** Durable parent node identity for nested action attribution. */
  parentNodeId?: string
  /** Parent autonomous journal for nested delegation lifecycle events. */
  journal?: Journal
}

export interface SubAgentResult {
  name: string
  role: RoleName
  report: string
  usage: Usage
  steps: number
  elapsedMs: number
  ok: boolean
}

/**
 * Runs one isolated, autonomous sub-agent to completion.
 *
 * The role decides three things before a single token is generated: which model
 * answers (a scout runs on the fast tier, or its own dedicated provider if one is
 * configured), which tools exist at all (a scout has no way to write), and what
 * the worker is told to optimise for. Each
 * sub-agent gets its own speculative read cache — they're reading different
 * parts of the tree, so sharing one would mostly mean invalidating each other's.
 *
 * Coding lead roles receive a separate `delegate_tasks` tool at depth zero. It
 * can run one bounded child fleet; child workers run at depth one and receive no
 * delegation tool, which keeps recursive fan-out predictable.
 */
function withGoalGraphIfAvailable<T>(graph: GoalGraphStore | undefined, fn: () => Promise<T>): Promise<T> {
  return graph ? withGoalGraph(graph, fn) : fn()
}

export async function runSubAgent(request: SubAgentRequest): Promise<SubAgentResult> {
  const definition = roleDefinition(request.role)
  const tier = roleConfig(request.role, definition.tier)
  const parent = currentAgent()
  const runId = request.runId ?? parent.runId
  const governor = request.governor ?? activeActionGovernor()
  const graph = request.graph ?? activeGoalGraph()
  const nodeId = request.nodeId
  const delegationDepth = request.delegationDepth ?? 0
  const baseTools = request.tools ?? [...toolsForRole(request.role), ...(request.extraTools ?? [])]
  const tools = [...baseTools]
  if (definition.canDelegate && delegationDepth < 1) {
    tools.push(createDelegationTool({
      parentRole: request.role,
      parentName: request.name,
      depth: delegationDepth,
      runId,
      governor,
      graph,
      parentNodeId: request.parentNodeId ?? nodeId,
      briefing: request.briefing,
      cwd: request.cwd ?? parent.cwd,
      signal: request.signal,
      onTool: request.onTool,
      journal: request.journal,
    }))
  }
  const startedAt = Date.now()

  const board = activeBlackboard()
  const boardContext =
    board.size() > 0
      ? `\n\n## What the fleet already knows\n${board.render()}\n(Use this instead of rediscovering it. Add to it with board_post.)`
      : ''

  const messages: ConversationMessage[] = [
    {
      role: 'user',
      content: [{ type: 'text', text: `${request.briefing ?? ''}${boardContext}\n\n## Your task\n${request.prompt}`.trim() }],
    },
  ]

  const cache = createToolResultCache()
  const prefetcher = createPrefetcher({ tools, cache })

  // A scout or critic dispatched while the lead is in cyber mode needs the same
  // authorization guardrails the lead has — see autonomy/mode.ts.
  const basePrompt = activeMode() === 'cyber' ? CYBER_SUBAGENT_SYSTEM_PROMPT : SUBAGENT_SYSTEM_PROMPT
  const cwd = request.cwd ?? currentAgent().cwd

  const result = await withAgentIdentity({ name: request.name, role: request.role, runId, cwd, signal: request.signal }, () =>
    withActionGovernor(governor, () => withGoalGraphIfAvailable(graph, () => withGoalNode(nodeId, () => runAgentLoop({
      messages,
      systemPrompt: `${basePrompt}\n\n## Your role\n${definition.prompt}`,
      tools,
      provider: tier.provider,
      providerName: tier.providerName,
      model: tier.model,
      fallbacks: autoFallbacksFor(tier.providerName),
      maxSteps: definition.maxSteps,
      useAnimation: false,
      verbose: false,
      onTool: (event) => {
        appendActionAudit(event, runId)
        request.onTool?.(event)
      },
      cache,
      prefetcher,
      signal: request.signal,
    })))),
  )

  recordUsage(result.usage)

  return {
    name: request.name,
    role: request.role,
    report: lastAssistantText(messages, '(sub-agent finished without a final text report)'),
    usage: result.usage,
    steps: result.steps,
    elapsedMs: Date.now() - startedAt,
    ok: result.stopReason === 'complete',
  }
}
