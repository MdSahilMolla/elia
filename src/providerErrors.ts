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
