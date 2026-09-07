import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { paths } from '../config.ts'

const MAX_DEPTH = 4
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.output', 'coverage'])

interface Candidate {
  path: string
  mtimeMs: number
  depth: number
  isIndex: boolean
}

/**
 * The best HTML file under `workspace/` that was written since `since`.
 *
 * Used to offer a live preview automatically after a turn that scaffolded a
 * static site — including a ChatGPT-subscription turn, whose file writes never
 * pass through Elia's own edit tools and so aren't in the turn's file tracker.
 * Prefers a fresher file, then an `index.html`, then a shallower path.
 */
export function findFreshPreviewTarget(since: number, root: string = paths.workspace): string | undefined {
  const found: Candidate[] = []

  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full, depth + 1)
        continue
      }
      if (!/\.html?$/i.test(entry.name)) continue
      try {
        const stat = statSync(full)
        if (stat.mtimeMs >= since) {
          found.push({ path: full, mtimeMs: stat.mtimeMs, depth, isIndex: /^index\.html?$/i.test(entry.name) })
        }
      } catch {
        // Raced away between readdir and stat — ignore.
      }
    }
  }

  walk(root, 0)
  if (found.length === 0) return undefined

  found.sort((a, b) => {
    // Freshest first (within a 3s window treat as equal so index.html wins).
    if (Math.abs(a.mtimeMs - b.mtimeMs) > 3_000) return b.mtimeMs - a.mtimeMs
    if (a.isIndex !== b.isIndex) return a.isIndex ? -1 : 1
    return a.depth - b.depth
  })
  return found[0]!.path
}
