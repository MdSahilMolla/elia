/**
 * How much conversation elia is willing to hold before it compacts.
 *
 * This used to be one hardcoded number — 30,000 estimated tokens — applied to
 * every model on every provider. It was set that low for a good reason (elia is
 * multi-provider, and a configurable model can have a very small window), but
 * the cost fell on the models that don't need it: on a frontier model with a
 * 200k window, elia was throwing away its own exploration after roughly six
 * source files. On a real repository that is the difference between holding the
 * code you just read and re-reading it, and it caps how long a coding task can
 * run before the agent starts forgetting the reason it made an edit.
 *
 * So the budget is derived from the model instead. An unrecognised model keeps
 * exactly the old behaviour: `DEFAULT_CONTEXT_WINDOW * USABLE_FRACTION` is
 * 30,000, the number that was hardcoded before. Nothing gets *less* room than it
 * had; models with a known, larger window get more.
 */

/**
 * Assumed window for a model nothing is known about. Chosen so the derived
 * threshold lands on the historical 30,000, because the safe default for an
 * unknown model is the behaviour that was already shipping.
 */
export const DEFAULT_CONTEXT_WINDOW = 50_000

/**
 * Share of the window the conversation may occupy before compaction starts.
 *
 * The rest is headroom for the system prompt, the tool definitions, the next
 * response, and the error in the estimate itself — `estimateTokens` counts
 * characters and divides by four, which is close enough to trigger on but not
 * close enough to run to the edge of a hard provider limit on.
 */
export const USABLE_FRACTION = 0.6

/**
 * Ceiling regardless of how large the window is.
 *
 * A million-token window does not mean a million-token conversation is a good
 * idea: recall degrades across a very long context, every turn re-attends the
 * whole thing, and cache-miss turns are billed for it. Past this point,
 * compacting into a summary is better work *and* cheaper than not.
 */
export const MAX_COMPACTION_THRESHOLD = 160_000

/**
 * Known context windows, matched against the model id.
 *
 * Deliberately at or below each family's documented size. Underestimating costs
 * one compaction pass; overestimating overruns the provider's hard limit and
 * fails the turn outright, so every uncertain case rounds down.
 */
const KNOWN_WINDOWS: { pattern: RegExp; window: number }[] = [
  // Anthropic — Claude 3.x through 5.
  { pattern: /^claude-/, window: 200_000 },
  // OpenAI. gpt-4.1 documents 1M; the cap above bounds what elia will use.
  { pattern: /^gpt-4\.1/, window: 1_000_000 },
  { pattern: /^gpt-5/, window: 400_000 },
  { pattern: /^o[134](?:-|$)/, window: 200_000 },
  { pattern: /^gpt-4o|^gpt-4-turbo/, window: 128_000 },
  { pattern: /^gpt-oss/, window: 128_000 },
  // Google.
  { pattern: /^gemini-/, window: 1_000_000 },
  // Open-weight families commonly served by the OpenAI-compatible providers.
  { pattern: /^mistral-|^magistral|^codestral/, window: 128_000 },
  { pattern: /^llama-3|^llama3|nemotron/, window: 128_000 },
  { pattern: /^deepseek/, window: 128_000 },
  { pattern: /^qwen/, window: 128_000 },
]

/**
 * Strips the vendor prefix providers put in front of a model id.
 *
 * OpenRouter, Groq and NVIDIA all serve ids like `openai/gpt-oss-120b` or
 * `nvidia/llama-3.3-nemotron-super-49b-v1.5`, and it is the part after the
 * slash that says which model it actually is.
 */
export function normalizeModelId(model: string): string {
  const trimmed = model.trim().toLowerCase()
  const slash = trimmed.lastIndexOf('/')
  return slash === -1 ? trimmed : trimmed.slice(slash + 1)
}

/** The context window elia will assume for `model`. */
export function contextWindowFor(model: string): number {
  const id = normalizeModelId(model)
  for (const entry of KNOWN_WINDOWS) {
    if (entry.pattern.test(id)) return entry.window
  }
  return DEFAULT_CONTEXT_WINDOW
}

/**
 * Reads an operator override.
 *
 * The table cannot know about a model released after this version, or about a
 * self-hosted endpoint. `ELIA_CONTEXT_WINDOW` is the escape hatch for both —
 * and for dialling the budget *down* on a provider that charges by the token.
 */
export function contextWindowOverride(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env.ELIA_CONTEXT_WINDOW?.trim()
  if (!raw) return undefined
  const value = Number.parseInt(raw, 10)
  if (!Number.isFinite(value) || value <= 0) return undefined
  return value
}

/**
 * Estimated tokens of conversation to allow before compacting, for `model`.
 *
 * Never returns less than the historical 30,000: a model elia does not
 * recognise, or a nonsense override, must not end up with a smaller working
 * memory than it had before this was model-aware.
 */
export function compactionThresholdFor(model: string, env: NodeJS.ProcessEnv = process.env): number {
  const window = contextWindowOverride(env) ?? contextWindowFor(model)
  const derived = Math.floor(window * USABLE_FRACTION)
  const floor = Math.floor(DEFAULT_CONTEXT_WINDOW * USABLE_FRACTION)
  return Math.min(MAX_COMPACTION_THRESHOLD, Math.max(floor, derived))
}
