import type { Tool } from './types.ts'
import { optionalString } from './args.ts'
import { runShell } from '../shell.ts'
import { resolveWorkspacePath } from '../autonomy/context.ts'

const SHELL_TIMEOUT_MS = 15_000

interface HealthMetric {
  name: string
  status: 'healthy' | 'warning' | 'critical' | 'unknown'
  value: string
  threshold?: string
  recommendation: string
}

interface IncidentPattern {
  type: string
  frequency: number
  lastSeen: string
  affectedFiles: string[]
  suggestedFix: string
}

interface MonitorReport {
  action: string
  metrics: HealthMetric[]
  incidentPatterns: IncidentPattern[]
  overallHealth: 'healthy' | 'degraded' | 'unhealthy'
  summary: string
  recommendations: string[]
}

async function getGitActivity(cwd: string): Promise<HealthMetric[]> {
  const metrics: HealthMetric[] = []

  const commitResult = await runShell('git log --oneline --since="24 hours ago" 2>/dev/null | wc -l', SHELL_TIMEOUT_MS, cwd)
  const recentCommits = parseInt(commitResult.stdout.trim(), 10) || 0
  metrics.push({
    name: 'Recent commits (24h)',
    status: recentCommits > 20 ? 'warning' : 'healthy',
    value: String(recentCommits),
    threshold: '20',
    recommendation: recentCommits > 20 ? 'High commit velocity — verify stability' : 'Normal commit activity',
  })

  const branchResult = await runShell('git branch --list "hotfix/*" 2>/dev/null | wc -l', SHELL_TIMEOUT_MS, cwd)
  const hotfixBranches = parseInt(branchResult.stdout.trim(), 10) || 0
  metrics.push({
    name: 'Active hotfix branches',
    status: hotfixBranches > 3 ? 'critical' : hotfixBranches > 0 ? 'warning' : 'healthy',
    value: String(hotfixBranches),
    threshold: '3',
    recommendation: hotfixBranches > 0 ? 'Active hotfixes — monitor for recurring issues' : 'No active hotfixes',
  })

  return metrics
}

async function getCodeHealthMetrics(cwd: string): Promise<HealthMetric[]> {
  const metrics: HealthMetric[] = []

  const todoResult = await runShell('grep -r "TODO\\|FIXME\\|HACK\\|XXX" --include="*.ts" --include="*.tsx" --include="*.js" . 2>/dev/null | grep -v node_modules | wc -l', SHELL_TIMEOUT_MS, cwd)
  const todoCount = parseInt(todoResult.stdout.trim(), 10) || 0
  metrics.push({
    name: 'Open TODOs/FIXMEs',
    status: todoCount > 50 ? 'warning' : 'healthy',
    value: String(todoCount),
    threshold: '50',
    recommendation: todoCount > 50 ? 'Consider triaging stale TODOs' : 'Manageable technical debt',
  })

  const largeResult = await runShell('find . -name "*.ts" -o -name "*.tsx" -o -name "*.js" | grep -v node_modules | xargs wc -l 2>/dev/null | sort -rn | head -5', SHELL_TIMEOUT_MS, cwd)
  const largeFiles = largeResult.stdout.split('\n').filter((l) => l.trim())
  if (largeFiles.length > 0) {
    const firstLine = largeFiles[0] ?? ''
    const match = firstLine.match(/(\d+)\s+/)
    const maxLines = match ? parseInt(match[1]!, 10) : 0
    metrics.push({
      name: 'Largest file (lines)',
      status: maxLines > 1000 ? 'warning' : 'healthy',
      value: String(maxLines),
      threshold: '1000',
      recommendation: maxLines > 1000 ? 'Consider splitting large files' : 'File sizes within norms',
    })
  }

  return metrics
}

async function analyzeIncidentPatterns(cwd: string): Promise<IncidentPattern[]> {
  const patterns: IncidentPattern[] = []

  const fixCommits = await runShell(
    'git log --oneline --all --grep="fix" --grep="bug" --grep="patch" --grep="hotfix" --since="30 days ago" 2>/dev/null | head -20',
    SHELL_TIMEOUT_MS,
    cwd,
  )
  const fixCount = fixCommits.stdout.split('\n').filter((l) => l.trim()).length
  if (fixCount > 5) {
    const files = await runShell(
      'git log --oneline --all --grep="fix" --since="30 days ago" --name-only --pretty=format:"" 2>/dev/null | sort | uniq -c | sort -rn | head -5',
      SHELL_TIMEOUT_MS,
      cwd,
    )
    const affectedFiles = files.stdout.split('\n').filter((l) => l.trim()).map((l) => {
      const parts = l.trim().split(/\s+/)
      return parts[parts.length - 1] ?? ''
    }).filter((f) => f.length > 0)

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

function computeOverallHealth(metrics: HealthMetric[]): MonitorReport['overallHealth'] {
  const hasCritical = metrics.some((m) => m.status === 'critical')
  const warningCount = metrics.filter((m) => m.status === 'warning').length
  if (hasCritical) return 'unhealthy'
  if (warningCount > 2) return 'degraded'
  return 'healthy'
}

export const selfHealingMonitorTool: Tool = {
  name: 'self_healing_monitor',
  description:
    'Monitor project health by analyzing git activity, code quality metrics, incident patterns, and technical debt. Provides actionable recommendations for self-healing. Supports status (read-only) and analyze (deeper) modes.',
  input_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'Action: status (quick health check), analyze (deep analysis), deploy_monitor (track deployment health)',
        enum: ['status', 'analyze', 'deploy_monitor', 'auto_fix'],
      },
      path: { type: 'string', description: 'Project root directory (default: current directory)' },
    },
    required: ['action'],
  },
  async execute(input) {
    const action = optionalString(input.action, 'action') ?? 'status'
    const cwd = resolveWorkspacePath('.')

    if (action === 'auto_fix') {
      return 'auto_fix mode is not yet implemented. Use status or analyze for read-only health checks.'
    }

    if (action === 'deploy_monitor') {
      return 'deploy_monitor mode is not yet implemented. Use status or analyze for project health monitoring.'
    }

    const gitMetrics = await getGitActivity(cwd)
    const codeMetrics = await getCodeHealthMetrics(cwd)
    const allMetrics = [...gitMetrics, ...codeMetrics]

    let incidentPatterns: IncidentPattern[] = []
    if (action === 'analyze') {
      incidentPatterns = await analyzeIncidentPatterns(cwd)
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
  },
}

function formatReport(report: MonitorReport): string {
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
