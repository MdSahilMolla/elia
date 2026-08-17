import Anthropic from '@anthropic-ai/sdk'
import type { ChatMessage, ContentBlock, Provider, StreamTurnParams, Usage } from './types.ts'

const EPHEMERAL_CACHE: Anthropic.CacheControlEphemeral = { type: 'ephemeral' }
// Sonnet 5 supports up to 128k output tokens; this is just a generous ceiling
// (billed by actual usage, not the cap) so large refactors don't get truncated.
const MAX_TOKENS = 32_000

export function createAnthropicProvider(apiKey: string, model: string): Provider {
  const client = new Anthropic({ apiKey })

  return {
    async streamTurn({ system, messages, tools, onText }: StreamTurnParams) {
      const stream = client.messages.stream({
        model,
        max_tokens: MAX_TOKENS,
        // Cache breakpoints (system, tools, tail of history) so an unchanged
        // prefix of an agent loop's growing request is reused turn to turn
        // instead of reprocessed from scratch — this is the biggest lever for
        // both latency and cost in a tool-calling loop.
        system: [{ type: 'text', text: system, cache_control: EPHEMERAL_CACHE }],
        messages: withCacheControlOnTail(messages.map(toAnthropicMessage)),
        tools: withCacheControlOnLastTool(
          tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.input_schema,
          })),
        ),
      })

      stream.on('text', (delta) => onText(delta))

      const finalMessage = await stream.finalMessage()

      const content: ContentBlock[] = []
      for (const block of finalMessage.content) {
        if (block.type === 'text') {
          content.push({ type: 'text', text: block.text })
        } else if (block.type === 'tool_use') {
          content.push({
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: block.input as Record<string, unknown>,
          })
        }
      }

      const usage: Usage = {
        inputTokens: finalMessage.usage.input_tokens,
        outputTokens: finalMessage.usage.output_tokens,
        cacheReadTokens: finalMessage.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: finalMessage.usage.cache_creation_input_tokens ?? 0,
      }

      return { content, usage }
    },
  }
}

function toAnthropicMessage(message: ChatMessage): Anthropic.MessageParam {
  return {
    role: message.role,
    content: message.content.map((block): Anthropic.ContentBlockParam => {
      switch (block.type) {
        case 'text':
          return { type: 'text', text: block.text }
        case 'tool_use':
          return { type: 'tool_use', id: block.id, name: block.name, input: block.input }
        case 'tool_result':
          return {
            type: 'tool_result',
            tool_use_id: block.tool_use_id,
            content: block.content,
            is_error: block.is_error,
          }
      }
    }),
  }
}

/** Marks the last content block of the last message so the (only ever growing) history caches incrementally. */
function withCacheControlOnTail(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  if (messages.length === 0) return messages

  const lastIndex = messages.length - 1
  const lastMessage = messages[lastIndex]!
  const content = lastMessage.content
  if (!Array.isArray(content) || content.length === 0) return messages

  const blockIndex = content.length - 1
  const content_ = [...content]
  content_[blockIndex] = {
    ...content_[blockIndex]!,
    cache_control: EPHEMERAL_CACHE,
  } as Anthropic.ContentBlockParam

  const messages_ = [...messages]
  messages_[lastIndex] = { ...lastMessage, content: content_ }
  return messages_
}

/** Marks the last tool definition so the whole (static) tools block caches. */
function withCacheControlOnLastTool(tools: Anthropic.Tool[]): Anthropic.Tool[] {
  if (tools.length === 0) return tools
  const lastIndex = tools.length - 1
  const tools_ = [...tools]
  tools_[lastIndex] = { ...tools_[lastIndex]!, cache_control: EPHEMERAL_CACHE }
  return tools_
}
