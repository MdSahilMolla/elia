import { expect, test } from 'bun:test'
import { classifyProbeError, describeProbeFailure, probeModel } from './probe.ts'
import type { Provider, StreamTurnParams } from './types.ts'

const ZERO = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }

test('a model that starts answering passes, and the request is cut off there', async () => {
  let aborted = false
  const provider: Provider = {
    async streamTurn(params: StreamTurnParams) {
      params.onText('o')
      await new Promise((resolve) => setTimeout(resolve, 5))
      aborted = Boolean(params.signal?.aborted)
      throw new Error('Request was aborted.')
    },
  }
  expect((await probeModel(provider)).ok).toBe(true)
  expect(aborted).toBe(true)
})

test('reasoning counts as answering, and so does a reply that finishes', async () => {
  const thinking: Provider = {
    async streamTurn(params) {
      params.onThinking?.('hmm')
      throw new Error('aborted')
    },
  }
  const finished: Provider = { async streamTurn() { return { content: [], usage: ZERO } } }
  expect((await probeModel(thinking)).ok).toBe(true)
  expect((await probeModel(finished)).ok).toBe(true)
})

test('the session that prompted this: a free OpenRouter model rate-limited upstream is not saved', async () => {
  const provider: Provider = {
    async streamTurn() {
      throw new Error('429 stealth/union-alpha is temporarily rate-limited upstream. Please retry shortly.')
    },
  }
  const result = await probeModel(provider)
  expect(result).toMatchObject({ ok: false, kind: 'rate_limited' })
  if (!result.ok) expect(describeProbeFailure('openrouter (stealth/union-alpha)', result)).toStartWith('openrouter (stealth/union-alpha) is rate-limited right now (429')
})

test('a model that never answers times out instead of hanging /model', async () => {
  const provider: Provider = {
    streamTurn: (params) => new Promise((_, reject) => params.signal?.addEventListener('abort', () => reject(new Error('aborted')))),
  }
  const started = Date.now()
  expect(await probeModel(provider, { timeoutMs: 50 })).toMatchObject({ ok: false, kind: 'timeout' })
  expect(Date.now() - started).toBeLessThan(2_000)
})

test('provider errors are sorted into what the operator can do about them', () => {
  expect(classifyProbeError('402 This request requires more credits')).toBe('no_credit')
  expect(classifyProbeError('401 Incorrect API key provided')).toBe('auth')
  expect(classifyProbeError('429 Rate limit reached for model on tokens per minute')).toBe('rate_limited')
  expect(classifyProbeError('RESOURCE_EXHAUSTED: quota exceeded for gemini-3.8-flash')).toBe('rate_limited')
  expect(classifyProbeError('404 The model `nope` does not exist')).toBe('not_found')
  expect(classifyProbeError('No endpoints found for foo/bar')).toBe('not_found')
  expect(classifyProbeError('503 The model is overloaded')).toBe('error')
})
