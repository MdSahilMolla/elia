import type { Tool } from './types.ts'
import { readBoundedOutput } from '../shell.ts'
import { publicFetch } from '../networkPolicy.ts'

const FETCH_TIMEOUT_MS = 15_000
const MAX_CHARS = 20_000
const MAX_RESPONSE_CHARS = 2_000_000

/** Reads one specific page a web_search turned up — a competitor site, a pricing page, a public data source. */
export const webFetchTool: Tool = {
  name: 'web_fetch',
  description:
    'Fetch a single web page and return its readable text content (HTML tags stripped). Use this to read a specific page a search turned up.',
  input_schema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to fetch (must start with http:// or https://)' },
    },
    required: ['url'],
  },
  async execute(input) {
    if (typeof input.url !== 'string' || input.url.trim().length === 0) throw new Error('url must be a non-empty string')
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
      const response = await publicFetch(url, { signal: controller.signal, headers: { 'User-Agent': 'elia-agent/0.1' } })
      if (response.status >= 300 && response.status < 400) throw new Error(`web_fetch refused redirect response: ${response.status}`)
      if (!response.ok) throw new Error(`web_fetch failed: ${response.status} ${response.statusText}`)

      const contentType = response.headers.get('content-type') ?? ''
      const body = response.body ? await readBoundedOutput(response.body, MAX_RESPONSE_CHARS) : ''
      const text = contentType.includes('html') ? htmlToText(body) : body

      return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n\n[truncated at ${MAX_CHARS} characters]` : text
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
