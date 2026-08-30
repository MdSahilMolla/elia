import { expect, test } from 'bun:test'
import { searchBrain } from './search.ts'
import type { BrainItem } from './store.ts'

function item(overrides: Partial<BrainItem> & Pick<BrainItem, 'key' | 'text'>): BrainItem {
  return {
    kind: 'note',
    render: overrides.text,
    at: 0,
    paths: [],
    symbols: [],
    ...overrides,
  }
}

test('searchBrain ranks the item that matches the query first', () => {
  const items = [
    item({ key: 'a', text: 'the migration runner locks the schema table before applying' }),
    item({ key: 'b', text: 'the theme toggle persists to localStorage' }),
  ]
  const hits = searchBrain(items, 'schema migration lock')
  expect(hits[0]!.item.key).toBe('a')
})

test('a project-global relevance boost lifts a proven item above an equal match', () => {
  const items = [
    item({ key: 'plain', text: 'the widget renderer was rewritten for speed' }),
    item({ key: 'proven', text: 'the widget renderer was rewritten for speed' }),
  ]
  const relevance = new Map([['proven', { recalled: 4, confirmed: 2 }]])
  const hits = searchBrain(items, 'widget renderer speed', { relevance })
  expect(hits[0]!.item.key).toBe('proven')
})

test('an item anchored to a file the turn is touching gets a path boost', () => {
  const items = [
    item({ key: 'anchored', text: 'validation happens at the boundary', paths: ['src/api/users.ts'] }),
    item({ key: 'loose', text: 'validation happens at the boundary always everywhere' }),
  ]
  const hits = searchBrain(items, 'validation boundary', { activePaths: ['src/api/users.ts'] })
  expect(hits[0]!.item.key).toBe('anchored')
})

test('kinds filter restricts the pool', () => {
  const items = [
    item({ key: 'l1', kind: 'lesson', text: 'shared keyword alpha' }),
    item({ key: 'n1', kind: 'note', text: 'shared keyword alpha' }),
  ]
  const hits = searchBrain(items, 'alpha', { kinds: ['lesson'] })
  expect(hits.map((h) => h.item.key)).toEqual(['l1'])
})

test('recency gently breaks ties toward the newer item', () => {
  const now = Date.now()
  const items = [
    item({ key: 'old', text: 'the cache is invalidated on write', at: now - 200 * 86_400_000 }),
    item({ key: 'new', text: 'the cache is invalidated on write', at: now - 1 * 86_400_000 }),
  ]
  const hits = searchBrain(items, 'cache invalidated write', { now })
  expect(hits[0]!.item.key).toBe('new')
})

test('searchBrain respects the limit', () => {
  const items = Array.from({ length: 12 }, (_, i) => item({ key: `k${i}`, text: 'common banana term' }))
  expect(searchBrain(items, 'banana', { limit: 4 })).toHaveLength(4)
})
