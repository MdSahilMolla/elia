import { expect, test } from 'bun:test'
import { commandShape, skillCandidates, type UsageStats } from './detector.ts'

test('a command reduces to program plus subcommand, dropping flags and arguments', () => {
  expect(commandShape('git diff --stat HEAD~1')).toBe('git diff')
  expect(commandShape('git diff --cached')).toBe('git diff')
  expect(commandShape('bun test src/foo.test.ts')).toBe('bun test')
})

test('different subcommands of the same program are different habits', () => {
  expect(commandShape('git log --oneline')).not.toBe(commandShape('git push origin main'))
})

test('leading flags are not mistaken for the subcommand', () => {
  expect(commandShape('npm --silent run build')).toBe('npm run')
})

test('a program with no subcommand shapes to just the program', () => {
  expect(commandShape('ls -la')).toBe('ls')
})

test('a windows executable suffix is normalized away', () => {
  expect(commandShape('tsc.exe --noEmit')).toBe('tsc')
})

test('an empty command has no shape', () => {
  expect(commandShape('   ')).toBeUndefined()
})

function stats(overrides: Partial<UsageStats> = {}): UsageStats {
  return { sequences: {}, commands: {}, resolved: [], ...overrides }
}

test('only habits at or above the threshold become candidates', () => {
  const candidates = skillCandidates(
    5,
    stats({
      commands: {
        'git diff': { count: 9, examples: ['git diff --stat'] },
        'ls': { count: 2, examples: ['ls -la'] },
      },
    }),
  )

  expect(candidates.map((candidate) => candidate.pattern)).toEqual(['git diff'])
  expect(candidates[0]!.count).toBe(9)
  expect(candidates[0]!.kind).toBe('command')
})

test('candidates are ordered by how often the habit occurred', () => {
  const candidates = skillCandidates(
    2,
    stats({
      commands: {
        rare: { count: 3, examples: [] },
        common: { count: 20, examples: [] },
      },
      sequences: { 'grep → read_file → edit_file': 11 },
    }),
  )

  expect(candidates.map((candidate) => candidate.pattern)).toEqual([
    'common',
    'grep → read_file → edit_file',
    'rare',
  ])
})

test('a pattern already turned into a skill stops being suggested', () => {
  const candidates = skillCandidates(
    2,
    stats({
      commands: { 'git diff': { count: 30, examples: [] } },
      resolved: ['git diff'],
    }),
  )

  expect(candidates).toEqual([])
})

test('tool sequences are reported as their own kind of candidate', () => {
  const candidates = skillCandidates(2, stats({ sequences: { 'grep → read_file → edit_file': 7 } }))

  expect(candidates[0]).toEqual({
    kind: 'sequence',
    pattern: 'grep → read_file → edit_file',
    count: 7,
    examples: [],
  })
})

test('no habits means no candidates', () => {
  expect(skillCandidates(5, stats())).toEqual([])
})
