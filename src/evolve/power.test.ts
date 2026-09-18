import { expect, test } from 'bun:test'

process.env.ANTHROPIC_API_KEY ??= 'test-key-for-evolve-power-test'

const { ASSUMED_RELIABILITY, detectableEffect, improvedBy, inferTasks, isAssumed, measurePower, renderGatePower, rerunSet, seededRandom, simulateSweep } = await import('./power.ts')
import type { PowerTask } from './power.ts'

/** The suite as it stands: 54 tasks, ~93% pass rate, 4 real failures. */
const currentSuite = (): PowerTask[] => [
  ...Array.from({ length: 46 }, (_, i) => ({ id: `solid-${i}`, pi: 0.99 })),
  ...Array.from({ length: 4 }, (_, i) => ({ id: `flaky-${i}`, pi: 0.85 })),
  ...Array.from({ length: 4 }, (_, i) => ({ id: `hard-${i}`, pi: 0.2 })),
]

test('a seeded run is reproducible', () => {
  const a = measurePower({ tasks: currentSuite(), repeats: 1, delta: 0.1, trials: 200, seed: 7 })
  const b = measurePower({ tasks: currentSuite(), repeats: 1, delta: 0.1, trials: 200, seed: 7 })
  expect(a.promoted).toBe(b.promoted)
})

test('a sweep at repeats=1 carries no taskRates, matching toMetrics', () => {
  const random = seededRandom(1)
  expect(simulateSweep(currentSuite(), 1, random).taskRates).toBeUndefined()
  expect(simulateSweep(currentSuite(), 3, random).taskRates).toBeDefined()
})

test('cost is both trees, twice — the race and the confirmation pair', () => {
  expect(measurePower({ tasks: currentSuite(), repeats: 3, delta: 0, trials: 10 }).costPerGeneration).toBe(4 * 54 * 3)
})

test('with every task re-run, the suite cannot carry even a large win', () => {
  // This is the finding the module exists to keep honest. If re-banding the
  // benchmark ever fixes it, this expectation is what will fail and say so.
  const floor = detectableEffect({ tasks: currentSuite(), repeats: 1, trials: 300, seed: 3 })
  expect(floor).toBeUndefined()
})

test('the sieve rescues the gate: carried tasks cannot flip, so they cannot reject', () => {
  // raceCandidate copies the baseline row for unreachable tasks. Modelling every
  // task as independently re-drawn understates the gate badly — a real win goes
  // from near-never promoted across all 54 to near-always across the 4 it reaches.
  const tasks = currentSuite()
  const wide = measurePower({ tasks, repeats: 1, delta: 0.85, trials: 400, seed: 21 })
  const narrow = measurePower({ tasks, repeats: 1, delta: 0.85, trials: 400, seed: 21, rerun: rerunSet(tasks, 4) })
  expect(narrow.promoted).toBeGreaterThan(wide.promoted + 0.4)
})

test('a narrowed re-run set costs proportionally less', () => {
  const tasks = currentSuite()
  const narrow = measurePower({ tasks, repeats: 1, delta: 0.5, trials: 50, seed: 2, rerun: rerunSet(tasks, 6) })
  expect(narrow.costPerGeneration).toBe(4 * 6 * 1)
})

test('rerunSet always includes every failing task', () => {
  const ids = rerunSet(currentSuite(), 6)
  for (let i = 0; i < 4; i++) expect(ids.has(`hard-${i}`)).toBe(true)
  expect(ids.size).toBe(6)
})

test('a candidate no better than the baseline is still promoted sometimes', () => {
  // Race and confirmation square the race's false-positive rate, which is what
  // keeps this small — but it is not zero, so a promotion is evidence, not proof.
  const noise = measurePower({ tasks: currentSuite(), repeats: 1, delta: 0, trials: 600, seed: 5 })
  expect(noise.falsePromoted).toBeGreaterThan(0)
  expect(noise.falsePromoted).toBeLessThan(0.1)
})

test('a genuinely better candidate is more likely to promote than an identical one', () => {
  const tasks = currentSuite()
  const big = measurePower({ tasks, repeats: 1, delta: 0.3, trials: 600, seed: 11 })
  expect(big.promoted).toBeGreaterThan(big.falsePromoted)
})

test('improvedBy raises every task and never exceeds certainty', () => {
  const raised = improvedBy([{ id: 'a', pi: 0.9 }, { id: 'b', pi: 0.2 }], 0.2)
  expect(raised[0]!.pi).toBeLessThanOrEqual(0.995)
  expect(raised[1]!.pi).toBeCloseTo(0.4, 5)
})

test('one observation is an assumption, and inferTasks says so rather than estimating', () => {
  // A single run cannot measure flakiness. Smoothing it to 0.67 would simulate a
  // far noisier suite than elia's and make the gate look blind for the wrong reason.
  const tasks = inferTasks({ passed: ['a'], failed: ['b'] })
  expect(tasks.find((t) => t.id === 'a')!.pi).toBe(ASSUMED_RELIABILITY.passed)
  expect(tasks.find((t) => t.id === 'b')!.pi).toBe(ASSUMED_RELIABILITY.failed)
  expect(isAssumed({})).toBe(true)
})

test('inferTasks uses measured rates once the benchmark repeated tasks', () => {
  const tasks = inferTasks({ taskRates: { a: 1, b: 0 }, attempts: 3 })
  expect(tasks.find((t) => t.id === 'a')!.pi).toBeCloseTo(3.5 / 4, 5)
  expect(isAssumed({ taskRates: { a: 1 }, attempts: 3 })).toBe(false)
})

test('the report names the assumption it rests on', () => {
  expect(renderGatePower([{ id: 'a', pi: 0.97 }], 1, 1, true)).toContain('assuming')
  expect(renderGatePower([{ id: 'a', pi: 0.97 }], 3, 1, false)).toContain('measured per-task rates')
})

test('the report shows the sieve curve and warns when repeats fight REAL_CHANGE', () => {
  const report = renderGatePower(currentSuite(), 9, 2)
  expect(report).toContain('54 task(s)')
  expect(report).toContain('ELIA_SIEVE=off')
  expect(report).toContain('repeats above 3')
})

test('an empty benchmark reports nothing rather than dividing by zero', () => {
  expect(renderGatePower([], 1)).toContain('no benchmark recorded yet')
})
