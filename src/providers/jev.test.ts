import { afterEach, expect, test } from 'bun:test'
import { askJev, jevEnabled, parseAnswers, type JevAnswer } from './jev.ts'

const originalFetch = globalThis.fetch
const saved = { key: process.env.ELIA_JEV_API_KEY, alt: process.env.TYPESAFE_API_KEY, mode: process.env.ELIA_JEV_MODE }
const QUESTIONS = { outcome: { type: 'noul' as const, instructions: 'The change is correct.' } }

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

afterEach(() => {
  globalThis.fetch = originalFetch
  restore('ELIA_JEV_API_KEY', saved.key)
  restore('TYPESAFE_API_KEY', saved.alt)
  restore('ELIA_JEV_MODE', saved.mode)
})

function withKey(): void {
  process.env.ELIA_JEV_API_KEY = 'test-key'
  delete process.env.ELIA_JEV_MODE
}

test('with no key, askJev is undefined and never touches the network', async () => {
  delete process.env.ELIA_JEV_API_KEY
  delete process.env.TYPESAFE_API_KEY
  let called = false
  globalThis.fetch = (async () => {
    called = true
    return new Response('{}')
  }) as unknown as typeof fetch
  expect(jevEnabled()).toBe(false)
  expect(await askJev('state', QUESTIONS)).toBeUndefined()
  expect(called).toBe(false)
})

test('ELIA_JEV_MODE=off disables Jev even with a key', () => {
  withKey()
  process.env.ELIA_JEV_MODE = 'off'
  expect(jevEnabled()).toBe(false)
})

test('sends the documented request and reads the answer', async () => {
  withKey()
  let captured: { url: string; auth: string | null; body: Record<string, unknown> } | undefined
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    captured = { url: String(url), auth: new Headers(init.headers).get('authorization'), body: JSON.parse(String(init.body)) }
    return new Response(JSON.stringify({ model: 'jev-1.13.0', answers: { outcome: { type: 'noul', noul: 0.09 } }, usage: { input_tokens: 42, output_tokens: 0 } }))
  }) as unknown as typeof fetch
  const result = await askJev({ diff: 'the state' }, QUESTIONS)
  expect(captured?.url).toBe('https://api.typesafe.ai/v1/systemone')
  expect(captured?.auth).toBe('Bearer test-key')
  expect(captured?.body).toEqual({ model: 'jev-latest', state: { diff: 'the state' }, questions: QUESTIONS })
  expect(result).toMatchObject({ ok: true, inputTokens: 42, answers: { outcome: { type: 'noul', noul: 0.09 } } })
})

test('a credential in the state is redacted before it leaves the machine', async () => {
  withKey()
  let sent = ''
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    sent = String(init.body)
    return new Response(JSON.stringify({ answers: { outcome: { type: 'noul', noul: 0.9 } } }))
  }) as unknown as typeof fetch
  await askJev('OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789', QUESTIONS) // pragma: allowlist secret
  expect(sent).not.toContain('sk-proj-abcdefghijklmnopqrstuvwxyz0123456789') // pragma: allowlist secret
  await askJev({ nested: ['token sk-proj-abcdefghijklmnopqrstuvwxyz0123456789'] }, QUESTIONS) // pragma: allowlist secret
  expect(sent).not.toContain('sk-proj-abcdefghijklmnopqrstuvwxyz0123456789') // pragma: allowlist secret
})

test('HTTP errors, garbage and network failures come back as errors, not throws', async () => {
  withKey()
  globalThis.fetch = (async () => new Response('bad key', { status: 401 })) as unknown as typeof fetch
  expect(await askJev('s', QUESTIONS)).toMatchObject({ ok: false, status: 401, error: expect.stringContaining('invalid API key') })
  globalThis.fetch = (async () => new Response('<html>')) as unknown as typeof fetch
  expect(await askJev('s', QUESTIONS)).toMatchObject({ ok: false, error: expect.stringContaining('non-JSON') })
  globalThis.fetch = (async () => {
    throw new Error('ECONNREFUSED')
  }) as unknown as typeof fetch
  expect(await askJev('s', QUESTIONS)).toMatchObject({ ok: false, error: 'ECONNREFUSED' })
})

test('a slow endpoint times out instead of holding the turn', async () => {
  withKey()
  globalThis.fetch = ((_url: string, init: RequestInit) =>
    new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))))) as unknown as typeof fetch
  const startedAt = Date.now()
  const result = await askJev('s', QUESTIONS, { timeoutMs: 50 })
  expect(result).toMatchObject({ ok: false, error: 'timed out after 50ms' })
  expect(Date.now() - startedAt).toBeLessThan(2_000)
})

test('a 429 or 529 is retried once inside the deadline; a 422 is not', async () => {
  withKey()
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    return calls === 1 ? new Response('slow down', { status: 529 }) : new Response(JSON.stringify({ answers: { outcome: { type: 'noul', noul: 0.7 } } }))
  }) as unknown as typeof fetch
  expect(await askJev('s', QUESTIONS, { timeoutMs: 5_000 })).toMatchObject({ ok: true })
  expect(calls).toBe(2)

  calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    return new Response('{"detail":"bad"}', { status: 422 })
  }) as unknown as typeof fetch
  expect(await askJev('s', QUESTIONS, { timeoutMs: 5_000 })).toMatchObject({ ok: false, status: 422 })
  expect(calls).toBe(1)
})

const ALL = {
  yes: { type: 'noul' as const, instructions: 'q' },
  pick: { type: 'choice' as const, instructions: 'q', criteria: { billing: null, technical: 'a bug' } },
  level: { type: 'score' as const, instructions: 'q', criteria: ['low', 'high'] },
}

test('parseAnswers reads the three documented answer types', () => {
  const body: { answers: Record<string, JevAnswer> } = {
    answers: {
      yes: { type: 'noul', noul: 0.93 },
      pick: { type: 'choice', choice: 'billing', probabilities: { billing: 0.8, technical: 0.2 }, confidence: 0.74 },
      level: { type: 'score', score: 0.4, legend: { '0': 'low', '1': 'high' }, probabilities: { '0': 0.6, '1': 0.4 }, confidence: 0.3 },
    },
  }
  expect(parseAnswers(body, ALL)).toEqual(body.answers)
})

test('parseAnswers drops what it cannot trust rather than guessing', () => {
  expect(parseAnswers(null, ALL)).toEqual({})
  expect(parseAnswers({ yes: { type: 'noul', noul: 0.9 } }, ALL)).toEqual({})
  expect(parseAnswers({ answers: { yes: { type: 'choice', noul: 0.9 } } }, ALL)).toEqual({})
  expect(parseAnswers({ answers: { yes: { type: 'noul', noul: 1.5 } } }, ALL)).toEqual({})
  expect(parseAnswers({ answers: { pick: { type: 'choice', choice: 'billing', probabilities: { billing: 2 }, confidence: 0.5 } } }, ALL)).toEqual({})
})

test('an answer missing for any asked question fails the whole call', async () => {
  withKey()
  globalThis.fetch = (async () => new Response(JSON.stringify({ answers: { yes: { type: 'noul', noul: 0.5 } } }))) as unknown as typeof fetch
  expect(await askJev('s', ALL)).toMatchObject({ ok: false, error: expect.stringContaining('pick, level') })
})
