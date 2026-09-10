/**
 * A deliberately small terminal syntax highlighter. Not a parser — a single
 * tokenizing pass that colours the four things that carry the most signal at a
 * glance: comments, strings, numbers, and language keywords. Everything else
 * stays default-coloured. Unknown languages fall through to string/number/comment
 * heuristics only.
 *
 * Returns segments so the caller can render `<Text color=…>` runs; it never
 * emits ANSI itself.
 */
import { palette } from './theme.ts'

export interface Segment {
  text: string
  color?: string
  /** Keywords use weight rather than hue, to stay inside the near-monochrome palette. */
  bold?: boolean
}

const KEYWORDS: Record<string, string[]> = {
  ts: 'const let var function return if else for while do switch case break continue class extends implements interface type enum import export from as new await async yield try catch finally throw typeof instanceof in of this super null undefined true false void never unknown any readonly public private protected static get set'.split(' '),
  js: 'const let var function return if else for while do switch case break continue class extends import export from as new await async yield try catch finally throw typeof instanceof in of this super null undefined true false void'.split(' '),
  py: 'def class return if elif else for while break continue import from as with lambda yield await async try except finally raise pass global nonlocal in is not and or None True False self'.split(' '),
  go: 'func return if else for range break continue switch case default type struct interface map chan go defer select package import var const nil true false make new'.split(' '),
  rust: 'fn let mut return if else for while loop match break continue struct enum impl trait pub use mod crate self super where async await move ref dyn Box Vec Option Result Some None Ok Err true false'.split(' '),
  sh: 'if then elif else fi for while do done case esac function return export local readonly set unset echo cd exit'.split(' '),
}

const LANGUAGE_ALIASES: Record<string, keyof typeof KEYWORDS | 'json'> = {
  typescript: 'ts', ts: 'ts', tsx: 'ts',
  javascript: 'js', js: 'js', jsx: 'js', mjs: 'js', cjs: 'js',
  python: 'py', py: 'py',
  go: 'go', golang: 'go',
  rust: 'rust', rs: 'rust',
  sh: 'sh', bash: 'sh', shell: 'sh', zsh: 'sh', console: 'sh',
  json: 'json', jsonc: 'json',
}

const COMMENT_PREFIX: Record<string, RegExp> = {
  ts: /^(\s*)(\/\/.*)$/,
  js: /^(\s*)(\/\/.*)$/,
  go: /^(\s*)(\/\/.*)$/,
  rust: /^(\s*)(\/\/.*)$/,
  py: /^(\s*)(#.*)$/,
  sh: /^(\s*)(#.*)$/,
}

export function normalizeLanguage(language?: string): string | undefined {
  if (!language) return undefined
  return LANGUAGE_ALIASES[language.toLowerCase().trim()]
}

/** Tokenize one line. `language` should already be normalized (see normalizeLanguage). */
export function highlightLine(line: string, language?: string): Segment[] {
  if (line.length === 0) return [{ text: '' }]

  // Whole-line comment (cheap, common) — bail early.
  const commentRe = language ? COMMENT_PREFIX[language] : undefined
  if (commentRe) {
    const m = commentRe.exec(line)
    if (m) return [{ text: m[1]! }, { text: m[2]!, color: palette.muted }]
  }

  const keywords = language && language !== 'json' ? new Set(KEYWORDS[language] ?? []) : new Set<string>()
  const segments: Segment[] = []
  let i = 0
  let plain = ''
  const flushPlain = () => {
    if (plain) segments.push({ text: plain })
    plain = ''
  }

  while (i < line.length) {
    const ch = line[i]!
    const rest = line.slice(i)

    // strings
    if (ch === '"' || ch === "'" || ch === '`') {
      const end = findStringEnd(line, i, ch)
      flushPlain()
      segments.push({ text: line.slice(i, end), color: palette.success })
      i = end
      continue
    }
    // trailing comment mid-line
    if ((ch === '/' && line[i + 1] === '/' && (language === 'ts' || language === 'js' || language === 'go' || language === 'rust')) || (ch === '#' && (language === 'py' || language === 'sh'))) {
      flushPlain()
      segments.push({ text: line.slice(i), color: palette.muted })
      i = line.length
      continue
    }
    // numbers
    const num = /^(?:0x[0-9a-fA-F]+|\d[\d_]*\.?\d*(?:e[+-]?\d+)?)/.exec(rest)
    if (num && !/[A-Za-z_]/.test(line[i - 1] ?? '')) {
      flushPlain()
      segments.push({ text: num[0], color: palette.muted })
      i += num[0].length
      continue
    }
    // identifiers / keywords
    const word = /^[A-Za-z_$][\w$]*/.exec(rest)
    if (word) {
      if (keywords.has(word[0])) {
        flushPlain()
        segments.push({ text: word[0], bold: true })
      } else {
        plain += word[0]
      }
      i += word[0].length
      continue
    }
    plain += ch
    i += 1
  }
  flushPlain()
  return segments.length > 0 ? segments : [{ text: line }]
}

function findStringEnd(line: string, start: number, quote: string): number {
  let i = start + 1
  while (i < line.length) {
    if (line[i] === '\\') {
      i += 2
      continue
    }
    if (line[i] === quote) return i + 1
    i += 1
  }
  return line.length // unterminated — colour to end of line
}
