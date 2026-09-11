// Shared codebase model: one deterministic, reusable view of the project.
//
// The lifecycle tools must not each scan and reconstruct the same project
// knowledge independently. This module centralizes the lightweight shared view:
// files, imports, exports, exported symbols, tests, configs, schemas, security
// surfaces, API surfaces, and external dependencies.
//
// It is deliberately lighter than the arch engine's AST-grade analysis: it is a
// cheap, deterministic index that prediction/planning tools can rely on without
// opening a TypeScript program. Deep dependency-graph analysis stays in the
// arch engine and reuses this model where it helps.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, extname, join, resolve, relative } from 'node:path'

export type CodeLanguage =
  | 'typescript'
  | 'javascript'
  | 'json'
  | 'yaml'
  | 'toml'
  | 'prisma'
  | 'sql'
  | 'go'
  | 'rust'
  | 'css'
  | 'html'
  | 'markdown'
  | 'other'

export type SymbolKind = 'function' | 'class' | 'interface' | 'type' | 'enum' | 'const' | 'default'

export interface CodebaseSymbol {
  name: string
  kind: SymbolKind
  /** 1-based line of the declaration. */
  line: number
  exported: boolean
}

export interface CodebaseFile {
  /** Posix, repo-relative path. */
  path: string
  absolutePath: string
  language: CodeLanguage
  lineCount: number
  sizeBytes: number
  isTest: boolean
  isConfig: boolean
  isSchema: boolean
  securitySurface: boolean
  apiSurface: boolean
  /** Raw module specifiers this file imports. */
  imports: string[]
  /** Names exported; 'default' for default exports. */
  exports: string[]
  symbols: CodebaseSymbol[]
}

export interface CodebaseDependency {
  name: string
  version: string
  kind: 'runtime' | 'dev' | 'peer' | 'optional'
  /** Loaded successfully from a manifest. */
  present: boolean
}

export interface CodebaseScm {
  type: 'git' | 'unknown'
  branch?: string
}

export interface CodebaseModel {
  root: string
  generatedAtMs: number
  files: CodebaseFile[]
  dependencies: CodebaseDependency[]
  testFiles: string[]
  configFiles: string[]
  schemaFiles: string[]
  securitySurfaceFiles: string[]
  apiSurfaceFiles: string[]
  scm: CodebaseScm
  /** True when the maximum file cap was reached. */
  truncated: boolean
}

export interface IndexOptions {
  maxFiles?: number
  ignoreDirs?: string[]
  /** Only index files whose repo-relative path starts with one of these dirs/files. */
  only?: string[]
}

const DEFAULT_IGNORE = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.cache',
  '.turbo',
  '.venv',
  'venv',
  '.tox',
  'target',
  '.cargo',
  '.rustup',
  '.elia',
  '.opencode',
  '.idea',
  '.vscode',
  '.terraform',
  '__pycache__',
  'vendor',
  'third_party',
  'raw',
  'tmp',
])

const CODE_EXTENSIONS = new Set(['ts', 'tsx', 'js', 'jsx', 'mts', 'cts', 'mjs', 'cjs'])
const SCHEMA_EXTENSIONS = new Set(['prisma', 'sql', 'graphql', 'gql'])

const SECURITY_SEGMENTS = /authoriz|authenticat|security|token|secret|credential|crypto|session|login|logout|permission|rbac|sanitiz|validat|password|apikey|api[-_]key|oauth|sso|csrf|audit|rate.?limit/i

const API_SEGMENTS = /(^|\/)(routes?|apis?|controllers?|handlers?|endpoints?|graphql|trpc|middlewares?|pages\/api)(\/|$)/i

const MAX_FILE_BYTES = 1_000_000

const EXPORT_SYMBOL_RE =
  /export\s+(?:(?:async\s+)?function|class|interface|type|enum|const)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g
const IMPORT_FROM_RE = /import\b[^'"]*?from\s*['"]([^'"]+)['"]/g
const IMPORT_SIDE_EFFECT_RE = /^\s*import\s*['"]([^'"]+)['"]/gm
const DYNAMIC_IMPORT_RE = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g
const REQUIRE_RE = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g
const FUNCTION_RE = /(?:export\s+(?:async\s+)?)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/g

function toPosix(p: string): string {
  return p.split('\\').join('/')
}

function languageForExtension(ext: string): CodeLanguage {
  switch (ext) {
    case 'ts':
    case 'tsx':
    case 'mts':
    case 'cts':
      return 'typescript'
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return 'javascript'
    case 'json':
      return 'json'
    case 'yaml':
    case 'yml':
      return 'yaml'
    case 'toml':
      return 'toml'
    case 'prisma':
      return 'prisma'
    case 'sql':
      return 'sql'
    case 'graphql':
    case 'gql':
      return 'other'
    case 'go':
      return 'go'
    case 'rs':
      return 'rust'
    case 'css':
    case 'scss':
    case 'sass':
    case 'less':
      return 'css'
    case 'html':
    case 'htm':
      return 'html'
    case 'md':
    case 'mdx':
      return 'markdown'
    default:
      return 'other'
  }
}

function isTestFile(path: string): boolean {
  return /\.(test|spec|e2e)\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/i.test(path)
}

function isConfigFile(base: string): boolean {
  if (/\.config\.(json|js|ts|mjs|cjs|yaml|yml|toml)$/i.test(base)) return true
  if (/^(tsconfig|jsconfig)[^/]*\.json$/.test(base)) return true
  if (/^\.env(\..+)?$/.test(base)) return true
  if (['package.json', 'bunfig.toml', 'renovate.json', '.npmrc', '.yarnrc', '.eslintrc.json', '.prettierrc', 'go.mod', 'Cargo.toml', 'rust-toolchain.toml', 'pom.xml', 'build.gradle'].includes(base)) return true
  return false
}

function skipFile(rel: string, base: string, stat: { size: number }, only?: string[]): boolean {
  if (stat.size > MAX_FILE_BYTES) return true
  if (only && only.length > 0) {
    const hit = only.some((prefix) => {
      const normalized = toPosix(prefix).replace(/\\/g, '/').replace(/^\.\//, '')
      return rel === normalized || rel.startsWith(normalized.endsWith('/') ? normalized : `${normalized}/`)
    })
    if (!hit) return true
  }
  return false
}

function collectFiles(rootResolved: string, options: Required<Pick<IndexOptions, 'maxFiles'>> & Pick<IndexOptions, 'ignoreDirs' | 'only'>): {
  files: CodebaseFile[]
  truncated: boolean
} {
  const ignoreDirs = new Set([...DEFAULT_IGNORE, ...(options.ignoreDirs ?? [])])
  const only = options.only
  const files: CodebaseFile[] = []

  const walk = (dir: string, depth: number): boolean => {
    if (files.length >= options.maxFiles || depth > 50) return false
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return true
    }
    entries.sort()
    for (const entry of entries) {
      if (files.length >= options.maxFiles) return false
      if (ignoreDirs.has(entry)) continue
      const abs = join(dir, entry)
      let stat
      try {
        stat = statSync(abs)
      } catch {
        continue
      }
      const rel = toPosix(relative(rootResolved, abs))
      if (stat.isDirectory()) {
        if (!walk(abs, depth + 1)) return false
        continue
      }
      if (!stat.isFile()) continue
      if (skipFile(rel, entry, stat, only)) continue
      const file = describeFile(abs, rel, stat.size)
      if (file) files.push(file)
    }
    return true
  }

  walk(rootResolved, 0)
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { files, truncated: files.length >= options.maxFiles }
}

function describeFile(abs: string, rel: string, sizeBytes: number): CodebaseFile | undefined {
  const ext = extname(abs).replace(/^\./, '')
  const base = basename(abs)
  const language = languageForExtension(ext)
  const isSchema = SCHEMA_EXTENSIONS.has(ext)
  const isConfig = isConfigFile(base)
  const isTest = isTestFile(rel)
  const securitySurface = SECURITY_SEGMENTS.test(rel)
  const apiSurface = API_SEGMENTS.test(rel)

  let source: string
  try {
    source = readFileSync(abs, 'utf-8')
  } catch {
    return undefined
  }
  const lines = source.split(/\r?\n/)
  const lineCount = lines.length

  const isCode = CODE_EXTENSIONS.has(ext)
  const imports: string[] = []
  const exports: string[] = []
  const symbols: CodebaseSymbol[] = []

  if (isCode) {
    lines.forEach((line, index) => {
      collectImports(line, imports)
      collectExports(line, exports, symbols, index + 1)
    })
  }

  return {
    path: rel,
    absolutePath: abs,
    language,
    lineCount,
    sizeBytes,
    isTest,
    isConfig,
    isSchema,
    securitySurface,
    apiSurface,
    imports: [...new Set(imports)],
    exports: [...new Set(exports)],
    symbols,
  }
}

function collectImports(line: string, target: string[]): void {
  for (const regex of [IMPORT_FROM_RE, DYNAMIC_IMPORT_RE, REQUIRE_RE]) {
    regex.lastIndex = 0
    for (const match of line.matchAll(regex)) {
      if (match[1]) target.push(match[1])
    }
  }
  const sideEffect = line.match(IMPORT_SIDE_EFFECT_RE)
  if (sideEffect?.[1]) target.push(sideEffect[1])
}

function collectExports(line: string, exports: string[], symbols: CodebaseSymbol[], lineNumber: number): void {
  const trimmed = line.trim()
  if (/^export\s+default\b/.test(trimmed)) {
    exports.push('default')
    FUNCTION_RE.lastIndex = 0
    const defaultFn = trimmed.match(FUNCTION_RE)
    if (defaultFn?.[1]) symbols.push({ name: defaultFn[1], kind: 'function', line: lineNumber, exported: true })
  }

  EXPORT_SYMBOL_RE.lastIndex = 0
  for (const match of line.matchAll(EXPORT_SYMBOL_RE)) {
    exports.push(match[1]!)
    const word = match[0]
    const kind = word.includes('function')
      ? 'function'
      : word.includes('class')
        ? 'class'
        : word.includes('interface')
          ? 'interface'
          : word.includes('enum')
            ? 'enum'
            : word.includes('type')
              ? 'type'
              : 'const'
    symbols.push({ name: match[1]!, kind, line: lineNumber, exported: true })
  }
}

function readJsonSafe(filePath: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    return undefined
  } catch {
    return undefined
  }
}

function collectDependencies(rootResolved: string): CodebaseDependency[] {
  const deps: CodebaseDependency[] = []
  const pkg = readJsonSafe(join(rootResolved, 'package.json'))
  if (pkg) {
    const scopes: Array<{ key: string; kind: CodebaseDependency['kind'] }> = [
      { key: 'dependencies', kind: 'runtime' },
      { key: 'devDependencies', kind: 'dev' },
      { key: 'peerDependencies', kind: 'peer' },
      { key: 'optionalDependencies', kind: 'optional' },
    ]
    for (const { key, kind } of scopes) {
      const value = pkg[key]
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      for (const [name, version] of Object.entries(value as Record<string, unknown>)) {
        deps.push({ name, version: typeof version === 'string' ? version : '', kind, present: true })
      }
    }
  }

  const goMod = join(rootResolved, 'go.mod')
  if (existsSync(goMod)) {
    try {
      const text = readFileSync(goMod, 'utf-8')
      const requireRe = /^\s*([A-Za-z0-9_.\-/]+)\s+v[\w.-]+/gm
      for (const match of text.matchAll(requireRe)) {
        const name = match[1]!
        if (!name || name === 'require' || name === 'module') continue
        deps.push({ name, version: '', kind: 'runtime', present: true })
      }
    } catch {
      // unreadable go.mod — not fatal
    }
  }

  const cargo = join(rootResolved, 'Cargo.toml')
  if (existsSync(cargo)) {
    try {
      const text = readFileSync(cargo, 'utf-8')
      for (const section of text.split('\n')) {
        const match = /^([A-Za-z0-9_\-]+)\s*=\s*\{?\s*version\s*=\s*["']([^"']+)["']/.exec(section.trim())
        if (match) deps.push({ name: match[1]!, version: match[2]!, kind: 'runtime', present: true })
      }
    } catch {
      // unreadable Cargo.toml — not fatal
    }
  }

  deps.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const seen = new Set<string>()
  const unique: CodebaseDependency[] = []
  for (const d of deps) {
    const key = `${d.name}:${d.kind}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(d)
  }
  return unique
}

function detectScm(rootResolved: string): CodebaseScm {
  const gitHead = join(rootResolved, '.git', 'HEAD')
  if (!existsSync(gitHead)) return { type: 'unknown' }
  try {
    const head = readFileSync(gitHead, 'utf-8').trim()
    const branch = head.startsWith('ref: refs/heads/') ? head.replace('ref: refs/heads/', '') : head.slice(0, 12)
    return { type: 'git', branch }
  } catch {
    return { type: 'git' }
  }
}

/**
 * Build the shared codebase model for `root`. Deterministic and synchronous.
 * Uses filesystem facts only — no shell, no network — so it is safe to call
 * from any tool and repeatable across runs.
 */
export function indexCodebase(root: string, options: IndexOptions = {}): CodebaseModel {
  const rootResolved = resolve(root)
  const { files, truncated } = collectFiles(rootResolved, {
    maxFiles: options.maxFiles ?? 10_000,
    ignoreDirs: options.ignoreDirs,
    only: options.only,
  })

  return {
    root: rootResolved,
    generatedAtMs: Date.now(),
    files,
    dependencies: collectDependencies(rootResolved),
    testFiles: files.filter((f) => f.isTest).map((f) => f.path),
    configFiles: files.filter((f) => f.isConfig).map((f) => f.path),
    schemaFiles: files.filter((f) => f.isSchema).map((f) => f.path),
    securitySurfaceFiles: files.filter((f) => f.securitySurface).map((f) => f.path),
    apiSurfaceFiles: files.filter((f) => f.apiSurface).map((f) => f.path),
    scm: detectScm(rootResolved),
    truncated,
  }
}

/** Look up a repo-relative (posix) path in the model. */
export function findFile(model: CodebaseModel, relPath: string): CodebaseFile | undefined {
  const normalized = toPosix(relPath).replace(/^\.\//, '')
  return model.files.find((f) => f.path === normalized)
}

function stripModuleExtension(path: string): string {
  return path.replace(/(\.d\.(ts|mts|cts)|\.(ts|tsx|js|jsx|mts|cts|mjs|cjs))$/, '')
}

/** Files that plausibly import from `targetRelPath`, via specifier resolution. */
export function importersOf(model: CodebaseModel, targetRelPath: string): string[] {
  const target = findFile(model, targetRelPath)
  if (!target) return []
  const targetModule = stripModuleExtension(target.path)
  const targetBase = basename(targetModule)
  const targetDir = dirname(targetModule)

  const result: string[] = []
  for (const file of model.files) {
    if (file.path === target.path) continue
    const hits = file.imports.filter((specifier) => {
      if (specifier === targetModule || specifier === target.path) return true
      const candidate = stripModuleExtension(toPosix(join(dirname(file.path), specifier)))
      if (candidate === targetModule) return true
      if (candidate === targetDir) return true
      if (specifier === '.' && basename(targetDir) === targetBase) return true
      return false
    })
    if (hits.length > 0) result.push(file.path)
  }
  return result.sort()
}

/** All exported symbols in the model, keyed by file path. */
export function exportedSymbols(model: CodebaseModel): Map<string, CodebaseSymbol[]> {
  const map = new Map<string, CodebaseSymbol[]>()
  for (const file of model.files) {
    const exported = file.symbols.filter((s) => s.exported)
    if (exported.length > 0) map.set(file.path, exported)
  }
  return map
}

/** Dependency names for quick membership checks. */
export function dependencyNames(model: CodebaseModel): Set<string> {
  return new Set(model.dependencies.map((d) => d.name))
}