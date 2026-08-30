import { autoFallbacksFor, config } from './config.ts'
import { maybeCompact } from './compaction.ts'
import type { ChatMessage, ContentBlock, Provider, ProviderActivity, Usage } from './providers/types.ts'
import type { Tool } from './tools/types.ts'
import { endTextTurn, writeNotice, writeToolCall, writeToolResult } from './ui/stream.ts'
import { startThinkingAnimation } from './ui/animator.ts'
import { createStreamCursor } from './ui/streamCursor.ts'
import { ZERO_USAGE, addUsage } from './usage.ts'
import { SPECULABLE_TOOLS, type CacheStats, type ToolResultCache } from './speculation/cache.ts'
import type { Prefetcher } from './speculation/prefetch.ts'
import { activeActionGovernor, assessAction, redactActionInput, type ActionAssessment } from './autonomy/governor.ts'
import { activeGoalGraph, activeGoalNode, type ActionReservation, classifyFailure } from './autonomy/goalGraph.ts'
import { contractForAction, evaluatePostconditions, evaluatePreconditions, type ActionContract, type ContractEvaluation } from './autonomy/actionContract.ts'
import { currentAgent } from './autonomy/context.ts'
import { activeMode } from './autonomy/mode.ts'
import { activeToolHooks, evaluateToolHooks } from './autonomy/devHooks.ts'
import { clampOutput } from './shell.ts'
import { isRepoMutatingTool, withRepoLock } from './repoLock.ts'
import { profilingEnabled, recordModelCall } from './profile.ts'

export type ConversationMessage = ChatMessage

const MAX_PARALLEL_TOOLS = 4
const MAX_SAFE_PARALLEL_TOOLS = 8
const MAX_PROVIDER_ATTEMPTS = 3
const PROVIDER_HEALTH_COOLDOWN_MS = 30_000
const providerHealth = new Map<string, { failures: number; cooldownUntil: number; lastError?: string }>()

/**
 * A hard ceiling on model round-trips in one loop. Without it a model that keeps
 * calling tools forever burns tokens unbounded; with it the loop always
 * terminates and reports *why* it stopped.
 */
const DEFAULT_MAX_STEPS = 80

export interface ProviderRoute {
  provider: Provider
  providerName: string
  model: string
  label?: string
}

export interface ToolEvent {
  /** The provider's tool_use id — pairs a result with its earlier onToolStart. */
  id?: string
  name: string
  input: Record<string, unknown>
  result: string
  isError: boolean
  durationMs: number
  /** True when the result came from a speculative pre-read instead of running now. */
  cached: boolean
  /** Deterministic pre-execution governance assessment, when available. */
  assessment?: ActionAssessment
  /** Durable action identity, when the loop is running inside a goal graph. */
  actionId?: string
  idempotencyKey?: string
  replayed?: boolean
  failureClass?: string
}

export interface RunAgentLoopOptions {
  messages: ConversationMessage[]
  systemPrompt: string
  /**
   * Per-turn system content that changes between user turns (query-ranked
   * memory, mode hints). Passed to the provider separately from `systemPrompt`
   * so it does not invalidate the cached stable prefix. Omit for callers whose
   * whole system prompt is static (sub-agents, personas).
   */
  systemDynamicPrompt?: string
  tools: Tool[]
  onText?: (delta: string) => void
  /** Streamed reasoning, when the provider produces any (not every provider/turn does). */
  onThinking?: (delta: string) => void
  /** Structured live progress from an agentic provider. */
  onActivity?: (activity: ProviderActivity) => void
  /** Show the thinking animation and emit a trailing newline after streamed text (top-level only). */
  useAnimation: boolean
  /** Log tool calls/results to stdout as they happen (off for silent sub-agents so parallel runs don't interleave). */
  verbose: boolean
  /** Model to run this loop on. Defaults to the selected deep-tier provider. */
  provider?: Provider
  /** Provider name matching `provider`, used for fallback notices and routing. */
  providerName?: string
  /** Model id matching `provider`, used for fallback notices and accounting. */
  model?: string
  /** Additional providers to try when the selected route is unavailable before output. */
  fallbacks?: ProviderRoute[]
  /** Max model round-trips before the loop gives up (default 80). */
  maxSteps?: number
  /** Called after every tool result — used by the journal and the skill-synthesis detector. */
  onTool?: (event: ToolEvent) => void
  /** Called when a tool call is dispatched, before it runs — lets a live UI show a pending card. */
  onToolStart?: (call: { id: string; name: string; input: Record<string, unknown> }) => void
  /** Speculative read cache; when present, matching read-only calls resolve instantly. */
  cache?: ToolResultCache
  /** Predicts and pre-runs the reads the model is likely to ask for next. */
  prefetcher?: Prefetcher
  /** Cooperative cancellation, checked between steps. */
  signal?: AbortSignal
  /**
   * Mid-run steering: called at each step boundary. Anything it returns is
   * spliced into the conversation as an operator message before the next model
   * call, so the user can redirect a working agent ("actually use zod", "that
   * file is generated") without stopping and restarting the turn. Must return
   * and clear its own buffer.
   */
  drainSteering?: () => string[]
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
    systemDynamicPrompt,
    tools,
    onText,
    onThinking,
    onActivity,
    useAnimation,
    verbose,
    provider,
    providerName,
    model,
    fallbacks,
    maxSteps = DEFAULT_MAX_STEPS,
    onTool,
    onToolStart,
    cache,
    prefetcher,
    signal,
    drainSteering,
  } = opts

  /**
   * Splices any pending operator steering into `messages` as a user turn.
   * Returns true when something was injected. Consecutive user messages are
   * merged by every provider, so this is safe to call right after a tool-result
   * user message.
   */
  const injectSteering = (): boolean => {
    const pending = drainSteering?.() ?? []
    if (pending.length === 0) return false
    const text = pending.join('\n').trim()
    if (!text) return false
    messages.push({
      role: 'user',
      content: [{ type: 'text', text: `[Operator steering — the user sent this while you were working. Take it as a direct instruction and adjust course now.]\n${text}` }],
    })
    if (verbose) writeNotice('elia: operator steering applied')
    return true
  }

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

    // Fold in any guidance the operator typed during the previous model call or
    // tool batch, before the next model call sees the conversation.
    injectSteering()

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
      try {
        const wrapUp = await streamOnce()
        messages.push({ role: 'assistant', content: wrapUp })
      } catch (error) {
        if (signal?.aborted) return finish('aborted')
        throw error
      }
      return finish('step-budget')
    }

    steps += 1
    let content: ContentBlock[]
    try {
      content = await streamOnce()
    } catch (error) {
      if (signal?.aborted) return finish('aborted')
      throw error
    }
    messages.push({ role: 'assistant', content })

    const toolUseBlocks = content.filter(
      (block): block is Extract<ContentBlock, { type: 'tool_use' }> => block.type === 'tool_use',
    )

    if (toolUseBlocks.length === 0) {
      // The model is ready to stop — but if the operator sent steering during
      // this last response, don't end the turn: fold it in and keep going.
      if (injectSteering()) continue
      return finish('complete')
    }

    if (verbose) {
      for (const block of toolUseBlocks) writeToolCall(block.name, block.input)
    }
    if (onToolStart) {
      for (const block of toolUseBlocks) onToolStart({ id: block.id, name: block.name, input: block.input })
    }

    // A batch that writes anything invalidates every speculative read: the model
    // must never receive a pre-write snapshot of a file it just changed. When a
    // batch mixes reads and writes, the reads in it also bypass the cache, since
    // within a parallel batch there is no ordering guarantee between them.
    const batchMutates = toolUseBlocks.some((block) => !SPECULABLE_TOOLS.has(block.name))
    if (batchMutates) cache?.invalidate()

    const observed: { name: string; input: Record<string, unknown>; result: string }[] = []

    const toolResults = await runWithConcurrencyLimit(toolUseBlocks, toolBatchConcurrency(toolUseBlocks), async (block) => {
      const tool = toolsByName[block.name]
      const startedAt = Date.now()

      // Cancellation lands mid-batch: a wide read/scan wave may have a dozen
      // calls still queued behind the concurrency limit when the operator hits
      // Ctrl+C. Don't dispatch new tool work once the run is aborted — return a
      // uniform cancelled result so the loop unwinds cleanly instead of
      // finishing the whole batch first.
      if (signal?.aborted) {
        onTool?.({ id: block.id, name: block.name, input: block.input, result: 'Run aborted before this tool ran.', isError: true, durationMs: 0, cached: false, failureClass: 'aborted' })
        return { type: 'tool_result' as const, tool_use_id: block.id, content: 'Run aborted before this tool ran.', is_error: true }
      }

      let resultText = ''
      let isError = false
      let cached = false
      let assessment: ActionAssessment | undefined
      let reservation: ActionReservation | undefined
      let replayed = false
      let failureClass: string | undefined
      let actionHeartbeat: ReturnType<typeof setInterval> | undefined
      let contract: ActionContract | undefined
      let precondition: ContractEvaluation | undefined
      let postcondition: ContractEvaluation | undefined
      const graph = activeGoalGraph()
      const cwd = currentAgent().cwd ?? process.cwd()
      const request = { name: block.name, input: block.input }
      try {
        reservation = graph?.reserveAction(request, activeGoalNode())
        if (reservation?.decision === 'replay') {
          replayed = true
          cached = true
          resultText = reservation.action.result ?? '[replayed completed action]'
        } else if (reservation && reservation.decision !== 'execute') {
          isError = true
          failureClass = reservation.decision === 'human-review' ? 'human-review' : 'authorization'
          // The identical call already failed once, so repeating it verbatim is
          // pointless — but the caller can only route around that if it is told
          // *why* it failed. Dropping the original reason here (as this used to)
          // left an unattended agent flailing: it would retry the same edit,
          // get an opaque "human review required", and burn turns guessing.
          // The idempotency key is derived from the input, so a genuinely
          // different input is a different action and runs normally — which is
          // exactly the advice to give.
          const original = reservation.action.error?.message
          resultText = [
            `This exact ${block.name} call already ${reservation.action.state} earlier in this run, so it was not repeated.`,
            original ? `The original failure was: ${original}` : undefined,
            'Do not retry it unchanged. Re-read the current file or state, then either issue a materially different call (for example, a more specific old_string with more surrounding context) or take a different approach.',
          ].filter(Boolean).join(' ')
        } else {
          const hookDecision = await evaluateToolHooks(activeToolHooks(), request, cwd, activeMode())
          if (!hookDecision.allowed) {
            isError = true
            failureClass = 'authorization'
            resultText = `Development hook ${hookDecision.hookId ? JSON.stringify(hookDecision.hookId) : 'policy'} blocked this action: ${hookDecision.message ?? 'no reason was provided'}`
            if (reservation) graph?.blockAction(reservation.action.id, resultText, false)
          } else {
            contract = contractForAction(request, cwd, reservation?.action.idempotencyKey ?? `ephemeral:${block.name}`)
            precondition = await evaluatePreconditions(contract, cwd, currentAgent().signal)
            if (!precondition.ok) {
              isError = true
              failureClass = contract.failureDisposition
              resultText = `Action precondition failed: ${precondition.failures.join('; ')}${precondition.nextAction ? ` ${precondition.nextAction}` : ''}`
              if (reservation) graph?.blockAction(reservation.action.id, resultText, contract.failureDisposition === 'human-review', precondition, undefined, contract)
            }
            if (!isError) {
              const alreadyApproved = activeGoalGraph()?.isActionApproved(request, activeGoalNode()) ?? false
              const gate = alreadyApproved
                ? { allowed: true, assessment: { ...assessAction(request), decision: 'allow' as const } }
                : await activeActionGovernor().check(request)
              assessment = gate.assessment
              if (!gate.allowed) {
                isError = true
                failureClass = classifyFailure(gate.message ?? gate.assessment.reason).class
                resultText = gate.message ?? `Action blocked by Elia’s autonomy governor: ${gate.assessment.reason}`
                if (reservation && gate.assessment.risk === 'critical') {
                  activeGoalGraph()?.requestApproval('action', reservation.action.idempotencyKey, { name: block.name, input: redactActionInput(block.name, block.input) }, gate.assessment.reason)
                }
                if (reservation) activeGoalGraph()?.blockAction(reservation.action.id, resultText, gate.assessment.risk === 'critical', precondition, undefined, contract)
              } else {
                if (reservation) {
                  graph?.startAction(reservation.action.id, contract, precondition)
                  actionHeartbeat = setInterval(() => {
                    try {
                      graph?.heartbeatAction(reservation!.action.id)
                    } catch {
                      // The action may have finished between timer ticks.
                    }
                  }, 30_000)
                }
                const pending = batchMutates ? undefined : cache?.take(block.name, block.input)
                if (pending) {
                  cached = true
                  resultText = await pending
                } else {
                  if (!tool) throw new Error(`Unknown tool: ${block.name}`)
                  // Serialize the actual file mutation so parallel edits (within
                  // this batch, or from a concurrent turn) can't interleave.
                  resultText = isRepoMutatingTool(block.name)
                    ? await withRepoLock(() => tool.execute(block.input))
                    : await tool.execute(block.input)
                }
                postcondition = contract ? evaluatePostconditions(contract, resultText, cwd) : undefined
                if (postcondition && !postcondition.ok) {
                  isError = true
                  failureClass = contract?.failureDisposition ?? 'retryable'
                  // Keep the tool's real output. This used to replace it outright,
                  // which meant a failing `bun test`/build/typecheck reported *that*
                  // it failed but never *why* — the stdout and stderr carrying the
                  // assertion, stack trace, or compiler error were discarded at
                  // exactly the moment they mattered most. An unattended agent was
                  // then debugging blind: observed live cycling through
                  // `--reporter=json/dot/spec/list` trying to coax out output it
                  // could actually see, and burning its step budget doing it.
                  const failureNote = `Action postcondition failed: ${postcondition.failures.join('; ')}${postcondition.nextAction ? ` ${postcondition.nextAction}` : ''}`
                  resultText = resultText.trim() ? `${failureNote}\n\nActual output:\n${clampOutput(resultText, 8000)}` : failureNote
                  if (reservation) {
                    if (contract?.failureDisposition === 'human-review') graph?.blockAction(reservation.action.id, resultText, true, precondition, postcondition, contract)
                    else graph?.finishAction(reservation.action.id, { ok: false, error: `retryable postcondition failure: ${postcondition.failures.join('; ')}`, postcondition })
                  }
                } else if (reservation) {
                  graph?.finishAction(reservation.action.id, { ok: true, result: resultText, postcondition })
                }
              }
            }
          }
        }
      } catch (err) {
        isError = true
        cached = false
        resultText = err instanceof Error ? err.message : String(err)
        const failure = classifyFailure(err)
        failureClass = failure.class
        if (reservation && reservation.decision === 'execute') graph?.finishAction(reservation.action.id, { ok: false, error: err })
      } finally {
        if (actionHeartbeat) clearInterval(actionHeartbeat)
      }

      const durationMs = Date.now() - startedAt
      if (verbose) writeToolResult(block.name, resultText, isError, cached)
      onTool?.({ id: block.id, name: block.name, input: block.input, result: resultText, isError, durationMs, cached, assessment, actionId: reservation?.action.id, idempotencyKey: reservation?.action.idempotencyKey, replayed, failureClass })
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

    // Resolve routes per call so the ambient provider remains swappable while
    // role-pinned tiers can still supply their own provider and fallback list.
    const active = provider ?? config.provider
    const routes: ProviderRoute[] = [
      {
        provider: active,
        providerName: providerName ?? config.providerName,
        model: model ?? config.model,
        label: `${providerName ?? config.providerName} (${model ?? config.model})`,
      },
      ...(fallbacks ?? (provider ? [] : autoFallbacksFor(config.providerName))),
    ]
    const now = Date.now()
    const healthyRoutes = routes.filter((route) => (providerHealth.get(providerHealthKey(route))?.cooldownUntil ?? 0) <= now)
    const activeRoutes = healthyRoutes.length > 0 ? healthyRoutes : routes
    let emittedOutput = false
    let firstOutputAt: number | undefined
    const noteFirstOutput = () => {
      if (firstOutputAt === undefined) firstOutputAt = Date.now()
    }
    try {
      let lastError: unknown
      for (let routeIndex = 0; routeIndex < activeRoutes.length; routeIndex += 1) {
        const route = activeRoutes[routeIndex]!
        for (let attempt = 1; ; attempt++) {
          const callStartedAt = Date.now()
          firstOutputAt = undefined
          try {
            const result = await streamProvider(route)
            totalUsage = addUsage(totalUsage, result.usage)
            providerHealth.delete(providerHealthKey(route))
            if (profilingEnabled()) {
              recordModelCall({
                callIndex: steps,
                actor: currentAgent().name,
                wallMs: Date.now() - callStartedAt,
                ttftMs: firstOutputAt ? firstOutputAt - callStartedAt : undefined,
                inputTokens: result.usage.inputTokens,
                cacheReadTokens: result.usage.cacheReadTokens,
                cacheWriteTokens: result.usage.cacheWriteTokens,
                outputTokens: result.usage.outputTokens,
                toolCalls: result.content.filter((block) => block.type === 'tool_use').length,
                systemChars: systemPrompt.length,
                dynamicSystemChars: systemDynamicPrompt?.length ?? 0,
                toolDefs: toolDefinitions.length,
                messageCount: messages.length,
              })
            }
            return result.content
          } catch (error) {
            lastError = error
            if (isFallbackableProviderError(error)) {
              const key = providerHealthKey(route)
              const previous = providerHealth.get(key)
              providerHealth.set(key, { failures: (previous?.failures ?? 0) + 1, cooldownUntil: Date.now() + PROVIDER_HEALTH_COOLDOWN_MS, lastError: error instanceof Error ? error.message : String(error) })
            }
            // Retrying after output was emitted would duplicate a partial answer in
            // the terminal. Only route before any output has been emitted.
            if (emittedOutput || !isFallbackableProviderError(error)) throw error
            if (signal?.aborted) throw error

            const nextRoute = activeRoutes[routeIndex + 1]
            if (nextRoute) {
              if (verbose) {
                writeNotice(
                  `provider ${route.label ?? `${route.providerName} (${route.model})`} unavailable; trying ${nextRoute.label ?? `${nextRoute.providerName} (${nextRoute.model})`}`,
                )
              }
              break
            }

            if (attempt >= MAX_PROVIDER_ATTEMPTS) throw error
            await Bun.sleep(250 * 2 ** (attempt - 1))
          }
        }
      }
      throw lastError instanceof Error ? lastError : new Error(String(lastError))
    } finally {
      stopAnimation()
      cursor?.stop()
      if (useAnimation) endTextTurn()
    }

    async function streamProvider(route: ProviderRoute) {
      // A ChatGPT subscription is backed by the separately authenticated Codex
      // CLI, which executes its own workspace tools. Treat that hand-off as one
      // critical, approval-gated action rather than silently bypassing Elia's
      // safety boundary. Normal API providers still return Elia tool calls.
      const delegated = route.providerName === 'codex'
      const request = { name: 'codex_delegate', input: { model: route.model, path: process.cwd() } }
      const startedAt = Date.now()
      let assessment: ActionAssessment | undefined
      if (delegated) {
        const gate = await activeActionGovernor().check(request)
        assessment = gate.assessment
        if (!gate.allowed) throw new Error(gate.message ?? `Codex subscription execution blocked: ${gate.assessment.reason}`)
        if (verbose) writeToolCall(request.name, request.input)
      }

      try {
        const result = await route.provider.streamTurn({
            system: systemPrompt,
            systemDynamic: systemDynamicPrompt,
            messages,
            tools: toolDefinitions,
            onText: (delta) => {
              emittedOutput = true
              noteFirstOutput()
              stopAnimation()
              cursor?.beforeText()
              onText?.(delta)
              cursor?.afterText()
            },
            onThinking: (delta) => {
              // Reasoning is real output too — a retry after some has been shown
              // would duplicate it in the terminal exactly like retrying after text.
              emittedOutput = true
              noteFirstOutput()
              stopAnimation()
              onThinking?.(delta)
            },
            onActivity: onActivity ? (activity) => {
              // Provider activity can include commands and file edits. Once it
              // is visible or actionable, retrying another route could repeat
              // work, so it has the same no-retry boundary as streamed text.
              emittedOutput = true
              noteFirstOutput()
              stopAnimation()
              cursor?.beforeText()
              onActivity?.(activity)
              cursor?.afterText()
            } : undefined,
            signal,
          })
        if (delegated) {
          if (verbose) writeToolResult(request.name, 'Codex completed its workspace run.', false, false, Date.now() - startedAt)
          onTool?.({ name: request.name, input: request.input, result: 'Codex completed its workspace run.', isError: false, durationMs: Date.now() - startedAt, cached: false, assessment })
        }
        return result
      } catch (error) {
        if (delegated) {
          const result = error instanceof Error ? error.message : String(error)
          if (verbose) writeToolResult(request.name, result, true, false, Date.now() - startedAt)
          onTool?.({ name: request.name, input: request.input, result, isError: true, durationMs: Date.now() - startedAt, cached: false, assessment })
        }
        throw error
      }
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

type ToolBatch = Array<{ name: string; input: Record<string, unknown> }>

/**
 * Read-only batches are the dominant reconnaissance path in coding work. They can
 * safely use a larger pool because they do not compete on file mutations, while
 * any batch containing a write or external side effect stays on the conservative
 * default. The environment override is bounded so a fast setting cannot create
 * an unbounded fan-out against a provider or local machine.
 */
export function toolBatchConcurrency(batch: ToolBatch): number {
  const configured = Number.parseInt(process.env.ELIA_TOOL_CONCURRENCY ?? '', 10)
  const requested = Number.isInteger(configured) && configured > 0 ? Math.min(configured, MAX_SAFE_PARALLEL_TOOLS) : MAX_PARALLEL_TOOLS
  if (batch.length === 0) return requested
  return batch.every(isReadOnlyToolCall) ? requested : Math.min(requested, MAX_PARALLEL_TOOLS)
}

function isReadOnlyToolCall(block: { name: string; input: Record<string, unknown> }): boolean {
  if (SPECULABLE_TOOLS.has(block.name)) return true
  if (block.name === 'read_spreadsheet' || block.name === 'web_search' || block.name === 'web_fetch') return true
  if (block.name === 'spreadsheet') return ['inspect', 'analyze', 'audit'].includes(String(block.input.action ?? ''))
  // Browser sessions are shared state: only pure observations may run together.
  // Navigation, scrolling, waits, and verification can race with another page
  // action even when they do not create an external side effect.
  if (block.name === 'browser') return ['status', 'snapshot', 'extract'].includes(String(block.input.action ?? ''))
  if (block.name === 'communication') return ['status', 'inspect', 'list', 'verify'].includes(String(block.input.action ?? ''))
  if (block.name === 'project_profile' || block.name === 'recall' || block.name === 'board_read') return true
  return false
}

function providerHealthKey(route: ProviderRoute): string {
  return `${route.providerName}:${route.model}`
}

export function resetProviderHealthForTests(): void {
  providerHealth.clear()
}

function isFallbackableProviderError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /connection|fetch failed|network|timeout|timed out|rate limit|model (?:not found|unavailable)|not found|404|429|500|502|503|504|server had an error/i.test(
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
