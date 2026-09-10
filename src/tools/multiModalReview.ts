import type { Tool } from './types.ts'
import { optionalString } from './args.ts'
import { runShell } from '../shell.ts'
import { resolveWorkspacePath } from '../autonomy/context.ts'

const SHELL_TIMEOUT_MS = 30_000
const MAX_DIFF_LINES = 300

interface ReviewDimension {
  name: string
  score: number
  maxScore: number
  findings: string[]
  suggestions: string[]
}

interface ReviewReport {
  file?: string
  commit?: string
  dimensions: ReviewDimension[]
  overallScore: number
  summary: string
}

function analyzeCodeComplexity(code: string): ReviewDimension {
  const lines = code.split('\n')
  const findings: string[] = []
  const suggestions: string[] = []
  let score = 10

  const longFunctions = code.split(/\n(?=(?:export\s+)?(?:async\s+)?(?:function|const\s+\w+\s*=\s*(?:async\s+)?))/)
  for (const fn of longFunctions) {
    const fnLines = fn.split('\n').length
    if (fnLines > 50) {
      findings.push(`Function is ${fnLines} lines long — consider breaking it up`)
      score -= 2
    }
  }

  const maxIndent = lines.reduce((max, line) => {
    const indent = line.match(/^(\s*)/)?.[1]?.length ?? 0
    return Math.max(max, indent)
  }, 0)
  if (maxIndent > 24) {
    findings.push(`Deep nesting detected (${maxIndent / 2}+ levels) — extract nested logic`)
    score -= 2
  }

  const complexityIndicators = [
    /\bif\s*\(.*\bif\s*\(/,
    /\belse\s*{[^}]*\belse\s*{/,
    /\bcase\s+.*:[\s\S]*?case\s+.*:[\s\S]*?case\s+./,
  ]
  for (const pattern of complexityIndicators) {
    if (pattern.test(code)) {
      findings.push('High cyclomatic complexity detected')
      score -= 1
      break
    }
  }

  if (lines.length > 300) {
    findings.push(`File is ${lines.length} lines — consider splitting`)
    score -= 1
  }

  suggestions.push('Consider adding JSDoc comments for public functions')
  suggestions.push('Add input validation at function boundaries')

  return { name: 'Complexity', score: Math.max(0, score), maxScore: 10, findings, suggestions }
}

function analyzeSecurity(code: string): ReviewDimension {
  const findings: string[] = []
  const suggestions: string[] = []
  let score = 10

  const securityPatterns = [
    { pattern: /eval\s*\(/, issue: 'eval() usage — potential code injection', severity: 3 },
    { pattern: /innerHTML\s*=/, issue: 'innerHTML assignment — potential XSS', severity: 3 },
    { pattern: /dangerouslySetInnerHTML/, issue: 'dangerouslySetInnerHTML — potential XSS', severity: 2 },
    { pattern: /exec\s*\(/, issue: 'exec() usage — potential command injection', severity: 3 },
    { pattern: /\bpassword\b.*=\s*['"]/, issue: 'Hardcoded password detected', severity: 3 },
    { pattern: /\bapi[_-]?key\b.*=\s*['"]/, issue: 'Hardcoded API key detected', severity: 3 },
    { pattern: /new\s+Function\s*\(/, issue: 'Dynamic function creation — potential injection', severity: 2 },
    { pattern: /\bMath\.random\b/, issue: 'Math.random() — not cryptographically secure', severity: 1 },
  ]

  for (const { pattern, issue, severity } of securityPatterns) {
    if (pattern.test(code)) {
      findings.push(issue)
      score -= severity
    }
  }

  if (findings.length === 0) {
    suggestions.push('No security issues detected — maintain current practices')
  } else {
    suggestions.push('Review and remediate security findings before shipping')
  }

  return { name: 'Security', score: Math.max(0, score), maxScore: 10, findings, suggestions }
}

function analyzePerformance(code: string): ReviewDimension {
  const findings: string[] = []
  const suggestions: string[] = []
  let score = 10

  if (/\.forEach\s*\(/.test(code) && /\.map\s*\(/.test(code)) {
    findings.push('Mixed forEach/map usage — prefer functional patterns consistently')
    score -= 1
  }

  if (/JSON\.parse\s*\(\s*JSON\.stringify/.test(code)) {
    findings.push('Deep clone via JSON round-trip — use structuredClone() or a library')
    score -= 2
  }

  if (/\.includes\(.*\.includes\(/.test(code)) {
    findings.push('Nested includes() — O(n*m) complexity, consider using a Set')
    score -= 1
  }

  if (/new\s+RegExp\s*\(/.test(code) && !/ RegExp\.escape/.test(code)) {
    findings.push('Dynamic RegExp construction — validate input to prevent ReDoS')
    score -= 1
  }

  if (/for\s*\(\s*let\s+\w+\s*=\s*0\s*;.*\.length/.test(code)) {
    suggestions.push('Cache array length in loop condition for performance')
  }

  if (findings.length === 0) {
    suggestions.push('No performance issues detected')
  }

  return { name: 'Performance', score: Math.max(0, score), maxScore: 10, findings, suggestions }
}

function analyzeTesting(code: string): ReviewDimension {
  const findings: string[] = []
  const suggestions: string[] = []
  let score = 10

  const hasTests = /describe\s*\(|it\s*\(|test\s*\(|expect\s*\(/.test(code)
  if (!hasTests && code.length > 200) {
    findings.push('No test patterns found in file > 200 lines')
    score -= 2
  }

  const hasMocking = /jest\.mock|vi\.mock|sinon|jest\.spy/.test(code)
  if (hasMocking && !/clearAllMocks|resetAllMocks|restoreAllMocks/.test(code)) {
    findings.push('Mocks used without cleanup — may cause test pollution')
    score -= 1
  }

  suggestions.push('Add edge case tests for boundary conditions')
  suggestions.push('Ensure error paths are tested')

  return { name: 'Testing', score: Math.max(0, score), maxScore: 10, findings, suggestions }
}

function analyzeDocumentation(code: string): ReviewDimension {
  const findings: string[] = []
  const suggestions: string[] = []
  let score = 10

  const exports = code.match(/\bexport\s+(?:const|function|class|interface|type)\s+(\w+)/g) ?? []
  const jsdocComments = code.match(/\/\*\*[\s\S]*?\*\//g) ?? []
  const ratio = exports.length > 0 ? jsdocComments.length / exports.length : 1

  if (exports.length > 3 && ratio < 0.3) {
    findings.push(`${exports.length} exports but only ${jsdocComments.length} JSDoc comments`)
    score -= 2
  }

  if (/TODO|FIXME|HACK|XXX/.test(code)) {
    const todos = (code.match(/(?:TODO|FIXME|HACK|XXX)/g) ?? []).length
    findings.push(`${todos} TODO/FIXME comments — address before shipping`)
    score -= 1
  }

  suggestions.push('Add JSDoc for all exported functions and types')
  suggestions.push('Document complex algorithms with inline comments')

  return { name: 'Documentation', score: Math.max(0, score), maxScore: 10, findings, suggestions }
}

function analyzeMaintainability(code: string): ReviewDimension {
  const findings: string[] = []
  const suggestions: string[] = []
  let score = 10

  const magicNumbers = code.match(/\b(?:[2-9]\d{2,}|[1-9]\d{3,})\b/g) ?? []
  if (magicNumbers.length > 3) {
    findings.push(`${magicNumbers.length} magic numbers — extract to named constants`)
    score -= 2
  }

  const consoleLogs = (code.match(/console\.(log|warn|error|debug)/g) ?? []).length
  if (consoleLogs > 5) {
    findings.push(`${consoleLogs} console statements — use a logging framework`)
    score -= 1
  }

  if (/any\b/.test(code) && /:\s*any\b/.test(code)) {
    findings.push('TypeScript "any" type usage — weaken type safety')
    score -= 1
  }

  suggestions.push('Use named constants instead of magic numbers')
  suggestions.push('Replace console.log with structured logging')

  return { name: 'Maintainability', score: Math.max(0, score), maxScore: 10, findings, suggestions }
}

export const multiModalReviewTool: Tool = {
  name: 'multi_modal_review',
  description:
    'Comprehensive code review across multiple dimensions: complexity, security, performance, testing, documentation, and maintainability. Analyzes a file, commit diff, or raw code and returns a scored report with actionable findings.',
  input_schema: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'Repo-relative file path to review' },
      commit: { type: 'string', description: 'Commit hash to review the diff of' },
      code: { type: 'string', description: 'Raw code to review (alternative to file/commit)' },
      dimensions: { type: 'string', description: 'Comma-separated dimensions to check: complexity,security,performance,testing,documentation,maintainability (default: all)' },
    },
  },
  async execute(input) {
    const cwd = resolveWorkspacePath('.')
    const file = optionalString(input.file, 'file')
    const commit = optionalString(input.commit, 'commit')
    const codeInput = optionalString(input.code, 'code')
    const dimensionsFilter = optionalString(input.dimensions, 'dimensions')?.split(',').map((d) => d.trim()) ?? []

    let code = ''
    let source = ''

    if (codeInput) {
      code = codeInput
      source = 'provided code'
    } else if (commit) {
      const result = await runShell(`git show ${commit} -- patch`, SHELL_TIMEOUT_MS, cwd)
      code = result.stdout
      source = `commit ${commit}`
    } else if (file) {
      const result = await runShell(`cat "${file}" 2>/dev/null`, SHELL_TIMEOUT_MS, cwd)
      code = result.stdout
      source = file
    } else {
      const result = await runShell(`git diff HEAD -- .`, SHELL_TIMEOUT_MS, cwd)
      code = result.stdout
      source = 'working tree diff'
    }

    if (!code.trim()) {
      return `No code found to review for: ${source}`
    }

    const allDimensions: ReviewDimension[] = [
      analyzeCodeComplexity(code),
      analyzeSecurity(code),
      analyzePerformance(code),
      analyzeTesting(code),
      analyzeDocumentation(code),
      analyzeMaintainability(code),
    ]

    const dimensions = dimensionsFilter.length > 0
      ? allDimensions.filter((d) => dimensionsFilter.includes(d.name.toLowerCase()))
      : allDimensions

    const totalScore = dimensions.reduce((sum, d) => sum + d.score, 0)
    const totalMax = dimensions.reduce((sum, d) => sum + d.maxScore, 0)
    const overallScore = totalMax > 0 ? Math.round((totalScore / totalMax) * 100) : 100

    const report: ReviewReport = {
      file: file ?? undefined,
      commit: commit ?? undefined,
      dimensions,
      overallScore,
      summary: `Reviewed ${source} across ${dimensions.length} dimensions. Overall score: ${overallScore}/100.`,
    }

    return formatReport(report)
  },
}

function formatReport(report: ReviewReport): string {
  const lines: string[] = []
  lines.push('=== Multi-Modal Code Review Report ===')
  if (report.file) lines.push(`File: ${report.file}`)
  if (report.commit) lines.push(`Commit: ${report.commit}`)
  lines.push(`Overall score: ${report.overallScore}/100`)
  lines.push('')
  lines.push(report.summary)

  for (const dim of report.dimensions) {
    const bar = '█'.repeat(Math.round(dim.score / dim.maxScore * 10)) + '░'.repeat(10 - Math.round(dim.score / dim.maxScore * 10))
    lines.push('')
    lines.push(`--- ${dim.name} [${bar}] ${dim.score}/${dim.maxScore} ---`)
    if (dim.findings.length > 0) {
      for (const f of dim.findings) lines.push(`  ! ${f}`)
    } else {
      lines.push('  No issues found')
    }
    if (dim.suggestions.length > 0) {
      for (const s of dim.suggestions) lines.push(`  > ${s}`)
    }
  }

  return lines.join('\n')
}
