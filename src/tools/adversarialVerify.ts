import type { Tool } from './types.ts'
import { optionalString } from './args.ts'
import { runShell } from '../shell.ts'
import { resolveWorkspacePath } from '../autonomy/context.ts'

const SHELL_TIMEOUT_MS = 30_000
const MAX_DIFF_LINES = 500

interface EdgeCase {
  type: 'boundary' | 'null' | 'race' | 'injection' | 'overflow' | 'encoding' | 'concurrency'
  description: string
  severity: 'low' | 'medium' | 'high' | 'critical'
  location: string
  testSuggestion: string
}

interface ExploitVector {
  type: string
  vector: string
  impact: string
  mitigation: string
}

interface AdversarialReport {
  target: string
  diffLines: number
  edgeCases: EdgeCase[]
  exploitVectors: ExploitVector[]
  riskScore: number
  summary: string
}

function classifyEdgeCase(line: string, filePath: string): EdgeCase | null {
  const trimmed = line.trim()

  if (/\b(parseInt|parseFloat|Number)\b/.test(trimmed) && /\+|-\*|\/|%/.test(trimmed)) {
    return {
      type: 'overflow',
      description: 'Numeric operation without explicit bounds checking',
      severity: 'medium',
      location: filePath,
      testSuggestion: 'Test with Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, NaN, and Infinity inputs',
    }
  }

  if (/\.length\s*[><=]/.test(trimmed) && !/\.length\s*>\s*0/.test(trimmed)) {
    return {
      type: 'boundary',
      description: 'Length comparison without explicit upper bound',
      severity: 'low',
      location: filePath,
      testSuggestion: 'Test with empty arrays/strings and extremely large inputs',
    }
  }

  if (/\bawait\b.*\bfetch\b|\bhttp\b.*\brequest\b/.test(trimmed)) {
    return {
      type: 'race',
      description: 'Async network operation without timeout or abort controller',
      severity: 'high',
      location: filePath,
      testSuggestion: 'Test with slow/failing network, timeout after 100ms, and concurrent requests',
    }
  }

  if (/innerHTML|dangerouslySetInnerHTML|eval\(|Function\(/.test(trimmed)) {
    return {
      type: 'injection',
      description: 'Potential code injection vector',
      severity: 'critical',
      location: filePath,
      testSuggestion: 'Test with XSS payloads: <script>alert(1)</script>, javascript:, and event handlers',
    }
  }

  if (/\bexec\b|\bspawn\b|\bchild_process\b/.test(trimmed)) {
    return {
      type: 'injection',
      description: 'Shell command execution without input sanitization',
      severity: 'critical',
      location: filePath,
      testSuggestion: 'Test with shell metacharacters: ; | & $ ` ( ) { } < > \\n',
    }
  }

  if (/Buffer\.from|Buffer\.alloc|new Buffer/.test(trimmed) && !/encoding/.test(trimmed)) {
    return {
      type: 'encoding',
      description: 'Buffer operation without explicit encoding specification',
      severity: 'low',
      location: filePath,
      testSuggestion: 'Test with binary data, UTF-8 edge cases, and invalid byte sequences',
    }
  }

  if (/\bnew Promise\b.*\bresolve\b|\bnew Promise\b.*\breject\b/.test(trimmed)) {
    return {
      type: 'concurrency',
      description: 'Promise construction without error propagation guarantee',
      severity: 'medium',
      location: filePath,
      testSuggestion: 'Test with rejected promises, thrown errors inside executor, and unhandled rejections',
    }
  }

  return null
}

function classifyExploitVector(line: string, filePath: string): ExploitVector | null {
  const trimmed = line.trim()

  if (/req\.params|req\.query|req\.body/.test(trimmed) && !/sanitize|validate|escape/.test(trimmed)) {
    return {
      type: 'input-validation',
      vector: 'Unsanitized request data used directly',
      impact: 'SQL injection, XSS, or command injection',
      mitigation: 'Validate and sanitize all user inputs before use',
    }
  }

  if (/localStorage|sessionStorage/.test(trimmed)) {
    return {
      type: 'storage',
      vector: 'Client-side storage without integrity checks',
      impact: 'Data tampering or XSS via stored payloads',
      mitigation: 'Use signed/encrypted tokens or server-side storage',
    }
  }

  if (/cors|Access-Control-Allow-Origin/.test(trimmed) && /\*/.test(trimmed)) {
    return {
      type: 'cors',
      vector: 'Permissive CORS policy allows any origin',
      impact: 'Cross-origin data theft or CSRF attacks',
      mitigation: 'Restrict CORS to specific trusted origins',
    }
  }

  return null
}

export const adversarialVerifyTool: Tool = {
  name: 'adversarial_verify',
  description:
    'Generate adversarial test cases against a diff or code change. Analyzes the diff for edge cases, exploit vectors, race conditions, and boundary violations. Returns a risk-scored report with concrete test suggestions.',
  input_schema: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'Repo-relative file to analyze (or use diff for full diff)' },
      diff: { type: 'string', description: 'Raw diff text to analyze (alternative to file)' },
      commit: { type: 'string', description: 'Commit hash to analyze (shows diff for that commit)' },
      severity: { type: 'string', description: 'Minimum severity to report: low, medium, high, critical (default: low)' },
    },
  },
  async execute(input) {
    const cwd = resolveWorkspacePath('.')
    const file = optionalString(input.file, 'file')
    const diffInput = optionalString(input.diff, 'diff')
    const commit = optionalString(input.commit, 'commit')
    const minSeverity = optionalString(input.severity, 'severity') ?? 'low'

    let diffText = ''

    if (diffInput) {
      diffText = diffInput
    } else if (commit) {
      const result = await runShell(`git show ${commit} --stat --patch`, SHELL_TIMEOUT_MS, cwd)
      diffText = result.stdout
    } else if (file) {
      const result = await runShell(`git diff HEAD -- "${file}"`, SHELL_TIMEOUT_MS, cwd)
      diffText = result.stdout
      if (!diffText.trim()) {
        const showResult = await runShell(`git show HEAD:"${file}" 2>/dev/null | head -${MAX_DIFF_LINES}`, SHELL_TIMEOUT_MS, cwd)
        diffText = showResult.stdout
      }
    } else {
      const result = await runShell(`git diff HEAD -- .`, SHELL_TIMEOUT_MS, cwd)
      diffText = result.stdout
    }

    if (!diffText.trim()) {
      return 'No diff content found to analyze. Ensure the file has uncommitted changes or provide a specific commit.'
    }

    const addedLines = diffText
      .split('\n')
      .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
      .slice(0, MAX_DIFF_LINES)

    const diffFiles = diffText
      .split('\n')
      .filter((l) => l.startsWith('diff --git'))
      .map((l) => {
        const match = l.match(/b\/(.+)$/)
        return match?.[1] ?? 'unknown'
      })

    const edgeCases: EdgeCase[] = []
    const exploitVectors: ExploitVector[] = []
    const severityOrder = { low: 0, medium: 1, high: 2, critical: 3 }

    for (const line of addedLines) {
      for (const targetFile of diffFiles) {
        const edgeCase = classifyEdgeCase(line, targetFile)
        if (edgeCase && severityOrder[edgeCase.severity] >= severityOrder[minSeverity as keyof typeof severityOrder]) {
          edgeCases.push(edgeCase)
        }
        const exploit = classifyExploitVector(line, targetFile)
        if (exploit) exploitVectors.push(exploit)
      }
    }

    const seen = new Set<string>()
    const uniqueEdgeCases = edgeCases.filter((e) => {
      const key = `${e.type}:${e.description}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

    const exploitSeen = new Set<string>()
    const uniqueExploits = exploitVectors.filter((e) => {
      const key = `${e.type}:${e.vector}`
      if (exploitSeen.has(key)) return false
      exploitSeen.add(key)
      return true
    })

    let riskScore = 0
    for (const ec of uniqueEdgeCases) {
      if (ec.severity === 'critical') riskScore += 30
      else if (ec.severity === 'high') riskScore += 15
      else if (ec.severity === 'medium') riskScore += 5
      else riskScore += 1
    }
    for (const ev of uniqueExploits) riskScore += 20
    riskScore = Math.min(100, riskScore)

    const report: AdversarialReport = {
      target: file ?? commit ?? 'full diff',
      diffLines: addedLines.length,
      edgeCases: uniqueEdgeCases,
      exploitVectors: uniqueExploits,
      riskScore,
      summary: `Analyzed ${addedLines.length} added lines across ${diffFiles.length} file(s). Found ${uniqueEdgeCases.length} edge case(s) and ${uniqueExploits.length} exploit vector(s). Risk score: ${riskScore}/100.`,
    }

    return formatReport(report)
  },
}

function formatReport(report: AdversarialReport): string {
  const lines: string[] = []
  lines.push('=== Adversarial Pre-Ship Verification Report ===')
  lines.push(`Target: ${report.target}`)
  lines.push(`Diff lines analyzed: ${report.diffLines}`)
  lines.push(`Risk score: ${report.riskScore}/100`)
  lines.push('')
  lines.push(report.summary)

  if (report.edgeCases.length > 0) {
    lines.push('')
    lines.push('--- Edge Cases ---')
    for (const ec of report.edgeCases) {
      lines.push(`  [${ec.severity.toUpperCase()}] ${ec.type}: ${ec.description}`)
      lines.push(`    Location: ${ec.location}`)
      lines.push(`    Test: ${ec.testSuggestion}`)
      lines.push('')
    }
  }

  if (report.exploitVectors.length > 0) {
    lines.push('--- Exploit Vectors ---')
    for (const ev of report.exploitVectors) {
      lines.push(`  [${ev.type}] ${ev.vector}`)
      lines.push(`    Impact: ${ev.impact}`)
      lines.push(`    Mitigation: ${ev.mitigation}`)
      lines.push('')
    }
  }

  if (report.riskScore === 0) {
    lines.push('No adversarial issues detected. Code appears safe for shipping.')
  } else if (report.riskScore < 30) {
    lines.push('Low risk. Consider adding targeted tests for identified edge cases.')
  } else if (report.riskScore < 70) {
    lines.push('Medium risk. Address exploit vectors and add boundary tests before shipping.')
  } else {
    lines.push('HIGH RITICAL: Do not ship without addressing critical issues above.')
  }

  return lines.join('\n')
}
