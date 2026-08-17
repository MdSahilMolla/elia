import { SUBAGENT_SYSTEM_PROMPT, tierConfig } from './config.ts'
import { runAgentLoop, type ConversationMessage, type ToolEvent } from './agentLoop.ts'
import type { ContentBlock, Usage } from './providers/types.ts'
import type { Tool } from './tools/types.ts'
import { toolsForRole, role as roleDefinition } from './autonomy/roles.ts'
import { withAgentIdentity } from './autonomy/context.ts'
import { activeBlackboard } from './autonomy/blackboard.ts'
import type { RoleName } from './autonomy/types.ts'
import { createToolResultCache } from './speculation/cache.ts'
import { createPrefetcher } from './speculation/prefetch.ts'
import { recordUsage } from './usage.ts'

export interface SubAgentRequest {
  prompt: string
  role: RoleName
  /** Display name for logs and blackboard attribution, e.g. "scout#2". */
  name: string
  /** Extra context injected above the task, typically the blackboard and the run's goal. */
  briefing?: string
  /** Tools granted to this run on top of its role's allowlist — used for the structured-report tools. */
  extraTools?: Tool[]
  onTool?: (event: ToolEvent) => void
  signal?: AbortSignal
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
 * tier answers (a scout runs on the fast tier), which tools exist at all (a
 * scout has no way to write), and what the worker is told to optimise for. Each
 * sub-agent gets its own speculative read cache — they're reading different
 * parts of the tree, so sharing one would mostly mean invalidating each other's.
 *
 * Sub-agents cannot spawn further sub-agents: no role's allowlist contains
 * `task`, which caps recursion depth at one and keeps the fan-out predictable.
 */
export async function runSubAgent(request: SubAgentRequest): Promise<SubAgentResult> {
  const definition = roleDefinition(request.role)
  const tier = tierConfig(definition.tier)
  const tools = [...toolsForRole(request.role), ...(request.extraTools ?? [])]
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

  const result = await withAgentIdentity({ name: request.name, role: request.role }, () =>
    runAgentLoop({
      messages,
      systemPrompt: `${SUBAGENT_SYSTEM_PROMPT}\n\n## Your role\n${definition.prompt}`,
      tools,
      provider: tier.provider,
      model: tier.model,
      maxSteps: definition.maxSteps,
      useAnimation: false,
      verbose: false,
      onTool: request.onTool,
      cache,
      prefetcher,
      signal: request.signal,
    }),
  )

  recordUsage(result.usage)

  return {
    name: request.name,
    role: request.role,
    report: finalReport(messages),
    usage: result.usage,
    steps: result.steps,
    elapsedMs: Date.now() - startedAt,
    ok: result.stopReason === 'complete',
  }
}

function finalReport(messages: ConversationMessage[]): string {
  const lastAssistantMessage = [...messages].reverse().find((message) => message.role === 'assistant')
  const text = lastAssistantMessage?.content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim()

  return text && text.length > 0 ? text : '(sub-agent finished without a final text report)'
}
