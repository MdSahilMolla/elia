import { expect, test, describe } from 'bun:test'
import { isUnmeasured } from './scoreboard.ts'
import type { LadderResult } from './types.ts'

function result(overrides: Partial<LadderResult> = {}): LadderResult {
  return {
    defectId: 'd',
    regime: 'mechanical',
    expectedCatch: 'structural',
    caughtBy: [],
    caught: false,
    falsePositiveOnClean: false,
    skipped: [],
    notes: [],
    ...overrides,
  }
}

describe('isUnmeasured', () => {
  test('a defect whose expected rung could not run is a hole, not an escape', () => {
    // The case that made the guard unusable from an evolution sandbox: the
    // structural checker is unavailable there, so both structural defects were
    // reported as "got through the ladder" and every candidate was rejected for
    // a regression that never happened.
    expect(isUnmeasured(result({ skipped: ['structural'] }))).toBe(true)
  })

  test('a defect the expected rung ran on and missed is a real escape', () => {
    expect(isUnmeasured(result({ skipped: [] }))).toBe(false)
  })

  test('a caught defect is measured even if some other rung was skipped', () => {
    expect(isUnmeasured(result({ caught: true, caughtBy: ['typecheck'], skipped: ['structural'] }))).toBe(false)
  })

  test('an unrelated rung being skipped does not excuse a miss', () => {
    // Only the rung that was *supposed* to catch this defect matters. A skipped
    // rung elsewhere must not launder a genuine escape out of the denominator —
    // that would be the scoreboard flattering itself.
    expect(isUnmeasured(result({ expectedCatch: 'test', skipped: ['structural'] }))).toBe(false)
  })
})
