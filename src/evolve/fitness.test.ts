import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// fitness.ts pulls in the agent loop, which resolves a provider at import time.
process.env.ANTHROPIC_API_KEY ??= 'test-key-for-fitness-test'

const { compareScorecards, isInfrastructureFailure } = await import('./fitness.ts')
const { IMMUTABLE_FILES, pruneSandboxes, violatedImmutables } = await import('./sandbox.ts')

import type { Metrics } from './ledger.ts'

function metrics(overrides: Partial<Metrics> = {}): Metrics {
  return {
    passRate: 0.5,
    passed: ['a', 'b'],
    failed: ['c', 'd'],
    totalTokens: 100_000,
    totalElapsedMs: 60_000,
    ...overrides,
  }
}

test('a higher pass rate is promoted, and the reason names what it gained', () => {
  const result = compareScorecards(
    metrics(),
    metrics({ passRate: 0.75, passed: ['a', 'b', 'c'], failed: ['d'] }),
  )

  expect(result.better).toBe(true)
  expect(result.reason).toContain('50% → 75%')
  expect(result.reason).toContain('c')
})

test('a strictly worse candidate is rejected, and the reason names what it lost', () => {
  // The regression check fires before the pass-rate comparison, which is the more
  // useful message: "b broke" tells you where to look, "the number went down" does not.
  const result = compareScorecards(metrics(), metrics({ passRate: 0.25, passed: ['a'], failed: ['b', 'c', 'd'] }))

  expect(result.better).toBe(false)
  expect(result.reason).toContain('regressed on b')
})

test('trading one passing task for another is rejected even when the total ties', () => {
  // Otherwise the search happily swaps capabilities around and calls it progress.
  const result = compareScorecards(metrics(), metrics({ passed: ['a', 'c'], failed: ['b', 'd'] }))

  expect(result.better).toBe(false)
  expect(result.reason).toContain('regressed on b')
})

test('a regression is rejected even when the pass rate went up overall', () => {
  const result = compareScorecards(
    metrics(),
    metrics({ passRate: 0.75, passed: ['a', 'c', 'd'], failed: ['b'] }),
  )

  expect(result.better).toBe(false)
  expect(result.reason).toContain('regressed on b')
})

test('an identical run is rejected, so benchmark noise cannot promote a no-op', () => {
  const result = compareScorecards(metrics(), metrics())

  expect(result.better).toBe(false)
  expect(result.reason).toContain('no measurable improvement')
})

test('a clear token saving at the same pass rate is promoted', () => {
  const result = compareScorecards(metrics(), metrics({ totalTokens: 80_000 }))

  expect(result.better).toBe(true)
  expect(result.reason).toContain('fewer tokens')
})

test('a token saving within the noise margin is not enough', () => {
  const result = compareScorecards(metrics(), metrics({ totalTokens: 98_000 }))

  expect(result.better).toBe(false)
})

test('a clear speed-up at the same pass rate and token count is promoted', () => {
  const result = compareScorecards(metrics(), metrics({ totalElapsedMs: 40_000 }))

  expect(result.better).toBe(true)
  expect(result.reason).toContain('faster')
})

test('parallel benchmark promotion uses wall-clock time when available', () => {
  const result = compareScorecards(
    metrics({ totalElapsedMs: 120_000, wallClockMs: 60_000 }),
    metrics({ totalElapsedMs: 120_000, wallClockMs: 40_000 }),
  )

  expect(result.better).toBe(true)
  expect(result.reason).toContain('faster')
})

test('saving tokens by getting much slower is rejected', () => {
  const result = compareScorecards(metrics(), metrics({ totalTokens: 70_000, totalElapsedMs: 120_000 }))

  expect(result.better).toBe(false)
})

test('a first run against an empty baseline is promoted on any pass', () => {
  const baseline = metrics({ passRate: 0, passed: [], failed: ['a', 'b', 'c', 'd'], totalTokens: 0, totalElapsedMs: 0 })
  const result = compareScorecards(baseline, metrics({ passRate: 0.25, passed: ['a'], failed: ['b', 'c', 'd'] }))

  expect(result.better).toBe(true)
})

test('a provider outage is treated as infrastructure, not as the agent failing the task', () => {
  // Scoring a transient 500 as a failure would make the benchmark reject a better
  // candidate on the strength of a network blip, and the ledger would carry that
  // false result forward into every later generation.
  expect(isInfrastructureFailure({ error: 'The server had an error while processing your request.', steps: 0 })).toBe(
    true,
  )
  expect(isInfrastructureFailure({ error: 'rate limit exceeded', steps: 4 })).toBe(true)
  expect(isInfrastructureFailure({ error: 'upstream returned 503', steps: 2 })).toBe(true)
  expect(isInfrastructureFailure({ error: 'fetch failed', steps: 1 })).toBe(true)
})

test('a hang scores as a real failure even though it also reports zero steps', () => {
  expect(isInfrastructureFailure({ error: 'timed out after 300000ms', steps: 0 })).toBe(false)
})

test('a wrong answer is never retried', () => {
  expect(isInfrastructureFailure({ steps: 6 })).toBe(false)
  expect(isInfrastructureFailure({ error: 'Unknown tool: search', steps: 6 })).toBe(false)
})

test('the files defining the benchmark are off limits to a candidate', () => {
  // Editing the benchmark is the cheapest way to score well, so the gate has to
  // treat it as void rather than as a change to review.
  expect(violatedImmutables(['src/config.ts', 'src/evolve/suite.ts'])).toEqual(['src/evolve/suite.ts'])
  expect(violatedImmutables(['src/config.ts', 'src/agentLoop.ts'])).toEqual([])
  expect(IMMUTABLE_FILES).toContain('src/evolve/fitness.ts')
  expect(IMMUTABLE_FILES).toContain('src/evolve/suite.ts')
})

test('the glob entries in IMMUTABLE_FILES are what is enforced, not decoration', () => {
  // `src/**/*.test.ts`, `values/**`, `src/gap/**` etc. used to be matched with
  // `includes` and never fired; a separate hand-written copy did the work.
  expect(violatedImmutables([
    'src/a.test.ts', 'src/deep/nested/b.test.ts', 'values/value-core.md', 'src/values/probe.ts', 'src/gap/vector.ts',
    'src/a.ts', 'src/testing.ts', 'valuesish/x.md', 'docs/values/x.md',
  ])).toEqual(['src/a.test.ts', 'src/deep/nested/b.test.ts', 'values/value-core.md', 'src/values/probe.ts', 'src/gap/vector.ts'])
  // Every glob entry in the list matches at least one plausible path — none are dead text.
  for (const entry of IMMUTABLE_FILES.filter((item) => item.includes('*'))) {
    const example = entry.replace('**/', 'x/').replace('**', 'x.md').replace('*', 'x')
    expect(violatedImmutables([example])).toEqual([example])
  }
})

test('sandbox copies are pruned to the retention cap, newest kept, rollback backups untouched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'elia-evolve-prune-'))
  try {
    for (let generation = 1; generation <= 8; generation++) {
      mkdirSync(join(dir, `gen-${generation}`, 'src'), { recursive: true })
      const at = new Date(Date.now() - (10 - generation) * 60_000)
      utimesSync(join(dir, `gen-${generation}`), at, at)
    }
    mkdirSync(join(dir, 'gen-1-backup'))
    const removed = pruneSandboxes(3, dir)
    expect(removed).toHaveLength(5)
    expect(readdirSync(dir).sort()).toEqual(['gen-1-backup', 'gen-6', 'gen-7', 'gen-8'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

const { markUnmeasured } = await import('./fitness.ts')

test('an out-of-credit or dead-environment task is unmeasured, not failed', () => {
  const base = { taskId: 't', weight: 1, passed: false, detail: '', steps: 0, elapsedMs: 0, totalTokens: 0 }
  expect(markUnmeasured({ ...base, error: '402 This request requires more credits' }).unmeasured).toBe(true)
  expect(markUnmeasured({ ...base, error: 'no result from agent process: error: preload not found "@x/y"' }).unmeasured).toBe(true)
  expect(markUnmeasured({ ...base, error: 'stale task: bunfig.toml preloads "@x/y"' }).unmeasured).toBe(true)
  // A hang is the candidate's fault; a wrong answer is a wrong answer.
  expect(markUnmeasured({ ...base, error: 'timed out after 300000ms' }).unmeasured).toBeUndefined()
  expect(markUnmeasured({ ...base, steps: 7, detail: 'tests still fail' }).unmeasured).toBeUndefined()
})

test('compareScorecards refuses to compare when either side has unmeasured tasks', () => {
  const better = metrics({ passRate: 1, passed: ['a', 'b', 'c', 'd'], failed: [] })
  const result = compareScorecards(metrics({ unmeasured: ['d'] }), better)
  expect(result.better).toBe(false)
  expect(result.reason).toContain('could not measure d')
  expect(compareScorecards(metrics(), { ...better, unmeasured: ['a'] }).better).toBe(false)
})

const { retryDelayMs, benchConcurrency } = await import('./fitness.ts')

test('a rate limit is waited out across minutes; other blips get one quick retry; permanent errors none', () => {
  const limited = { error: '429 Rate limit reached: input token limit exceeded', steps: 12 }
  expect([1, 2, 3, 4, 5, 6].map((attempt) => retryDelayMs(limited, attempt))).toEqual([30_000, 60_000, 120_000, 240_000, 240_000, undefined])
  const blip = { error: 'fetch failed', steps: 3 }
  expect([1, 2].map((attempt) => retryDelayMs(blip, attempt))).toEqual([2000, undefined])
  expect(retryDelayMs({ error: '402 requires more credits', steps: 0 }, 1)).toBeUndefined()
  expect(retryDelayMs({ steps: 9 }, 1)).toBeUndefined()
})

test('benchConcurrency reads ELIA_BENCH_CONCURRENCY and defaults to 2', () => {
  expect(benchConcurrency({})).toBe(2)
  expect(benchConcurrency({ ELIA_BENCH_CONCURRENCY: '1' })).toBe(1)
  expect(benchConcurrency({ ELIA_BENCH_CONCURRENCY: '0' })).toBe(2)
  expect(benchConcurrency({ ELIA_BENCH_CONCURRENCY: 'x' })).toBe(2)
})

test('a benchmark task never falls back to another provider', async () => {
  const { benchTaskEnv } = await import('./fitness.ts')
  const env = benchTaskEnv({ ELIA_ROUTING_MODE: 'auto', ELIA_PROVIDER: 'mercury' }, '/tmp/x.reach')
  expect(env.ELIA_ROUTING_MODE).toBe('selected')
  expect(env.ELIA_PROVIDER).toBe('mercury')
})

const { measureFitness, outOfCredit } = await import('./fitness.ts')

test('only an account out of credit counts as out of credit, not a rate limit', () => {
  const base = { unmeasured: true as const }
  expect(outOfCredit({ ...base, error: '402 {"error":{"code":"free_tier_quota_exceeded"}}' })).toBe(true)
  expect(outOfCredit({ ...base, error: 'This request requires more credits' })).toBe(true)
  expect(outOfCredit({ ...base, error: '429 rate limit exceeded' })).toBe(false)
  expect(outOfCredit({ ...base, error: 'stale task: bunfig.toml preloads "@x/y"' })).toBe(false)
  // A task the agent got wrong is never a reason to stop the sweep.
  expect(outOfCredit({ error: '402 Payment Required' })).toBe(false)
})

test('once the provider is out of credit the rest of the sweep is not run, and none of it scores', async () => {
  const tasks = ['t1', 't2', 't3'].map((id) => ({ id, weight: 1 })) as unknown as import('./task.ts').BenchTask[]
  const ran: string[] = []
  const card = await measureFitness({
    sourceRoot: '/nowhere',
    tasks,
    concurrency: 1,
    repeats: 3,
    runTask: async (task) => {
      ran.push(task.id)
      const base = { taskId: task.id, weight: 1, detail: '', steps: 0, elapsedMs: 1, totalTokens: 0 }
      return task.id === 't1' ? { ...base, passed: true, steps: 3 } : { ...base, passed: false, error: '402 requires more credits', unmeasured: true }
    },
  })
  // t2's first attempt found the empty account; its other two and all of t3 never ran.
  expect(ran).toEqual(['t1', 't1', 't1', 't2'])
  expect(card.unmeasured).toEqual(['t2', 't3'])
  expect(card.outcomes.find((outcome) => outcome.taskId === 't3')!.error).toContain('out of credit')
  expect(card.passRate).toBe(1)
})

test('a repeated task carries the trace of the attempt it reports as failing', async () => {
  const { aggregateAttempts, benchTaskEnv } = await import('./fitness.ts')
  const base = { taskId: 't', weight: 1, detail: '', steps: 3, elapsedMs: 1, totalTokens: 1 }
  const outcome = aggregateAttempts([
    { ...base, passed: true, trace: 'a pass never has one' },
    { ...base, passed: false, detail: 'wrong', trace: '1. edit_file … → ERROR' },
    { ...base, passed: true },
  ])
  expect(outcome.trace).toBe('1. edit_file … → ERROR')
  expect(aggregateAttempts([{ ...base, passed: true }, { ...base, passed: true }]).trace).toBeUndefined()
  expect(benchTaskEnv({}, '/tmp/x.reach', '/tmp/x.trace').ELIA_BENCH_TRACE_OUT).toBe('/tmp/x.trace')
  expect(benchTaskEnv({}, '/tmp/x.reach').ELIA_BENCH_TRACE_OUT).toBeUndefined()
})

test('a provider that stopped answering is infrastructure, although it also says "timed out"', async () => {
  const { isInfrastructureFailure, retryDelayMs } = await import('./fitness.ts')
  const loopGaveUp = { error: 'response stalled: nothing arrived for 120s (timed out)', steps: 3 }
  const harnessStopped = { error: 'provider stalled: the model sent nothing for 60s or more before the task was stopped at 300000ms', steps: 0 }
  expect(isInfrastructureFailure(loopGaveUp)).toBe(true)
  expect(isInfrastructureFailure(harnessStopped)).toBe(true)
  // The agent's own hang still scores.
  expect(isInfrastructureFailure({ error: 'timed out after 300000ms', steps: 0 })).toBe(false)
  expect([1, 2, 3, 4].map((attempt) => retryDelayMs(harnessStopped, attempt))).toEqual([30_000, 60_000, 120_000, undefined])
})

test('a pass rate up by less than noise is a tie, so a real saving can still win on it', () => {
  // Generation 1's shape: one flaky task up a third, another down a third, and
  // 8% fewer tokens — turned away before efficiency was ever looked at.
  const baseline = metrics({ passRate: 0.96, passed: ['a', 'b'], failed: [], taskRates: { a: 2 / 3, b: 2 / 3 }, totalTokens: 100_000, totalElapsedMs: 60_000 })
  const cheaper = metrics({ passRate: 0.97, passed: ['a'], failed: ['b'], taskRates: { a: 1, b: 1 / 3 }, totalTokens: 91_000, totalElapsedMs: 60_000 })
  const result = compareScorecards(baseline, cheaper)
  expect(result.better).toBe(true)
  expect(result.reason).toContain('9% fewer tokens')
  // No saving: still no promotion, and the reason says why.
  const same = compareScorecards(baseline, { ...cheaper, totalTokens: 100_000 })
  expect(same.better).toBe(false)
  expect(same.reason).toContain('no task improved by more than run-to-run noise')
  // A pass rate that fell is still refused whatever it saved.
  expect(compareScorecards(baseline, { ...cheaper, passRate: 0.95 }).better).toBe(false)
})
