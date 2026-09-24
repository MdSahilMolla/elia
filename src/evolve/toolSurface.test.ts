import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { removedTools } from './toolSurface.ts'

process.env.ANTHROPIC_API_KEY ??= 'test-key-for-tool-surface-test'

test('a tool the candidate no longer gives its agent is a removal; a new one is not', () => {
  expect(removedTools(['read_file', 'github', 'browser'], ['read_file', 'grep'])).toEqual(['browser', 'github'])
  expect(removedTools(['read_file'], ['read_file', 'load_tools'])).toEqual([])
  expect(removedTools(['read_file', 'read_file'], ['read_file'])).toEqual([])
})

test('run from a tree, it reports that tree\'s own registry', async () => {
  const { toolNamesIn } = await import('./measureTree.ts')
  const names = await toolNamesIn(join(import.meta.dir, '..', '..'))
  expect(names).toContain('read_file')
  expect(names).toContain('github')
  expect(new Set(names).size).toBe(names!.length)
}, 60_000)

test('a tree whose registry cannot be read gives no list, which the engine treats as a rejection', async () => {
  const { toolNamesIn } = await import('./measureTree.ts')
  expect(await toolNamesIn('/nowhere/at/all')).toBeUndefined()
})
