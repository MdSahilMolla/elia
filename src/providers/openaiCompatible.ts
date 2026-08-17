import OpenAI from 'openai'
import type { ChatMessage, ContentBlock, Provider, StreamTurnParams, ToolDefinition, Usage } from './types.ts'

export function createOpenAICompatibleProvider(
  apiKey: string,
  model: string,
  baseURL?: string,
): Provider {
  const client = new OpenAI({ apiKey, baseURL })

  return {
    async streamTurn({ system, messages, tools, onText }: StreamTurnParams) {
      const runner = client.chat.completions
        .stream({
          model,
          messages: toOpenAIMessages(system, messages),
          tools: toOpenAITools(tools),
          // Without this the final streamed response has no usage data at all.
          stream_options: { include_usage: true },
        })
        .on('content', (delta) => onText(delta))

      const completion = await runner.finalChatCompletion()
      const message = completion.choices[0]?.message
      if (!message) {
        throw new Error('Provider returned no message in response')
      }

      const content = toContentBlocks(message)

      // OpenAI-style usage reports prompt_tokens as a total that already
      // *includes* any cached portion, unlike Anthropic's separate counters —
      // so subtract it out to keep inputTokens meaning "non-cached" everywhere.
      const rawUsage = completion.usage
      const cacheReadTokens = rawUsage?.prompt_tokens_details?.cached_tokens ?? 0
      const usage: Usage = {
        inputTokens: Math.max(0, (rawUsage?.prompt_tokens ?? 0) - cacheReadTokens),
        outputTokens: rawUsage?.completion_tokens ?? 0,
        cacheReadTokens,
        cacheWriteTokens: 0,
      }

      return { content, usage }
    },
  }
}

/** The shape this adapter actually depends on, kept loose because "OpenAI-compatible" providers vary. */
export interface CompletionMessageLike {
  content?: string | null
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
export function toContentBlocks(message: CompletionMessageLike): ContentBlock[] {
  const content: ContentBlock[] = []

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

function safeJsonParse(text: string): Record<string, unknown> {
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}
