import { afterEach, expect, mock, test } from 'bun:test'
import { resetPrewarmForTests, warmConnection } from './prewarm.ts'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
  resetPrewarmForTests()
})

test('warmConnection issues one HEAD request to the origin of the base URL', () => {
  const calls: { url: string; method?: string }[] = []
  globalThis.fetch = mock((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method })
    return Promise.resolve(new Response(null, { status: 405 }))
  }) as unknown as typeof fetch

  warmConnection('https://api.anthropic.com/v1/messages')

  expect(calls).toHaveLength(1)
  expect(calls[0]!.url).toBe('https://api.anthropic.com/')
  expect(calls[0]!.method).toBe('HEAD')
})

test('a second call for the same origin does not hit the network again', () => {
  let count = 0
  globalThis.fetch = mock(() => {
    count += 1
    return Promise.resolve(new Response(null, { status: 404 }))
  }) as unknown as typeof fetch

  warmConnection('https://api.groq.com/openai/v1')
  warmConnection('https://api.groq.com/openai/v1/chat/completions')

  expect(count).toBe(1)
})

test('a missing or unparseable base URL is a silent no-op', () => {
  globalThis.fetch = mock(() => {
    throw new Error('should not be called')
  }) as unknown as typeof fetch

  expect(() => warmConnection(undefined)).not.toThrow()
  expect(() => warmConnection('not a url')).not.toThrow()
})

test('a fetch rejection never surfaces', async () => {
  globalThis.fetch = mock(() => Promise.reject(new Error('offline'))) as unknown as typeof fetch

  expect(() => warmConnection('https://example.com')).not.toThrow()
  // Give the swallowed rejection a tick to settle without an unhandled-rejection crash.
  await new Promise((resolve) => setTimeout(resolve, 10))
})
