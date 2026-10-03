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

// --- Relevance -----------------------------------------------------------------
// The API ranks by BM25 alone, so a hit can match one loose word: "react
// useEffect cleanup" brought back the ReAct paper. Scores are not comparable
// across slices (curated returns none), so relevance is judged here, on what
// the model will read: the share of the query's content words a hit contains.

const STOPWORDS = new Set(('a an and are as at be about by can could do does did for from has have how i in into is it its me my of on or our say says said should show shows so than that the their them then there these this those to us was we what when where which who why will with would you your ' +
  'research researchers paper papers study studies literature published work works find found explain tell know known latest current recent ' +
  'should shall must keep get make use using used way ways best better good need needs want help like also just more most some any all each other between please give list ' +
  'go ahead ok okay yes yeah no continue thanks thank hey hi hello sure now done ' +
  // What to do to the code, not what it is about.
  'add adds adding fix fixes fixing remove create update updates change changes write rename refactor delete run set move implement').split(' '))

/** A word's comparable form: lower case, plural "s" dropped. */
function stem(word: string): string {
  return word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word
}

function words(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
}

/** The words of a query that carry its meaning, as written, de-duplicated. */
export function keywords(query: string): string[] {
  return [...new Set(words(query).filter((word) => !STOPWORDS.has(word) && (word.length > 1 || /\d/.test(word))))]
}

/** The same words in comparable form, for matching against hits. */
export function contentTerms(query: string): string[] {
  return [...new Set(keywords(query).map(stem))]
}

/** Share of `terms` found in a hit's title, snippet, tags and topic. */
export function coverage(terms: readonly string[], hit: Record<string, unknown>): number {
  if (terms.length === 0) return 1
  const text = [hit.title, hit.snippet_title, hit.snippet_idea, hit.snippet, hit.text_head, hit.tags, hit.topic, hit.domain].map((value) => str(value) ?? '').join(' ')
  const have = new Set(words(plain(text)).map(stem))
  return terms.filter((term) => have.has(term)).length / terms.length
}

/** Enough of the query to count: every word of a one- or two-word query, at least half of a longer one. */
export function relevant(terms: readonly string[], hit: Record<string, unknown>): boolean {
  const share = coverage(terms, hit)
  return terms.length <= 2 ? share === 1 : share >= 0.5
}

/**
 * The pre-turn probe's test, looser than a search's because a request is a
 * sentence, not keywords: at least two of its words (and 30% of them) in the
 * entry, and at least one in the entry's title or tags, so the entry is about
 * the topic rather than mentioning it in passing.
 */
export function bearsOn(terms: readonly string[], hit: Record<string, unknown>): boolean {
  if (terms.length < 2) return false
  const inText = new Set(words(plain([hit.title, hit.snippet_title, hit.snippet_idea, hit.snippet, hit.tags, hit.topic].map((value) => str(value) ?? '').join(' '))).map(stem))
  const inTitle = new Set(words(plain([hit.title, hit.tags].map((value) => str(value) ?? '').join(' '))).map(stem))
  const matched = terms.filter((term) => inText.has(term))
  return matched.length >= 2 && matched.length / terms.length >= 0.3 && matched.some((term) => inTitle.has(term))
}

const CYBER_QUERY = /\b(cve-\d{4}-\d+|ghsa-|cves?|vulnerab\w*|exploit\w*|advisor(y|ies)|att&ck|mitre|t1\d{3}|ctf|malware|ransomware|xss|sqli|sql injection|rce|privilege escalation|buffer overflow)\b/i
const MATH_QUERY = /\b(probabilit\w*|theorem|proofs?|prove|integral|derivative|regression|variance|statistic\w*|eigen\w*|matri(x|ces)|bayes\w*|distribution|hypothesis test|p-value|lemma)\b/i

/** The slices an unspecified search reads: security questions go to cyber, everything else to the verified slice plus arXiv and Wikipedia, with StackExchange for maths. */
export function autoSlices(query: string, mode: string): Slice[] {
  if (mode === 'cyber' || CYBER_QUERY.test(query)) return ['cyber']
  return MATH_QUERY.test(query) ? ['curated', 'stackexchange', 'arxiv', 'general'] : ['curated', 'arxiv', 'general']
}

type Ranked = { hit: Record<string, unknown>; share: number; rank: number }

async function fetchSlice(query: string, slice: Slice, domain: string | undefined, limit: number): Promise<Record<string, unknown>[]> {
  const params = new URLSearchParams({ q: query, slice, limit: String(limit) })
  if (domain) params.set('domain', domain)
  const data = await requestJson(`/search?${params}`)
  return Array.isArray(data.hits) ? data.hits.filter((hit): hit is Record<string, unknown> => typeof hit === 'object' && hit !== null).map((hit) => ({ kb_slice: slice, ...hit })) : []
}

async function search(query: string, slices: Slice[], domain: string | undefined, limit: number): Promise<string> {
  const terms = contentTerms(query)
  // The server ranks every word it is sent, "what does research say about"
  // included; it gets the words that carry the meaning, unless the model
  // quoted a phrase on purpose.
  const sent = query.includes('"') || terms.length === 0 ? query : keywords(query).join(' ')
  // Fetch more than will be shown, so the relevance cut still leaves enough.
  const perSlice = Math.min(MAX_LIMIT, Math.max(limit, slices.length > 1 ? 8 : limit * 2))
  const settled = await Promise.allSettled(slices.map((slice) => fetchSlice(sent, slice, domain, perSlice)))
  const failed = slices.filter((_, i) => settled[i]!.status === 'rejected')
  if (failed.length === slices.length) throw (settled[0] as PromiseRejectedResult).reason

  const ranked: Ranked[] = settled.flatMap((result) => result.status === 'fulfilled' ? result.value.map((hit, rank) => ({ hit, share: coverage(terms, hit), rank })) : [])
  const fetched = ranked.length
  let shown = ranked.filter(({ hit }) => relevant(terms, hit))
  const weak = shown.length === 0 && ranked.length > 0
  if (weak) shown = ranked.sort((a, b) => b.share - a.share || a.rank - b.rank).slice(0, 3)
  // Hand-verified first; then the closest matches; then the server's order.
  else shown = shown.sort((a, b) => Number(str(b.hit.kb_slice) === 'curated') - Number(str(a.hit.kb_slice) === 'curated') || b.share - a.share || a.rank - b.rank).slice(0, limit)

  const where = slices.length === 1 ? `${slices[0]} (${KB_SLICES[slices[0]!].trust})` : `${slices.join(' + ')}`
  const header = `Knowledge base · ${where} · "${query}"${sent !== query ? ` → searched as "${sent}"` : ''}${domain ? ` · domain ${domain}` : ''} · ${weak ? 0 : shown.length} relevant of ${fetched} fetched`
  const notes = [
    failed.length > 0 ? `${failed.join(', ')} did not answer; the rest are below.` : '',
    slices.length > 1 ? `Trust: ${slices.map((slice) => `${slice} ${KB_SLICES[slice].trust.split(' — ')[0]}`).join(' · ')}. Verify bulk-slice facts before citing them.` : '',
  ].filter(Boolean)
  if (fetched === 0) return [header, ...notes, `No matches. Try other words${slices.length === 1 ? `, or another slice: ${SLICE_NAMES.filter((name) => name !== slices[0]).join(', ')}` : ''}.`].join('\n\n')
  const body = shown.map(({ hit }, i) => formatHit(hit, i)).join('\n\n')
  const tail = weak
    ? `None of these contains most of "${terms.join(' ')}"; they are the closest matches, not answers. Try other words or another slice.`
    : 'For the full text: action "record" with the slice and id.'
  return [header, ...notes, body, tail].join('\n\n')
}

// --- Knowing when to look ------------------------------------------------------
// Words in a request are a weak signal of whether the knowledge base can help;
// the knowledge base itself is a strong one. Before a turn, the verified slice
// (answers in ~0.3s) is searched for the request's own words, and only entries
// that bear on the request (bearsOn) count. A match tells the
// model what exists and loads the tool; no match costs the model nothing.

export interface KnowledgeProbe {
  /** One line for the turn's dynamic prompt. */
  hint: string
  entries: { id: string; title: string }[]
}

const PROBE_TIMEOUT_MS = 1_200
const probeCache = new Map<string, KnowledgeProbe | undefined>()

/** Whether the pre-turn probe runs: on unless `ELIA_KB_PROBE=off`, never in cyber mode (the tool is always loaded there). */
export function knowledgeProbeEnabled(mode: string, env: Record<string, string | undefined> = process.env): boolean {
  const setting = env.ELIA_KB_PROBE?.trim().toLowerCase()
  if (setting === 'off' || setting === '0' || setting === 'false') return false
  return mode !== 'cyber'
}

/** The verified entries that bear on `request`, or undefined when there are none, the request is too thin to judge, or the knowledge base did not answer in time. */
export async function knowledgeProbe(request: string, options: { timeoutMs?: number } = {}): Promise<KnowledgeProbe | undefined> {
  const terms = contentTerms(request)
  // "hey", "go ahead", "yes": nothing to look up.
  if (terms.length < 2) return undefined
  // Long pastes are logs and code, not questions; their first words decide.
  const words = keywords(request).slice(0, 12)
  const key = words.join(' ')
  if (probeCache.has(key)) return probeCache.get(key)
  let result: KnowledgeProbe | undefined
  try {
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), options.timeoutMs ?? PROBE_TIMEOUT_MS))
    const hits = await Promise.race([fetchSlice(key, 'curated', undefined, 6), timeout])
    const probeTerms = contentTerms(key)
    const matching = hits.filter((hit) => bearsOn(probeTerms, hit)).slice(0, 3)
    if (matching.length > 0) {
      const entries = matching.map((hit) => ({ id: str(hit.id) ?? '?', title: plain(str(hit.title) ?? str(hit.snippet_title) ?? '') }))
      result = {
        entries,
        hint: `The knowledge base has hand-verified entries on this request: ${entries.map((entry) => `"${clip(entry.title, 90)}" (id ${entry.id})`).join('; ')}. If the answer turns on research or how a technique works, read them with the knowledge tool (action "record", slice "curated", the id) and cite them; for this project's own code, the code is the authority.`,
      }
    }
  } catch {
    // Unreachable or slow: the turn goes ahead exactly as it would have.
    return undefined
  }
  probeCache.set(key, result)
  return result
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
  description: `Search elia's own knowledge base (eliabase, 5.9M records, answers in about a second) for questions about the outside world: research and papers, how a technique or algorithm works, a CVE or exploit, a definition or fact. Use this instead of web_search for research and security questions; use web_search for news, prices and anything newer than a paper, and read the project's own files for questions about its code. Use the curated slice first for anything about self-improving agents, coding agents, evaluation, reward hacking, memory, planning or tool use — it is the only hand-verified slice. Use cyber to look up a CVE, advisory, exploit, ATT&CK technique or CTF writeup. The other slices are bulk and unvetted: say so when you cite them, and confirm a fact that matters elsewhere.

Slices:
${SLICE_NAMES.map((name) => `- ${name}: ${KB_SLICES[name].holds}`).join('\n')}

search with no slice reads the verified slice, arXiv and Wikipedia together (security questions go to cyber, maths adds StackExchange) and keeps only hits that contain most of the query's words, verified entries first. Write the query as keywords. search returns titles, links and snippets with each hit's slice and id; record returns one hit's full text; slices shows every slice's size and domains (e.g. arxiv has computing, ai, physics; cyber has advisory, vuln-db, exploit, att&ck).`,
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['search', 'record', 'slices'], description: 'search by keywords, read one record, or list the slices' },
      query: { type: 'string', description: 'For search: keywords. "Quoted phrases" are matched as phrases.' },
      slice: { type: 'string', enum: ['auto', ...SLICE_NAMES], description: 'For search: leave out (or "auto") to search the right slices together; name one to search only it. For record: the slice the hit showed.' },
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
    if (input.slice !== undefined && input.slice !== 'auto' && !isSlice(input.slice)) throw new Error(`slice must be auto or one of: ${SLICE_NAMES.join(', ')}`)
    if (action === 'record') {
      // A model that copies "curated 144" or "curated/144" from a hit meant slice and id.
      const written = str(input.id)?.match(/^([a-z]+)[\s/:]+(\S+)$/i)
      const slice = isSlice(input.slice) ? input.slice : written && isSlice(written[1]!.toLowerCase()) ? written[1]!.toLowerCase() as Slice : undefined
      const id = written && isSlice(written[1]!.toLowerCase()) ? written[2] : str(input.id)
      if (!slice) throw new Error(`record needs the slice its search hit showed: ${SLICE_NAMES.join(', ')}`)
      if (!id) throw new Error('record needs the id its search hit showed')
      return record(slice, id)
    }
    if (action !== 'search') throw new Error('action must be search, record, or slices')
    if (typeof input.query !== 'string' || !input.query.trim()) throw new Error('search needs a non-empty query')
    if (input.limit !== undefined && (typeof input.limit !== 'number' || !Number.isFinite(input.limit))) throw new Error('limit must be a number')
    const limit = Math.max(1, Math.min(MAX_LIMIT, typeof input.limit === 'number' ? Math.round(input.limit) : DEFAULT_LIMIT))
    const { activeMode } = await import('../autonomy/mode.ts')
    const query = input.query.trim()
    const slices = isSlice(input.slice) ? [input.slice] : autoSlices(query, activeMode())
    return search(query, slices, str(input.domain), limit)
  },
}
