import { createHash } from 'node:crypto'

/**
 * The pages web_fetch actually retrieved in this process, so evidence can be checked against them.
 *
 * A model that cites a search snippet, or paraphrases a page it never opened, produces evidence that reads
 * exactly like a quote. Keeping the text the fetch returned lets Battmann confirm that a recorded excerpt is
 * on the page it names. Bounded: the most recent pages only, each capped.
 */

const MAX_PAGES = 64
const MAX_TEXT = 400_000

export interface FetchedPage { url: string; text: string; sha256: string; fetchedAt: string }

const pages = new Map<string, FetchedPage>()

/** A URL's identity for lookup: no fragment, no trailing slash, lower-case host. */
export function pageKey(raw: string): string {
  try {
    const url = new URL(raw.trim())
    url.hash = ''
    url.hostname = url.hostname.toLowerCase()
    return url.toString().replace(/\/+$/, '')
  } catch {
    return raw.trim()
  }
}

export function rememberFetchedPage(urls: string[], text: string): void {
  const kept = text.slice(0, MAX_TEXT)
  const page: FetchedPage = { url: urls[urls.length - 1] ?? urls[0] ?? '', text: kept, sha256: createHash('sha256').update(kept).digest('hex'), fetchedAt: new Date().toISOString() }
  for (const url of new Set(urls.map(pageKey))) {
    pages.delete(url)
    pages.set(url, page)
  }
  while (pages.size > MAX_PAGES) pages.delete(pages.keys().next().value!)
}

export function lookupFetchedPage(url: string): FetchedPage | undefined {
  return pages.get(pageKey(url))
}

/** Test seam. */
export function forgetFetchedPages(): void {
  pages.clear()
}

/** Case, whitespace, and typographic quotes and dashes do not count as differences between an excerpt and its page. */
export function normalizeForQuote(text: string): string {
  return text.toLowerCase().replace(/[‘’‛′]/g, "'").replace(/[“”‟″]/g, '"').replace(/[‐‑‒–—―]/g, '-').replace(/\s+/g, ' ').trim()
}

/**
 * Whether an excerpt is quoted from a page: the whole excerpt, or every fragment of it between ellipses, must
 * appear in the page text. Fragments shorter than a few words cannot establish anything and are ignored.
 */
export function excerptIsOnPage(excerpt: string, pageText: string): boolean {
  const page = normalizeForQuote(pageText)
  const whole = normalizeForQuote(excerpt).replace(/^["']|["']$/g, '')
  if (whole && page.includes(whole)) return true
  const fragments = whole.split(/\s*(?:\.\.\.|…|\[\.\.\.\])\s*/).map((fragment) => fragment.replace(/^["']|["']$/g, '').trim()).filter((fragment) => fragment.length >= 20)
  return fragments.length > 0 && fragments.every((fragment) => page.includes(fragment))
}
