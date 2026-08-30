import { expect, test } from 'bun:test'
import { allMatches, closestRegions, lineAt, multipleMatchMessage, notFoundMessage, numberedSnippet } from './editMatch.ts'

const file = `function a() {
  return 1
}

function b() {
  return 2
}
`

test('lineAt maps an offset to a 1-indexed line', () => {
  expect(lineAt(file, 0)).toBe(1)
  expect(lineAt(file, file.indexOf('return 2'))).toBe(6)
})

test('numberedSnippet shows a marked context window', () => {
  const s = numberedSnippet(file, 6, 1)
  expect(s).toContain('› 6\t  return 2')
  expect(s).toContain('  5\tfunction b() {')
})

test('allMatches finds every occurrence', () => {
  expect(allMatches('a.b.a.b.a', 'a')).toHaveLength(3)
  expect(allMatches(file, 'return 1')).toHaveLength(1)
})

test('closestRegions locates text whose indentation differs', () => {
  const regions = closestRegions(file, 'return 2\n', 1)
  expect(regions[0]?.line).toBe(6)
})

test('notFoundMessage flags a whitespace-only mismatch and shows the real text', () => {
  const msg = notFoundMessage(file, 'return 2', 'x.ts') // missing the 2-space indent
  expect(msg).toContain('whitespace/indentation differs')
  expect(msg).toContain('return 2')
})

test('notFoundMessage says the text is simply absent when it is', () => {
  const msg = notFoundMessage(file, 'return 999', 'x.ts')
  expect(msg.toLowerCase()).toContain('read_file again')
})

test('multipleMatchMessage lists each occurrence with a line number', () => {
  const dup = 'x\nx\nx\n'
  const msg = multipleMatchMessage(dup, 'x\n', 'd.ts')
  expect(msg).toContain('matches 3 locations')
  expect(msg).toContain('lines 1, 2, 3')
  expect(msg).toContain('› 2\t')
})
