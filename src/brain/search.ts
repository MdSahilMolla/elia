import { basename } from 'node:path'
import { rankBm25 } from '../bm25.ts'
import { relevanceBoost, type RelevanceCount } from './relevance.ts'
import type { BrainItem } from './store.ts'

/**
 * Ranks the merged brain against a query: BM25 for text relevance, then three
 * multiplicative boosts — proven usefulness (project-global recall signal), a
 * hit on a file the turn is already working in, and gentle recency so a fresh
 * fact edges out a stale one of equal match.
 */

const RECENCY_HALF_LIFE_DAYS = 90

export interface BrainHit {
  item: BrainItem
  score: number
}

export interface SearchBrainOptions {
  limit?: number
  /** Files the current turn is touching — items anchored to them rank higher. */
  activePaths?: string[]
  /** Project-global relevance counts, from relevance.ts. */
  relevance?: Map<string, RelevanceCount>
  /** Restrict to certain kinds. */
  kinds?: BrainItem['kind'][]
  now?: number
}

function recencyBoost(at: number, now: number): number {
  if (!at) return 1
  const ageDays = Math.max(0, (now - at) / 86_400_000)
  return 1 + 0.5 * Math.exp(-ageDays / RECENCY_HALF_LIFE_DAYS)
}

function pathBoost(item: BrainItem, activePaths: string[]): number {
  if (activePaths.length === 0 || item.paths.length === 0) return 1
  const activeBases = new Set(activePaths.map((p) => basename(p).toLowerCase()))
  const hit = item.paths.some((p) => activePaths.includes(p) || activeBases.has(basename(p).toLowerCase()))
  return hit ? 2.5 : 1
}

export function searchBrain(items: BrainItem[], query: string, options: SearchBrainOptions = {}): BrainHit[] {
  const limit = options.limit && options.limit > 0 ? Math.floor(options.limit) : 6
  const now = options.now ?? Date.now()
  const activePaths = options.activePaths ?? []
  const relevance = options.relevance

  const pool = options.kinds ? items.filter((item) => options.kinds!.includes(item.kind)) : items
  if (pool.length === 0) return []

  const byKey = new Map(pool.map((item) => [item.key, item]))
  const ranked = rankBm25(pool.map((item) => ({ id: item.key, text: item.text })), query)

  return ranked
    .map(({ id, score }) => {
      const item = byKey.get(id)!
      const boosted = score
        * (relevance ? relevanceBoost(relevance, item.key) : 1)
        * pathBoost(item, activePaths)
        * recencyBoost(item.at, now)
      return { item, score: boosted }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}
