import { describe, expect, it } from 'bun:test'
import { assessRisk, riskLevelFor, clampRiskScore, combineRisks, formatRisk, type RiskDimension, type RiskModel } from './risk.ts'

const severity: RiskDimension = { name: 'severity', weight: 1, score: 80, description: 'Critical injection surface' }
const exploitability: RiskDimension = { name: 'exploitability', weight: 1, score: 60, description: 'Needs network access' }

describe('riskLevelFor', () => {
  it('maps 0-100 onto the four risk levels', () => {
    expect(riskLevelFor(0)).toBe('low')
    expect(riskLevelFor(24)).toBe('low')
    expect(riskLevelFor(25)).toBe('medium')
    expect(riskLevelFor(49)).toBe('medium')
    expect(riskLevelFor(50)).toBe('high')
    expect(riskLevelFor(74)).toBe('high')
    expect(riskLevelFor(75)).toBe('critical')
    expect(riskLevelFor(100)).toBe('critical')
  })

  it('clamps extreme input defensively', () => {
    expect(riskLevelFor(Number.NaN)).toBe('low')
    expect(riskLevelFor(-10)).toBe('low')
    expect(riskLevelFor(999)).toBe('critical')
  })
})

describe('clampRiskScore', () => {
  it('rounds and clamps to 0-100', () => {
    expect(clampRiskScore(120)).toBe(100)
    expect(clampRiskScore(-5)).toBe(0)
    expect(clampRiskScore(33.7)).toBe(34)
  })
})

describe('assessRisk', () => {
  it('weights dimensions by their relative weight', () => {
    const risk = assessRisk([
      { name: 'a', weight: 3, score: 100, description: 'always on' },
      { name: 'b', weight: 1, score: 0, description: 'never' },
    ])
    expect(risk.score).toBe(75)
    expect(risk.level).toBe('critical')
  })

  it('handles a single dimension', () => {
    const risk = assessRisk([severity])
    expect(risk.score).toBe(80)
    expect(risk.level).toBe('critical')
    expect(risk.dimensions).toHaveLength(1)
  })

  it('produces an explanation per dimension', () => {
    const risk = assessRisk([severity, exploitability], { confidence: 0.8 })
    expect(risk.explanation).toHaveLength(2)
    expect(risk.explanation[0]).toContain('severity (weight 1, score 80)')
    expect(risk.explanation[0]).toContain('contributes 40/100')
  })

  it('carries confidence and its source', () => {
    const risk = assessRisk([severity], { confidence: 0.9, confidenceSource: 'reproduced test failure' })
    expect(risk.confidence).toBe(0.9)
    expect(risk.confidenceSource).toBe('reproduced test failure')
  })

  it('defaults to neutral confidence when absent', () => {
    expect(assessRisk([severity]).confidence).toBe(0.5)
  })

  it('returns a zero risk model for empty dimensions', () => {
    const risk = assessRisk([])
    expect(risk.score).toBe(0)
    expect(risk.level).toBe('low')
    expect(risk.explanation).toHaveLength(1)
    expect(risk.confidence).toBe(0)
  })

  it('ignores non-numeric weights gracefully', () => {
    const risk = assessRisk([{ name: 'a', weight: Number.NaN, score: 90, description: 'x' }])
    expect(risk.score).toBe(0)
    expect(risk.level).toBe('low')
  })

  it('clamps dimension scores into 0-100 before scoring', () => {
    const risk = assessRisk([{ name: 'a', weight: 1, score: 250, description: 'over the top' }])
    expect(risk.score).toBe(100)
  })

  it('supports an explicit level override', () => {
    const risk = assessRisk([severity], { levelOverride: () => 'high' })
    expect(risk.level).toBe('high')
    expect(risk.score).toBe(80)
  })
})

describe('combineRisks', () => {
  const low: RiskModel = { score: 10, level: 'low', dimensions: [], explanation: ['low'], confidence: 0.9 }
  const high: RiskModel = { score: 90, level: 'critical', dimensions: [severity], explanation: ['high'], confidence: 0.6 }

  it('takes the worst score and weakest confidence', () => {
    const merged = combineRisks([low, high])
    expect(merged.score).toBe(90)
    expect(merged.level).toBe('critical')
    expect(merged.confidence).toBe(0.6)
  })

  it('merges dimensions and explanations', () => {
    const merged = combineRisks([low, high])
    expect(merged.dimensions).toContainEqual(severity)
    expect(merged.explanation).toContain('high')
  })

  it('returns an empty model for empty input', () => {
    const merged = combineRisks([])
    expect(merged.score).toBe(0)
    expect(merged.level).toBe('low')
    expect(merged.explanation).toHaveLength(0)
  })
})

describe('formatRisk', () => {
  it('renders a one-line summary', () => {
    const risk: RiskModel = { score: 63, level: 'high', dimensions: [], explanation: [], confidence: 0.5 }
    expect(formatRisk(risk)).toBe('Risk: 63/100 (HIGH) — confidence 50%')
  })
})