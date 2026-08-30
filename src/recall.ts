import type { LedgerRecord } from './ledger.ts'
import { rankBm25 } from './bm25.ts'

/**
 * BM25 ranking over the episodic ledger, layered with a self-tuning usage
 * boost. The ranking core lives in `bm25.ts` (shared with the cross-session
 * brain); this module adds the ledger-specific document shape and the
 * proven-usefulness signal.
 */

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
  if (records.length === 0) return []

  const byId = new Map(records.map((record) => [record.id, record]))
  const ranked = rankBm25(records.map((record) => ({ id: record.id, text: recordText(record) })), query)

  return ranked
    .map(({ id, score }) => {
      const record = byId.get(id)!
      const usageBoost = 1 + Math.log1p(record.recallCount) + 2 * Math.log1p(record.confirmedUseCount)
      return { record, score: score * usageBoost }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}
