import { afterEach, expect, test } from 'bun:test'
import { DEFAULT_KB_URL, autoSlices, contentTerms, keywords, knowledgeBaseUrl, knowledgeProbe, knowledgeProbeEnabled, knowledgeTool, relevant } from './knowledge.ts'
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
  // Twice the limit is fetched, so the relevance cut still leaves enough to show.
  expect(Object.fromEntries(seen.urls[0]!.searchParams)).toEqual({ q: 'reflexion', slice: 'curated', limit: '6' })
  expect(out).toContain('curated (high — hand-verified)')
  expect(out).toContain('1 relevant of 1 fetched')
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
  expect(seen.urls[0]!.searchParams.get('limit')).toBe('16')
  expect(out).toContain('cyber (low — bulk feeds, verify before citing)')
  expect(out).toContain('[cyber:advisory] Security update for log4j')
})

test('with no slice, search reads the right slices together: cyber for security, StackExchange added for maths', async () => {
  const seen = serve({ hits: [] })
  await knowledgeTool.execute({ action: 'search', query: 'agent memory' })
  await withActiveMode('cyber', () => knowledgeTool.execute({ action: 'search', query: 'agent memory' }))
  expect(seen.urls.map((url) => url.searchParams.get('slice'))).toEqual(['curated', 'arxiv', 'general', 'cyber'])
  expect(autoSlices('is lodash affected by CVE-2021-23337', 'dev')).toEqual(['cyber'])
  expect(autoSlices('bayes theorem intuition', 'dev')).toEqual(['curated', 'stackexchange', 'arxiv', 'general'])
})

test('the server is sent the words that carry the meaning; matching ignores plurals', () => {
  expect(keywords('What does research say about agent memory?')).toEqual(['agent', 'memory'])
  expect(keywords('bayes theorem')).toEqual(['bayes', 'theorem'])
  expect(contentTerms('world models for agents')).toEqual(['world', 'model', 'agent'])
  expect(keywords('CVE-2021-44228')).toEqual(['cve', '2021', '44228'])
})

test('a hit that matches one loose word is dropped, and a search with nothing relevant says so', async () => {
  const react = { id: 1, kb_slice: 'curated', title: 'ReAct: Synergizing Reasoning and Acting in Language Models', snippet_idea: 'interleaves reasoning traces and actions' }
  const hook = { id: 2, kb_slice: 'general', title: 'React hooks', snippet: 'useEffect runs a cleanup function before the next effect' }
  expect(relevant(contentTerms('react useEffect cleanup'), react)).toBe(false)
  expect(relevant(contentTerms('react useEffect cleanup'), hook)).toBe(true)

  serve({ hits: [react] })
  const out = await knowledgeTool.execute({ action: 'search', query: 'react useEffect cleanup', slice: 'curated' })
  expect(out).toContain('0 relevant of 1 fetched')
  expect(out).toContain('they are the closest matches, not answers')
})

test('auto search puts hand-verified entries first, and keeps going when one slice fails', async () => {
  publicFetchTestHooks.transport = async (url) => {
    const slice = url.searchParams.get('slice')
    if (slice === 'general') return new Response('upstream error', { status: 502 })
    const hits = slice === 'curated'
      ? [{ id: 7, title: 'A-MEM: Agentic Memory for LLM Agents', snippet_idea: 'self-organizing agent memory' }]
      : [{ id: 9, title: 'Multi-Agent Memory from a Computer Architecture Perspective', score: 15.4 }, { id: 10, title: 'Deciding a Graph Property by a Single Mobile Agent' }]
    return new Response(JSON.stringify({ hits }))
  }
  const out = await knowledgeTool.execute({ action: 'search', query: 'what does research say about agent memory' })
  expect(out).toContain('searched as "agent memory"')
  expect(out).toContain('general did not answer')
  expect(out).toContain('2 relevant of 3 fetched')
  expect(out.indexOf('A-MEM')).toBeLessThan(out.indexOf('Multi-Agent Memory'))
  expect(out).not.toContain('Graph Property')
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
  await expect(knowledgeTool.execute({ action: 'search', query: 'x', slice: 'all' })).rejects.toThrow('slice must be auto or one of')
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
  for (const text of ['check the knowledge base for this', 'look up CVE-2021-44228', 'what does the literature on self-improving agents say',
    'what does research say about agent memory?', 'how does attention work', 'summarize the state of the art in reward hacking', 'find studies on LLM evaluation']) {
    expect(toolsCuedBy(text, ['knowledge']), text).toEqual(['knowledge'])
  }
  for (const text of ['fix the failing test in src/app.ts', 'add dark mode to the settings page', 'how does the auth middleware work', 'how does this function work',
    'research the codebase and fix the bug', 'add a tool that uses the llm client', 'write a binary search tree in python']) {
    expect(toolsCuedBy(text, ['knowledge']), text).toEqual([])
  }
})

test('before a turn, elia looks: verified entries that match the request become a hint; a coding request or a greeting gets none', async () => {
  const seen = serve({ hits: [
    { id: 94, title: 'A-MEM: Agentic Memory for LLM Agents', snippet_idea: 'self-organizing memory for agents', tags: 'memory' },
    { id: 12, title: 'ReAct: Synergizing Reasoning and Acting', snippet_idea: 'reasoning traces' },
  ] })
  const found = await knowledgeProbe('How should an agent keep long-term memory between sessions?')
  expect(seen.urls[0]!.searchParams.get('slice')).toBe('curated')
  expect(found?.entries).toEqual([{ id: '94', title: 'A-MEM: Agentic Memory for LLM Agents' }])
  expect(found?.hint).toContain('"A-MEM: Agentic Memory for LLM Agents" (id 94)')
  expect(found?.hint).toContain('slice "curated"')
  expect(found?.hint).toContain("for this project's own code, the code is the authority")

  // The same verified slice answers, but nothing in it is about the request.
  expect(await knowledgeProbe('fix the failing test in src/app.ts and rerun the build')).toBeUndefined()

  const asked = seen.urls.length
  expect(await knowledgeProbe('hey')).toBeUndefined()
  expect(await knowledgeProbe('go ahead')).toBeUndefined()
  expect(seen.urls.length).toBe(asked)
})

test('a probe the knowledge base cannot answer in time changes nothing', async () => {
  publicFetchTestHooks.transport = () => new Promise(() => {})
  const started = Date.now()
  expect(await knowledgeProbe('reward hacking in self improving agents', { timeoutMs: 50 })).toBeUndefined()
  expect(Date.now() - started).toBeLessThan(1_000)
  publicFetchTestHooks.transport = async () => new Response('down', { status: 503 })
  expect(await knowledgeProbe('world models for planning agents')).toBeUndefined()
})

test('the probe is off with ELIA_KB_PROBE=off, and in cyber mode where the tool is always loaded', () => {
  expect(knowledgeProbeEnabled('dev', {})).toBe(true)
  expect(knowledgeProbeEnabled('battmann', {})).toBe(true)
  expect(knowledgeProbeEnabled('dev', { ELIA_KB_PROBE: 'off' })).toBe(false)
  expect(knowledgeProbeEnabled('cyber', {})).toBe(false)
})

test('record understands an id written as "curated 144" or "curated/144"', async () => {
  const seen = serve({ record: { title: 'Large Language Models Cannot Self-Correct Reasoning Yet' } })
  await knowledgeTool.execute({ action: 'record', id: 'curated 144' })
  await knowledgeTool.execute({ action: 'record', id: 'curated/144' })
  await knowledgeTool.execute({ action: 'record', slice: 'arxiv', id: '621531' })
  expect(seen.urls.map((url) => url.pathname)).toEqual(['/record/curated/144', '/record/curated/144', '/record/arxiv/621531'])
})
