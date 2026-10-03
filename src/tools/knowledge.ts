import type { Tool } from './types.ts'
import { isExplicitLocalHostname, publicFetch } from '../networkPolicy.ts'

/**
 * elia's own knowledge base (eliabase): 5.9M records behind one read-only
 * JSON API — a hand-verified slice of self-improvement literature, plus bulk
 * Wikipedia, arXiv, Wikidata, Gutenberg, StackExchange and security feeds.
 * Source: github.com/MdSahilMolla/elia-knowledgebase (vercel/api/index.py).
 *
 * `ELIA_KB_URL` points it elsewhere — the same API served locally by the
 * repository's `kb_server.py` — and `ELIA_KB_API_KEY` is sent as `X-API-Key`
 * for a server that sets `KB_API_KEY`.
 *
 * `slice=all` is not offered: measured 2026-10-03, the hosted API answered it
 * with curated hits only ("react" matched ReAct papers) after 5–7s, so the
 * model would read loose matches as the whole knowledge base's answer.
 */

export const DEFAULT_KB_URL = 'https://eliabase.vercel.app'
const REQUEST_TIMEOUT_MS = 30_000
const MAX_RESPONSE_BYTES = 5_000_000
const DEFAULT_LIMIT = 8
const MAX_LIMIT = 25
const SNIPPET_CHARS = 400
const RECORD_CHARS = 12_000

/** Each slice, what it holds, and how far to trust it — the API's own trust labels. */
export const KB_SLICES = {
  curated: { holds: '213 hand-verified entries on self-improving agents: RSI, coding agents, evaluation and reward hacking, memory, planning, tool use, world models', trust: 'high — hand-verified' },
  general: { holds: 'English Wikipedia, 1.0M articles', trust: 'low — unvetted, verify before citing' },
  arxiv: { holds: 'arXiv metadata and abstracts, 3.2M papers in every category', trust: 'low — unvetted metadata, verify before citing' },
  wikidata: { holds: 'Wikidata entities (label + description), 479k', trust: 'low — unvetted, verify before citing' },
  gutenberg: { holds: 'Project Gutenberg public-domain books, 62k', trust: 'medium — public-domain text' },
  stackexchange: { holds: 'StackExchange Q&A with answers, 247k — mostly mathematics, statistics and science; little programming (not Stack Overflow)', trust: 'low — community answers, verify before citing' },
  cyber: { holds: 'security feeds, 904k: NVD CVEs, OSV/GHSA advisories, Exploit-DB, MITRE ATT&CK, CTF writeups', trust: 'low — bulk feeds, verify before citing' },
} as const

type Slice = keyof typeof KB_SLICES
const SLICE_NAMES = Object.keys(KB_SLICES) as Slice[]

function isSlice(value: unknown): value is Slice {
  return typeof value === 'string' && value in KB_SLICES
}

/** The API's base URL, without a trailing slash. */
export function knowledgeBaseUrl(env: Record<string, string | undefined> = process.env): string {
  return (env.ELIA_KB_URL?.trim() || DEFAULT_KB_URL).replace(/\/+$/, '')
}

async function requestJson(path: string): Promise<Record<string, unknown>> {
  const base = knowledgeBaseUrl()
  const url = `${base}${path}`
  const apiKey = process.env.ELIA_KB_API_KEY?.trim()
  const response = await publicFetch(url, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { Accept: 'application/json', 'User-Agent': 'elia-agent/0.1 (https://github.com/MdSahilMolla/elia)', ...(apiKey ? { 'X-API-Key': apiKey } : {}) },
    // The person pointed ELIA_KB_URL at their own machine (kb_server.py);
    // every other host still has to be a public one.
    ...(isExplicitLocalHostname(new URL(base).hostname) ? { policy: { allowExplicitLocal: true } } : {}),
  })
  if (response.status === 404) throw new Error(`knowledge base: nothing at ${path}`)
  if (!response.ok) throw new Error(`knowledge base request failed: ${response.status} ${response.statusText}`)
  const buffer = await response.arrayBuffer()
  if (buffer.byteLength > MAX_RESPONSE_BYTES) throw new Error(`knowledge base response exceeded ${MAX_RESPONSE_BYTES} bytes`)
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(buffer))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object')
    return parsed as Record<string, unknown>
  } catch {
    throw new Error(`knowledge base at ${base} did not answer with JSON — is ELIA_KB_URL the API's address?`)
  }
}

function str(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** Snippets mark matches with `<b>`; the model reads plain text. */
function plain(text: string): string {
  return text.replace(/<\/?b>/g, '').replace(/\s+/g, ' ').trim()
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

function formatHit(hit: Record<string, unknown>, index: number): string {
  const slice = str(hit.kb_slice) ?? '?'
  const title = plain(str(hit.title) ?? str(hit.snippet_title) ?? '(untitled)')
  const where = [slice, str(hit.domain) ?? str(hit.topic)].filter(Boolean).join(':')
  const authors = str(hit.authors)
  const year = str(hit.year)
  // Curated authors already end in the year ("Shinn et al., 2023").
  const byline = [authors, year && !authors?.includes(year) ? year : undefined].filter(Boolean).join(', ')
  const link = str(hit.link) ?? str(hit.url)
  const body = plain(str(hit.snippet_idea) ?? str(hit.snippet) ?? str(hit.text_head) ?? '')
  return [
    `${index + 1}. [${where}] ${title}${byline ? ` — ${byline}` : ''}`,
    `   record: slice=${slice} id=${str(hit.id) ?? '?'}${link ? ` · ${link}` : ''}${str(hit.tags) ? ` · tags: ${str(hit.tags)}` : ''}`,
    body ? `   ${clip(body, SNIPPET_CHARS)}` : '',
  ].filter(Boolean).join('\n')
}

async function search(query: string, slice: Slice, domain: string | undefined, limit: number): Promise<string> {
  const params = new URLSearchParams({ q: query, slice, limit: String(limit) })
  if (domain) params.set('domain', domain)
  const data = await requestJson(`/search?${params}`)
  const hits = Array.isArray(data.hits) ? data.hits.filter((hit): hit is Record<string, unknown> => typeof hit === 'object' && hit !== null) : []
  const total = typeof data.total === 'number' ? data.total : undefined
  const header = `Knowledge base · ${slice} (${KB_SLICES[slice].trust}) · "${query}"${domain ? ` · domain ${domain}` : ''} · ${hits.length}${total !== undefined ? ` of ${total}` : ''} match(es)`
  if (hits.length === 0) return `${header}\n\nNo matches. Try other words, or another slice: ${SLICE_NAMES.filter((name) => name !== slice).join(', ')}.`
  return `${header}\n\n${hits.map(formatHit).join('\n\n')}\n\nMatching is keyword-based (BM25), so read each title before relying on it. For the full text: action "record" with the slice and id.`
}

async function record(slice: Slice, id: string): Promise<string> {
  const data = await requestJson(`/record/${slice}/${encodeURIComponent(id)}`)
  const rec = typeof data.record === 'object' && data.record !== null ? data.record as Record<string, unknown> : data
  const lines = Object.entries(rec)
    .filter(([key, value]) => key !== 'id' && value !== null && value !== '' && (typeof value === 'string' || typeof value === 'number'))
    .map(([key, value]) => `${key}: ${typeof value === 'string' ? value.trim() : value}`)
  return clip(`Knowledge base record ${slice}/${id} (${KB_SLICES[slice].trust})\n\n${lines.join('\n')}`, RECORD_CHARS)
}

export const knowledgeTool: Tool = {
  name: 'knowledge',
  description: `Search elia's own knowledge base (eliabase): 5.9M records, read-only, no key. Use the curated slice first for anything about self-improving agents, coding agents, evaluation, reward hacking, memory, planning or tool use — it is the only hand-verified slice. Use cyber to look up a CVE, advisory, exploit, ATT&CK technique or CTF writeup. The other slices are bulk and unvetted: say so when you cite them, and confirm a fact that matters elsewhere.

Slices:
${SLICE_NAMES.map((name) => `- ${name}: ${KB_SLICES[name].holds}`).join('\n')}

search returns titles, links and snippets with each hit's slice and id; record returns one hit's full text; slices shows every slice's size and domains (e.g. arxiv has computing, ai, physics; cyber has advisory, vuln-db, exploit, att&ck).`,
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['search', 'record', 'slices'], description: 'search by keywords, read one record, or list the slices' },
      query: { type: 'string', description: 'For search: keywords. "Quoted phrases" are matched as phrases.' },
      slice: { type: 'string', enum: SLICE_NAMES, description: 'For search and record: which slice. Search defaults to cyber in cyber mode and curated otherwise.' },
      domain: { type: 'string', description: 'For search: narrow a bulk slice to one domain, e.g. "computing" or "ai" in arxiv, "exploit" in cyber' },
      id: { type: 'string', description: 'For record: the id a search hit showed' },
      limit: { type: 'number', description: `For search: how many hits, 1-${MAX_LIMIT}. Default ${DEFAULT_LIMIT}.` },
    },
    required: ['action'],
  },

  async execute(input) {
    const action = input.action
    if (action === 'slices') {
      const data = await requestJson('/slices')
      return `Knowledge base slices (${knowledgeBaseUrl()}):\n${JSON.stringify(data.slices ?? data, null, 1)}`
    }
    if (input.slice !== undefined && !isSlice(input.slice)) throw new Error(`slice must be one of: ${SLICE_NAMES.join(', ')}`)
    if (action === 'record') {
      if (!isSlice(input.slice)) throw new Error(`record needs the slice its search hit showed: ${SLICE_NAMES.join(', ')}`)
      const id = str(input.id)
      if (!id) throw new Error('record needs the id its search hit showed')
      return record(input.slice, id)
    }
    if (action !== 'search') throw new Error('action must be search, record, or slices')
    if (typeof input.query !== 'string' || !input.query.trim()) throw new Error('search needs a non-empty query')
    if (input.limit !== undefined && (typeof input.limit !== 'number' || !Number.isFinite(input.limit))) throw new Error('limit must be a number')
    const limit = Math.max(1, Math.min(MAX_LIMIT, typeof input.limit === 'number' ? Math.round(input.limit) : DEFAULT_LIMIT))
    const { activeMode } = await import('../autonomy/mode.ts')
    const slice: Slice = isSlice(input.slice) ? input.slice : activeMode() === 'cyber' ? 'cyber' : 'curated'
    return search(input.query.trim(), slice, str(input.domain), limit)
  },
}
