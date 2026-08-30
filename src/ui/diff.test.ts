import { expect, test } from 'bun:test'
import { addOnlyDiff, diffStat, fencedDiff, renderDiff, unifiedDiff } from './diff.ts'

test('unifiedDiff counts added and removed lines', () => {
  const before = 'one\ntwo\nthree\n'
  const after = 'one\nTWO\nthree\nfour\n'
  const diff = unifiedDiff(before, after, 'x.txt')
  expect(diff.added).toBe(2)
  expect(diff.removed).toBe(1)
  expect(diffStat(diff)).toBe('+2 −1')
})

test('renderDiff shows a line-number gutter and +/- markers without color', () => {
  const diff = unifiedDiff('a\nb\nc\n', 'a\nB\nc\n', 'x.txt')
  const lines = renderDiff(diff, { color: false })
  expect(lines.some((line) => line.includes('@@'))).toBe(true)
  expect(lines.some((line) => / - b$/.test(line))).toBe(true)
  expect(lines.some((line) => / \+ B$/.test(line))).toBe(true)
})

test('renderDiff truncates at maxLines and appends an expand hint', () => {
  const before = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')
  const after = before.replace(/line \d+/g, (m) => `${m}!`)
  const lines = renderDiff(unifiedDiff(before, after), { color: false, maxLines: 5, expandHint: '/expand' })
  expect(lines.at(-1)).toContain('more diff line')
  expect(lines.at(-1)).toContain('/expand')
})

test('addOnlyDiff caps long new files', () => {
  const diff = addOnlyDiff(Array.from({ length: 500 }, (_, i) => `l${i}`).join('\n'), 'new.ts', 10)
  expect(diff.added).toBe(10)
  expect(diff.removed).toBe(0)
  expect(fencedDiff(diff)).toContain('more line')
})

test('fencedDiff wraps hunks in a diff code fence', () => {
  const diff = unifiedDiff('x\n', 'y\n', 'f')
  const fenced = fencedDiff(diff)
  expect(fenced.startsWith('```diff\n')).toBe(true)
  expect(fenced.trimEnd().endsWith('```')).toBe(true)
})
