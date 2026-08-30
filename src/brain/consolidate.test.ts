import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ContentBlock } from '../providers/types.ts'

process.env.ANTHROPIC_API_KEY ??= 'test-key-for-consolidate-test'

const { config } = await import('../config.ts')
const { consolidateBrain } = await import('./consolidate.ts')
const { loadLessons } = await import('../autonomy/lessons.ts')
const { loadNotes, appendNote } = await import('./notes.ts')

let dir: string
let lessonsPath: string
let notesPath: string
let consolidatedAtPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'elia-consolidate-'))
  lessonsPath = join(dir, 'lessons.md')
  notesPath = join(dir, 'notes.jsonl')
  consolidatedAtPath = join(dir, 'consolidated-at')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function stubFast(response: string): void {
  config.tiers.fast.provider = {
    async streamTurn({ onText }) {
      onText(response)
      return { content: [{ type: 'text', text: response }] as ContentBlock[], usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }
    },
  }
}

function seedLessons(lines: string[]): void {
  writeFileSync(lessonsPath, `# Lessons\n\n${lines.map((l) => `- ${l} <!-- 2026-01-01T00:00:00Z -->`).join('\n')}\n`)
}

const opts = () => ({ lessonsPath, notesPath, consolidatedAtPath })

test('skips when there is not enough to consolidate and no force', async () => {
  seedLessons(['run tests with bun'])
  const result = await consolidateBrain(opts())
  expect(result.changed).toBe(false)
  expect(result.reason).toContain('nothing to consolidate')
})

test('force merges duplicate lessons and rewrites the file', async () => {
  seedLessons([
    'run the tests with bun, not node',
    'the test runner is bun — node cannot resolve the .ts imports',
    'the http client lives in src/http.ts',
  ])
  stubFast(JSON.stringify({
    lessons: ['Run tests with bun, not node — node cannot resolve the .ts imports', 'The http client lives in src/http.ts'],
    removeNotes: [],
  }))

  const result = await consolidateBrain({ ...opts(), force: true })
  expect(result.changed).toBe(true)
  expect(result.lessonsBefore).toBe(3)
  expect(result.lessonsAfter).toBe(2)
  expect(loadLessons(lessonsPath).map((l) => l.text)).toEqual([
    'Run tests with bun, not node — node cannot resolve the .ts imports',
    'The http client lives in src/http.ts',
  ])
  expect(existsSync(consolidatedAtPath)).toBe(true)
})

test('refuses a rewrite that would delete most of the list', async () => {
  seedLessons(['lesson a', 'lesson b', 'lesson c', 'lesson d', 'lesson e'])
  stubFast(JSON.stringify({ lessons: ['just one'], removeNotes: [] }))

  const result = await consolidateBrain({ ...opts(), force: true })
  expect(result.changed).toBe(false)
  expect(result.reason).toContain('too much')
  expect(loadLessons(lessonsPath)).toHaveLength(5)
})

test('drops notes the model marks redundant, keeping the rest verbatim', async () => {
  seedLessons(['keep me'])
  appendNote({ text: 'the api rate-limits at 20 rps' }, notesPath)
  appendNote({ text: 'redundant with a lesson' }, notesPath)
  stubFast(JSON.stringify({ lessons: ['keep me'], removeNotes: ['redundant with a lesson'] }))

  const result = await consolidateBrain({ ...opts(), force: true })
  expect(result.notesRemoved).toBe(1)
  expect(loadNotes(notesPath).map((n) => n.text)).toEqual(['the api rate-limits at 20 rps'])
})

test('a non-JSON response changes nothing', async () => {
  seedLessons(['a', 'b', 'c'])
  stubFast('sorry, I could not do that')
  const result = await consolidateBrain({ ...opts(), force: true })
  expect(result.changed).toBe(false)
  expect(loadLessons(lessonsPath)).toHaveLength(3)
})

test('a provider failure is swallowed and changes nothing', async () => {
  seedLessons(['a', 'b', 'c'])
  config.tiers.fast.provider = { async streamTurn() { throw new Error('offline') } }
  const result = await consolidateBrain({ ...opts(), force: true })
  expect(result.changed).toBe(false)
  expect(readFileSync(lessonsPath, 'utf8')).toContain('- a ')
})
