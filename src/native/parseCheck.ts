/**
 * Structural pre-flight for a file mutation.
 *
 * Before `edit_file` / `write_file` commits a change, check the *proposed*
 * contents:
 *
 *  - every supported non-Java source file goes through the C++ structural
 *    validator (`native/elia-parse`). This runs **in-process** via `bun:ffi`
 *    (`./ffi.ts`) whenever the `elia-native` library is built — no daemon, no
 *    socket, works with the default `ELIA_DAEMON=off`. The daemon's `parse.check`
 *    is only a fallback for when the library is missing but a daemon is up.
 *  - `.java` goes through the JDK compiler (`jvm.check`, Java bridge), filtered
 *    to syntax/structure errors only — import-resolution noise from a missing
 *    classpath is ignored. This genuinely needs the resident daemon, so a `.java`
 *    pre-flight is skipped unless `ELIA_DAEMON` is `auto`/`require`.
 *
 * If the edit newly breaks the file — the old contents were fine and the new
 * ones are not — reject the write and hand the model the exact positions. That
 * trades a sub-millisecond (a few hundred ms for Java) check for a failed build
 * round-trip.
 *
 * Fails open in every uncertain case: no checker available, unknown file type,
 * file already broken before the edit, checker error. It never blocks an edit it
 * is not confident about.
 */

import {
  DaemonUnavailable,
  daemonJvmCheck,
  daemonMode,
  daemonParseCheck,
  type JvmCheckResult,
  type ParseCheckResult,
} from '../daemon/index.ts'
import { nativeParseCheck, nativeUnavailableReason } from './ffi.ts'

/**
 * The reason the most recent pre-flight did nothing, or `undefined` when it
 * actually ran. `elia doctor` reads this; in `ELIA_DAEMON=require` mode it is
 * also echoed to stderr, so "why is the native check not firing?" has an answer
 * instead of silence.
 */
let lastSkipReason: string | undefined
export function lastPreflightSkipReason(): string | undefined {
  return lastSkipReason
}
function skip(reason: string): undefined {
  lastSkipReason = reason
  if (daemonMode() === 'require') process.stderr.write(`[elia] structural pre-flight skipped: ${reason}\n`)
  return undefined
}

/** Which structural checker actually handled the last edit: the in-process
 * `bun:ffi` library, the daemon's `parse.check`, or neither. `elia doctor` reads
 * this. */
export type StructuralBackend = 'native' | 'daemon' | 'none'
let lastBackend: StructuralBackend = 'none'
export function lastStructuralBackend(): StructuralBackend {
  return lastBackend
}

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
  if (after.length > MAX_CHECK_BYTES) return skip(`file over ${MAX_CHECK_BYTES} bytes`)
  const ext = extensionOf(path)

  try {
    let result: string | undefined
    if (ext === 'java') {
      if (daemonMode() === 'off') return skip('ELIA_DAEMON=off — the Java pre-flight needs the daemon (set ELIA_DAEMON=auto)')
      result = await javaPreflight(path, before, after)
    } else if (STRUCTURAL_EXTENSIONS.has(ext)) {
      const structural = await structuralPreflight(path, before, after)
      if (structural === NO_STRUCTURAL_CHECKER) {
        return skip(
          `no structural checker available — ${nativeUnavailableReason() ?? 'native library not loaded'}` +
            (daemonMode() === 'off' ? ' and ELIA_DAEMON=off' : ''),
        )
      }
      result = structural
    } else {
      return skip(`no checker for .${ext || '(no extension)'}`)
    }
    lastSkipReason = undefined
    return result
  } catch (err) {
    if (err instanceof DaemonUnavailable) return skip(`daemon unavailable: ${err.message}`)
    return skip(`checker error: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Distinguishes "the check ran and the edit is fine" (`undefined`) from "no
 * checker was available at all" — the latter is a skip, not an allow. */
const NO_STRUCTURAL_CHECKER = Symbol('no-structural-checker')

/**
 * Run the C++ structural validator on `source`. Prefers the in-process library
 * (`bun:ffi`); falls back to the daemon's `parse.check` only when the library is
 * absent but a daemon is enabled. Returns `undefined` when neither is available.
 */
async function runStructural(source: string, path: string): Promise<ParseCheckResult | undefined> {
  const inProcess = nativeParseCheck(source, { path })
  if (inProcess) {
    lastBackend = 'native'
    return inProcess
  }
  if (daemonMode() === 'off') return undefined
  const result = await daemonParseCheck({ source, path })
  lastBackend = 'daemon'
  return result
}

async function structuralPreflight(
  path: string,
  before: string | undefined,
  after: string,
): Promise<string | undefined | typeof NO_STRUCTURAL_CHECKER> {
  const afterResult = await runStructural(after, path)
  if (!afterResult) return NO_STRUCTURAL_CHECKER
  if (isClean(afterResult)) return undefined

  if (before !== undefined && before.trim().length > 0) {
    const beforeResult = await runStructural(before, path)
    if (beforeResult && !beforeResult.ok) return undefined // already broken; a repair must not be blocked
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
