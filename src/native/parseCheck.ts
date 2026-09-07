/**
 * Structural pre-flight for a file mutation.
 *
 * Before `edit_file` / `write_file` commits a change, check the *proposed*
 * contents:
 *
 *  - `.java` goes through the JDK compiler (`jvm.check`, Java bridge), filtered
 *    to syntax/structure errors only — import-resolution noise from a missing
 *    classpath is ignored.
 *  - every other supported source file goes through the C++ structural validator
 *    (`native/elia-parse`, `parse.check`).
 *
 * If the edit newly breaks the file — the old contents were fine and the new
 * ones are not — reject the write and hand the model the exact positions. That
 * trades a sub-millisecond (a few hundred ms for Java) check for a failed build
 * round-trip.
 *
 * Fails open in every uncertain case: daemon off or unreachable, unknown file
 * type, file already broken before the edit, checker error. It never blocks an
 * edit it is not confident about.
 */

import {
  DaemonUnavailable,
  daemonJvmCheck,
  daemonMode,
  daemonParseCheck,
  type JvmCheckResult,
  type ParseCheckResult,
} from '../daemon/index.ts'

/** Extensions the C++ validator's lexers handle well. Everything else is skipped
 * — prose, config, and data files have brackets it would misread. */
const STRUCTURAL_EXTENSIONS = new Set([
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs',
  'py', 'pyi', 'rs', 'go',
  'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'hxx',
])

/** Above this the check is skipped — an edit to a multi-MB generated file is not
 * what this guard is for, and the daemon caps its own capture. */
const MAX_CHECK_BYTES = 2_000_000

/**
 * `javac` messages that mean "you broke the syntax", as opposed to semantic
 * errors that a missing classpath would also produce. Matched as substrings.
 */
const JAVA_SYNTAX_ERRORS = [
  "';' expected",
  "'(' expected",
  "')' expected",
  "'{' expected",
  "'}' expected",
  "'[' expected",
  "']' expected",
  '<identifier> expected',
  'illegal start of expression',
  'illegal start of type',
  'illegal start of statement',
  'class, interface, enum, or record expected',
  'reached end of file while parsing',
  'illegal character',
  'not a statement',
  'unclosed string literal',
  'unclosed character literal',
  'unclosed comment',
  'malformed',
]

function extensionOf(path: string): string {
  const base = path.replace(/^.*[/\\]/, '')
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

/**
 * Returns a rejection message when `after` is broken and `before` was not —
 * otherwise `undefined` (allow the write).
 */
export async function preflightStructuralCheck(
  path: string,
  before: string | undefined,
  after: string,
): Promise<string | undefined> {
  if (daemonMode() === 'off') return undefined
  if (after.length > MAX_CHECK_BYTES) return undefined
  const ext = extensionOf(path)

  try {
    if (ext === 'java') return await javaPreflight(path, before, after)
    if (STRUCTURAL_EXTENSIONS.has(ext)) return await structuralPreflight(path, before, after)
    return undefined
  } catch (err) {
    if (err instanceof DaemonUnavailable) return undefined
    return undefined // any checker problem: fail open
  }
}

async function structuralPreflight(
  path: string,
  before: string | undefined,
  after: string,
): Promise<string | undefined> {
  const afterResult = await daemonParseCheck({ source: after, path })
  if (isClean(afterResult)) return undefined

  if (before !== undefined && before.trim().length > 0) {
    const beforeResult = await daemonParseCheck({ source: before, path })
    if (!beforeResult.ok) return undefined // already broken; a repair must not be blocked
  }

  return reject(path, afterResult.errors.slice(0, 5).map((e) => `  line ${e.line}:${e.column} — ${e.message}`))
}

async function javaPreflight(
  path: string,
  before: string | undefined,
  after: string,
): Promise<string | undefined> {
  const afterErrors = javaSyntaxErrors(await daemonJvmCheck({ source: after, path }))
  if (afterErrors.length === 0) return undefined

  if (before !== undefined && before.trim().length > 0) {
    const beforeErrors = javaSyntaxErrors(await daemonJvmCheck({ source: before, path }))
    if (beforeErrors.length > 0) return undefined
  }

  return reject(path, afterErrors.slice(0, 5).map((e) => `  line ${e.line}:${e.column} — ${e.message}`))
}

function isClean(result: ParseCheckResult): boolean {
  return result.ok || result.errors.length === 0
}

function javaSyntaxErrors(result: JvmCheckResult): JvmCheckResult['errors'] {
  return result.errors.filter(
    (e) => e.severity === 'error' && JAVA_SYNTAX_ERRORS.some((needle) => e.message.includes(needle)),
  )
}

function reject(path: string, lines: string[]): string {
  return (
    `This change leaves ${path} broken and was not written:\n${lines.join('\n')}\n\n` +
    `Fix the syntax and try the edit again.`
  )
}
