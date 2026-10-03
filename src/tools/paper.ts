import type { Tool } from './types.ts'
import { publicFetch } from '../networkPolicy.ts'

/**
 * Research literature, from the APIs that actually serve it.
 *
 * Scholarly lookup used to go through `web_search` + `web_fetch`: a general web
 * index, then an HTML scrape of whatever it returned. That fails in specific
 * ways — publisher pages render client-side, DOI links are redirects, and the
 * useful facts (authors, date, venue, citation count, whether there is a free
 * copy) live in structured fields no prose scrape recovers reliably.
 *
 * OpenAlex, arXiv and Crossref serve all of it as JSON or Atom, free, with no
 * key and no JavaScript. This asks them directly.
 */

const REQUEST_TIMEOUT_MS = 20_000
const MAX_RESPONSE_BYTES = 5_000_000
const DEFAULT_LIMIT = 8
const MAX_LIMIT = 25
const ABSTRACT_CHARS = 1_800

type Source = 'openalex' | 'arxiv' | 'crossref'

interface Paper {
  title: string
  authors: string[]
  year?: number
  venue?: string
  doi?: string
  url?: string
  /** A link to a free full text when one is known — the version actually readable. */
  openAccessUrl?: string
  citations?: number
  abstract?: string
  source: Source
}

async function requestText(url: string, accept: string): Promise<string> {
  const response = await publicFetch(url, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    // OpenAlex and Crossref both ask for a contact address for their polite
    // pools and give faster, more reliable service in return.
    headers: { Accept: accept, 'User-Agent': 'elia-agent/0.1 (https://github.com/MdSahilMolla/elia)' },
  })
  if (!response.ok) throw new Error(`paper lookup failed: ${response.status} ${response.statusText}`)
  const buffer = await response.arrayBuffer()
  if (buffer.byteLength > MAX_RESPONSE_BYTES) throw new Error(`paper lookup failed: response exceeded ${MAX_RESPONSE_BYTES} bytes`)
  return new TextDecoder().decode(buffer)
}

async function requestJson(url: string): Promise<Record<string, unknown>> {
  const text = await requestText(url, 'application/json')
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object')
    return parsed as Record<string, unknown>
  } catch {
    throw new Error('paper lookup failed: the source returned a non-JSON response')
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null) : []
}

/**
 * OpenAlex ships abstracts as an inverted index — `{ word: [positions] }` —
 * because publishers license the index but not the running text. Rebuilding it
 * is just placing each word at each of its positions.
 */
function abstractFromInverted(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const slots: string[] = []
  for (const [word, positions] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(positions)) continue
    for (const position of positions) {
      if (typeof position === 'number' && position >= 0 && position < 50_000) slots[position] = word
    }
  }
  const text = slots.filter(Boolean).join(' ').trim()
  return text ? text.slice(0, ABSTRACT_CHARS) : undefined
}

function openAlexPaper(work: Record<string, unknown>): Paper {
  const authorships = records(work.authorships)
  const location = typeof work.primary_location === 'object' && work.primary_location !== null ? (work.primary_location as Record<string, unknown>) : undefined
  const venue = location && typeof location.source === 'object' && location.source !== null ? str((location.source as Record<string, unknown>).display_name) : undefined
  const best = typeof work.best_oa_location === 'object' && work.best_oa_location !== null ? (work.best_oa_location as Record<string, unknown>) : undefined
  return {
    title: str(work.display_name) ?? str(work.title) ?? '(untitled)',
    authors: authorships
      .map((entry) => (typeof entry.author === 'object' && entry.author !== null ? str((entry.author as Record<string, unknown>).display_name) : undefined))
      .filter((name): name is string => Boolean(name)),
    year: typeof work.publication_year === 'number' ? work.publication_year : undefined,
    venue,
    doi: str(work.doi)?.replace(/^https?:\/\/doi\.org\//i, ''),
    url: str(work.doi) ?? str(work.id),
    openAccessUrl: best ? (str(best.pdf_url) ?? str(best.landing_page_url)) : undefined,
    citations: typeof work.cited_by_count === 'number' ? work.cited_by_count : undefined,
    abstract: abstractFromInverted(work.abstract_inverted_index),
    source: 'openalex',
  }
}

/** arXiv answers in Atom; it is small and regular enough not to warrant an XML parser. */
function arxivPapers(xml: string, limit: number): Paper[] {
  const out: Paper[] = []
  const entries = xml.split(/<entry>/).slice(1)
  for (const entry of entries.slice(0, limit)) {
    const pick = (tag: string): string | undefined =>
      new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(entry)?.[1]?.replace(/\s+/g, ' ').trim()
    const id = pick('id')
    const published = pick('published')
    out.push({
      title: pick('title') ?? '(untitled)',
      authors: [...entry.matchAll(/<name>([\s\S]*?)<\/name>/g)].map((match) => match[1]!.trim()).filter(Boolean),
      year: published ? new Date(published).getUTCFullYear() : undefined,
      venue: 'arXiv',
      doi: pick('arxiv:doi'),
      url: id,
      openAccessUrl: id?.replace('/abs/', '/pdf/'),
      abstract: pick('summary')?.slice(0, ABSTRACT_CHARS),
      source: 'arxiv',
    })
  }
  return out
}

function crossrefPaper(item: Record<string, unknown>): Paper {
  const issued = typeof item.issued === 'object' && item.issued !== null ? (item.issued as Record<string, unknown>) : undefined
  const parts = issued && Array.isArray(issued['date-parts']) ? (issued['date-parts'] as unknown[])[0] : undefined
  const year = Array.isArray(parts) && typeof parts[0] === 'number' ? parts[0] : undefined
  return {
    title: (Array.isArray(item.title) ? str(item.title[0]) : str(item.title)) ?? '(untitled)',
    authors: records(item.author).map((a) => [str(a.given), str(a.family)].filter(Boolean).join(' ')).filter(Boolean),
    year,
    venue: Array.isArray(item['container-title']) ? str(item['container-title'][0]) : undefined,
    doi: str(item.DOI),
    url: str(item.URL),
    citations: typeof item['is-referenced-by-count'] === 'number' ? item['is-referenced-by-count'] : undefined,
    abstract: str(item.abstract)?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, ABSTRACT_CHARS),
    source: 'crossref',
  }
}

async function search(query: string, source: Source, limit: number): Promise<Paper[]> {
  if (source === 'arxiv') {
    const url = `http://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=${limit}&sortBy=relevance`
    return arxivPapers(await requestText(url, 'application/atom+xml'), limit)
  }
  if (source === 'crossref') {
    const data = await requestJson(`https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=${limit}`)
    const message = typeof data.message === 'object' && data.message !== null ? (data.message as Record<string, unknown>) : {}
    return records(message.items).map(crossrefPaper)
  }
  const data = await requestJson(`https://api.openalex.org/works?search=${encodeURIComponent(query)}&per_page=${limit}`)
  return records(data.results).map(openAlexPaper)
}

/** A DOI, an arXiv id, or an OpenAlex work id — whichever the caller happens to have. */
async function get(id: string): Promise<Paper> {
  const arxivId = /^(?:arxiv:)?(\d{4}\.\d{4,5}(?:v\d+)?)$/i.exec(id)?.[1]
  if (arxivId) {
    const papers = arxivPapers(await requestText(`http://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxivId)}`, 'application/atom+xml'), 1)
    if (papers.length === 0) throw new Error(`No arXiv paper with id ${arxivId}`)
    return papers[0]!
  }
  const doi = id.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').replace(/^doi:/i, '')
  const key = /^10\.\d{4,9}\//.test(doi) ? `https://doi.org/${doi}` : doi
  return openAlexPaper(await requestJson(`https://api.openalex.org/works/${encodeURIComponent(key)}`))
}

export function formatPapers(papers: Paper[], query: string): string {
  if (papers.length === 0) return `No papers found for ${JSON.stringify(query)}. Try broader terms, or a different source.`
  return papers
    .map((paper, index) => {
      const lines = [`${index + 1}. ${paper.title}`]
      const byline = [
        paper.authors.length > 3 ? `${paper.authors.slice(0, 3).join(', ')} et al.` : paper.authors.join(', '),
        paper.year ? String(paper.year) : undefined,
        paper.venue,
        typeof paper.citations === 'number' ? `${paper.citations} citations` : undefined,
      ].filter(Boolean).join(' · ')
      if (byline) lines.push(`   ${byline}`)
      if (paper.doi) lines.push(`   doi: ${paper.doi}`)
      // The link that can actually be read, called out separately from the
      // landing page — a paywalled DOI is not a readable source.
      if (paper.openAccessUrl) lines.push(`   free full text: ${paper.openAccessUrl}`)
      else if (paper.url) lines.push(`   ${paper.url}`)
      if (paper.abstract) lines.push(`   ${paper.abstract}`)
      return lines.join('\n')
    })
    .join('\n\n')
}

export const paperTool: Tool = {
  name: 'paper',
  description: `Search and read research literature through OpenAlex, arXiv and Crossref — free, no key, structured. Use this instead of web_search whenever the question is about published research: it returns titles, authors, year, venue, DOI, citation counts, abstracts, and a link to a free full text when one exists.

search finds papers by topic. get looks one up by DOI, arXiv id, or OpenAlex id. Sources: openalex (default, broadest coverage), arxiv (preprints, full abstracts, always a free PDF), crossref (published record and DOIs).

Once you have a "free full text" link, web_fetch reads it — including PDFs. Prefer that over summarising from an abstract alone when the details matter.

For self-improving agents, coding agents, agent evaluation, reward hacking, agent memory, planning or tool use, search the knowledge tool's curated slice first: its entries are hand-verified, with the key idea and limitations written out. Use paper to go beyond it.`,
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['search', 'get'], description: 'search by topic, or get one paper by id' },
      query: { type: 'string', description: 'For search: the topic or title to look for' },
      id: { type: 'string', description: 'For get: a DOI ("10.1038/nature14539"), an arXiv id ("1706.03762"), or an OpenAlex id' },
      source: { type: 'string', enum: ['openalex', 'arxiv', 'crossref'], description: 'Which index to search. Default openalex.' },
      limit: { type: 'number', description: `How many results, 1-${MAX_LIMIT}. Default ${DEFAULT_LIMIT}.` },
    },
    required: ['action'],
  },

  async execute(input) {
    const action = input.action
    if (action !== 'search' && action !== 'get') throw new Error('action must be search or get')

    if (action === 'get') {
      if (typeof input.id !== 'string' || input.id.trim().length === 0) throw new Error('get requires an id (a DOI, arXiv id, or OpenAlex id)')
      return formatPapers([await get(input.id.trim())], input.id.trim())
    }

    if (typeof input.query !== 'string' || input.query.trim().length === 0) throw new Error('search requires a non-empty query')
    const source = input.source === undefined ? 'openalex' : input.source
    if (source !== 'openalex' && source !== 'arxiv' && source !== 'crossref') throw new Error('source must be openalex, arxiv, or crossref')
    if (input.limit !== undefined && (typeof input.limit !== 'number' || !Number.isFinite(input.limit))) throw new Error('limit must be a number')
    const limit = Math.max(1, Math.min(MAX_LIMIT, typeof input.limit === 'number' ? Math.round(input.limit) : DEFAULT_LIMIT))
    const query = input.query.trim()
    return formatPapers(await search(query, source, limit), query)
  },
}
