import { expect, test } from 'bun:test'
import type { CalibrationEntry } from '../autonomy/calibration.ts'
import type { TurnOutcome } from '../autonomy/outcomes.ts'
import type { GapVector } from '../gap/types.ts'
import { estimateFrontier, renderFrontier, verifierRates } from './frontier.ts'

function turn(domains: TurnOutcome['domains'], verify: TurnOutcome['verify'], repairAttempts = 0): TurnOutcome {
  return { at: 0, prompt: 'x', filesChanged: 1, domains, editRetries: 0, toolErrors: 0, verify, repairAttempts, aborted: false }
}

function gap(overrides: Partial<GapVector> = {}): GapVector {
  return {
    at: '2026-09-14T00:00:00.000Z',
    ref: 'abc',
    defectsTotal: 20,
    defectsScored: 20,
    mechanicalCatchRate: 0.9,
    falsePositiveRate: 0,
    byRegime: { mechanical: { total: 20, caught: 18 }, empirical: { total: 0, caught: 0 }, judgment: { total: 0, caught: 0 } },
    byRung: {},
    calibrationContradictionRate: 0,
    escapees: [],
    ...overrides,
  }
}

function claim(contradicted: boolean): CalibrationEntry {
  return {
    at: '2026-09-14T00:00:00.000Z',
    runId: 'r',
    reportedState: 'verified',
    confidence: 'high',
    facts: { verificationPassed: true, reviewPassed: true, completedSteps: 1, totalSteps: 1, unresolvedActions: 0, pendingApprovals: 0, blockedByBudget: 0 },
    contradictions: contradicted ? ['x'] : [],
  }
}

test('p counts every repair as another sample', () => {
  const report = estimateFrontier({
    outcomes: [turn(['code'], 'pass', 0), turn(['code'], 'pass', 2), turn(['code'], 'fail', 1)],
    calibration: [],
  })
  const code = report.families.find((family) => family.family === 'code')!
  // Samples: 1 + 3 + 2 = 6, of which 2 passed.
  expect(code.p.trials).toBe(6)
  expect(code.p.successes).toBe(2)
})

test('a family is only placed when the evidence places it', () => {
  const strong = Array.from({ length: 60 }, () => turn(['code'], 'pass'))
  const report = estimateFrontier({ outcomes: strong, gap: gap(), calibration: [] })
  const code = report.families.find((family) => family.family === 'code')!
  expect(code.status).toBe('inside')
  expect(code.precision).toBeGreaterThan(0.9)
  expect(report.mass).toBe(1)

  // No verifier measurement at all: unmeasured, never "inside by default".
  const blind = estimateFrontier({ outcomes: strong, calibration: [] })
  expect(blind.families.find((family) => family.family === 'code')!.status).toBe('unmeasured')
  expect(blind.mass).toBeUndefined()
})

test('a family whose success rate is below the false-accept rate is outside', () => {
  const weak = [...Array.from({ length: 2 }, () => turn(['docs'], 'pass', 30)), ...Array.from({ length: 40 }, () => turn(['docs'], 'fail', 5))]
  const judged = gap({
    criticVerdicts: Array.from({ length: 30 }, (_, index) => ({ defectId: `d${index}`, caughtDefective: index % 2 === 0, flaggedClean: false, note: '' })),
  })
  const report = estimateFrontier({ outcomes: weak, gap: judged, calibration: [] })
  const docs = report.families.find((family) => family.family === 'docs')!
  expect(docs.alpha!.source).toContain('critic')
  expect(docs.status).toBe('outside')
})

test('turns with no verification are counted as outside every frontier', () => {
  const report = estimateFrontier({ outcomes: [turn(['frontend'], 'none'), turn(['frontend'], 'pass')], calibration: [] })
  expect(report.unverifiedShare.successes).toBe(1)
  expect(report.families.find((family) => family.family === 'frontend')!.unverified).toBe(1)
})

test('R1 judges recent checkable turns: prose-only turns and old history do not count', () => {
  const old = Array.from({ length: 80 }, () => turn(['code'], 'none'))
  const recent = Array.from({ length: 60 }, (_, index) => turn(['code'], index < 6 ? 'none' : 'pass'))
  const prose = Array.from({ length: 10 }, () => turn(['docs'], 'none'))
  const report = estimateFrontier({ outcomes: [...old, ...recent, ...prose], calibration: [] })
  // All-time, every unverified turn still counts…
  expect(report.unverifiedShare.successes).toBe(96)
  // …but R1 sees the last 60 checkable turns, and docs-only turns are not among them.
  expect(report.checkableUnverified.trials).toBe(60)
  expect(report.checkableUnverified.successes).toBe(6)
  expect(renderFrontier(report)).toContain('what rule R1 acts on')
  // A turn that touched code and docs is still checkable.
  expect(estimateFrontier({ outcomes: [turn(['docs', 'code'], 'none')], calibration: [] }).checkableUnverified.successes).toBe(1)
})

test('the completion assessor gives an on-distribution α', () => {
  const rates = verifierRates(undefined, [claim(true), claim(false), claim(true)])
  expect(rates.assessor!.onDistribution).toBe(true)
  expect(rates.assessor!.estimate.mean).toBeCloseTo(2 / 3, 9)
  const rendered = renderFrontier(estimateFrontier({ outcomes: [turn(['code'], 'pass')], calibration: [claim(false)] }))
  expect(rendered).toContain('completion assessor')
  expect(rendered).toContain('frontier mass')
})
