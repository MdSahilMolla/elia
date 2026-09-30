import { expect, test } from 'bun:test'
import { analyze, renderReport } from './analyze.ts'
import type { Arms } from './analyze.ts'
import { SIGNAL_CRITERIA } from './basket.ts'
import type { Measured, Outcome } from './outcomes.ts'

const WEEK = 7 * 86_400

/** Survival spread over [0, 1] with a fix touching about a third of the commits, and the agent on every other one. */
function build(count: number, tweak: (o: Outcome, i: number) => void = () => {}): { measured: Measured; arms: Arms } {
  const arms = new Map<string, boolean>()
  const outcomes = Array.from({ length: count }, (_, i): Outcome => {
    const added = 20 + (i % 5) * 30
    const survival = (i % 10) / 9
    const died = Math.round(added * (1 - survival))
    const fixed = i % 3 === 0
    const outcome: Outcome = {
      sha: `c${i}`,
      subject: 's',
      landedAt: 1_700_000_000 + (i % 40) * (WEEK / 10),
      added,
      deleted: 1,
      files: 1,
      kind: 'code',
      lineSurvival: survival,
      died,
      fixKilled: fixed ? Math.min(1, died) : 0,
      reverted: false,
      fixedAfter: false,
    }
    outcome.fixedAfter = outcome.fixKilled > 0
    tweak(outcome, i)
    arms.set(outcome.sha, i % 2 === 0)
    return outcome
  })
  return { measured: { outcomes, censored: 5, noCountedFiles: 1, unreadableFiles: 0 }, arms }
}

test('a varied, consistent history is usable, and says how much of survival is defects', () => {
  const { measured, arms } = build(300)
  const report = analyze(measured, arms, 14, 320)
  expect(report.verdict).toBe('usable')
  expect(report.checks.every((check) => check.pass)).toBe(true)
  const deaths = measured.outcomes.reduce((sum, o) => sum + o.died, 0)
  const fixed = measured.outcomes.reduce((sum, o) => sum + Math.min(o.fixKilled, o.died), 0)
  expect(report.fixShareOfDeaths).toBeCloseTo(fixed / deaths, 12)
  expect(report.coverage.commits).toBe(320)
  expect(report.arms.agent.commits + report.arms.other.commits).toBe(300)
})

test('too few commits is not the same verdict as a bad signal', () => {
  const { measured, arms } = build(SIGNAL_CRITERIA.minMeasurable - 1)
  expect(analyze(measured, arms, 14, 200).verdict).toBe('too few commits')
})

test('a metric that never varies fails, and one that is saturated fails', () => {
  const flat = build(300, (o) => {
    o.lineSurvival = 1
    o.died = 0
    o.fixKilled = 0
    o.fixedAfter = false
  })
  const report = analyze(flat.measured, flat.arms, 14, 300)
  expect(report.verdict).toBe('not usable')
  expect(report.checks.filter((c) => !c.pass).map((c) => c.name)).toEqual(expect.arrayContaining(['survival varies', 'survival not saturated']))
})

test('fix-removed lines exceeding the lines that died means the two measurements disagree', () => {
  const broken = build(300, (o, i) => {
    if (i % 3 === 0) {
      o.fixKilled = o.died + 50
      o.fixedAfter = true
    }
  })
  const report = analyze(broken.measured, broken.arms, 14, 300)
  expect(report.checks.find((c) => c.name === 'measurements agree')?.pass).toBe(false)
  expect(report.verdict).toBe('not usable')
})

test('the report plans a trial and is honest that the comparison is observational', () => {
  const { measured, arms } = build(300)
  const text = renderReport(analyze(measured, arms, 14, 300), 'x')
  expect(text).toContain('Observational')
  expect(text).toContain('per arm')
  expect(text).toContain('no events in this history') // build() never reverts anything
  expect(text).toContain('cluster within sessions')
})

test('with no agent commits there is nothing to compare, and no trial to size against', () => {
  const { measured } = build(300)
  const report = analyze(measured, new Map(), 14, 300)
  expect(report.arms.agent.commits).toBe(0)
  expect(report.agentCommitsPerWeek).toBe(0)
  expect(report.plans.every((plan) => plan.weeks === undefined)).toBe(true)
})
