/**
 * Unified-diff parsing for the workspace activity feed.
 *
 * This is a parser rather than a pretty-printer. The feed needs the structure —
 * hunk boundaries, which lines were added or removed, whether a change is a
 * wholesale rewrite — to decide what to show and what to elide, none of which is
 * recoverable from pre-rendered text.
 *
 * The Go component computes the patch per link against that link's own base, so
 * the base is whatever the sender had agreed, not whatever this node has on
 * disk. `src/workspace/fileChange.ts` owns the rule for which base is used.
 *
 * Two behaviours here are deliberate rather than incidental:
 *
 * - Context is collapsible. Unchanged regions between hunks are absent from the
 *   text, so rendering shows hunk headers and never pretends to show whole
 *   files.
 * - A wholesale rewrite is flagged, not rendered as hundreds of lines. The
 *   component's diff engine falls back to delete-all/insert-all past a cell
 *   budget (`internal/diff/diff.go`), so a large no-context hunk is a rewrite
 *   report, not 2000 lines of noise. The counts are still exact.
 */

import { isEliaTrustFile, isSensitivePath } from '../autonomy/sensitivePaths.ts'
import { green, red } from '../ui/theme.ts'

export type DiffLineKind = 'context' | 'add' | 'remove'

/** One line of a hunk, with the line numbers it occupies on each side. */
export interface DiffLine {
  kind: DiffLineKind
  text: string
  oldLine?: number
  newLine?: number
  /** The file's final line was unterminated, so this line has no newline. */
  noNewline?: boolean
}

/** A contiguous run of changes, as delimited by an `@@` header. */
export interface DiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: DiffLine[]
}

export interface ParsedDiff {
  path: string
  hunks: DiffHunk[]
  isNewFile: boolean
  isDeleted: boolean
  binary: boolean
  /**
   * The sender replaced the whole file rather than editing it. Reported instead
   * of rendered, because the underlying engine could not diff it meaningfully.
   */
  degenerate: boolean
}

/**
 * Above this many added and removed lines with no context between them, the
 * diff is treated as a rewrite. A full-file deletion is not a rewrite — it has
 * additions of zero — so both sides must be non-trivial.
 */
const REWRITE_MIN_SIDE = 50

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/**
 * Parses a unified diff. Returns `binary: true` when the sender reported binary
 * content, and empty hunks when the text carried nothing to show — a caller must
 * not treat "no hunks" as "no change".
 */
export function parseUnifiedDiff(path: string, body: string): ParsedDiff {
  const lines = body.split('\n')
  const result: ParsedDiff = {
    path,
    hunks: [],
    isNewFile: false,
    isDeleted: false,
    binary: false,
    degenerate: false,
  }

  let hunk: DiffHunk | undefined
  let oldNo = 0
  let newNo = 0

  for (const raw of lines) {
    if (HUNK_HEADER.test(raw)) {
      const m = HUNK_HEADER.exec(raw)
      if (!m) continue
      hunk = {
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        lines: [],
      }
      result.hunks.push(hunk)
      oldNo = hunk.oldStart
      newNo = hunk.newStart
      continue
    }
    // Headers precede the first hunk; the /dev/null names mark create and delete.
    if (!hunk) {
      if (raw.startsWith('--- ')) {
        if (raw.includes('/dev/null')) result.isNewFile = true
        result.path = headerPath(raw.slice(4), path)
      } else if (raw.startsWith('+++ ')) {
        if (raw.includes('/dev/null')) result.isDeleted = true
      } else if (raw.startsWith('Binary files ') || raw.startsWith('GIT binary patch')) {
        result.binary = true
      }
      continue
    }
    if (raw === '' ) {
      // A trailing empty element from the final newline, not a context line.
      continue
    }
    if (raw.startsWith('\\')) {
      const last = hunk.lines.at(-1)
      if (last) last.noNewline = true
      continue
    }
    const marker = raw[0]
    if (marker === undefined) continue
    const text = raw.slice(1)
    if (marker === '+') {
      hunk.lines.push({ kind: 'add', text, newLine: newNo++ })
    } else if (marker === '-') {
      hunk.lines.push({ kind: 'remove', text, oldLine: oldNo++ })
    } else if (marker === ' ') {
      hunk.lines.push({ kind: 'context', text, oldLine: oldNo++, newLine: newNo++ })
    } else {
      // Anything else ends the hunk rather than being silently dropped.
      hunk = undefined
    }
  }

  result.degenerate = isRewrite(result)
  return result
}

/** Strips the `a/` and `b/` prefixes unified diffs use, and any trailing tab-separated timestamp. */
function headerPath(header: string, fallback: string): string {
  const bare = header.split('\t')[0]?.trim() ?? ''
  if (bare === '' || bare === '/dev/null') return fallback
  return bare.replace(/^[ab]\//, '')
}

function isRewrite(diff: ParsedDiff): boolean {
  let added = 0
  let removed = 0
  let context = 0
  for (const hunk of diff.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === 'add') added += 1
      else if (line.kind === 'remove') removed += 1
      else context += 1
    }
  }
  return context === 0 && added >= REWRITE_MIN_SIDE && removed >= REWRITE_MIN_SIDE
}

/** Exact line counts, taken from the parsed lines rather than the hunk headers. */
export function diffCounts(diff: ParsedDiff): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const hunk of diff.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === 'add') added += 1
      else if (line.kind === 'remove') removed += 1
    }
  }
  return { added, removed }
}

/** How a hunk should be rendered, given how many surrounding lines to keep. */
export interface RenderOptions {
  /** Lines of context to show around each change within a hunk. 0 shows changes only. */
  context?: number
  /** Colorize added and removed lines. Defaults to whatever the terminal allows. */
  color?: boolean
}

/**
 * Renders a parsed diff for display. Returns the summary line plus one block per
 * hunk; a rewrite returns only the summary, because its hunks are the noise the
 * flag exists to avoid.
 */
export function renderUnifiedDiff(diff: ParsedDiff, options: RenderOptions = {}): string {
  const context = Math.max(0, options.context ?? 3)
  const color = options.color ?? true
  const { added, removed } = diffCounts(diff)

  const out: string[] = [`${diff.path} +${added} -${removed}`]

  if (diff.binary) {
    out.push('  (binary content changed — no text diff)')
    return out.join('\n')
  }
  if (diff.degenerate) {
    out.push(`  (rewritten wholesale: ${added} lines replaced, diff not meaningful)`)
    return out.join('\n')
  }
  if (diff.hunks.length === 0) {
    out.push('  (no textual change)')
    return out.join('\n')
  }

  for (const hunk of diff.hunks) {
    const header = `  @@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`
    out.push(color ? header : header.trimEnd())
    for (const line of visibleLines(hunk.lines, context)) {
      const marker = line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '
      const gutter = `${formatNum(line.newLine ?? line.oldLine)} `
      const body = line.noNewline ? `${line.text} (no newline at end of file)` : line.text
      const painted =
        color && line.kind === 'add' ? green(body) : color && line.kind === 'remove' ? red(body) : body
      out.push(`${marker}${gutter}${painted}`)
    }
  }
  return out.join('\n')
}

function formatNum(n: number | undefined): string {
  return n === undefined ? '' : String(n)
}

/**
 * Keeps every change plus `context` lines either side of it, and inserts an
 * elision marker for the gap. A hunk that is entirely context is dropped, since
 * it would show unchanged lines the feed has no reason to display.
 */
function visibleLines(lines: DiffLine[], context: number): DiffLine[] {
  const keep = new Array<boolean>(lines.length).fill(false)
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]?.kind === 'context') continue
    for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j += 1) {
      keep[j] = true
    }
  }
  const out: DiffLine[] = []
  let skipping = false
  for (let i = 0; i < lines.length; i += 1) {
    if (keep[i]) {
      out.push(lines[i] as DiffLine)
      skipping = false
    } else if (!skipping) {
      out.push({ kind: 'context', text: `… ${i + 1} unchanged lines elided` })
      skipping = true
    }
  }
  return out
}

/**
 * Whether a diff body may be shown for a path.
 *
 * Both classifiers are required. `isSensitivePath` covers paths that store
 * secrets, and `isEliaTrustFile` covers Elia's own trust surface, which
 * `isSensitivePath` does not match: `policy.json` and `allow.json` are
 * ordinary project config names elsewhere, so they are matched by path rather
 * than bare file name. Checking only the first would show a diff of
 * `preauth.secret`, the key that signs standing approvals.
 *
 * Fail-closed with no override. The heuristic has false positives — a project's
 * `credentials` example is one — and that is the correct direction of error: the
 * metadata that survives is enough to say a path changed, and withholding a
 * body only costs the reader the detail.
 */
export function shouldWithholdDiffBody(path: string): boolean {
  return isSensitivePath(path) || isEliaTrustFile(path)
}

/** What the feed shows in place of a withheld body. */
export const WITHHELD_NOTICE = 'changed (contents withheld)'