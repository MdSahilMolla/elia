import { expect, test } from 'bun:test'
import { writeFixtureCorpus } from './fixture.ts'
import { searchCorpus } from './index.ts'
import { loadCorpus } from './store.ts'
import type { CyberCorpus, CyberHit, CyberSearchQuery } from './types.ts'

async function fixtureCorpus(): Promise<CyberCorpus> {
  const fixture = writeFixtureCorpus()
  return loadCorpus({ dir: fixture.dir, force: true })
}

test('BM25 ranks the record carrying the queried technique first', async () => {
  const corpus = await fixtureCorpus()
  const hits = searchCorpus(corpus, { query: 'ret2libc', limit: 20 })

  expect(hits.length).toBe(10)
  expect(hits.every((hit) => hit.chunk.record_id === 'r_pwn1')).toBe(true)
  expect(hits[0]!.chunk.record_id).toBe('r_pwn1')
  expect(hits[0]!.record?.id).toBe('r_pwn1')
})

test('chunk-type boosts lift exploitation above context at equal term match', async () => {
  const corpus = await fixtureCorpus()
  const hits = searchCorpus(corpus, { query: 'challenge', limit: 20 })

  expect(hits).toHaveLength(20)
  const types = hits.map((hit) => hit.chunk.chunk_type)
  // The 1.3 group leads, the 1.15 group sits above the unboosted context chunks.
  expect(['exploitation', 'vulnerability_discovery']).toContain(types[0]!)
  expect(['exploitation', 'vulnerability_discovery']).toContain(types[1]!)
  expect(types.indexOf('detection')).toBeLessThan(types.indexOf('context'))
  expect(types.indexOf('remediation')).toBeLessThan(types.indexOf('context'))
  expect(hits[0]!.chunk.record_id).toBe('r_pwn1')
})

test('an exact technique filter narrows to that record and keeps exploitation on top', async () => {
  const corpus = await fixtureCorpus()
  const hits = searchCorpus(corpus, { query: 'challenge', technique: 'ret2libc', limit: 20 })

  expect(hits).toHaveLength(10)
  expect(hits.every((hit) => hit.chunk.category === 'pwn')).toBe(true)
  expect(['exploitation', 'vulnerability_discovery']).toContain(hits[0]!.chunk.chunk_type)
})

test('filters narrow the candidate set independently of the query', async () => {
  const corpus = await fixtureCorpus()
  const browse = (q: Partial<CyberSearchQuery>): CyberHit[] => searchCorpus(corpus, { ...q, query: q.query ?? '', limit: 50 })

  const byCategory = browse({ category: 'WEB' })
  expect(byCategory).toHaveLength(10)
  expect(byCategory.every((hit) => hit.chunk.category === 'web')).toBe(true)

  expect(browse({ cwe: 'cwe-79' })).toHaveLength(10)
  expect(browse({ technique: 'ret2' })).toHaveLength(10)
  expect(browse({ artifactType: 'elf' })).toHaveLength(10)
  expect(browse({ vulnerability: 'buffer' })).toHaveLength(10)
  expect(browse({ vulnerability: 'Buffer Overflow' })).toHaveLength(10)
  expect(browse({ platform: 'linux' })).toHaveLength(20)
  expect(browse({ chunkType: 'exploitation' })).toHaveLength(2)
  expect(browse({ category: 'pwn', chunkType: 'remediation' })).toHaveLength(1)
  expect(browse({ cwe: 'CWE-999' })).toHaveLength(0)
  expect(browse({ category: 'web', artifactType: 'elf' })).toHaveLength(0)

  expect(searchCorpus(corpus, { query: 'ret2libc', category: 'web' })).toHaveLength(0)
})

test('an empty query browses the filtered chunks scored by quality only', async () => {
  const corpus = await fixtureCorpus()
  const hits = searchCorpus(corpus, { query: '', limit: 50 })

  expect(hits).toHaveLength(20)
  expect(hits.every((hit) => hit.score === 0.8)).toBe(true)

  const webOnly = searchCorpus(corpus, { query: '', category: 'web', limit: 50 })
  expect(webOnly).toHaveLength(10)
  expect(webOnly.every((hit) => hit.chunk.category === 'web')).toBe(true)
})

test('the default limit is 8 and fractional or broken limits round sanely', async () => {
  const corpus = await fixtureCorpus()

  expect(searchCorpus(corpus, { query: '' })).toHaveLength(8)
  expect(searchCorpus(corpus, { query: '', limit: 3 })).toHaveLength(3)
  expect(searchCorpus(corpus, { query: '', limit: 2.5 })).toHaveLength(3)
  expect(searchCorpus(corpus, { query: '', limit: -4 })).toHaveLength(1)
})

test('a query with no matching term returns nothing', async () => {
  const corpus = await fixtureCorpus()
  expect(searchCorpus(corpus, { query: 'zzz-no-such-token' })).toHaveLength(0)
})
