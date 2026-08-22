import type { Tool } from './types.ts'

const SEARCH_TIMEOUT_MS = 15_000
const RESULT_COUNT = 8

interface BraveResult {
  title?: string
  url?: string
  description?: string
}

function searchProvider(): string {
  return process.env.ELIA_SEARCH_PROVIDER ?? 'brave'
}

/** Real external market/competitor research for the Marketing and Finance personas — see src/agents/personas.ts. */
export const webSearchTool: Tool = {
  name: 'web_search',
  description:
    'Search the web and return the top results (title, url, snippet) for a query. Use this for market research, competitor research, or looking up current information not in this project.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query' },
    },
    required: ['query'],
  },
  async execute(input) {
    const query = input.query as string
    const provider = searchProvider()
    if (provider !== 'brave') {
      throw new Error(`Unsupported ELIA_SEARCH_PROVIDER "${provider}" — only "brave" is implemented right now.`)
    }

    const apiKey = process.env.ELIA_SEARCH_API_KEY
    if (!apiKey) {
      throw new Error(
        'web_search needs ELIA_SEARCH_API_KEY set. Sign up for a free Brave Search API key at https://brave.com/search/api/ and add it to .env.',
      )
    }

    const url = new URL('https://api.search.brave.com/res/v1/web/search')
    url.searchParams.set('q', query)
    url.searchParams.set('count', String(RESULT_COUNT))

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS)
    let response: Response
    try {
      response = await fetch(url, {
        headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey },
        signal: controller.signal,
      })
    } catch (err) {
      throw new Error(`web_search request failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      clearTimeout(timeout)
    }

    if (!response.ok) {
      throw new Error(`web_search failed: ${response.status} ${response.statusText}`)
    }

    const data = (await response.json()) as { web?: { results?: BraveResult[] } }
    const results = data.web?.results ?? []
    if (results.length === 0) return 'No results found.'

    return results
      .map(
        (result, i) =>
          `${i + 1}. ${result.title ?? '(untitled)'}\n   ${result.url ?? ''}\n   ${stripTags(result.description ?? '')}`,
      )
      .join('\n\n')
  },
}

function stripTags(text: string): string {
  return text.replace(/<[^>]+>/g, '')
}
