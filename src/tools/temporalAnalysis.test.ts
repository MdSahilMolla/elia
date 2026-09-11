import { describe, expect, it, beforeAll, afterAll } from 'bun:test'
import { linearRegression, classifyTrend, byteSizeOf, lineCountOf, makeGitRunner, getCommitFrequencyTrend, getFileSizeTrend, getComplexityTrend } from './temporalAnalysis.ts'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type GitRunner = (args: string[]) => Promise<string>

function gitRun(cwd: string): GitRunner {
  return async (args) => {
    const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
    const stdout = await new Response(proc.stdout).text()
    await proc.exited.catch(() => undefined)
    if (proc.exitCode !== 0) throw new Error(`git ${args.join(' ')} exited ${proc.exitCode}`)
    return stdout
  }
}

describe('linearRegression', () => {
  it('returns slope 0 for constant series', () => {
    const r = linearRegression([0, 1, 2].map((x) => ({ x, y: 10 })))
    expect(r.slope).toBe(0)
    expect(r.intercept).toBe(10)
    expect(r.r2).toBe(0)
  })

  it('detects linear growth', () => {
    const r = linearRegression([0, 1, 2, 3, 4].map((x) => ({ x, y: x * 3 + 2 })))
    expect(r.slope).toBeCloseTo(3, 5)
    expect(r.intercept).toBeCloseTo(2, 5)
    expect(r.r2).toBeGreaterThan(0.99)
  })

  it('handles a single point', () => {
    const r = linearRegression([{ x: 0, y: 5 }])
    expect(r.slope).toBe(0)
    expect(r.intercept).toBe(5)
  })

  it('handles empty series', () => {
    const r = linearRegression([])
    expect(r.slope).toBe(0)
    expect(r.intercept).toBe(0)
  })
})

describe('classifyTrend', () => {
  it('classifies increasing vs decreasing', () => {
    expect(classifyTrend(5, 0.9, [10, 20, 30])).toBe('increasing')
    expect(classifyTrend(-5, 0.9, [30, 20, 10])).toBe('decreasing')
  })

  it('classifies volatile when range is large relative to average', () => {
    expect(classifyTrend(0.1, 0.5, [0, 100, 0, 100, 0])).toBe('volatile')
  })

  it('classifies stable when fit is weak', () => {
    expect(classifyTrend(2, 0.1, [10, 12, 11])).toBe('stable')
  })
})

describe('byteSizeOf / lineCountOf', () => {
  it('measures bytes and lines like wc', () => {
    expect(byteSizeOf('hello')).toBe(5)
    expect(lineCountOf('a\nb\nc\n')).toBe(3)
    expect(lineCountOf('a\nb\nc')).toBe(3)
    expect(lineCountOf('')).toBe(0)
  })
})

describe('git-backed trends (real git, argv runner)', () => {
  let root: string
  let runner: GitRunner

  function commitAt(date: string, message: string): Promise<number> {
    const proc = Bun.spawn(['git', 'commit', '-q', '-m', message], {
      cwd: root,
      env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    return proc.exited.then(async () => {
      await new Response(proc.stderr).text().catch(() => undefined)
      return proc.exitCode ?? -1
    })
  }

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'temporal-test-'))
    runner = gitRun(root)
    await runner(['init', '-q'])
    await runner(['config', 'core.autocrlf', 'false'])
    await runner(['config', 'user.email', 'test@example.com'])
    await runner(['config', 'user.name', 'Test'])
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'grow.ts'), 'export const a = 1\n')
    await runner(['add', '.'])
    expect(await commitAt('2026-09-01T12:00:00', 'initial')).toBe(0)
    writeFileSync(join(root, 'src', 'grow.ts'), Array.from({ length: 100 }, (_, i) => `export const v${i} = ${i}\n`).join(''))
    writeFileSync(join(root, 'src', 'other.ts'), 'export const b = 2\n')
    await runner(['add', '.'])
    expect(await commitAt('2026-09-05T12:00:00', 'grow')).toBe(0)
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('file size trend sees growth', async () => {
    const trend = await getFileSizeTrend(runner, 'src/grow.ts', 8)
    expect(trend.dataPoints.length).toBeGreaterThanOrEqual(2)
    const values = trend.dataPoints.map((p) => p.value)
    expect(Math.max(...values)).toBeGreaterThan(200)
  }, 20000)

  it('complexity trend counts lines', async () => {
    const trend = await getComplexityTrend(runner, 'src/grow.ts', 8)
    expect(trend.dataPoints.length).toBeGreaterThanOrEqual(2)
    const values = trend.dataPoints.map((p) => p.value)
    expect(Math.max(...values)).toBeGreaterThan(50)
  }, 20000)

  it('commit frequency counts commits per bucket', async () => {
    const trend = await getCommitFrequencyTrend(runner, 30)
    const total = trend.dataPoints.reduce((s, p) => s + p.value, 0)
    expect(total).toBeGreaterThanOrEqual(2)
    expect(trend.metric).toBe('Commit frequency')
  }, 20000)

  it('makeGitRunner works against real repo', async () => {
    const r = await makeGitRunner(root)
    const out = await r(['rev-parse', '--is-inside-work-tree'])
    expect(out.trim()).toBe('true')
  })
})