import { expect, test } from 'bun:test'
import { highlightLine, normalizeLanguage } from './highlight.ts'

const text = (line: string, lang?: string) => highlightLine(line, lang).map((s) => s.text).join('')

test('segments always reconstruct the original line', () => {
  for (const line of [
    'const x = "hello" // trailing',
    "  return foo(bar, 42)",
    'def main(): pass  # note',
    '{ "key": 123, "flag": true }',
    '',
    'plain prose with no tokens',
  ]) {
    expect(text(line, 'ts')).toBe(line)
  }
})

test('normalizeLanguage maps aliases and rejects unknowns', () => {
  expect(normalizeLanguage('typescript')).toBe('ts')
  expect(normalizeLanguage('TSX')).toBe('ts')
  expect(normalizeLanguage('bash')).toBe('sh')
  expect(normalizeLanguage('brainfuck')).toBeUndefined()
  expect(normalizeLanguage(undefined)).toBeUndefined()
})

test('a whole-line comment is a single muted segment', () => {
  const segs = highlightLine('  // just a note', 'ts')
  expect(segs.some((s) => s.text.includes('// just a note') && s.color)).toBe(true)
})

test('keywords are bold; strings and numbers are tinted — inside the mono palette', () => {
  const segs = highlightLine('const n = "hi"', 'ts')
  expect(segs.find((s) => s.text === 'const')?.bold).toBe(true)
  expect(segs.find((s) => s.text === '"hi"')?.color).toBeDefined()
})

test('an unterminated string colours to end of line without dropping text', () => {
  expect(text('msg = "oops', 'py')).toBe('msg = "oops')
})
