import type { Tool } from './types.ts'
import { optionalString } from './args.ts'
import { runShell } from '../shell.ts'
import { resolveWorkspacePath } from '../autonomy/context.ts'

const SHELL_TIMEOUT_MS = 30_000
const MAX_FILES_ANALYZED = 100

interface ImpactNode {
  file: string
  changeType: 'modified' | 'added' | 'deleted' | 'renamed'
  riskLevel: 'low' | 'medium' | 'high' | 'critical'
  downstreamFiles: string[]
  testsAffected: string[]
  riskReason: string
}

interface ImpactReport {
  changedFiles: ImpactNode[]
  totalDownstreamFiles: number
  totalTestsAffected: number
  overallRisk: 'low' | 'medium' | 'high' | 'critical'
  riskScore: number
  summary: string
  recommendations: string[]
}

async function getChangedFiles(cwd: string, commit?: string): Promise<Array<{ file: string; type: string }>> {
  let cmd = 'git diff --name-status HEAD'
  if (commit) cmd = `git diff --name-status ${commit}^..${commit}`
  const result = await runShell(cmd, SHELL_TIMEOUT_MS, cwd)
  return result.stdout
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      const parts = l.split('\t')
      return { file: parts[1] ?? '', type: parts[0]?.charAt(0) ?? 'M' }
    })
    .filter((f) => f.file.length > 0)
}

async function findImporters(filePath: string, cwd: string): Promise<string[]> {
  const result = await runShell(
    `grep -rl --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" "${filePath.replace(/\.(ts|tsx|js|jsx)$/, '')}" . 2>/dev/null | grep -v node_modules | grep -v ".git/" | head -20`,
    SHELL_TIMEOUT_MS,
    cwd,
  )
  return result.stdout.split('\n').filter((l) => l.trim().length > 0 && l !== filePath)
}

async function findTestFiles(filePath: string, cwd: string): Promise<string[]> {
  const baseName = filePath.replace(/\.(ts|tsx|js|jsx)$/, '')
  const patterns = [
    `${baseName}.test.ts`,
    `${baseName}.test.tsx`,
    `${baseName}.spec.ts`,
    `${baseName}.spec.tsx`,
    `${baseName}.test.js`,
  ]
  const found: string[] = []
  for (const p of patterns) {
    const check = await runShell(`test -f "${p}" && echo "${p}"`, SHELL_TIMEOUT_MS, cwd)
    if (check.stdout.trim()) found.push(check.stdout.trim())
  }
  const dirResult = await runShell(
    `find . -path "*/node_modules" -prune -o -name "*${baseName}*test*" -print -o -name "*${baseName}*spec*" -print 2>/dev/null | head -5`,
    SHELL_TIMEOUT_MS,
    cwd,
  )
  for (const line of dirResult.stdout.split('\n')) {
    if (line.trim() && !found.includes(line.trim())) found.push(line.trim())
  }
  return found.slice(0, 10)
}

async function assessFileRisk(file: string, changeType: string, cwd: string): Promise<{ risk: string; reason: string }> {
  const ext = file.split('.').pop()?.toLowerCase() ?? ''

  if (changeType === 'D') return { risk: 'high', reason: 'File deletion may break imports' }
  if (changeType === 'R') return { risk: 'medium', reason: 'File rename requires updating all importers' }

  const criticalPatterns = ['config', 'auth', 'env', 'secret', 'token', 'deploy', 'migration', 'schema']
  for (const pattern of criticalPatterns) {
    if (file.toLowerCase().includes(pattern)) {
      return { risk: 'high', reason: `File matches critical pattern: ${pattern}` }
    }
  }

  if (['ts', 'tsx'].includes(ext)) {
    const sizeResult = await runShell(`wc -l < "${file}" 2>/dev/null || echo 0`, SHELL_TIMEOUT_MS, cwd)
    const lines = parseInt(sizeResult.stdout.trim(), 10)
    if (lines > 500) return { risk: 'medium', reason: `Large file (${lines} lines) — high blast radius` }
  }

  if (ext === 'json' || ext === 'yaml' || ext === 'yml') {
    return { risk: 'medium', reason: 'Configuration file change may affect behavior globally' }
  }

  if (ext === 'sql' || ext === 'prisma') {
    return { risk: 'critical', reason: 'Schema/migration change — irreversible in production' }
  }

  return { risk: 'low', reason: 'Standard source file change' }
}

export const predictiveImpactTool: Tool = {
  name: 'predictive_impact',
  description:
    'Predict the blast radius of code changes before they are committed. Analyzes which downstream files, modules, and tests will be affected, assigns risk scores, and provides actionable recommendations. Use with git diff, a specific commit, or a file path.',
  input_schema: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'Specific file to analyze impact for' },
      commit: { type: 'string', description: 'Commit hash to analyze' },
      maxFiles: { type: 'number', description: `Max changed files to analyze (1-${MAX_FILES_ANALYZED}, default 30)` },
    },
  },
  async execute(input) {
    const cwd = resolveWorkspacePath('.')
    const commit = optionalString(input.commit, 'commit')
    const maxFiles = Math.min(Math.max(typeof input.maxFiles === 'number' ? input.maxFiles : 30, 1), MAX_FILES_ANALYZED)

    const changedFiles = await getChangedFiles(cwd, commit)
    if (changedFiles.length === 0) {
      return 'No changes detected. Ensure there are uncommitted changes or provide a valid commit hash.'
    }

    const nodes: ImpactNode[] = []
    let totalDownstream = 0
    let totalTests = 0
    let maxRiskScore = 0

    const riskScores: Record<string, number> = { low: 1, medium: 3, high: 7, critical: 10 }

    for (const cf of changedFiles.slice(0, maxFiles)) {
      const { risk, reason } = await assessFileRisk(cf.file, cf.type, cwd)
      const downstream = await findImporters(cf.file, cwd)
      const tests = await findTestFiles(cf.file, cwd)

      const riskScore = riskScores[risk] ?? 1
      if (riskScore > maxRiskScore) maxRiskScore = riskScore

      totalDownstream += downstream.length
      totalTests += tests.length

      nodes.push({
        file: cf.file,
        changeType: cf.type === 'A' ? 'added' : cf.type === 'D' ? 'deleted' : cf.type === 'R' ? 'renamed' : 'modified',
        riskLevel: risk as ImpactNode['riskLevel'],
        downstreamFiles: downstream.slice(0, 10),
        testsAffected: tests,
        riskReason: reason,
      })
    }

    let overallRisk: ImpactReport['overallRisk'] = 'low'
    if (maxRiskScore >= 10) overallRisk = 'critical'
    else if (maxRiskScore >= 7) overallRisk = 'high'
    else if (maxRiskScore >= 3) overallRisk = 'medium'

    const riskScore = Math.min(100, maxRiskScore * 10 + totalDownstream * 2 + totalTests * 1)

    const recommendations: string[] = []
    if (overallRisk === 'critical') {
      recommendations.push('DO NOT commit without thorough review — schema/critical config changes detected')
    }
    if (totalTests > 0) {
      recommendations.push(`Run ${totalTests} affected test(s) before committing`)
    }
    if (totalDownstream > 5) {
      recommendations.push(`High downstream impact (${totalDownstream} files) — consider breaking the change into smaller PRs`)
    }
    const highRiskFiles = nodes.filter((n) => n.riskLevel === 'high' || n.riskLevel === 'critical')
    if (highRiskFiles.length > 0) {
      recommendations.push(`Review high-risk files: ${highRiskFiles.map((n) => n.file).join(', ')}`)
    }
    if (nodes.some((n) => n.changeType === 'deleted')) {
      recommendations.push('Deleted files detected — verify no remaining imports reference them')
    }
    if (recommendations.length === 0) {
      recommendations.push('Changes appear low-risk. Standard testing recommended.')
    }

    const report: ImpactReport = {
      changedFiles: nodes,
      totalDownstreamFiles: totalDownstream,
      totalTestsAffected: totalTests,
      overallRisk,
      riskScore,
      summary: `Analyzed ${nodes.length} changed file(s). ${totalDownstream} downstream file(s) and ${totalTests} test(s) may be affected. Overall risk: ${overallRisk}.`,
      recommendations,
    }

    return formatReport(report)
  },
}

function formatReport(report: ImpactReport): string {
  const lines: string[] = []
  lines.push('=== Predictive Impact Analysis Report ===')
  lines.push(`Overall risk: ${report.overallRisk.toUpperCase()} (score: ${report.riskScore}/100)`)
  lines.push(`Changed files: ${report.changedFiles.length}`)
  lines.push(`Downstream files affected: ${report.totalDownstreamFiles}`)
  lines.push(`Tests affected: ${report.totalTestsAffected}`)
  lines.push('')
  lines.push(report.summary)

  lines.push('')
  lines.push('--- Changed Files ---')
  for (const node of report.changedFiles) {
    const icon = node.riskLevel === 'critical' ? '!!!' : node.riskLevel === 'high' ? '!!' : node.riskLevel === 'medium' ? '!' : '-'
    lines.push(`  ${icon} [${node.changeType}] ${node.file} (${node.riskLevel})`)
    lines.push(`    Reason: ${node.riskReason}`)
    if (node.downstreamFiles.length > 0) {
      lines.push(`    Downstream: ${node.downstreamFiles.join(', ')}`)
    }
    if (node.testsAffected.length > 0) {
      lines.push(`    Tests: ${node.testsAffected.join(', ')}`)
    }
    lines.push('')
  }

  lines.push('--- Recommendations ---')
  for (const rec of report.recommendations) {
    lines.push(`  * ${rec}`)
  }

  return lines.join('\n')
}
