import { config, SYSTEM_PROMPT, CYBER_SYSTEM_PROMPT } from './config.ts'
import { runAgentLoop, type ConversationMessage, type RunAgentLoopResult } from './agentLoop.ts'
import { allWorkerTools, cyberTools } from './tools/registry.ts'
import { taskTool } from './tools/task.ts'
import { previewTool } from './tools/preview.ts'
import { writeText, writeThinking, writeUsageLine } from './ui/stream.ts'
import { recordUsage, recordTopLevelTurn, formatUsageLine } from './usage.ts'
import { createToolResultCache } from './speculation/cache.ts'
import { createPrefetcher } from './speculation/prefetch.ts'
import { observeToolCall } from './skills/detector.ts'
import { setActiveMode, type AgentMode } from './autonomy/mode.ts'
import { noteToolUse } from './ledger.ts'

export type { ConversationMessage }
export type { AgentMode }

// preview opens a real Chrome window — like task, that's a top-level-only
// capability; a silent sub-agent popping open browser windows would be surprising.
// The engagement/scan tools are top-level-only too, and further gated to cyber
// mode — a normal coding turn has no business scaffolding a security engagement.
function topLevelTools(mode: AgentMode) {
  return [...allWorkerTools(), taskTool, previewTool, ...(mode === 'cyber' ? cyberTools : [])]
}

export async function runTurn(
  messages: ConversationMessage[],
  options: { mode?: AgentMode } = {},
): Promise<RunAgentLoopResult> {
  const startedAt = Date.now()
  const mode = options.mode ?? 'default'
  // Ambient for the whole turn, including sub-agents dispatched via the task
  // tool arbitrarily deep in a tool call — see autonomy/mode.ts.
  setActiveMode(mode)
  const tools = topLevelTools(mode)
  const systemPrompt = mode === 'cyber' ? CYBER_SYSTEM_PROMPT : SYSTEM_PROMPT

  // One cache per turn rather than per session: the turn boundary is the point at
  // which the user may have edited files behind elia's back.
  const cache = createToolResultCache()
  const prefetcher = createPrefetcher({ tools, cache })

  const result = await runAgentLoop({
    messages,
    systemPrompt,
    tools,
    onText: writeText,
    onThinking: writeThinking,
    useAnimation: true,
    verbose: true,
    cache,
    prefetcher,
    onTool: (event) => {
      // Every call is a data point for deciding which tool elia should write itself next.
      observeToolCall(event.name, event.input)
      // And a data point for whether a recently recalled episode actually mattered — see ledger.ts.
      noteToolUse(event.input)
    },
  })
  const elapsedMs = Date.now() - startedAt

  recordUsage(result.usage)
  recordTopLevelTurn(elapsedMs)

  const hits = result.cacheStats?.hits ?? 0
  const prefetchNote = hits > 0 ? ` · ${hits} read${hits === 1 ? '' : 's'} prefetched` : ''
  writeUsageLine(`${formatUsageLine(result.usage, elapsedMs, config.model)}${prefetchNote}`)

  return result
}
