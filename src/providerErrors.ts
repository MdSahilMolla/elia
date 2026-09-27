/**
 * Recognising the "your request was too big / too fast" family of provider
 * errors.
 *
 * Three separate places already tried to spot this family and all three used a
 * different, incomplete spelling of it, so a real failure slipped past every
 * one of them at once. Seen live (run 2026-09-13-l0av-rnq0): two plan steps
 * died on
 *
 *   413 Request too large for model `openai/gpt-oss-120b` ... service tier
 *   `on_demand` on tokens per minute (TPM): Limit 8000, Requested 42323,
 *   please reduce your message size and try again.
 *
 * That message contains neither `429`, nor the words "rate limit", nor
 * "context_length_exceeded", nor "prompt is too long" — the only spellings the
 * classifiers looked for. So it was not fallbackable (no route change), it was
 * not retryable-with-delay (`retryAfter` stayed unset, the retry fired with
 * `backoffMs: 0`), and the retry re-sent a request of almost exactly the same
 * size, which failed identically. Both steps were lost and the run ended
 * `needs-attention` with three of four steps done.
 *
 * One predicate, used by every classifier, so the spellings cannot drift apart
 * again.
 */

/**
 * The request exceeded a size or rate cap the provider enforces.
 *
 * Covers both halves of the family, because providers do not agree on which
 * one they are reporting and the remedy is the same either way (wait, shrink,
 * or route elsewhere):
 *  - size: `413`, "request too large", "payload too large", "prompt is too
 *    long", "context_length_exceeded", "reduce your message size"
 *  - rate: `429`, "rate limit" / `rate_limit_exceeded` (the underscore form is
 *    the standard OpenAI-compatible error *code* and was matched by nothing),
 *    "tokens per minute", "TPM", "quota exceeded", "too many requests"
 */
export function isCapacityError(message: string): boolean {
  return CAPACITY_ERROR.test(message)
}

/**
 * `\b413\b` deliberately, not a bare `413`: an unrelated message carrying the
 * number as part of a larger token (a file offset, a hash) should not be read
 * as a capacity failure.
 *
 * `rate[_ -]?limit` covers "rate limit", "rate_limit_exceeded" and
 * "rate-limited" in one alternative.
 */
const CAPACITY_ERROR =
  /\b(?:413|429)\b|rate[_ -]?limit|payload too large|request(?:ed)? (?:body )?too large|too many requests|quota exceeded|prompt is too long|context[_ ]?length[_ ]?exceeded|maximum context length|exceeds? (?:the )?(?:model'?s? )?(?:maximum )?context (?:window|length)|input is too long|too many tokens|reduce (?:the length of the messages|your (?:message|prompt|request) size)|tokens per (?:minute|min)\b|\bTPM\b|\bTPD\b/i

/**
 * The narrower half: the request was too *big*, as opposed to merely too
 * frequent. Waiting does not fix this one — the next attempt has to be
 * smaller — so callers that can shrink a request use this to decide to.
 */
export function isRequestTooLargeError(message: string): boolean {
  return REQUEST_TOO_LARGE.test(message)
}

/**
 * "maximum context length" is the OpenAI-compatible spelling mercury (and
 * vLLM-served models generally) use: "You exceeded the maximum context length
 * for this model of 260000. Please reduce the length of the messages or
 * completion." It matched nothing here, so a session that outgrew the window
 * was treated as a fatal error — no shrink, no retry — and because the history
 * that caused it was saved, every later prompt in that session died the same
 * way before a single token was generated (session mu0t6bvd-urf6i6, 2026-09-14).
 */
const REQUEST_TOO_LARGE =
  /\b413\b|payload too large|request(?:ed)? (?:body )?too large|prompt is too long|context[_ ]?length[_ ]?exceeded|maximum context length|exceeds? (?:the )?(?:model'?s? )?(?:maximum )?context (?:window|length)|input is too long|too many tokens|reduce (?:the length of the messages|your (?:message|prompt|request) size)/i

/**
 * The model garbled one of its own tool calls, and the provider refused to
 * relay arguments that were not valid JSON. Nothing reached a tool and nothing
 * is wrong with the request; the next sample almost always parses.
 *
 * mercury-2.5 does this mid-stream — Inception's server sends
 * `{"error": {"message": "Failed to parse tool call arguments as JSON"}}` as an
 * SSE chunk, which the OpenAI SDK throws as an APIError with no status. No
 * classifier recognised it, so it was fatal: run 2026-09-15-lot0-alkr died
 * outright on it while checking its plan's assumptions, and an interactive
 * session (mu0a4z96-ec8e56) lost a turn the same way.
 */
export function isMalformedToolCallError(message: string): boolean {
  return /failed to parse tool call arguments/i.test(message)
}

/**
 * The provider's side had a hiccup — it is overloaded, it answered with a 5xx,
 * the connection dropped, or the stream went silent. Nothing is wrong with the
 * request, and the same route usually answers a few seconds later.
 *
 * mercury-2.5 reports overload mid-stream: "Service temporarily overloaded"
 * arrives as an SSE error chunk, often after text has streamed, and the route
 * loop never asked again once output had been shown. Run 2026-09-21-jynj-3z2u
 * died on it while proposing its plan, eight minutes in.
 *
 * A capacity failure is a different family with its own delays
 * (`capacityRetryDelayMs`), and a refused connection or a failed DNS lookup is
 * a configuration problem, not a hiccup — neither is matched here.
 */
export function isTransientServerError(message: string): boolean {
  return !isCapacityError(message) && TRANSIENT_SERVER_ERROR.test(message)
}

/**
 * The request never reached the provider: DNS, a refused or dropped socket, no
 * route to the host. One provider failing this way is often its own endpoint
 * (a local server that is down), so on its own it is not a hiccup. Every
 * provider failing this way at once is this machine's network.
 */
export function isConnectionError(message: string): boolean {
  return CONNECTION_ERROR.test(message)
}

const CONNECTION_ERROR =
  /connection error|fetch failed|unable to connect|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|network (?:error|is unreachable)|socket connection was closed unexpectedly/i

// `missing finish_reason` is the OpenAI SDK's word for a stream that closed
// before its last chunk: mercury did it mid-build and ended an evolve
// generation outright, where asking again would have answered.
const TRANSIENT_SERVER_ERROR =
  /overloaded|temporarily unavailable|service unavailable|server had an error|internal server error|bad gateway|gateway time-?out|\b(?:500|502|503|504|529)\b|ECONNRESET|socket hang up|connection (?:was )?(?:closed|reset|terminated)|response stalled|missing finish_reason/i

/**
 * The route-health half of provider classification. The agent loop's route
 * fallback once kept its own regex spellings of "is this worth routing around",
 * so the same failure could be spelled one way here and another next to the loop
 * that consumed it — the drift this module was written to end. Every decision
 * about routing and cooldowns now shares these predicates.
 */

/**
 * A route that cannot be used at all — out of credit, or its key refused. Asking
 * it again is pointless, but the next route may well answer: these used to end
 * the turn, so a free-tier OpenRouter key with no credit (402) never handed over.
 */
export function isUnusableRouteError(message: string): boolean {
  return /\b(?:401|402|403)\b|payment required|insufficient[_ ](?:credits?|quota|balance|funds)|requires more credits|invalid[_ ]api[_ ]key|incorrect api key|unauthori[sz]ed/i.test(message)
}

/** A daily or plan quota spent — distinct from a per-minute rate limit, which clears in seconds. */
export function isQuotaExhaustedError(message: string): boolean {
  return /exceeded your current quota|quota (?:has been )?exceeded|daily (?:request |token )?(?:limit|quota)|requests? per day|free[- ]tier (?:limit|quota)|usage limit reached/i.test(message)
}

/**
 * Whether an error is worth routing to another provider instead of ending the
 * turn. Two families were missing and both end a turn outright when they hit:
 * overload (`529` / `overloaded_error`), the single most common transient
 * failure under load and precisely what a fallback route exists for; and
 * context overflow (`prompt is too long`, `context_length_exceeded`), which
 * another route with a larger window can actually serve. Neither is a bug in
 * the request, so neither should be fatal.
 *
 * The context-overflow half was only half-covered: it listed the two Anthropic
 * spellings and missed the OpenAI-compatible ones entirely (`413`, "Request
 * too large", a per-minute token cap), so a live run lost two steps to an error
 * this predicate called fatal. `isCapacityError` covers that family now, shared
 * with `classifyFailure` in the goal graph.
 *
 * Built from the shared family predicates plus
 * `ROUTE_FALLBACK_MODEL_OR_TIMEOUT` — model-not-found and plain timeouts,
 * which are not part of the transient or connection families but still mean
 * "ask another route".
 */
export function isFallbackableProviderError(message: string): boolean {
  return isCapacityError(message) || isConnectionError(message) || isTransientServerError(message) || ROUTE_FALLBACK_MODEL_OR_TIMEOUT.test(message)
}

const ROUTE_FALLBACK_MODEL_OR_TIMEOUT = /timeout|timed out|model (?:not found|unavailable)|\b404\b|not found|connection|network/i

/**
 * How long to wait before re-attempting a capacity failure.
 *
 * A per-minute token cap ("tokens per minute (TPM): Limit 8000") clears on a
 * minute boundary, so a few seconds is not enough and the old blanket 30s was
 * chosen for `429` rather than for TPM. A pure size overflow gets no delay at
 * all — waiting cannot make a 42k-token request fit an 8k cap, only shrinking
 * can, and a delay there is dead time.
 */
export function capacityRetryDelayMs(message: string): number {
  if (!isCapacityError(message)) return 0
  if (/tokens per (?:minute|min)\b|\bTPM\b/i.test(message)) return 60_000
  // A size overflow with no rate component: retrying later changes nothing.
  if (isRequestTooLargeError(message) && !/\b429\b|rate[_ -]?limit|too many requests|quota exceeded/i.test(message)) return 0
  return 30_000
}

/**
 * Delay before re-attempting a failed provider call: the capacity window when
 * the failure signals a cap (0 from `capacityRetryDelayMs` means "no window"),
 * otherwise the flat binary backoff the generic path has always used.
 */
export function retryBackoffMs(failureText: string, attempt: number): number {
  return capacityRetryDelayMs(failureText) || 250 * 2 ** (attempt - 1)
}
