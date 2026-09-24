import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

/**
 * Checks the claims an answer makes about the repository against the
 * repository.
 *
 * An answer that says "the retry lives in `src/net/retry.ts:88`" makes a claim
 * a file system can settle in microseconds, and a model that invents paths and
 * line numbers does so fluently enough that nobody checks. The idea comes from
 * AION's reasoning pipeline — extract the claims, verify each against a
 * knowledge base, send the answer back when one fails — with the one knowledge
 * base elia has that cannot be argued with: the checkout itself.
 *
 * Deliberately narrow, because a false alarm costs the user a model turn:
 *
 * - Only citations, never mentions. `path:line` and a markdown link to a local
 *   file both assert that the thing exists. A bare path in prose is often a
 *   file the answer proposes to create, and flagging it would be wrong.
 * - Only paths inside the workspace, with an extension a source or doc file
 *   has — `example.com:8080` is not a file. A bare file name that is not at
 *   the root (`retry.ts:88`) is skipped: it names a file somewhere, and
 *   guessing where would be the same invention this check exists to catch.
 * - Never a path the turn itself wrote, moved or deleted: "I removed
 *   src/old.ts:12" is true, and the file is gone because of it.
 *
 * A clean result proves nothing about the answer beyond its citations; like
 * reason/structural.ts it can fail an answer and can never pass one.
 */

export interface Citation {
  /** As written in the answer. */
  raw: string
  path: string
  line?: number
}

export interface UngroundedCitation {
  citation: Citation
  why: string
}

export interface GroundingResult {
  checked: number
  ungrounded: UngroundedCitation[]
}

const EXTENSIONS =
  'ts|tsx|mts|cts|js|jsx|mjs|cjs|json|jsonc|md|mdx|py|pyi|go|rs|java|kt|kts|scala|rb|php|c|h|cc|cpp|cxx|hpp|hh|cs|fs|swift|m|mm|sh|bash|zsh|ps1|yml|yaml|toml|ini|cfg|css|scss|sass|less|html|htm|vue|svelte|astro|sql|graphql|gql|proto|txt|lua|dart|ex|exs|erl|hs|ml|clj|zig|nim|r|jl|tf|gradle|xml|plist|env'

/** `src/a/b.ts:42`, `./x.py:3-9`, `lib/c.go:10:4` — a path with an extension, then a line. */
const PATH_WITH_LINE = new RegExp(`(?<![\\w/.@:~-])((?:\\.{1,2}/)?[\\w@.-]+(?:/[\\w@.-]+)*\\.(?:${EXTENSIONS})):(\\d+)(?:[-–]\\d+)?(?![\\w/])`, 'g')

/** `[label](target)` — a link whose target has no scheme and no leading `#`. */
const MARKDOWN_LINK = /\[[^\]\n]*\]\(([^)\s]+)\)/g

const LINKED_PATH = new RegExp(`^((?:\\.{1,2}/)?[\\w@.-]+(?:/[\\w@.-]+)*\\.(?:${EXTENSIONS}))(?:(?::|#L)(\\d+)(?:[-–]L?\\d+)?)?$`)

/** Citations in an answer. Fenced code is skipped: it quotes output and proposes code, it does not cite. */
export function extractCitations(text: string): Citation[] {
  const prose = text.replace(/```[\s\S]*?(?:```|$)/g, ' ')
  const found = new Map<string, Citation>()
  const add = (citation: Citation) => {
    const key = `${citation.path}:${citation.line ?? ''}`
    if (!found.has(key)) found.set(key, citation)
  }

  for (const match of prose.matchAll(MARKDOWN_LINK)) {
    const target = match[1]!
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#') || target.startsWith('/')) continue
    const parsed = LINKED_PATH.exec(target)
    if (!parsed) continue
    add({ raw: match[0], path: parsed[1]!, ...(parsed[2] ? { line: Number(parsed[2]) } : {}) })
  }
  // A link's label repeats its target in short (`[retry.ts:88](src/net/retry.ts:88)`);
  // the target was checked above, and the label alone would resolve to the root.
  for (const match of prose.replace(MARKDOWN_LINK, ' ').matchAll(PATH_WITH_LINE)) {
    add({ raw: match[0], path: match[1]!, line: Number(match[2]) })
  }
  return [...found.values()]
}

/** Lines in a file, counted without reading anything past a sane size. */
function lineCount(path: string): number | undefined {
  try {
    if (statSync(path).size > 8 * 1024 * 1024) return undefined
    const text = readFileSync(path, 'utf8')
    if (text.length === 0) return 0
    return text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
  } catch {
    return undefined
  }
}

export function checkGrounding(citations: Citation[], cwd: string, options: { touched?: Iterable<string> } = {}): GroundingResult {
  const touched = new Set([...(options.touched ?? [])].map((path) => resolve(cwd, path)))
  const ungrounded: UngroundedCitation[] = []
  let checked = 0

  for (const citation of citations) {
    const absolute = resolve(cwd, citation.path)
    const inside = relative(cwd, absolute)
    if (inside.startsWith('..') || isAbsolute(inside)) continue
    if (touched.has(absolute)) continue
    const exists = existsSync(absolute)
    if (!exists && !citation.path.includes('/')) continue
    checked += 1

    if (!exists) {
      ungrounded.push({ citation, why: 'no such file in this workspace' })
      continue
    }
    if (citation.line === undefined) continue
    let isFile = false
    try {
      isFile = statSync(absolute).isFile()
    } catch {}
    if (!isFile) {
      ungrounded.push({ citation, why: 'is a directory, not a file with lines' })
      continue
    }
    const lines = lineCount(absolute)
    if (lines !== undefined && (citation.line < 1 || citation.line > lines)) {
      ungrounded.push({ citation, why: `the file has ${lines} line${lines === 1 ? '' : 's'}` })
    }
  }
  return { checked, ungrounded }
}

/** The message that sends an answer back when its citations do not hold. */
export function groundingBriefing(result: GroundingResult): string {
  const lines = result.ungrounded.map(({ citation, why }) => `- ${citation.raw} — ${why}`)
  return [
    'Your answer cites locations that do not exist in this workspace:',
    ...lines,
    '',
    'Look each one up (list or search the files) before you rely on it. Then correct the answer: give the real path and line, or say plainly that you could not find it. Do not invent a replacement.',
  ].join('\n')
}

export function describeGrounding(result: GroundingResult): string {
  const shown = result.ungrounded.slice(0, 3).map(({ citation, why }) => `${citation.path}${citation.line ? `:${citation.line}` : ''} (${why})`)
  const more = result.ungrounded.length > 3 ? ` and ${result.ungrounded.length - 3} more` : ''
  return `${result.ungrounded.length} of ${result.checked} cited location(s) do not exist: ${shown.join(', ')}${more}`
}
