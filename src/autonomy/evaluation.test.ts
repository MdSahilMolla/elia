import { describe, expect, test } from 'bun:test'
import { evaluateHeldOut } from './evaluation.ts'

describe('held-out evaluation', () => {
  test('scores only held-out rows and compares a baseline', () => {
    const result = evaluateHeldOut([
      { id: 'dev', probability: 0, outcome: 1, split: 'development' },
      { id: 'h1', probability: 0.9, baselineProbability: 0.5, outcome: 1, split: 'held-out' },
      { id: 'h2', probability: 0.1, baselineProbability: 0.5, outcome: 0, split: 'held-out' },
    ])
    expect(result.count).toBe(2)
    expect(result.brier).toBeCloseTo(0.01)
    expect(result.baselineBrier).toBe(0.25)
    expect(result.calibration).toHaveLength(2)
  })

  test('refuses probabilities outside the closed interval', () => {
    expect(() => evaluateHeldOut([{ id: 'bad', probability: 1.1, outcome: 1, split: 'held-out' }])).toThrow('between 0 and 1')
  })
})
