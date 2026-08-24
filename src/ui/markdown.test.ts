import { expect, test } from 'bun:test'
import { createMarkdownStream } from './markdown.ts'

const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '')

function run(...chunks: string[]): string {
  const stream = createMarkdownStream()
  let out = ''
  for (const chunk of chunks) out += stream.push(chunk)
  out += stream.flush()
  return out
}

test('plain text passes through unchanged', () => {
  expect(run('just a sentence, nothing special.\n')).toBe('just a sentence, nothing special.\n')
})

test('a bold span within one chunk has its markers stripped', () => {
  expect(strip(run('Hello **world**!\n'))).toBe('Hello world!\n')
})

test('a bold span split across chunks right at the opening "**" still resolves', () => {
  // The classic streaming trap: chunk 1 ends with a single '*', chunk 2 opens with the pairing '*'.
  expect(strip(run('**Hel', 'lo**\n'))).toBe('Hello\n')
})

test('a bold span split one character into the marker still resolves', () => {
  expect(strip(run('one *', '* two\n'))).toBe('one  two\n')
})

test('a lone asterisk that never pairs is printed literally', () => {
  expect(strip(run('5 * 3 = 15\n'))).toBe('5 * 3 = 15\n')
})

test('an unterminated bold span at the very end of a reply still closes on flush', () => {
  // Malformed markdown (odd number of '**') shouldn't leave bold stuck on forever.
  const stream = createMarkdownStream()
  let out = stream.push('this is **never closed')
  out += stream.flush()
  expect(strip(out)).toBe('this is never closed')
})

test('inline code markers are stripped', () => {
  expect(strip(run('run `bun test` first\n'))).toBe('run bun test first\n')
})

test('a header line has its "#" prefix stripped', () => {
  expect(strip(run('## Section Title\n'))).toBe('Section Title\n')
})

test('a line starting with "#" but not a real header prefix is left alone', () => {
  expect(strip(run('#5 is not a header\n'))).toBe('#5 is not a header\n')
})

test('a header split across chunks mid-hash-run still classifies correctly', () => {
  expect(strip(run('#', '# Title\n'))).toBe('Title\n')
})

test('a markdown table is rendered as aligned columns, not raw pipes', () => {
  const out = strip(run('| Area | Detail |\n|------|--------|\n| A | one |\n| B | two |\n\n'))
  expect(out).not.toContain('|')
  expect(out).toContain('AREA')
  expect(out).toContain('A')
  expect(out).toContain('one')
  const lines = out.split('\n').filter((line) => line.length > 0)
  const width = lines[0]!.length
  expect(lines.every((line) => line.length === width)).toBe(true)
})

test('a table streamed row by row across many chunks renders identically to one big chunk', () => {
  const wholeChunk = strip(run('| A | B |\n|---|---|\n| 1 | 2 |\n\nafter\n'))
  const streamedByRow = strip(run('| A | B |\n', '|---|---|\n', '| 1 | 2 |\n', '\n', 'after\n'))
  expect(streamedByRow).toBe(wholeChunk)
})

test('bold text inside a table cell is still stripped of its markers', () => {
  const out = strip(run('| Task | Status |\n|---|---|\n| **build** | done |\n\n'))
  expect(out).toContain('build')
  expect(out).not.toContain('*')
})

test('a pipe-containing line with no separator row is left as plain text, not mistaken for a table', () => {
  const out = strip(run('use `a | b` as the separator\n'))
  expect(out).toContain('a | b')
})

test('a table left unterminated at the end of a reply still renders on flush', () => {
  const stream = createMarkdownStream()
  let out = stream.push('| A | B |\n|---|---|\n| 1 | 2 |')
  out += stream.flush()
  const stripped = strip(out)
  expect(stripped).not.toContain('|')
  expect(stripped).toContain('1')
  expect(stripped).toContain('2')
})

test('plain multi-paragraph text with blank lines is preserved', () => {
  expect(run('first paragraph.\n\nsecond paragraph.\n')).toBe('first paragraph.\n\nsecond paragraph.\n')
})
