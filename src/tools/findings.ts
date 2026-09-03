import { existsSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { Tool } from './types.ts'
import { captureBeforeWrite } from '../checkpoint.ts'
import { redactSecrets } from '../ui/redact.ts'
import { engagementDir } from './engagement.ts'

const SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'] as const
type Severity = (typeof SEVERITIES)[number]
const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }
const MAX_FIELD = 20_000
const EVIDENCE_EXCERPT_LINES = 40

interface Finding {
  id: string
  title: string
  severity: Severity
  description: string
  remediation: string
  /** recon/-relative paths to the tool output that supports this finding. */
  evidence: string[]
  recordedAt: string
}

function text(input: unknown, name: string, max = MAX_FIELD): string {
  if (typeof input !== 'string' || input.trim().length === 0) throw new Error(`${name} must be a non-empty string`)
  if (input.length > max) throw new Error(`${name} exceeds ${max} characters`)
  return input.trim()
}

function requireScaffolded(slug: string): string {
  const dir = engagementDir(slug)
  if (!existsSync(join(dir, 'SCOPE.md'))) {
    throw new Error(`No engagement "${slug}" found (missing ${join(dir, 'SCOPE.md')}). Run new_engagement first.`)
  }
  return dir
}

/** Resolve a caller-supplied evidence reference to a path that must sit inside the engagement's recon/ folder. */
function resolveEvidencePath(dir: string, reference: string): string {
  const reconDir = resolve(join(dir, 'recon'))
  const raw = reference.trim().replace(/^recon[\\/]/i, '')
  if (raw.length === 0) throw new Error('evidence entries must be non-empty')
  const resolved = isAbsolute(raw) ? resolve(raw) : resolve(join(reconDir, raw))
  const rel = relative(reconDir, resolved)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`evidence "${reference}" is outside the engagement's recon/ folder`)
  }
  return resolved
}

async function readFindings(dir: string): Promise<Finding[]> {
  const file = Bun.file(join(dir, 'findings.jsonl'))
  if (!(await file.exists())) return []
  const raw = await file.text()
  const findings: Finding[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      findings.push(JSON.parse(trimmed) as Finding)
    } catch {
      // A hand-edited or truncated ledger line is skipped rather than aborting the report.
    }
  }
  return findings
}

function renderFindingBlock(finding: Finding): string {
  return [
    `### [${finding.severity.toUpperCase()}] ${finding.title}  (${finding.id})`,
    '',
    finding.description,
    '',
    `**Remediation:** ${finding.remediation}`,
    '',
    `**Evidence:** ${finding.evidence.map((entry) => `recon/${entry}`).join(', ')}`,
    '',
  ].join('\n')
}

export const logFindingTool: Tool = {
  name: 'log_finding',
  description:
    "Record a confirmed finding for an authorized engagement. Every finding must cite evidence: one or more files under the engagement's recon/ folder (produced by run_security_tool or http_probe). A finding whose evidence files do not exist is rejected — go capture the evidence first. Findings are appended to findings.jsonl (machine-readable) and findings.md (human-readable); engagement_report turns them into report.md.",
  input_schema: {
    type: 'object',
    properties: {
      engagement: { type: 'string', description: 'The engagement slug (from new_engagement)' },
      title: { type: 'string', description: 'Short finding title, e.g. "Reflected XSS in search parameter"' },
      severity: { type: 'string', enum: [...SEVERITIES], description: 'info | low | medium | high | critical' },
      description: { type: 'string', description: 'What the issue is, where it is, and why it matters' },
      remediation: { type: 'string', description: 'How to fix it' },
      evidence: {
        type: 'array',
        items: { type: 'string' },
        description: 'recon/-relative filenames that demonstrate the finding, e.g. ["1699-nmap-full.log", "traffic.jsonl"]',
      },
    },
    required: ['engagement', 'title', 'severity', 'description', 'remediation', 'evidence'],
  },
  async execute(input) {
    const slug = text(input.engagement, 'engagement', 200)
    const title = text(input.title, 'title', 500)
    const severity = text(input.severity, 'severity', 20) as Severity
    if (!SEVERITIES.includes(severity)) throw new Error(`severity must be one of ${SEVERITIES.join(', ')}`)
    const description = text(input.description, 'description')
    const remediation = text(input.remediation, 'remediation')
    if (!Array.isArray(input.evidence) || input.evidence.length === 0) {
      throw new Error('evidence must be a non-empty array of recon/-relative filenames — a finding needs tool output behind it')
    }

    const dir = requireScaffolded(slug)
    const evidence: string[] = []
    const missing: string[] = []
    for (const entry of input.evidence) {
      if (typeof entry !== 'string') throw new Error('evidence entries must be strings')
      const resolved = resolveEvidencePath(dir, entry)
      const normalized = relative(resolve(join(dir, 'recon')), resolved).replace(/\\/g, '/')
      if (!existsSync(resolved)) missing.push(`recon/${normalized}`)
      else if (!evidence.includes(normalized)) evidence.push(normalized)
    }
    if (missing.length > 0) {
      throw new Error(
        `Evidence not found: ${missing.join(', ')}. Run run_security_tool or http_probe for "${slug}" to capture it, then log the finding referencing the saved file.`,
      )
    }

    const existing = await readFindings(dir)
    const id = `F-${String(existing.length + 1).padStart(3, '0')}`
    const finding: Finding = { id, title, severity, description, remediation, evidence, recordedAt: new Date().toISOString() }

    const jsonlPath = join(dir, 'findings.jsonl')
    await captureBeforeWrite(jsonlPath)
    await Bun.write(jsonlPath, `${[...existing, finding].map((entry) => JSON.stringify(entry)).join('\n')}\n`)

    const mdPath = join(dir, 'findings.md')
    const header = `# Findings: ${slug}\n\n<!-- Appended by log_finding. Run engagement_report to compile report.md. -->\n`
    const blocks = [...existing, finding].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]).map(renderFindingBlock)
    await captureBeforeWrite(mdPath)
    await Bun.write(mdPath, `${header}\n${blocks.join('\n')}`)

    return `Logged ${id} [${severity}] "${title}" with ${evidence.length} evidence file(s): ${evidence.join(', ')}`
  },
}

export const engagementReportTool: Tool = {
  name: 'engagement_report',
  description:
    "Compile report.md for an authorized engagement from its logged findings. Orders findings by severity, embeds a short excerpt of each finding's evidence file for reproducibility, and flags any finding whose evidence file has since gone missing as unverified (the report is then marked a draft). Run after logging findings with log_finding.",
  input_schema: {
    type: 'object',
    properties: {
      engagement: { type: 'string', description: 'The engagement slug (from new_engagement)' },
    },
    required: ['engagement'],
  },
  async execute(input) {
    const slug = text(input.engagement, 'engagement', 200)
    const dir = requireScaffolded(slug)
    const findings = await readFindings(dir)
    if (findings.length === 0) {
      return `No findings logged for "${slug}" yet. Use log_finding first, then engagement_report.`
    }

    const scope = (await Bun.file(join(dir, 'SCOPE.md')).text().catch(() => '')).trim()
    const ordered = [...findings].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
    const reconDir = resolve(join(dir, 'recon'))
    const unverified: string[] = []

    const sections: string[] = []
    for (const finding of ordered) {
      const excerpts: string[] = []
      for (const entry of finding.evidence) {
        const path = resolve(join(reconDir, entry))
        if (!existsSync(path)) {
          unverified.push(`${finding.id} (missing recon/${entry})`)
          continue
        }
        const body = await Bun.file(path).text().catch(() => '')
        const excerpt = body.split('\n').slice(0, EVIDENCE_EXCERPT_LINES).join('\n')
        excerpts.push(`<details><summary>recon/${entry}</summary>\n\n\`\`\`\n${redactSecrets(excerpt)}\n\`\`\`\n</details>`)
      }
      sections.push(
        [
          `### [${finding.severity.toUpperCase()}] ${finding.title}  (${finding.id})`,
          '',
          finding.description,
          '',
          `**Remediation:** ${finding.remediation}`,
          '',
          `**Reproduction / evidence:**`,
          '',
          excerpts.length > 0 ? excerpts.join('\n\n') : '_Evidence file missing — this finding is unverified._',
          '',
        ].join('\n'),
      )
    }

    const counts = SEVERITIES.map((severity) => ({ severity, n: findings.filter((f) => f.severity === severity).length })).filter((row) => row.n > 0)
    const summary = counts.map((row) => `${row.n} ${row.severity}`).join(', ') || 'no findings'
    const draft = unverified.length > 0

    const report = [
      `# Security assessment report: ${slug}`,
      '',
      `**Date:** ${new Date().toISOString().slice(0, 10)}`,
      `**Findings:** ${summary}`,
      draft ? `\n> ⚠️ DRAFT — ${unverified.length} finding(s) reference evidence that is no longer on disk: ${unverified.join('; ')}. Re-capture the evidence or remove the claim before sharing.` : '',
      '',
      '## Scope',
      '',
      scope || '_SCOPE.md not found._',
      '',
      '## Findings',
      '',
      sections.join('\n'),
      '## Methodology',
      '',
      'Findings in this report are compiled from findings.jsonl. Each was recorded via log_finding, which requires an evidence file under recon/ to exist at log time; engagement_report re-checks those files and marks any that have gone missing.',
      '',
    ]
      .filter((line) => line !== '')
      .join('\n')

    const reportPath = join(dir, 'report.md')
    await captureBeforeWrite(reportPath)
    await Bun.write(reportPath, `${report}\n`)

    return `Wrote ${reportPath} — ${findings.length} finding(s): ${summary}.${draft ? ` Marked DRAFT: ${unverified.length} unverified.` : ''}`
  },
}
