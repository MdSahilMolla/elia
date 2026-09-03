import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { newEngagementTool, engagementDir } from './engagement.ts'
import { logFindingTool, engagementReportTool } from './findings.ts'

const slug = 'elia-test-findings-2026'

afterEach(() => rmSync(engagementDir(slug), { recursive: true, force: true }))

async function scaffold() {
  await newEngagementTool.execute({ slug, target: 'test.example.com', authorizedBy: 'own lab', scope: 'web app only' })
}

function writeRecon(name: string, body: string) {
  const dir = join(engagementDir(slug), 'recon')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), body)
}

test('log_finding rejects a finding whose evidence file does not exist', async () => {
  await scaffold()
  await expect(
    logFindingTool.execute({
      engagement: slug,
      title: 'SQLi in id param',
      severity: 'high',
      description: 'union-based',
      remediation: 'parameterise',
      evidence: ['sqlmap-run.log'],
    }),
  ).rejects.toThrow('Evidence not found')
})

test('log_finding rejects an empty evidence array', async () => {
  await scaffold()
  await expect(
    logFindingTool.execute({ engagement: slug, title: 't', severity: 'low', description: 'd', remediation: 'r', evidence: [] }),
  ).rejects.toThrow('non-empty array')
})

test('log_finding rejects evidence that escapes the recon folder', async () => {
  await scaffold()
  await expect(
    logFindingTool.execute({ engagement: slug, title: 't', severity: 'low', description: 'd', remediation: 'r', evidence: ['../SCOPE.md'] }),
  ).rejects.toThrow('outside the engagement')
})

test('log_finding records a finding backed by real recon output', async () => {
  await scaffold()
  writeRecon('nuclei.log', 'CVE-2024-1234 detected on /admin')
  const result = await logFindingTool.execute({
    engagement: slug,
    title: 'Outdated component with known CVE',
    severity: 'critical',
    description: 'nuclei flagged CVE-2024-1234',
    remediation: 'upgrade',
    evidence: ['nuclei.log', 'recon/nuclei.log'],
  })
  expect(result).toContain('F-001')
  const jsonl = await Bun.file(join(engagementDir(slug), 'findings.jsonl')).text()
  const finding = JSON.parse(jsonl.trim())
  expect(finding.evidence).toEqual(['nuclei.log'])
  expect(finding.severity).toBe('critical')
  expect(await Bun.file(join(engagementDir(slug), 'findings.md')).text()).toContain('Outdated component')
})

test('engagement_report compiles findings by severity with embedded evidence', async () => {
  await scaffold()
  writeRecon('a.log', 'low-sev evidence body')
  writeRecon('b.log', 'critical evidence body')
  await logFindingTool.execute({ engagement: slug, title: 'Verbose error page', severity: 'low', description: 'stack traces', remediation: 'hide', evidence: ['a.log'] })
  await logFindingTool.execute({ engagement: slug, title: 'Auth bypass', severity: 'critical', description: 'no check', remediation: 'add check', evidence: ['b.log'] })

  const result = await engagementReportTool.execute({ engagement: slug })
  expect(result).toContain('2 finding(s)')
  const report = await Bun.file(join(engagementDir(slug), 'report.md')).text()
  expect(report.indexOf('Auth bypass')).toBeLessThan(report.indexOf('Verbose error page'))
  expect(report).toContain('critical evidence body')
  expect(report).not.toContain('DRAFT')
})

test('engagement_report marks the report a draft when evidence has gone missing', async () => {
  await scaffold()
  writeRecon('gone.log', 'temporary evidence')
  await logFindingTool.execute({ engagement: slug, title: 'Missing header', severity: 'medium', description: 'no CSP', remediation: 'add CSP', evidence: ['gone.log'] })
  rmSync(join(engagementDir(slug), 'recon', 'gone.log'))

  const result = await engagementReportTool.execute({ engagement: slug })
  expect(result).toContain('DRAFT')
  expect(await Bun.file(join(engagementDir(slug), 'report.md')).text()).toContain('no longer on disk')
})

test('engagement_report is a no-op message when nothing is logged', async () => {
  await scaffold()
  expect(await engagementReportTool.execute({ engagement: slug })).toContain('No findings logged')
})
