import { redactText } from '../ui/redact.ts'

/**
 * A client for Jev, TypeSafe AI's "System One" model
 * (https://docs.typesafe.ai/api).
 *
 * Jev writes no text and no code. It takes a block of state and a set of typed
 * questions and returns one typed answer per question, in well under a second.
 * That makes it useless as elia's lead model and useful next to it: the yes/no
 * calls elia makes with regexes or a second model call can be asked of it in
 * parallel, for a fraction of a cent.
 *
 * Optional by construction. With no key set every call returns `undefined`
 * without touching the network, and with a key set a down, slow or rejecting
 * endpoint returns an `error` — never a throw — so a caller's fallback is simply
 * "carry on the way elia already does".
 */

/** A value the API accepts as state or as question text: a string, a JSON object, or an array. */
export type JevText = string | Record<string, unknown> | unknown[]

export type JevQuestion =
  /** Yes/no. The answer is the probability of yes. */
  | { type: 'noul'; instructions: JevText; criteria?: { true: string; false: string } }
  /** One of several unordered options; `criteria` maps each option to a description (or null). */
  | { type: 'choice'; instructions: JevText; criteria: Record<string, string | null> }
  /** A level on an ordered scale; `criteria` lists the level descriptions, lowest first (at least 2). */
  | { type: 'score'; instructions: JevText; criteria: string[] }

export type JevAnswer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'score'; score: number; legend: Record<string, string>; probabilities: Record<string, number>; confidence: number }

export type JevResult =
  | { ok: true; answers: Record<string, JevAnswer>; latencyMs: number; inputTokens?: number }
  | { ok: false; error: string; status?: number; latencyMs: number }

export interface AskJevOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

const DEFAULT_BASE_URL = 'https://api.typesafe.ai'
const DEFAULT_TIMEOUT_MS = 2_000
/**
 * jev-1.13 allows 32k tokens of state plus the longest question, but its own
 * limitations page says accuracy falls as state fills with content unrelated to
 * the decision — so each string in the state is capped well below that.
 */
const MAX_TEXT_CHARS = 16_000
/** Rate-limited (429) and overloaded (529) are worth one retry inside the deadline; nothing else is. */
const RETRYABLE = new Set([429, 529])
const RETRY_DELAY_MS = 250

export function jevApiKey(): string | undefined {
  const value = (process.env.ELIA_JEV_API_KEY ?? process.env.TYPESAFE_API_KEY)?.trim()
  return value || undefined
}

export function jevEnabled(): boolean {
  return jevApiKey() !== undefined && process.env.ELIA_JEV_MODE?.trim().toLowerCase() !== 'off'
}

export function jevBaseUrl(): string {
  return (process.env.ELIA_JEV_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '')
}

export function jevModel(): string {
  return process.env.ELIA_JEV_MODEL?.trim() || 'jev-latest'
}

/** Returns undefined when Jev is not configured; never throws. */
export async function askJev(state: JevText, questions: Record<string, JevQuestion>, options: AskJevOptions = {}): Promise<JevResult | undefined> {
  const key = jevApiKey()
  if (!key || !jevEnabled()) return undefined
  const startedAt = Date.now()
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  // A plain timer, not AbortSignal.timeout: Bun leaves that one unref'd, and a
  // fetch that never settles then parks the turn instead of timing out.
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(), timeoutMs)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal
  // State and question text leave the machine: strip anything that looks like a credential first.
  const body = JSON.stringify({ model: jevModel(), state: redactValue(state), questions })
  try {
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetch(`${jevBaseUrl()}/v1/systemone`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body,
        signal,
      })
      const text = await response.text()
      const latencyMs = Date.now() - startedAt
      if (!response.ok) {
        if (attempt === 0 && RETRYABLE.has(response.status) && latencyMs + RETRY_DELAY_MS * 2 < timeoutMs) {
          await abortableDelay(RETRY_DELAY_MS, signal)
          continue
        }
        return { ok: false, status: response.status, error: `${describeStatus(response.status)}: ${text.slice(0, 200)}`, latencyMs }
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        return { ok: false, error: `non-JSON response: ${text.slice(0, 200)}`, latencyMs }
      }
      const answers = parseAnswers(parsed, questions)
      const missing = Object.keys(questions).filter((name) => !answers[name])
      if (missing.length > 0) return { ok: false, error: `no usable answer for ${missing.join(', ')} in: ${text.slice(0, 200)}`, latencyMs }
      const usage = asRecord(asRecord(parsed)?.usage)
      return { ok: true, answers, latencyMs, inputTokens: typeof usage?.input_tokens === 'number' ? usage.input_tokens : undefined }
    }
  } catch (err) {
    const latencyMs = Date.now() - startedAt
    const reason = timeout.signal.aborted ? `timed out after ${timeoutMs}ms` : err instanceof Error ? err.message : String(err)
    return { ok: false, error: reason, latencyMs }
  } finally {
    clearTimeout(timer)
  }
}

function describeStatus(status: number): string {
  switch (status) {
    case 401: return 'HTTP 401 (missing or invalid API key)'
    case 422: return 'HTTP 422 (request failed validation)'
    case 429: return 'HTTP 429 (rate limited)'
    case 529: return 'HTTP 529 (service overloaded)'
    default: return `HTTP ${status}`
  }
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('aborted'))
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }, { once: true })
  })
}

function redactValue(value: JevText): JevText {
  if (typeof value === 'string') return redactText(value, MAX_TEXT_CHARS)
  return JSON.parse(JSON.stringify(value, (_key, inner) => (typeof inner === 'string' ? redactText(inner, MAX_TEXT_CHARS) : inner))) as JevText
}

/**
 * Reads `answers` out of a response, keeping only an answer whose type matches
 * the question that was asked and whose numbers are in range. An answer it
 * cannot read is left out, which the caller treats as "Jev unavailable" rather
 * than a guess.
 */
export function parseAnswers(body: unknown, questions: Record<string, JevQuestion>): Record<string, JevAnswer> {
  const answers = asRecord(asRecord(body)?.answers)
  if (!answers) return {}
  const out: Record<string, JevAnswer> = {}
  for (const [name, question] of Object.entries(questions)) {
    const raw = asRecord(answers[name])
    if (!raw || raw.type !== question.type) continue
    if (question.type === 'noul') {
      if (isProbability(raw.noul)) out[name] = { type: 'noul', noul: raw.noul }
    } else if (question.type === 'choice') {
      const probabilities = probabilityMap(raw.probabilities)
      if (typeof raw.choice === 'string' && probabilities && isProbability(raw.confidence)) {
        out[name] = { type: 'choice', choice: raw.choice, probabilities, confidence: raw.confidence }
      }
    } else {
      const probabilities = probabilityMap(raw.probabilities)
      const legend = asRecord(raw.legend)
      if (typeof raw.score === 'number' && Number.isFinite(raw.score) && probabilities && isProbability(raw.confidence)) {
        out[name] = {
          type: 'score',
          score: raw.score,
          legend: Object.fromEntries(Object.entries(legend ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
          probabilities,
          confidence: raw.confidence,
        }
      }
    }
  }
  return out
}

function isProbability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

function probabilityMap(value: unknown): Record<string, number> | undefined {
  const record = asRecord(value)
  if (!record) return undefined
  const entries = Object.entries(record)
  return entries.every(([, p]) => isProbability(p)) ? (Object.fromEntries(entries) as Record<string, number>) : undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}
