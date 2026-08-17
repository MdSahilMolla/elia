import { config, SYSTEM_PROMPT } from './config.ts'
import { runAgentLoop, type ConversationMessage, type RunAgentLoopResult } from './agentLoop.ts'
import { allWorkerTools } from './tools/registry.ts'
import { taskTool } from './tools/task.ts'
import { previewTool } from './tools/preview.ts'
import { writeText, writeUsageLine } from './ui/stream.ts'
import { recordUsage, recordTopLevelTurn, formatUsageLine } from './usage.ts'
import { createToolResultCache } from './speculation/cache.ts'
import { createPrefetcher } from './speculation/prefetch.ts'
import { observeToolCall } from './skills/detector.ts'

export type { ConversationMessage }

// preview opens a real Chrome window — like task, that's a top-level-only
// capability; a silent sub-agent popping open browser windows would be surprising.
function topLevelTools() {
  return [...allWorkerTools(), taskTool, previewTool]
}

export async function runTurn(messages: ConversationMessage[]): Promise<RunAgentLoopResult> {
  const startedAt = Date.now()
  const tools = topLevelTools()

  // One cache per turn rather than per session: the turn boundary is the point at
  // which the user may have edited files behind elia's back.
  const cache = createToolResultCache()
  const prefetcher = createPrefetcher({ tools, cache })

  const result = await runAgentLoop({
    messages,
    systemPrompt: SYSTEM_PROMPT,
    tools,
    onText: writeText,
    useAnimation: true,
    verbose: true,
    cache,
    prefetcher,
    // Every call is a data point for deciding which tool elia should write itself next.
    onTool: (event) => observeToolCall(event.name, event.input),
  })
  const elapsedMs = Date.now() - startedAt

  recordUsage(result.usage)
  recordTopLevelTurn(elapsedMs)

  const hits = result.cacheStats?.hits ?? 0
  const prefetchNote = hits > 0 ? ` · ${hits} read${hits === 1 ? '' : 's'} prefetched` : ''
  writeUsageLine(`${formatUsageLine(result.usage, elapsedMs, config.model)}${prefetchNote}`)

  return result
}
