// When edit_file's exact-substring match fails, a bare "old_string not found"
// leaves the model retrying blind — the loop we watched burn a dozen turns on a
// stylesheet. These helpers turn a failed match into a message the model can act
// on: where the closest text actually is, what its real indentation looks like,
// or every location a non-unique string occurs.

const NON_TRIVIAL = /\S/

function normalizeWs(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** 1-indexed line number containing byte offset `index`. */
export function lineAt(text: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < text.length; i += 1) if (text[i] === '\n') line += 1
  return line
}

/** Numbered lines `line-radius`‥`line+radius` (1-indexed, clamped), for showing context. */
export function numberedSnippet(text: string, line: number, radius = 3): string {
  const lines = text.split('\n')
  const start = Math.max(1, line - radius)
  const end = Math.min(lines.length, line + radius)
  const out: string[] = []
  for (let n = start; n <= end; n += 1) out.push(`${n === line ? '›' : ' '} ${n}\t${lines[n - 1]}`)
  return out.join('\n')
}

/** Every start offset where `needle` occurs verbatim. */
export function allMatches(text: string, needle: string): number[] {
  const hits: number[] = []
  let from = 0
  for (;;) {
    const at = text.indexOf(needle, from)
    if (at === -1) break
    hits.push(at)
    from = at + Math.max(1, needle.length)
  }
  return hits
}

/**
 * Slides a window the height of `needle` down the file and returns the best
 * whitespace-insensitive matches — so "your text is here, but the indentation
 * differs" becomes visible.
 */
export function closestRegions(text: string, needle: string, k = 2): { line: number; score: number }[] {
  const fileLines = text.split('\n')
  const needleLines = needle.replace(/\n+$/, '').split('\n')
  const height = Math.max(1, needleLines.length)
  const target = needleLines.map(normalizeWs).filter((l) => l.length > 0)
  if (target.length === 0) return []

  const scored: { line: number; score: number }[] = []
  for (let i = 0; i + height <= fileLines.length + height - 1 && i < fileLines.length; i += 1) {
    const window = fileLines.slice(i, i + height).map(normalizeWs)
    let hits = 0
    for (const t of target) if (window.some((w) => w === t || (w.length > 8 && (w.includes(t) || t.includes(w))))) hits += 1
    const score = hits / target.length
    if (score >= 0.5) scored.push({ line: i + 1, score })
  }
  scored.sort((a, b) => b.score - a.score || a.line - b.line)
  const seen = new Set<number>()
  const out: { line: number; score: number }[] = []
  for (const s of scored) {
    if (out.some((o) => Math.abs(o.line - s.line) < height)) continue
    if (seen.has(s.line)) continue
    seen.add(s.line)
    out.push(s)
    if (out.length >= k) break
  }
  return out
}

/** Message for the "not found" case: normalized-match hint + closest regions. */
export function notFoundMessage(text: string, needle: string, path: string): string {
  const parts: string[] = [`old_string not found in ${path}.`]

  const normFile = normalizeWs(text)
  const normNeedle = normalizeWs(needle)
  const normCount = normNeedle ? allMatches(normFile, normNeedle).length : 0

  if (normCount === 1) {
    parts.push('The text IS in the file but the whitespace/indentation differs. Copy old_string from a fresh read_file so it matches byte-for-byte (tabs vs spaces, trailing spaces, blank lines).')
  } else if (normCount > 1) {
    parts.push(`Ignoring whitespace, that text appears ${normCount} times — add surrounding lines to old_string to make it unique, and match the file's real indentation.`)
  }

  const regions = closestRegions(text, needle, 2)
  if (regions.length > 0) {
    parts.push('Closest match' + (regions.length > 1 ? 'es' : '') + ' in the current file:')
    for (const region of regions) parts.push(numberedSnippet(text, region.line, 3))
  } else if (normCount === 0) {
    const firstLine = needle.split('\n').find((l) => NON_TRIVIAL.test(l))?.trim()
    parts.push(
      firstLine
        ? `Nothing resembling "${firstLine.slice(0, 80)}" is in the file. It may already have been changed — read_file again before editing.`
        : 'It may already have been changed — read_file again before editing.',
    )
  }
  return parts.join('\n')
}

/** Message for the "matches multiple locations" case: list every hit, one per distinct line. */
export function multipleMatchMessage(text: string, needle: string, path: string): string {
  const hits = allMatches(text, needle)
  const lines = [...new Set(hits.map((at) => lineAt(text, at)))]
  const parts = [
    `old_string matches ${hits.length} location${hits.length === 1 ? '' : 's'} in ${path} (line${lines.length === 1 ? '' : 's'} ${lines.slice(0, 10).join(', ')}). Add lines above or below it so it appears exactly once. Occurrences:`,
  ]
  for (const line of lines.slice(0, 6)) parts.push(numberedSnippet(text, line, 2))
  if (lines.length > 6) parts.push(`… and ${lines.length - 6} more`)
  return parts.join('\n')
}
