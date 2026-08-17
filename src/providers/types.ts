export type ContentBlock =
  | { type: 'text'; text: string }
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
