/**
 * A tiny, dependency-free BM25 ranker.
 *
 * elia's memory retrieval (episodic recall, and the cross-session brain) is
 * deliberately not semantic search: no embedding API, no vector store, just
 * enough real ranking to surface the stored item that actually mentions what
 * the model asked about. This module is the shared core — `recall.ts` ranks the
 * episodic ledger with it, `brain/search.ts` ranks every knowledge source with
 * it — so the two behave identically and there is one place to tune.
 */

const DEFAULT_K1 = 1.5
const DEFAULT_B = 0.75

/** Splits text into lowercased terms, keeping path- and symbol-shaped tokens whole. */
export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9_./-]+/g) ?? []
}

export interface Bm25Doc {
  id: string
  text: string
}

export interface Bm25Hit {
  id: string
  score: number
}

export interface Bm25Options {
  k1?: number
  b?: number
}

/**
 * Scores every document against `query` with Okapi BM25 and returns the ones
 * with a non-zero score, most relevant first. No limit is applied — callers
 * layer their own boosts (recency, proven-usefulness) on top and slice
 * afterwards.
 */
export function rankBm25(docs: Bm25Doc[], query: string, options: Bm25Options = {}): Bm25Hit[] {
  const k1 = options.k1 ?? DEFAULT_K1
  const b = options.b ?? DEFAULT_B

  const queryTerms = tokenize(query)
  if (queryTerms.length === 0 || docs.length === 0) return []

  const tokenized = docs.map((doc) => tokenize(doc.text))
  const avgLen = tokenized.reduce((sum, terms) => sum + terms.length, 0) / tokenized.length || 1

  const uniqueQueryTerms = [...new Set(queryTerms)]
  const documentFrequency = new Map<string, number>()
  for (const term of uniqueQueryTerms) {
    documentFrequency.set(term, tokenized.filter((terms) => terms.includes(term)).length)
  }

  const hits: Bm25Hit[] = docs.map((doc, index) => {
    const terms = tokenized[index]!
    const termCounts = new Map<string, number>()
    for (const term of terms) termCounts.set(term, (termCounts.get(term) ?? 0) + 1)

    let score = 0
    for (const term of queryTerms) {
      const df = documentFrequency.get(term) ?? 0
      const tf = termCounts.get(term) ?? 0
      if (df === 0 || tf === 0) continue

      const idf = Math.log((docs.length - df + 0.5) / (df + 0.5) + 1)
      const denominator = tf + k1 * (1 - b + b * (terms.length / avgLen))
      score += idf * ((tf * (k1 + 1)) / denominator)
    }

    return { id: doc.id, score }
  })

  return hits.filter((hit) => hit.score > 0).sort((a, b) => b.score - a.score)
}
