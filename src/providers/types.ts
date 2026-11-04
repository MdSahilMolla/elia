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
  /**
   * `extra` is provider data that has to travel back with the call on the next
   * request — Gemini 3's `extra_content.google.thought_signature`, without which
   * it refuses the following step (HTTP 400).
   */
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown>; extra?: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error: boolean }
  /**
   * An image the user attached to a prompt (a pasted/dragged screenshot, or
   * `/attach <path>`). `data` is the raw file base64-encoded; `mediaType` is one
   * of the four types every vision-capable provider accepts. `alt` is an
   * optional human label (usually the original filename) shown in the transcript
   * and forwarded to providers that can't take images so the model still knows
   * one was sent. Only ever appears on a `user` message.
   */
  | { type: 'image'; mediaType: ImageMediaType; data: string; alt?: string }

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

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
  /** Bound task workspace. Providers must use this rather than process.cwd(). */
  cwd: string
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
  /**
   * How hard this one request should deliberate, for providers with a
   * per-request effort knob (Inception's Mercury). A hint: providers without
   * one ignore it. elia's own short side-calls — drafting a plan, distilling a
   * lesson — ask for `low`, which on mercury-2.5 cut planning from ~3–5 s to
   * ~1.5 s with plans of the same quality.
   */
  reasoningEffort?: 'instant' | 'low' | 'medium' | 'high'
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
  /** Every cache write, whatever its lifetime. */
  cacheWriteTokens: number
  /**
   * The part of `cacheWriteTokens` written with a 1-hour lifetime. Those cost 2×
   * input rather than the 1.25× of a 5-minute write, and the Anthropic provider
   * writes both kinds — its stable system prompt and tools at 1 hour, the
   * per-turn prompt and history at 5 minutes. Optional and 0 when absent, so a
   * provider that does not report the split is priced exactly as before.
   */
  cacheWrite1hTokens?: number
}

/** User-visible progress emitted by agentic providers while a turn is running. */
export interface ProviderActivity {
  kind: 'turn' | 'plan' | 'command' | 'command_output' | 'file_change' | 'diff' | 'tool' | 'model' | 'warning' | 'status'
  title: string
  detail?: string
  status?: 'started' | 'updated' | 'completed' | 'failed' | 'warning'
  /** `plan` only: plan steps elia just ticked on evidence, each with what proved it. */
  evidence?: Record<string, string>
}

export interface Provider {
  /** `truncated`: the provider stopped at its output limit, so the response (and any tool call it ends in) is incomplete. */
  streamTurn(params: StreamTurnParams): Promise<{ content: ContentBlock[]; usage: Usage; truncated?: boolean }>
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
  /**
   * Optional: forget any conversation state the provider keeps on its own side
   * (the ChatGPT subscription's Codex thread). Called after `/clear` or
   * `/compact` rewrites the history, so the next turn starts from Elia's
   * messages instead of the provider's stale copy.
   */
  resetConversation?(): void
  /**
   * Optional: names of tools this provider's model should not be offered right
   * now, because every definition costs it prompt it reads slowly (a local
   * model). The agent loop leaves them out and tells the model which.
   */
  omitTools?(): ReadonlySet<string>
}
