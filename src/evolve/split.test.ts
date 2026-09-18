import { expect, test } from 'bun:test'

process.env.ANTHROPIC_API_KEY ??= 'test-key-for-split-test'

const {
  blindEvidence,
  blindMetrics,
  classifyGeneralization,
  halfMetrics,
  renderGeneralization,
  renderSplit,
  splitTasks,
  taskHash,
} = await import('./split.ts')
const { REAL_CHANGE, cardFromOutcomes, toMetrics } = await import('./fitness.ts')
import type { TaskOutcome } from './fitness.ts'
import type { BenchTask } from './task.ts'

function task(id: string, weight = 1): BenchTask {
  return { id, weight, prompt: id, setup: async () => {}, check: async () => ({ passed: true, detail: '' }) }
}

function outcome(taskId: string, passed: boolean, over: Partial<TaskOutcome> = {}): TaskOutcome {
  return { taskId, weight: 1, passed, detail: passed ? 'ok' : 'wrong', steps: 3, elapsedMs: 1000, totalTokens: 1000, model: 'm', ...over }
}

const MANY = ['precise-edit', 'find-symbol', 'fix-failing-test', 'propagate-rename', 'hist-7c2db18', 'hist-fa1f598', 'hist-c9d115e', 'hist-99ade90', 'slugify', 'stats-median', 'form-scope', 'money-tax']

test('the split is a property of the task id, not its position', () => {
  const tasks = MANY.map((id) => task(id))
  const forward = splitTasks(tasks)
  const backward = splitTasks([...tasks].reverse())

  expect(new Set(forward.heldOut.map((t) => t.id))).toEqual(new Set(backward.heldOut.map((t) => t.id)))
})

test('harvesting a new task never moves an existing one across the line', () => {
  const before = splitTasks(MANY.map((id) => task(id)))
  const after = splitTasks([...MANY, 'hist-newly-harvested', 'hist-another'].map((id) => task(id)))

  for (const id of MANY) {
    const wasHeldOut = before.heldOut.some((t) => t.id === id)
    const isHeldOut = after.heldOut.some((t) => t.id === id)
    expect(`${id}:${isHeldOut}`).toBe(`${id}:${wasHeldOut}`)
  }
})

test('both halves are non-empty, and together they are the whole corpus', () => {
  const split = splitTasks(MANY.map((id) => task(id)))

  expect(split.split).toBe(true)
  expect(split.train.length).toBeGreaterThan(0)
  expect(split.heldOut.length).toBeGreaterThan(0)
  expect([...split.train, ...split.heldOut].map((t) => t.id).sort()).toEqual([...MANY].sort())
})

test('a corpus too small to split leaves every task shown', () => {
  const split = splitTasks([task('a'), task('b')])

  expect(split.split).toBe(false)
  expect(split.heldOut).toEqual([])
  expect(split.train).toHaveLength(2)
  expect(renderSplit(split)).toContain('too few')
})

test('a hash that lands everything on one side still yields two halves', () => {
  // Fraction 1 - epsilon puts every id below the line; the fallback has to keep
  // one task shown rather than hand the proposer nothing to work from.
  const split = splitTasks(MANY.map((id) => task(id)), 0.999999)

  expect(split.train).toHaveLength(1)
  expect(split.heldOut).toHaveLength(MANY.length - 1)
})

test('taskHash is stable across calls and inside the unit interval', () => {
  for (const id of MANY) {
    expect(taskHash(id)).toBe(taskHash(id))
    expect(taskHash(id)).toBeGreaterThanOrEqual(0)
    expect(taskHash(id)).toBeLessThan(1)
  }
})

test('the brief names no held-out task', () => {
  const tasks = MANY.map((id) => task(id))
  const split = splitTasks(tasks)
  const outcomes = tasks.map((t, index) => outcome(t.id, index % 2 === 0))
  const whole = toMetrics(cardFromOutcomes('/live', tasks, outcomes, 5000))

  const shown = blindMetrics(whole, split, halfMetrics(outcomes, split.train).passRate)
  const shownEvidence = blindEvidence(outcomes.filter((o) => !o.passed), split)

  const named = [...shown.passed, ...shown.failed, ...Object.keys(shown.steps ?? {}), ...shownEvidence.map((o) => o.taskId)]
  for (const heldOut of split.heldOut) expect(named).not.toContain(heldOut.id)
  // ...and everything on the shown side is still there to work from.
  for (const train of split.train) expect(named).toContain(train.id)
})

test('the blinded pass rate is the shown half, not the whole corpus', () => {
  const tasks = MANY.map((id) => task(id))
  const split = splitTasks(tasks)
  // Everything shown passes; everything held out fails. The whole-corpus rate
  // and the shown rate must therefore disagree, and the brief must carry the
  // number the proposer can actually account for.
  const outcomes = tasks.map((t) => outcome(t.id, split.train.some((s) => s.id === t.id)))
  const whole = toMetrics(cardFromOutcomes('/live', tasks, outcomes, 5000))

  const shown = blindMetrics(whole, split, halfMetrics(outcomes, split.train).passRate)

  expect(whole.passRate).toBeLessThan(1)
  expect(shown.passRate).toBe(1)
})

test('a gain on a held-out task reads as generalized', () => {
  const tasks = MANY.map((id) => task(id))
  const split = splitTasks(tasks)
  const target = split.heldOut[0]!
  const before = tasks.map((t) => outcome(t.id, t.id !== target.id))
  const after = tasks.map((t) => outcome(t.id, true))

  const record = classifyGeneralization({
    baselineOutcomes: before,
    candidateOutcomes: after,
    split,
    ranTaskIds: tasks.map((t) => t.id),
    realChange: REAL_CHANGE,
  })

  expect(record.verdict).toBe('generalized')
  expect(record.gainedUnseen).toEqual([target.id])
  expect(record.heldOutMeasured).toBe(split.heldOut.length)
})

test('a gain confined to the tasks it was shown reads as shown-only', () => {
  const tasks = MANY.map((id) => task(id))
  const split = splitTasks(tasks)
  const target = split.train[0]!
  const before = tasks.map((t) => outcome(t.id, t.id !== target.id))
  const after = tasks.map((t) => outcome(t.id, true))

  const record = classifyGeneralization({
    baselineOutcomes: before,
    candidateOutcomes: after,
    split,
    ranTaskIds: tasks.map((t) => t.id),
    realChange: REAL_CHANGE,
  })

  expect(record.verdict).toBe('shown-only')
  expect(record.gainedShown).toEqual([target.id])
  expect(record.gainedUnseen).toEqual([])
})

test('a candidate that moved nothing reads as flat', () => {
  const tasks = MANY.map((id) => task(id))
  const split = splitTasks(tasks)
  const rows = tasks.map((t) => outcome(t.id, true))

  const record = classifyGeneralization({
    baselineOutcomes: rows,
    candidateOutcomes: rows,
    split,
    ranTaskIds: tasks.map((t) => t.id),
    realChange: REAL_CHANGE,
  })

  expect(record.verdict).toBe('flat')
})

test('held-out tasks the sieve carried rather than ran are not counted as measured', () => {
  const tasks = MANY.map((id) => task(id))
  const split = splitTasks(tasks)
  const rows = tasks.map((t) => outcome(t.id, true))

  const record = classifyGeneralization({
    baselineOutcomes: rows,
    candidateOutcomes: rows,
    split,
    // The diff only reached the shown half; every held-out row carried over.
    ranTaskIds: split.train.map((t) => t.id),
    realChange: REAL_CHANGE,
  })

  expect(record.heldOutMeasured).toBe(0)
  expect(record.heldOutTotal).toBe(split.heldOut.length)
  expect(renderGeneralization(record)).toContain(`0/${split.heldOut.length}`)
})

test('a run too small to split says so rather than claiming a verdict', () => {
  const tasks = [task('a'), task('b')]
  const split = splitTasks(tasks)
  const rows = tasks.map((t) => outcome(t.id, true))

  const record = classifyGeneralization({
    baselineOutcomes: rows,
    candidateOutcomes: rows,
    split,
    ranTaskIds: ['a', 'b'],
    realChange: REAL_CHANGE,
  })

  expect(record.verdict).toBe('not-split')
  expect(renderGeneralization(record)).toContain('not measured')
})

test('a movement smaller than run-to-run noise is not a gain', () => {
  const tasks = MANY.map((id) => task(id))
  const split = splitTasks(tasks)
  const target = split.heldOut[0]!
  // Repeated runs: the task went from 2/5 attempts to 3/5. Below REAL_CHANGE,
  // so it is the benchmark's own variance rather than an improvement.
  const before = tasks.map((t) => outcome(t.id, true, t.id === target.id ? { attempts: 5, passes: 2, passed: false } : {}))
  const after = tasks.map((t) => outcome(t.id, true, t.id === target.id ? { attempts: 5, passes: 3 } : {}))

  const record = classifyGeneralization({
    baselineOutcomes: before,
    candidateOutcomes: after,
    split,
    ranTaskIds: tasks.map((t) => t.id),
    realChange: REAL_CHANGE,
  })

  expect(record.gainedUnseen).toEqual([])
  expect(record.verdict).toBe('flat')
})

test('weights follow their own half', () => {
  const tasks = [task('precise-edit', 3), task('find-symbol', 1), task('hist-7c2db18', 5), task('slugify', 1), task('stats-median', 2)]
  const split = splitTasks(tasks)
  const rows = tasks.map((t) => outcome(t.id, true))

  // Each half is scored against its own total weight, so a half in which
  // everything passes is 100% however heavy its tasks are.
  expect(halfMetrics(rows, split.train).passRate).toBe(1)
  expect(halfMetrics(rows, split.heldOut).passRate).toBe(1)
})
