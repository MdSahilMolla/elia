export type InlineRun =
  | { kind: 'text' | 'strong' | 'code'; text: string }
  | { kind: 'link'; text: string; url: string }

export type MarkdownBlock =
  | { kind: 'paragraph'; content: InlineRun[] }
  | { kind: 'heading'; level: number; content: InlineRun[] }
  | { kind: 'list'; items: MarkdownListItem[] }
  | { kind: 'quote'; lines: InlineRun[][] }
  | { kind: 'code'; language?: string; lines: string[]; complete: boolean }
  | { kind: 'rule' }
  | { kind: 'table'; header: InlineRun[][]; rows: InlineRun[][][]; align: Array<'left' | 'right' | 'center'> }

export interface MarkdownListItem {
  marker: string
  depth: number
  checked?: boolean
  content: InlineRun[]
}

const HEADING = /^(#{1,6})\s+(.*)$/
const LIST_ITEM = /^(\s*)([-+*]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/
const QUOTE = /^\s{0,3}>\s?(.*)$/
const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)?.*$/
const RULE = /^\s{0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/
const TABLE_SEPARATOR_CELL = /^:?-{3,}:?$/

/** Remove terminal escape/control sequences before model text reaches Ink. */
export function sanitizeTerminalText(text: string): string {
  return text
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|.)/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '')
}

function safeLink(url: string): boolean {
  const target = url.trim()
  if (/^(?:https?:\/\/|mailto:)/i.test(target)) return true
  return /^(?:\.{0,2}\/|#)[^\s]*$/.test(target)
}

/** Parse the deliberately small inline subset Elia renders in terminals. */
export function parseInline(input: string): InlineRun[] {
  const text = sanitizeTerminalText(input)
  const runs: InlineRun[] = []
  let plain = ''
  let index = 0

  const flushPlain = () => {
    if (!plain) return
    const previous = runs.at(-1)
    if (previous?.kind === 'text') previous.text += plain
    else runs.push({ kind: 'text', text: plain })
    plain = ''
  }

  while (index < text.length) {
    if (text[index] === '`') {
      const end = text.indexOf('`', index + 1)
      if (end > index + 1) {
        flushPlain()
        runs.push({ kind: 'code', text: text.slice(index + 1, end) })
        index = end + 1
        continue
      }
    }

    if (text.startsWith('**', index)) {
      const end = text.indexOf('**', index + 2)
      if (end > index + 2) {
        flushPlain()
        runs.push({ kind: 'strong', text: text.slice(index + 2, end) })
        index = end + 2
        continue
      }
    }

    if (text[index] === '[') {
      const labelEnd = text.indexOf('](', index + 1)
      const urlEnd = labelEnd === -1 ? -1 : text.indexOf(')', labelEnd + 2)
      if (labelEnd > index + 1 && urlEnd > labelEnd + 2) {
        const url = text.slice(labelEnd + 2, urlEnd).trim()
        if (safeLink(url)) {
          flushPlain()
          runs.push({ kind: 'link', text: text.slice(index + 1, labelEnd), url })
          index = urlEnd + 1
          continue
        }
      }
    }

    plain += text[index]
    index += 1
  }

  flushPlain()
  return runs.length > 0 ? runs : [{ kind: 'text', text: '' }]
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  const cells: string[] = []
  let cell = ''
  let escaped = false
  let code = false

  for (const char of trimmed) {
    if (escaped) {
      cell += char
      escaped = false
    } else if (char === '\\') {
      escaped = true
      cell += char
    } else if (char === '`') {
      code = !code
      cell += char
    } else if (char === '|' && !code) {
      cells.push(cell.trim())
      cell = ''
    } else {
      cell += char
    }
  }
  cells.push(cell.trim())
  return cells
}

function tableSeparator(line: string): Array<'left' | 'right' | 'center'> | undefined {
  const cells = splitTableRow(line)
  if (cells.length === 0 || cells.some((cell) => !TABLE_SEPARATOR_CELL.test(cell.replace(/\s/g, '')))) return undefined
  return cells.map((cell) => {
    const value = cell.replace(/\s/g, '')
    if (value.startsWith(':') && value.endsWith(':')) return 'center'
    return value.endsWith(':') ? 'right' : 'left'
  })
}

function hasTableCells(line: string): boolean {
  return line.includes('|') && splitTableRow(line).length > 1
}

/**
 * Parse complete or currently-streaming markdown into stable terminal blocks.
 * Unterminated constructs remain visible instead of being discarded.
 */
export function parseMarkdownBlocks(input: string): MarkdownBlock[] {
  const lines = sanitizeTerminalText(input).replace(/\r\n?/g, '\n').split('\n')
  const blocks: MarkdownBlock[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (!line.trim()) {
      index += 1
      continue
    }

    const fence = FENCE.exec(line)
    if (fence) {
      const marker = fence[1] ?? '```'
      const language = fence[2] || undefined
      const codeLines: string[] = []
      let complete = false
      index += 1
      while (index < lines.length) {
        const candidate = lines[index] ?? ''
        const close = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(candidate)
        const closeMarker = close?.[1]
        if (closeMarker && closeMarker[0] === marker[0] && closeMarker.length >= marker.length) {
          complete = true
          index += 1
          break
        }
        codeLines.push(candidate)
        index += 1
      }
      blocks.push({ kind: 'code', language, lines: codeLines, complete })
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1]?.length ?? 1, content: parseInline(heading[2] ?? '') })
      index += 1
      continue
    }

    if (RULE.test(line)) {
      blocks.push({ kind: 'rule' })
      index += 1
      continue
    }

    const alignment = index + 1 < lines.length ? tableSeparator(lines[index + 1] ?? '') : undefined
    if (alignment && hasTableCells(line) && alignment.length === splitTableRow(line).length) {
      const headerCells = splitTableRow(line)
      const rows: InlineRun[][][] = []
      index += 2
      while (index < lines.length && hasTableCells(lines[index] ?? '')) {
        rows.push(splitTableRow(lines[index] ?? '').map(parseInline))
        index += 1
      }
      blocks.push({ kind: 'table', header: headerCells.map(parseInline), rows, align: alignment })
      continue
    }

    if (LIST_ITEM.test(line)) {
      const items: MarkdownListItem[] = []
      while (index < lines.length) {
        const match = LIST_ITEM.exec(lines[index] ?? '')
        if (!match) break
        items.push({
          marker: match[2] ?? '-',
          depth: Math.floor((match[1]?.replace(/\t/g, '  ').length ?? 0) / 2),
          checked: match[3] === undefined ? undefined : match[3].toLowerCase() === 'x',
          content: parseInline(match[4] ?? ''),
        })
        index += 1
      }
      blocks.push({ kind: 'list', items })
      continue
    }

    if (QUOTE.test(line)) {
      const quoteLines: InlineRun[][] = []
      while (index < lines.length) {
        const match = QUOTE.exec(lines[index] ?? '')
        if (!match) break
        quoteLines.push(parseInline(match[1] ?? ''))
        index += 1
      }
      blocks.push({ kind: 'quote', lines: quoteLines })
      continue
    }

    const paragraph: string[] = []
    while (index < lines.length) {
      const candidate = lines[index] ?? ''
      if (!candidate.trim()) break
      if (paragraph.length > 0) {
        const beginsBlock = FENCE.test(candidate) || HEADING.test(candidate) || RULE.test(candidate) || LIST_ITEM.test(candidate) || QUOTE.test(candidate)
        const beginsTable = index + 1 < lines.length && hasTableCells(candidate) && Boolean(tableSeparator(lines[index + 1] ?? ''))
        if (beginsBlock || beginsTable) break
      }
      paragraph.push(candidate.trim())
      index += 1
    }
    blocks.push({ kind: 'paragraph', content: parseInline(paragraph.join(' ')) })
  }

  return blocks
}
