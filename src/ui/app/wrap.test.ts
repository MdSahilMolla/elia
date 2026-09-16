import { expect, test } from 'bun:test'
import { wrapPlain, wrapRuns } from './wrap.ts'
import type { InlineRun } from '../markdownBlocks.ts'

// The exact line from a real ConPTY run: at 107 columns the word "delete" ends
// on the last column, and Ink's wrap (trim: false) carried the space after it
// to the next row — "   todos, saved…" one column out of line.
const PROMPT = 'Build a simple todo list web app from scratch with plain HTML, CSS and JavaScript: add, complete and delete todos, saved in localStorage.'

test('no wrapped line starts with the space it broke on', () => {
  for (const width of [20, 37, 64, 106, 107, 108]) {
    const lines = wrapPlain(PROMPT, width).split('\n')
    expect(lines.every((line) => !line.startsWith(' '))).toBe(true)
    expect(lines.every((line) => Bun.stringWidth(line) <= width)).toBe(true)
    // Nothing lost: the words are all still there, in order.
    expect(lines.join(' ')).toBe(PROMPT)
  }
})

test('a line that already fits, explicit newlines and indentation are left alone', () => {
  expect(wrapPlain('short', 40)).toBe('short')
  expect(wrapPlain('◐ Plan · 1/3 done — still open:\n  □ add the styles', 40)).toBe('◐ Plan · 1/3 done — still open:\n  □ add the styles')
  // A wrapped indented line keeps its indent on every row.
  expect(wrapPlain('  one two three four five six', 14)).toBe('  one two\n  three four\n  five six')
})

test('a word wider than the line is hard-broken rather than overflowing', () => {
  const lines = wrapPlain('see https://example.com/a/very/long/path/that/never/ends ok', 20).split('\n')
  expect(lines.every((line) => Bun.stringWidth(line) <= 20)).toBe(true)
  expect(lines.join('').replace(/\s/g, '')).toBe('seehttps://example.com/a/very/long/path/that/never/endsok')
})

test('styled runs break at the same places and keep their styling across the break', () => {
  const runs: InlineRun[] = [
    { kind: 'text', text: 'Run ' },
    { kind: 'code', text: 'bun test src/ui' },
    { kind: 'text', text: ' and then ' },
    { kind: 'strong', text: 'check the output' },
    { kind: 'text', text: ' carefully.' },
  ]
  const wrapped = wrapRuns(runs, 20)
  const text = wrapped.map((run) => run.text).join('')
  expect(text.split('\n').every((line) => Bun.stringWidth(line) <= 20 && !line.startsWith(' '))).toBe(true)
  // Code and bold survive, even when split over two rows.
  expect(wrapped.filter((run) => run.kind === 'code').map((run) => run.text).join('')).toBe('bun test src/ui')
  expect(wrapped.filter((run) => run.kind === 'strong').map((run) => run.text).join(' ')).toBe('check the output')
})

test('no width (a bare component render) means Ink wraps as before', () => {
  expect(wrapPlain(PROMPT, Number.POSITIVE_INFINITY)).toBe(PROMPT)
  const runs: InlineRun[] = [{ kind: 'text', text: PROMPT }]
  expect(wrapRuns(runs, Number.POSITIVE_INFINITY)).toBe(runs)
})
