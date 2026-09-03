import type { Tool } from './types.ts'

const SEARCH_TIMEOUT_MS = 20_000
const MAX_QUERY_LENGTH = 2_000
type SearchProvider = 'brave' | 'exa' | 'serper'
interface SearchResult { title: string; url: string; snippet: string; publishedAt?: string; author?: string }

function providerKey(provider: SearchProvider): string | undefined {
  if (provider === 'exa') return process.env.EXA_API_KEY?.trim()
  if (provider === 'serper') return process.env.SERPER_API_KEY?.trim()
  return process.env.ELIA_SEARCH_API_KEY?.trim()
}

function resolveProvider(requested?: unknown): SearchProvider {
  const value = typeof requested === 'string' && requested.trim() ? requested.trim().toLowerCase() : (process.env.ELIA_SEARCH_PROVIDER?.trim().toLowerCase() || 'auto')
  if (!['auto', 'brave', 'exa', 'serper'].includes(value)) throw new Error(`Unsupported ELIA_SEARCH_PROVIDER "${value}" — use auto, brave, exa, or serper.`)
  if (value !== 'auto') {
    const provider = value as SearchProvider
    if (!providerKey(provider)) throw new Error(`${provider} web_search needs ${provider === 'exa' ? 'EXA_API_KEY' : provider === 'serper' ? 'SERPER_API_KEY' : 'ELIA_SEARCH_API_KEY'} set.`)
    return provider
  }
  for (const provider of ['exa', 'serper', 'brave'] as const) if (providerKey(provider)) return provider
  throw new Error('web_search needs EXA_API_KEY, SERPER_API_KEY, or ELIA_SEARCH_API_KEY (Brave) set.')
}

function stringArray(input: unknown, name: string): string[] | undefined {
  if (input === undefined) return undefined
  if (!Array.isArray(input) || input.some((value) => typeof value !== 'string')) throw new Error(`${name} must be an array of strings`)
  return input.map((value) => value.trim()).filter(Boolean).slice(0, 20)
}

function isoDate(input: unknown, name: string): string | undefined {
  if (input === undefined) return undefined
  if (typeof input !== 'string' || !Number.isFinite(Date.parse(input))) throw new Error(`${name} must be an ISO date or timestamp`)
  return new Date(input).toISOString()
}

async function requestJson(url: string, init: RequestInit): Promise<Record<string, unknown>> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    if (!response.ok) throw new Error(`web_search failed: ${response.status} ${response.statusText}`)
    return await response.json() as Record<string, unknown>
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('web_search failed:')) throw error
    throw new Error(`web_search request failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally { clearTimeout(timeout) }
}

/** Server-authoritative recency: the model cannot be trusted to compute "last N days" from a date it may have wrong. */
function recencyStart(recencyDays: number | undefined): string | undefined {
  if (recencyDays === undefined) return undefined
  return new Date(Date.now() - recencyDays * 86_400_000).toISOString()
}
function braveFreshness(recencyDays: number | undefined): string | undefined {
  if (recencyDays === undefined) return undefined
  return recencyDays <= 1 ? 'pd' : recencyDays <= 7 ? 'pw' : recencyDays <= 31 ? 'pm' : recencyDays <= 366 ? 'py' : undefined
}
function serperRecency(recencyDays: number | undefined): string | undefined {
  if (recencyDays === undefined) return undefined
  return recencyDays <= 1 ? 'qdr:d' : recencyDays <= 7 ? 'qdr:w' : recencyDays <= 31 ? 'qdr:m' : recencyDays <= 366 ? 'qdr:y' : undefined
}

async function braveSearch(query: string, count: number, include?: string[], exclude?: string[], recencyDays?: number): Promise<SearchResult[]> {
  const url = new URL('https://api.search.brave.com/res/v1/web/search')
  url.searchParams.set('q', [query, ...(include?.map((d) => `site:${d}`) ?? []), ...(exclude?.map((d) => `-site:${d}`) ?? [])].join(' '))
  url.searchParams.set('count', String(count))
  const freshness = braveFreshness(recencyDays)
  if (freshness) url.searchParams.set('freshness', freshness)
  const data = await requestJson(url.toString(), { headers: { Accept: 'application/json', 'X-Subscription-Token': providerKey('brave')! } })
  const web = data.web as { results?: Array<{ title?: string; url?: string; description?: string; age?: string }> } | undefined
  return (web?.results ?? []).map((r) => ({ title: r.title ?? '(untitled)', url: r.url ?? '', snippet: stripTags(r.description ?? ''), publishedAt: r.age }))
}

async function exaSearch(query: string, count: number, include?: string[], exclude?: string[], start?: string, end?: string): Promise<SearchResult[]> {
  const data = await requestJson('https://api.exa.ai/search', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': providerKey('exa')! }, body: JSON.stringify({ query, numResults: count, type: 'auto', moderation: true, contents: { highlights: true }, includeDomains: include, excludeDomains: exclude, startPublishedDate: start, endPublishedDate: end }) })
  return (Array.isArray(data.results) ? data.results as Array<Record<string, unknown>> : []).map((r) => ({
    title: typeof r.title === 'string' ? r.title : '(untitled)', url: typeof r.url === 'string' ? r.url : '',
    snippet: typeof r.summary === 'string' ? r.summary : Array.isArray(r.highlights) ? r.highlights.filter((v): v is string => typeof v === 'string').join(' ') : typeof r.text === 'string' ? r.text.slice(0, 1_000) : '',
    publishedAt: typeof r.publishedDate === 'string' ? r.publishedDate : undefined, author: typeof r.author === 'string' ? r.author : undefined,
  }))
}

async function serperSearch(query: string, count: number, country?: unknown, language?: unknown, recencyDays?: number): Promise<SearchResult[]> {
  const tbs = serperRecency(recencyDays)
  const data = await requestJson('https://google.serper.dev/search', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-KEY': providerKey('serper')! }, body: JSON.stringify({ q: query, num: count, ...(tbs ? { tbs } : {}), ...(typeof country === 'string' && country.trim() ? { gl: country.trim() } : {}), ...(typeof language === 'string' && language.trim() ? { hl: language.trim() } : {}) }) })
  return (Array.isArray(data.organic) ? data.organic as Array<Record<string, unknown>> : []).slice(0, count).map((r) => ({ title: typeof r.title === 'string' ? r.title : '(untitled)', url: typeof r.link === 'string' ? r.link : '', snippet: typeof r.snippet === 'string' ? r.snippet : '', publishedAt: typeof r.date === 'string' ? r.date : undefined }))
}

export const webSearchTool: Tool = {
  name: 'web_search',
  description: 'Search current web evidence through Exa, Serper, or Brave and return normalized source URLs, snippets, dates, authors, provider, and retrieval time. Available in every Elia mode. Prefer primary sources and fetch selected pages before treating snippets as evidence. Pass recencyDays to restrict results to the last N days when the question turns on current events — it is computed against the real clock, so use it instead of guessing a startPublishedDate.',
  input_schema: { type: 'object', properties: {
    query: { type: 'string' }, provider: { type: 'string', enum: ['auto', 'exa', 'serper', 'brave'] }, count: { type: 'number', description: '1-20 results' },
    includeDomains: { type: 'array' }, excludeDomains: { type: 'array' }, startPublishedDate: { type: 'string' }, endPublishedDate: { type: 'string' },
    recencyDays: { type: 'number', description: 'Only results published within the last N days (1-3650), applied from the server clock. Overrides startPublishedDate when both are given.' },
    country: { type: 'string' }, language: { type: 'string' },
  }, required: ['query'] },
  async execute(input) {
    if (typeof input.query !== 'string' || !input.query.trim()) throw new Error('query must be a non-empty string')
    if (input.query.length > MAX_QUERY_LENGTH) throw new Error(`query exceeds ${MAX_QUERY_LENGTH} characters`)
    const query = input.query.trim(); const provider = resolveProvider(input.provider)
    const count = input.count === undefined ? 8 : typeof input.count === 'number' && Number.isFinite(input.count) ? Math.max(1, Math.min(20, Math.round(input.count))) : (() => { throw new Error('count must be a number') })()
    const include = stringArray(input.includeDomains, 'includeDomains'); const exclude = stringArray(input.excludeDomains, 'excludeDomains')
    let recencyDays: number | undefined
    if (input.recencyDays !== undefined) {
      if (typeof input.recencyDays !== 'number' || !Number.isFinite(input.recencyDays) || input.recencyDays < 1 || input.recencyDays > 3650) throw new Error('recencyDays must be a number between 1 and 3650')
      recencyDays = Math.round(input.recencyDays)
    }
    const start = recencyStart(recencyDays) ?? isoDate(input.startPublishedDate, 'startPublishedDate'); const end = isoDate(input.endPublishedDate, 'endPublishedDate')
    if (start && end && start > end) throw new Error('startPublishedDate must not be after endPublishedDate')
    const results = provider === 'exa' ? await exaSearch(query, count, include, exclude, start, end) : provider === 'serper' ? await serperSearch(query, count, input.country, input.language, recencyDays) : await braveSearch(query, count, include, exclude, recencyDays)
    const header = [`Search provider: ${provider}`, `Retrieved: ${new Date().toISOString()}`, `Query: ${query}`, ...(recencyDays ? [`Recency filter: last ${recencyDays} day(s)`] : [])]
    if (!results.length) return [...header, 'No results found.'].join('\n')
    return [...header, '', ...results.map((r, i) => [`${i + 1}. ${r.title}`, `   ${r.url}`, r.publishedAt ? `   Published: ${r.publishedAt}` : '', r.author ? `   Author: ${r.author}` : '', r.snippet ? `   ${stripTags(r.snippet).slice(0, 2_000)}` : ''].filter(Boolean).join('\n'))].join('\n')
  },
}

function stripTags(text: string): string { return text.replace(/<[^>]+>/g, '') }
export { resolveProvider }
