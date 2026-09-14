import { afterEach, expect, test } from 'bun:test'
import { paperTool } from './paper.ts'
import { publicFetchTestHooks } from '../networkPolicy.ts'

afterEach(() => {
  publicFetchTestHooks.transport = undefined
})

/** Answer whichever source the tool reaches for, and record the URLs it asked for. */
function serve(body: string, init: ResponseInit = { status: 200 }): string[] {
  const asked: string[] = []
  publicFetchTestHooks.transport = async (url) => {
    asked.push(url.toString())
    return new Response(body, init)
  }
  return asked
}

const OPENALEX_WORK = {
  display_name: 'Attention Is All You Need',
  publication_year: 2017,
  cited_by_count: 140_000,
  doi: 'https://doi.org/10.5555/3295222.3295349',
  authorships: [
    { author: { display_name: 'Ashish Vaswani' } },
    { author: { display_name: 'Noam Shazeer' } },
    { author: { display_name: 'Niki Parmar' } },
    { author: { display_name: 'Jakob Uszkoreit' } },
  ],
  primary_location: { source: { display_name: 'NeurIPS' } },
  best_oa_location: { pdf_url: 'https://arxiv.org/pdf/1706.03762' },
  // OpenAlex licenses the index, not the running text, so abstracts arrive inverted.
  abstract_inverted_index: { The: [0], dominant: [1], sequence: [2], transduction: [3], models: [4] },
}

test('a search returns the fields a prose scrape cannot recover', async () => {
  const asked = serve(JSON.stringify({ results: [OPENALEX_WORK] }))
  const result = await paperTool.execute({ action: 'search', query: 'transformer architecture' })

  expect(asked[0]).toContain('api.openalex.org/works?search=transformer%20architecture')
  expect(result).toContain('Attention Is All You Need')
  expect(result).toContain('2017')
  expect(result).toContain('NeurIPS')
  expect(result).toContain('140000 citations')
  expect(result).toContain('doi: 10.5555/3295222.3295349')
})

test('the inverted abstract index is rebuilt into readable text', async () => {
  serve(JSON.stringify({ results: [OPENALEX_WORK] }))
  const result = await paperTool.execute({ action: 'search', query: 'transformers' })
  expect(result).toContain('The dominant sequence transduction models')
})

test('a free full-text link is surfaced as the readable one', async () => {
  // A paywalled DOI is not a source elia can actually read; the OA link is.
  serve(JSON.stringify({ results: [OPENALEX_WORK] }))
  const result = await paperTool.execute({ action: 'search', query: 'transformers' })
  expect(result).toContain('free full text: https://arxiv.org/pdf/1706.03762')
})

test('more than three authors are shortened with et al.', async () => {
  serve(JSON.stringify({ results: [OPENALEX_WORK] }))
  const result = await paperTool.execute({ action: 'search', query: 'transformers' })
  expect(result).toContain('Ashish Vaswani, Noam Shazeer, Niki Parmar et al.')
  expect(result).not.toContain('Jakob Uszkoreit')
})

const ARXIV_ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<entry>
  <id>http://arxiv.org/abs/1706.03762v5</id>
  <published>2017-06-12T00:00:00Z</published>
  <title>Attention Is All You Need</title>
  <summary>We propose a new simple network architecture, the Transformer.</summary>
  <author><name>Ashish Vaswani</name></author>
  <author><name>Noam Shazeer</name></author>
</entry>
</feed>`

test('arXiv is parsed from Atom, and its PDF link is derived from the abs link', async () => {
  const asked = serve(ARXIV_ATOM)
  const result = await paperTool.execute({ action: 'search', query: 'transformer', source: 'arxiv' })
  expect(asked[0]).toContain('export.arxiv.org/api/query?search_query=all:transformer')
  expect(result).toContain('Attention Is All You Need')
  expect(result).toContain('We propose a new simple network architecture')
  expect(result).toContain('free full text: http://arxiv.org/pdf/1706.03762v5')
})

test('get resolves an arXiv id against arXiv rather than the DOI index', async () => {
  const asked = serve(ARXIV_ATOM)
  await paperTool.execute({ action: 'get', id: '1706.03762' })
  expect(asked[0]).toContain('id_list=1706.03762')
})

test('get resolves a DOI, in bare, prefixed, and full-URL form, against OpenAlex', async () => {
  for (const id of ['10.1038/nature14539', 'doi:10.1038/nature14539', 'https://doi.org/10.1038/nature14539']) {
    const asked = serve(JSON.stringify(OPENALEX_WORK))
    await paperTool.execute({ action: 'get', id })
    expect(asked[0]).toContain('api.openalex.org/works/https%3A%2F%2Fdoi.org%2F10.1038%2Fnature14539')
  }
})

test('crossref strips the markup its abstracts carry', async () => {
  serve(JSON.stringify({
    message: {
      items: [{
        title: ['Deep learning'],
        DOI: '10.1038/nature14539',
        'is-referenced-by-count': 90_000,
        issued: { 'date-parts': [[2015]] },
        'container-title': ['Nature'],
        author: [{ given: 'Yann', family: 'LeCun' }],
        abstract: '<jats:p>Deep learning allows computational models.</jats:p>',
      }],
    },
  }))
  const result = await paperTool.execute({ action: 'search', query: 'deep learning', source: 'crossref' })
  expect(result).toContain('Deep learning allows computational models.')
  expect(result).not.toContain('jats:p')
  expect(result).toContain('Yann LeCun · 2015 · Nature')
})

test('an empty result says so instead of returning nothing', async () => {
  serve(JSON.stringify({ results: [] }))
  expect(await paperTool.execute({ action: 'search', query: 'zzz no such topic' })).toContain('No papers found')
})

test('a failing source is reported rather than swallowed', async () => {
  serve('upstream is down', { status: 503, statusText: 'Service Unavailable' })
  await expect(paperTool.execute({ action: 'search', query: 'anything' })).rejects.toThrow('503')
})

test('input is validated', async () => {
  await expect(paperTool.execute({ action: 'browse' })).rejects.toThrow('action must be search or get')
  await expect(paperTool.execute({ action: 'search' })).rejects.toThrow('non-empty query')
  await expect(paperTool.execute({ action: 'get' })).rejects.toThrow('requires an id')
  await expect(paperTool.execute({ action: 'search', query: 'x', source: 'scholar' })).rejects.toThrow('source must be')
})

test('the result count is clamped to the documented range', async () => {
  const asked = serve(JSON.stringify({ results: [] }))
  await paperTool.execute({ action: 'search', query: 'x', limit: 9_000 })
  expect(asked[0]).toContain('per_page=25')
})
