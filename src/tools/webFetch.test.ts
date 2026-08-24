import { afterEach, expect, test } from 'bun:test'
import { webFetchTool } from './webFetch.ts'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

test('web_fetch rejects an invalid URL', async () => {
  await expect(webFetchTool.execute({ url: 'not a url' })).rejects.toThrow('Invalid URL')
})

test('web_fetch rejects a non-http(s) URL', async () => {
  await expect(webFetchTool.execute({ url: 'file:///etc/passwd' })).rejects.toThrow('Refusing to fetch')
})

test('web_fetch rejects private, loopback, and metadata targets before fetching', async () => {
  for (const url of ['http://127.0.0.1:3000', 'http://10.0.0.1', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/']) {
    await expect(webFetchTool.execute({ url })).rejects.toThrow('private or local')
  }
})

test('web_fetch strips HTML tags and scripts down to readable text', async () => {
  globalThis.fetch = (async () =>
    new Response('<html><head><script>evil()</script></head><body><p>Hello <b>world</b></p></body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    })) as unknown as typeof fetch

  const result = await webFetchTool.execute({ url: 'https://example.com' })
  expect(result).toContain('Hello world')
  expect(result).not.toContain('evil()')
  expect(result).not.toContain('<')
})

test('web_fetch passes non-HTML content through unchanged', async () => {
  globalThis.fetch = (async () =>
    new Response('{"a":1}', { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch

  const result = await webFetchTool.execute({ url: 'https://example.com/data.json' })
  expect(result).toBe('{"a":1}')
})

test('web_fetch surfaces a non-ok response as an error', async () => {
  globalThis.fetch = (async () => new Response('nope', { status: 404, statusText: 'Not Found' })) as unknown as typeof fetch
  await expect(webFetchTool.execute({ url: 'https://example.com/missing' })).rejects.toThrow('404')
})

test('web_fetch truncates very long pages', async () => {
  const huge = 'x'.repeat(25_000)
  globalThis.fetch = (async () =>
    new Response(huge, { status: 200, headers: { 'content-type': 'text/plain' } })) as unknown as typeof fetch

  const result = await webFetchTool.execute({ url: 'https://example.com/huge' })
  expect(result).toContain('[truncated at 20000 characters]')
})
