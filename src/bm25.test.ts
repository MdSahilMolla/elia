import { expect, test } from 'bun:test'
import { rankBm25, tokenize } from './bm25.ts'

test('tokenize keeps paths and symbols whole', () => {
  expect(tokenize('edit src/foo/bar.ts and TAX_RATE now')).toEqual(['edit', 'src/foo/bar.ts', 'and', 'tax_rate', 'now'])
})

test('rankBm25 returns nothing for an empty corpus or an empty query', () => {
  expect(rankBm25([], 'anything')).toEqual([])
  expect(rankBm25([{ id: 'a', text: 'hello world' }], '   ')).toEqual([])
})

test('rankBm25 ranks the document that mentions the query terms first', () => {
  const docs = [
    { id: 'a', text: 'refactored the payment retry logic to use exponential backoff' },
    { id: 'b', text: 'wrote docs for the onboarding flow' },
    { id: 'c', text: 'fixed a flaky test in the payment webhook handler' },
  ]
  const hits = rankBm25(docs, 'payment retry backoff')
  expect(hits[0]!.id).toBe('a')
  expect(hits.map((h) => h.id)).not.toContain('b')
})

test('rankBm25 does not limit — it returns every scoring document', () => {
  const docs = Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, text: 'shared keyword banana' }))
  expect(rankBm25(docs, 'banana').length).toBe(10)
})

test('rankBm25 gives a rarer term more weight', () => {
  const docs = [
    { id: 'common', text: 'the the the the config' },
    { id: 'rare', text: 'config threadpool' },
  ]
  const hits = rankBm25(docs, 'config threadpool')
  expect(hits[0]!.id).toBe('rare')
})
