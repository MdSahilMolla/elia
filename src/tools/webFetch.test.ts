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

// A redirect is followed, but every hop goes back through the address policy —
// the reason publicFetch stays `redirect: manual` and the caller does the hop.

/** Serve a scripted map of url -> response, so a redirect chain can be walked. */
function route(routes: Record<string, ResponseInit & { body?: string }>): string[] {
  const visited: string[] = []
  publicFetchTestHooks.transport = async (url) => {
    const key = url.toString()
    visited.push(key)
    const hit = routes[key]
    if (!hit) return new Response('unrouted', { status: 404, statusText: 'Not Found' })
    const { body, ...init } = hit
    return new Response(body ?? '', init)
  }
  return visited
}

test('web_fetch follows a redirect chain to the final page', async () => {
  const visited = route({
    'https://doi.org/10.1000/xyz': { status: 302, headers: { location: 'https://www.example.com/article/1' } },
    'https://www.example.com/article/1': { status: 301, headers: { location: '/article/1/full' } },
    'https://www.example.com/article/1/full': { status: 200, headers: { 'content-type': 'text/plain' }, body: 'the paper text' },
  })
  expect(await webFetchTool.execute({ url: 'https://doi.org/10.1000/xyz' })).toBe('the paper text')
  // Including the relative Location resolved against the hop it came from.
  expect(visited).toEqual([
    'https://doi.org/10.1000/xyz',
    'https://www.example.com/article/1',
    'https://www.example.com/article/1/full',
  ])
})

test('web_fetch rejects a redirect into a private address', async () => {
  // The whole reason following redirects is done hop-by-hop: the second hop
  // must not inherit the first hop's clearance.
  respond('', { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } })
  await expect(webFetchTool.execute({ url: 'https://example.com/moved' })).rejects.toThrow('private or local')
})

test('web_fetch stops on a redirect loop', async () => {
  route({
    'https://example.com/a': { status: 302, headers: { location: 'https://example.com/b' } },
    'https://example.com/b': { status: 302, headers: { location: 'https://example.com/a' } },
  })
  await expect(webFetchTool.execute({ url: 'https://example.com/a' })).rejects.toThrow('redirect loop')
})

test('web_fetch gives up after too many redirects', async () => {
  publicFetchTestHooks.transport = async (url) => {
    const n = Number(url.pathname.slice(1)) || 0
    return new Response('', { status: 302, headers: { location: `https://example.com/${n + 1}` } })
  }
  await expect(webFetchTool.execute({ url: 'https://example.com/0' })).rejects.toThrow('more than 5 redirects')
})

test('web_fetch truncates a very long page and says how to read on', async () => {
  respond('x'.repeat(250_000), { status: 200, headers: { 'content-type': 'text/plain' } })
  const result = await webFetchTool.execute({ url: 'https://example.com/huge' })
  expect(result).toContain('[truncated at 100000 of 250000 characters')
  expect(result).toContain('offset: 100000')
})

test('web_fetch reads on from an offset', async () => {
  respond(`${'a'.repeat(100_000)}THE-TAIL`, { status: 200, headers: { 'content-type': 'text/plain' } })
  const result = await webFetchTool.execute({ url: 'https://example.com/huge', offset: 100_000 })
  expect(result).toContain('[resuming at character 100000 of 100008]')
  expect(result).toContain('THE-TAIL')
  expect(result).not.toContain('truncated')
})

test('web_fetch reports an offset past the end rather than returning nothing', async () => {
  respond('short', { status: 200, headers: { 'content-type': 'text/plain' } })
  expect(await webFetchTool.execute({ url: 'https://example.com/s', offset: 9_000 })).toContain('past the end')
})

test('web_fetch rejects a negative offset', async () => {
  await expect(webFetchTool.execute({ url: 'https://example.com/s', offset: -1 })).rejects.toThrow('non-negative')
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

// --- PDFs come back as text, not as binary noise -----------------------------

/** A tiny PDF with one uncompressed text stream. */
function pdfBytes(body: string): ArrayBuffer {
  const payload = Buffer.from(body, 'latin1')
  const joined = Buffer.concat([
    Buffer.from('%PDF-1.7\n', 'latin1'),
    Buffer.from(`<< /Length ${payload.length} >>\nstream\n`, 'latin1'),
    payload,
    Buffer.from('\nendstream\n%%EOF\n', 'latin1'),
  ])
  return joined.buffer.slice(joined.byteOffset, joined.byteOffset + joined.byteLength) as ArrayBuffer
}

test('web_fetch extracts the text of a PDF instead of returning its bytes', async () => {
  const bytes = pdfBytes(`BT (${'Scaling laws for neural language models. '.repeat(8)}) Tj ET`)
  publicFetchTestHooks.transport = async () => new Response(bytes, { status: 200, headers: { 'content-type': 'application/pdf' } })
  const result = await webFetchTool.execute({ url: 'https://example.com/paper.pdf' })
  expect(result).toContain('Scaling laws for neural language models')
  expect(result).not.toContain('%PDF')
})

test('an image-only PDF says it needs OCR rather than coming back empty', async () => {
  // The failure that matters: an empty string reads as "this paper says
  // nothing", and the model then summarises a document it never saw.
  const bytes = pdfBytes('q 612 0 0 792 0 0 cm /Im1 Do Q')
  publicFetchTestHooks.transport = async () => new Response(bytes, { status: 200, headers: { 'content-type': 'application/pdf' } })
  const result = await webFetchTool.execute({ url: 'https://example.com/scan.pdf' })
  expect(result).toContain('is a PDF, but')
  expect(result).toContain('OCR')
})

test('a PDF mislabelled as octet-stream is still detected and extracted', async () => {
  const bytes = pdfBytes(`BT (${'Mislabelled but perfectly readable text. '.repeat(8)}) Tj ET`)
  publicFetchTestHooks.transport = async () => new Response(bytes, { status: 200, headers: { 'content-type': 'application/octet-stream' } })
  const result = await webFetchTool.execute({ url: 'https://example.com/unlabelled' })
  expect(result).toContain('Mislabelled but perfectly readable text')
})
