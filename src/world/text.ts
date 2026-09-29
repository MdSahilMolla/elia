/**
 * Telling a wording edit from a logic edit, without a parser.
 *
 * The twin can predict what an edit does to the fixed prompt every call sends,
 * exactly, because that is arithmetic on text. It cannot predict what an edit
 * to logic does — a changed loop can take fewer steps or more — so the two
 * are priced differently, and the price is the whole point: an edit that only
 * rewords a prompt or a tool description is priced tightly, and one that
 * touches control flow is priced as a gamble.
 *
 * "Only rewords" means: once every comment and the inside of every string is
 * blanked, the two files are the same program. Anything this lexer is unsure
 * of is reported as *not* text-only — it returns undefined, and the caller
 * treats that as logic. A wrong "logic" costs a benchmark run that a cheaper
 * screen could have skipped; a wrong "text" would let a logic edit be priced
 * as a wording edit, so every ambiguity resolves the expensive way.
 *
 * Deliberately conservative in three places:
 *   - `from '…'`, `import '…'` and `require('…')` keep their string, since
 *     changing which module is loaded is not a rewording;
 *   - a regular expression keeps its source, since changing what it matches is
 *     not either, and `/` is read as a regex only where a division cannot be;
 *   - an unterminated string, comment or template is a failure to lex.
 */

const WORD = /[A-Za-z0-9_$]/
/** Characters after which a `/` begins a regular expression, never a division. */
const REGEX_CAN_FOLLOW = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', ';', '*', '%', '<', '>', '~', '^'])
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'case', 'throw', 'in', 'of', 'delete', 'void', 'yield', 'await'])

interface Cursor {
  src: string
  i: number
}

/** Lexes one template literal body (after the opening backtick), blanking its text and lexing `${…}` as code. */
function lexTemplate(cursor: Cursor, out: string[]): boolean {
  out.push('`')
  while (cursor.i < cursor.src.length) {
    const ch = cursor.src[cursor.i]!
    if (ch === '\\') {
      cursor.i += 2
      continue
    }
    if (ch === '`') {
      cursor.i += 1
      out.push('`')
      return true
    }
    if (ch === '$' && cursor.src[cursor.i + 1] === '{') {
      cursor.i += 2
      out.push('${')
      if (!lexCode(cursor, out, true)) return false
      out.push('}')
      continue
    }
    cursor.i += 1
  }
  return false
}

/** Lexes code until the end, or — inside a `${` — until its closing brace. Undefined-equivalent is `false`. */
function lexCode(cursor: Cursor, out: string[], insideTemplate: boolean): boolean {
  let depth = 0
  const { src } = cursor
  const previousSignificant = (): string | undefined => out[out.length - 1]

  while (cursor.i < src.length) {
    const ch = src[cursor.i]!

    if (/\s/.test(ch)) {
      cursor.i += 1
      continue
    }

    if (ch === '/' && src[cursor.i + 1] === '/') {
      const end = src.indexOf('\n', cursor.i)
      cursor.i = end === -1 ? src.length : end + 1
      continue
    }
    if (ch === '/' && src[cursor.i + 1] === '*') {
      const end = src.indexOf('*/', cursor.i + 2)
      if (end === -1) return false
      cursor.i = end + 2
      continue
    }

    if (ch === '"' || ch === "'") {
      const start = cursor.i
      cursor.i += 1
      while (cursor.i < src.length && src[cursor.i] !== ch) {
        if (src[cursor.i] === '\n') return false
        cursor.i += src[cursor.i] === '\\' ? 2 : 1
      }
      if (cursor.i >= src.length) return false
      cursor.i += 1
      const before = previousSignificant()
      const two = out[out.length - 2]
      // A module specifier decides what runs, so it is code, not wording.
      const isSpecifier = before === 'from' || before === 'import' || (before === '(' && (two === 'require' || two === 'import'))
      out.push(isSpecifier ? src.slice(start, cursor.i) : ch + ch)
      continue
    }

    if (ch === '`') {
      cursor.i += 1
      if (!lexTemplate(cursor, out)) return false
      continue
    }

    if (ch === '/') {
      const before = previousSignificant()
      const regexAllowed = before === undefined || REGEX_CAN_FOLLOW.has(before) || REGEX_AFTER_WORD.has(before)
      if (regexAllowed) {
        const start = cursor.i
        cursor.i += 1
        let inClass = false
        while (cursor.i < src.length) {
          const c = src[cursor.i]!
          if (c === '\n') return false
          if (c === '\\') {
            cursor.i += 2
            continue
          }
          if (c === '[') inClass = true
          else if (c === ']') inClass = false
          else if (c === '/' && !inClass) break
          cursor.i += 1
        }
        if (cursor.i >= src.length) return false
        cursor.i += 1
        while (cursor.i < src.length && /[a-z]/.test(src[cursor.i]!)) cursor.i += 1
        out.push(src.slice(start, cursor.i))
        continue
      }
    }

    if (WORD.test(ch)) {
      const start = cursor.i
      while (cursor.i < src.length && WORD.test(src[cursor.i]!)) cursor.i += 1
      out.push(src.slice(start, cursor.i))
      continue
    }

    if (insideTemplate) {
      if (ch === '{') depth += 1
      else if (ch === '}') {
        if (depth === 0) {
          cursor.i += 1
          return true
        }
        depth -= 1
      }
    }
    out.push(ch)
    cursor.i += 1
  }
  return !insideTemplate
}

/** The file as a token stream with comments and string text blanked, or undefined when it cannot be read safely. */
export function maskText(source: string): string | undefined {
  const out: string[] = []
  return lexCode({ src: source, i: 0 }, out, false) ? out.join(' ') : undefined
}

/**
 * True when `after` differs from `before` only inside comments and string or
 * template text. False for any logic change, for identical files, and for any
 * file this cannot read with confidence.
 */
export function isTextOnlyEdit(before: string, after: string): boolean {
  if (before === after) return false
  const a = maskText(before)
  const b = maskText(after)
  return a !== undefined && b !== undefined && a === b
}
