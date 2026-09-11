// Shared change model: what a commit, PR, or working-tree state actually changes.
//
// This becomes the common input for impact, specification, architecture,
// review, and adversarial analyses. It is built deterministically from git
// diff data: which files changed, what kinds of change occurred, which symbols
// and imports/exports were touched, and which surfaces (tests, config, schema,
// security) are involved.

import { resolve } from 'node:path'

export type ChangeKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'copied'

export type SymbolChangeKind = 'function' | 'class' | 'interface' | 'type' | 'enum' | 'const' | 'import' | 'export' | 'default' | 'other'

export interface ChangedSymbol {
  name: string
  kind: SymbolChangeKind
  /** 'added'/'removed' for new/deleted declarations, 'signature' for modified declarations. */
  change: 'added' | 'removed' | 'signature'
}

export interface ChangedFile {
  path: string
  kind: ChangeKind
  oldPath?: string
  additions: number
  deletions: number
  symbols: ChangedSymbol[]
  importsChanged: string[]
  exportsChanged: string[]
  isTest: boolean
  isConfigOrSchema: boolean
  isSecuritySurface: boolean
  isApiSurface: boolean
  isDependencyManifest: boolean
}

export interface ChangeModel {
  baseRef?: string
  headRef?: string
  files: ChangedFile[]
  summary: {
    totalFiles: number
    linesAdded: number
    linesRemoved: number
    testsChanged: string[]
    configOrSchemaChanged: string[]
    securitySurfacesChanged: string[]
    apiSurfacesChanged: string[]
    dependencyManifestsChanged: string[]
  }
  generatedAtMs: number
}

export interface ChangeOptions {
  /** Commit range to analyze: `base..head`. Defaults to the working tree vs HEAD. */
  base?: string
  head?: string
  /**
   * Inject a git runner: receives git argv (without the leading `git`) and
   * returns stdout text. Defaults to a `Bun.spawn` argv-based invocation that
   * avoids cmd-shell quoting hazards on Windows. Used by tests.
   */
  run?: (args: string[]) => Promise<string>
  cwd: string
  /** Guard against pathological repos: max files to analyze. */
  maxFiles?: number
}

const SECURITY_SEGMENTS = /authoriz|authenticat|security|token|secret|credential|crypto|session|login|logout|permission|rbac|sanitiz|validat|password|apikey|api[-_]key|oauth|sso|csrf|audit|rate.?limit/i

const API_SEGMENTS = /(^|\/)(routes?|apis?|controllers?|handlers?|endpoints?|graphql|trpc|middlewares?|pages\/api)(\/|$)/i

const DECL_RE =
  /export\s+(?:(?:async\s+)?function|class|interface|type|enum|const)\s+([A-Za-z_$][A-Za-z0-9_$]*)/
const FUNCTION_DECL_RE = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/
const CLASS_DECL_RE = /^(?:export\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/
const IMPORT_CHANGE_RE = /^import\b.*?from\s*['"]([^'"]+)['"]|^import\s*['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/

export function toPosix(p: string): string {
  return p.split('\\').join('/')
}

function isTestPath(path: string): boolean {
  return /\.(test|spec|e2e)\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/i.test(path)
}

function isConfigOrSchemaPath(path: string): boolean {
  const base = path.split('/').pop() ?? path
  if (/\.(prisma|sql)$|(^|[/\\])(migrations?|seed)([/\\]|$)/i.test(path)) return true
  if (/\.config\.(json|js|ts|mjs|cjs|yaml|yml|toml)$/i.test(base)) return true
  if (/^(tsconfig|jsconfig)[^/]*\.json$/.test(base)) return true
  return ['package.json', 'package-lock.json', 'bun.lock', 'bun.lockb', 'yarn.lock', 'pnpm-lock.yaml', 'go.mod', 'go.sum', 'Cargo.toml', 'Cargo.lock', 'bunfig.toml', '.env', '.env.example'].includes(base)
}

function isDependencyManifest(path: string): boolean {
  const base = path.split('/').pop() ?? path
  return ['package.json', 'package-lock.json', 'bun.lock', 'bun.lockb', 'yarn.lock', 'pnpm-lock.yaml', 'go.mod', 'go.sum', 'Cargo.toml', 'Cargo.lock', 'bunfig.toml'].includes(base)
}

function isSecuritySurface(path: string): boolean {
  return SECURITY_SEGMENTS.test(path)
}

function isApiSurface(path: string): boolean {
  return API_SEGMENTS.test(path)
}

function inspectLine(line: string, change: ChangedSymbol['change'], symbols: ChangedSymbol[], imports: Set<string>, exports: Set<string>): void {
  const stripped = line.startsWith('+') || line.startsWith('-') ? line.slice(1) : line
  const content = stripped.trim()
  if (content.length === 0) return

  const decl = content.match(DECL_RE)
  const funcDecl = content.match(FUNCTION_DECL_RE)
  const classDecl = content.match(CLASS_DECL_RE)
  const imp = content.match(IMPORT_CHANGE_RE)

  const name = decl?.[1]
  if (name) {
    const kind = decl[0].includes('function')
      ? 'function'
      : decl[0].includes('class')
        ? 'class'
        : decl[0].includes('interface')
          ? 'interface'
          : decl[0].includes('enum')
            ? 'enum'
            : decl[0].includes('type')
              ? 'type'
              : 'const'
    symbols.push({ name, kind, change })
  } else if (funcDecl?.[1]) {
    symbols.push({ name: funcDecl[1], kind: 'function', change })
  } else if (classDecl?.[1]) {
    symbols.push({ name: classDecl[1], kind: 'class', change })
  }

  if (imp?.[1] ?? imp?.[2] ?? imp?.[3]) {
    imports.add((imp[1] ?? imp[2] ?? imp[3])!)
  }
  if (/^export\s/.test(content)) exports.add(name ?? 'default')
}

/**
 * Parse `git diff` output for a single file into a {@link ChangedFile}. Pure and
 * deterministic; the tool layer feeds it diff text and the caller composes the
 * git invocations (or uses {@link buildChangeModel}).
 */
export function analyzeFileFromDiff(path: string, diffBody: string): ChangedFile {
  const lines = diffBody.split(/\r?\n/)
  let additions = 0
  let deletions = 0
  const symbols: ChangedSymbol[] = []
  const importsChanged = new Set<string>()
  const exportsChanged = new Set<string>()

  for (const raw of lines) {
    if (raw.startsWith('+++') || raw.startsWith('---') || raw.startsWith('@@') || raw.startsWith('diff ')) continue
    if (raw.startsWith('+')) {
      additions++
      inspectLine(raw, 'added', symbols, importsChanged, exportsChanged)
    } else if (raw.startsWith('-')) {
      deletions++
      inspectLine(raw, 'removed', symbols, importsChanged, exportsChanged)
    }
  }

  // A declaration that disappears on one side and reappears on the other is a
  // signature change, not an add-plus-remove.
  const merged: ChangedSymbol[] = []
  const byKey = new Map<string, ChangedSymbol>()
  for (const symbol of symbols) {
    const key = `${symbol.name}:${symbol.kind}`
    const existing = byKey.get(key)
    if (!existing) {
      byKey.set(key, symbol)
      merged.push(symbol)
    } else if (existing.change !== symbol.change) {
      existing.change = 'signature'
    }
  }

  return {
    path: toPosix(path),
    kind: 'modified',
    additions,
    deletions,
    symbols: merged,
    importsChanged: [...importsChanged],
    exportsChanged: [...exportsChanged],
    isTest: isTestPath(path),
    isConfigOrSchema: isConfigOrSchemaPath(path),
    isSecuritySurface: isSecuritySurface(path),
    isApiSurface: isApiSurface(path),
    isDependencyManifest: isDependencyManifest(path),
  }
}

/** Parse output of `git diff --name-status` / `--name-status -M`. */
export function parseGitNameStatus(output: string): Array<{ path: string; type: string; oldPath?: string }> {
  const entries: Array<{ path: string; type: string; oldPath?: string }> = []
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const tabParts = line.split('\t')
    if (tabParts.length < 2) continue
    const code = tabParts[0]!.charAt(0).toUpperCase()
    if (tabParts[0]!.startsWith('R') || tabParts[0]!.startsWith('C')) {
      const oldPath = tabParts[1] ?? ''
      const newPath = tabParts[2] ?? tabParts[1] ?? ''
      if (newPath) entries.push({ path: toPosix(newPath), type: tabParts[0]!.startsWith('R') ? 'R' : 'C', oldPath: toPosix(oldPath) })
      continue
    }
    const path = tabParts[1] ?? ''
    if (path) entries.push({ path: toPosix(path), type: code })
  }
  return entries
}

function kindFromType(type: string): ChangeKind {
  if (type === 'A') return 'added'
  if (type === 'D') return 'deleted'
  if (type === 'R') return 'renamed'
  if (type === 'C') return 'copied'
  return 'modified'
}

function defaultGitRunner(cwd: string): (args: string[]) => Promise<string> {
  return async (args) => {
    const proc = Bun.spawn(['git', ...args], { stdout: 'pipe', stderr: 'pipe', cwd: resolve(cwd) })
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    const exit = await proc.exited
    if (exit !== 0) throw new Error(`git ${args[0]} failed (exit ${exit}): ${stderr.trim().slice(0, 400)}`)
    return stdout
  }
}

/**
 * Build the change model for a working tree (vs HEAD) or a commit range.
 * Runs real git commands through argv-based invocation (no shell quoting).
 */
export async function buildChangeModel(options: ChangeOptions): Promise<ChangeModel> {
  const run = options.run ?? defaultGitRunner(options.cwd)
  const maxFiles = options.maxFiles ?? 200

  const base = options.base ?? ''
  const head = options.head ?? ''
  const refSpec = base ? `${base}..${head || 'HEAD'}` : 'HEAD'

  let nameStatus: string
  try {
    nameStatus = await run(['diff', '--name-status', '-M', refSpec])
  } catch {
    nameStatus = ''
  }
  const statusEntries = parseGitNameStatus(nameStatus)

  const files: ChangedFile[] = []
  let linesAdded = 0
  let linesRemoved = 0

  for (const entry of statusEntries.slice(0, maxFiles)) {
    let diffBody = ''
    let diffPath = entry.path
    const diffRefs = base ? [refSpec, '--', entry.path] : ['HEAD', '--', entry.path]
    try {
      diffBody = await run(['diff', ...diffRefs])
    } catch {
      diffBody = ''
    }
    if ((entry.type === 'R' || entry.type === 'C') && !diffBody.trim() && entry.oldPath) {
      diffPath = entry.oldPath
      try {
        diffBody = await run(['diff', ...(base ? [refSpec, '--', entry.oldPath] : ['HEAD', '--', entry.oldPath])])
      } catch {
        diffBody = ''
      }
    }

    const analyzed = analyzeFileFromDiff(diffPath, diffBody)
    const file: ChangedFile = {
      ...analyzed,
      path: entry.path,
      kind: kindFromType(entry.type),
      ...(diffPath === entry.path && entry.oldPath ? { oldPath: entry.oldPath } : {}),
      ...(entry.type === 'D' ? { additions: 0 } : {}),
    }
    linesAdded += file.additions
    linesRemoved += file.deletions
    files.push(file)
  }

  const summary = {
    totalFiles: files.length,
    linesAdded,
    linesRemoved,
    testsChanged: files.filter((f) => f.isTest).map((f) => f.path),
    configOrSchemaChanged: files.filter((f) => f.isConfigOrSchema).map((f) => f.path),
    securitySurfacesChanged: files.filter((f) => f.isSecuritySurface).map((f) => f.path),
    apiSurfacesChanged: files.filter((f) => f.isApiSurface).map((f) => f.path),
    dependencyManifestsChanged: files.filter((f) => f.isDependencyManifest).map((f) => f.path),
  }

  return {
    baseRef: base || undefined,
    headRef: head || undefined,
    files,
    summary,
    generatedAtMs: Date.now(),
  }
}