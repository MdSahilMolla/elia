import type { Tool } from './types.ts'

const FETCH_TIMEOUT_MS = 15_000
const MAX_CHARS = 20_000

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
    const raw = input.url as string
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
    let response: Response
    try {
      response = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'elia-agent/0.1' } })
    } catch (err) {
      throw new Error(`web_fetch request failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      clearTimeout(timeout)
    }

    if (!response.ok) throw new Error(`web_fetch failed: ${response.status} ${response.statusText}`)

    const contentType = response.headers.get('content-type') ?? ''
    const body = await response.text()
    const text = contentType.includes('html') ? htmlToText(body) : body

    return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n\n[truncated at ${MAX_CHARS} characters]` : text
  },
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/(p|div|br|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
