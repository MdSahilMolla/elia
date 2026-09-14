import { expect, test, describe } from 'bun:test'
import { applyCriticVerdicts, criticDefects, scoreCriticVerdicts } from './critic.ts'
import { CORPUS } from './corpus.ts'
import { checkGapNotRegressed } from './guard.ts'
import type { CriticVerdict, GapVector, LadderResult } from './types.ts'

function ladderResult(overrides: Partial<LadderResult> & { defectId: string }): LadderResult {
  return {
    regime: 'judgment',
    expectedCatch: 'critic',
    caughtBy: [],
    caught: false,
    falsePositiveOnClean: false,
    skipped: [],
    notes: [],
    ...overrides,
  }
}

function verdict(overrides: Partial<CriticVerdict> & { defectId: string }): CriticVerdict {
  return { caughtDefective: false, flaggedClean: false, note: '', ...overrides }
}

describe('criticDefects', () => {
  test('selects exactly the defects no cheap rung can catch', () => {
    const selected = criticDefects()
    expect(selected.length).toBeGreaterThan(0)
    for (const defect of selected) expect(defect.expectedCatch).toBe('critic')
    // The corpus's judgment controls are the critic rung's responsibility.
    const judgment = CORPUS.filter((d) => d.regime === 'judgment')
    expect(selected.map((d) => d.id).sort()).toEqual(judgment.map((d) => d.id).sort())
  })
})

describe('scoreCriticVerdicts', () => {
  test('false-accept rate counts the defects the critic waved through', () => {
    const result = scoreCriticVerdicts([
      verdict({ defectId: 'a', caughtDefective: true }),
      verdict({ defectId: 'b', caughtDefective: false }),
      verdict({ defectId: 'c', caughtDefective: false }),
      verdict({ defectId: 'd', caughtDefective: true }),
    ])
    expect(result.falseAcceptRate).toBe(0.5)
    expect(result.unavailable).toBe(false)
  })

  test('flagging the clean control is a false positive', () => {
    const result = scoreCriticVerdicts([
      verdict({ defectId: 'a', caughtDefective: true, flaggedClean: true }),
      verdict({ defectId: 'b', caughtDefective: true }),
    ])
    expect(result.falsePositiveRate).toBe(0.5)
  })

  test('an errored verdict leaves the denominator rather than scoring as a miss', () => {
    // The point: a provider outage must not read as the critic going blind, which
    // the guard would treat as a catastrophic regression and use to reject a
    // candidate that had nothing to do with it.
    const result = scoreCriticVerdicts([
      verdict({ defectId: 'a', caughtDefective: true }),
      verdict({ defectId: 'b', errored: true }),
    ])
    expect(result.falseAcceptRate).toBe(0)
    expect(result.unavailable).toBe(false)
  })

  test('every verdict erroring reports unavailable instead of a perfect score', () => {
    const result = scoreCriticVerdicts([verdict({ defectId: 'a', errored: true })], 1)
    expect(result.unavailable).toBe(true)
    expect(result.falseAcceptRate).toBe(0)
  })
})

describe('applyCriticVerdicts', () => {
  test('a defect the critic named stops being uncaught', () => {
    const results = [ladderResult({ defectId: 'judgment-missing-authz' })]
    applyCriticVerdicts(results, [verdict({ defectId: 'judgment-missing-authz', caughtDefective: true })])
    expect(results[0]!.caught).toBe(true)
    expect(results[0]!.caughtBy).toContain('critic')
  })

  test('a defect the critic missed stays uncaught', () => {
    const results = [ladderResult({ defectId: 'judgment-intent-drift' })]
    applyCriticVerdicts(results, [verdict({ defectId: 'judgment-intent-drift', caughtDefective: false })])
    expect(results[0]!.caught).toBe(false)
    expect(results[0]!.caughtBy).not.toContain('critic')
  })

  test('an errored verdict changes nothing', () => {
    const results = [ladderResult({ defectId: 'x', caught: true, caughtBy: ['typecheck'] })]
    applyCriticVerdicts(results, [verdict({ defectId: 'x', errored: true, flaggedClean: true })])
    expect(results[0]!.falsePositiveOnClean).toBe(false)
    expect(results[0]!.caughtBy).toEqual(['typecheck'])
  })

  test('flagging the clean control marks a false positive', () => {
    const results = [ladderResult({ defectId: 'x' })]
    applyCriticVerdicts(results, [verdict({ defectId: 'x', caughtDefective: true, flaggedClean: true })])
    expect(results[0]!.falsePositiveOnClean).toBe(true)
  })

  test('is idempotent — re-folding does not double-count the rung', () => {
    const results = [ladderResult({ defectId: 'x' })]
    const verdicts = [verdict({ defectId: 'x', caughtDefective: true })]
    applyCriticVerdicts(results, verdicts)
    applyCriticVerdicts(results, verdicts)
    expect(results[0]!.caughtBy.filter((r) => r === 'critic')).toHaveLength(1)
  })
})

describe('the Verifier-Leads invariant, end to end', () => {
  const base = (overrides: Partial<GapVector> = {}): GapVector => ({
    at: new Date().toISOString(),
    ref: 'abc1234',
    defectsTotal: 11,
    defectsScored: 9,
    mechanicalCatchRate: 1,
    falsePositiveRate: 0,
    byRegime: { mechanical: { total: 7, caught: 7 }, empirical: { total: 2, caught: 2 }, judgment: { total: 2, caught: 1 } },
    byRung: {},
    calibrationContradictionRate: 0.08,
    escapees: [],
    ...overrides,
  })

  test('a candidate whose critic got blunter is rejected', () => {
    // This is the regression the whole gate exists to stop, and the case that was
    // undetectable while nothing computed criticFalseAcceptRate: every
    // deterministic number is identical, and only the critic moved.
    const before = base({ criticFalseAcceptRate: 0 })
    const after = base({ criticFalseAcceptRate: 0.5 })
    const guard = checkGapNotRegressed(before, after)
    expect(guard.ok).toBe(false)
    expect(guard.regressions.join(' ')).toContain('critic false-accept')
  })

  test('a deterministic-only pair cannot express that regression at all', () => {
    // Documents why the rung had to exist: without it both vectors carry
    // `criticFalseAcceptRate: undefined`, the guard skips its clause, and a
    // candidate that blinded the critic passes.
    const guard = checkGapNotRegressed(base(), base())
    expect(guard.ok).toBe(true)
    expect(base().criticFalseAcceptRate).toBeUndefined()
  })

  test('a candidate whose critic got sharper passes', () => {
    const guard = checkGapNotRegressed(base({ criticFalseAcceptRate: 0.5 }), base({ criticFalseAcceptRate: 0 }))
    expect(guard.ok).toBe(true)
  })
})
