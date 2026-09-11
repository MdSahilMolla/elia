import { describe, expect, it } from 'bun:test'
import { analyzeSecurity, analyzePerformance, analyzeTesting, analyzeDocumentation, analyzeMaintainability, reviewCode, formatReport } from './multiModalReview.ts'

const CLEAN = `export function hello(name: string): string {
  return "Hello " + sanitize(name)
}

export class Greeter {
  greet() {
    try {
      return hello("world")
    } catch (e) {
      return ""
    }
  }
}
`

const DIRTY = `export function run(query: string) {
  const password = "hunter2"
  document.getElementById("out").innerHTML = query
  const apiKey = "sk-123"
  const copy = JSON.parse(JSON.stringify(query))
  const a: any = 1
  if (q) { if (w) { if (e) { if (r) { if (t) { if (y) { if (u) { if (i) { if (o) { const deep = true } } } } } } } } }
}
`

describe('analyzeSecurity', () => {
  it('flags hardcoded secrets and XSS vectors', () => {
    const dim = analyzeSecurity(DIRTY)
    expect(dim.findings.some((f) => f.includes('Hardcoded password'))).toBe(true)
    expect(dim.findings.some((f) => f.includes('Hardcoded API key'))).toBe(true)
    expect(dim.findings.some((f) => f.includes('innerHTML'))).toBe(true)
    expect(dim.score).toBeLessThan(10)
  })

  it('passes clean code', () => {
    const dim = analyzeSecurity(CLEAN)
    expect(dim.findings).toEqual([])
    expect(dim.score).toBe(10)
  })
})

describe('analyzePerformance', () => {
  it('flags JSON round-trip cloning', () => {
    const dim = analyzePerformance('const x = JSON.parse(JSON.stringify(obj))')
    expect(dim.findings.some((f) => f.includes('Deep clone'))).toBe(true)
  })
})

describe('analyzeTesting', () => {
  it('flags missing tests in large files', () => {
    const big = 'export const a = 1\n'.repeat(30)
    const dim = analyzeTesting(big)
    expect(dim.findings.some((f) => f.includes('No test patterns'))).toBe(true)
  })

  it('recognizes test presence', () => {
    const dim = analyzeTesting('describe("x", () => { it("y", () => { expect(1).toBe(1) }) })')
    expect(dim.score).toBe(10)
  })
})

describe('analyzeDocumentation', () => {
  it('flags many exports with few JSDoc comments', () => {
    const code = 'export const a = 1\nexport const b = 2\nexport const c = 3\nexport const d = 4\n'
    const dim = analyzeDocumentation(code)
    expect(dim.findings.some((f) => f.includes('exports but only'))).toBe(true)
  })

  it('flags TODO markers', () => {
    const dim = analyzeDocumentation('// TODO: fix this later\n// FIXME: broken\n')
    expect(dim.findings.some((f) => f.includes('TODO/FIXME'))).toBe(true)
  })
})

describe('analyzeMaintainability', () => {
  it('flags magic numbers and any types', () => {
    const dim = analyzeMaintainability('const a = 500\nconst b = 1200\nconst c = 3400\nconst d = 7800\nexport const fn = (x: any) => x\n')
    expect(dim.findings.some((f) => f.includes('magic numbers'))).toBe(true)
    expect(dim.findings.some((f) => f.includes('any'))).toBe(true)
  })
})

describe('reviewCode', () => {
  it('computes deterministic overall score and risk level', () => {
    const dirty = reviewCode(DIRTY)
    expect(dirty.dimensions.length).toBe(6)
    expect(dirty.overallScore).toBeLessThan(100)
    expect(['low', 'medium', 'high', 'critical']).toContain(dirty.riskLevel)
    expect(dirty.summary).toContain('Risk:')
  })

  it('supports dimension filtering', () => {
    const report = reviewCode(DIRTY, { dimensions: ['security', 'performance'] })
    expect(report.dimensions.map((d) => d.name)).toEqual(['Security', 'Performance'])
  })

  it('scores clean code at maximum', () => {
    const report = reviewCode(CLEAN)
    expect(report.overallScore).toBeGreaterThanOrEqual(90)
    expect(report.riskLevel).toBe('low')
  })

  it('is deterministic', () => {
    expect(reviewCode(DIRTY)).toEqual(reviewCode(DIRTY))
  })
})

describe('formatReport', () => {
  it('renders dimensions and score', () => {
    const report = reviewCode(DIRTY)
    const text = formatReport(report)
    expect(text).toContain('Overall score')
    expect(text).toContain('Security')
    expect(text).toContain('No issues found')
  })
})