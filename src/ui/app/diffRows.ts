// The rows of an edit's diff card, and which words inside them changed.
//
// A removed line directly followed by its replacement is a pair; for a pair
// the words that actually differ get their own, stronger band, so a one-token
// fix reads as a one-token fix instead of two whole coloured lines to compare
// by eye. Pure — the card only paints what this returns.
import { diffWordsWithSpace } from 'diff'
import type { Segment } from './highlight.ts'

export type Range = [start: number, end: number]

export interface DiffRow {
  kind: 'hunk' | 'add' | 'del' | 'ctx' | 'meta'
  num?: number
  text: string
  /** For a paired add/del row: the character ranges that differ from its counterpart. */
  changes?: Range[]
}

/** Tabs would expand to whatever the terminal's tab stops are; the gutter and the band need a fixed width. */
const untab = (text: string): string => text.replace(/\t/g, '  ')

/** Parses the `` ```diff `` block of an edit/write result into rows with line numbers. */
export function parseDiff(result: string): DiffRow[] {
  const start = result.indexOf('```diff')
  if (start === -1) return []
  const afterFence = result.indexOf('\n', start)
  const end = result.indexOf('```', afterFence + 1)
  const body = result.slice(afterFence + 1, end === -1 ? undefined : end).split('\n')

  const rows: DiffRow[] = []
  let oldLn = 0
  let newLn = 0
  for (const rawLine of body) {
    const line = rawLine.replace(/\r$/, '')
    if (line.length === 0) continue
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (hunk) {
      oldLn = Number(hunk[1])
      newLn = Number(hunk[2])
      rows.push({ kind: 'hunk', text: line })
      continue
    }
    const marker = line[0]
    const text = untab(line.slice(1))
    if (marker === '+') rows.push({ kind: 'add', num: newLn++, text })
    else if (marker === '-') rows.push({ kind: 'del', num: oldLn++, text })
    else if (marker === '\\') rows.push({ kind: 'meta', text: text.trim() })
    else {
      rows.push({ kind: 'ctx', num: newLn, text })
      oldLn += 1
      newLn += 1
    }
  }
  // The first hunk header only restates the line numbers the gutter already
  // shows; later ones become a quiet "⋮" gap marker.
  const trimmed = rows.filter((row, i) => !(row.kind === 'hunk' && rows.slice(0, i).every((r) => r.kind === 'hunk')))
  return pairChanges(trimmed)
}

/** Longest line a word diff is attempted on — past this it is cost without payoff. */
const WORD_DIFF_MAX = 400
/** A pair where more than this share of a line changed is a rewrite; highlighting words would light up everything. */
const REWRITE_SHARE = 0.6

const span = (ranges: Range[]): number => ranges.reduce((total, [a, b]) => total + (b - a), 0)

/** Which characters of `before` and `after` differ, word by word. Undefined when the lines are too different to be worth it. */
export function wordChanges(before: string, after: string): { before: Range[]; after: Range[] } | undefined {
  if (before.length > WORD_DIFF_MAX || after.length > WORD_DIFF_MAX) return undefined
  if (!before.trim() || !after.trim()) return undefined
  const removed: Range[] = []
  const added: Range[] = []
  let i = 0
  let j = 0
  for (const part of diffWordsWithSpace(before, after)) {
    const length = part.value.length
    if (part.added) {
      added.push([j, j + length])
      j += length
    } else if (part.removed) {
      removed.push([i, i + length])
      i += length
    } else {
      i += length
      j += length
    }
  }
  if (removed.length === 0 && added.length === 0) return undefined
  if (span(removed) > before.length * REWRITE_SHARE || span(added) > after.length * REWRITE_SHARE) return undefined
  return { before: removed, after: added }
}

/** Marks word-level changes on each removed line that is directly replaced by an added one. */
export function pairChanges(rows: DiffRow[]): DiffRow[] {
  const out = rows.map((row) => ({ ...row }))
  let i = 0
  while (i < out.length) {
    if (out[i]!.kind !== 'del') {
      i += 1
      continue
    }
    let delEnd = i
    while (delEnd < out.length && out[delEnd]!.kind === 'del') delEnd += 1
    let addEnd = delEnd
    while (addEnd < out.length && out[addEnd]!.kind === 'add') addEnd += 1
    const dels = delEnd - i
    const adds = addEnd - delEnd
    // Only a like-for-like replacement pairs up line by line.
    if (dels === adds && dels <= 8) {
      for (let k = 0; k < dels; k += 1) {
        const del = out[i + k]!
        const add = out[delEnd + k]!
        const changes = wordChanges(del.text, add.text)
        if (changes) {
          del.changes = changes.before
          add.changes = changes.after
        }
      }
    }
    i = Math.max(addEnd, i + 1)
  }
  return out
}

export interface Paint {
  text: string
  color?: string
  bold?: boolean
  /** Inside a changed range — painted with the stronger band. */
  changed?: boolean
}

/**
 * Syntax segments split at the changed-range boundaries, so a row can carry
 * both its highlighting and its word-level band.
 */
export function paintRow(segments: readonly Segment[], changes: readonly Range[] | undefined): Paint[] {
  if (!changes || changes.length === 0) return segments.map((segment) => ({ ...segment }))
  const out: Paint[] = []
  let offset = 0
  for (const segment of segments) {
    let cursor = 0
    const text = segment.text
    while (cursor < text.length) {
      const at = offset + cursor
      const inside = changes.find(([a, b]) => at >= a && at < b)
      // Run to the next boundary: the end of this range, or the start of the next one.
      const nextStart = changes.map(([a]) => a).filter((a) => a > at).sort((a, b) => a - b)[0]
      const stop = inside ? inside[1] : nextStart ?? Number.POSITIVE_INFINITY
      const length = Math.min(text.length - cursor, stop - at)
      const piece: Paint = { text: text.slice(cursor, cursor + length), color: segment.color, bold: segment.bold }
      if (inside) piece.changed = true
      out.push(piece)
      cursor += length
    }
    offset += text.length
  }
  return out
}
