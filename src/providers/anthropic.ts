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

/**
 * Models that take *adaptive* thinking rather than a fixed token budget.
 *
 * `thinking: { type: 'enabled', budget_tokens: N }` is rejected with a 400 on
 * Claude 5 and the Opus 4.7/4.8 family, and deprecated on 4.6 — which means the
 * shape elia used to send unconditionally failed every single turn on
 * `claude-sonnet-5`, its own default Anthropic model. Depth is expressed with
 * `output_config.effort` there instead. Older models (Haiku 4.5, Sonnet 4.5 and
 * earlier) still require the budget form, so both shapes have to be supported.
 */
const ADAPTIVE_THINKING = /^claude-(?:fable-5|mythos-5|opus-5|opus-4-[678]|sonnet-5|sonnet-4-6)/

/** elia's token budget mapped onto the effort levels adaptive thinking uses. */
function effortForBudget(budget: number): NonNullable<NonNullable<Anthropic.MessageStreamParams['output_config']>['effort']> {
  if (budget <= 2048) return 'low'
  if (budget <= 8192) return 'medium'
  if (budget <= 24_576) return 'high'
  return 'xhigh'
}

/**
 * The `thinking`/`output_config`/`max_tokens` fields for one model.
 *
 * Exported so the request shape can be asserted per model without a live client
 * — the 400 this prevents is invisible until a real call is made.
 */
export function thinkingParamsFor(
  model: string,
  thinkingBudget: number | undefined,
): Pick<Anthropic.MessageStreamParams, 'thinking' | 'max_tokens' | 'output_config'> {
  if (!thinkingBudget) return { max_tokens: MAX_TOKENS }
  if (ADAPTIVE_THINKING.test(model.trim().toLowerCase())) {
    return {
      max_tokens: MAX_TOKENS,
      // `display` defaults to "omitted" on these models, which streams thinking
      // blocks with empty text — elia shows reasoning, so ask for the summary.
      thinking: { type: 'adaptive', display: 'summarized' } as Anthropic.ThinkingConfigParam,
      output_config: { effort: effortForBudget(thinkingBudget) },
    }
  }
  return {
    // Extended thinking's budget counts toward max_tokens, so the ceiling has
    // to clear the budget with real room left for the answer itself.
    max_tokens: Math.max(MAX_TOKENS, thinkingBudget + 8_000),
    thinking: { type: 'enabled', budget_tokens: thinkingBudget },
  }
}

export interface AnthropicProviderOptions {
  thinking?: ThinkingOption
}

export function createAnthropicProvider(
  apiKey: string,
  model: string,
  options: AnthropicProviderOptions = {},
): Provider {
  // The agent loop has its own 3-attempt retry with provider fallback, but it
  // gives up the moment any token has streamed (see agentLoop's `emittedOutput`
  // guard) — so a 429 or 529 mid-stream was simply fatal. One SDK-level retry
  // covers the pre-stream case cheaply without fighting the loop's own logic.
  const client = new Anthropic({ apiKey, timeout: 180_000, maxRetries: 1 })
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
    ...thinkingParamsFor(model, thinkingBudget),
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
        case 'image':
          return {
            type: 'image',
            source: { type: 'base64', media_type: block.mediaType, data: block.data },
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
