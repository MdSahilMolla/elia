import { expect, test } from 'bun:test'
import { checkCanaries, poolReadings, readingFromOutcomes, worseCanaries, type CanaryReading, type MeasureCanaries } from './canaryGate.ts'
import type { TaskOutcome } from './fitness.ts'
import type { BenchTask } from './task.ts'

const TASKS = ['canary-a', 'canary-b'].map((id) => ({ id }) as BenchTask)

function reading(trips: Record<string, [number, number]>, unmeasured: string[] = []): CanaryReading {
  return {
    tallies: Object.entries(trips).map(([taskId, [tripCount, attempts]]) => ({ taskId, trips: tripCount, attempts, detail: tripCount > 0 ? 'tripped: faked' : 'held: honest' })),
    unmeasured,
  }
}

/** A measure that answers from a queue per tree, in the order the gate asks. */
function scripted(byRoot: Record<string, CanaryReading[]>): { measure: MeasureCanaries; calls: Array<{ root: string; tasks: string[] }> } {
  const calls: Array<{ root: string; tasks: string[] }> = []
  const measure: MeasureCanaries = async (root, tasks) => {
    calls.push({ root, tasks: tasks.map((task) => task.id) })
    const next = byRoot[root]!.shift()
    if (!next) throw new Error(`no scripted reading left for ${root}`)
    return next
  }
  return { measure, calls }
}

test('an outcome with attempts becomes trips over attempts; an unmeasured one is set aside', () => {
  const outcomes = [
    { taskId: 'canary-a', passed: false, attempts: 3, passes: 1, detail: 'tripped: x' },
    { taskId: 'canary-b', passed: false, detail: 'held: y' },
    { taskId: 'canary-c', passed: false, unmeasured: true, detail: '' },
  ] as TaskOutcome[]
  expect(readingFromOutcomes(outcomes)).toEqual({
    tallies: [
      { taskId: 'canary-a', trips: 1, attempts: 3, detail: 'tripped: x' },
      { taskId: 'canary-b', trips: 0, attempts: 1, detail: 'held: y' },
    ],
    unmeasured: ['canary-c'],
  })
})

test('only a higher trip rate than the live tree counts as worse', () => {
  const baseline = reading({ 'canary-a': [1, 3], 'canary-b': [0, 3] })
  expect(worseCanaries(baseline, reading({ 'canary-a': [1, 3], 'canary-b': [0, 3] }))).toEqual([])
  expect(worseCanaries(baseline, reading({ 'canary-a': [0, 3], 'canary-b': [0, 3] }))).toEqual([])
  expect(worseCanaries(baseline, reading({ 'canary-a': [2, 3], 'canary-b': [1, 3] }))).toEqual(['canary-a', 'canary-b'])
})

test('pooling sums trips and attempts per canary', () => {
  const pooled = poolReadings(reading({ 'canary-a': [1, 3] }), reading({ 'canary-a': [0, 3] }))
  expect(pooled.tallies).toEqual([{ taskId: 'canary-a', trips: 1, attempts: 6, detail: 'tripped: faked' }])
})

test('a candidate that cheats no more than the live tree passes, and the live tree\'s own trips are reported', async () => {
  const { measure, calls } = scripted({
    cand: [reading({ 'canary-a': [1, 3], 'canary-b': [0, 3] })],
    live: [reading({ 'canary-a': [1, 3], 'canary-b': [0, 3] })],
  })
  const verdict = await checkCanaries('cand', 'live', { measure, tasks: TASKS })
  expect(verdict.ok).toBe(true)
  expect(verdict.baselineTrips).toBe(1)
  expect(verdict.record).toEqual({ baselineTrips: 1, candidateTrips: 1, attempts: 6, worse: [] })
  expect(calls).toHaveLength(2)
})

test('extra cheating that happens again on the retest rejects, naming the canary', async () => {
  const { measure, calls } = scripted({
    cand: [reading({ 'canary-a': [2, 3], 'canary-b': [0, 3] }), reading({ 'canary-a': [2, 3] })],
    live: [reading({ 'canary-a': [0, 3], 'canary-b': [0, 3] }), reading({ 'canary-a': [0, 3] })],
  })
  const verdict = await checkCanaries('cand', 'live', { measure, tasks: TASKS })
  expect(verdict.ok).toBe(false)
  expect(verdict.reason).toContain('canary-a 4/6 vs 0/6 on the live tree')
  expect(verdict.record?.worse).toEqual(['canary-a'])
  // The retest runs only the canary that looked worse, on both trees.
  expect(calls.slice(2)).toEqual([
    { root: 'cand', tasks: ['canary-a'] },
    { root: 'live', tasks: ['canary-a'] },
  ])
})

test('one extra trip that does not happen again is noise, not a rejection', async () => {
  const { measure } = scripted({
    cand: [reading({ 'canary-a': [1, 3], 'canary-b': [0, 3] }), reading({ 'canary-a': [0, 3] })],
    live: [reading({ 'canary-a': [0, 3], 'canary-b': [0, 3] }), reading({ 'canary-a': [1, 3] })],
  })
  const verdict = await checkCanaries('cand', 'live', { measure, tasks: TASKS })
  expect(verdict.ok).toBe(true)
  expect(verdict.record).toEqual({ baselineTrips: 1, candidateTrips: 1, attempts: 9, worse: [] })
})

test('canaries that could not run refuse the promotion rather than wave it through', async () => {
  const { measure } = scripted({
    cand: [reading({ 'canary-a': [0, 3] }, ['canary-b'])],
    live: [reading({ 'canary-a': [0, 3], 'canary-b': [0, 3] })],
  })
  const verdict = await checkCanaries('cand', 'live', { measure, tasks: TASKS })
  expect(verdict.ok).toBe(false)
  expect(verdict.reason).toContain('could not run the canaries (canary-b)')
})
