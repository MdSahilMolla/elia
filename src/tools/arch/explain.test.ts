import { describe, expect, it } from 'bun:test'
import { ruleWiki, explainRule, explainViolation } from './explain.ts'
import type { Violation } from './types.ts'

describe('rule wiki', () => {
  it('documents every violation kind in stable order', () => {
    const kinds = ruleWiki().map((r) => r.kind)
    expect(kinds).toEqual([
      'circular_dependency',
      'import_direction',
      'dependency_inversion',
      'package_boundary_violation',
      'abstraction_leakage',
      'forbidden_import',
      'unresolved_import',
      'god_module',
      'excessive_coupling',
      'orphan_module',
      'deep_dependency_chain',
    ])
    for (const rule of ruleWiki()) {
      expect(rule.title.length).toBeGreaterThan(5)
      expect(rule.summary.length).toBeGreaterThan(10)
      expect(rule.why.length).toBeGreaterThan(10)
      expect(rule.howToFix.length).toBeGreaterThan(10)
    }
  })

  it('explains a rule by kind', () => {
    expect(explainRule('circular_dependency').title).toBe('Break the dependency cycle')
  })
})

describe('violation narrative', () => {
  const v: Violation = {
    type: 'import_direction',
    severity: 'error',
    source: 'src/model/upward.ts',
    target: 'src/web/shared.ts',
    specifier: '../web/shared',
    line: 1,
    description: 'Layer "model" imports from upper layer "web" (../web/shared).',
    suggestion: 'Move the imported code.',
    why: '',
  }

  it('produces a grounded headline and why for an edge violation', () => {
    const n = explainViolation(v)
    expect(n.headline).toContain('Respect layer direction')
    expect(n.why).toContain('Layer "model" imports from upper layer "web"')
    expect(n.impact).toContain('via "../web/shared" from src/model/upward.ts to src/web/shared.ts (line 1)')
  })

  it('handles module-level violations without a target', () => {
    const orphan: Violation = {
      type: 'orphan_module',
      severity: 'info',
      source: 'src/lonely.ts',
      target: '',
      description: 'Module has no imports and no dependents.',
      suggestion: 'Connect it.',
      why: '',
    }
    const n = explainViolation(orphan)
    expect(n.headline).toContain('Connect or remove the orphan')
    expect(n.impact).toContain('on src/lonely.ts')
  })
})