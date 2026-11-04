import { expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cacheRegistrySizes } from '../cacheRegistry.ts'
import { writeFixtureCorpus } from './fixture.ts'
import { loadCorpus, resetCorpusCache } from './store.ts'

test('loadCorpus parses records and chunks and builds the joins', async () => {
  const fixture = writeFixtureCorpus()
  resetCorpusCache()
  const corpus = await loadCorpus({ dir: fixture.dir })

  expect(corpus.dir).toBe(fixture.dir)
  expect(corpus.records.length).toBe(2)
  expect(corpus.chunks.length).toBe(20)
  expect(corpus.recordById.get('r_pwn1')?.title).toContain('ret2libc')
  expect(corpus.chunksByRecord.get('r_pwn1')?.length).toBe(10)
  expect(corpus.chunksByRecord.get('r_web1')?.length).toBe(10)
  expect(corpus.categoryCounts.get('pwn')).toBe(1)
  expect(corpus.categoryCounts.get('web')).toBe(1)
  expect(corpus.manifest?.record_count).toBe(2)
  expect(corpus.manifest?.chunk_count).toBe(20)
})

test('a corpus that was never installed loads empty instead of throwing', async () => {
  resetCorpusCache()
  const corpus = await loadCorpus({ dir: join(tmpdir(), 'elia-cyberbrain-not-installed') })

  expect(corpus.records).toEqual([])
  expect(corpus.chunks).toEqual([])
  expect(corpus.recordById.size).toBe(0)
  expect(corpus.chunksByRecord.size).toBe(0)
  expect(corpus.categoryCounts.size).toBe(0)
  expect(corpus.manifest).toBeNull()
})

test('the cache survives repeated loads and force / reset both bypass it', async () => {
  const fixture = writeFixtureCorpus()
  resetCorpusCache()

  const first = await loadCorpus({ dir: fixture.dir })
  expect(await loadCorpus({ dir: fixture.dir })).toBe(first)

  const forced = await loadCorpus({ dir: fixture.dir, force: true })
  expect(forced).not.toBe(first)
  expect(forced.records.length).toBe(2)

  resetCorpusCache()
  expect(await loadCorpus({ dir: fixture.dir })).not.toBe(first)
})

test('the cache registers with the cacheRegistry and reports its record count', async () => {
  const fixture = writeFixtureCorpus()
  resetCorpusCache()
  await loadCorpus({ dir: fixture.dir })
  expect(cacheRegistrySizes().cyberbrain).toBe(2)
})
