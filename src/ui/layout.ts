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

/**
 * Aligned columns with a header and separator rule, no border — for dense
 * row-oriented listings (bench results, skills, runs) where a full box per
 * entry would be noise. Cells may carry color; the header/separator are dim.
 */
export function table(columns: TableColumn[], rows: string[][]): string[] {
  const widths = columns.map((col, i) =>
    Math.max(visibleLength(col.header), ...rows.map((row) => visibleLength(row[i] ?? '')), 0),
  )

  const renderRow = (cells: string[]): string =>
    cells
      .map((cell, i) => {
        const width = widths[i] ?? 0
        return columns[i]?.align === 'right' ? padLeft(cell, width) : padRight(cell, width)
      })
      .join('  ')

  const header = dim(renderRow(columns.map((col) => col.header.toUpperCase())))
  const separator = dim(widths.map((width) => H.repeat(width)).join('  '))
  return [header, separator, ...rows.map(renderRow)]
}
