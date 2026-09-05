import { clampOutput } from '../shell.ts'

/**
 * Builds the "what actually changed" section handed to the review panel.
 *
 * The diff has to be clamped — three reviewers each carrying an unbounded diff
 * is how a review turn blows its context — but a clamped diff is a quality
 * problem, not just a formatting one. `clampOutput` cuts the *middle* out, so
 * what disappears is whole files, and the reviewers were being told to "read the
 * changed files in full" without ever being told which files those were. A
 * reviewer that cannot see a file and does not know it exists reviews the change
 * it can see and approves. That is a fail-open gate in a loop that is otherwise
 * carefully fail-closed.
 *
 * So the file inventory is always included, built from the *unclamped* diff, and
 * when the diff was cut the reviewers are told so in as many words.
 */

/** How much diff text each reviewer carries before it is cut. */
export const REVIEW_DIFF_LIMIT = 8000

export interface ChangedFile {
  path: string
  added: number
  removed: number
}

/**
 * Parses `git diff --numstat`.
 *
 * Binary files are reported by git as `-\t-\t<path>`; they are real changes and
 * belong in the inventory, so they are kept with zero counts rather than
 * dropped. A rename arrives as `a\tb\told => new` (or with braces); the
 * destination path is the one a reviewer can open.
 */
export function parseNumstat(output: string): ChangedFile[] {
  const files: ChangedFile[] = []
  for (const line of output.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const parts = trimmed.split('\t')
    if (parts.length < 3) continue
    const [addedRaw, removedRaw, ...pathParts] = parts
    const path = renameDestination(pathParts.join('\t'))
    if (!path) continue
    files.push({
      path,
      added: Number.parseInt(addedRaw!, 10) || 0,
      removed: Number.parseInt(removedRaw!, 10) || 0,
    })
  }
  return files
}

/** `old => new` and `dir/{a => b}/file` both name the file a reviewer should open. */
function renameDestination(path: string): string {
  const braced = path.match(/^(.*)\{.*? => (.*?)\}(.*)$/)
  if (braced) return `${braced[1]}${braced[2]}${braced[3]}`.replace(/\/\//g, '/')
  const arrow = path.split(' => ')
  return (arrow.length > 1 ? arrow[arrow.length - 1]! : path).trim()
}

/** One line per changed file, so a reviewer can open anything the diff omitted. */
export function renderChangedFiles(files: ChangedFile[]): string {
  if (files.length === 0) return '(no files changed against HEAD)'
  return files.map((file) => `- ${file.path} (+${file.added} −${file.removed})`).join('\n')
}

export interface ReviewDiffOptions {
  /** Raw `git diff HEAD` output. */
  diff: string
  /** Raw `git diff --numstat HEAD` output. */
  numstat: string
  limit?: number
}

export interface ReviewDiffSection {
  /** The section to paste into the reviewer prompt. */
  text: string
  files: ChangedFile[]
  truncated: boolean
}

export function buildReviewDiffSection(options: ReviewDiffOptions): ReviewDiffSection {
  const limit = options.limit ?? REVIEW_DIFF_LIMIT
  const diff = options.diff.trim()
  const files = parseNumstat(options.numstat)
  const truncated = diff.length > limit

  const body = diff ? clampOutput(diff, limit) : '(no diff against HEAD — check git status below)'

  const sections = [
    `## Files changed (${files.length})`,
    renderChangedFiles(files),
    '',
    `## What actually changed (git diff HEAD)${truncated ? ' — TRUNCATED' : ''}`,
    body,
  ]

  if (truncated) {
    sections.push(
      '',
      // Named as an obligation, not a suggestion: the reviewer is the last gate,
      // and "I could not see it" must not resolve to "approve".
      'The diff above was cut to fit, and whole files are missing from the middle of it.',
      'Every file in the inventory above that you cannot see a diff for is UNREVIEWED.',
      'Read those files yourself before you submit a verdict. If you could not examine a',
      'changed file, say so in your verdict rather than approving around it.',
    )
  }

  return { text: sections.join('\n'), files, truncated }
}
