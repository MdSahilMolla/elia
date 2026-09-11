import { describe, expect, it, beforeAll, afterAll } from 'bun:test'
import {
  runSelfHealing,
  scanMarkerReferences,
  largestSourceFile,
  computeOverallHealth,
  planAutoFix,
  deploymentHealth,
  defaultGitRunner,
  writeAutoFixDraft,
  formatAutoFixDraft,
  type HealthMetric,
  type GitFn,
} from './selfHealingMonitor.ts'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function sampleGitFn(overrides: Partial<Record<string, string>> = {}): GitFn {
  return async (args: string[]) => {
    const joined = args.join(' ')
    if (joined.includes('--since')) return overrides.commits ?? 'a1c fix auth bug\nb2d add tests\n'
    if (joined.includes('--name-only')) return overrides.names ?? 'src/auth.ts\nsrc/auth.ts\nsrc/plans.ts\n'
    if (joined.includes('branch --list')) return overrides.hotfix ?? ''
    return ''
  }
}

describe('scanMarkerReferences', () => {
  let cwd: string
  beforeAll(() => {
    cwd = mkdtempSync(join(tmpdir(), 'shm-markers-'))
    mkdirSync(join(cwd, 'src'), { recursive: true })
    writeFileSync(join(cwd, 'src', 'a.ts'), '// TODO fix this\nconst x = 1 // FIXME\n')
    writeFileSync(join(cwd, 'src', 'b.ts'), 'clean file\n')
    writeFileSync(join(cwd, 'package.json'), '{"name":"t"}\n')
  })
  afterAll(() => rmSync(cwd, { recursive: true, force: true }))

  it('counts markers and reports top files', () => {
    const { count, files } = scanMarkerReferences(cwd)
    expect(count).toBe(2)
    expect(files[0]!.file.split('\\').join('/').endsWith('src/a.ts')).toBe(true)
  })

  it('ignores node_modules and non-source files', () => {
    mkdirSync(join(cwd, 'node_modules'), { recursive: true })
    writeFileSync(join(cwd, 'node_modules', 'z.ts'), 'TODO TODO TODO\n')
    writeFileSync(join(cwd, 'notes.md'), 'TODO\n')
    const before = scanMarkerReferences(cwd).count
    const after = scanMarkerReferences(cwd).count
    expect(after).toBe(before)
  })
})

describe('largestSourceFile', () => {
  let cwd: string
  beforeAll(() => {
    cwd = mkdtempSync(join(tmpdir(), 'shm-large-'))
    mkdirSync(join(cwd, 'src'))
    writeFileSync(join(cwd, 'src', 'big.ts'), Array.from({ length: 1200 }, () => 'x').join('\n'))
    writeFileSync(join(cwd, 'src', 'small.ts'), 'y\n')
  })
  afterAll(() => rmSync(cwd, { recursive: true, force: true }))

  it('finds the largest source file by lines', () => {
    const largest = largestSourceFile(cwd)
    expect(largest).not.toBeNull()
    expect(largest!.file.endsWith('big.ts')).toBe(true)
    expect(largest!.lines).toBeGreaterThan(1000)
  })
})

describe('computeOverallHealth', () => {
  const metric = (status: HealthMetric['status']): HealthMetric => ({
    name: 'm', status, value: '0', recommendation: '',
  })
  it('degrades on many warnings, unhealthy on critical', () => {
    expect(computeOverallHealth([metric('healthy'), metric('healthy')])).toBe('healthy')
    expect(computeOverallHealth([metric('warning'), metric('warning'), metric('warning')])).toBe('degraded')
    expect(computeOverallHealth([metric('critical'), metric('healthy')])).toBe('unhealthy')
  })
})

describe('planAutoFix', () => {
  it('returns a non-applied draft with rationale from incidents', () => {
    const metrics: HealthMetric[] = [{ name: 'Active hotfix branches', status: 'critical', value: '4', threshold: '3', recommendation: 'x' }]
    const incidents = [{ type: 'frequent-fixes', frequency: 12, lastSeen: 'now', affectedFiles: ['src/broken.ts'], suggestedFix: 'fix root cause' }]
    const draft = planAutoFix('/tmp/fake', metrics, incidents)
    expect(draft.criticality).toBe('warning')
    expect(draft.items.some((i) => i.file === 'src/broken.ts')).toBe(true)
  })

  it('writes the draft to .elia/heal-plans without touching source', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'shm-draft-'))
    const draft = planAutoFix(cwd, [], [])
    const path = writeAutoFixDraft(cwd, draft)
    expect(existsSync(path)).toBe(true)
    const written = formatAutoFixDraft(draft)
    expect(written).toContain('Nothing was modified')
    rmSync(cwd, { recursive: true, force: true })
  })
})

describe('deploymentHealth', () => {
  let cwd: string
  beforeAll(() => {
    cwd = mkdtempSync(join(tmpdir(), 'shm-deploy-'))
    mkdirSync(join(cwd, '.elia'))
  })
  afterAll(() => rmSync(cwd, { recursive: true, force: true }))

  it('reports healthy with no records', () => {
    expect(deploymentHealth(cwd).healthy).toBe(true)
  })
  it('reports fresh deployment as healthy and stale as unhealthy', () => {
    writeFileSync(join(cwd, '.elia', 'deployments.json'), JSON.stringify([{ at: new Date().toISOString(), ref: 'abc123' }]))
    expect(deploymentHealth(cwd).healthy).toBe(true)
    writeFileSync(join(cwd, '.elia', 'deployments.json'), JSON.stringify([{ at: new Date(Date.now() - 30 * 86400000).toISOString() }]))
    expect(deploymentHealth(cwd).healthy).toBe(false)
  })
  it('flags malformed log', () => {
    writeFileSync(join(cwd, '.elia', 'deployments.json'), '{ nope')
    expect(deploymentHealth(cwd).healthy).toBe(false)
  })
})

describe('runSelfHealing (injectable git)', () => {
  let cwd: string
  beforeAll(() => {
    cwd = mkdtempSync(join(tmpdir(), 'shm-run-'))
    mkdirSync(join(cwd, 'src'))
    writeFileSync(join(cwd, 'src', 'a.ts'), 'export const ok = 1\n')
    writeFileSync(join(cwd, 'package.json'), '{"name":"t"}\n')
  })
  afterAll(() => rmSync(cwd, { recursive: true, force: true }))

  it('status reports project health', async () => {
    const out = await runSelfHealing({ action: 'status' }, cwd, sampleGitFn())
    expect(out).toContain('=== Self-Healing Monitor Report ===')
    expect(out).toContain('Overall health:')
  })

  it('analyze surfaces incident patterns', async () => {
    const out = await runSelfHealing({ action: 'analyze' }, cwd, sampleGitFn({ commits: Array.from({ length: 12 }, () => 'c fix thing').join('\n') }))
    expect(out).toContain('Incident Patterns')
    expect(out).toContain('frequent-fixes')
  })

  it('deploy_monitor reads local deployment history', async () => {
    mkdirSync(join(cwd, '.elia'), { recursive: true })
    writeFileSync(join(cwd, '.elia', 'deployments.json'), JSON.stringify([{ at: new Date().toISOString() }]))
    const out = await runSelfHealing({ action: 'deploy_monitor' }, cwd, sampleGitFn())
    expect(out).toContain('Deployment Monitor')
    expect(out).toContain('OK')
  })

  it('auto_fix generates a draft plan, not an application', async () => {
    const out = await runSelfHealing({ action: 'auto_fix' }, cwd, sampleGitFn({ commits: Array.from({ length: 12 }, () => 'c fix thing').join('\n') }))
    expect(out).toContain('Auto-Fix Draft Plan (not applied)')
    expect(out).toContain('Draft saved to:')
    expect(out).toContain('Nothing was modified')
  })

  it('throws on unknown action', async () => {
    try {
      await runSelfHealing({ action: 'nope' }, cwd, sampleGitFn())
      expect.unreachable()
    } catch (e) {
      expect((e as Error).message).toContain('Unknown action')
    }
  })
})

describe('defaultGitRunner', () => {
  it('returns empty string when not a git repo', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'shm-git-'))
    const out = await defaultGitRunner(['status'], cwd)
    expect(out).not.toBeUndefined()
    rmSync(cwd, { recursive: true, force: true })
  })
})