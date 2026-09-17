import OpenAI from 'openai'
import type { ChatMessage, ContentBlock, Provider, StreamTurnParams, ThinkingOption, ToolDefinition, Usage } from './types.ts'
import { validateNetworkUrl } from '../networkPolicy.ts'
import { warmConnection } from './prewarm.ts'
import { geminiFetch } from './geminiStream.ts'

export interface OpenAICompatibleProviderOptions {
  thinking?: ThinkingOption
  /**
   * Ask the endpoint for a summary of its reasoning. Inception's Mercury
   * reasons before every answer (hundreds of `reasoning_tokens` a step) but
   * returns none of it unless the request sets `reasoning_summary`, and then
   * only as a top-level `reasoning_summary: { content, status }` on the final
   * chunk — never as a streamed delta. Other endpoints reject the unknown flag,
   * so it is only sent where the registry knows it is understood.
   */
  reasoningSummary?: boolean
  /** The endpoint takes Inception's per-request `reasoning_effort` (instant/low/medium/high). */
  reasoningEffort?: boolean
  /**
   * Google's OpenAI-compatible Gemini endpoint. Two things differ there: a
   * Gemini 3 tool call carries a `thought_signature` that must be sent back
   * with it or the next step is refused (HTTP 400), and its thoughts are only
   * returned when asked for — inline in `content`, wrapped in `<thought>` tags.
   */
  gemini?: boolean
}

/**
 * Google's documented stand-in for a tool call that has no signature of its own
 * — one made by another provider before a fallback or `/model` switch landed on
 * Gemini. Without it that history is refused outright.
 */
export const GEMINI_SKIP_SIGNATURE = 'skip_thought_signature_validator'

// A generous ceiling on a single response (billed by actual usage, not the cap)
// so a runaway generation can't rack up unbounded cost or block the turn
// indefinitely. Mirrors the Anthropic provider's MAX_TOKENS. `max_tokens` is the
// field every OpenAI-compatible endpoint in scope here (Groq, DeepSeek, …)
// understands; the newer `max_completion_tokens` is not universally supported.
const MAX_TOKENS = 32_000

/**
 * How long a started response may go without sending anything before it counts
 * as stalled. The SDK's own request timeout stops at the response headers, so a
 * body that stops arriving was waited on forever: a turn on a rate-limited free
 * OpenRouter model sat for half an hour, and fallback never got its turn.
 */
export function streamIdleMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.ELIA_STREAM_IDLE_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 120_000
}

export function createOpenAICompatibleProvider(
  apiKey: string,
  model: string,
  baseURL?: string,
  options: OpenAICompatibleProviderOptions = {},
): Provider {
  const allowExplicitLocal = process.env.ELIA_ALLOW_INSECURE_LOCAL_ENDPOINT === '1'
  const validatedBaseURL = baseURL
    ? validateNetworkUrl(baseURL, { allowExplicitLocal, requireHttps: true }).toString()
    : baseURL
  const client = new OpenAI({ apiKey, baseURL: validatedBaseURL, timeout: 180_000, maxRetries: 1, ...(options.gemini ? { fetch: geminiFetch() } : {}) })
  // Reasoning-capable OpenAI-compatible models (Groq's gpt-oss, DeepSeek's API,
  // others) emit reasoning as a non-standard `reasoning`/`reasoning_content`
  // field with no enable/disable request param — there is nothing to toggle in
  // the request itself, only whether elia surfaces what the model already sends.
  const passthroughReasoning = options.thinking?.enabled ?? true
  // `reasoning_summary_wait` holds the final chunk until the summary is ready;
  // without it the summary is routinely "unavailable" by the time the answer ends.
  const summaryParams: Record<string, unknown> = passthroughReasoning && options.reasoningSummary
    ? { reasoning_summary: true, reasoning_summary_wait: true }
    : {}
  const geminiThoughts = Boolean(options.gemini && passthroughReasoning)
  const thoughtParams: Record<string, unknown> = geminiThoughts
    ? { extra_body: { google: { thinking_config: { include_thoughts: true } } } }
    : {}
  const wire: WireOptions = { gemini: Boolean(options.gemini), geminiThoughts }

  return {
    prewarm() {
      warmConnection(validatedBaseURL ?? client.baseURL)
    },

    async streamTurn({ system, systemDynamic, messages, tools, onText, onThinking, onToolBlock, signal, reasoningEffort }: StreamTurnParams) {
      // The stable prompt stays first so an OpenAI-compatible endpoint's
      // automatic prefix caching still matches on it; the per-turn dynamic
      // suffix follows it.
      const fullSystem = systemDynamic && systemDynamic.trim() ? `${system}\n\n${systemDynamic}` : system
      const openAITools = toOpenAITools(tools)
      const requestParams: Record<string, unknown> = {
        ...summaryParams,
        ...thoughtParams,
        ...(options.reasoningEffort && reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      }
      // Tracks whether the caller's callbacks have already surfaced any part of
      // this response before a streaming failure. Only a completely silent
      // stream (nothing emitted yet) is safe to silently retry non-streaming and
      // replay below — replaying after real content already reached the caller
      // would double-send it. See the catch block below.
      let emittedContent = false
      const thoughts = geminiThoughts ? createThoughtSplitter() : undefined
      const idleMs = streamIdleMs()
      const stall = new AbortController()
      let idleTimer: ReturnType<typeof setTimeout> | undefined
      const stillAlive = () => {
        if (idleTimer) clearTimeout(idleTimer)
        idleTimer = setTimeout(() => stall.abort(), idleMs)
      }
      stillAlive()
      const streamSignal = signal ? AbortSignal.any([signal, stall.signal]) : stall.signal
      const runner = client.chat.completions
        .stream({
          model,
          max_tokens: MAX_TOKENS,
          messages: toOpenAIMessages(fullSystem, messages, wire),
          tools: openAITools,
          // Let the model emit several tool calls in one response so elia can run
          // them in parallel — the single biggest lever on agent wall-clock is
          // fewer model round-trips. Only sent when tools are actually offered;
          // some endpoints reject the field on a tool-less request.
          ...(openAITools.length > 0 ? { parallel_tool_calls: true } : {}),
          // Without this the final streamed response has no usage data at all.
          stream_options: { include_usage: true },
          ...requestParams,
        }, { signal: streamSignal })
        .on('chunk', stillAlive)
        .on('content', (delta) => {
          // Empty content chunks are keepalive/role noise, not output. Passing
          // them on breaks transcript accumulation downstream (see
          // ui/app/store.ts assistantDelta), so they stop here.
          if (!delta) return
          emittedContent = true
          if (!thoughts) return onText(delta)
          for (const part of thoughts.feed(delta)) {
            if (part.thought) onThinking?.(part.text)
            else onText(part.text)
          }
        })

      if (onToolBlock) {
        // A tool call has finished streaming its arguments while the rest of the
        // turn is still generating — hand it up so a read-only call can start now.
        runner.on('tool_calls.function.arguments.done', (event) => {
          let input: Record<string, unknown>
          try {
            input = event.arguments ? (JSON.parse(event.arguments) as Record<string, unknown>) : {}
          } catch {
            return
          }
          if (input && typeof input === 'object') {
            emittedContent = true
            onToolBlock({ type: 'tool_use', id: `stream_${event.index}`, name: event.name, input })
          }
        })
      }

      // The SDK's accumulated message never carries `reasoning_summary` (it is
      // a sibling of `choices`, not part of the message), so it is kept here.
      let summary = ''
      // The SDK keeps a non-standard delta field by overwriting it chunk by
      // chunk, so its final message holds only the last reasoning fragment.
      let reasoningText = ''
      if (passthroughReasoning) {
        runner.on('chunk', (chunk) => {
          // The reasoning field is non-standard, so the SDK's delta type has no
          // overlap with it at all — an explicit cast, not just a loose param type.
          const delta = chunk.choices?.[0]?.delta as
            | { reasoning?: string | null; reasoning_content?: string | null }
            | undefined
          const reasoning = readReasoning(delta)
          if (reasoning) {
            emittedContent = true
            reasoningText += reasoning
            onThinking?.(reasoning)
          }
          const summarised = readReasoningSummary(chunk)
          if (summarised && !summary) {
            summary = summarised
            emittedContent = true
            onThinking?.(summarised)
          }
        })
      }

      try {
        const completion = await runner.finalChatCompletion().catch((error: unknown) => {
          // Worded to read as a timeout, which is what routes to the next provider.
          if (stall.signal.aborted && !signal?.aborted) throw new Error(`response stalled: nothing arrived for ${Math.round(idleMs / 1000)}s (timed out)`)
          throw error
        })
        const message = completion.choices[0]?.message
        if (!message) {
          throw new Error('Provider returned no message in response')
        }
        const streamed: CompletionMessageLike = reasoningText ? { ...message, reasoning: reasoningText, reasoning_content: undefined } : message
        return { content: withReasoningSummary(toContentBlocks(streamed, passthroughReasoning, wire), summary), usage: usageFrom(completion.usage) }
      } catch (err) {
        // The non-streaming fallback below re-issues the whole request and
        // replays the full response through onText/onThinking — safe only when
        // the failed stream emitted nothing yet. If it already emitted partial
        // content, silently retrying here would double-send that content (and
        // could execute a second, different set of tool calls); propagate the
        // original error instead so the caller's own retry/dedup logic (the
        // `emittedOutput` guard in agentLoop.ts) handles it at the right layer.
        if (!isStreamingUnsupported(err) || emittedContent) throw err
        const completion = await client.chat.completions.create({
          model,
          max_tokens: MAX_TOKENS,
          messages: toOpenAIMessages(fullSystem, messages, wire),
          tools: openAITools,
          ...(openAITools.length > 0 ? { parallel_tool_calls: true } : {}),
          stream: false,
          ...requestParams,
        }, signal ? { signal } : undefined)
        const message = completion.choices[0]?.message
        if (!message) throw new Error('Provider returned no message in non-streaming response')
        const content = withReasoningSummary(
          toContentBlocks(message, passthroughReasoning, wire),
          passthroughReasoning ? (readReasoningSummary(completion) ?? '') : '',
        )
        for (const block of content) {
          if (block.type === 'thinking') onThinking?.(block.text)
          if (block.type === 'text') onText(block.text)
        }
        return { content, usage: usageFrom(completion.usage) }
      } finally {
        if (idleTimer) clearTimeout(idleTimer)
      }
    },
  }
}

/** The shape this adapter actually depends on, kept loose because "OpenAI-compatible" providers vary. */
export interface CompletionMessageLike {
  content?: string | null
  /** Non-standard reasoning fields — Groq's gpt-oss models use `reasoning`, DeepSeek-style APIs use `reasoning_content`. */
  reasoning?: string | null
  reasoning_content?: string | null
  tool_calls?: (
    | {
        id?: string
        type?: string
        function?: { name?: string; arguments?: string }
        /** Gemini's `{ google: { thought_signature } }`. */
        extra_content?: unknown
      }
    | undefined
    | null
  )[]
}

/**
 * Converts one provider response into content blocks, tolerating the ways real
 * OpenAI-compatible endpoints deviate from the schema.
 *
 * The important case is a sparse `tool_calls` array. The SDK accumulates streamed
 * tool calls into an array indexed by the provider's own `index` field, so a
 * provider that emits those indices out of order or skips one — which happens with
 * parallel tool calls — leaves real holes in it. Indexing into those holes used to
 * throw and take down the whole turn. A malformed entry is dropped instead: the
 * model sees the tool it asked for produce nothing and can retry, which is
 * recoverable in a way that a crashed agent loop is not.
 */
export function toContentBlocks(message: CompletionMessageLike, includeReasoning = true, wire: WireOptions = {}): ContentBlock[] {
  const content: ContentBlock[] = []

  const reasoning = includeReasoning ? (message.reasoning ?? message.reasoning_content) : undefined
  if (reasoning) content.push({ type: 'thinking', text: reasoning, signature: '' })

  if (message.content && wire.geminiThoughts) {
    const splitter = createThoughtSplitter()
    const pieces = [...splitter.feed(message.content), ...splitter.flush()]
    const thought = pieces.filter((piece) => piece.thought).map((piece) => piece.text).join('')
    const text = pieces.filter((piece) => !piece.thought).map((piece) => piece.text).join('')
    if (thought && includeReasoning) content.push({ type: 'thinking', text: thought, signature: '' })
    if (text) content.push({ type: 'text', text })
  } else if (message.content) {
    content.push({ type: 'text', text: message.content })
  }

  for (const [index, toolCall] of (message.tool_calls ?? []).entries()) {
    if (!toolCall || (toolCall.type !== undefined && toolCall.type !== 'function')) continue
    const name = toolCall.function?.name
    if (!name) continue
    content.push({
      type: 'tool_use',
      // Some providers omit the id. It only has to be unique within this turn,
      // since it is what the matching tool_result refers back to.
      id: toolCall.id || `call_${index}`,
      name,
      input: safeJsonParse(toolCall.function?.arguments ?? ''),
      ...(isRecord(toolCall.extra_content) ? { extra: { extra_content: toolCall.extra_content } } : {}),
    })
  }

  return content
}

export interface WireOptions {
  /** Talking to Gemini: send tool-call signatures back (see GEMINI_SKIP_SIGNATURE). */
  gemini?: boolean
  /** Gemini was asked for its thoughts, so `content` carries `<thought>` spans. */
  geminiThoughts?: boolean
}

export function toOpenAIMessages(
  system: string,
  messages: ChatMessage[],
  wire: WireOptions = {},
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const result: OpenAI.Chat.ChatCompletionMessageParam[] = [{ role: 'system', content: system }]

  for (const message of messages) {
    if (message.role === 'assistant') {
      const textParts = message.content.filter(
        (b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text',
      )
      const toolUseBlocks = message.content.filter(
        (b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use',
      )

      result.push({
        role: 'assistant',
        content: textParts.length > 0 ? textParts.map((b) => b.text).join('') : null,
        ...(toolUseBlocks.length > 0
          ? {
              tool_calls: toolUseBlocks.map((b, index) => ({
                id: b.id,
                type: 'function' as const,
                function: { name: b.name, arguments: JSON.stringify(b.input) },
                // Only Gemini gets these back: other endpoints reject a field
                // they do not know. Gemini checks the first call of each step,
                // so that one always carries a signature.
                ...(wire.gemini ? geminiToolCallExtra(b.extra, index === 0) : {}),
              })),
            }
          : {}),
      })
      continue
    }

    const textParts = message.content.filter(
      (b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text',
    )
    const imageParts = message.content.filter(
      (b): b is Extract<ContentBlock, { type: 'image' }> => b.type === 'image',
    )
    if (imageParts.length > 0) {
      // Chat Completions vision format: images and text as typed parts. Data
      // URLs keep it self-contained — no separate upload step.
      const parts: OpenAI.Chat.ChatCompletionContentPart[] = [
        ...imageParts.map((b) => ({
          type: 'image_url' as const,
          image_url: { url: `data:${b.mediaType};base64,${b.data}` },
        })),
        ...(textParts.length > 0 ? [{ type: 'text' as const, text: textParts.map((b) => b.text).join('') }] : []),
      ]
      result.push({ role: 'user', content: parts })
    } else if (textParts.length > 0) {
      result.push({ role: 'user', content: textParts.map((b) => b.text).join('') })
    }

    const toolResults = message.content.filter(
      (b): b is Extract<ContentBlock, { type: 'tool_result' }> => b.type === 'tool_result',
    )
    for (const block of toolResults) {
      result.push({ role: 'tool', tool_call_id: block.tool_use_id, content: block.content })
    }
  }

  return result
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function geminiToolCallExtra(extra: Record<string, unknown> | undefined, first: boolean): Record<string, unknown> {
  const own = extra?.extra_content
  const google = isRecord(own) && isRecord(own.google) ? own.google : undefined
  if (google && typeof google.thought_signature === 'string') return { extra_content: own }
  return first ? { extra_content: { google: { thought_signature: GEMINI_SKIP_SIGNATURE } } } : {}
}

export interface ThoughtPiece {
  text: string
  thought: boolean
}

const THOUGHT_OPEN = '<thought>'
const THOUGHT_CLOSE = '</thought>'

/**
 * Splits Gemini's streamed `content` into thought and answer. A tag can arrive
 * cut across two chunks, so a tail that could still become one is held back
 * until the next chunk (or `flush`) settles it.
 */
export function createThoughtSplitter(): { feed(chunk: string): ThoughtPiece[]; flush(): ThoughtPiece[] } {
  let inThought = false
  let pending = ''
  return {
    feed(chunk) {
      let rest = pending + chunk
      pending = ''
      const pieces: ThoughtPiece[] = []
      while (rest) {
        const tag = inThought ? THOUGHT_CLOSE : THOUGHT_OPEN
        const at = rest.indexOf(tag)
        if (at >= 0) {
          if (at > 0) pieces.push({ text: rest.slice(0, at), thought: inThought })
          inThought = !inThought
          rest = rest.slice(at + tag.length)
          continue
        }
        let keep = 0
        for (let length = Math.min(tag.length - 1, rest.length); length > 0; length -= 1) {
          if (tag.startsWith(rest.slice(-length))) {
            keep = length
            break
          }
        }
        const emit = rest.slice(0, rest.length - keep)
        if (emit) pieces.push({ text: emit, thought: inThought })
        pending = rest.slice(rest.length - keep)
        rest = ''
      }
      return pieces
    },
    flush() {
      const text = pending
      pending = ''
      return text ? [{ text, thought: inThought }] : []
    },
  }
}

function toOpenAITools(tools: ToolDefinition[]): OpenAI.Chat.ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }))
}

function usageFrom(rawUsage: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | null | undefined): Usage {
  // OpenAI-style usage reports prompt_tokens as a total that already includes
  // any cached portion, unlike Anthropic's separate counters.
  const cacheReadTokens = rawUsage?.prompt_tokens_details?.cached_tokens ?? 0
  return {
    inputTokens: Math.max(0, (rawUsage?.prompt_tokens ?? 0) - cacheReadTokens),
    outputTokens: rawUsage?.completion_tokens ?? 0,
    cacheReadTokens,
    cacheWriteTokens: 0,
  }
}

function isStreamingUnsupported(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error)
  return /streaming is not supported|stream is not supported|request ended without sending any chunks/i.test(text)
}

/**
 * The text of a Mercury-style `reasoning_summary` on a chunk or completion.
 * Mercury sends the key on every chunk, as `null` until (and unless) a summary
 * exists, and a model that has no summary to give reports `null` throughout.
 */
export function readReasoningSummary(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const summary = (payload as { reasoning_summary?: unknown }).reasoning_summary
  if (!summary || typeof summary !== 'object') return undefined
  const content = (summary as { content?: unknown }).content
  return typeof content === 'string' && content.trim() ? content.trim() : undefined
}

/** Records a reasoning summary as the turn's thinking block, unless the model already streamed its own reasoning. */
function withReasoningSummary(content: ContentBlock[], summary: string): ContentBlock[] {
  if (!summary || content.some((block) => block.type === 'thinking')) return content
  return [{ type: 'thinking', text: summary, signature: '' }, ...content]
}

/** Pulls a reasoning fragment off a raw streamed delta, tolerating either non-standard field name. */
function readReasoning(
  delta: { reasoning?: string | null; reasoning_content?: string | null } | null | undefined,
): string | undefined {
  const value = delta?.reasoning ?? delta?.reasoning_content
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function safeJsonParse(text: string): Record<string, unknown> {
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}
