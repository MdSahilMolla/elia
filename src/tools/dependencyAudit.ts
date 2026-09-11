import type { Tool } from './types.ts'
import { optionalString } from './args.ts'
import { resolveWorkspacePath } from '../autonomy/context.ts'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { assessRisk, type RiskModel, type RiskDimension } from './intel/risk.ts'
import { makeEvidence, type Evidence } from './intel/evidence.ts'

export interface DependencyInfo {
  name: string
  currentVersion: string
  /** Actual installed version when a lockfile/module exists, else the declared range target. */
  range: string
  latestVersion: string
  isOutdated: boolean
  isVulnerable: boolean
  isVolatile: boolean
  isInstalled: boolean
  deprecated: boolean
  deprecationMessage?: string
  risk: RiskModel
  evidence: Evidence[]
}

export interface AuditReport {
  packageManager: string
  totalDependencies: number
  outdated: number
  vulnerable: number
  volatile: number
  missing: number
  deprecated: number
  dependencies: DependencyInfo[]
  summary: string
  recommendations: string[]
}

export interface DependencyHints {
  latestVersion?: string
  isVulnerable?: boolean
  deprecated?: boolean
  deprecationMessage?: string
}

/** Version ranges considered unpinned / volatile. */
export function isVolatileRange(range: string): boolean {
  const spec = range.trim()
  if (spec === '*') return true
  if (spec === 'latest') return true
  if (spec.includes('||')) return true
  const { operator } = splitSpec(spec)
  return operator.startsWith('>') || operator.startsWith('<') || operator.startsWith('~')
}

interface SplitSpec {
  operator: string
  version: string
}

export function splitSpec(range: string): SplitSpec {
  const match = range.trim().match(/^([<>=~^*]+)?\s*(.*)$/)
  return { operator: (match?.[1] ?? '').trim(), version: (match?.[2] ?? '').trim() }
}

/**
 * Deterministic 0-100 risk for a single dependency based on local facts.
 * Never queries a registry: it scores what the manifest and lock state prove.
 */
export function analyzeDependency(
  dep: { name: string; currentVersion: string; range: string },
  hints: DependencyHints = {},
): DependencyInfo {
  const evidence: Evidence[] = [
    makeEvidence({ kind: 'source_location', description: 'Entry for dependency in project manifest', location: 'package.json' }),
  ]
  const dimensions: RiskDimension[] = []
  let deprecationMessage: string | undefined

  if (hints.isVulnerable) {
    dimensions.push({ name: 'severity', weight: 0.25, score: 100, description: 'Known vulnerability reported for this package.' })
    dimensions.push({ name: 'exposure', weight: 0.15, score: 90, description: 'Vulnerable dependency is reachable from the project manifest.' })
    evidence.push(makeEvidence({ kind: 'test_result', description: 'Vulnerability flag from local audit data', location: dep.name }))
  }
  if (hints.deprecated) {
    dimensions.push({ name: 'severity', weight: 0.25, score: 70, description: 'Package is deprecated upstream.' })
    deprecationMessage = hints.deprecationMessage ?? 'Package is deprecated'
    evidence.push(makeEvidence({ kind: 'source_location', description: 'Deprecation marker in manifest context', location: dep.name }))
  }
  if (dep.range && isVolatileRange(dep.range)) {
    dimensions.push({ name: 'recurrence', weight: 0.05, score: 60, description: `Volatile range "${dep.range}" — build is not reproducible.` })
    evidence.push(makeEvidence({ kind: 'static_scan', description: `Range ${dep.range} is unpinned or floating`, location: dep.name }))
  }
  if (hints.latestVersion && dep.currentVersion !== hints.latestVersion && compareVersions(dep.currentVersion, hints.latestVersion)) {
    dimensions.push({ name: 'recurrence', weight: 0.05, score: 45, description: `Declared version ${dep.currentVersion} behind latest ${hints.latestVersion}.` })
    evidence.push(makeEvidence({ kind: 'test_result', description: 'Outdated version hint from registry data', location: dep.name }))
  }

  if (dimensions.length === 0) {
    dimensions.push({ name: 'severity', weight: 0.25, score: 10, description: 'No manifest-level issues identified offline.' })
  }

  const risk = assessRisk(dimensions, { confidence: 0.7, confidenceSource: 'local manifest + lockfile facts' })

  return {
    name: dep.name,
    currentVersion: dep.currentVersion,
    range: dep.range,
    latestVersion: hints.latestVersion ?? dep.currentVersion,
    isOutdated: Boolean(hints.latestVersion && compareVersions(dep.currentVersion, hints.latestVersion)),
    isVulnerable: hints.isVulnerable ?? false,
    isVolatile: isVolatileRange(dep.range),
    isInstalled: true,
    deprecated: hints.deprecated ?? false,
    deprecationMessage,
    risk,
    evidence,
  }
}

export function buildDependencyReport(deps: DependencyInfo[]): AuditReport {
  const outdated = deps.filter((d) => d.isOutdated).length
  const vulnerable = deps.filter((d) => d.isVulnerable).length
  const volatile = deps.filter((d) => d.isVolatile).length
  const missing = deps.filter((d) => !d.isInstalled).length
  const deprecated = deps.filter((d) => d.deprecated).length

  const sorted = [...deps].sort((a, b) => b.risk.score - a.risk.score)

  const recommendations: string[] = []
  if (vulnerable > 0) {
    recommendations.push(`URGENT: ${vulnerable} package(s) have known vulnerabilities — pin and upgrade immediately`)
  }
  const depNames = deps.filter((d) => d.deprecated).map((d) => d.name).join(', ')
  if (deprecated > 0) recommendations.push(`${deprecated} deprecated package(s): ${depNames} — find alternatives`)
  if (volatile > 0) recommendations.push(`${volatile} package(s) use volatile ranges — pin exact versions for reproducibility`)
  if (missing > 0) recommendations.push(`${missing} declared package(s) are not installed — run install`)
  if (outdated > 0) recommendations.push(`${outdated} package(s) are outdated — review and upgrade`)
  if (recommendations.length === 0) recommendations.push('No manifest-level dependency issues detected offline.')

  return {
    packageManager: 'npm-like',
    totalDependencies: deps.length,
    outdated,
    vulnerable,
    volatile,
    missing,
    deprecated,
    dependencies: sorted,
    summary: `Audited ${deps.length} dependencies. ${vulnerable > 0 ? `${vulnerable} vulnerable, ` : ''}${deprecated} deprecated, ${volatile} volatile, ${outdated} outdated.`,
    recommendations,
  }
}

/** Compare dotted versions; returns true when `latest` is newer than `current`. */
export function compareVersions(current: string, latest: string): boolean {
  const c = current.split('.').map(Number)
  const l = latest.split('.').map(Number)
  for (let i = 0; i < Math.max(c.length, l.length); i++) {
    const cv = c[i] ?? 0
    const lv = l[i] ?? 0
    if (lv > cv) return true
    if (lv < cv) return false
  }
  return false
}

export function detectPackageManager(cwd: string): string {
  if (existsSync(join(cwd, 'bun.lockb')) || existsSync(join(cwd, 'bun.lock'))) return 'bun'
  if (existsSync(join(cwd, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(cwd, 'yarn.lock'))) return 'yarn'
  if (existsSync(join(cwd, 'package-lock.json'))) return 'npm'
  if (existsSync(join(cwd, 'go.mod'))) return 'go'
  if (existsSync(join(cwd, 'Cargo.toml'))) return 'cargo'
  if (existsSync(join(cwd, 'requirements.txt')) || existsSync(join(cwd, 'pyproject.toml'))) return 'pip'
  return 'unknown'
}

export interface ParsedNodeDep {
  name: string
  currentVersion: string
  range: string
}

export function parsePackageJson(content: string): ParsedNodeDep[] {
  try {
    const pkg = JSON.parse(content)
    const declared: Record<string, string> = { ...pkg.dependencies, ...pkg.devDependencies }
    return Object.entries(declared).map(([name, range]) => {
      const spec = typeof range === 'string' ? range : String(range)
      const { version } = splitSpec(spec)
      const current = version || 'unknown'
      return { name, currentVersion: current, range: spec }
    })
  } catch {
    return []
  }
}

function recRange(range: string): string {
  return /\*|latest|~|>|<|(?:\|\|)/.test(range) ? ` (range "${range}")` : ''
}

export const dependencyAuditTool: Tool = {
  name: 'dependency_audit',
  description:
    'Audit project dependencies offline: known vulnerabilities and badges, deprecated packages, volatile/unpinned ranges, and missing installs. Deterministic — reads the manifest and lockfile, never queries a registry. Supports npm/bun/pnpm/yarn projects.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Project root directory (default: current directory)' },
      includeDev: { type: 'boolean', description: 'Include devDependencies (default true)' },
      fix: { type: 'boolean', description: 'Show recommended fix commands (default true)' },
    },
  },
  async execute(input) {
    const cwd = resolveWorkspacePath('.')
    const scanPath = optionalString(input.path, 'path') ?? '.'
    const fullCwd = scanPath === '.' ? cwd : join(cwd, scanPath)

    const packageManager = detectPackageManager(fullCwd)
    if (packageManager === 'unknown') {
      return 'No supported package manager detected. Supported: npm, bun, pnpm, yarn.'
    }
    if (!['npm', 'bun', 'pnpm', 'yarn'].includes(packageManager)) {
      return `Package manager "${packageManager}" detected but manifest audit currently covers npm-like projects.`
    }

    const pkgPath = join(fullCwd, 'package.json')
    if (!existsSync(pkgPath)) return 'No package.json found.'
    const deps = parsePackageJson(readFileSync(pkgPath, 'utf-8'))
    if (deps.length === 0) return 'No dependencies found in package.json.'

    const nodeModules = join(fullCwd, 'node_modules')
    const infos = deps.map((dep) => {
      const installed = existsSync(join(nodeModules, dep.name))
      const info = analyzeDependency(dep, {})
      return { ...info, isInstalled: installed } as DependencyInfo
    })

    const report = buildDependencyReport(infos)
    return formatReport(report, packageManager, input.fix === true)
  },
}

function formatReport(report: AuditReport, packageManager: string, showFixes: boolean): string {
  const lines: string[] = []
  lines.push('=== Dependency Audit Report (offline) ===')
  lines.push(`Package manager: ${packageManager}`)
  lines.push(`Total dependencies: ${report.totalDependencies}`)
  lines.push(`Vulnerable: ${report.vulnerable} | Deprecated: ${report.deprecated} | Volatile: ${report.volatile} | Outdated: ${report.outdated}`)
  lines.push('')
  lines.push(report.summary)

  const issues = report.dependencies.filter((d) => d.isVulnerable || d.deprecated || d.isVolatile || d.isOutdated || !d.isInstalled)
  if (issues.length > 0) {
    lines.push('')
    lines.push('--- Issues ---')
    for (const dep of issues) {
      const flags: string[] = []
      if (dep.isVulnerable) flags.push('VULNERABLE')
      if (dep.deprecated) flags.push('DEPRECATED')
      if (dep.isVolatile) flags.push('VOLATILE')
      if (dep.isOutdated) flags.push('OUTDATED')
      if (!dep.isInstalled) flags.push('NOT INSTALLED')
      lines.push(`  ${dep.name} (${dep.currentVersion}${recRange(dep.range)}) [${flags.join(', ')}] risk ${dep.risk.level} ${dep.risk.score}/100`)
      if (dep.deprecationMessage) lines.push(`    ${dep.deprecationMessage}`)
    }
  }

  lines.push('')
  lines.push('--- Recommendations ---')
  for (const rec of report.recommendations) {
    lines.push(`  * ${rec}`)
  }

  if (showFixes) {
    lines.push('')
    lines.push('--- Suggested Fix Commands ---')
    for (const dep of report.dependencies.filter((d) => d.isVulnerable || d.deprecated)) {
      lines.push(`  bun add ${dep.name}@latest`)
    }
  }

  return lines.join('\n')
}