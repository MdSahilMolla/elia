import { afterAll, beforeEach, expect, test } from 'bun:test'
import type { Item, ToolItem } from './store.ts'
import {
  clampLive,
  DEFAULT_CHROME_ROWS,
  estimateItemHeight,
  liveBudgetRows,
  liveCapEnabled,
  MIN_LIVE_ROWS,
  wrappedRows,
} from './liveRegion.ts'

const assistant = (id: string, text: string, streaming = true): Item => ({ id, kind: 'assistant', text, streaming })
const notice = (id: string, text: string): Item => ({ id, kind: 'notice', text })
const tool = (id: string, over: Partial<ToolItem> = {}): Item => ({
  id,
  kind: 'tool',
  name: 'run_command',
  input: { command: 'bun test' },
  status: 'running',
  ...over,
})
const lines = (n: number, width = 10): string =>
  Array.from({ length: n }, (_, i) => `${i}`.padEnd(width, 'x')).join('\n')

// The suite must read the same whether or not the operator is running with the
// flag exported in their shell, so each test starts from a cleared environment
// and the ambient values are put back afterwards.
const ambient = { cap: process.env.ELIA_LIVE_CAP, reserve: process.env.ELIA_LIVE_CAP_RESERVE }

beforeEach(() => {
  delete process.env.ELIA_LIVE_CAP
  delete process.env.ELIA_LIVE_CAP_RESERVE
})

afterAll(() => {
  if (ambient.cap === undefined) delete process.env.ELIA_LIVE_CAP
  else process.env.ELIA_LIVE_CAP = ambient.cap
  if (ambient.reserve === undefined) delete process.env.ELIA_LIVE_CAP_RESERVE
  else process.env.ELIA_LIVE_CAP_RESERVE = ambient.reserve
})

test('the cap is on unless explicitly switched off', () => {
  expect(liveCapEnabled()).toBe(true)
  for (const on of ['on', '1', 'true', 'ON']) {
    process.env.ELIA_LIVE_CAP = on
    expect(liveCapEnabled()).toBe(true)
  }
  for (const off of ['off', '0', 'false', 'OFF']) {
    process.env.ELIA_LIVE_CAP = off
    expect(liveCapEnabled()).toBe(false)
  }
})

test('wrappedRows counts wrapping against the gutter-reduced width', () => {
  expect(wrappedRows('', 80)).toBe(0)
  expect(wrappedRows('short', 80)).toBe(1)
  expect(wrappedRows('a\nb\nc', 80)).toBe(3)
  // 20 chars at 10 wide = 2 rows; the same text behind a 4-col gutter needs 4.
  expect(wrappedRows('x'.repeat(20), 10)).toBe(2)
  expect(wrappedRows('x'.repeat(20), 10, 4)).toBe(4)
  // A blank line still occupies a row.
  expect(wrappedRows('a\n\nb', 80)).toBe(3)
})

test('estimateItemHeight adds each kind s chrome to its payload', () => {
  // assistant: 1 row of marginTop + 3 payload rows
  expect(estimateItemHeight(assistant('a', 'one\ntwo\nthree'), 80)).toBe(4)
  // a lookup group: marginTop + header + one summary row, however many calls
  const group: Item = { id: 'g', kind: 'group', tools: [tool('r1', { name: 'read_file' }) as ToolItem, tool('r2', { name: 'grep' }) as ToolItem] }
  expect(estimateItemHeight(group, 80)).toBe(3)
  // notice: a bare single-line Text, no margin
  expect(estimateItemHeight(notice('n', 'saved'), 80)).toBe(1)
  // tool: marginTop + header, and no result means no body
  expect(estimateItemHeight(tool('t'), 80)).toBe(2)
  expect(estimateItemHeight(tool('t', { result: 'a\nb' }), 80)).toBe(4)
})

test('a collapsed tool body is estimated against the fold limit, not its full result', () => {
  const huge = tool('t', { status: 'ok', result: lines(5000) })
  // Collapsed cards fold to ~14 rows, so a 5000-line result must not be
  // estimated as 5000 rows — that would blow the whole budget on one card.
  expect(estimateItemHeight(huge, 80)).toBe(2 + 14)
  expect(estimateItemHeight(huge, 80, true)).toBe(2 + 600)
})

test('liveBudgetRows reserves room for the chrome below the transcript', () => {
  expect(liveBudgetRows(40)).toBe(40 - DEFAULT_CHROME_ROWS)
  // A tiny terminal still gets a usable floor rather than a negative budget.
  expect(liveBudgetRows(10)).toBe(MIN_LIVE_ROWS)
  expect(liveBudgetRows(1)).toBe(MIN_LIVE_ROWS)
  process.env.ELIA_LIVE_CAP_RESERVE = '4'
  expect(liveBudgetRows(40)).toBe(36)
})

test('a live region that already fits is passed through untouched', () => {
  const live = [assistant('a', 'one\ntwo'), notice('n', 'ok')]
  const capped = clampLive(live, { columns: 80, budgetRows: 20 })
  expect(capped.items).toBe(live)
  expect(capped.hiddenRows).toBe(0)
  expect(capped.hiddenItems).toBe(0)
})

test('overflow is trimmed off the top, newest content kept', () => {
  const live = [notice('n1', 'first'), notice('n2', 'second'), notice('n3', 'third'), notice('n4', 'fourth')]
  const capped = clampLive(live, { columns: 80, budgetRows: 3 })
  // budget 3, minus 1 row for the marker, leaves room for the last 2 notices.
  expect(capped.items.map((item) => item.id)).toEqual(['n3', 'n4'])
  expect(capped.hiddenItems).toBe(2)
  expect(capped.hiddenRows).toBe(2)
})

test('the oldest item that partially fits is kept with its tail', () => {
  const live = [assistant('a', lines(20))]
  const capped = clampLive(live, { columns: 80, budgetRows: 6 })
  expect(capped.items).toHaveLength(1)
  const kept = capped.items[0]!
  expect(kept.id).toBe('a')
  expect(kept.kind).toBe('assistant')
  // marker (1) + chrome (1) leaves 4 payload rows, and it is the *last* 4.
  const keptText = (kept as { text: string }).text
  expect(keptText.split('\n')).toHaveLength(4)
  expect(keptText.split('\n').at(-1)).toBe((lines(20).split('\n').at(-1) as string))
  expect(capped.hiddenRows).toBe(16)
  // Clamped, not dropped — so it is not counted as a hidden item.
  expect(capped.hiddenItems).toBe(0)
})

test('a clamped item keeps its id so Ink does not remount the row mid-repaint', () => {
  const live = [assistant('stable', lines(40))]
  const capped = clampLive(live, { columns: 80, budgetRows: 8 })
  expect(capped.items[0]!.id).toBe('stable')
})

test('a tool card is clamped through its result, and the original is not mutated', () => {
  const original = tool('t', { status: 'running', result: lines(30) })
  const capped = clampLive([original], { columns: 80, budgetRows: 7 })
  const kept = capped.items[0] as ToolItem
  expect(kept.id).toBe('t')
  expect(kept.status).toBe('running')
  expect(kept.result!.split('\n').length).toBeLessThan(30)
  expect((original as ToolItem).result!.split('\n')).toHaveLength(30)
})

test('an item too tall for even one payload row is dropped whole', () => {
  const live = [notice('n1', 'old'), tool('t', { result: lines(30) })]
  // budget 3 → marker leaves 2, and the tool card s chrome alone is 2, so there
  // is no room for a payload row: the card is dropped rather than shown headless.
  const capped = clampLive(live, { columns: 80, budgetRows: 3 })
  expect(capped.items).toHaveLength(0)
  expect(capped.hiddenItems).toBe(2)
})

test('the trimmed region never exceeds the budget it was given', () => {
  const live: Item[] = [
    assistant('a1', lines(50)),
    tool('t1', { status: 'ok', result: lines(40) }),
    notice('n1', 'a notice'),
    assistant('a2', lines(30)),
  ]
  for (const budgetRows of [2, 3, 5, 8, 13, 21, 34]) {
    const capped = clampLive(live, { columns: 80, budgetRows })
    const height = capped.items.reduce((sum, item) => sum + estimateItemHeight(item, 80), 0)
    const marker = capped.hiddenRows > 0 ? 1 : 0
    expect(height + marker).toBeLessThanOrEqual(budgetRows)
  }
})

test('a narrower terminal wraps more, so more is trimmed at the same budget', () => {
  const live = [assistant('a', Array.from({ length: 12 }, () => 'x'.repeat(70)).join('\n'))]
  const wide = clampLive(live, { columns: 100, budgetRows: 10 })
  const narrow = clampLive(live, { columns: 40, budgetRows: 10 })
  expect(narrow.hiddenRows).toBeGreaterThan(wide.hiddenRows)
})
