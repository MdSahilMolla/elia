import { afterEach, expect, test } from 'bun:test'
import { webFetchTool, htmlToText, decodeEntities } from './webFetch.ts'
import { publicFetchTestHooks } from '../networkPolicy.ts'

afterEach(() => {
  publicFetchTestHooks.transport = undefined
})

function respond(body: string, init: ResponseInit): void {
  publicFetchTestHooks.transport = async () => new Response(body, init)
}

test('web_fetch rejects an invalid URL', async () => {
  await expect(webFetchTool.execute({ url: 'not a url' })).rejects.toThrow('Invalid URL')
})

test('web_fetch rejects a non-http(s) URL', async () => {
  await expect(webFetchTool.execute({ url: 'file:///etc/passwd' })).rejects.toThrow('Refusing to fetch')
})

test('web_fetch rejects private, loopback, and metadata targets before fetching', async () => {
  let reached = false
  publicFetchTestHooks.transport = async () => {
    reached = true
    return new Response('should not get here')
  }
  for (const url of ['http://127.0.0.1:3000', 'http://10.0.0.1', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/']) {
    await expect(webFetchTool.execute({ url })).rejects.toThrow('private or local')
  }
  expect(reached).toBe(false)
})

test('web_fetch strips HTML tags and scripts down to readable text', async () => {
  respond('<html><head><script>evil()</script></head><body><p>Hello <b>world</b></p></body></html>', {
    status: 200,
    headers: { 'content-type': 'text/html' },
  })

  const result = await webFetchTool.execute({ url: 'https://example.com' })
  expect(result).toContain('Hello world')
  expect(result).not.toContain('evil()')
  expect(result).not.toContain('<')
})

test('web_fetch passes non-HTML content through unchanged', async () => {
  respond('{"a":1}', { status: 200, headers: { 'content-type': 'application/json' } })

  const result = await webFetchTool.execute({ url: 'https://example.com/data.json' })
  expect(result).toBe('{"a":1}')
})

test('web_fetch surfaces a non-ok response as an error', async () => {
  respond('nope', { status: 404, statusText: 'Not Found' })
  await expect(webFetchTool.execute({ url: 'https://example.com/missing' })).rejects.toThrow('404')
})

test('web_fetch refuses to follow a redirect', async () => {
  respond('', { status: 302, headers: { location: 'http://169.254.169.254/' } })
  await expect(webFetchTool.execute({ url: 'https://example.com/moved' })).rejects.toThrow('refused redirect')
})

test('web_fetch truncates very long pages', async () => {
  respond('x'.repeat(25_000), { status: 200, headers: { 'content-type': 'text/plain' } })

  const result = await webFetchTool.execute({ url: 'https://example.com/huge' })
  expect(result).toContain('[truncated at 20000 characters]')
})

test('htmlToText does not leak attribute text when a quoted attribute contains ">"', () => {
  expect(htmlToText('<p><a title="a > b" href="/x">link</a> text</p>')).toBe('link text')
})

test('htmlToText keeps <pre> and <textarea> line structure out of the whitespace collapse', () => {
  const text = htmlToText('<p>Intro   text</p><pre>line 1\n    indented  line 2\n</pre><textarea>a\n  b</textarea><p>after</p>')
  expect(text).toContain('Intro text')
  expect(text).toContain('line 1\n    indented  line 2')
  expect(text).toContain('a\n  b')
  expect(text).toContain('after')
})

test('htmlToText decodes numeric and common named entities, leaving unknown ones intact', () => {
  expect(decodeEntities('&#39;q&#x27; &mdash; &hellip; &copy; &amp;lt; &unknownthing;')).toBe("'q' — … © &lt; &unknownthing;")
  // A private-use placeholder can't be smuggled in through an entity.
  expect(decodeEntities('&#xE000;0&#xE001;')).toBe('&#xE000;0&#xE001;')
})

test('htmlToText drops noscript, template and svg content', () => {
  expect(htmlToText('<noscript>enable js</noscript><template><b>t</b></template><svg><text>s</text></svg><p>body</p>')).toBe('body')
})
