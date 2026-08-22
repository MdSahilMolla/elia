export type ContentBlock =
  | { type: 'text'; text: string }
  /**
   * The model's private reasoning, shown to the user before its answer/tool
   * calls. `signature` is Anthropic's cryptographic proof the block is
   * unmodified — required to replay it back in later turns of an extended-
   * thinking conversation. Providers that only pass through a reasoning field
   * (no signature scheme) leave it `''`; such blocks are never sent to Anthropic.
   */
  | { type: 'thinking'; text: string; signature: string }
  /** A thinking block Anthropic redacted for safety; opaque, but must still round-trip verbatim. */
  | { type: 'redacted_thinking'; data: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error: boolean }

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: ContentBlock[]
}

export interface ToolDefinition {
  name: string
  description: string
  input_schema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
}

export interface StreamTurnParams {
  system: string
  messages: ChatMessage[]
  tools: ToolDefinition[]
  onText: (delta: string) => void
  /** Streamed reasoning, when the provider/model produces any. Never guaranteed to fire. */
  onThinking?: (delta: string) => void
}

/** Whether extended thinking / reasoning is requested for a provider instance, and how much budget to give it. */
export interface ThinkingOption {
  enabled: boolean
  /** Anthropic's `budget_tokens` — ignored by providers that don't take an explicit budget. */
  budgetTokens: number
}

/**
 * Token usage for one request. `inputTokens` is always the *non-cached*
 * portion — Anthropic reports it that way natively, and the OpenAI-compatible
 * adapter subtracts `cacheReadTokens` out of the raw prompt token count so
 * cost math is uniform across providers regardless of who reports what.
 */
export interface Usage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export interface Provider {
  streamTurn(params: StreamTurnParams): Promise<{ content: ContentBlock[]; usage: Usage }>
}
