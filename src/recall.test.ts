import { expect, test } from 'bun:test'
import { searchLedger } from './recall.ts'
import type { LedgerRecord } from './ledger.ts'

function record(overrides: Partial<LedgerRecord>): LedgerRecord {
  return {
    id: overrides.id ?? Math.random().toString(36),
    turn: 0,
    at: Date.now(),
    messageCount: 1,
    summary: '',
    decisions: [],
    filesTouched: [],
    symbols: [],
    openThreads: [],
    recallCount: 0,
    confirmedUseCount: 0,
    ...overrides,
  }
}

test('searchLedger returns nothing for an empty ledger or an empty query', () => {
  expect(searchLedger([], 'anything')).toEqual([])
  expect(searchLedger([record({ summary: 'x' })], '   ')).toEqual([])
})

test('searchLedger ranks the episode that actually mentions the query terms first', () => {
  const records = [
    record({ id: 'a', summary: 'refactored the payment retry logic to use exponential backoff' }),
    record({ id: 'b', summary: 'wrote docs for the onboarding flow' }),
    record({ id: 'c', summary: 'fixed a flaky test in the payment webhook handler' }),
  ]

  const hits = searchLedger(records, 'payment retry backoff')

  expect(hits.length).toBeGreaterThan(0)
  expect(hits[0]!.record.id).toBe('a')
  expect(hits.map((h) => h.record.id)).not.toContain('b')
})

test('searchLedger matches on files and symbols, not just prose', () => {
  const records = [
    record({ id: 'a', summary: 'unrelated work', filesTouched: ['src/tax.ts'], symbols: ['TAX_RATE'] }),
    record({ id: 'b', summary: 'other unrelated work' }),
  ]

  const hits = searchLedger(records, 'TAX_RATE')
  expect(hits[0]?.record.id).toBe('a')
})

test('searchLedger respects the limit', () => {
  const records = Array.from({ length: 10 }, (_, i) => record({ id: `r${i}`, summary: 'shared keyword banana' }))
  const hits = searchLedger(records, 'banana', 3)
  expect(hits.length).toBe(3)
})

test('a higher recallCount/confirmedUseCount boosts an otherwise equally-matching episode above another', () => {
  const records = [
    record({ id: 'plain', summary: 'the widget renderer was rewritten for speed' }),
    record({ id: 'proven', summary: 'the widget renderer was rewritten for speed', recallCount: 5, confirmedUseCount: 3 }),
  ]

  const hits = searchLedger(records, 'widget renderer speed')
  expect(hits[0]?.record.id).toBe('proven')
})

test('a query with no matching terms at all returns no hits', () => {
  const records = [record({ id: 'a', summary: 'apples and oranges' })]
  expect(searchLedger(records, 'zzz_nonexistent_term')).toEqual([])
})
