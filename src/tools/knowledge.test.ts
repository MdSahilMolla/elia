import { afterEach, expect, test } from 'bun:test'
import { DEFAULT_KB_URL, knowledgeBaseUrl, knowledgeTool } from './knowledge.ts'
import { publicFetchTestHooks } from '../networkPolicy.ts'
import { withActiveMode } from '../autonomy/mode.ts'
import { deferredToolsForMode, toolsCuedBy } from './lazyTools.ts'
import { allBuiltinTools } from './registry.ts'

const previousUrl = process.env.ELIA_KB_URL
const previousKey = process.env.ELIA_KB_API_KEY

afterEach(() => {
  publicFetchTestHooks.transport = undefined
  if (previousUrl === undefined) delete process.env.ELIA_KB_URL
  else process.env.ELIA_KB_URL = previousUrl
  if (previousKey === undefined) delete process.env.ELIA_KB_API_KEY
  else process.env.ELIA_KB_API_KEY = previousKey
})

/** Answers every request with `body`, recording what was asked. */
function serve(body: unknown, status = 200): { urls: URL[]; headers: Record<string, string>[] } {
  const seen = { urls: [] as URL[], headers: [] as Record<string, string>[] }
  publicFetchTestHooks.transport = async (url, init) => {
    seen.urls.push(url)
    seen.headers.push(init.headers ?? {})
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
  }
  return seen
}

const CURATED_HIT = {
  id: 140, kb_slice: 'curated', topic: 'self-improving-language-models', title: 'Reflexion: Language Agents with Verbal Reinforcement Learning',
  authors: 'Shinn et al., 2023', year: 2023, link: 'https://arxiv.org/abs/2303.11366', tags: 'self-correction, memory',
  snippet_idea: 'The <b>reinforcement</b> happens in language, not weights.',
}

test('search sends the query, slice and limit, and shows each hit with its trust, link and record id', async () => {
  delete process.env.ELIA_KB_URL
  const seen = serve({ total: 14, hits: [CURATED_HIT] })
  const out = await knowledgeTool.execute({ action: 'search', query: 'reflexion', slice: 'curated', limit: 3 })

  expect(seen.urls[0]!.origin).toBe(DEFAULT_KB_URL)
  expect(seen.urls[0]!.pathname).toBe('/search')
  expect(Object.fromEntries(seen.urls[0]!.searchParams)).toEqual({ q: 'reflexion', slice: 'curated', limit: '3' })
  expect(out).toContain('curated (high — hand-verified)')
  expect(out).toContain('1 of 14 match(es)')
  expect(out).toContain('Reflexion: Language Agents with Verbal Reinforcement Learning — Shinn et al., 2023\n')
  expect(out).toContain('record: slice=curated id=140 · https://arxiv.org/abs/2303.11366')
  // Highlight markup is stripped for the model.
  expect(out).toContain('The reinforcement happens in language')
  expect(out).not.toContain('<b>')
})

test('a bulk slice is labelled unvetted, and a domain narrows it', async () => {
  const seen = serve({ total: 52, hits: [{ id: 903249, kb_slice: 'cyber', domain: 'advisory', title: 'Security update for log4j', url: 'https://osv.dev/x', snippet: 'CVE-2021-44228: remote code execution' }] })
  const out = await knowledgeTool.execute({ action: 'search', query: 'CVE-2021-44228', slice: 'cyber', domain: 'advisory' })
  expect(seen.urls[0]!.searchParams.get('domain')).toBe('advisory')
  expect(seen.urls[0]!.searchParams.get('limit')).toBe('8')
  expect(out).toContain('cyber (low — bulk feeds, verify before citing)')
  expect(out).toContain('[cyber:advisory] Security update for log4j')
})

test('with no slice, search uses cyber in cyber mode and curated otherwise', async () => {
  const seen = serve({ hits: [] })
  await knowledgeTool.execute({ action: 'search', query: 'x' })
  await withActiveMode('cyber', () => knowledgeTool.execute({ action: 'search', query: 'x' }))
  expect(seen.urls.map((url) => url.searchParams.get('slice'))).toEqual(['curated', 'cyber'])
})

test('no matches says so and names the other slices', async () => {
  serve({ total: 0, hits: [] })
  const out = await knowledgeTool.execute({ action: 'search', query: 'nothing', slice: 'arxiv' })
  expect(out).toContain('No matches')
  expect(out).toContain('curated, general, wikidata')
})

test('record fetches one entry in full', async () => {
  const seen = serve({ slice: 'curated', id: 140, record: { id: 140, title: 'Reflexion', key_idea: 'Act, fail, reflect, retry.', link_verified: 1 } })
  const out = await knowledgeTool.execute({ action: 'record', slice: 'curated', id: '140' })
  expect(seen.urls[0]!.pathname).toBe('/record/curated/140')
  expect(out).toContain('key_idea: Act, fail, reflect, retry.')
})

test('bad input is refused before any request: an unknown or "all" slice, a record without its slice, an empty query', async () => {
  const seen = serve({ hits: [] })
  await expect(knowledgeTool.execute({ action: 'search', query: 'x', slice: 'all' })).rejects.toThrow('slice must be one of')
  await expect(knowledgeTool.execute({ action: 'record', id: '1' })).rejects.toThrow('record needs the slice')
  await expect(knowledgeTool.execute({ action: 'record', slice: 'curated' })).rejects.toThrow('record needs the id')
  await expect(knowledgeTool.execute({ action: 'search', query: '  ' })).rejects.toThrow('non-empty query')
  expect(seen.urls).toHaveLength(0)
})

test('a missing record and a non-JSON answer are reported plainly', async () => {
  serve({ detail: 'not found' }, 404)
  await expect(knowledgeTool.execute({ action: 'record', slice: 'arxiv', id: '9' })).rejects.toThrow('nothing at /record/arxiv/9')
  serve('<!DOCTYPE html><html></html>')
  await expect(knowledgeTool.execute({ action: 'search', query: 'x', slice: 'curated' })).rejects.toThrow('did not answer with JSON')
})

test('ELIA_KB_URL points at a local kb_server, and ELIA_KB_API_KEY is sent as X-API-Key', async () => {
  process.env.ELIA_KB_URL = 'http://127.0.0.1:8000/'
  process.env.ELIA_KB_API_KEY = 'local-key'
  expect(knowledgeBaseUrl()).toBe('http://127.0.0.1:8000')
  const seen = serve({ hits: [] })
  await knowledgeTool.execute({ action: 'search', query: 'x', slice: 'general' })
  expect(seen.urls[0]!.origin).toBe('http://127.0.0.1:8000')
  expect(seen.headers[0]!['X-API-Key']).toBe('local-key')
})

test('a private address that is not this machine is still refused', async () => {
  process.env.ELIA_KB_URL = 'http://10.0.0.5:8000'
  serve({ hits: [] })
  await expect(knowledgeTool.execute({ action: 'search', query: 'x', slice: 'general' })).rejects.toThrow()
})

test('it is a built-in tool, deferred until needed, cued by its words, and kept in full in cyber mode', () => {
  expect(allBuiltinTools().some((tool) => tool.name === 'knowledge')).toBe(true)
  expect(deferredToolsForMode('dev').has('knowledge')).toBe(true)
  expect(deferredToolsForMode('cyber').has('knowledge')).toBe(false)
  for (const text of ['check the knowledge base for this', 'look up CVE-2021-44228', 'what does the literature on self-improving agents say']) {
    expect(toolsCuedBy(text, ['knowledge']), text).toEqual(['knowledge'])
  }
  expect(toolsCuedBy('fix the failing test in src/app.ts', ['knowledge'])).toEqual([])
})
