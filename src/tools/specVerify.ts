import type { Tool } from './types.ts'
import { optionalString } from './args.ts'
import { resolveWorkspacePath } from '../autonomy/context.ts'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'])
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt', '.cache', '.elia', '.turbo', '.opencode'])

export interface SpecSection {
  id: string
  title: string
  type: 'requirement' | 'constraint' | 'behavior' | 'interface' | 'edge-case'
  description: string
  verified: boolean
  evidence: string
  gaps: string[]
}

export interface VerificationReport {
  specFile?: string
  codeFile?: string
  sections: SpecSection[]
  coverage: number
  totalRequirements: number
  verifiedRequirements: number
  summary: string
  recommendations: string[]
}

/** Walk a directory and return concatenated source text (deterministic, sorted, capped). */
export function readCodeDirectory(dir: string, maxFiles = 50, maxBytes = 2_000_000): string {
  const parts: string[] = []
  let count = 0
  let bytes = 0

  function walk(current: string): void {
    if (count >= maxFiles || bytes >= maxBytes) return
    let entries: string[]
    try {
      entries = readdirSync(current)
    } catch {
      return
    }
    entries.sort()
    for (const entry of entries) {
      if (count >= maxFiles || bytes >= maxBytes) return
      const full = join(current, entry)
      let stat: ReturnType<typeof statSync>
      try {
        stat = statSync(full)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        if (!SKIP_DIRS.has(entry)) walk(full)
      } else if (stat.isFile() && SOURCE_EXTENSIONS.has(extname(entry))) {
        try {
          const content = readFileSync(full, 'utf-8')
          parts.push(`\n// FILE: ${entry}\n${content}`)
          count++
          bytes += content.length
        } catch {
          // skip unreadable files
        }
      }
    }
  }

  walk(dir)
  return parts.join('')
}

export function readTextFile(cwd: string, file: string): string {
  const abs = join(cwd, file)
  if (!existsSync(abs)) return ''
  try {
    return readFileSync(abs, 'utf-8')
  } catch {
    return ''
  }
}

export function parseSpecSections(spec: string): SpecSection[] {
  const sections: SpecSection[] = []
  const lines = spec.split('\n')
  let currentSection: Partial<SpecSection> | null = null

  for (const line of lines) {
    const headerMatch = line.match(/^#{2,3}\s+(.+)/)
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

export function inferSpecType(title: string): SpecSection['type'] {
  const lower = title.toLowerCase()
  if (/require|must|shall|should|need/.test(lower)) return 'requirement'
  if (/constraint|limit|boundary|max|min|allow/.test(lower)) return 'constraint'
  if (/behavior|flow|sequence|when|if.*then/.test(lower)) return 'behavior'
  if (/interface|api|endpoint|schema|contract/.test(lower)) return 'interface'
  if (/edge|corner|error|failure|exception/.test(lower)) return 'edge-case'
  return 'requirement'
}

export function verifySection(section: SpecSection, code: string): SpecSection {
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

export function analyzeCodePatterns(code: string): string[] {
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

/** Deterministic spec-to-code verification over already-loaded text. */
export function verifySpecification(spec: string, code: string, ctx: { specFile?: string; codeFile?: string } = {}): VerificationReport {
  const sections = parseSpecSections(spec)
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

  return {
    specFile: ctx.specFile,
    codeFile: ctx.codeFile,
    sections: verifiedSections,
    coverage,
    totalRequirements: sections.length,
    verifiedRequirements: verifiedCount,
    summary: `Verified ${verifiedCount}/${sections.length} specification requirements (${coverage}% coverage). Code patterns: ${codePatterns.join(', ')}.`,
    recommendations,
  }
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
      spec = readTextFile(cwd, specFile)
    }

    if (!spec.trim()) {
      return 'No specification provided. Use spec (text), specFile (path), or provide a markdown specification.'
    }

    let code = ''
    if (codeFile) {
      code = readTextFile(cwd, codeFile)
    } else {
      code = readCodeDirectory(join(cwd, codeDir))
    }

    if (!code.trim()) {
      return 'No code found to verify against. Provide a codeFile or codeDir with source files.'
    }

    const report = verifySpecification(spec, code, { specFile: specFile ?? undefined, codeFile: codeFile ?? undefined })
    if (report.totalRequirements === 0) {
      return 'No specification sections found. Ensure the spec has markdown headers (## or ###).'
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
