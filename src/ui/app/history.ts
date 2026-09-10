import { existsSync, readFileSync, appendFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { paths } from '../../statePaths.ts'

/**
 * Persistent prompt history for the interactive REPL. The slashPrompt reducer
 * already walks an in-memory `history` array with ↑/↓; this backs it with a file
 * so the last session's prompts are there when you relaunch, and `Ctrl+R` has
 * something to search. Kept deliberately dumb — a newline-delimited file, newest
 * last, capped. Never throws: a missing or unreadable file just means no history.
 */

const MAX_ENTRIES = 500

export function loadHistory(path = paths.promptHistory): string[] {
  try {
    if (!existsSync(path)) return []
    return readFileSync(path, 'utf8')
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0)
      .slice(-MAX_ENTRIES)
  } catch {
    return []
  }
}

/** Append one submitted line. Skips blanks, slash/shell commands, and an immediate repeat. */
export function appendHistory(line: string, path = paths.promptHistory): void {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('/') || trimmed.startsWith('!')) return
  try {
    const existing = loadHistory(path)
    if (existing[existing.length - 1] === trimmed) return
    mkdirSync(dirname(path), { recursive: true })
    if (existing.length >= MAX_ENTRIES) {
      // Rewrite to keep the file bounded rather than growing forever.
      writeFileSync(path, [...existing.slice(-(MAX_ENTRIES - 1)), trimmed].join('\n') + '\n')
    } else {
      appendFileSync(path, trimmed + '\n')
    }
  } catch {
    // Losing a history line is cosmetic.
  }
}

/**
 * Reverse-search: the most recent entries whose text contains `query`
 * (case-insensitive), newest first, deduped, capped for the overlay.
 */
export function searchHistory(query: string, history: string[], limit = 8): string[] {
  const needle = query.toLowerCase().trim()
  if (!needle) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (let i = history.length - 1; i >= 0 && out.length < limit; i -= 1) {
    const entry = history[i]!
    if (seen.has(entry) || !entry.toLowerCase().includes(needle)) continue
    seen.add(entry)
    out.push(entry)
  }
  return out
}
