import { afterEach, beforeEach, expect, test } from 'bun:test'
import { webSearchTool } from './webSearch.ts'

const originalFetch = globalThis.fetch
const originalApiKey = process.env.ELIA_SEARCH_API_KEY
const originalProvider = process.env.ELIA_SEARCH_PROVIDER

beforeEach(() => {
  process.env.ELIA_SEARCH_API_KEY = 'test-key'
  delete process.env.ELIA_SEARCH_PROVIDER
})

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalApiKey === undefined) delete process.env.ELIA_SEARCH_API_KEY
  else process.env.ELIA_SEARCH_API_KEY = originalApiKey
  if (originalProvider === undefined) delete process.env.ELIA_SEARCH_PROVIDER
  else process.env.ELIA_SEARCH_PROVIDER = originalProvider
})

test('web_search fails clearly when no API key is configured', async () => {
  delete process.env.ELIA_SEARCH_API_KEY
  await expect(webSearchTool.execute({ query: 'anything' })).rejects.toThrow('ELIA_SEARCH_API_KEY')
})

test('web_search rejects an unsupported provider', async () => {
  process.env.ELIA_SEARCH_PROVIDER = 'yahoo'
  await expect(webSearchTool.execute({ query: 'anything' })).rejects.toThrow('Unsupported ELIA_SEARCH_PROVIDER')
})

test('web_search formats Brave results into readable text', async () => {
  let calledUrl = ''
  let calledHeaders: Record<string, string> | undefined
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    const [input, init] = args
    calledUrl = String(input)
    calledHeaders = init?.headers as Record<string, string> | undefined
    return new Response(
      JSON.stringify({
        web: {
          results: [
            { title: 'Example', url: 'https://example.com', description: 'An <b>example</b> site' },
          ],
        },
      }),
      { status: 200 },
    )
  }) as unknown as typeof fetch

  const result = await webSearchTool.execute({ query: 'example query' })

  expect(calledUrl).toContain('api.search.brave.com')
  expect(calledUrl).toContain('q=example')
  expect(calledHeaders?.['X-Subscription-Token']).toBe('test-key')
  expect(result).toContain('Example')
  expect(result).toContain('https://example.com')
  expect(result).toContain('An example site') // HTML tags stripped
})

test('web_search reports no results plainly', async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ web: { results: [] } }), { status: 200 })) as unknown as typeof fetch
  const result = await webSearchTool.execute({ query: 'nothing matches this' })
  expect(result).toBe('No results found.')
})

test('web_search surfaces a non-ok response as an error', async () => {
  globalThis.fetch = (async () =>
    new Response('nope', { status: 500, statusText: 'Internal Server Error' })) as unknown as typeof fetch
  await expect(webSearchTool.execute({ query: 'anything' })).rejects.toThrow('500')
})
