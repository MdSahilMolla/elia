import OpenAI from 'openai'
import type { ChatMessage, ContentBlock, Provider, StreamTurnParams, ThinkingOption, ToolDefinition, Usage } from './types.ts'
import { validateNetworkUrl } from '../networkPolicy.ts'

export interface OpenAICompatibleProviderOptions {
  thinking?: ThinkingOption
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
  const client = new OpenAI({ apiKey, baseURL: validatedBaseURL, timeout: 180_000, maxRetries: 0 })
  // Reasoning-capable OpenAI-compatible models (Groq's gpt-oss, DeepSeek's API,
  // others) emit reasoning as a non-standard `reasoning`/`reasoning_content`
  // field with no enable/disable request param — there is nothing to toggle in
  // the request itself, only whether elia surfaces what the model already sends.
  const passthroughReasoning = options.thinking?.enabled ?? true

  return {
    async streamTurn({ system, messages, tools, onText, onThinking, signal }: StreamTurnParams) {
      const runner = client.chat.completions
        .stream({
          model,
          messages: toOpenAIMessages(system, messages),
          tools: toOpenAITools(tools),
          // Without this the final streamed response has no usage data at all.
          stream_options: { include_usage: true },
        }, signal ? { signal } : undefined)
        .on('content', (delta) => onText(delta))

      if (passthroughReasoning) {
        runner.on('chunk', (chunk) => {
          // The reasoning field is non-standard, so the SDK's delta type has no
          // overlap with it at all — an explicit cast, not just a loose param type.
          const delta = chunk.choices?.[0]?.delta as
            | { reasoning?: string | null; reasoning_content?: string | null }
            | undefined
          const reasoning = readReasoning(delta)
          if (reasoning) onThinking?.(reasoning)
        })
      }

      try {
        const completion = await runner.finalChatCompletion()
        const message = completion.choices[0]?.message
        if (!message) {
          throw new Error('Provider returned no message in response')
        }
        return { content: toContentBlocks(message, passthroughReasoning), usage: usageFrom(completion.usage) }
      } catch (err) {
        if (!isStreamingUnsupported(err)) throw err
        const completion = await client.chat.completions.create({
          model,
          messages: toOpenAIMessages(system, messages),
          tools: toOpenAITools(tools),
          stream: false,
        }, signal ? { signal } : undefined)
        const message = completion.choices[0]?.message
        if (!message) throw new Error('Provider returned no message in non-streaming response')
        const content = toContentBlocks(message, passthroughReasoning)
        for (const block of content) {
          if (block.type === 'thinking') onThinking?.(block.text)
          if (block.type === 'text') onText(block.text)
        }
        return { content, usage: usageFrom(completion.usage) }
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
export function toContentBlocks(message: CompletionMessageLike, includeReasoning = true): ContentBlock[] {
  const content: ContentBlock[] = []

  const reasoning = includeReasoning ? (message.reasoning ?? message.reasoning_content) : undefined
  if (reasoning) content.push({ type: 'thinking', text: reasoning, signature: '' })

  if (message.content) content.push({ type: 'text', text: message.content })

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
    })
  }

  return content
}

function toOpenAIMessages(
  system: string,
  messages: ChatMessage[],
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
              tool_calls: toolUseBlocks.map((b) => ({
                id: b.id,
                type: 'function' as const,
                function: { name: b.name, arguments: JSON.stringify(b.input) },
              })),
            }
          : {}),
      })
      continue
    }

    const textParts = message.content.filter(
      (b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text',
    )
    if (textParts.length > 0) {
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
