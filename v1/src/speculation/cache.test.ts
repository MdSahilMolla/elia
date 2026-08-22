import { expect, test } from 'bun:test'
import { createToolResultCache } from './cache.ts'

test('a speculated result is returned instantly and counted as a hit', async () => {
  const cache = createToolResultCache()
  cache.speculate('read_file', { path: 'a.ts' }, async () => 'contents of a')

  const hit = cache.take('read_file', { path: 'a.ts' })
  expect(hit).toBeDefined()
  expect(await hit!).toBe('contents of a')
  expect(cache.stats()).toEqual({ speculated: 1, hits: 1, misses: 0 })
})

test('a call that was never speculated is a miss', () => {
  const cache = createToolResultCache()

  expect(cache.take('read_file', { path: 'nope.ts' })).toBeUndefined()
  expect(cache.stats().misses).toBe(1)
  expect(cache.hitRate()).toBe(0)
})

test('key order does not matter, so argument order cannot cause a false miss', async () => {
  const cache = createToolResultCache()
  cache.speculate('grep', { pattern: 'x', path: 'src' }, async () => 'found')

  const hit = cache.take('grep', { path: 'src', pattern: 'x' })
  expect(await hit!).toBe('found')
})

test('different arguments are different entries', async () => {
  const cache = createToolResultCache()
  cache.speculate('read_file', { path: 'a.ts' }, async () => 'a')
  cache.speculate('read_file', { path: 'b.ts' }, async () => 'b')

  expect(await cache.take('read_file', { path: 'b.ts' })!).toBe('b')
  expect(await cache.take('read_file', { path: 'a.ts' })!).toBe('a')
})

test('the same speculation twice only runs the work once', async () => {
  const cache = createToolResultCache()
  let runs = 0
  const run = async () => {
    runs += 1
    return 'once'
  }

  cache.speculate('read_file', { path: 'a.ts' }, run)
  cache.speculate('read_file', { path: 'a.ts' }, run)

  expect(await cache.take('read_file', { path: 'a.ts' })!).toBe('once')
  expect(runs).toBe(1)
  expect(cache.stats().speculated).toBe(1)
})

test('a result is consumed, so a second identical call re-runs against fresh state', async () => {
  const cache = createToolResultCache()
  cache.speculate('read_file', { path: 'a.ts' }, async () => 'a')

  await cache.take('read_file', { path: 'a.ts' })
  expect(cache.take('read_file', { path: 'a.ts' })).toBeUndefined()
})

test('tools with side effects are never speculated or served from cache', async () => {
  const cache = createToolResultCache()
  cache.speculate('run_command', { command: 'rm -rf /' }, async () => 'should never run')
  cache.speculate('write_file', { path: 'a', content: 'b' }, async () => 'nope')

  expect(cache.stats().speculated).toBe(0)
  expect(cache.canSpeculate('run_command')).toBe(false)
  expect(cache.canSpeculate('write_file')).toBe(false)
  expect(cache.canSpeculate('read_file')).toBe(true)
  // A non-speculable name must not even register a miss — it never consults the cache.
  expect(cache.take('run_command', { command: 'ls' })).toBeUndefined()
  expect(cache.stats().misses).toBe(0)
})

test('invalidate drops everything, so a post-write read cannot get a stale snapshot', async () => {
  const cache = createToolResultCache()
  cache.speculate('read_file', { path: 'a.ts' }, async () => 'before the write')

  cache.invalidate()

  expect(cache.take('read_file', { path: 'a.ts' })).toBeUndefined()
})

test('a failed speculation surfaces as a rejection rather than a bad cached value', async () => {
  const cache = createToolResultCache()
  cache.speculate('read_file', { path: 'gone.ts' }, async () => {
    throw new Error('File not found: gone.ts')
  })

  const hit = cache.take('read_file', { path: 'gone.ts' })
  expect(hit).toBeDefined()
  await expect(hit!).rejects.toThrow('File not found')
})

test('hit rate reflects hits over real attempts', async () => {
  const cache = createToolResultCache()
  cache.speculate('read_file', { path: 'a.ts' }, async () => 'a')

  await cache.take('read_file', { path: 'a.ts' })
  cache.take('read_file', { path: 'b.ts' })

  expect(cache.hitRate()).toBe(0.5)
})
