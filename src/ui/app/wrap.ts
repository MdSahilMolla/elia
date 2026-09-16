// Word wrapping for prose, done before Ink sees it.
//
// Ink wraps <Text> with wrap-ansi's `trim: false`, and when a word ends exactly
// at the column edge the space after it is carried to the start of the next
// row — "…add, complete and delete" / " todos, saved…" — so every so often a
// wrapped line starts one column to the right of its neighbours. Pre-breaking
// prose at the width it will actually get means Ink never has to break it.
// Code keeps Ink's wrapping: its leading whitespace is meaningful.
import { createContext, useContext } from 'react'
import type { InlineRun } from '../markdownBlocks.ts'

/** Columns the whole frame gets. Infinity (the default) means "let Ink wrap". */
export const FrameWidth = createContext<number>(Number.POSITIVE_INFINITY)

export function useFrameWidth(): number {
  return useContext(FrameWidth)
}

const widthOf = (text: string): number => Bun.stringWidth(text)

interface Range {
  start: number
  end: number
}

/**
 * Line ranges for `text` at `width` columns: breaks at spaces (the space is
 * dropped), hard-breaks a word wider than a whole line. No newlines in `text`.
 */
function lineRanges(text: string, width: number): Range[] {
  const ranges: Range[] = []
  let lineStart = 0
  let lineWidth = 0
  let lastBreak = -1 // index of the last space on this line
  let i = 0
  while (i < text.length) {
    const char = String.fromCodePoint(text.codePointAt(i)!)
    const w = widthOf(char)
    if (char === ' ') lastBreak = i
    if (lineWidth + w > width && i > lineStart) {
      if (char === ' ') {
        ranges.push({ start: lineStart, end: i })
        i += 1
        while (text[i] === ' ') i += 1
        lineStart = i
        lineWidth = 0
        lastBreak = -1
        continue
      }
      if (lastBreak > lineStart) {
        ranges.push({ start: lineStart, end: lastBreak })
        i = lastBreak + 1
        while (text[i] === ' ') i += 1
      } else {
        ranges.push({ start: lineStart, end: i })
      }
      lineStart = i
      lineWidth = 0
      lastBreak = -1
      continue
    }
    lineWidth += w
    i += char.length
  }
  ranges.push({ start: lineStart, end: text.length })
  return ranges
}

/** Wrap plain text to `width`, keeping explicit newlines and each line's own indent. */
export function wrapPlain(text: string, width: number): string {
  if (!Number.isFinite(width) || width < 8) return text
  return text
    .split('\n')
    .map((line) => {
      if (widthOf(line) <= width) return line
      const indent = /^\s*/.exec(line)![0]
      const body = line.slice(indent.length)
      return lineRanges(body, Math.max(4, width - indent.length))
        .map((range) => indent + body.slice(range.start, range.end))
        .join('\n')
    })
    .join('\n')
}

const visibleText = (run: InlineRun): string => (run.kind === 'link' && run.text !== run.url ? `${run.text} (${run.url})` : run.kind === 'link' ? run.url : run.text)

/**
 * Wrap a paragraph's styled runs to `width`: the same breaks as `wrapPlain`,
 * with each run split where a line ends, so bold/code/link styling survives
 * the break. Links are flattened to their visible text.
 */
export function wrapRuns(runs: InlineRun[], width: number): InlineRun[] {
  if (!Number.isFinite(width) || width < 8) return runs
  const flat = runs.map((run) => ({ run, text: visibleText(run) }))
  const plain = flat.map((part) => part.text).join('')
  if (plain.includes('\n') || widthOf(plain) <= width) return runs
  const bounds: { start: number; end: number; run: InlineRun }[] = []
  let offset = 0
  for (const part of flat) {
    bounds.push({ start: offset, end: offset + part.text.length, run: part.run })
    offset += part.text.length
  }
  const out: InlineRun[] = []
  const ranges = lineRanges(plain, width)
  ranges.forEach((line, index) => {
    for (const bound of bounds) {
      const start = Math.max(line.start, bound.start)
      const end = Math.min(line.end, bound.end)
      if (end <= start) continue
      const text = plain.slice(start, end)
      if (bound.run.kind === 'link') out.push({ kind: 'link', text, url: text })
      else out.push({ kind: bound.run.kind, text })
    }
    if (index < ranges.length - 1) out.push({ kind: 'text', text: '\n' })
  })
  return out
}
