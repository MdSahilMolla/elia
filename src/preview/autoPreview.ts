import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'
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
 * The best HTML file this turn produced.
 *
 * Looks at what the turn actually wrote first, then falls back to scanning
 * `workspace/`. The scan alone was not enough: it only ever walked
 * `paths.workspace`, so a site written anywhere else — `portfolio-demo/`,
 * `nikhil-website/`, the repo root — was invisible, and the turn reported
 * nothing for a page that existed on disk. The written-file list is also what
 * makes the *right* page win when a turn touches several.
 *
 * `written` comes from the turn's file tracker (see checkpoint.ts). It is
 * optional because a ChatGPT-subscription turn writes files without going
 * through Elia's edit tools and so contributes nothing to the tracker — those
 * turns still rely on the workspace scan.
 *
 * Prefers a fresher file, then an `index.html`, then a shallower path.
 */
export function findFreshPreviewTarget(
  since: number,
  root: string = paths.workspace,
  written: string[] = [],
): string | undefined {
  const found: Candidate[] = []
  const seen = new Set<string>()

  const consider = (full: string, depth: number): void => {
    const key = resolve(full).toLowerCase()
    if (seen.has(key)) return
    try {
      const stat = statSync(full)
      if (!stat.isFile() || stat.mtimeMs < since) return
      seen.add(key)
      found.push({ path: full, mtimeMs: stat.mtimeMs, depth, isIndex: /^index\.html?$/i.test(basename(full)) })
    } catch {
      // Raced away, or never existed — ignore.
    }
  }

  // What this turn wrote, wherever it wrote it. Depth 0 so a written file
  // outranks an equally fresh one merely found by the scan.
  for (const path of written) {
    if (!/\.html?$/i.test(path)) continue
    const full = isAbsolute(path) ? path : resolve(process.cwd(), path)
    if (existsSync(full)) consider(full, 0)
  }

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
      consider(full, depth + 1)
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
