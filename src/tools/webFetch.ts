import type { Tool } from './types.ts'
import { readBoundedOutput } from '../shell.ts'
import { publicFetch } from '../networkPolicy.ts'
import { looksLikePdf, pdfToText, thinExtractionReason } from './pdfText.ts'
import { rememberFetchedPage } from './fetchedPages.ts'

const FETCH_TIMEOUT_MS = 15_000
const MAX_CHARS = 100_000
const MAX_RESPONSE_CHARS = 2_000_000
/** Redirect hops to follow. Long enough for the real chains (doi.org → publisher → CDN), short enough to bound a loop. */
const MAX_REDIRECTS = 5

/**
 * One hop's worth of redirect, or `undefined` when the response is the answer.
 *
 * `publicFetch` is deliberately `redirect: 'manual'` — following redirects
 * inside it would let the *second* hop skip the address policy the first one
 * passed. So following them is the caller's job, and it is only safe done the
 * way it is here: each hop goes back through `publicFetch`, which re-runs
 * `assertPublicNetworkUrl` and re-pins DNS for the new URL. A redirect to
 * 127.0.0.1, to a private range, or to a non-http(s) scheme is rejected on the
 * next pass exactly as a directly-supplied one would be.
 */
function redirectTarget(response: Response, from: URL): URL | undefined {
  if (response.status < 300 || response.status >= 400) return undefined
  const location = response.headers.get('location')
  if (!location) return undefined
  try {
    // Relative Locations are common and legal ("/abs/2401.00001").
    return new URL(location, from)
  } catch {
    throw new Error(`web_fetch failed: redirect to an unparsable location (${location})`)
  }
}

/** Reads one specific page a web_search turned up — a competitor site, a pricing page, a public data source. */
export const webFetchTool: Tool = {
  name: 'web_fetch',
  description:
    'Fetch a single web page or PDF and return its readable text (HTML tags stripped, PDF text extracted). Use this to read a specific document a search turned up. Redirects are followed, so DOI links and other resolvers work. Long documents are truncated; pass offset to read on from where a previous call stopped. A scanned, image-only PDF says so rather than coming back empty.',
  input_schema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to fetch (must start with http:// or https://)' },
      offset: { type: 'number', description: 'Character offset to start from, for reading on past a truncated page. Default 0.' },
    },
    required: ['url'],
  },
  async execute(input) {
    if (typeof input.url !== 'string' || input.url.trim().length === 0) throw new Error('url must be a non-empty string')
    if (input.offset !== undefined && (typeof input.offset !== 'number' || !Number.isInteger(input.offset) || input.offset < 0)) {
      throw new Error('offset must be a non-negative integer')
    }
    const offset = typeof input.offset === 'number' ? input.offset : 0
    const raw = input.url.trim()
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      throw new Error(`Invalid URL: ${raw}`)
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`Refusing to fetch non-http(s) URL: ${raw}`)
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      // publicFetch validates the target and then re-validates inside the
      // connection's own DNS lookup, so the address that passed the policy is
      // the one the socket connects to — a rebinding DNS server gets no second
      // resolution to answer differently.
      let response = await publicFetch(url, { signal: controller.signal, headers: { 'User-Agent': 'elia-agent/0.1' } })
      const seen = new Set<string>([url.toString()])
      for (let hop = 0; hop < MAX_REDIRECTS; hop += 1) {
        const next = redirectTarget(response, url)
        if (!next) break
        if (seen.has(next.toString())) throw new Error(`web_fetch failed: redirect loop at ${next.toString()}`)
        seen.add(next.toString())
        response.body?.cancel().catch(() => {})
        url = next
        response = await publicFetch(url, { signal: controller.signal, headers: { 'User-Agent': 'elia-agent/0.1' } })
      }
      if (response.status >= 300 && response.status < 400) {
        throw new Error(`web_fetch failed: more than ${MAX_REDIRECTS} redirects, giving up at ${url.toString()}`)
      }
      if (!response.ok) throw new Error(`web_fetch failed: ${response.status} ${response.statusText}`)

      const contentType = response.headers.get('content-type') ?? ''
      let text: string
      if (contentType.includes('pdf')) {
        // Every non-HTML body used to be returned verbatim, so a PDF arrived as
        // undecoded binary and the model tried to read it as prose. Research
        // papers are almost always PDFs, which made "read this paper" fail in
        // the least useful way available: a page of mojibake that looks like
        // content. A thin extraction is reported as *why* it is thin, because
        // an empty result and a scanned document must not look alike.
        //
        // The body is read through a byte bound just like the text path: an
        // unbounded `arrayBuffer()` used to pull a whole multi-gigabyte PDF
        // into memory instead of being cut off the way HTML already is.
        const { bytes, truncated } = await readBoundedBytes(response.body, MAX_RESPONSE_CHARS * 4)
        const extracted = pdfToText(bytes)
        const thin = thinExtractionReason(extracted)
        const truncatedPrefix = truncated ? `[PDF body exceeded ${MAX_RESPONSE_CHARS * 4} bytes; extraction reflects only the leading part]\n\n` : ''
        if (thin) return `${truncatedPrefix}[${url.toString()} is a PDF, but ${thin}]${extracted.text ? `\n\nWhat little text was found:\n${extracted.text}` : ''}`
        text = truncatedPrefix + extracted.text
      } else {
        const body = response.body ? await readBoundedOutput(response.body, MAX_RESPONSE_CHARS) : ''
        // A server that mislabels a PDF as octet-stream or text/plain is common;
        // sniff the header rather than trust the label.
        text = contentType.includes('html')
          ? htmlToText(body)
          : looksLikePdf(new TextEncoder().encode(body.slice(0, 1024)))
            ? pdfToText(new Uint8Array(Buffer.from(body, 'latin1'))).text
            : body
      }

      rememberFetchedPage([raw, url.toString()], text)
      if (offset >= text.length && text.length > 0) {
        return `[offset ${offset} is past the end of this page — it is ${text.length} characters]`
      }
      const window = text.slice(offset, offset + MAX_CHARS)
      const end = offset + window.length
      const header = offset > 0 ? `[resuming at character ${offset} of ${text.length}]\n\n` : ''
      const footer = end < text.length ? `\n\n[truncated at ${end} of ${text.length} characters — call web_fetch again with offset: ${end} to read on]` : ''
      return `${header}${window}${footer}`
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('web_fetch failed:')) throw err
      throw new Error(`web_fetch request failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      clearTimeout(timeout)
    }
  },
}

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  mdash: '—', ndash: '–', hellip: '…', bull: '•', middot: '·',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»',
  copy: '©', reg: '®', trade: '™', deg: '°', times: '×', divide: '÷',
  euro: '€', pound: '£', yen: '¥', cent: '¢', sect: '§', para: '¶',
}

// A tag, with quoted attribute values allowed to contain `>` — a bare
// `<[^>]+>` ends at the first `>` inside `title="a > b"` and leaks the rest of
// the attribute into the text.
const TAG = /<\/?[a-zA-Z][^\s/>]*(?:[^>"']|"[^"]*"|'[^']*')*>/g

// Private-use code points marking where a preformatted block goes back in.
// They are not whitespace, so the collapse below leaves them intact; any that
// arrive in the page itself are stripped first so they can't be spoofed.
const PRE_OPEN = String.fromCharCode(0xe000)
const PRE_CLOSE = String.fromCharCode(0xe001)
const PLACEHOLDER_CHARS = new RegExp(`[${PRE_OPEN}${PRE_CLOSE}]`, 'g')
const PLACEHOLDER = new RegExp(`${PRE_OPEN}(\\d+)${PRE_CLOSE}`, 'g')

/** Decode numeric (`&#39;`, `&#x27;`) and common named HTML entities; unknown ones are left as written. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10)
      // Surrogates and the private-use block (which holds htmlToText's
      // placeholders) are left encoded rather than decoded into the text.
      const decodable = Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) && !(code >= 0xe000 && code <= 0xf8ff)
      return decodable ? String.fromCodePoint(code) : match
    }
    return NAMED_ENTITIES[name.toLowerCase()] ?? match
  })
}

/**
 * Reads a response stream up to `maxBytes`, cancelling once the bound is hit.
 * The text path already bounds its read (readBoundedOutput); the PDF path
 * converts to bytes, so it needs the byte-bound twin — otherwise a giant PDF
 * (or a mislabeled text file sniffed as PDF) is pulled into memory unbounded.
 */
export async function readBoundedBytes(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!stream) return { bytes: new Uint8Array(0), truncated: false }
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let truncated = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        const room = maxBytes - total
        if (room <= 0) {
          truncated = true
          await reader.cancel().catch(() => {})
          break
        }
        if (value.length > room) {
          chunks.push(value.subarray(0, room))
          total = maxBytes
          truncated = true
          await reader.cancel().catch(() => {})
          break
        }
        chunks.push(value)
        total += value.length
      }
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return { bytes, truncated }
}

export function htmlToText(html: string): string {
  // <pre>/<textarea> are preformatted: keep their line structure out of the
  // whitespace collapse below, then restore it.
  const preformatted: string[] = []
  const withoutPre = html
    .replace(PLACEHOLDER_CHARS, '')
    .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(pre|textarea)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_match, _tag, inner: string) => {
      preformatted.push(decodeEntities(inner.replace(TAG, '')))
      return `\n${PRE_OPEN}${preformatted.length - 1}${PRE_CLOSE}\n`
    })
  const text = decodeEntities(
    withoutPre
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|tr|section|article|header|footer|blockquote|table)\s*>/gi, '\n')
      .replace(TAG, ' '),
  )
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return text.replace(PLACEHOLDER, (_match, index: string) => preformatted[Number(index)] ?? '')
}
