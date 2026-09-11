import { describe, expect, it } from 'bun:test'
import { parseSpecSections, verifySection, verifySpecification, inferSpecType, analyzeCodePatterns, readCodeDirectory } from './specVerify.ts'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SPEC = `# Order API

## Requirements
- Must create an order with items and totals
- Must validate customer identity before checkout

## Constraints
- Total must never exceed credit limit

## Edge Cases
- Payment failure returns an error to the client
`

describe('parseSpecSections', () => {
  it('parses markdown headers into typed sections', () => {
    const sections = parseSpecSections(SPEC)
    expect(sections.length).toBe(3)
    expect(sections[0]!.type).toBe('requirement')
    expect(sections[1]!.type).toBe('constraint')
    expect(sections[2]!.type).toBe('edge-case')
    expect(sections[0]!.description).toContain('customer identity')
  })

  it('returns no sections for missing headers', () => {
    expect(parseSpecSections('just plain text, no headers here')).toEqual([])
  })
})

describe('inferSpecType', () => {
  it('infers by heading keywords', () => {
    expect(inferSpecType('Requirements')).toBe('requirement')
    expect(inferSpecType('Interface Contract')).toBe('interface')
    expect(inferSpecType('Constrained limits max')).toBe('constraint')
    expect(inferSpecType('Edge Cases')).toBe('edge-case')
    expect(inferSpecType('Something Else')).toBe('requirement')
  })
})

describe('verifySection', () => {
  it('verifies when key terms appear in code', () => {
    const section = { id: 's1', title: 'Requirements', type: 'requirement' as const, description: 'order items and totals validation', verified: false, evidence: '', gaps: [] }
    const out = verifySection(section, 'function createOrder(items) { return totals(items) }')
    expect(out.verified).toBe(true)
    expect(out.gaps).toEqual([])
  })

  it('leaves gaps when coverage is low', () => {
    const section = { id: 's2', title: 'Edge Cases', type: 'edge-case' as const, description: 'payment failure gracefully degrades offline cache', verified: false, evidence: '', gaps: [] }
    const out = verifySection(section, 'export const benign = () => 42')
    expect(out.verified).toBe(false)
    expect(out.gaps.length).toBeGreaterThan(0)
  })
})

describe('analyzeCodePatterns', () => {
  it('detects structural patterns', () => {
    const code = 'export function x() { try { import { a } from "./a" } catch (e) {} } // test(, expect('
    const p = analyzeCodePatterns(code)
    expect(p).toContain('exports public API')
    expect(p).toContain('has dependencies')
    expect(p).toContain('handles errors')
    expect(p).toContain('has tests')
  })
})

describe('verifySpecification', () => {
  it('produces coverage and recommendations', () => {
    const code = `
      function createOrder(items) { return items }
      function total(items) { return items.length }
      const creditLimit = 5000
      function checkout(id) { return validate(id) }
    `
    const report = verifySpecification(SPEC, code)
    expect(report.totalRequirements).toBe(3)
    expect(report.coverage).toBeGreaterThanOrEqual(0)
    expect(report.coverage).toBeLessThanOrEqual(100)
    expect(report.recommendations.length).toBeGreaterThan(0)
    expect(report.summary).toContain('Verified')
  })

  it('is deterministic', () => {
    const a = verifySpecification(SPEC, 'export const x = 1')
    const b = verifySpecification(SPEC, 'export const x = 1')
    expect(a).toEqual(b)
  })
})

describe('readCodeDirectory', () => {
  it('walks source files deterministically and skips node_modules', () => {
    const dir = mkdtempSync(join(tmpdir(), 'specverify-'))
    mkdirSync(join(dir, 'src', 'nested'), { recursive: true })
    mkdirSync(join(dir, 'node_modules'))
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1\n')
    writeFileSync(join(dir, 'src', 'nested', 'b.ts'), 'export const b = 2\n')
    writeFileSync(join(dir, 'node_modules', 'dep.ts'), 'export const evil = true\n')
    writeFileSync(join(dir, 'src', 'notes.md'), 'not source\n')
    const text = readCodeDirectory(dir)
    expect(text).toContain('a.ts')
    expect(text).toContain('b.ts')
    expect(text).not.toContain('evil')
    expect(text).not.toContain('notes.md')
  })
})