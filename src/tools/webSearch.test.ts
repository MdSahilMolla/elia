import { afterEach, beforeEach, expect, test } from 'bun:test'
import { webSearchTool } from './webSearch.ts'

const originalFetch = globalThis.fetch
const originalApiKey = process.env.ELIA_SEARCH_API_KEY
const originalProvider = process.env.ELIA_SEARCH_PROVIDER
const originalExaKey = process.env.EXA_API_KEY
const originalSerperKey = process.env.SERPER_API_KEY

beforeEach(() => {
  process.env.ELIA_SEARCH_API_KEY = 'test-key'
  delete process.env.ELIA_SEARCH_PROVIDER
  delete process.env.EXA_API_KEY
  delete process.env.SERPER_API_KEY
})

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalApiKey === undefined) delete process.env.ELIA_SEARCH_API_KEY
  else process.env.ELIA_SEARCH_API_KEY = originalApiKey
  if (originalProvider === undefined) delete process.env.ELIA_SEARCH_PROVIDER
  else process.env.ELIA_SEARCH_PROVIDER = originalProvider
  if (originalExaKey === undefined) delete process.env.EXA_API_KEY
  else process.env.EXA_API_KEY = originalExaKey
  if (originalSerperKey === undefined) delete process.env.SERPER_API_KEY
  else process.env.SERPER_API_KEY = originalSerperKey
})

test('web_search fails clearly when no API key is configured', async () => {
  delete process.env.ELIA_SEARCH_API_KEY
  await expect(webSearchTool.execute({ query: 'anything' })).rejects.toThrow('EXA_API_KEY')
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
  expect(result).toContain('No results found.')
})

test('web_search normalizes Exa results and sends date/domain filters', async () => {
  process.env.EXA_API_KEY = 'exa-key'; process.env.ELIA_SEARCH_PROVIDER = 'exa'
  let request: RequestInit | undefined
  globalThis.fetch = (async (_url, init) => { request = init; return new Response(JSON.stringify({ results: [{ title: 'Primary source', url: 'https://example.gov/report', publishedDate: '2026-08-01T00:00:00Z', highlights: ['Material evidence'] }] }), { status: 200 }) }) as typeof fetch
  const result = await webSearchTool.execute({ query: 'trade disruption', includeDomains: ['example.gov'], startPublishedDate: '2026-01-01', count: 5 })
  expect((request?.headers as Record<string, string>)['x-api-key']).toBe('exa-key')
  expect(String(request?.body)).toContain('example.gov')
  expect(result).toContain('Search provider: exa')
  expect(result).toContain('Material evidence')
})

test('web_search normalizes Serper organic results', async () => {
  process.env.SERPER_API_KEY = 'serper-key'; process.env.ELIA_SEARCH_PROVIDER = 'serper'
  let calledUrl = ''; let request: RequestInit | undefined
  globalThis.fetch = (async (url, init) => { calledUrl = String(url); request = init; return new Response(JSON.stringify({ organic: [{ title: 'Policy notice', link: 'https://example.gov/policy', snippet: 'Official notice', date: 'Aug 1, 2026' }] }), { status: 200 }) }) as typeof fetch
  const result = await webSearchTool.execute({ query: 'policy', country: 'us', language: 'en' })
  expect(calledUrl).toBe('https://google.serper.dev/search')
  expect((request?.headers as Record<string, string>)['X-API-KEY']).toBe('serper-key')
  expect(result).toContain('Search provider: serper')
  expect(result).toContain('Policy notice')
})

test('web_search recencyDays sends a clock-derived date window to Exa and headers it', async () => {
  process.env.EXA_API_KEY = 'exa-key'; process.env.ELIA_SEARCH_PROVIDER = 'exa'
  let request: RequestInit | undefined
  globalThis.fetch = (async (_url, init) => { request = init; return new Response(JSON.stringify({ results: [] }), { status: 200 }) }) as typeof fetch
  const result = await webSearchTool.execute({ query: 'nepal government', recencyDays: 30 })
  const body = JSON.parse(String(request?.body)) as { startPublishedDate?: string }
  expect(body.startPublishedDate).toBeString()
  expect(Date.parse(body.startPublishedDate!)).toBeGreaterThan(Date.now() - 31 * 86_400_000)
  expect(result).toContain('Recency filter: last 30 day(s)')
})

test('web_search rejects an out-of-range recencyDays', async () => {
  await expect(webSearchTool.execute({ query: 'x', recencyDays: 0 })).rejects.toThrow('recencyDays')
  await expect(webSearchTool.execute({ query: 'x', recencyDays: 5000 })).rejects.toThrow('recencyDays')
})

test('web_search maps recencyDays to a Brave freshness parameter', async () => {
  let calledUrl = ''
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => { calledUrl = String(input); return new Response(JSON.stringify({ web: { results: [] } }), { status: 200 }) }) as unknown as typeof fetch
  await webSearchTool.execute({ query: 'example', recencyDays: 7 })
  expect(calledUrl).toContain('freshness=pw')
})

test('web_search does not present Brave\'s relative age as a published date', async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ web: { results: [
    { title: 'Relative', url: 'https://a.example', description: 'x', age: '3 days ago' },
    { title: 'Absolute', url: 'https://b.example', description: 'y', age: '2 days ago', page_age: '2026-08-01T10:00:00' },
  ] } }), { status: 200 })) as unknown as typeof fetch
  const result = await webSearchTool.execute({ query: 'dates' })
  expect(result).not.toContain('Published: 3 days ago')
  expect(result).toContain('Age (provider-reported): 3 days ago')
  expect(result).toContain('Published: 2026-08-01T10:00:00')
  expect(result).not.toContain('2 days ago')
})

test('web_search tolerates malformed result entries instead of trusting the cast', async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ web: { results: [null, 'junk', 7, { title: 42, url: 'https://ok.example', description: 'fine' }] } }), { status: 200 })) as unknown as typeof fetch
  const result = await webSearchTool.execute({ query: 'shape' })
  expect(result).toContain('1. (untitled)')
  expect(result).toContain('https://ok.example')
  // Anchored to a result line, not a bare `2.`: every response carries a
  // `Retrieved: <ISO timestamp>` header, and a substring check matched that
  // whenever the seconds ended in 2 (`...:02.336Z`) — a real ~1-in-10 flake.
  expect(result).not.toMatch(/^2\. /m)
})

test('web_search rejects a non-object or oversized provider response', async () => {
  globalThis.fetch = (async () => new Response('[1,2,3]', { status: 200 })) as unknown as typeof fetch
  await expect(webSearchTool.execute({ query: 'array' })).rejects.toThrow('non-object')
  globalThis.fetch = (async () => new Response('<html>not json</html>', { status: 200 })) as unknown as typeof fetch
  await expect(webSearchTool.execute({ query: 'html' })).rejects.toThrow('non-JSON')
  globalThis.fetch = (async () => new Response('x'.repeat(5_000_001), { status: 200 })) as unknown as typeof fetch
  await expect(webSearchTool.execute({ query: 'huge' })).rejects.toThrow('exceeded')
})

test('web_search surfaces a non-ok response as an error', async () => {
  globalThis.fetch = (async () =>
    new Response('nope', { status: 500, statusText: 'Internal Server Error' })) as unknown as typeof fetch
  await expect(webSearchTool.execute({ query: 'anything' })).rejects.toThrow('500')
})
