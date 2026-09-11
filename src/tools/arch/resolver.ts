// Module specifier resolution: map a raw import/export specifier to a file on
// disk. Supports relative paths, absolute paths, tsconfig `paths` aliases (from
// the tsconfig `extends` chain), and falls back to external (bare specifier) or
// unresolved.

import { dirname, isAbsolute } from 'node:path'
import { readFileSync, statSync } from 'node:fs'
import type { RawImport } from './types.ts'
import { normalizePath, joinPath } from './parser.ts'

export type ResolveStatus = 'file' | 'external' | 'unresolved'

export interface ResolveResult {
  status: ResolveStatus
  /** Resolved absolute path when status is 'file'. */
  path?: string
  /** Normalized specifier when status is 'external'. */
  externalSpecifier?: string
}

/** Options that influence resolution. */
export interface ResolveOptions {
  /** Absolute project root (posix-normalized). */
  projectRoot: string
  /** tsconfig `paths` entries (from the extends chain), keyed by pattern. */
  paths?: Record<string, string[]>
  /** tsconfig `baseUrl` (posix-normalized). */
  baseUrl?: string
}

/** Candidate extensions tried in order when the literal path does not exist. */
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.d.ts']

function isRelative(spec: string): boolean {
  return spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..'
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function tryFile(base: string): string | undefined {
  if (isFile(base)) return normalizePath(base)
  for (const ext of EXTENSIONS) {
    if (isFile(base + ext)) return normalizePath(base + ext)
  }
  return undefined
}

/** Try `<base>` as a directory with an index file. */
function tryIndex(base: string): string | undefined {
  let isDir = false
  try {
    isDir = statSync(base).isDirectory()
  } catch {
    return undefined
  }
  if (!isDir) return undefined
  for (const ext of EXTENSIONS) {
    const candidate = joinPath(base, 'index' + ext)
    if (isFile(candidate)) return candidate
  }
  return undefined
}

function absoluteCandidate(raw: string): string | undefined {
  return tryFile(normalizePath(raw)) ?? tryIndex(normalizePath(raw))
}

/**
 * Load tsconfig `paths` and `baseUrl` by walking the `extends` chain from the
 * given config file. Distant package extends (e.g. `@tsconfig/bun`) are not
 * followed — only file-relative `extends`.
 */
export function loadTsconfigAliases(tsconfigFile: string): { paths?: Record<string, string[]>; baseUrl?: string } {
  const result: { paths?: Record<string, string[]>; baseUrl?: string } = {}
  const seen = new Set<string>()
  let current = normalizePath(tsconfigFile)

  while (current) {
    if (seen.has(current)) break
    seen.add(current)
    let cfg: Record<string, unknown>
    try {
      cfg = JSON.parse(readFileSync(current, 'utf8')) as Record<string, unknown>
    } catch {
      break
    }
    const compilerOptions = cfg.compilerOptions as Record<string, unknown> | undefined
    if (!result.baseUrl && compilerOptions?.baseUrl) {
      result.baseUrl = normalizePath(String(compilerOptions.baseUrl))
    }
    if (!result.paths && compilerOptions?.paths) {
      const raw = compilerOptions.paths as Record<string, unknown>
      const out: Record<string, string[]> = {}
      for (const [key, value] of Object.entries(raw)) {
        if (Array.isArray(value)) out[key] = value.map((v) => normalizePath(String(v)))
      }
      if (Object.keys(out).length > 0) result.paths = out
    }
    const parent = cfg.extends
    if (typeof parent !== 'string' || parent.length === 0) break
    if (parent.startsWith('.')) {
      current = normalizePath(dirname(current)) + '/' + normalizePath(parent)
    } else {
      break
    }
  }
  return result
}

/**
 * Match a tsconfig `paths` pattern (support for a single `*` wildcard) against
 * a specifier. Returns the captured wildcard text or null when it has no match.
 */
function matchPathPattern(spec: string, pattern: string): string | null {
  const star = pattern.indexOf('*')
  if (star === -1) return spec === pattern ? '' : null
  const prefix = pattern.slice(0, star)
  const suffix = pattern.slice(star + 1)
  if (!spec.startsWith(prefix) || !spec.endsWith(suffix)) return null
  return spec.slice(prefix.length, spec.length - suffix.length)
}

/** Resolve a raw module specifier relative to the importing file. */
export function resolveSpecifier(sourceFile: string, specifier: string, options: ResolveOptions): ResolveResult {
  const raw = specifier.trim()
  if (raw.length === 0) return { status: 'unresolved' }

  if (isRelative(raw)) {
    const base = normalizePath(dirname(sourceFile))
    const candidate = tryFile(joinPath(base, raw)) ?? tryIndex(joinPath(base, raw))
    if (candidate) return { status: 'file', path: candidate }
    return { status: 'unresolved' }
  }

  if (isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw)) {
    const candidate = absoluteCandidate(raw)
    if (candidate) return { status: 'file', path: candidate }
    return { status: 'unresolved' }
  }

  if (options.paths) {
    for (const [pattern, targets] of Object.entries(options.paths)) {
      const wildcard = matchPathPattern(raw, pattern)
      if (wildcard === null) continue
      for (const target of targets) {
        const replaced = target.includes('*') ? target.replace('*', wildcard ?? '') : target
        const base = options.baseUrl ? joinPath(options.projectRoot, options.baseUrl) : options.projectRoot
        const candidate = tryFile(joinPath(base, replaced))
        if (candidate) return { status: 'file', path: candidate }
      }
    }
  }

  // Anything else is a bare specifier: a node_modules dependency.
  return { status: 'external', externalSpecifier: raw }
}

/** Resolve all raw imports of a file against its own directory. */
export function resolveRawImports(
  sourceFile: string,
  projectRoot: string,
  paths?: Record<string, string[]>,
  baseUrl?: string,
): (raw: RawImport) => ResolveResult {
  return (raw: RawImport) => resolveSpecifier(sourceFile, raw.specifier, { projectRoot, paths, baseUrl })
}