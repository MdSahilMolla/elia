import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.ANTHROPIC_API_KEY ??= 'test-key-for-lift-test'
process.env.NO_COLOR = '1'

const { LIFT_EVIDENCE, compareLift, liftEvidence, readLiftRuns, recordLiftRun, renderLift, verdictLine } = await import('./lift.ts')
type Scorecard = import('./fitness.ts').Scorecard
type TaskOutcome = import('./fitness.ts').TaskOutcome

const outcome = (taskId: string, passes: number, overrides: Partial<TaskOutcome> = {}): TaskOutcome => ({
  taskId,
  weight: 1,
  passed: passes * 2 >= 3,
  detail: '',
  steps: 5,
  elapsedMs: 1000,
  totalTokens: 10_000,
  attempts: 3,
  passes,
  ...overrides,
})

const card = (outcomes: TaskOutcome[], model = 'm'): Scorecard => ({
  sourceRoot: '/elia',
  model,
  outcomes,
  passRate: 0,
  unmeasured: outcomes.filter((o) => o.unmeasured).map((o) => o.taskId),
  totalTokens: 0,
  totalElapsedMs: 0,
  wallClockMs: 0,
  cacheHits: 0,
  cacheMisses: 0,
  cacheHitRate: 0,
})

const ids = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`)

test('a harness that wins task after task is proven to help', () => {
  const report = compareLift(card(ids(12).map((id) => outcome(id, 3))), card(ids(12).map((id) => outcome(id, 0))))
  expect(report.lift).toBe(1)
  expect(report.wins).toBe(12)
  expect(report.eHelps).toBeGreaterThanOrEqual(LIFT_EVIDENCE)
  expect(report.verdict).toBe('helps')
  expect(verdictLine(report)).toContain('the harness helps: +100 points')
})

test('when the bare model wins, that is the verdict — the comparison is not one-sided', () => {
  const report = compareLift(card(ids(12).map((id) => outcome(id, 0))), card(ids(12).map((id) => outcome(id, 3))))
  expect(report.verdict).toBe('hurts')
  expect(verdictLine(report)).toContain('the bare model scores +100 points higher')
})

test('a few points on a few tasks is reported as noise, not as a lift', () => {
  // One win in five tasks: +7 points, and nowhere near evidence.
  const elia = card([outcome('a', 3), outcome('b', 2), outcome('c', 3), outcome('d', 1), outcome('e', 3)])
  const bare = card([outcome('a', 2), outcome('b', 2), outcome('c', 3), outcome('d', 1), outcome('e', 3)])
  const report = compareLift(elia, bare)
  expect(report.lift).toBeGreaterThan(0)
  expect(report.verdict).toBe('inconclusive')
  expect(verdictLine(report)).toContain('no measurable difference yet')
})

test('a task either arm could not measure leaves both sides', () => {
  const elia = card([outcome('a', 3), outcome('b', 3, { unmeasured: true }), outcome('c', 0)])
  const bare = card([outcome('a', 0), outcome('b', 0), outcome('c', 0, { unmeasured: true })])
  const report = compareLift(elia, bare)
  expect(report.tasks.map((task) => task.taskId)).toEqual(['a'])
  expect(report.unmeasured).toEqual(['b', 'c'])
  expect(report.eliaRate).toBe(1)
  expect(report.bareRate).toBe(0)
})

test('arms on different models are refused, not compared', () => {
  const report = compareLift(card([outcome('a', 3)], 'model-a'), card([outcome('a', 0)], 'model-b'))
  expect(report.verdict).toBe('not comparable')
  expect(report.why).toContain('different models')
})

test('rates are weighted like the benchmark’s own pass rate', () => {
  const elia = card([outcome('heavy', 3, { weight: 3 }), outcome('light', 0)])
  const bare = card([outcome('heavy', 0, { weight: 3 }), outcome('light', 3)])
  const report = compareLift(elia, bare)
  expect(report.eliaRate).toBe(0.75)
  expect(report.bareRate).toBe(0.25)
})

test('the rendering shows both arms per task and the verdict', () => {
  const text = renderLift(compareLift(card([outcome('a', 3)]), card([outcome('a', 1)])))
  expect(text).toContain('Harness lift')
  expect(text).toContain('3/3')
  expect(text).toContain('1/3')
  expect(text).toContain('elia better on 1, bare better on 0, tied on 0')
})

const dir = mkdtempSync(join(tmpdir(), 'elia-lift-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

test('a lift is remembered for elia compounding, and never measured says so', () => {
  const path = join(dir, 'lift.ndjson')
  expect(liftEvidence(readLiftRuns(path))).toContain('never measured')
  recordLiftRun(compareLift(card(ids(12).map((id) => outcome(id, 3))), card(ids(12).map((id) => outcome(id, 0)))), 'synthetic', path)
  const runs = readLiftRuns(path)
  expect(runs).toHaveLength(1)
  expect(liftEvidence(runs)).toContain('harness lift +100 points, proven')
})
