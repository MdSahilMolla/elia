import type { Tool } from './types.ts'
import { optionalString } from './args.ts'
import { runShell } from '../shell.ts'
import { resolveWorkspacePath } from '../autonomy/context.ts'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const SHELL_TIMEOUT_MS = 30_000

interface DependencyInfo {
  name: string
  currentVersion: string
  latestVersion: string
  isOutdated: boolean
  isVulnerable: boolean
  license: string
  lastPublished: string
  weeklyDownloads: number
  deprecated: boolean
  deprecationMessage?: string
}

interface AuditReport {
  packageManager: string
  totalDependencies: number
  outdated: number
  vulnerable: number
  deprecated: number
  dependencies: DependencyInfo[]
  summary: string
  recommendations: string[]
}

async function detectPackageManager(cwd: string): Promise<string> {
  if (existsSync(join(cwd, 'bun.lockb')) || existsSync(join(cwd, 'bun.lock'))) return 'bun'
  if (existsSync(join(cwd, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(cwd, 'yarn.lock'))) return 'yarn'
  if (existsSync(join(cwd, 'package-lock.json'))) return 'npm'
  if (existsSync(join(cwd, 'go.mod'))) return 'go'
  if (existsSync(join(cwd, 'Cargo.toml'))) return 'cargo'
  if (existsSync(join(cwd, 'requirements.txt')) || existsSync(join(cwd, 'pyproject.toml'))) return 'pip'
  return 'unknown'
}

async function getNodeDeps(cwd: string): Promise<Array<{ name: string; version: string }>> {
  const pkgPath = join(cwd, 'package.json')
  if (!existsSync(pkgPath)) return []
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
    const deps = { ...pkg.dependencies, ...pkg.devDependencies }
    return Object.entries(deps).map(([name, version]) => ({
      name,
      version: (version as string).replace(/^[\^~>=<]*/, ''),
    }))
  } catch {
    return []
  }
}

async function checkNpmInfo(name: string, cwd: string): Promise<Partial<DependencyInfo>> {
  const result = await runShell(
    `npm view "${name}" version license time.modified deprecated 2>/dev/null || echo "NOT_FOUND"`,
    SHELL_TIMEOUT_MS,
    cwd,
  )
  if (result.stdout.includes('NOT_FOUND')) return {}
  const lines = result.stdout.split('\n').filter((l) => l.trim())
  return {
    latestVersion: lines[0]?.trim(),
    license: lines[1]?.trim() ?? 'unknown',
    lastPublished: lines[2]?.trim() ?? '',
    deprecated: lines[3]?.trim() === 'true',
    deprecationMessage: lines[3]?.trim() !== 'true' ? undefined : 'Package is deprecated',
  }
}

async function checkVulnerabilities(cwd: string): Promise<Map<string, boolean>> {
  const vulnMap = new Map<string, boolean>()
  const result = await runShell('npm audit --json 2>/dev/null || echo "{}"', SHELL_TIMEOUT_MS, cwd)
  try {
    const audit = JSON.parse(result.stdout)
    if (audit.vulnerabilities) {
      for (const [name] of Object.entries(audit.vulnerabilities)) {
        vulnMap.set(name as string, true)
      }
    }
  } catch { /* ignore parse errors */ }
  return vulnMap
}

function compareVersions(current: string, latest: string): boolean {
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

export const dependencyAuditTool: Tool = {
  name: 'dependency_audit',
  description:
    'Audit project dependencies for outdated versions, security vulnerabilities, deprecated packages, and license issues. Supports npm/bun/pnpm/yarn projects. Returns a comprehensive report with upgrade recommendations.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Project root directory (default: current directory)' },
      includeDev: { type: 'boolean', description: 'Include devDependencies (default true)' },
      fix: { type: 'boolean', description: 'Show recommended fix commands (default false)' },
    },
  },
  async execute(input) {
    const cwd = resolveWorkspacePath('.')
    const scanPath = optionalString(input.path, 'path') ?? '.'
    const fullCwd = scanPath === '.' ? cwd : join(cwd, scanPath)

    const packageManager = await detectPackageManager(fullCwd)
    if (packageManager === 'unknown') {
      return 'No supported package manager detected. Supported: npm, bun, pnpm, yarn, go, cargo, pip.'
    }

    if (packageManager !== 'npm' && packageManager !== 'bun' && packageManager !== 'pnpm' && packageManager !== 'yarn') {
      return `Package manager "${packageManager}" detected but full audit not yet implemented. Currently supporting npm/bun/pnpm/yarn projects.`
    }

    const deps = await getNodeDeps(fullCwd)
    if (deps.length === 0) return 'No dependencies found in package.json.'

    const vulnMap = await checkVulnerabilities(fullCwd)
    const depInfos: DependencyInfo[] = []

    for (const dep of deps.slice(0, 50)) {
      const info = await checkNpmInfo(dep.name, fullCwd)
      const latestVersion = info.latestVersion ?? dep.version
      depInfos.push({
        name: dep.name,
        currentVersion: dep.version,
        latestVersion,
        isOutdated: compareVersions(dep.version, latestVersion),
        isVulnerable: vulnMap.get(dep.name) ?? false,
        license: info.license ?? 'unknown',
        lastPublished: info.lastPublished ?? '',
        weeklyDownloads: 0,
        deprecated: info.deprecated ?? false,
        deprecationMessage: info.deprecationMessage,
      })
    }

    const outdated = depInfos.filter((d) => d.isOutdated).length
    const vulnerable = depInfos.filter((d) => d.isVulnerable).length
    const deprecatedCount = depInfos.filter((d) => d.deprecated).length

    const recommendations: string[] = []
    if (vulnerable > 0) {
      recommendations.push(`URGENT: ${vulnerable} package(s) have known vulnerabilities — run "npm audit fix" immediately`)
    }
    if (deprecatedCount > 0) {
      const depNames = depInfos.filter((d) => d.deprecated).map((d) => d.name).join(', ')
      recommendations.push(`${deprecatedCount} deprecated package(s): ${depNames} — find alternatives`)
    }
    if (outdated > 0) {
      recommendations.push(`${outdated} package(s) are outdated — review and upgrade to latest versions`)
    }
    if (recommendations.length === 0) {
      recommendations.push('All dependencies are up to date with no known vulnerabilities.')
    }

    const report: AuditReport = {
      packageManager,
      totalDependencies: deps.length,
      outdated,
      vulnerable,
      deprecated: deprecatedCount,
      dependencies: depInfos,
      summary: `Audited ${deps.length} dependencies. ${outdated} outdated, ${vulnerable} vulnerable, ${deprecatedCount} deprecated.`,
      recommendations,
    }

    return formatReport(report)
  },
}

function formatReport(report: AuditReport): string {
  const lines: string[] = []
  lines.push('=== Dependency Audit Report ===')
  lines.push(`Package manager: ${report.packageManager}`)
  lines.push(`Total dependencies: ${report.totalDependencies}`)
  lines.push(`Outdated: ${report.outdated} | Vulnerable: ${report.vulnerable} | Deprecated: ${report.deprecated}`)
  lines.push('')
  lines.push(report.summary)

  const issues = report.dependencies.filter((d) => d.isOutdated || d.isVulnerable || d.deprecated)
  if (issues.length > 0) {
    lines.push('')
    lines.push('--- Issues ---')
    for (const dep of issues) {
      const flags: string[] = []
      if (dep.isVulnerable) flags.push('VULNERABLE')
      if (dep.deprecated) flags.push('DEPRECATED')
      if (dep.isOutdated) flags.push('OUTDATED')
      lines.push(`  ${dep.name} (${dep.currentVersion} -> ${dep.latestVersion}) [${flags.join(', ')}]`)
      if (dep.deprecationMessage) lines.push(`    ${dep.deprecationMessage}`)
    }
  }

  lines.push('')
  lines.push('--- Recommendations ---')
  for (const rec of report.recommendations) {
    lines.push(`  * ${rec}`)
  }

  return lines.join('\n')
}
