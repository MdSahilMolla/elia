import { afterEach, expect, test } from 'bun:test'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { newEngagementTool, engagementDir } from './engagement.ts'
import { runSecurityToolTool } from './securityScan.ts'

// paths.workspace is fixed at process start from the real cwd (see config.ts), so
// these write into the real workspace/engagements/ tree under distinctly-named,
// test-only slugs — cleaned up below rather than run against a faked cwd.
const testSlugs = ['elia-test-acme-webapp-2026', 'elia-test-never-scaffolded', 'elia-test-lab']

afterEach(() => {
  for (const slug of testSlugs) rmSync(engagementDir(slug), { recursive: true, force: true })
})

test('new_engagement scaffolds SCOPE.md, findings.md, report.md, and recon/', async () => {
  const result = await newEngagementTool.execute({
    slug: 'elia-test-acme-webapp-2026',
    target: '10.0.0.0/24',
    authorizedBy: 'signed SOW with Acme Corp',
    scope: 'web app only, no social engineering',
  })

  const dir = engagementDir('elia-test-acme-webapp-2026')
  expect(result).toContain(dir)

  expect(await Bun.file(join(dir, 'SCOPE.md')).text()).toContain('10.0.0.0/24')
  expect(await Bun.file(join(dir, 'SCOPE.md')).text()).toContain('signed SOW with Acme Corp')
  expect(await Bun.file(join(dir, 'findings.md')).text()).toContain('Findings')
  expect(await Bun.file(join(dir, 'report.md')).text()).toContain('Security assessment report')
  expect(existsSync(join(dir, 'recon'))).toBe(true)
})

test('run_security_tool refuses to run for an engagement that was never scaffolded', async () => {
  const result = await runSecurityToolTool.execute({
    engagement: 'elia-test-never-scaffolded',
    label: 'nmap',
    command: 'echo hi',
  })
  expect(result).toContain('Run new_engagement first')
})

test('run_security_tool runs the command and saves output under the engagement recon/ folder', async () => {
  await newEngagementTool.execute({
    slug: 'elia-test-lab',
    target: '192.168.56.10',
    authorizedBy: 'own lab VM',
    scope: 'everything on the VM',
  })

  const result = await runSecurityToolTool.execute({
    engagement: 'elia-test-lab',
    label: 'probe',
    command: 'echo scan-output-123',
  })

  expect(result).toContain('scan-output-123')
  const reconDir = join(engagementDir('elia-test-lab'), 'recon')
  const files = await Array.fromAsync(new Bun.Glob('*.log').scan({ cwd: reconDir }))
  expect(files.length).toBe(1)
  const logContent = await Bun.file(join(reconDir, files[0]!)).text()
  expect(logContent).toContain('scan-output-123')
  expect(logContent).toContain('echo scan-output-123')
})
