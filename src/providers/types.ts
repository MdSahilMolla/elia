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
  /**
   * The stable system prompt — fixed for the whole session. Providers that
   * support prompt caching pin this to their longest cache TTL so a slow tool
   * call or a long pause between user turns does not force it to be reprocessed.
   */
  system: string
  /**
   * Optional per-turn system content that changes between user turns (e.g.
   * query-ranked project memory). Kept separate from `system` so it does not
   * invalidate the cached stable prefix; providers append it right after
   * `system` with its own shorter-lived cache breakpoint.
   */
  systemDynamic?: string
  messages: ChatMessage[]
  tools: ToolDefinition[]
  onText: (delta: string) => void
  /** Streamed reasoning, when the provider/model produces any. Never guaranteed to fire. */
  onThinking?: (delta: string) => void
  /**
   * Fires with each fully-formed content block the moment the provider finishes
   * streaming it — before the turn as a whole completes. The agent loop uses
   * this to start a read-only `tool_use` call speculatively while the model is
   * still generating the rest of the message, so the tool phase is already done
   * (or in flight) by the time the turn ends. Only providers that stream block
   * boundaries emit it; a `tool_use` block's `input` is the fully parsed JSON.
   */
  onToolBlock?: (block: ContentBlock) => void
  /** Structured progress from agentic providers (plans, commands, edits, and runtime status). */
  onActivity?: (activity: ProviderActivity) => void
  /** Abort the in-flight provider request when the owning run is cancelled. */
  signal?: AbortSignal
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

/** User-visible progress emitted by agentic providers while a turn is running. */
export interface ProviderActivity {
  kind: 'turn' | 'plan' | 'command' | 'command_output' | 'file_change' | 'diff' | 'tool' | 'model' | 'warning' | 'status'
  title: string
  detail?: string
  status?: 'started' | 'updated' | 'completed' | 'failed' | 'warning'
}

export interface Provider {
  streamTurn(params: StreamTurnParams): Promise<{ content: ContentBlock[]; usage: Usage }>
  /**
   * Optional, fire-and-forget: open a connection to the provider's host before
   * the first real request needs it, so that request doesn't pay DNS + TLS +
   * HTTP/2 setup (typically 150–400 ms) on its critical path. Called once at
   * startup while the user is still reading the intro / typing. Never throws,
   * never awaited, and a failure is silently ignored — it is pure latency
   * hygiene, not a health check. `hint.system` carries the resolved session
   * system prompt when the caller knows it, so an agentic provider can also
   * pre-establish a session/thread keyed on it.
   */
  prewarm?(hint?: { system?: string }): void
}
