import { config } from './config.ts'
import type { ChatMessage, ContentBlock, Provider, Usage } from './providers/types.ts'
import type { Tool } from './tools/types.ts'
import { endTextTurn, writeNotice, writeToolCall, writeToolResult } from './ui/stream.ts'
import { startThinkingAnimation } from './ui/animator.ts'
import { createStreamCursor } from './ui/streamCursor.ts'
import { ZERO_USAGE, addUsage } from './usage.ts'
import { SPECULABLE_TOOLS, type CacheStats, type ToolResultCache } from './speculation/cache.ts'
import type { Prefetcher } from './speculation/prefetch.ts'
import { maybeCompact } from './compaction.ts'
import { activeActionGovernor, type ActionAssessment } from './autonomy/governor.ts'

export type ConversationMessage = ChatMessage

const MAX_PARALLEL_TOOLS = 4
const MAX_PROVIDER_ATTEMPTS = 3

/**
 * A hard ceiling on model round-trips in one loop. Without it a model that keeps
 * calling tools forever burns tokens unbounded; with it the loop always
 * terminates and reports *why* it stopped.
 */
const DEFAULT_MAX_STEPS = 80

export interface ToolEvent {
  name: string
  input: Record<string, unknown>
  result: string
  isError: boolean
  durationMs: number
  /** True when the result came from a speculative pre-read instead of running now. */
  cached: boolean
  /** Deterministic pre-execution governance assessment, when available. */
  assessment?: ActionAssessment
}

export interface RunAgentLoopOptions {
  messages: ConversationMessage[]
  systemPrompt: string
  tools: Tool[]
  onText?: (delta: string) => void
  /** Streamed reasoning, when the provider produces any (not every provider/turn does). */
  onThinking?: (delta: string) => void
  /** Show the thinking animation and emit a trailing newline after streamed text (top-level only). */
  useAnimation: boolean
  /** Log tool calls/results to stdout as they happen (off for silent sub-agents so parallel runs don't interleave). */
  verbose: boolean
  /** Model to run this loop on. Defaults to the deep tier; roles override it to route cheap work to the fast tier. */
  provider?: Provider
  /** Model id matching `provider`, used only for cost accounting. */
  model?: string
  /** Max model round-trips before the loop gives up (default 80). */
  maxSteps?: number
  /** Called after every tool result — used by the journal and the skill-synthesis detector. */
  onTool?: (event: ToolEvent) => void
  /** Speculative read cache; when present, matching read-only calls resolve instantly. */
  cache?: ToolResultCache
  /** Predicts and pre-runs the reads the model is likely to ask for next. */
  prefetcher?: Prefetcher
  /** Cooperative cancellation, checked between steps. */
  signal?: AbortSignal
}

export type StopReason = 'complete' | 'step-budget' | 'aborted'

export interface RunAgentLoopResult {
  /** Usage summed across every model call this loop made (including ones behind tool-call round-trips). */
  usage: Usage
  /** Model round-trips actually made. */
  steps: number
  stopReason: StopReason
  cacheStats?: CacheStats
}

/**
 * Runs the send-stream-execute-tools loop until the model stops calling tools,
 * mutating `messages` in place. Shared by the top-level agent (src/agent.ts)
 * and sub-agents (src/subagent.ts) so both get parallel tool execution,
 * speculative prefetch, and the same step budget.
 */
export async function runAgentLoop(opts: RunAgentLoopOptions): Promise<RunAgentLoopResult> {
  const {
    messages,
    systemPrompt,
    tools,
    onText,
    onThinking,
    useAnimation,
    verbose,
    provider,
    maxSteps = DEFAULT_MAX_STEPS,
    onTool,
    cache,
    prefetcher,
    signal,
  } = opts

  const toolDefinitions = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema,
  }))
  const toolsByName: Record<string, Tool> = Object.fromEntries(tools.map((tool) => [tool.name, tool]))

  let totalUsage = ZERO_USAGE
  let steps = 0

  const finish = (stopReason: StopReason): RunAgentLoopResult => ({
    usage: totalUsage,
    steps,
    stopReason,
    cacheStats: cache?.stats(),
  })

  while (true) {
    if (signal?.aborted) return finish('aborted')

    // A growing history costs more to attend to every turn even with prompt
    // caching (which makes it cheap to *re-send*, not smaller), and is
    // eventually finite regardless of provider. Cheap no-op check below the
    // threshold; only pays for a summary call once it's actually crossed.
    if (await maybeCompact(messages)) {
      if (verbose) writeNotice('elia: conversation history compacted to keep things fast')
    }

    if (steps >= maxSteps) {
      messages.push({
        role: 'user',
        content: [
          {
            type: 'text',
            text: `[elia] Step budget of ${maxSteps} model calls reached. Stop calling tools and summarise what you completed, what is left, and what you would do next.`,
          },
        ],
      })
      // One final call, with the budget lifted, so the run ends with a real report
      // rather than being cut off mid-thought.
      steps += 1
      const wrapUp = await streamOnce()
      messages.push({ role: 'assistant', content: wrapUp })
      return finish('step-budget')
    }

    steps += 1
    const content = await streamOnce()
    messages.push({ role: 'assistant', content })

    const toolUseBlocks = content.filter(
      (block): block is Extract<ContentBlock, { type: 'tool_use' }> => block.type === 'tool_use',
    )

    if (toolUseBlocks.length === 0) return finish('complete')

    if (verbose) {
      for (const block of toolUseBlocks) writeToolCall(block.name, block.input)
    }

    // A batch that writes anything invalidates every speculative read: the model
    // must never receive a pre-write snapshot of a file it just changed. When a
    // batch mixes reads and writes, the reads in it also bypass the cache, since
    // within a parallel batch there is no ordering guarantee between them.
    const batchMutates = toolUseBlocks.some((block) => !SPECULABLE_TOOLS.has(block.name))
    if (batchMutates) cache?.invalidate()

    const observed: { name: string; input: Record<string, unknown>; result: string }[] = []

    const toolResults = await runWithConcurrencyLimit(toolUseBlocks, MAX_PARALLEL_TOOLS, async (block) => {
      const tool = toolsByName[block.name]
      const startedAt = Date.now()

      let resultText: string
      let isError = false
      let cached = false
      let assessment: ActionAssessment | undefined
      try {
        const gate = await activeActionGovernor().check({ name: block.name, input: block.input })
        assessment = gate.assessment
        if (!gate.allowed) {
          isError = true
          resultText = gate.message ?? `Action blocked by Elia’s autonomy governor: ${gate.assessment.reason}`
        } else {
          const pending = batchMutates ? undefined : cache?.take(block.name, block.input)
          if (pending) {
            cached = true
            resultText = await pending
          } else {
            if (!tool) throw new Error(`Unknown tool: ${block.name}`)
            resultText = await tool.execute(block.input)
          }
        }
      } catch (err) {
        isError = true
        cached = false
        resultText = err instanceof Error ? err.message : String(err)
      }

      const durationMs = Date.now() - startedAt
      if (verbose) writeToolResult(block.name, resultText, isError, cached)
      onTool?.({ name: block.name, input: block.input, result: resultText, isError, durationMs, cached, assessment })
      if (!isError) observed.push({ name: block.name, input: block.input, result: resultText })

      return {
        type: 'tool_result' as const,
        tool_use_id: block.id,
        content: resultText,
        is_error: isError,
      }
    })

    if (batchMutates) cache?.invalidate()

    messages.push({ role: 'user', content: toolResults })

    // Kick off predicted reads *before* looping back, so they run in parallel with
    // the model generating its next message rather than after it.
    prefetcher?.observe(observed)
    // Loop back automatically so the model can react to tool results without user input.
  }

  async function streamOnce(): Promise<ContentBlock[]> {
    const animation = useAnimation ? startThinkingAnimation() : undefined
    let animationStopped = !useAnimation
    const stopAnimation = () => {
      if (animationStopped) return
      animationStopped = true
      animation?.stop()
    }
    const cursor = useAnimation ? createStreamCursor() : undefined

    // Resolved per call rather than captured once, so the ambient provider stays
    // swappable (tests stub `config.provider`) while roles can still pin a tier.
    const active = provider ?? config.provider

    try {
      let emittedOutput = false
      for (let attempt = 1; ; attempt++) {
        try {
          const result = await active.streamTurn({
            system: systemPrompt,
            messages,
            tools: toolDefinitions,
            onText: (delta) => {
              emittedOutput = true
              stopAnimation()
              cursor?.beforeText()
              onText?.(delta)
              cursor?.afterText()
            },
            onThinking: (delta) => {
              // Reasoning is real output too — a retry after some has been shown
              // would duplicate it in the terminal exactly like retrying after text.
              emittedOutput = true
              stopAnimation()
              onThinking?.(delta)
            },
          })
          totalUsage = addUsage(totalUsage, result.usage)
          return result.content
        } catch (error) {
          // Retrying after output was emitted would duplicate a partial answer in
          // the terminal. Only retry failures that happened before any output.
          if (emittedOutput || attempt >= MAX_PROVIDER_ATTEMPTS || !isRetryableProviderError(error)) throw error
          if (signal?.aborted) throw error
          await Bun.sleep(250 * 2 ** (attempt - 1))
        }
      }
    } finally {
      stopAnimation()
      cursor?.stop()
      if (useAnimation) endTextTurn()
    }
  }
}

/**
 * The last thing the assistant actually said in a conversation — what a
 * sub-agent or persona turn reports back to whoever dispatched it. Shared so
 * every caller (sub-agents, agent personas) reads a finished turn's result the
 * same way instead of re-deriving it, with a caller-supplied fallback for the
 * "stopped without saying anything" case.
 */
export function lastAssistantText(messages: ConversationMessage[], fallback: string): string {
  const lastAssistantMessage = [...messages].reverse().find((message) => message.role === 'assistant')
  const text = lastAssistantMessage?.content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim()

  return text && text.length > 0 ? text : fallback
}

function isRetryableProviderError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /connection|fetch failed|network|timeout|timed out|rate limit|429|500|502|503|504|server had an error/i.test(
    message,
  )
}

/** Runs `fn` over `items` with at most `limit` in flight at once, preserving result order. */
export async function runWithConcurrencyLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0

  async function worker(): Promise<void> {
    while (true) {
      const index = cursor++
      if (index >= items.length) return
      results[index] = await fn(items[index]!)
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}
