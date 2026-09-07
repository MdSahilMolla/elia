/**
 * Structural pre-flight for a file mutation.
 *
 * Before `edit_file` / `write_file` commits a change, run the C++ structural
 * validator (`native/elia-parse`, via the daemon) over the *proposed* contents.
 * If the edit newly breaks the file's bracket / string / comment structure —
 * the old contents parsed clean and the new ones do not — reject the write and
 * hand the model the exact positions. That trades a sub-millisecond check for a
 * failed build round-trip.
 *
 * Fails open in every uncertain case: daemon off or unreachable, unknown file
 * type, file already broken before the edit, checker error. It never blocks an
 * edit it is not confident about.
 */

import { DaemonUnavailable, daemonMode, daemonParseCheck } from '../daemon/index.ts'

/** Extensions the validator's lexers handle well. Everything else is skipped —
 * prose, config, and data files have brackets the validator would misread. */
const CHECKED_EXTENSIONS = new Set([
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs',
  'py', 'pyi', 'rs', 'go', 'java',
  'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'hxx',
])

/** Above this the structural check is skipped — an edit to a multi-MB generated
 * file is not what this guard is for, and the daemon caps its own capture. */
const MAX_CHECK_BYTES = 2_000_000

function extensionOf(path: string): string {
  const base = path.replace(/^.*[/\\]/, '')
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

/**
 * Returns a rejection message when `after` is structurally broken and `before`
 * was not — otherwise `undefined` (allow the write).
 */
export async function preflightStructuralCheck(
  path: string,
  before: string | undefined,
  after: string,
): Promise<string | undefined> {
  if (daemonMode() === 'off') return undefined
  if (!CHECKED_EXTENSIONS.has(extensionOf(path))) return undefined
  if (after.length > MAX_CHECK_BYTES) return undefined

  try {
    const afterResult = await daemonParseCheck({ source: after, path })
    if (afterResult.ok || afterResult.errors.length === 0) return undefined

    // Only block when the edit made it worse — a model repairing an
    // already-broken file must not be stopped by the breakage it is fixing.
    if (before !== undefined && before.trim().length > 0) {
      const beforeResult = await daemonParseCheck({ source: before, path })
      if (!beforeResult.ok) return undefined
    }

    const detail = afterResult.errors
      .slice(0, 5)
      .map((e) => `  line ${e.line}:${e.column} — ${e.message}`)
      .join('\n')
    return (
      `This change leaves ${path} structurally broken and was not written:\n${detail}\n\n` +
      `Balance the brackets / close the string or comment and try the edit again.`
    )
  } catch (err) {
    if (err instanceof DaemonUnavailable) return undefined
    return undefined // any checker problem: fail open
  }
}
