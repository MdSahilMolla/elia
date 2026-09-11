import { describe, expect, it } from 'bun:test'
import {
  clampConfidence,
  scaleConfidence,
  makeEvidence,
  combineEvidence,
  formatEvidence,
  KIND_CEILING,
  type Evidence,
} from './evidence.ts'

describe('clampConfidence', () => {
  it('clamps out-of-range values', () => {
    expect(clampConfidence(-1)).toBe(0)
    expect(clampConfidence(1.5)).toBe(1)
    expect(clampConfidence(0.5)).toBe(0.5)
  })

  it('handles non-finite and missing input', () => {
    expect(clampConfidence(Number.NaN)).toBe(0)
    expect(clampConfidence(Number.POSITIVE_INFINITY)).toBe(0)
  })
})

describe('scaleConfidence', () => {
  it('maps a 0-100 score into 0-1', () => {
    expect(scaleConfidence(0)).toBe(0)
    expect(scaleConfidence(100)).toBe(1)
    expect(scaleConfidence(50)).toBeCloseTo(0.5, 5)
  })
})

describe('makeEvidence', () => {
  it('clamps raw confidence to the 0-1 range', () => {
    expect(makeEvidence({ kind: 'git_commit', description: 'x', confidence: 3 }).confidence).toBe(0.9)
    expect(makeEvidence({ kind: 'git_commit', description: 'x', confidence: -1 }).confidence).toBe(0)
  })

  it('never exceeds the ceiling for its kind', () => {
    const staticScan = makeEvidence({ kind: 'static_scan', description: 'regex match', confidence: 1 })
    expect(staticScan.confidence).toBeLessThanOrEqual(KIND_CEILING.static_scan)
    expect(staticScan.confidence).toBe(KIND_CEILING.static_scan)

    const testResult = makeEvidence({ kind: 'test_result', description: 'ran', confidence: 1 })
    expect(testResult.confidence).toBe(KIND_CEILING.test_result)
  })

  it('defaults confidence to the kind ceiling when omitted', () => {
    const e = makeEvidence({ kind: 'source_location', description: 'line 42' })
    expect(e.confidence).toBe(KIND_CEILING.source_location)
  })

  it('carries location, source, timestamp and reproducibility', () => {
    const e = makeEvidence({
      kind: 'architectural_rule',
      description: 'UI must not import persistence',
      location: 'src/ui.ts:10',
      source: 'arch.json',
    })
    expect(e.location).toBe('src/ui.ts:10')
    expect(e.source).toBe('arch.json')
    expect(e.capturedAt).toBeDefined()
    expect(e.reproducible).toBe(true)
  })

  it('marks static scans as not reproducible by default', () => {
    expect(makeEvidence({ kind: 'static_scan', description: 'x' }).reproducible).toBe(false)
  })

  it('rounds confidence to two decimals', () => {
    const e = makeEvidence({ kind: 'runtime_output', description: 'x', confidence: 0.87654321 })
    expect(e.confidence).toBe(0.88)
  })
})

describe('combineEvidence', () => {
  it('returns null result for empty input', () => {
    expect(combineEvidence([])).toEqual({ confidence: 0, count: 0 })
  })

  it('treats a single piece as its own confidence', () => {
    const single = makeEvidence({ kind: 'git_commit', description: 'abc123', confidence: 0.9 })
    const combined = combineEvidence([single])
    expect(combined.count).toBe(1)
    expect(combined.confidence).toBe(0.9)
  })

  it('corroboration never exceeds the strongest piece', () => {
    const weak = makeEvidence({ kind: 'static_scan', description: 'a', confidence: 0.4 })
    const strong = makeEvidence({ kind: 'test_result', description: 'b', confidence: 0.95 })
    const combined = combineEvidence([weak, strong])
    expect(combined.confidence).toBeGreaterThanOrEqual(0.95)
    expect(combined.confidence).toBeLessThanOrEqual(1)
    expect(combined.confidence).toBeGreaterThan(0.95)
  })

  it('is bounded by 1.0 with many strong pieces', () => {
    const strong = Array.from({ length: 5 }, () => makeEvidence({ kind: 'test_result', description: 'x', confidence: 0.95 }))
    const combined = combineEvidence(strong)
    expect(combined.confidence).toBeGreaterThan(0.95)
    expect(combined.confidence).toBeLessThanOrEqual(1)
    expect(combined.confidence).toBe(0.97)
  })
})

describe('formatEvidence', () => {
  const e: Evidence = {
    kind: 'git_commit',
    description: 'introduced by abc123',
    confidence: 0.9,
    location: 'src/a.ts:1',
    source: 'abc123',
  }
  it('renders kind, description, location, source and confidence', () => {
    const line = formatEvidence(e)
    expect(line).toContain('[git_commit]')
    expect(line).toContain('introduced by abc123')
    expect(line).toContain('@src/a.ts:1')
    expect(line).toContain('(abc123)')
    expect(line).toContain('conf=90%')
  })
})