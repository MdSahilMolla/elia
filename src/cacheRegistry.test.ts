import { afterEach, expect, test } from 'bun:test'
import { boundedMap, cacheRegistrySizes, clearAllCaches, registerCache, resetCacheRegistryForTests } from './cacheRegistry.ts'

afterEach(() => resetCacheRegistryForTests())

test('boundedMap evicts oldest-first once past the cap and reports the eviction', () => {
  const evicted: number[] = []
  const map = boundedMap<string, number>(3, (value) => evicted.push(value))

  map.set('a', 1)
  map.set('b', 2)
  map.set('c', 3)
  map.set('d', 4)

  expect(map.size).toBe(3)
  expect([...map.keys()]).toEqual(['b', 'c', 'd'])
  expect(evicted).toEqual([1])
})

test('re-setting an existing key refreshes its position instead of double-counting', () => {
  const map = boundedMap<string, number>(2)
  map.set('a', 1)
  map.set('b', 2)
  map.set('a', 11) // 'a' moves to the back; nothing evicted yet
  map.set('c', 3) // now 'b' is oldest

  expect(map.size).toBe(2)
  expect([...map.keys()]).toEqual(['a', 'c'])
  expect(map.get('a')).toBe(11)
})

test('boundedMap rejects a non-positive cap', () => {
  expect(() => boundedMap(0)).toThrow('positive integer')
  expect(() => boundedMap(-1)).toThrow('positive integer')
})

test('clearAllCaches clears every registered cache and survives one that throws', () => {
  const a = new Map([['x', 1]])
  const b = new Map([['y', 2]])
  registerCache('a', () => a.clear(), () => a.size)
  registerCache('boom', () => { throw new Error('nope') }, () => 0)
  registerCache('b', () => b.clear(), () => b.size)

  clearAllCaches()

  expect(a.size).toBe(0)
  expect(b.size).toBe(0)
})

test('registerCache is idempotent by name and cacheRegistrySizes reflects live sizes', () => {
  const m = new Map<string, number>()
  registerCache('m', () => m.clear(), () => m.size)
  registerCache('m', () => m.clear(), () => m.size) // replace, not duplicate

  m.set('a', 1)
  m.set('b', 2)
  expect(cacheRegistrySizes()).toEqual({ m: 2 })
})
