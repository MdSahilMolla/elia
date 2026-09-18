import { expect, test } from 'bun:test'

process.env.ANTHROPIC_API_KEY ??= 'test-key-for-evolve-power-test'

const { ASSUMED_RELIABILITY, detectableEffect, improvedBy, inferTasks, isAssumed, measurePower, renderGatePower, seededRandom, simulateSweep } = await import('./power.ts')
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

test('the current suite cannot carry even a large win to a promotion', () => {
  // This is the finding the module exists to keep honest. If re-banding the
  // benchmark ever fixes it, this expectation is what will fail and say so.
  const floor = detectableEffect({ tasks: currentSuite(), repeats: 1, trials: 300, seed: 3 })
  expect(floor).toBeUndefined()
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

test('the report names the floor and warns when repeats fight REAL_CHANGE', () => {
  const report = renderGatePower(currentSuite(), 9, 2)
  expect(report).toContain('54 task(s)')
  expect(report).toContain('repeats above 3')
})

test('an empty benchmark reports nothing rather than dividing by zero', () => {
  expect(renderGatePower([], 1)).toContain('no benchmark recorded yet')
})
