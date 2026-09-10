import { isIgnored } from '../../tools/ignoreDirs.ts'

/**
 * `@`-mention file completion for the REPL input. The repo file list is built
 * once, lazily, on the first `@` and cached for the session (a REPL that outlives
 * a big refactor is rare, and a stale entry just fails to insert). Matching is a
 * cheap substring-then-subsequence rank — no fuzzy-match dependency.
 */

let cache: string[] | undefined
let building: Promise<string[]> | undefined

const MAX_FILES = 5_000

async function buildIndex(cwd: string): Promise<string[]> {
  const out: string[] = []
  try {
    const glob = new Bun.Glob('**/*')
    for await (const path of glob.scan({ cwd, dot: false, onlyFiles: true })) {
      const normalized = path.replace(/\\/g, '/')
      if (isIgnored(normalized)) continue
      // elia scaffolds throwaway projects under workspace/; not useful to @-ref.
      if (normalized.startsWith('workspace/') || normalized.startsWith('coverage/')) continue
      out.push(normalized)
      if (out.length >= MAX_FILES) break
    }
  } catch {
    // An unreadable tree just means no completions.
  }
  out.sort()
  return out
}

/** Kick off (or reuse) the index build. Safe to call on every `@` keystroke. */
export function primeFileIndex(cwd = process.cwd()): void {
  if (cache || building) return
  building = buildIndex(cwd).then((files) => {
    cache = files
    building = undefined
    return files
  })
}

export function fileIndexReady(): boolean {
  return cache !== undefined
}

/** Invalidate after a write so a newly-created file can be @-referenced. */
export function resetFileIndex(): void {
  cache = undefined
  building = undefined
}

function score(path: string, query: string): number {
  const p = path.toLowerCase()
  const q = query.toLowerCase()
  if (!q) return 1
  const base = p.slice(p.lastIndexOf('/') + 1)
  if (base.startsWith(q)) return 1000 - path.length
  const idx = p.indexOf(q)
  if (idx >= 0) return 500 - idx - path.length * 0.01
  // subsequence
  let qi = 0
  for (let i = 0; i < p.length && qi < q.length; i += 1) if (p[i] === q[qi]) qi += 1
  return qi === q.length ? 100 - path.length * 0.01 : -1
}

/**
 * Completions for the token after `@`. Returns [] until the index has finished
 * building (the caller shows a "indexing…" hint meanwhile).
 */
export function completeFile(query: string, limit = 8): string[] {
  if (!cache) return []
  return cache
    .map((path) => ({ path, s: score(path, query) }))
    .filter((entry) => entry.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((entry) => entry.path)
}

/** The `@token` under the cursor, if the buffer has an open @-mention there. */
export function activeMention(buffer: string, cursor: number): { start: number; query: string } | null {
  const upto = buffer.slice(0, cursor)
  const at = upto.lastIndexOf('@')
  if (at < 0) return null
  // Must be at start or preceded by whitespace, and contain no whitespace since.
  if (at > 0 && !/\s/.test(buffer[at - 1]!)) return null
  const query = upto.slice(at + 1)
  if (/\s/.test(query)) return null
  return { start: at, query }
}
