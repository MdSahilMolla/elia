import { BATTMANN_SYSTEM_PROMPT, config, CYBER_SYSTEM_PROMPT, DEV_SYSTEM_PROMPT, FITNESS_SYSTEM_PROMPT, SPORTS_SYSTEM_PROMPT } from './config.ts'
import { runAgentLoop, type ConversationMessage, type RunAgentLoopResult, type ToolEvent } from './agentLoop.ts'
import { allWorkerTools, businessTools, cyberTools, getSynthesizedTools } from './tools/registry.ts'
import { taskTool } from './tools/task.ts'
import { previewTool } from './tools/preview.ts'
import { writeText, writeThinking, writeUsageLine } from './ui/stream.ts'
import { recordUsage, recordTopLevelTurn, formatUsageLine } from './usage.ts'
import { createToolResultCache } from './speculation/cache.ts'
import { createPrefetcher } from './speculation/prefetch.ts'
import { observeToolCall } from './skills/detector.ts'
import { setActiveMode, type AgentMode } from './autonomy/mode.ts'
import { noteToolUse } from './ledger.ts'
import { appendActionAudit } from './autonomy/audit.ts'
import { createActionGovernor, withActionGovernor, type ActionApproval, type GovernanceMode } from './autonomy/governor.ts'
import { loadDevelopmentToolHooks, withToolHooks } from './autonomy/devHooks.ts'
import { expandSkillSelection } from './skills/bundles.ts'

export type { ConversationMessage }
export type { AgentMode }

// preview opens a real Chrome window — like task, that's a top-level-only
// capability; a silent sub-agent popping open browser windows would be surprising.
// The engagement/scan tools are top-level-only too, and further gated to cyber
// mode — a dev turn has no business scaffolding a security engagement.
function topLevelTools(mode: AgentMode, selectedSkillNames?: string[]) {
  const expandedSelection = expandSkillSelection(selectedSkillNames)
  const selected = new Set(expandedSelection ?? [])
  const synthesized = new Set(getSynthesizedTools().map((tool) => tool.name))
  const workerTools = allWorkerTools().filter((tool) => expandedSelection === undefined || !synthesized.has(tool.name) || selected.has(tool.name))
  // Battmann gets the research and reporting set: an intelligence brief
  // grounded only in the local filesystem would be fabrication by construction.
  return [
    ...workerTools,
    taskTool,
    previewTool,
    ...(mode === 'cyber' ? cyberTools : []),
    ...(mode === 'battmann' ? businessTools : []),
  ]
}

export interface RunTurnOptions {
  mode?: AgentMode
  onTool?: (event: ToolEvent) => void
  approveAction?: ActionApproval
  governanceMode?: GovernanceMode
  /** Names of synthesized skills explicitly selected for this turn; omitted means all loaded skills remain available. */
  skillNames?: string[]
  /** Cooperative cancellation for task-console shutdown and operator control. */
  signal?: AbortSignal
  /** Optional bridge callback for streamed assistant text. */
  onText?: (delta: string) => void
  /** Optional bridge callback for streamed reasoning. */
  onThinking?: (delta: string) => void
  /** Suppress terminal rendering and usage output for machine clients. */
  silent?: boolean
  /** Skip recordUsage/recordTopLevelTurn/the usage-line print — for a caller (e.g. the orchestrator delegating a lone 'tech' route) that aggregates and records stats itself exactly once. */
  skipStats?: boolean
}

export async function runTurn(
  messages: ConversationMessage[],
  options: RunTurnOptions = {},
): Promise<RunAgentLoopResult> {
  const startedAt = Date.now()
  const mode = options.mode ?? 'dev'
  // Ambient for the whole turn, including sub-agents dispatched via the task
  // tool arbitrarily deep in a tool call — see autonomy/mode.ts.
  setActiveMode(mode)
  const tools = topLevelTools(mode, options.skillNames)
  const systemPrompt = mode === 'cyber'
    ? CYBER_SYSTEM_PROMPT
    : mode === 'sports'
      ? SPORTS_SYSTEM_PROMPT
      : mode === 'fitness'
        ? FITNESS_SYSTEM_PROMPT
        : mode === 'battmann'
          ? BATTMANN_SYSTEM_PROMPT
          : DEV_SYSTEM_PROMPT

  // One cache per turn rather than per session: the turn boundary is the point at
  // which the user may have edited files behind elia's back.
  const cache = createToolResultCache()
  const prefetcher = createPrefetcher({ tools, cache })

  const governor = createActionGovernor({
    mode: options.governanceMode ?? (options.approveAction ? 'supervised' : 'unattended'),
    approve: options.approveAction,
  })

  const hooks = mode === 'dev' ? loadDevelopmentToolHooks() : []
  const result = await withToolHooks(hooks, () => withActionGovernor(governor, () => runAgentLoop({
    messages,
    systemPrompt,
    tools,
    onText: options.onText ?? writeText,
    onThinking: options.onThinking ?? writeThinking,
    useAnimation: !options.silent,
    verbose: !options.silent,
    cache,
    prefetcher,
    signal: options.signal,
    onTool: (event) => {
      // Every call is a data point for deciding which tool elia should write itself next.
      appendActionAudit(event)
      observeToolCall(event.name, event.input)
      // And a data point for whether a recently recalled episode actually mattered — see ledger.ts.
      noteToolUse(event.input)
      options.onTool?.(event)
    },
  })))
  const elapsedMs = Date.now() - startedAt

  if (!options.skipStats) {
    recordUsage(result.usage)
    recordTopLevelTurn(elapsedMs)
  }

  const hits = result.cacheStats?.hits ?? 0
  const prefetchNote = hits > 0 ? ` · ${hits} read${hits === 1 ? '' : 's'} prefetched` : ''
  if (!options.silent && !options.skipStats) writeUsageLine(`${formatUsageLine(result.usage, elapsedMs, config.model)}${prefetchNote}`)

  return result
}
