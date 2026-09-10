import type { Tool } from './types.ts'
import { optionalString } from './args.ts'
import { runShell } from '../shell.ts'
import { resolveWorkspacePath } from '../autonomy/context.ts'

const SHELL_TIMEOUT_MS = 30_000

interface SpecSection {
  id: string
  title: string
  type: 'requirement' | 'constraint' | 'behavior' | 'interface' | 'edge-case'
  description: string
  verified: boolean
  evidence: string
  gaps: string[]
}

interface VerificationReport {
  specFile?: string
  codeFile?: string
  sections: SpecSection[]
  coverage: number
  totalRequirements: number
  verifiedRequirements: number
  summary: string
  recommendations: string[]
}

function parseSpecSections(spec: string): SpecSection[] {
  const sections: SpecSection[] = []
  const lines = spec.split('\n')
  let currentSection: Partial<SpecSection> | null = null

  for (const line of lines) {
    const headerMatch = line.match(/^#{1,3}\s+(.+)/)
    if (headerMatch) {
      if (currentSection?.id) {
        sections.push(currentSection as SpecSection)
      }
      currentSection = {
        id: `spec_${sections.length + 1}`,
        title: headerMatch[1]!.trim(),
        type: inferSpecType(headerMatch[1]!),
        description: '',
        verified: false,
        evidence: '',
        gaps: [],
      }
    } else if (currentSection) {
      currentSection.description += line + '\n'
    }
  }
  if (currentSection?.id) sections.push(currentSection as SpecSection)
  return sections
}

function inferSpecType(title: string): SpecSection['type'] {
  const lower = title.toLowerCase()
  if (/require|must|shall|should|need/.test(lower)) return 'requirement'
  if (/constraint|limit|boundary|max|min|allow/.test(lower)) return 'constraint'
  if (/behavior|flow|sequence|when|if.*then/.test(lower)) return 'behavior'
  if (/interface|api|endpoint|schema|contract/.test(lower)) return 'interface'
  if (/edge|corner|error|failure|exception/.test(lower)) return 'edge-case'
  return 'requirement'
}

function verifySection(section: SpecSection, code: string): SpecSection {
  const verified = { ...section }
  const codeLower = code.toLowerCase()
  const specWords = section.description
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 4)
    .slice(0, 20)

  let matchCount = 0
  for (const word of specWords) {
    if (codeLower.includes(word)) matchCount++
  }

  const coverageRatio = specWords.length > 0 ? matchCount / specWords.length : 0

  if (coverageRatio > 0.5) {
    verified.verified = true
    verified.evidence = `Found ${matchCount}/${specWords.length} key terms in implementation`
  } else if (coverageRatio > 0.2) {
    verified.verified = false
    verified.evidence = `Partial coverage: ${matchCount}/${specWords.length} key terms found`
    verified.gaps.push('Some specification terms not found in implementation')
  } else {
    verified.verified = false
    verified.evidence = `Low coverage: only ${matchCount}/${specWords.length} key terms found`
    verified.gaps.push('Specification requirements may not be implemented')
    verified.gaps.push('Review the implementation for missing functionality')
  }

  return verified
}

function analyzeCodePatterns(code: string): string[] {
  const patterns: string[] = []
  if (/export\s+(const|function|class)/.test(code)) patterns.push('exports public API')
  if (/import\s+.*from/.test(code)) patterns.push('has dependencies')
  if (/try\s*\{/.test(code)) patterns.push('handles errors')
  if (/async|await|Promise/.test(code)) patterns.push('uses async patterns')
  if (/test\(|describe\(|it\(|expect\(/.test(code)) patterns.push('has tests')
  if (/\.catch\(|reject/.test(code)) patterns.push('handles rejections')
  if (/validate|sanitize|escape/.test(code)) patterns.push('validates input')
  if (/timeout|abort|cancel/.test(code)) patterns.push('handles timeouts')
  return patterns
}

export const specVerifyTool: Tool = {
  name: 'spec_verify',
  description:
    'Verify that code implementation matches a specification. Parse the spec into requirements, check each against the codebase, and generate a coverage report with gaps and recommendations. Supports markdown specs, API contracts, or behavioral descriptions.',
  input_schema: {
    type: 'object',
    properties: {
      spec: { type: 'string', description: 'Specification text (markdown format)' },
      specFile: { type: 'string', description: 'Path to specification file' },
      codeFile: { type: 'string', description: 'Path to code file to verify against' },
      codeDir: { type: 'string', description: 'Directory of code to search for implementations' },
    },
  },
  async execute(input) {
    const cwd = resolveWorkspacePath('.')
    const specText = optionalString(input.spec, 'spec')
    const specFile = optionalString(input.specFile, 'specFile')
    const codeFile = optionalString(input.codeFile, 'codeFile')
    const codeDir = optionalString(input.codeDir, 'codeDir') ?? '.'

    let spec = ''
    if (specText) {
      spec = specText
    } else if (specFile) {
      const result = await runShell(`cat "${specFile}" 2>/dev/null`, SHELL_TIMEOUT_MS, cwd)
      spec = result.stdout
    }

    if (!spec.trim()) {
      return 'No specification provided. Use spec (text), specFile (path), or provide a markdown specification.'
    }

    let code = ''
    if (codeFile) {
      const result = await runShell(`cat "${codeFile}" 2>/dev/null`, SHELL_TIMEOUT_MS, cwd)
      code = result.stdout
    } else {
      const result = await runShell(
        `find "${codeDir}" -name "*.ts" -o -name "*.tsx" -o -name "*.js" | grep -v node_modules | head -50 | xargs cat 2>/dev/null`,
        SHELL_TIMEOUT_MS,
        cwd,
      )
      code = result.stdout
    }

    if (!code.trim()) {
      return 'No code found to verify against. Provide a codeFile or codeDir with source files.'
    }

    const sections = parseSpecSections(spec)
    if (sections.length === 0) {
      return 'No specification sections found. Ensure the spec has markdown headers (## or ###).'
    }

    const verifiedSections = sections.map((s) => verifySection(s, code))
    const verifiedCount = verifiedSections.filter((s) => s.verified).length
    const coverage = sections.length > 0 ? Math.round((verifiedCount / sections.length) * 100) : 0

    const codePatterns = analyzeCodePatterns(code)

    const recommendations: string[] = []
    const unverified = verifiedSections.filter((s) => !s.verified)
    if (unverified.length > 0) {
      recommendations.push(`${unverified.length} requirement(s) not verified — review implementation for gaps`)
    }
    if (!codePatterns.includes('has tests')) {
      recommendations.push('No tests detected — add tests to verify specification compliance')
    }
    if (!codePatterns.includes('handles errors')) {
      recommendations.push('No error handling detected — add try/catch for robustness')
    }
    if (!codePatterns.includes('validates input')) {
      recommendations.push('No input validation detected — add validation for specification constraints')
    }
    if (coverage >= 80) {
      recommendations.push('Good coverage — ensure edge cases from the spec are also handled')
    }

    const report: VerificationReport = {
      specFile: specFile ?? undefined,
      codeFile: codeFile ?? undefined,
      sections: verifiedSections,
      coverage,
      totalRequirements: sections.length,
      verifiedRequirements: verifiedCount,
      summary: `Verified ${verifiedCount}/${sections.length} specification requirements (${coverage}% coverage). Code patterns: ${codePatterns.join(', ')}.`,
      recommendations,
    }

    return formatReport(report)
  },
}

function formatReport(report: VerificationReport): string {
  const lines: string[] = []
  lines.push('=== Specification-to-Code Verification Report ===')
  if (report.specFile) lines.push(`Spec: ${report.specFile}`)
  if (report.codeFile) lines.push(`Code: ${report.codeFile}`)
  lines.push(`Coverage: ${report.coverage}% (${report.verifiedRequirements}/${report.totalRequirements})`)
  lines.push('')
  lines.push(report.summary)

  lines.push('')
  lines.push('--- Specification Requirements ---')
  for (const section of report.sections) {
    const icon = section.verified ? '✓' : '✗'
    lines.push(`  ${icon} [${section.type}] ${section.title}`)
    lines.push(`    ${section.evidence}`)
    if (section.gaps.length > 0) {
      for (const gap of section.gaps) {
        lines.push(`    Gap: ${gap}`)
      }
    }
  }

  lines.push('')
  lines.push('--- Recommendations ---')
  for (const rec of report.recommendations) {
    lines.push(`  * ${rec}`)
  }

  return lines.join('\n')
}
