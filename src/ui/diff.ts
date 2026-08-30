// Unified-diff computation and terminal rendering, shared by the edit_file /
// write_file tools (which embed a patch in their model-facing result) and the
// REPL's tool-result renderer (which colorizes it for the human watching).
//
// Built on the `diff` package's structuredPatch so hunk boundaries and line
// numbers match what `git diff` / `patch` produce — the model gets a real,
// applyable patch, not an ad-hoc before/after dump.
import { structuredPatch } from 'diff'
import { colorEnabled, dim, green, red } from './theme.ts'

export interface DiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  /** Each entry keeps its leading marker: ' ' context, '-' removed, '+' added, '\' meta. */
  lines: string[]
}

export interface UnifiedDiff {
  path: string
  hunks: DiffHunk[]
  /** Total added / removed line counts across every hunk, for one-line summaries. */
  added: number
  removed: number
}

/** Computes the hunks between two strings. `context` is lines of unchanged code kept around each change. */
export function unifiedDiff(oldText: string, newText: string, path = 'file', context = 3): UnifiedDiff {
  const patch = structuredPatch(path, path, oldText, newText, '', '', { context })
  const hunks: DiffHunk[] = patch.hunks.map((hunk) => ({
    oldStart: hunk.oldStart,
    oldLines: hunk.oldLines,
    newStart: hunk.newStart,
    newLines: hunk.newLines,
    lines: hunk.lines,
  }))
  let added = 0
  let removed = 0
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) added += 1
      else if (line.startsWith('-')) removed += 1
    }
  }
  return { path, hunks, added, removed }
}

/** A wholly-new file rendered as one add-only hunk, capped so a huge generated file doesn't flood the screen. */
export function addOnlyDiff(newText: string, path = 'file', maxLines = 200): UnifiedDiff {
  const all = newText.length === 0 ? [] : newText.replace(/\n$/, '').split('\n')
  const shown = all.slice(0, maxLines)
  const lines = shown.map((line) => `+${line}`)
  if (all.length > shown.length) lines.push(`\\ +${all.length - shown.length} more line${all.length - shown.length === 1 ? '' : 's'} not shown`)
  return {
    path,
    hunks: all.length === 0 ? [] : [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: all.length, lines }],
    added: shown.length,
    removed: 0,
  }
}

export interface RenderDiffOptions {
  /** Stop after this many body lines and append a "… +N more" footer. */
  maxLines?: number
  /** Force color on/off; defaults to the terminal's capability. */
  color?: boolean
  /** Footer hint shown when truncated (e.g. "/expand"). */
  expandHint?: string
}

function gutter(n: number | undefined): string {
  return (n === undefined ? '' : String(n)).padStart(4, ' ')
}

/**
 * Renders hunks as colored terminal lines: a 4-wide line-number gutter (old
 * number on removals, new number elsewhere), then the +/-/space marker, then the
 * code. Returns an array of lines so callers control indentation and framing.
 */
export function renderDiff(diff: UnifiedDiff, options: RenderDiffOptions = {}): string[] {
  const useColor = options.color ?? colorEnabled
  const maxLines = options.maxLines ?? Number.POSITIVE_INFINITY
  const paint = useColor ? { dim, green, red } : { dim: id, green: id, red: id }

  const out: string[] = []
  let emitted = 0
  let skipped = 0

  for (const hunk of diff.hunks) {
    if (emitted >= maxLines) {
      skipped += hunk.lines.length
      continue
    }
    out.push(paint.dim(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`))
    let oldLn = hunk.oldStart
    let newLn = hunk.newStart
    for (const line of hunk.lines) {
      if (emitted >= maxLines) {
        skipped += 1
        continue
      }
      const marker = line[0]
      const body = line.slice(1)
      if (marker === '+') {
        out.push(paint.green(`${gutter(newLn)} + ${body}`))
        newLn += 1
      } else if (marker === '-') {
        out.push(paint.red(`${gutter(oldLn)} - ${body}`))
        oldLn += 1
      } else if (marker === '\\') {
        out.push(paint.dim(`       ${body.trim()}`))
      } else {
        out.push(paint.dim(`${gutter(newLn)}   ${body}`))
        oldLn += 1
        newLn += 1
      }
      emitted += 1
    }
  }

  if (skipped > 0) {
    const hint = options.expandHint ? ` — ${options.expandHint}` : ''
    out.push(paint.dim(`… +${skipped} more diff line${skipped === 1 ? '' : 's'}${hint}`))
  }
  return out
}

/** A ```diff fenced block for embedding in a tool result the model reads. Never colored. */
export function fencedDiff(diff: UnifiedDiff): string {
  const body: string[] = []
  for (const hunk of diff.hunks) {
    body.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`)
    body.push(...hunk.lines)
  }
  return ['```diff', ...body, '```'].join('\n')
}

/** "+12 −3" style change summary. */
export function diffStat(diff: UnifiedDiff): string {
  return `+${diff.added} −${diff.removed}`
}

function id(text: string): string {
  return text
}
