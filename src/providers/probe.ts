import type { Provider } from './types.ts'

/**
 * One tiny request to find out whether a model answers right now, before
 * `/model` saves it as the session's model for every later launch.
 *
 * `/model` used to save whatever was picked. A free OpenRouter model that was
 * rate-limited upstream got saved that way, every restart came back on it, and
 * each turn sat retrying a model that was not answering. The probe stops at the
 * first streamed text or reasoning, so a working model costs a few tokens.
 */

export type ProbeFailure = 'rate_limited' | 'no_credit' | 'auth' | 'not_found' | 'timeout' | 'error'

export type ProbeResult =
  | { ok: true; ms: number }
  | { ok: false; kind: ProbeFailure; reason: string }

const DEFAULT_TIMEOUT_MS = 30_000

/** Sorts a provider error into what the operator can do about it. */
export function classifyProbeError(message: string): ProbeFailure {
  if (/\b402\b|payment required|insufficient[_ ](?:credits?|quota|balance|funds)|requires more credits|out of credit/i.test(message)) return 'no_credit'
  if (/\b(?:401|403)\b|invalid[_ ]api[_ ]key|incorrect api key|unauthori[sz]ed|forbidden/i.test(message)) return 'auth'
  if (/\b429\b|rate[- ]?limit|too many requests|quota exceeded|resource[_ ]exhausted/i.test(message)) return 'rate_limited'
  if (/\b404\b|model[^.]*(?:not found|does not exist|unavailable|not available)|no endpoints found|unknown model/i.test(message)) return 'not_found'
  if (/timed? ?out|timeout|stalled/i.test(message)) return 'timeout'
  return 'error'
}

const FAILURE_WORDS: Record<ProbeFailure, string> = {
  rate_limited: 'is rate-limited right now',
  no_credit: 'needs credit on this account',
  auth: 'rejected the API key',
  not_found: 'is not available to this key',
  timeout: 'did not answer in time',
  error: 'failed',
}

/** "stealth/union-alpha is rate-limited right now (429 …)". */
export function describeProbeFailure(label: string, result: Extract<ProbeResult, { ok: false }>): string {
  const detail = result.reason.replace(/\s+/g, ' ').trim().slice(0, 160)
  return `${label} ${FAILURE_WORDS[result.kind]}${detail ? ` (${detail})` : ''}`
}

export async function probeModel(
  provider: Provider,
  options: { cwd?: string; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ProbeResult> {
  const started = Date.now()
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  let answered = false
  let timedOut = false
  const answer = () => {
    if (answered) return
    answered = true
    controller.abort()
  }
  const onOuterAbort = () => controller.abort()
  options.signal?.addEventListener('abort', onOuterAbort, { once: true })
  // A timer rather than AbortSignal.timeout: Bun's has hung before in this repo.
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  try {
    await provider.streamTurn({
      cwd: options.cwd ?? process.cwd(),
      system: 'You are a connectivity check. Reply with the single word: ok',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'ok?' }] }],
      tools: [],
      onText: (delta) => {
        if (delta) answer()
      },
      onThinking: (delta) => {
        if (delta) answer()
      },
      signal: controller.signal,
    })
    return { ok: true, ms: Date.now() - started }
  } catch (error) {
    if (answered) return { ok: true, ms: Date.now() - started }
    if (timedOut) return { ok: false, kind: 'timeout', reason: `no reply within ${Math.round(timeoutMs / 1000)}s` }
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, kind: options.signal?.aborted ? 'error' : classifyProbeError(message), reason: options.signal?.aborted ? 'cancelled' : message }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onOuterAbort)
  }
}
