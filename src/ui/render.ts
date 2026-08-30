// Shared, pure rendering helpers for the REPL's scrollback: folding long tool
// output down to a head + "… N more" footer, and colorizing an embedded
// ```diff block. Kept free of I/O so stream.ts and the /expand command both
// call the same code and agree on where the cut is.
import { colorEnabled, dim, green, red } from './theme.ts'

export interface FoldOptions {
  /** Lines kept before the fold. */
  headLines?: number
  /** Byte ceiling; output past this is folded even if under headLines. */
  maxBytes?: number
  /** Hint appended to the fold footer, e.g. "/expand". */
  expandHint?: string
}

export interface FoldedText {
  text: string
  /** Lines hidden by the fold; 0 when nothing was folded. */
  hiddenLines: number
}

const DEFAULT_HEAD_LINES = 20
const DEFAULT_MAX_BYTES = 2_000

/**
 * Trims `text` to at most `headLines` lines (and `maxBytes` bytes), appending a
 * dim `⎿ … +N lines — /expand` footer when anything was cut. The full text
 * still lives in the session transcript for `/expand` to reprint.
 */
export function foldText(text: string, options: FoldOptions = {}): FoldedText {
  const headLines = options.headLines ?? DEFAULT_HEAD_LINES
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const hint = options.expandHint ?? '/expand'

  const lines = text.split('\n')
  const overByBytes = Buffer.byteLength(text, 'utf8') > maxBytes
  if (lines.length <= headLines && !overByBytes) return { text, hiddenLines: 0 }

  let kept = lines.slice(0, headLines)
  if (Buffer.byteLength(kept.join('\n'), 'utf8') > maxBytes) {
    while (kept.length > 1 && Buffer.byteLength(kept.join('\n'), 'utf8') > maxBytes) kept = kept.slice(0, -1)
  }
  const hiddenLines = lines.length - kept.length
  const footer = dim(`  ⎿ … +${hiddenLines} line${hiddenLines === 1 ? '' : 's'} — ${hint}`)
  return { text: `${kept.join('\n')}\n${footer}`, hiddenLines }
}

/**
 * Colorizes the lines inside a ```diff … ``` fence (green `+`, red `-`, dim
 * `@@` markers) and drops the fence lines themselves — a terminal wants the
 * colored diff, not the literal Markdown backticks. Lines outside a fence are
 * left untouched; a string with no fence comes back unchanged.
 */
export function colorizeDiffBlock(text: string): string {
  if (!text.includes('```diff')) return text
  const lines = text.split('\n')
  const out: string[] = []
  let inDiff = false
  for (const line of lines) {
    if (line.trim() === '```diff') {
      inDiff = true
      continue
    }
    if (inDiff && line.trim() === '```') {
      inDiff = false
      continue
    }
    if (!inDiff || !colorEnabled) {
      out.push(line)
      continue
    }
    if (line.startsWith('@@') || line.startsWith('\\')) out.push(dim(line))
    else if (line.startsWith('+')) out.push(green(line))
    else if (line.startsWith('-')) out.push(red(line))
    else out.push(dim(line))
  }
  return out.join('\n')
}

/** True when a tool's result is a file-mutation patch worth rendering in full colour rather than one-line summarising. */
export function isDiffResult(name: string): boolean {
  return name === 'edit_file' || name === 'write_file'
}
