import { afterAll, describe, expect, test } from 'bun:test'
import { searchCorpus } from './index.ts'
import { openCyberReference } from './open.ts'
import { loadCorpus, resetCorpusCache } from './store.ts'
import { validateCorpus } from './validate.ts'

/**
 * Retrieval against a REAL installed corpus, not the two-record fixture the
 * unit tests write. Gated on `ELIA_CYBERBRAIN_TEST_CORPUS` (a corpus
 * directory): when it is unset or empty every test below is skipped, so the
 * suite stays green on machines without the corpus installed. Read-only by
 * construction — no network, no writes — the corpus is only validated, loaded,
 * searched, and rendered. Heavy parses get generous timeouts because a real
 * corpus is tens of megabytes of JSONL.
 */

const corpusDir = (process.env.ELIA_CYBERBRAIN_TEST_CORPUS ?? '').trim()
const enabled = corpusDir.length > 0

describe.skipIf(!enabled)('CyberBrain retrieval against a real installed corpus', () => {
  afterAll(() => {
    resetCorpusCache()
  })

  test('validateCorpus reports an ok receipt with records and chunks', async () => {
    const receipt = await validateCorpus(corpusDir)
    expect(receipt.checks.filter((check) => !check.ok).map((check) => `${check.name}: ${check.detail}`)).toEqual([])
    expect(receipt.ok).toBe(true)
    expect(receipt.recordCount).toBeGreaterThan(0)
    expect(receipt.chunkCount).toBeGreaterThan(0)
  }, 60_000)

  test('loadCorpus parses the installed records and chunks', async () => {
    resetCorpusCache()
    const corpus = await loadCorpus({ dir: corpusDir })
    expect(corpus.records.length).toBeGreaterThan(0)
    expect(corpus.chunks.length).toBeGreaterThan(0)
    expect(corpus.recordById.size).toBeGreaterThan(0)
    expect(corpus.chunksByRecord.size).toBeGreaterThan(0)
  }, 60_000)

  test('searchCorpus returns at least one hit for a common term', async () => {
    resetCorpusCache()
    const corpus = await loadCorpus({ dir: corpusDir })
    const hits = searchCorpus(corpus, { query: 'the' })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.chunk.record_id.length).toBeGreaterThan(0)
  }, 60_000)

  test('openCyberReference renders the record behind the top hit', async () => {
    resetCorpusCache()
    const corpus = await loadCorpus({ dir: corpusDir })
    const hits = searchCorpus(corpus, { query: 'the' })
    expect(hits.length).toBeGreaterThan(0)
    const recordId = hits[0]!.chunk.record_id
    const rendered = openCyberReference(corpus, `record:${recordId}`)
    expect(rendered).toContain(recordId)
  }, 60_000)

  test('reloading the same dir reuses the cache with consistent counts', async () => {
    resetCorpusCache()
    const first = await loadCorpus({ dir: corpusDir })
    const cached = await loadCorpus({ dir: corpusDir })
    expect(cached).toBe(first)
    expect(cached.records.length).toBe(first.records.length)
    expect(cached.chunks.length).toBe(first.chunks.length)

    const forced = await loadCorpus({ dir: corpusDir, force: true })
    expect(forced).not.toBe(first)
    expect(forced.records.length).toBe(first.records.length)
    expect(forced.chunks.length).toBe(first.chunks.length)
    expect(forced.records.length).toBeGreaterThan(0)
    expect(forced.chunks.length).toBeGreaterThan(0)
  }, 60_000)
})
