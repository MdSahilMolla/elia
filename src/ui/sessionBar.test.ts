import { expect, test } from 'bun:test'
import { renderSessionBar, statusGlyph } from './sessionBar.ts'
import { visibleWidth } from './layout.ts'

test('renders a chip per live session with the right glyph', () => {
  const bar = renderSessionBar([
    { name: 'feat/rate-limit', status: 'running', lastTask: 'wiring the limiter' },
    { name: 'bugfix/queue', status: 'waiting-input' },
    { name: 'research', status: 'idle' },
  ])
  expect(bar).toContain('[feat/rate-limit ●]')
  expect(bar).toContain('[bugfix/queue ●]')
  expect(bar).toContain('[research ○]')
})

test('renderSessionBar with no sessions is an empty line', () => {
  expect(renderSessionBar([])).toBe('')
})

test('every session status maps to exactly one glyph', () => {
  const expectations: Array<['running' | 'waiting-input' | 'idle' | 'blocked' | 'done' | 'errored', ReturnType<typeof statusGlyph>]> = [
    ['running', '●'],
    ['waiting-input', '●'],
    ['idle', '○'],
    ['blocked', '⚠'],
    ['done', '✓'],
    ['errored', '✗'],
  ]
  for (const [status, glyph] of expectations) {
    expect(statusGlyph(status)).toBe(glyph)
  }
})

test('keeps the line within the requested width, truncating long names from the left', () => {
  const sessions = [
    { name: 'feat/rate-limiter-implementation', status: 'blocked' as const },
    { name: 'bugfix/queue-drain-infinite-loop', status: 'running' as const },
    { name: 'research/llm-caching-strategy', status: 'idle' as const },
  ]
  for (const maxWidth of [30, 40, 50]) {
    const bar = renderSessionBar(sessions, maxWidth)
    expect(visibleWidth(bar)).toBeLessThanOrEqual(maxWidth)
  }
  const bar = renderSessionBar(sessions, 30)
  expect(visibleWidth(bar)).toBeLessThanOrEqual(30)
  expect(bar).toContain('●')
  expect(bar).toContain('…')
})

test('names that fit are not touched', () => {
  const bar = renderSessionBar([{ name: 'shop', status: 'done' as const }, { name: 'dash', status: 'idle' as const }], 40)
  expect(bar).toBe('[shop ✓] [dash ○]')
})

test('dropping chips from the end when even one name cannot help', () => {
  const long = Array.from({ length: 12 }, (_, i) => ({ name: `session-number-${i}`, status: 'running' as const }))
  const bar = renderSessionBar(long, 40)
  expect(visibleWidth(bar)).toBeLessThanOrEqual(40)
  expect(bar).toContain('●')
})