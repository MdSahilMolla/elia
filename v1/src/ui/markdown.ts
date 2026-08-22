import { raw, colorEnabled } from './theme.ts'
import { table as renderTable } from './layout.ts'

const HASH_RUN = /^#{1,6}$/
const HEADER_PREFIX = /^(#{1,6})\s$/
const TABLE_ROW = /^\|.*\|\s*$/
const TABLE_SEPARATOR = /^\s*\|?[\s:|-]+\|?\s*$/

type LineMode = 'classify' | 'passthrough' | 'header' | 'table'

export interface MarkdownStream {
  /** Feed one chunk of streamed text; returns whatever is now safe to print. */
  push(delta: string): string
  /** Call once at the end of the turn — flushes anything still held back (an in-progress table, an unresolved line prefix). */
  flush(): string
}

/**
 * A small streaming-safe markdown-lite renderer for terminal output.
 *
 * The model's replies are GitHub-flavored markdown; a real terminal understands
 * none of it, so dumping it raw shows literal "**" and unaligned "|" table rows
 * that wrap wherever the terminal feels like. But the entire point of streaming
 * text live is that it appears as it arrives — buffering the *whole* reply to
 * run it through a real markdown parser would fix the formatting at the cost of
 * that live feel, which is most of what makes this feel responsive.
 *
 * So this only buffers what it structurally has to:
 *  - A table can't be column-aligned until every row of it has arrived, so a
 *    table block is buffered whole and rendered in one shot when it ends.
 *  - Classifying a line as a header needs only its leading "#"s and one space
 *    — a handful of characters — so that's the only other thing ever held
 *    back, and only at the very start of each line.
 * Everything else streams through character by character, same as before.
 * Bold spans nest one level (no italics, no links) — enough for what models
 * actually produce in chat replies, not a markdown engine.
 */
export function createMarkdownStream(): MarkdownStream {
  let mode: LineMode = 'classify'
  let classifyBuf = ''
  let tableLines: string[] = []
  let tableCurrentLine = ''
  let boldOn = false
  let codeOn = false
  // A lone trailing '*' at the very end of a chunk might be the first half of a
  // '**' split across the streaming boundary — held here until the next push().
  let carry = ''

  function closeTable(): string {
    if (tableLines.length === 0) return ''
    const rendered = renderTableBlock(tableLines)
    tableLines = []
    return rendered
  }

  function step(buf: string): string {
    let out = ''
    let i = 0

    while (i < buf.length) {
      const ch = buf[i]!

      if (mode === 'table') {
        tableCurrentLine += ch
        if (ch === '\n') {
          const line = tableCurrentLine.slice(0, -1)
          tableCurrentLine = ''
          if (TABLE_ROW.test(line)) {
            tableLines.push(line)
          } else {
            out += closeTable()
            mode = 'classify'
            out += step(`${line}\n`) // this line wasn't a table row — reclassify it from scratch
          }
        }
        i += 1
        continue
      }

      if (mode === 'classify') {
        classifyBuf += ch
        i += 1

        if (classifyBuf === '|') {
          mode = 'table'
          tableCurrentLine = classifyBuf
          classifyBuf = ''
          continue
        }
        if (HASH_RUN.test(classifyBuf) && classifyBuf.length < 6) continue // might still extend into a header prefix
        if (HEADER_PREFIX.test(classifyBuf)) {
          mode = 'header'
          out += colorEnabled ? raw.bold + raw.gold : ''
          classifyBuf = ''
          continue
        }
        // Disqualified as a table or header line. Rewind rather than recurse on the
        // buffered fragment in isolation: a lone trailing '*' in it needs to stay
        // visible to whatever real character follows it in this same chunk, so it
        // can still pair into a '**' — a recursive call on a disconnected substring
        // would see only that fragment, treat the '*' as chunk-final, and wrongly
        // carry it even though the very next character (still in `buf`) resolves it.
        mode = 'passthrough'
        i -= classifyBuf.length
        classifyBuf = ''
        continue
      }

      // mode is 'passthrough' or 'header'
      if (ch === '\n') {
        if (mode === 'header') out += colorEnabled ? raw.reset : ''
        out += '\n'
        mode = 'classify'
        classifyBuf = ''
        i += 1
        continue
      }
      if (ch === '`') {
        codeOn = !codeOn
        out += colorEnabled ? (codeOn ? raw.dim : raw.reset) : ''
        i += 1
        continue
      }
      if (ch === '*') {
        if (i === buf.length - 1) {
          carry = '*'
          i += 1
          continue
        }
        if (buf[i + 1] === '*') {
          boldOn = !boldOn
          out += colorEnabled ? (boldOn ? raw.bold : raw.reset) : ''
          i += 2
          continue
        }
        out += ch // a lone '*' not part of a '**' pair — not supported, printed literally
        i += 1
        continue
      }
      out += ch
      i += 1
    }

    return out
  }

  return {
    push(delta: string): string {
      const buf = carry + delta
      carry = ''
      return step(buf)
    },
    flush(): string {
      let out = ''
      // Whatever's left in classifyBuf at this point can only be a partial run of
      // '#' characters that never resolved into a header (the '|' case transitions
      // out of classify immediately, within the same step() call) — plain '#' has
      // no meaning of its own, so it's already correct as literal text.
      if (classifyBuf) {
        out += classifyBuf
        classifyBuf = ''
      }
      // The table's last row may never have gotten its closing '\n' if the reply
      // just ended there — count it anyway rather than silently dropping it. If it
      // turns out not to be a real row after all, it has to print *after* the table
      // it was trailing, not before.
      let unmatchedLine = ''
      if (mode === 'table' && tableCurrentLine) {
        if (TABLE_ROW.test(tableCurrentLine)) tableLines.push(tableCurrentLine)
        else unmatchedLine = tableCurrentLine
        tableCurrentLine = ''
      }
      out += closeTable()
      out += unmatchedLine
      if (mode === 'header') out += colorEnabled ? raw.reset : ''
      if (carry) {
        out += carry
        carry = ''
      }
      if (boldOn) {
        out += colorEnabled ? raw.reset : ''
        boldOn = false
      }
      if (codeOn) {
        out += colorEnabled ? raw.reset : ''
        codeOn = false
      }
      mode = 'classify'
      return out
    },
  }
}

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return trimmed.split('|').map((cell) => cell.trim())
}

function columnAlign(cell: string): 'left' | 'right' {
  const trimmed = cell.trim()
  return trimmed.endsWith(':') && !trimmed.startsWith(':') ? 'right' : 'left'
}

/** Bold/code spans in a table cell are already-complete text, not a stream — a plain replace is enough, no state machine needed. */
function renderInlineStatic(text: string): string {
  const withBold = text.replace(/\*\*(.+?)\*\*/g, (_, inner: string) =>
    colorEnabled ? `${raw.bold}${inner}${raw.reset}` : inner,
  )
  return withBold.replace(/`([^`]+)`/g, (_, inner: string) => (colorEnabled ? `${raw.dim}${inner}${raw.reset}` : inner))
}

function renderTableBlock(lines: string[]): string {
  if (lines.length < 2 || !TABLE_SEPARATOR.test(lines[1]!)) {
    // No separator row means this was never really a GFM table — hand the raw lines back rather than guess.
    return `${lines.join('\n')}\n`
  }

  const headerCells = splitRow(lines[0]!)
  const alignCells = splitRow(lines[1]!)
  const columns = headerCells.map((header, i) => ({ header: renderInlineStatic(header), align: columnAlign(alignCells[i] ?? '') }))
  const rows = lines.slice(2).map((line) => splitRow(line).map(renderInlineStatic))

  return `${renderTable(columns, rows).join('\n')}\n`
}
