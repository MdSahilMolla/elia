import { expect, test } from 'bun:test'
import { buildCard, renderCards } from './cards.ts'
import type { BrainItem } from './store.ts'

function item(kind: BrainItem['kind'], key: string, render: string, paths: string[], at = 0): BrainItem {
  return { kind, key, text: render, render, at, paths, symbols: [] }
}

const items: BrainItem[] = [
  item('rationale', 'r1', 'why src/agentLoop.ts: serialize writes behind a lock — parallel edits corrupt the file', ['src/agentLoop.ts']),
  item('episode', 'e1', 'episode: touched the loop while adding cancellation', ['src/agentLoop.ts'], 1000),
  item('note', 'n1', 'note: the loop assumes at most one in-flight tool call', ['src/agentloop.ts'], 2000),
  item('lesson', 'l1', 'lesson: unrelated', ['src/other.ts']),
]

test('buildCard gathers everything about a path, rationale first', () => {
  const card = buildCard(items, 'src/agentLoop.ts')
  expect(card).toBeDefined()
  expect(card!.lines[0]).toContain('serialize writes behind a lock')
  expect(card!.lines).toHaveLength(3)
})

test('buildCard matches on basename, so case and directory differences still hit', () => {
  const card = buildCard(items, 'packages/core/src/AgentLoop.ts')
  expect(card?.lines.some((l) => l.includes('one in-flight tool call'))).toBe(true)
})

test('buildCard returns undefined for a path the brain knows nothing about', () => {
  expect(buildCard(items, 'src/nothing-here.ts')).toBeUndefined()
})

test('renderCards produces a prompt section for known paths and nothing for unknown', () => {
  expect(renderCards(items, ['src/unknown.ts'])).toBe('')
  const section = renderCards(items, ['src/agentLoop.ts'])
  expect(section).toContain('What elia already knows')
  expect(section).toContain('### src/agentLoop.ts')
})

test('renderCards de-dupes paths that share a basename', () => {
  const section = renderCards(items, ['src/agentLoop.ts', 'other/src/agentloop.ts'])
  expect(section.match(/### /g)).toHaveLength(1)
})
