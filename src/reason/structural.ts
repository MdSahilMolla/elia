import { readFileSync } from 'node:fs'
import { extname } from 'node:path'

/**
 * The check that always exists.
 *
 * Of 89 recorded turns that changed files, 33 were never checked by anything:
 * `detectChecks` found no typecheck or test command, no page rendered, and the
 * turn was filed `skipped` — which is honest, but it means a third of elia's
 * file-changing work shipped with nothing having looked at it. The commonest
 * shapes are a single file edited somewhere no manifest owns, and a scratch
 * script written outside any project.
 *
 * A parse is what is left when everything else is unavailable. It needs no
 * project, no manifest, no server, no network and no model — just the bytes the
 * turn wrote. It cannot tell you the code is right. It can tell you the file is
 * *broken*, and the failures it catches are real and unglamorous: a write that
 * truncated, an edit that left a brace unclosed, a JSON config corrupted by a
 * bad replacement. Those ship silently today.
 *
 * ## The rule this module exists to respect
 *
 * A parse that passes is NOT a verification that passes, and this must never be
 * allowed to drift. elia's recorded history is a catalogue of gates that scored
 * something weak and reported it as something strong — every self-improvement
 * gate here was vacuous until it was audited, and 76 lessons were kept on the
 * strength of checks that measured nothing. If "it parses" were recorded as
 * `verify: pass`, the 37%-unverified number that motivated this file would drop
 * on paper while nothing improved, and the measurement that could have caught
 * that would itself be the thing that broke.
 *
 * So the contract is deliberately one-directional: this can move a turn to
 * `fail`, and it can never move a turn to `pass`. A clean parse leaves the turn
 * exactly as unverified as it was, with a line saying so in plainer words.
 */

export interface FileParseResult {
  file: string
  ok: boolean
  /** The parser's first line, when it rejected the file. */
  reason?: string
}

export interface StructuralOutcome {
  /** Files this could actually parse-check. */
  checked: FileParseResult[]
  /** Files outside what a parse can see — an image, a .md, a language with no in-process parser. */
  skipped: string[]
  broken: FileParseResult[]
}

const SCRIPT_LOADER: Record<string, 'ts' | 'tsx' | 'js' | 'jsx'> = {
  '.ts': 'ts',
  '.mts': 'ts',
  '.cts': 'ts',
  '.tsx': 'tsx',
  '.js': 'js',
  '.mjs': 'js',
  '.cjs': 'js',
  '.jsx': 'jsx',
}

const JSON_EXT = new Set(['.json', '.jsonc', '.webmanifest'])

/** First line only: a parser's full output is a wall, and the first line is the location. */
function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.split('\n').find((line) => line.trim()) ?? message.slice(0, 200)
}

/**
 * Parses one file, if it is a kind we can parse.
 *
 * Bun's transpiler runs in-process, so this costs microseconds per file and
 * cannot be blocked by a governor, a missing dependency, or a project that does
 * not build — which is the entire point, given this runs where every other check
 * was unavailable.
 */
export function parseFile(path: string, source: string): FileParseResult | undefined {
  const extension = extname(path).toLowerCase()

  const loader = SCRIPT_LOADER[extension]
  if (loader) {
    try {
      new Bun.Transpiler({ loader }).transformSync(source)
      return { file: path, ok: true }
    } catch (error) {
      return { file: path, ok: false, reason: firstLine(error) }
    }
  }

  if (JSON_EXT.has(extension)) {
    try {
      JSON.parse(source)
      return { file: path, ok: true }
    } catch (error) {
      return { file: path, ok: false, reason: firstLine(error) }
    }
  }

  return undefined
}

/**
 * Parse-checks the files a turn wrote.
 *
 * A file that cannot be read is reported skipped rather than broken: the usual
 * cause is a path the turn deleted or moved after writing it, and calling that a
 * syntax error would be a lie that costs a repair round.
 */
export function parseChangedFiles(paths: string[], read: (path: string) => string = (path) => readFileSync(path, 'utf8')): StructuralOutcome {
  const checked: FileParseResult[] = []
  const skipped: string[] = []

  for (const path of paths) {
    let source: string
    try {
      source = read(path)
    } catch {
      skipped.push(path)
      continue
    }
    const result = parseFile(path, source)
    if (result) checked.push(result)
    else skipped.push(path)
  }

  return { checked, skipped, broken: checked.filter((result) => !result.ok) }
}

/**
 * The line the user sees.
 *
 * The wording on a clean parse is the part that matters. "Not verified" stays,
 * because it is still true — what changes is that the turn now says what it
 * *did* manage to establish, instead of going quiet and leaving the user to
 * assume more than happened.
 */
export function describeStructural(outcome: StructuralOutcome, why: string): string {
  if (outcome.broken.length > 0) {
    const first = outcome.broken[0]!
    const more = outcome.broken.length > 1 ? ` (and ${outcome.broken.length - 1} more)` : ''
    return `${first.file} does not parse: ${first.reason}${more}`
  }
  if (outcome.checked.length === 0) return `Not verified — ${why}, and nothing among the changed files could be parse-checked`
  const files = `${outcome.checked.length} changed file${outcome.checked.length === 1 ? '' : 's'}`
  return `Not verified — ${why}. ${files} parse, but nothing ran them.`
}

/** Repair instructions for a file that does not parse. Concrete, because the fix always is. */
export function repairBriefing(outcome: StructuralOutcome): string {
  const listed = outcome.broken.map((result) => `- ${result.file}: ${result.reason}`).join('\n')
  return [
    'A file you just wrote does not parse. Whatever else is true of this change, it is broken as written:',
    '',
    listed,
    '',
    'This is a syntax failure, not a design question — the usual causes are a write that truncated, an edit that left a brace or bracket unclosed, or a replacement that corrupted the surrounding text. Open each file listed, read the region the parser names, and fix it in place.',
  ].join('\n')
}
