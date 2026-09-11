import type { Tool } from './types.ts'
import { optionalString } from './args.ts'
import { resolveWorkspacePath } from '../autonomy/context.ts'
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join, relative, extname } from 'node:path'

const MARKER_RE = /(TODO|FIXME|HACK|XXX)/g
const MAX_SCANNED_FILES = 2000
const HEAL_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx'])

export type GitFn = (args: string[], cwd: string) => Promise<string>

export async function defaultGitRunner(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  const output = await new Response(proc.stdout).text()
  const code = await proc.exited
  return code === 0 ? output : ''
}

export interface HealthMetric {
  name: string
  status: 'healthy' | 'warning' | 'critical' | 'unknown'
  value: string
  threshold?: string
  recommendation: string
}

export interface IncidentPattern {
  type: string
  frequency: number
  lastSeen: string
  affectedFiles: string[]
  suggestedFix: string
}

export interface MonitorReport {
  action: string
  metrics: HealthMetric[]
  incidentPatterns: IncidentPattern[]
  overallHealth: 'healthy' | 'degraded' | 'unhealthy'
  summary: string
  recommendations: string[]
}

export interface AutoFixDraft {
  id: string
  generatedAt: string
  criticality: 'info' | 'warning'
  items: Array<{ file?: string; action: string; rationale: string }>
}

function listSourceFiles(dir: string): string[] {
  const files: string[] = []
  try {
    const entries = readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (files.length >= MAX_SCANNED_FILES) break
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.elia') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        files.push(...listSourceFiles(full))
      } else if (HEAL_EXTENSIONS.has(extname(entry.name))) {
        files.push(full)
      }
    }
  } catch {
    // unreadable directories are skipped
  }
  return files
}

/** Count marker references (TODO/FIXME/HACK/XXX) in source files, skipping binaries and huge files. */
export function scanMarkerReferences(cwd: string): { count: number; files: Array<{ file: string; count: number }> } {
  const files = listSourceFiles(cwd)
  const perFile: Array<{ file: string; count: number }> = []
  let total = 0
  for (const file of files) {
    let text: string
    try {
      if (statSync(file).size > 2 * 1024 * 1024) continue
      text = readFileSync(file, 'utf-8')
    } catch {
      continue
    }
    const matches = text.match(MARKER_RE)
    if (!matches) continue
    const count = matches.length
    total += count
    perFile.push({ file: relative(cwd, file), count })
  }
  perFile.sort((a, b) => b.count - a.count)
  return { count: total, files: perFile.slice(0, 10) }
}

/** Largest source file and its raw newline count (fs-based, no wc/find). */
export function largestSourceFile(cwd: string): { file: string; lines: number } | null {
  const files = listSourceFiles(cwd)
  let largest: { file: string; lines: number } | null = null
  for (const file of files) {
    try {
      if (statSync(file).size > 5 * 1024 * 1024) continue
      const text = readFileSync(file, 'utf-8')
      const lines = text.split('\n').length
      if (!largest || lines > largest.lines) largest = { file: relative(cwd, file), lines }
    } catch {
      continue
    }
  }
  return largest
}

export async function getGitActivity(cwd: string, gitFn: GitFn = defaultGitRunner): Promise<HealthMetric[]> {
  const metrics: HealthMetric[] = []

  const recentCommits = (await gitFn(['log', '--oneline', '--since="24 hours ago"'], cwd))
    .split('\n').filter((l) => l.trim()).length
  metrics.push({
    name: 'Recent commits (24h)',
    status: recentCommits > 20 ? 'warning' : 'healthy',
    value: String(recentCommits),
    threshold: '20',
    recommendation: recentCommits > 20 ? 'High commit velocity — verify stability' : 'Normal commit activity',
  })

  const hotfixBranches = (await gitFn(['branch', '--list', 'hotfix/*'], cwd))
    .split('\n').filter((l) => l.trim()).length
  metrics.push({
    name: 'Active hotfix branches',
    status: hotfixBranches > 3 ? 'critical' : hotfixBranches > 0 ? 'warning' : 'healthy',
    value: String(hotfixBranches),
    threshold: '3',
    recommendation: hotfixBranches > 0 ? 'Active hotfixes — monitor for recurring issues' : 'No active hotfixes',
  })

  return metrics
}

export async function getCodeHealthMetrics(cwd: string): Promise<HealthMetric[]> {
  const metrics: HealthMetric[] = []

  const markers = scanMarkerReferences(cwd)
  metrics.push({
    name: 'Open TODOs/FIXMEs',
    status: markers.count > 50 ? 'warning' : 'healthy',
    value: String(markers.count),
    threshold: '50',
    recommendation: markers.count > 50 ? 'Consider triaging stale TODOs' : 'Manageable technical debt',
  })

  const largest = largestSourceFile(cwd)
  if (largest) {
    metrics.push({
      name: 'Largest file (lines)',
      status: largest.lines > 1000 ? 'warning' : 'healthy',
      value: String(largest.lines),
      threshold: '1000',
      recommendation: largest.lines > 1000 ? `Consider splitting ${largest.file}` : 'File sizes within norms',
    })
  }

  return metrics
}

export async function analyzeIncidentPatterns(cwd: string, gitFn: GitFn = defaultGitRunner): Promise<IncidentPattern[]> {
  const patterns: IncidentPattern[] = []

  const fixCommits = (await gitFn(
    ['log', '--oneline', '--all', '--grep=fix', '--grep=bug', '--grep=patch', '--grep=hotfix', '--since="30 days ago"'],
    cwd,
  )).split('\n').filter((l) => l.trim())
  const fixCount = fixCommits.length
  if (fixCount > 5) {
    const files = (await gitFn(
      ['log', '--oneline', '--all', '--grep=fix', '--since="30 days ago"', '--name-only', '--pretty=format:'],
      cwd,
    )).split('\n').filter((l) => l.trim())
    const counts = new Map<string, number>()
    for (const line of files) {
      const parts = line.trim().split(/\s+/)
      const file = parts[parts.length - 1] ?? ''
      if (file.length > 0) counts.set(file, (counts.get(file) ?? 0) + 1)
    }
    const affectedFiles = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([f]) => f)

    patterns.push({
      type: 'frequent-fixes',
      frequency: fixCount,
      lastSeen: new Date().toISOString(),
      affectedFiles,
      suggestedFix: 'Investigate root cause in frequently-fixed files — consider additional tests or refactoring',
    })
  }

  return patterns
}

export function computeOverallHealth(metrics: HealthMetric[]): MonitorReport['overallHealth'] {
  const hasCritical = metrics.some((m) => m.status === 'critical')
  const warningCount = metrics.filter((m) => m.status === 'warning').length
  if (hasCritical) return 'unhealthy'
  if (warningCount > 2) return 'degraded'
  return 'healthy'
}

export function deploymentHealth(cwd: string): { healthy: boolean; report: string } {
  const path = join(cwd, '.elia', 'deployments.json')
  if (!existsSync(path)) {
    return { healthy: true, report: 'No deployment records found. Track deployments via .elia/deployments.json.' }
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Array<{ at: string; ref?: string; status?: string }>
    if (!Array.isArray(raw) || raw.length === 0) return { healthy: true, report: 'No deployment records found.' }
    const last = raw[raw.length - 1]!
    const ageDays = (Date.now() - new Date(last.at).getTime()) / 86400000
    const ok = ageDays < 7 && (last.status === undefined || last.status === 'ok')
    return {
      healthy: ok,
      report: ok
        ? `Last deployment ${ageDays.toFixed(1)}d ago (${last.ref ?? 'n/a'}) — within norms.`
        : `Last deployment ${ageDays.toFixed(1)}d ago (${last.ref ?? 'n/a'}) — stale or failing, investigate.`,
    }
  } catch {
    return { healthy: false, report: 'deployments.json is malformed.' }
  }
}

/**
 * Draft-only auto-fix planning. Builds non-destructive recommendations from
 * current metrics and incident patterns; never edits or applies anything.
 */
export function planAutoFix(cwd: string, metrics: HealthMetric[], incidentPatterns: IncidentPattern[]): AutoFixDraft {
  const items: AutoFixDraft['items'] = []
  const criticality: AutoFixDraft['criticality'] = incidentPatterns.length > 0 || metrics.some((m) => m.status === 'critical' || m.status === 'warning') ? 'warning' : 'info'

  for (const pattern of incidentPatterns) {
    for (const file of pattern.affectedFiles.slice(0, 3)) {
      items.push({
        file,
        action: 'add regression tests and root-cause review',
        rationale: `File appears in ${pattern.frequency} fix commits in the last 30 days (${pattern.type}).`,
      })
    }
  }

  const hotfixes = metrics.find((m) => m.name === 'Active hotfix branches')
  if (hotfixes && hotfixes.status === 'critical') {
    items.push({ action: 'triage and promote or close hotfix branches', rationale: 'More than 3 active hotfix branches suggest recurring instability.' })
  }
  const commits = metrics.find((m) => m.name === 'Recent commits (24h)')
  if (commits && commits.status === 'warning') {
    items.push({ action: 'add stability verification / CI guard on fast-track merges', rationale: 'High commit velocity in the last 24h.' })
  }
  const markers = metrics.find((m) => m.name === 'Open TODOs/FIXMEs')
  if (markers && markers.status === 'warning') {
    items.push({ action: 'triage stale TODO/FIXME markers', rationale: `${markers.value} unresolved markers exceeded the threshold.` })
  }
  const large = metrics.find((m) => m.name === 'Largest file (lines)')
  if (large && large.status === 'warning') {
    items.push({ action: 'split oversized module', rationale: `Largest file is ${large.value} lines.` })
  }

  if (items.length === 0) {
    items.push({ action: 'no action required', rationale: 'No health warnings or incident patterns detected.' })
  }

  return { id: `heal_${Date.now()}`, generatedAt: new Date().toISOString(), criticality, items }
}

export function formatAutoFixDraft(draft: AutoFixDraft): string {
  const lines: string[] = []
  lines.push('=== Auto-Fix Draft Plan (not applied) ===')
  lines.push(`ID: ${draft.id}`)
  lines.push(`Generated: ${draft.generatedAt}`)
  lines.push(`Criticality: ${draft.criticality.toUpperCase()}`)
  lines.push('')
  lines.push('Proposed changes (review before applying):')
  for (const item of draft.items) {
    lines.push(`  - [${item.file ?? 'project'}] ${item.action}`)
    lines.push(`    ${item.rationale}`)
  }
  lines.push('')
  lines.push('This is a draft plan. Nothing was modified.')
  return lines.join('\n')
}

export function writeAutoFixDraft(cwd: string, draft: AutoFixDraft): string {
  const dir = join(cwd, '.elia', 'heal-plans')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const path = join(dir, `${draft.id}.md`)
  writeFileSync(path, formatAutoFixDraft(draft))
  return path
}

export async function runSelfHealing(input: Record<string, unknown>, cwd: string, gitFn: GitFn = defaultGitRunner): Promise<string> {
  const action = optionalString(input.action, 'action') ?? 'status'
  const explicitPath = optionalString(input.path, 'path')
  const target = explicitPath && existsSync(join(cwd, explicitPath)) ? join(cwd, explicitPath) : cwd

  if (action !== 'status' && action !== 'analyze' && action !== 'deploy_monitor' && action !== 'auto_fix') {
    throw new Error(`Unknown action: ${action}. Use status, analyze, deploy_monitor, or auto_fix.`)
  }

  if (action === 'auto_fix') {
    const gitMetrics = await getGitActivity(target, gitFn)
    const codeMetrics = await getCodeHealthMetrics(target)
    const incidents = await analyzeIncidentPatterns(target, gitFn)
    const draft = planAutoFix(target, [...gitMetrics, ...codeMetrics], incidents)
    const savedAt = writeAutoFixDraft(target, draft)
    return [formatAutoFixDraft(draft), '', `Draft saved to: ${savedAt}`].join('\n')
  }

  if (action === 'deploy_monitor') {
    const { healthy, report } = deploymentHealth(target)
    return [
      '=== Deployment Monitor ===',
      `Status: ${healthy ? 'OK' : 'ATTENTION'}`,
      '',
      report,
    ].join('\n')
  }

  const gitMetrics = await getGitActivity(target, gitFn)
  const codeMetrics = await getCodeHealthMetrics(target)
  const allMetrics = [...gitMetrics, ...codeMetrics]

  let incidentPatterns: IncidentPattern[] = []
  if (action === 'analyze') {
    incidentPatterns = await analyzeIncidentPatterns(target, gitFn)
  }

  const overallHealth = computeOverallHealth(allMetrics)
  const recommendations: string[] = []

  for (const metric of allMetrics) {
    if (metric.status !== 'healthy') {
      recommendations.push(`${metric.name}: ${metric.recommendation}`)
    }
  }

  for (const pattern of incidentPatterns) {
    recommendations.push(`${pattern.type}: ${pattern.suggestedFix}`)
  }

  if (recommendations.length === 0) {
    recommendations.push('Project health looks good. Continue monitoring.')
  }

  const report: MonitorReport = {
    action,
    metrics: allMetrics,
    incidentPatterns,
    overallHealth,
    summary: `Project health: ${overallHealth}. ${allMetrics.length} metrics checked. ${incidentPatterns.length} incident pattern(s) detected.`,
    recommendations,
  }

  return formatReport(report)
}

export function formatReport(report: MonitorReport): string {
  const lines: string[] = []
  lines.push('=== Self-Healing Monitor Report ===')
  lines.push(`Mode: ${report.action}`)
  lines.push(`Overall health: ${report.overallHealth.toUpperCase()}`)
  lines.push('')
  lines.push(report.summary)

  lines.push('')
  lines.push('--- Health Metrics ---')
  for (const metric of report.metrics) {
    const icon = metric.status === 'healthy' ? '✓' : metric.status === 'warning' ? '⚠' : metric.status === 'critical' ? '✗' : '?'
    lines.push(`  ${icon} ${metric.name}: ${metric.value}${metric.threshold ? ` (threshold: ${metric.threshold})` : ''}`)
    if (metric.status !== 'healthy') {
      lines.push(`    → ${metric.recommendation}`)
    }
  }

  if (report.incidentPatterns.length > 0) {
    lines.push('')
    lines.push('--- Incident Patterns ---')
    for (const pattern of report.incidentPatterns) {
      lines.push(`  [${pattern.type}] Frequency: ${pattern.frequency}`)
      if (pattern.affectedFiles.length > 0) {
        lines.push(`    Affected: ${pattern.affectedFiles.join(', ')}`)
      }
      lines.push(`    Fix: ${pattern.suggestedFix}`)
    }
  }

  lines.push('')
  lines.push('--- Recommendations ---')
  for (const rec of report.recommendations) {
    lines.push(`  * ${rec}`)
  }

  return lines.join('\n')
}

export const selfHealingMonitorTool: Tool = {
  name: 'self_healing_monitor',
  description:
    'Monitor project health by analyzing git activity, code quality metrics, incident patterns, and technical debt. Provides actionable recommendations for self-healing. status is read-only; analyze adds incident patterns; auto_fix generates a non-destructive draft plan; deploy_monitor checks deployment freshness from the local deployment log.',
  input_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'Action: status (quick health check), analyze (deep analysis), deploy_monitor (deployment health), auto_fix (draft-only fix plan)',
        enum: ['status', 'analyze', 'deploy_monitor', 'auto_fix'],
      },
      path: { type: 'string', description: 'Project root directory (default: current directory)' },
    },
    required: ['action'],
  },
  async execute(input) {
    return runSelfHealing(input as Record<string, unknown>, resolveWorkspacePath('.'))
  },
}