// When the model emits a tool_use block naming a tool that doesn't exist
// (`print_tree`, `search`, `bash`, …), a bare "Unknown tool" leaves it guessing.
// This turns the miss into a pointer at the real name — the loop we watched
// burned ~13s recovering from one hallucinated `print_tree` call.

/** Classic Levenshtein edit distance, iterative two-row. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  let curr = new Array<number>(b.length + 1)
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost)
    }
    ;[prev, curr] = [curr, prev]
  }
  return prev[b.length]!
}

/**
 * The single closest real tool name to `wanted`, or `undefined` when nothing is
 * close enough to be worth suggesting. Also matches on substring containment
 * (`tree` → `list_files` won't, but `read` → `read_file` will) so a plausible
 * near-miss is caught even when the edit distance is large.
 */
export function suggestToolName(wanted: string, names: readonly string[]): string | undefined {
  const w = wanted.toLowerCase()
  let best: { name: string; score: number } | undefined
  for (const name of names) {
    const n = name.toLowerCase()
    const dist = editDistance(w, n)
    // Accept up to ~40% of the longer string as edits, or a clean word overlap.
    const tolerance = Math.max(2, Math.floor(Math.max(w.length, n.length) * 0.4))
    const overlaps = (w.length >= 4 && n.includes(w)) || (n.length >= 4 && w.includes(n))
    if (dist <= tolerance || overlaps) {
      const score = overlaps ? dist - 3 : dist
      if (!best || score < best.score) best = { name, score }
    }
  }
  return best?.name
}

/** The full "no such tool" message handed back as a tool_result. */
export function unknownToolMessage(wanted: string, names: readonly string[]): string {
  const suggestion = suggestToolName(wanted, names)
  const sorted = [...names].sort()
  return (
    `No tool named "${wanted}" is available.` +
    (suggestion ? ` Did you mean "${suggestion}"?` : '') +
    `\nUse one of these exact names: ${sorted.join(', ')}.`
  )
}
