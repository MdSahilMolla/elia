/**
 * Ranking CyberBrain chunks: one inverted index per corpus, Okapi BM25 on top.
 *
 * `rankBm25` re-tokenizes every document on every call — fine for the small
 * brain stores, wasteful over a corpus of thousands of chunks hit by every
 * retrieval turn. Here tokenization happens once per corpus object (cached in
 * a WeakMap, so a reloaded corpus rebuilds and the old one is collectable) and
 * each query only walks the postings of its own terms. The scoring formula is
 * deliberately identical to `rankBm25` (k1 1.5, b 0.75, same idf) so the two
 * rankers agree; only the df lookup moves from a per-query scan to the
 * postings map. Scores then get multiplicative boosts for chunk kind, record
 * quality, and exact taxonomy matches, because a hit that *is* the technique
 * asked for should outrank a chunk that merely mentions the query words.
 */

import { tokenize } from '../bm25.ts'
import type { CyberChunk, CyberCorpus, CyberHit, CyberSearchQuery } from './types.ts'

const K1 = 1.5
const B = 0.75

interface Posting {
  /** Index into `corpus.chunks`; postings for a term are appended in doc order, so they are sorted. */
  doc: number
  tf: number
}

interface ChunkIndex {
  postings: Map<string, Posting[]>
  docLengths: number[]
  avgLength: number
}

const indexes = new WeakMap<CyberCorpus, ChunkIndex>()

function indexFor(corpus: CyberCorpus): ChunkIndex {
  const existing = indexes.get(corpus)
  if (existing) return existing

  const postings = new Map<string, Posting[]>()
  const docLengths: number[] = []
  corpus.chunks.forEach((chunk, doc) => {
    const terms = tokenize(chunk.text)
    docLengths.push(terms.length)

    const tfByTerm = new Map<string, number>()
    for (const term of terms) tfByTerm.set(term, (tfByTerm.get(term) ?? 0) + 1)
    for (const [term, tf] of tfByTerm) {
      const list = postings.get(term)
      if (list) list.push({ doc, tf })
      else postings.set(term, [{ doc, tf }])
    }
  })

  const totalLength = docLengths.reduce((sum, length) => sum + length, 0)
  const index: ChunkIndex = { postings, docLengths, avgLength: totalLength / docLengths.length || 1 }
  indexes.set(corpus, index)
  return index
}

function postingFor(list: Posting[], doc: number): Posting | undefined {
  let low = 0
  let high = list.length - 1
  while (low <= high) {
    const mid = (low + high) >> 1
    const posting = list[mid]!
    if (posting.doc === doc) return posting
    if (posting.doc < doc) low = mid + 1
    else high = mid - 1
  }
  return undefined
}

const lc = (value: string | undefined): string => (value ?? '').toLowerCase()

/**
 * Enum-like fields (category, CWE, platform, chunk type, artifact type) match
 * case-insensitively and exactly; free text (vulnerability, technique) matches
 * as a substring, so "overflow" finds "Buffer Overflow" and "xss" finds
 * "Stored XSS".
 */
function matchesFilters(chunk: CyberChunk, q: CyberSearchQuery): boolean {
  if (q.category && lc(chunk.category) !== lc(q.category)) return false
  if (q.cwe && lc(chunk.cwe) !== lc(q.cwe)) return false
  if (q.platform && lc(chunk.platform) !== lc(q.platform)) return false
  if (q.chunkType && lc(chunk.chunk_type) !== lc(q.chunkType)) return false
  if (q.artifactType && !chunk.artifact_types.some((type) => lc(type) === lc(q.artifactType))) return false
  if (q.vulnerability && !lc(chunk.vulnerability).includes(lc(q.vulnerability))) return false
  if (q.technique && !chunk.techniques.some((technique) => lc(technique).includes(lc(q.technique)))) return false
  return true
}

function qualityOf(chunk: CyberChunk): number {
  return typeof chunk.quality_score === 'number' ? chunk.quality_score / 100 : 0.8
}

function boostFor(chunk: CyberChunk, q: CyberSearchQuery): number {
  const type =
    chunk.chunk_type === 'exploitation' || chunk.chunk_type === 'vulnerability_discovery'
      ? 1.3
      : chunk.chunk_type === 'remediation' || chunk.chunk_type === 'verification' || chunk.chunk_type === 'detection'
        ? 1.15
        : 1

  let boost = type * qualityOf(chunk)
  if (q.technique && chunk.techniques.some((technique) => lc(technique) === lc(q.technique))) boost *= 1.5
  if (q.vulnerability && lc(chunk.vulnerability) === lc(q.vulnerability)) boost *= 1.4
  if (q.cwe && lc(chunk.cwe) === lc(q.cwe)) boost *= 1.3
  return boost
}

export function searchCorpus(corpus: CyberCorpus, q: CyberSearchQuery): CyberHit[] {
  const index = indexFor(corpus)
  const queryTerms = tokenize(q.query)
  const docCount = corpus.chunks.length
  const hits: CyberHit[] = []

  for (const [doc, chunk] of corpus.chunks.entries()) {
    if (!matchesFilters(chunk, q)) continue

    // Browse mode: no term scoring, quality alone decides the order.
    if (queryTerms.length === 0) {
      hits.push({ chunk, record: corpus.recordById.get(chunk.record_id), score: qualityOf(chunk) })
      continue
    }

    const docLength = index.docLengths[doc]!
    let score = 0
    for (const term of queryTerms) {
      const postings = index.postings.get(term)
      if (!postings) continue
      const posting = postingFor(postings, doc)
      if (!posting) continue

      const idf = Math.log((docCount - postings.length + 0.5) / (postings.length + 0.5) + 1)
      const denominator = posting.tf + K1 * (1 - B + B * (docLength / index.avgLength))
      score += (idf * (posting.tf * (K1 + 1))) / denominator
    }
    if (score <= 0) continue

    hits.push({ chunk, record: corpus.recordById.get(chunk.record_id), score: score * boostFor(chunk, q) })
  }

  hits.sort((a, b) => b.score - a.score)

  // Default 8; a fractional limit rounds up and a broken one still returns a page.
  const requested = q.limit ?? 8
  const limit = Number.isFinite(requested) ? Math.max(1, Math.ceil(requested)) : 8
  return hits.slice(0, limit)
}
