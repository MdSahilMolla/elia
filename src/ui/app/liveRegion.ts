// WS0.7 — bound the height of Ink's live region.
//
// The bug this exists for: Ink repaints the live frame by emitting a blind
// cursor-up of `renderedHeight` rows and redrawing. Once that region is taller
// than the terminal's visible rows the top of it has already scrolled off, the
// cursor-up lands in the wrong place, and the repaint smears — the status bar
// flickers and blocks like the `Orienting` prompt print twice.
//
// `store.ts`'s `flushSettled()` is the first half of the defence: it keeps
// migrating *settled* items out of `live` and into `<Static>`, which Ink prints
// once and never touches again. But it cannot migrate an item that is still in
// motion, and a single streaming answer — or a fan-out of concurrently running
// tool cards — can exceed the viewport on its own.
//
// This module is the second half: given the live items and the real terminal
// geometry, decide how much of the live region may be *rendered*. Anything that
// does not fit is dropped from the top of the live frame — losslessly, because
// the moment those items settle `flushSettled()` sweeps them into `<Static>`
// and they print in full, in order, to scrollback. So the cap trims what is
// repainted, never what the operator ends up seeing.
//
// On by default since the ConPTY pass (2026-09-15): a real Windows console
// driven with mercury-2.5 duplicated whole frames into scrollback without it.
// `ELIA_LIVE_CAP=off` turns it back off.
import type { Item } from './store.ts'

/** Is the live-region cap enabled? On unless explicitly switched off. */
export function liveCapEnabled(): boolean {
  const raw = (process.env.ELIA_LIVE_CAP ?? 'on').toLowerCase()
  return !(raw === 'off' || raw === '0' || raw === 'false')
}

// Rows the rest of the frame needs below the transcript: the workspace panel,
// the working indicator and its tip, the input between its two rules and the
// status row, plus their margins. Deliberately generous — under-reserving
// reintroduces exactly the overflow this module exists to prevent, while
// over-reserving only trims a couple more rows off a live region that is
// already too tall to read.
export const DEFAULT_CHROME_ROWS = 16
/** Never squeeze the live region below this, however small the terminal. */
export const MIN_LIVE_ROWS = 6

function chromeReserve(): number {
  const override = Number.parseInt(process.env.ELIA_LIVE_CAP_RESERVE ?? '', 10)
  return Number.isFinite(override) && override >= 0 ? override : DEFAULT_CHROME_ROWS
}

/** Rows the live transcript region may occupy on a terminal `rows` tall. */
export function liveBudgetRows(rows: number, chromeRows: number = chromeReserve()): number {
  return Math.max(MIN_LIVE_ROWS, rows - chromeRows)
}

// Per-kind rendering overhead that is *not* the text payload: `marginTop`
// spacers, a tool card's summary header, and the left gutter each row is
// indented by. Mirrors TranscriptItem.tsx / ToolCard.tsx.
interface Shape {
  /** Rows the item costs before any payload row. */
  chrome: number
  /** Columns eaten by the left rail / indent on every payload row. */
  gutter: number
  /** Payload rows actually rendered are capped at this by the fold limits. */
  bodyLimit: number
}

function shapeOf(item: Item, expanded: boolean): Shape {
  switch (item.kind) {
    case 'user':
      return { chrome: 1, gutter: 2, bodyLimit: Infinity }
    case 'assistant':
      // Every row sits behind the two-column "● " lead.
      return { chrome: 1, gutter: 2, bodyLimit: Infinity }
    case 'thinking':
      // marginTop (a continuation has none); every row is indented behind "✻ ".
      return { chrome: item.continuation ? 0 : 1, gutter: 2, bodyLimit: Infinity }
    case 'tool':
      // marginTop + the one-line header; the body is folded to ~14 rows
      // collapsed (diff / shell tail / summary line) and 600 expanded.
      return { chrome: 2, gutter: 4, bodyLimit: expanded ? 600 : 14 }
    case 'group':
      // marginTop + header + one summary row; expanded lists one row per call.
      return { chrome: 2, gutter: 4, bodyLimit: expanded ? 600 : 1 }
    case 'shell':
      return { chrome: 1, gutter: 2, bodyLimit: Infinity }
    case 'error':
      return { chrome: 1, gutter: 2, bodyLimit: Infinity }
    case 'notice':
      return { chrome: 0, gutter: 2, bodyLimit: Infinity }
    case 'receipt':
      return { chrome: 1, gutter: 2, bodyLimit: Infinity }
    case 'header':
      return { chrome: 1, gutter: 2, bodyLimit: 3 }
  }
}

/** The text an item renders as rows. Tool cards render their `result` as the body. */
function payloadOf(item: Item): string {
  switch (item.kind) {
    case 'tool':
      return item.result ?? ''
    case 'group':
      return item.tools.map((tool) => tool.name).join('\n')
    case 'header':
      return 'header\nline'
    default:
      return item.text
  }
}

function withPayload(item: Item, payload: string): Item {
  // Same `id` on purpose: it is the React key, and swapping it mid-stream would
  // make Ink unmount and remount the row it is in the middle of repainting.
  if (item.kind === 'tool') return { ...item, result: payload }
  if (item.kind === 'group' || item.kind === 'header') return item
  return { ...item, text: payload }
}

/**
 * Rows `text` occupies at `columns` wide behind a `gutter`-wide indent.
 *
 * An approximation on purpose: it counts UTF-16 code units, so wide CJK glyphs
 * and emoji are under-counted and ANSI-styled markdown is over-counted. Exact
 * measurement would mean rendering the tree twice per frame. The cap only has
 * to stay in the right neighbourhood — being a row or two pessimistic costs a
 * trimmed line, while the failure it prevents smears the whole frame.
 */
export function wrappedRows(text: string, columns: number, gutter = 0): number {
  if (text === '') return 0
  const width = Math.max(1, columns - gutter)
  let rows = 0
  for (const line of text.split('\n')) rows += Math.max(1, Math.ceil(line.length / width))
  return rows
}

/** Estimated rendered height of one live item, in terminal rows. */
export function estimateItemHeight(item: Item, columns: number, expanded = false): number {
  const shape = shapeOf(item, expanded)
  const body = Math.min(shape.bodyLimit, wrappedRows(payloadOf(item), columns, shape.gutter))
  return shape.chrome + body
}

/** Keep the last `rows` rendered rows of `text`, dropping whole source lines off the top. */
function clampToTail(text: string, rows: number, columns: number, gutter: number): string {
  const lines = text.split('\n')
  const width = Math.max(1, columns - gutter)
  let used = 0
  let cut = lines.length
  while (cut > 0) {
    const cost = Math.max(1, Math.ceil(lines[cut - 1]!.length / width))
    if (used + cost > rows) break
    used += cost
    cut -= 1
  }
  return lines.slice(cut).join('\n')
}

export interface LiveCapOptions {
  columns: number
  /** Rows the live transcript region may occupy — see `liveBudgetRows`. */
  budgetRows: number
  /** Ctrl+O state: expanded cards render far more body rows. */
  expanded?: boolean
}

export interface ClampedLive {
  /** What the live region should render, oldest first. */
  items: readonly Item[]
  /** Estimated rows trimmed off the top. `0` means nothing was trimmed. */
  hiddenRows: number
  /** Items dropped whole. An item kept with a clamped tail is not counted here. */
  hiddenItems: number
}

/**
 * Trim the live region to `budgetRows`, keeping the newest content — that is
 * where the cursor is and what the operator is actually watching. Items that do
 * not fit are dropped from the top; the oldest item that partially fits has its
 * payload tail-clamped.
 *
 * Nothing is lost: every trimmed item prints in full to `<Static>` as soon as
 * it settles. One cosmetic caveat — a tool card whose `result` gets tail-clamped
 * can lose the fenced diff header the diff renderer looks for, so it falls back
 * to a plain body for as long as it is still running.
 */
export function clampLive(live: readonly Item[], options: LiveCapOptions): ClampedLive {
  const { columns, expanded = false } = options
  const budget = Math.max(1, options.budgetRows)

  const heights = live.map((item) => estimateItemHeight(item, columns, expanded))
  const total = heights.reduce((sum, height) => sum + height, 0)
  if (total <= budget) return { items: live, hiddenRows: 0, hiddenItems: 0 }

  // One row goes to the "… N earlier rows" marker Transcript renders once we
  // are trimming, so a capped frame reads differently from a merely short one.
  let available = Math.max(1, budget - 1)
  const kept: Item[] = []
  let hiddenRows = 0
  let hiddenItems = 0

  for (let i = live.length - 1; i >= 0; i -= 1) {
    const item = live[i]!
    const height = heights[i]!
    if (height <= available) {
      kept.unshift(item)
      available -= height
      continue
    }
    // Room for this item's chrome plus at least one payload row? Keep a clamped
    // tail of it. Otherwise drop it whole — and everything older with it, since
    // we are walking newest-first and the budget only shrinks from here.
    const shape = shapeOf(item, expanded)
    const payloadRows = available - shape.chrome
    if (payloadRows >= 1) {
      const clamped = withPayload(item, clampToTail(payloadOf(item), payloadRows, columns, shape.gutter))
      kept.unshift(clamped)
      hiddenRows += height - estimateItemHeight(clamped, columns, expanded)
    } else {
      hiddenRows += height
      hiddenItems += 1
    }
    for (let older = i - 1; older >= 0; older -= 1) {
      hiddenRows += heights[older]!
      hiddenItems += 1
    }
    return { items: kept, hiddenRows, hiddenItems }
  }

  return { items: kept, hiddenRows, hiddenItems }
}
