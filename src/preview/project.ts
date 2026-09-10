import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Frameworks whose `index.html` is a *source* entry that a plain static file
 * server cannot serve — it references TS/TSX modules the bundler has to
 * transform. Finding such an `index.html` on disk does NOT mean the app is
 * previewable as-is. */
export const BUNDLER = /\b(vite|webpack|parcel|rollup|esbuild|@vitejs|next|@remix-run|astro|@sveltejs|react-scripts)\b/

export type PackageRunner = 'bun' | 'npm' | 'pnpm' | 'yarn'

export interface ProjectInfo {
  dir: string
  runner: PackageRunner
  hasBuildScript: boolean
  hasDevScript: boolean
  /** The literal `dev` script's command, if present. */
  devScript?: string
  usesBundler: boolean
}

/** Walks up from a file (or directory) looking for the nearest `package.json`. */
export function findProject(fileOrDir: string): ProjectInfo | undefined {
  let dir = existsSync(fileOrDir) && !/\.[a-z0-9]+$/i.test(fileOrDir) ? fileOrDir : dirname(fileOrDir)
  for (let i = 0; i < 8; i += 1) {
    const pkgPath = join(dir, 'package.json')
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
          scripts?: Record<string, string>
          dependencies?: Record<string, string>
          devDependencies?: Record<string, string>
        }
        const deps = JSON.stringify({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.scripts })
        return {
          dir,
          runner: existsSync(join(dir, 'bun.lock')) || existsSync(join(dir, 'bun.lockb'))
            ? 'bun'
            : existsSync(join(dir, 'pnpm-lock.yaml'))
              ? 'pnpm'
              : existsSync(join(dir, 'yarn.lock'))
                ? 'yarn'
                : 'npm',
          hasBuildScript: Boolean(pkg.scripts?.build),
          hasDevScript: Boolean(pkg.scripts?.dev || pkg.scripts?.start),
          devScript: pkg.scripts?.dev ?? pkg.scripts?.start,
          usesBundler: BUNDLER.test(deps),
        }
      } catch {
        return undefined
      }
    }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}

/** An already-built output directory containing an `index.html`, if any. */
export function pickBuildOutput(projectDir: string): string | undefined {
  for (const name of ['dist', 'build', 'out', '.output/public', '.next']) {
    const candidate = join(projectDir, name)
    if (existsSync(join(candidate, 'index.html'))) return candidate
  }
  return undefined
}

/**
 * Whether an on-disk HTML file is a bundler *source* entry (references
 * `type="module"` scripts pointing at raw source paths) rather than a
 * self-contained page a static server can serve directly.
 */
export function isUnbuiltModuleEntry(htmlPath: string): boolean {
  let html: string
  try {
    html = readFileSync(htmlPath, 'utf8')
  } catch {
    return false
  }
  // A bundled page points at hashed asset files (/assets/index-abc123.js); a
  // source page points straight at .ts/.tsx/.jsx or /src/… and has no built
  // bundle reference.
  const referencesSource = /<script[^>]+type=["']module["'][^>]+src=["'][^"']*(?:\/src\/|\.tsx?|\.jsx)["']/i.test(html)
    || /<script[^>]+src=["']\/@vite\//i.test(html)
  const referencesBundle = /<script[^>]+src=["'][^"']*\/assets\/[^"']+\.js["']/i.test(html)
  return referencesSource && !referencesBundle
}
