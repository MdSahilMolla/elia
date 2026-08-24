import { expect, test } from 'bun:test'
import { box, hr, table, terminalWidth, visibleWidth, wrapText } from './layout.ts'

const GOLD = '\x1b[33m'
const RESET = '\x1b[0m'

test('box sizes to its longest line and pads shorter ones to match', () => {
  const rendered = box(['short', 'a longer line here']).split('\n')

  const width = rendered[0]!.length
  expect(rendered.every((line) => line.length === width)).toBe(true)
  expect(rendered[0]!.startsWith('┌')).toBe(true)
  expect(rendered.at(-1)!.startsWith('└')).toBe(true)
})

test('box measures ANSI-colored lines by their visible width, not their byte length', () => {
  const plain = box(['plain text']).split('\n')
  const colored = box([`${GOLD}plain text${RESET}`]).split('\n')

  // Same visible content -> an identically-sized border, despite the extra color bytes.
  expect(colored[0]!.length).toBe(plain[0]!.length)
  expect(colored[1]).toContain(`${GOLD}plain text${RESET}`)
})

test('box renders a title into the top border', () => {
  const rendered = box(['x'], { title: 'Proposal' })
  expect(rendered).toContain('Proposal')
  expect(rendered.split('\n')[0]).toMatch(/^┌─ Proposal ─+┐$/)
})

test('box never truncates a line wider than the requested cap', () => {
  const long = 'x'.repeat(200)
  const rendered = box([long], { maxWidth: 40 }).split('\n')
  // The content line still contains the full text even though the border above/below is capped.
  expect(rendered[1]).toContain(long)
})

test('wrapText breaks on word boundaries within the given width', () => {
  const wrapped = wrapText('the quick brown fox jumps over the lazy dog', 12)
  expect(wrapped.every((line) => line.length <= 12)).toBe(true)
  expect(wrapped.join(' ')).toBe('the quick brown fox jumps over the lazy dog')
})

test('wrapText never returns an empty array, even for empty input', () => {
  expect(wrapText('', 10)).toEqual([''])
})

test('hr repeats the rule character to the requested width', () => {
  const line = hr(10, '-')
  expect(line.replace(/\x1b\[[0-9;]*m/g, '')).toBe('-'.repeat(10))
})

test('terminalWidth clamps to the given max and never drops below a usable floor', () => {
  expect(terminalWidth(200)).toBeLessThanOrEqual(200)
  expect(terminalWidth(10)).toBeGreaterThanOrEqual(40)
})

test('visibleWidth handles wide and combining Unicode characters', () => {
  expect(visibleWidth('界')).toBe(2)
  expect(visibleWidth('e\u0301')).toBe(1)
  expect(visibleWidth('a界b')).toBe(4)
})

test('table right-aligns numeric columns and left-aligns the rest', () => {
  const rows = table(
    [{ header: 'name' }, { header: 'count', align: 'right' }],
    [
      ['alpha', '3'],
      ['b', '120'],
    ],
  )

  const dataLines = rows.slice(2)
  expect(dataLines[0]).toMatch(/^alpha\s+3$/)
  expect(dataLines[1]!.trimEnd()).toMatch(/b\s+120$/)
})

test('table header and separator widths match the widest cell in each column', () => {
  const rows = table([{ header: 'id' }], [['s1'], ['a-much-longer-id']])
  const stripped = rows.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ''))
  const width = stripped[0]!.length
  expect(stripped.every((line) => line.length === width)).toBe(true)
})

test('table never renders a line wider than the terminal, wrapping an overlong cell instead', () => {
  const longCell = 'Early-warning, quantified risk probabilities, scenario analysis, trend identification, strategic summaries, hidden-relationship mapping. '.repeat(4)
  const rows = table(
    [{ header: 'section' }, { header: 'key points' }],
    [['Problem Statement', longCell]],
  )
  const stripped = rows.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ''))
  const cap = terminalWidth()
  expect(stripped.every((line) => line.length <= cap)).toBe(true)
  // Nothing from the overlong cell was dropped — every word still shows up somewhere in the block.
  const rendered = stripped.join(' ')
  for (const word of ['Early-warning,', 'hidden-relationship', 'mapping.']) {
    expect(rendered).toContain(word)
  }
})

test('table treats a literal <br> in a cell as a real line break', () => {
  const rows = table([{ header: 'notes' }], [['first line<br>second line']])
  const stripped = rows.map((line) => line.replace(/\x1b\[[0-9;]*m/g, '').trimEnd())
  expect(stripped).toContain('first line')
  expect(stripped).toContain('second line')
})

test('table still renders a single tight line per row when content already fits', () => {
  const rows = table([{ header: 'name' }, { header: 'count', align: 'right' }], [['alpha', '3']])
  expect(rows).toHaveLength(3) // header + separator + exactly one data line
})
