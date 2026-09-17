import { expect, test } from 'bun:test'

process.env.ANTHROPIC_API_KEY ??= 'test-key-for-sieve-test'

const { carryOutcome, raceCandidate, raceOrder, regressionsIn, renderRace, scaledWallClock, sieveEnabled } = await import('./sieve.ts')
const { cardFromOutcomes, compareScorecards, toMetrics } = await import('./fitness.ts')
import type { Scorecard, TaskOutcome } from './fitness.ts'
import type { ReachMap } from './reach.ts'
import type { BenchTask } from './task.ts'
import type { Metrics } from './ledger.ts'

function task(id: string): BenchTask {
  return { id, weight: 1, prompt: id, setup: async () => {}, check: async () => ({ passed: true, detail: '' }) }
}

function outcome(taskId: string, passed: boolean, over: Partial<TaskOutcome> = {}): TaskOutcome {
  return { taskId, weight: 1, passed, detail: passed ? 'ok' : 'wrong', steps: 3, elapsedMs: 1000, totalTokens: 1000, model: 'm', ...over }
}

function metricsFrom(outcomes: TaskOutcome[]): Metrics {
  return toMetrics(cardFromOutcomes('/live', outcomes.map((o) => task(o.taskId)), outcomes, 5000))
}

/**
 * A benchmark that never calls a model: it looks each requested task up in a
 * script and hands back what that task is defined to do. Every test here is
 * about which tasks get run and what verdict comes out, so the runs themselves
 * only need to be consistent.
 */
function scripted(script: Record<string, TaskOutcome>) {
  const ran: string[] = []
  const measure = async ({ sourceRoot, tasks }: { sourceRoot: string; tasks?: BenchTask[] }): Promise<Scorecard> => {
    const requested = tasks ?? []
    for (const t of requested) ran.push(t.id)
    return cardFromOutcomes(sourceRoot, requested, requested.map((t) => script[t.id] ?? outcome(t.id, true)), 100)
  }
  return { ran, measure }
}

const FIVE = ['a', 'b', 'c', 'd', 'e']

test('a diff no task loads is rejected without running anything', async () => {
  const baselineOutcomes = FIVE.map((id) => outcome(id, true))
  const reach: ReachMap = Object.fromEntries(FIVE.map((id) => [id, { modules: ['src/agentLoop.ts'], runs: 1, at: 0 }]))
  const { ran, measure } = scripted({})

  const report = await raceCandidate({
    sourceRoot: '/sandbox',
    tasks: FIVE.map(task),
    baseline: metricsFrom(baselineOutcomes),
    baselineOutcomes,
    changedFiles: ['src/ui/theme.ts'],
    measure,
    reach,
  })

  expect(ran).toEqual([])
  expect(report.ran).toEqual([])
  expect(report.carried).toEqual(FIVE)
  expect(report.comparison.better).toBe(false)
  expect(report.comparison.reason).toContain('no measurable improvement')
  expect(report.tokens).toBe(0)
})

test('an unreachable task carries its cost across, so a candidate cannot look cheap by not running it', async () => {
  // Dropping the carried tasks from the totals instead of carrying them would
  // hand every candidate a fake efficiency win: four fewer tasks in the
  // denominator reads as "80% fewer tokens" to the tie-break.
  const baselineOutcomes = FIVE.map((id) => outcome(id, true, { totalTokens: 1000, elapsedMs: 1000 }))
  const reach: ReachMap = {
    a: { modules: ['src/tools/edit.ts'], runs: 1, at: 0 },
    b: { modules: ['src/agentLoop.ts'], runs: 1, at: 0 },
    c: { modules: ['src/agentLoop.ts'], runs: 1, at: 0 },
    d: { modules: ['src/agentLoop.ts'], runs: 1, at: 0 },
    e: { modules: ['src/agentLoop.ts'], runs: 1, at: 0 },
  }
  const { ran, measure } = scripted({ a: outcome('a', true, { totalTokens: 1000, elapsedMs: 1000 }) })

  const report = await raceCandidate({
    sourceRoot: '/sandbox',
    tasks: FIVE.map(task),
    baseline: metricsFrom(baselineOutcomes),
    baselineOutcomes,
    changedFiles: ['src/tools/edit.ts'],
    measure,
    reach,
  })

  expect(ran).toEqual(['a'])
  expect(report.card.totalTokens).toBe(5000)
  expect(report.card.passRate).toBe(1)
  expect(report.comparison.better).toBe(false)
  expect(report.comparison.reason).toContain('no measurable improvement')
})

test('a regression settles the verdict without running the rest — and settles it the same way', async () => {
  const baselineOutcomes = FIVE.map((id) => outcome(id, true))
  const baseline = metricsFrom(baselineOutcomes)
  const reach: ReachMap = Object.fromEntries(FIVE.map((id) => [id, { modules: ['src/agentLoop.ts'], runs: 1, at: 0 }]))
  const script = { c: outcome('c', false) }
  const { ran, measure } = scripted(script)

  const report = await raceCandidate({
    sourceRoot: '/sandbox',
    tasks: FIVE.map(task),
    baseline,
    baselineOutcomes,
    changedFiles: ['src/agentLoop.ts'],
    measure,
    reach,
  })

  expect(report.comparison.better).toBe(false)
  expect(report.settledBy).toBe('c')
  expect(ran.length).toBeLessThan(FIVE.length)
  expect(report.skipped.length).toBeGreaterThan(0)

  // The claim that matters: racing changed what was paid for, not the answer.
  const fullSweep = compareScorecards(
    baseline,
    metricsFrom(FIVE.map((id) => script[id as keyof typeof script] ?? outcome(id, true))),
  )
  expect(report.comparison.better).toBe(fullSweep.better)
  expect(report.comparison.reason).toBe(fullSweep.reason)
})

test('a task that could not be measured settles it too, the same way', async () => {
  const baselineOutcomes = FIVE.map((id) => outcome(id, true))
  const baseline = metricsFrom(baselineOutcomes)
  const reach: ReachMap = Object.fromEntries(FIVE.map((id) => [id, { modules: ['src/agentLoop.ts'], runs: 1, at: 0 }]))
  const { ran, measure } = scripted({ a: outcome('a', false, { unmeasured: true }) })

  const report = await raceCandidate({
    sourceRoot: '/sandbox',
    tasks: FIVE.map(task),
    baseline,
    baselineOutcomes,
    changedFiles: ['src/agentLoop.ts'],
    measure,
    reach,
  })

  expect(report.comparison.better).toBe(false)
  expect(report.comparison.reason).toContain('could not measure a')
  expect(ran).toEqual(['a'])
})

test('a candidate that regresses nowhere and fixes a failure is better, on the tasks that can move', async () => {
  const baselineOutcomes = [outcome('a', true), outcome('b', true), outcome('c', false), outcome('d', true), outcome('e', true)]
  const baseline = metricsFrom(baselineOutcomes)
  const reach: ReachMap = {
    a: { modules: ['src/tools/edit.ts'], runs: 1, at: 0 },
    b: { modules: ['src/agentLoop.ts'], runs: 1, at: 0 },
    c: { modules: ['src/tools/edit.ts'], runs: 1, at: 0 },
    d: { modules: ['src/agentLoop.ts'], runs: 1, at: 0 },
    e: { modules: ['src/agentLoop.ts'], runs: 1, at: 0 },
  }
  const { ran, measure } = scripted({ c: outcome('c', true) })

  const report = await raceCandidate({
    sourceRoot: '/sandbox',
    tasks: FIVE.map(task),
    baseline,
    baselineOutcomes,
    changedFiles: ['src/tools/edit.ts'],
    measure,
    reach,
  })

  expect(ran.sort()).toEqual(['a', 'c'])
  expect(report.comparison.better).toBe(true)
  expect(report.comparison.reason).toContain('now passes c')
  expect(report.skipped).toEqual([])
})

test('tasks the race never ran are recorded as unmeasured, so the card fails closed', async () => {
  // A partial card must never read as a result. `compareScorecards` refuses any
  // comparison with an unmeasured task, which is what makes this safe to store.
  const baselineOutcomes = FIVE.map((id) => outcome(id, true))
  const baseline = metricsFrom(baselineOutcomes)
  const reach: ReachMap = Object.fromEntries(FIVE.map((id) => [id, { modules: ['src/agentLoop.ts'], runs: 1, at: 0 }]))
  const { measure } = scripted({ a: outcome('a', false) })

  const report = await raceCandidate({
    sourceRoot: '/sandbox',
    tasks: FIVE.map(task),
    baseline,
    baselineOutcomes,
    changedFiles: ['src/agentLoop.ts'],
    measure,
    reach,
  })

  expect(report.card.unmeasured.sort()).toEqual(report.skipped.sort())
  expect(compareScorecards(baseline, toMetrics(report.card)).better).toBe(false)
})

test('a diff that adds a file is never called inert', async () => {
  // A new module can be loaded by a registry that discovers it at runtime, so no
  // recording can prove it unreachable. The race falls back to the whole set.
  const baselineOutcomes = FIVE.map((id) => outcome(id, true))
  const reach: ReachMap = Object.fromEntries(FIVE.map((id) => [id, { modules: ['src/agentLoop.ts'], runs: 1, at: 0 }]))
  const { ran, measure } = scripted({})

  await raceCandidate({
    sourceRoot: '/sandbox',
    tasks: FIVE.map(task),
    baseline: metricsFrom(baselineOutcomes),
    baselineOutcomes,
    changedFiles: ['src/a-file-that-does-not-exist-in-the-live-tree.ts'],
    measure,
    reach,
  })

  expect(ran.sort()).toEqual([...FIVE].sort())
})

test('an inert task with no baseline row is measured rather than assumed', async () => {
  const baselineOutcomes = [outcome('a', true)]
  const reach: ReachMap = {
    a: { modules: ['src/tools/edit.ts'], runs: 1, at: 0 },
    b: { modules: ['src/agentLoop.ts'], runs: 1, at: 0 },
  }
  const { ran, measure } = scripted({})

  const report = await raceCandidate({
    sourceRoot: '/sandbox',
    tasks: ['a', 'b'].map(task),
    baseline: metricsFrom(baselineOutcomes),
    baselineOutcomes,
    changedFiles: ['src/tools/edit.ts'],
    measure,
    reach,
  })

  expect(ran.sort()).toEqual(['a', 'b'])
  expect(report.carried).toEqual([])
})

test('the order runs passing, diff-heavy, cheap tasks first', () => {
  const reach: ReachMap = {
    heavy: { modules: ['src/a.ts', 'src/b.ts'], runs: 1, at: 0 },
    light: { modules: ['src/a.ts'], runs: 1, at: 0 },
    slow: { modules: ['src/a.ts'], runs: 1, at: 0 },
    failing: { modules: ['src/a.ts', 'src/b.ts'], runs: 1, at: 0 },
  }
  const baselineOutcomes = [
    outcome('heavy', true, { elapsedMs: 9000 }),
    outcome('light', true, { elapsedMs: 100 }),
    outcome('slow', true, { elapsedMs: 9000 }),
    outcome('failing', false),
  ]
  const ordered = raceOrder(
    ['slow', 'failing', 'light', 'heavy'].map(task),
    metricsFrom(baselineOutcomes),
    ['src/a.ts', 'src/b.ts'],
    reach,
    baselineOutcomes,
  )

  expect(ordered.map((t) => t.id)).toEqual(['heavy', 'light', 'slow', 'failing'])
})

test('regressions are counted by the same half-attempt rule the comparison uses', () => {
  const baseline: Metrics = { passRate: 1, passed: ['a'], failed: [], taskRates: { a: 1, b: 0.6 }, totalTokens: 0, totalElapsedMs: 0 }
  expect(regressionsIn(baseline, [outcome('a', false)])).toEqual(['a'])
  // A third of the attempts flipping is the noise repeats exist to absorb.
  expect(regressionsIn(baseline, [outcome('b', true, { attempts: 3, passes: 1 })])).toEqual([])
  // An unmeasured task is not a regression; it is handled before them.
  expect(regressionsIn(baseline, [outcome('a', false, { unmeasured: true })])).toEqual([])
})

test('a carried row keeps its numbers and drops the baseline evidence directory', () => {
  const carried = carryOutcome(outcome('a', true, { keptDir: '/baseline/evidence', totalTokens: 77, attempts: 3, passes: 2 }))
  expect(carried.keptDir).toBeUndefined()
  expect(carried.totalTokens).toBe(77)
  expect(carried.attempts).toBe(3)
  expect(carried.passes).toBe(2)
  expect(carried.detail).toContain('carried')
})

test('the race can be switched off', () => {
  const before = process.env.ELIA_SIEVE
  try {
    process.env.ELIA_SIEVE = 'off'
    expect(sieveEnabled()).toBe(false)
    process.env.ELIA_SIEVE = 'on'
    expect(sieveEnabled()).toBe(true)
    delete process.env.ELIA_SIEVE
    expect(sieveEnabled()).toBe(true)
  } finally {
    if (before === undefined) delete process.env.ELIA_SIEVE
    else process.env.ELIA_SIEVE = before
  }
})

test('the operator line says what was not paid for', () => {
  const line = renderRace(
    { card: {} as Scorecard, comparison: { better: false, reason: '' }, ran: ['a'], carried: ['b', 'c'], skipped: ['d'], settledBy: 'a', tokens: 0, elapsedMs: 0 },
    4,
  )
  expect(line).toContain('1/4 task(s) run')
  expect(line).toContain('2 carried')
  expect(line).toContain('after a settled it')
  expect(line).toContain('3 task run(s) not paid for')
})

test('a real efficiency win survives carrying, and the race does not manufacture one', async () => {
  // The measured task spends half the tokens and half the time it used to; the
  // four carried tasks are unchanged. The win has to read as the real ~10%, not
  // as the 80% that dropping the carried rows would have invented.
  const baselineOutcomes = FIVE.map((id) => outcome(id, true, { totalTokens: 1000, elapsedMs: 1000 }))
  const reach: ReachMap = {
    a: { modules: ['src/tools/edit.ts'], runs: 1, at: 0 },
    b: { modules: ['src/agentLoop.ts'], runs: 1, at: 0 },
    c: { modules: ['src/agentLoop.ts'], runs: 1, at: 0 },
    d: { modules: ['src/agentLoop.ts'], runs: 1, at: 0 },
    e: { modules: ['src/agentLoop.ts'], runs: 1, at: 0 },
  }
  const { measure } = scripted({ a: outcome('a', true, { totalTokens: 100, elapsedMs: 500 }) })

  const report = await raceCandidate({
    sourceRoot: '/sandbox',
    tasks: FIVE.map(task),
    baseline: metricsFrom(baselineOutcomes),
    baselineOutcomes,
    changedFiles: ['src/tools/edit.ts'],
    measure,
    reach,
  })

  // 4100 of 5000 tokens: an 18% saving across the suite, which clears the margin.
  expect(report.card.totalTokens).toBe(4100)
  expect(report.comparison.better).toBe(true)
  expect(report.comparison.reason).toContain('fewer tokens')
})

test('a partial card is timed by scaling the baseline, not by how long the race took', () => {
  const baseline: Metrics = { passRate: 1, passed: [], failed: [], totalTokens: 0, totalElapsedMs: 5000, wallClockMs: 2000 }
  // Half the summed task time means half the parallel duration, same concurrency.
  expect(scaledWallClock(baseline, 2500)).toBe(1000)
  expect(scaledWallClock(baseline, 5000)).toBe(2000)
  // A baseline with no timings at all cannot scale anything; say so by not trying.
  expect(scaledWallClock({ passRate: 1, passed: [], failed: [], totalTokens: 0, totalElapsedMs: 0 }, 42)).toBe(42)
})
