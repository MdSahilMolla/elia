import type { LedgerRecord } from './ledger.ts'

/**
 * A small local BM25 index over the episodic ledger — no embedding API, no
 * vector store, just enough real ranking to make `recall(query)` useful.
 * Deliberately not semantic search: it is a fast, dependency-free way to find
 * the archived episode that actually mentions what the model is asking about.
 */

const BM25_K1 = 1.5
const BM25_B = 0.75

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9_./-]+/g) ?? []
}

function recordText(record: LedgerRecord): string {
  return [record.summary, ...record.decisions, ...record.filesTouched, ...record.symbols, ...record.openThreads].join(' ')
}

export interface RecallHit {
  record: LedgerRecord
  score: number
}

/**
 * Ranks archived episodes against `query` with BM25, then applies a usage boost
 * from each episode's own recall history — the self-tuning half of the design.
 * `recallCount` (this episode kept matching real queries) and `confirmedUseCount`
 * (a tool call right after a recall actually touched one of its files, tracked in
 * ledger.ts) both push a proven-useful episode above an equally text-similar one
 * that never panned out, without needing any retraining.
 */
export function searchLedger(records: LedgerRecord[], query: string, limit = 5): RecallHit[] {
  const queryTerms = tokenize(query)
  if (queryTerms.length === 0 || records.length === 0) return []

  const docs = records.map((record) => tokenize(recordText(record)))
  const avgLen = docs.reduce((sum, doc) => sum + doc.length, 0) / docs.length || 1

  const uniqueQueryTerms = [...new Set(queryTerms)]
  const documentFrequency = new Map<string, number>()
  for (const term of uniqueQueryTerms) {
    documentFrequency.set(term, docs.filter((doc) => doc.includes(term)).length)
  }

  const hits: RecallHit[] = records.map((record, index) => {
    const doc = docs[index]!
    const termCounts = new Map<string, number>()
    for (const term of doc) termCounts.set(term, (termCounts.get(term) ?? 0) + 1)

    let score = 0
    for (const term of queryTerms) {
      const documentCount = documentFrequency.get(term) ?? 0
      const termFrequency = termCounts.get(term) ?? 0
      if (documentCount === 0 || termFrequency === 0) continue

      const idf = Math.log((records.length - documentCount + 0.5) / (documentCount + 0.5) + 1)
      const denominator = termFrequency + BM25_K1 * (1 - BM25_B + BM25_B * (doc.length / avgLen))
      score += idf * ((termFrequency * (BM25_K1 + 1)) / denominator)
    }

    const usageBoost = 1 + Math.log1p(record.recallCount) + 2 * Math.log1p(record.confirmedUseCount)
    return { record, score: score * usageBoost }
  })

  return hits
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}
