// Architecture configuration: explicit layers, rules, and boundary definitions.
//
// The configuration file may be `arch.json`, `.arch.json`, or `arch.config.json`
// in the project root, or an `architecture` key in `package.json`. Explicit
// configuration always overrides inferred structure; anything not explicitly
// configured is reported as inference, never as fact.

import { readFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { normalizePath } from './parser.ts'

/** A named layer with path globs that place modules in it. */
export interface LayerDef {
  name: string
  include: string[]
  /** When set, only files matching these globs may be imported cross-layer. */
  publicApi?: string[]
}

/** A directed rule between two path globs. */
export interface ImportRule {
  from: string
  to: string
  reason?: string
}

/** A pair describing an abstraction its implementations must honor. */
export interface DependencyInversionPair {
  /** Glob selecting the abstraction (interface) file(s). */
  interface: string
  /** Glob selecting the implementation file(s). */
  implementation: string
}

/** A self-contained package that communicates through a public API. */
export interface PackageDef {
  name: string
  include: string[]
  /** Files importable from outside the package; defaults to everything. */
  publicApi?: string[]
}

export interface ArchitectureConfig {
  version?: number
  /** Abstract-to-concrete order; matches prevent downward dependencies only. */
  layers?: LayerDef[]
  direction?: 'downward'
  forbiddenImports?: ImportRule[]
  allowedImports?: ImportRule[]
  /** Dependency inversion pairs honored via explicit configuration. */
  dependencyInversion?: DependencyInversionPair[]
  packages?: PackageDef[]
  /** Exempt files (entry points, scripts, build artifacts). */
  exempt?: string[]
  /** Longest dependency chain (in hops) allowed before flagging. */
  maxChainDepth?: number
  /** Preserve the legacy convention that `lib/**` may not import `app/**`. */
  legacyLibAppRule?: boolean
}

export interface LoadedConfig {
  config: ArchitectureConfig
  /** Where the configuration was read from ('' when none). */
  source: string
}

const CONFIG_FILES = ['arch.json', '.arch.json', 'arch.config.json']

/** Load architecture configuration for a project. Returns an empty config. */
export function loadArchitectureConfig(projectRoot: string, explicitPath?: string): LoadedConfig {
  const root = normalizePath(projectRoot)
  if (explicitPath) {
    const file = explicitPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(explicitPath) ? normalizePath(explicitPath) : root + '/' + explicitPath
    return { config: readConfigFile(file), source: file }
  }
  for (const name of CONFIG_FILES) {
    const file = root + '/' + name
    if (existsSync(file)) return { config: readConfigFile(file), source: file }
  }
  const pkgPath = root + '/package.json'
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { architecture?: ArchitectureConfig }
      if (pkg.architecture) return { config: pkg.architecture, source: pkgPath }
    } catch {
      // ignore malformed package.json; fall through to defaults
    }
  }
  return { config: {}, source: '' }
}

function readConfigFile(file: string): ArchitectureConfig {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`Architecture config ${file} is not valid JSON: ${String((err as Error).message)}`)
  }
  const config = (parsed as { architecture?: ArchitectureConfig }).architecture ?? (parsed as ArchitectureConfig)
  validateConfig(file, config)
  return config
}

function validateConfig(file: string, config: ArchitectureConfig): void {
  const layers = config.layers
  if (layers) {
    const seen = new Set<string>()
    for (const layer of layers) {
      if (!layer.name || typeof layer.name !== 'string') throw new Error(`${file}: each layer needs a name`)
      if (seen.has(layer.name)) throw new Error(`${file}: duplicate layer name "${layer.name}"`)
      seen.add(layer.name)
      if (!Array.isArray(layer.include) || layer.include.length === 0) {
        throw new Error(`${file}: layer "${layer.name}" needs a non-empty include list`)
      }
    }
  }
  if (config.direction && config.direction !== 'downward') {
    throw new Error(`${file}: direction must be "downward" when set`)
  }
  for (const rule of config.forbiddenImports ?? []) {
    if (!rule.from || !rule.to) throw new Error(`${file}: forbiddenImports entries need both from and to`)
  }
  for (const pair of config.dependencyInversion ?? []) {
    if (!pair.interface || !pair.implementation) {
      throw new Error(`${file}: dependencyInversion entries need both interface and implementation`)
    }
  }
}

/**
 * Compile a simple path pattern (supporting `**`, `*`, `?`) into a RegExp,
 * matched against posix-relative module paths.
 */
export function compilePattern(pattern: string): RegExp {
  let p = normalizePath(pattern)
  if (p.endsWith('/')) p += '**'
  let re = ''
  let i = 0
  while (i < p.length) {
    const ch = p[i]!
    if (p.startsWith('**', i)) {
      re += '.*'
      i += 2
      continue
    }
    if (ch === '*') {
      re += '[^/]*'
    } else if (ch === '?') {
      re += '[^/]'
    } else if ('.+^$[]{}()|\\'.includes(ch)) {
      re += '\\' + ch
    } else {
      re += ch
    }
    i++
  }
  return new RegExp('^' + re + '$')
}

/** True when a relative path matches at least one pattern. */
export function matchesAny(relativePath: string, patterns: string[] | undefined): boolean {
  if (!patterns || patterns.length === 0) return false
  return patterns.some((p) => compilePattern(p).test(relativePath))
}

/** The basename of a relative path without its extension. */
export function basenameNoExt(relativePath: string): string {
  const base = relativePath.slice(relativePath.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(0, dot) : base
}