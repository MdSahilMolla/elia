// Structural layout primitives — box borders, rules, aligned tables — built on
// top of theme.ts's colors. Kept separate from theme.ts because these functions
// measure and pad strings (which must ignore embedded ANSI codes to line up
// correctly), where theme.ts only ever produces them.
import { stripAnsi, dim } from './theme.ts'

const H = '─'
const V = '│'
const TL = '┌'
const TR = '┐'
const BL = '└'
const BR = '┘'

export function visibleWidth(text: string): number {
  let width = 0
  for (const character of Array.from(stripAnsi(text))) {
    const code = character.codePointAt(0) ?? 0
    if (isCombining(code) || code === 0) continue
    width += isWide(code) ? 2 : 1
  }
  return width
}

function visibleLength(text: string): number {
  return visibleWidth(text)
}

function isCombining(code: number): boolean {
  return (code >= 0x300 && code <= 0x36f) || (code >= 0x1ab0 && code <= 0x1aff) || (code >= 0x20d0 && code <= 0x20ff) || (code >= 0xfe20 && code <= 0xfe2f)
}

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2329 && code <= 0x232a) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff)
  )
}

/** Pads a possibly-colored string to a visible width without disturbing its ANSI codes. */
function padRight(text: string, width: number): string {
  const pad = width - visibleLength(text)
  return pad > 0 ? text + ' '.repeat(pad) : text
}

function padLeft(text: string, width: number): string {
  const pad = width - visibleLength(text)
  return pad > 0 ? ' '.repeat(pad) + text : text
}

/** The terminal's usable width, clamped so layout never depends on an unset column count or balloons on a huge screen. */
export function terminalWidth(max = 96): number {
  return Math.max(40, Math.min(max, process.stdout.columns ?? 80))
}

/** A full-width horizontal rule, for separating turns or sections in scrollback. */
export function hr(width = terminalWidth(), char = H): string {
  return dim(char.repeat(width))
}

export interface BoxOptions {
  title?: string
  /** Colors the border characters (and title). Defaults to dim, so content colors stay the focus. */
  borderColor?: (text: string) => string
  maxWidth?: number
}

export interface Frame {
  top: string
  bottom: string
  /** Wraps one line of content between the side borders, padded to the frame's fixed inner width. */
  line(content: string): string
  innerWidth: number
}

/**
 * A bordered frame whose width is fixed up front rather than measured from
 * content — for panels that redraw in place (a live board, a spinner) where
 * the border must not jitter horizontally as the content inside it changes
 * between renders. `box` below is the content-measuring convenience built on it.
 */
export function frame(innerWidth: number, options: BoxOptions = {}): Frame {
  const paint = options.borderColor ?? dim
  const width = innerWidth + 4
  const top = options.title
    ? `${TL}${H} ${options.title} ${H.repeat(Math.max(1, width - 5 - visibleLength(options.title)))}${TR}`
    : `${TL}${H.repeat(width - 2)}${TR}`
  const bottom = `${BL}${H.repeat(width - 2)}${BR}`

  return {
    top: paint(top),
    bottom: paint(bottom),
    innerWidth,
    line: (content: string) => `${paint(V)} ${padRight(content, innerWidth)} ${paint(V)}`,
  }
}

/**
 * Draws a bordered panel around pre-rendered lines, which may already carry ANSI
 * color — callers are expected to have word-wrapped any long prose themselves
 * (see `wrapText` below); a line that's still wider than the box after that
 * overflows the right border rather than risk truncating mid-escape-sequence.
 */
export function box(lines: string[], options: BoxOptions = {}): string {
  const cap = terminalWidth(options.maxWidth ?? 96) - 4
  const longest = lines.reduce((max, line) => Math.max(max, visibleLength(line)), 0)
  const titleWidth = options.title ? visibleLength(options.title) + 2 : 0
  const contentWidth = Math.min(cap, Math.max(20, longest, titleWidth))

  const f = frame(contentWidth, options)
  return [f.top, ...lines.map((line) => f.line(line)), f.bottom].join('\n')
}

/** Word-wraps plain (uncolored) text to a width — apply color to each returned line afterward, not before. */
export function wrapText(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    if (current.length + word.length + 1 > width && current.length > 0) {
      lines.push(current)
      current = word
    } else {
      current = current.length === 0 ? word : `${current} ${word}`
    }
  }
  if (current.length > 0) lines.push(current)
  return lines.length > 0 ? lines : ['']
}

export interface TableColumn {
  header: string
  align?: 'left' | 'right'
}

const MIN_COLUMN_WIDTH = 10
const COLUMN_SEPARATOR = '  '

/**
 * Scales natural column widths down to fit `available`, proportional to how
 * wide each column wanted to be, without letting any column collapse below
 * `minWidth`. Whatever rounding leaves over budget is trimmed from the
 * widest column(s) — the one with the most room to lose it.
 */
function fitColumnWidths(natural: number[], available: number, minWidth: number): number[] {
  const total = natural.reduce((sum, width) => sum + width, 0)
  if (total <= available || natural.length === 0) return natural

  const widths = natural.map((width) => Math.max(minWidth, Math.floor((width / total) * available)))
  let over = widths.reduce((sum, width) => sum + width, 0) - available
  while (over > 0) {
    let widestIndex = 0
    for (let i = 1; i < widths.length; i += 1) if (widths[i]! > widths[widestIndex]!) widestIndex = i
    if (widths[widestIndex]! <= minWidth) break // every column is already at the floor
    widths[widestIndex]! -= 1
    over -= 1
  }
  return widths
}

/** Splits a single visible-width "word" (no internal whitespace, but possibly ANSI-colored) into chunks that each fit `width`, for the rare token too long to wrap normally (a URL, an unbroken id). */
function hardBreak(word: string, width: number): string[] {
  const chunks: string[] = []
  let current = ''
  let currentWidth = 0
  let i = 0
  while (i < word.length) {
    const escape = /^\x1b\[[0-9;]*m/.exec(word.slice(i))
    if (escape) {
      current += escape[0]
      i += escape[0].length
      continue
    }
    const char = word[i]!
    const charWidth = visibleWidth(char)
    if (currentWidth + charWidth > width && current) {
      chunks.push(current)
      current = ''
      currentWidth = 0
    }
    current += char
    currentWidth += charWidth
    i += 1
  }
  if (current) chunks.push(current)
  return chunks.length > 0 ? chunks : ['']
}

/** Word-wraps ANSI-colored text (measuring by visible width, not byte length) to a column width, hard-breaking any single token that's wider than the column on its own. */
function wrapVisible(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let current = ''
  let currentWidth = 0
  for (const word of words) {
    const wordWidth = visibleWidth(word)
    if (wordWidth > width) {
      if (current) {
        lines.push(current)
        current = ''
        currentWidth = 0
      }
      const broken = hardBreak(word, width)
      lines.push(...broken.slice(0, -1))
      current = broken.at(-1) ?? ''
      currentWidth = visibleWidth(current)
      continue
    }
    const nextWidth = currentWidth + wordWidth + (current ? 1 : 0)
    if (nextWidth > width && current) {
      lines.push(current)
      current = word
      currentWidth = wordWidth
    } else {
      current = current ? `${current} ${word}` : word
      currentWidth = nextWidth
    }
  }
  if (current) lines.push(current)
  return lines.length > 0 ? lines : ['']
}

/** A GFM table cell may use literal `<br>` for an intentional line break — split on it before wrapping the rest. */
function cellLines(text: string, width: number): string[] {
  const paragraphs = text.replace(/<br\s*\/?>/gi, '\n').split('\n')
  const lines = paragraphs.flatMap((paragraph) => (visibleLength(paragraph) <= width ? [paragraph] : wrapVisible(paragraph, width)))
  return lines.length > 0 ? lines : ['']
}

/**
 * Aligned columns with a header and separator rule, no border — for dense
 * row-oriented listings (bench results, skills, runs) where a full box per
 * entry would be noise. Cells may carry color; the header/separator are dim.
 *
 * Column widths follow the content up to the terminal's width; past that,
 * columns shrink proportionally and cells wrap onto extra lines rather than
 * running off the edge of the screen — the failure mode this replaced was a
 * model-generated table with a paragraph in one cell stretching every row to
 * hundreds of columns wide.
 */
export function table(columns: TableColumn[], rows: string[][]): string[] {
  const naturalWidths = columns.map((col, i) =>
    Math.max(visibleLength(col.header), ...rows.map((row) => visibleLength(row[i] ?? '')), 0),
  )
  const separatorBudget = Math.max(0, columns.length - 1) * COLUMN_SEPARATOR.length
  const available = Math.max(columns.length * MIN_COLUMN_WIDTH, terminalWidth() - separatorBudget)
  const widths = fitColumnWidths(naturalWidths, available, MIN_COLUMN_WIDTH)

  const renderRow = (cells: string[]): string[] => {
    const wrapped = cells.map((cell, i) => cellLines(cell, widths[i] ?? MIN_COLUMN_WIDTH))
    const height = Math.max(1, ...wrapped.map((lines) => lines.length))
    const out: string[] = []
    for (let line = 0; line < height; line += 1) {
      out.push(
        wrapped
          .map((lines, i) => {
            const width = widths[i] ?? 0
            const content = lines[line] ?? ''
            return columns[i]?.align === 'right' ? padLeft(content, width) : padRight(content, width)
          })
          .join(COLUMN_SEPARATOR),
      )
    }
    return out
  }

  const headerLines = renderRow(columns.map((col) => col.header.toUpperCase())).map(dim)
  const separator = dim(widths.map((width) => H.repeat(width)).join(COLUMN_SEPARATOR))
  return [...headerLines, separator, ...rows.flatMap(renderRow)]
}
