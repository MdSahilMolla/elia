import { expect, test } from 'bun:test'
import { capacityRetryDelayMs, isCapacityError, isConnectionError, isRequestTooLargeError, isTransientServerError, retryBackoffMs } from './providerErrors.ts'

/**
 * The exact message that took two steps out of run 2026-09-13-l0av-rnq0. Every
 * classifier in the codebase missed it, so it is the canonical regression case.
 */
const GROQ_413 =
  '413 Request too large for model `openai/gpt-oss-120b` in organization `org_01jjz` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 42323, please reduce your message size and try again.'

test('the live 413 TPM failure is recognised as a capacity error', () => {
  expect(isCapacityError(GROQ_413)).toBe(true)
})

test('the live 413 TPM failure is recognised as a too-large request', () => {
  expect(isRequestTooLargeError(GROQ_413)).toBe(true)
})

test('a per-minute token cap waits for the minute boundary, not 30s', () => {
  expect(capacityRetryDelayMs(GROQ_413)).toBe(60_000)
})

// The underscore spelling is the standard OpenAI-compatible error *code*, and
// the old classifiers only looked for "rate limit" with a space.
test('rate_limit_exceeded is recognised', () => {
  expect(isCapacityError('rate_limit_exceeded')).toBe(true)
  expect(isCapacityError('Error code: 429 - rate_limit_exceeded')).toBe(true)
})

test('the size-only spellings are recognised', () => {
  for (const message of ['413 Payload Too Large', 'Request too large', 'prompt is too long', 'context_length_exceeded', 'please reduce your message size']) {
    expect(isCapacityError(message)).toBe(true)
  }
})

// Waiting cannot make an oversized request fit; only shrinking can. A delay
// there is dead time in a run that already has a budget.
test('a pure size overflow gets no delay, because waiting cannot make it fit', () => {
  expect(capacityRetryDelayMs('413 Payload Too Large')).toBe(0)
  expect(capacityRetryDelayMs('context_length_exceeded')).toBe(0)
})

test('a plain rate limit still backs off', () => {
  expect(capacityRetryDelayMs('429 too many requests')).toBe(30_000)
})

// A capacity predicate that fires on ordinary failures would send real bugs
// down the wait-and-retry path instead of surfacing them.
test('unrelated failures are not capacity errors', () => {
  for (const message of [
    "old_string not found in src/App.tsx",
    'error TS2322: Type string is not assignable to type number',
    'ENOENT: no such file or directory',
    'invalid api key',
    'Script not found "build"',
  ]) {
    expect(isCapacityError(message)).toBe(false)
  }
})

// `413` as a substring of a larger number is not an HTTP status.
test('a bare number containing 413 is not a capacity error', () => {
  expect(isCapacityError('read 84132 bytes from offset 4413299')).toBe(false)
})

test('a hiccup on the provider side is transient; a capacity cap or a bad setup is not', () => {
  for (const message of [
    'Service temporarily overloaded',
    '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
    '503 Service Unavailable',
    'The server had an error while processing your request.',
    'read ECONNRESET',
    'response stalled: nothing arrived for 120s (timed out)',
  ]) expect(isTransientServerError(message)).toBe(true)
  for (const message of [
    GROQ_413,
    '429 Too Many Requests',
    'connect ECONNREFUSED 127.0.0.1:11434',
    '401 invalid api key',
    '404 model not found',
    'Failed to parse tool call arguments as JSON',
  ]) expect(isTransientServerError(message)).toBe(false)
})

test('a request that never reached the provider is a connection error; a provider refusing it is not', () => {
  for (const message of ['Connection error.', 'fetch failed', 'connect ECONNREFUSED 127.0.0.1:11434', 'getaddrinfo ENOTFOUND api.inceptionlabs.ai', 'getaddrinfo EAI_AGAIN api.groq.com', 'The socket connection was closed unexpectedly']) {
    expect(isConnectionError(message)).toBe(true)
  }
  for (const message of ['401 invalid api key', '402 This request requires more credits', 'Service temporarily overloaded', '429 Too Many Requests']) {
    expect(isConnectionError(message)).toBe(false)
  }
})

test('a stream that closed before its last chunk is asked again, not the end of the turn', () => {
  // The OpenAI SDK's words for it; mercury ended an evolve generation this way.
  expect(isTransientServerError('missing finish_reason for choice 0')).toBe(true)
})

// The capacity/TPM rung of the retry ladder used to sleep 250·2ⁿ regardless of
// the provider's suggested window, so a minute-boundary cap killed live runs.
test('retryBackoffMs prefers the capacity window over binary backoff', () => {
  expect(retryBackoffMs(GROQ_413, 1)).toBe(60_000)
  expect(retryBackoffMs(GROQ_413, 3)).toBe(60_000)
  expect(retryBackoffMs('429 too many requests', 1)).toBe(30_000)
  expect(retryBackoffMs('Error code: 429 - rate_limit_exceeded', 2)).toBe(30_000)
})

test('retryBackoffMs keeps the binary fallback for non-capacity failures', () => {
  expect(retryBackoffMs('401 invalid api key', 1)).toBe(250)
  expect(retryBackoffMs('401 invalid api key', 4)).toBe(2000)
})

test('retryBackoffMs never returns NaN or a negative delay', () => {
  for (const text of [GROQ_413, '429 too many requests', '401 invalid api key', '']) {
    for (let attempt = 1; attempt <= 6; attempt++) {
      const delay = retryBackoffMs(text, attempt)
      expect(Number.isFinite(delay)).toBe(true)
      expect(delay).toBeGreaterThanOrEqual(0)
    }
  }
})
