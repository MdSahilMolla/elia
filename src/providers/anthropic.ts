import Anthropic from '@anthropic-ai/sdk'
import type { ChatMessage, ContentBlock, Provider, StreamTurnParams, ThinkingOption, ToolDefinition, Usage } from './types.ts'
import { warmConnection } from './prewarm.ts'

const EPHEMERAL_CACHE: Anthropic.CacheControlEphemeral = { type: 'ephemeral' }
// The stable prefix of an agent-loop request — the system prompt and the tool
// definitions — does not change for the life of a session. A tool call can take
// several minutes (a slow `bun test`, an install), and a user can sit thinking
// for longer, either of which blows the default 5-minute cache TTL and forces
// the whole prefix to be reprocessed on the next call. Pinning the stable
// blocks to the 1-hour TTL keeps them cached across those gaps; the moving tail
// of the conversation stays on the cheaper 5-minute default since it is
// rewritten every step anyway.
const EPHEMERAL_CACHE_1H: Anthropic.CacheControlEphemeral = { type: 'ephemeral', ttl: '1h' }
// Sonnet 5 supports up to 128k output tokens; this is just a generous ceiling
// (billed by actual usage, not the cap) so large refactors don't get truncated.
const MAX_TOKENS = 32_000

export interface AnthropicProviderOptions {
  thinking?: ThinkingOption
}

export function createAnthropicProvider(
  apiKey: string,
  model: string,
  options: AnthropicProviderOptions = {},
): Provider {
  const client = new Anthropic({ apiKey, timeout: 180_000, maxRetries: 0 })
  // undefined = thinking disabled entirely (no request param, no extra max_tokens headroom).
  const thinkingBudget = options.thinking?.enabled ? options.thinking.budgetTokens : undefined

  return {
    prewarm() {
      warmConnection(client.baseURL)
    },

    async streamTurn({ system, systemDynamic, messages, tools, onText, onThinking, onToolBlock, signal }: StreamTurnParams) {
      const stream = client.messages.stream(
        buildAnthropicRequest({ model, thinkingBudget, system, systemDynamic, messages, tools }),
        signal ? { signal } : undefined,
      )

      stream.on('text', (delta) => onText(delta))
      if (thinkingBudget) stream.on('thinking', (delta) => onThinking?.(delta))
      if (onToolBlock) {
        // `content_block_stop` — the block is fully streamed and its input JSON
        // parsed, but the turn is still going. Hand tool_use blocks up now so a
        // read-only call can be started before finalMessage() resolves.
        stream.on('contentBlock', (block) => {
          if (block.type === 'tool_use') {
            onToolBlock({ type: 'tool_use', id: block.id, name: block.name, input: block.input as Record<string, unknown> })
          }
        })
      }

      const finalMessage = await stream.finalMessage()

      const content: ContentBlock[] = []
      for (const block of finalMessage.content) {
        if (block.type === 'text') {
          content.push({ type: 'text', text: block.text })
        } else if (block.type === 'thinking') {
          content.push({ type: 'thinking', text: block.thinking, signature: block.signature })
        } else if (block.type === 'redacted_thinking') {
          content.push({ type: 'redacted_thinking', data: block.data })
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

export interface AnthropicRequestParts {
  model: string
  /** Anthropic extended-thinking budget, or undefined when thinking is off. */
  thinkingBudget?: number
  /** The stable, session-long system prompt. Cached under the 1-hour TTL. */
  system: string
  /**
   * Per-turn dynamic system content (query-ranked memory, mode hints). Sent as
   * a second system block with its own 5-minute breakpoint so it does not bust
   * the stable prefix's cache when it changes between user turns.
   */
  systemDynamic?: string
  messages: ChatMessage[]
  tools: ToolDefinition[]
}

/**
 * Builds the Messages API request, applying all four cache breakpoints:
 * the stable system prompt and the tool block on the 1-hour TTL (they never
 * change in a session), the dynamic system suffix and the tail of the
 * conversation on the default 5-minute TTL (they change every turn). Pure and
 * exported so the breakpoint layout can be asserted without a live API client.
 */
export function buildAnthropicRequest(parts: AnthropicRequestParts): Anthropic.MessageStreamParams {
  const { model, thinkingBudget, system, systemDynamic, messages, tools } = parts

  const systemBlocks: Anthropic.TextBlockParam[] = [{ type: 'text', text: system, cache_control: EPHEMERAL_CACHE_1H }]
  if (systemDynamic && systemDynamic.trim()) {
    systemBlocks.push({ type: 'text', text: systemDynamic, cache_control: EPHEMERAL_CACHE })
  }

  return {
    model,
    // Extended thinking's budget counts toward max_tokens, so the ceiling has
    // to clear the budget with real room left for the answer itself.
    max_tokens: thinkingBudget ? Math.max(MAX_TOKENS, thinkingBudget + 8_000) : MAX_TOKENS,
    ...(thinkingBudget ? { thinking: { type: 'enabled' as const, budget_tokens: thinkingBudget } } : {}),
    system: systemBlocks,
    messages: withCacheControlOnTail(messages.map(toAnthropicMessage)),
    tools: withCacheControlOnLastTool(
      tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.input_schema as Anthropic.Tool.InputSchema,
      })),
    ),
  }
}

export function toAnthropicMessage(message: ChatMessage): Anthropic.MessageParam {
  return {
    role: message.role,
    content: message.content.map((block): Anthropic.ContentBlockParam => {
      switch (block.type) {
        case 'text':
          return { type: 'text', text: block.text }
        case 'thinking':
          // Must be replayed back byte-for-byte with its original signature — Anthropic
          // rejects a tampered or resynthesized thinking block in an extended-thinking turn.
          return { type: 'thinking', thinking: block.text, signature: block.signature }
        case 'redacted_thinking':
          return { type: 'redacted_thinking', data: block.data }
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

/**
 * Marks the last tool definition so the whole (static) tools block caches. The
 * tool set is fixed for the life of a session, so it gets the 1-hour TTL — a
 * slow tool call or a long pause between user turns must not evict it.
 */
function withCacheControlOnLastTool(tools: Anthropic.Tool[]): Anthropic.Tool[] {
  if (tools.length === 0) return tools
  const lastIndex = tools.length - 1
  const tools_ = [...tools]
  tools_[lastIndex] = { ...tools_[lastIndex]!, cache_control: EPHEMERAL_CACHE_1H }
  return tools_
}
