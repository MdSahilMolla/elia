import { expect, test } from 'bun:test'
import { paintRow, parseDiff, wordChanges } from './diffRows.ts'

const fence = (body: string): string => `Edited src/stats.ts\n\n\`\`\`diff\n${body}\n\`\`\``

test('rows carry line numbers from the hunk header, and the first header is dropped', () => {
  const rows = parseDiff(fence('@@ -8,3 +8,3 @@\n export function average() {\n-  return a + 1\n+  return a\n }'))
  expect(rows.map((row) => [row.kind, row.num])).toEqual([
    ['ctx', 8],
    ['del', 9],
    ['add', 9],
    ['ctx', 10],
  ])
})

test('a later hunk stays as a gap marker', () => {
  const rows = parseDiff(fence('@@ -1,1 +1,1 @@\n-a\n+b\n@@ -20,1 +20,1 @@\n-c\n+d'))
  expect(rows.filter((row) => row.kind === 'hunk')).toHaveLength(1)
})

test('tabs become spaces so the band and the gutter keep a fixed width', () => {
  const rows = parseDiff(fence('@@ -1,1 +1,1 @@\n-\treturn 1\n+\treturn 2'))
  expect(rows[0]!.text).toBe('  return 1')
})

test('a replaced line marks only the words that changed', () => {
  const rows = parseDiff(fence('@@ -9,1 +9,1 @@\n-  return sum(values) / values.length + 1\n+  return sum(values) / values.length'))
  const [removed, added] = rows
  expect(removed!.changes).toBeDefined()
  const changedText = removed!.changes!.map(([a, b]) => removed!.text.slice(a, b)).join('')
  expect(changedText.trim()).toBe('+ 1')
  // Nothing was added on the new line — only removed from the old one.
  expect(added!.changes ?? []).toEqual([])
})

test('a line rewritten from scratch gets no word marks — it would light up everything', () => {
  expect(wordChanges('const a = fetchUsers()', 'throw new Error("unreachable")')).toBeUndefined()
  expect(wordChanges('', 'anything')).toBeUndefined()
})

test('unpaired additions and removals are left alone', () => {
  const rows = parseDiff(fence('@@ -1,2 +1,1 @@\n-one\n-two\n+uno'))
  expect(rows.every((row) => row.changes === undefined)).toBe(true)
})

test('painting splits syntax segments at the changed ranges and keeps every character', () => {
  const paints = paintRow(
    [
      { text: 'return ', bold: true },
      { text: 'total + 1', color: 'cyan' },
    ],
    [[12, 16]],
  )
  expect(paints.map((paint) => paint.text).join('')).toBe('return total + 1')
  expect(paints.filter((paint) => paint.changed).map((paint) => paint.text).join('')).toBe(' + 1')
  // The syntax colour survives the split.
  expect(paints.find((paint) => paint.changed)?.color).toBe('cyan')
  expect(paintRow([{ text: 'plain' }], undefined)).toEqual([{ text: 'plain' }])
})
