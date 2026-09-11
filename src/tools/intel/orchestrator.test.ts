import { describe, expect, it } from 'bun:test'
import { planAnalysis, prioritizeFindings, formatPlan, identifyChangeNature, type AnalysisFinding } from './orchestrator.ts'
import type { ChangeModel } from './change.ts'

function makeChange(partial: Partial<ChangeModel>): ChangeModel {
  return {
    files: [],
    summary: { totalFiles: 0, linesAdded: 0, linesRemoved: 0, testsChanged: [], configOrSchemaChanged: [], securitySurfacesChanged: [], apiSurfacesChanged: [], dependencyManifestsChanged: [] },
    generatedAtMs: 0,
    ...partial,
  }
}

describe('identifyChangeNature', () => {
  it('flags security surfaces and security imports', () => {
    const change = makeChange({
      files: [
        { path: 'src/security/auth.ts', kind: 'modified', additions: 2, deletions: 0, symbols: [{ name: 'login', kind: 'function', change: 'added' }], importsChanged: ['jose'], exportsChanged: [], isTest: false, isConfigOrSchema: false, isSecuritySurface: true, isApiSurface: false, isDependencyManifest: false },
      ],
      summary: { totalFiles: 1, linesAdded: 2, linesRemoved: 0, testsChanged: [], configOrSchemaChanged: [], securitySurfacesChanged: ['src/security/auth.ts'], apiSurfacesChanged: [], dependencyManifestsChanged: [] },
    })
    expect(identifyChangeNature(change)).toContain('security')
  })

  it('flags schema and dependency changes', () => {
    const change = makeChange({
      files: [
        { path: 'prisma/schema.prisma', kind: 'modified', additions: 3, deletions: 0, symbols: [], importsChanged: [], exportsChanged: [], isTest: false, isConfigOrSchema: true, isSecuritySurface: false, isApiSurface: false, isDependencyManifest: false },
        { path: 'package.json', kind: 'modified', additions: 1, deletions: 0, symbols: [], importsChanged: [], exportsChanged: [], isTest: false, isConfigOrSchema: true, isSecuritySurface: false, isApiSurface: false, isDependencyManifest: true },
      ],
      summary: { totalFiles: 2, linesAdded: 4, linesRemoved: 0, testsChanged: [], configOrSchemaChanged: ['prisma/schema.prisma', 'package.json'], securitySurfacesChanged: [], apiSurfacesChanged: [], dependencyManifestsChanged: ['package.json'] },
    })
    expect(identifyChangeNature(change)).toEqual(['dependencies', 'schema'])
  })

  it('flags api surfaces and broad structural change', () => {
    const change = makeChange({
      files: [
        { path: 'src/api/orders.ts', kind: 'modified', additions: 1, deletions: 0, symbols: [{ name: 'listOrders', kind: 'function', change: 'signature' }], importsChanged: ['express'], exportsChanged: [], isTest: false, isConfigOrSchema: false, isSecuritySurface: false, isApiSurface: true, isDependencyManifest: false },
        { path: 'src/app.ts', kind: 'modified', additions: 1, deletions: 0, symbols: [], importsChanged: ['./db'], exportsChanged: [], isTest: false, isConfigOrSchema: false, isSecuritySurface: false, isApiSurface: false, isDependencyManifest: false },
        { path: 'src/cli.ts', kind: 'modified', additions: 1, deletions: 0, symbols: [], importsChanged: [], exportsChanged: [], isTest: false, isConfigOrSchema: false, isSecuritySurface: false, isApiSurface: false, isDependencyManifest: false },
        { path: 'src/shell.ts', kind: 'modified', additions: 1, deletions: 0, symbols: [], importsChanged: [], exportsChanged: [], isTest: false, isConfigOrSchema: false, isSecuritySurface: false, isApiSurface: false, isDependencyManifest: false },
        { path: 'src/util.ts', kind: 'modified', additions: 1, deletions: 0, symbols: [], importsChanged: [], exportsChanged: [], isTest: false, isConfigOrSchema: false, isSecuritySurface: false, isApiSurface: false, isDependencyManifest: false },
        { path: 'src/log.ts', kind: 'modified', additions: 1, deletions: 0, symbols: [], importsChanged: [], exportsChanged: [], isTest: false, isConfigOrSchema: false, isSecuritySurface: false, isApiSurface: false, isDependencyManifest: false },
      ],
      summary: { totalFiles: 6, linesAdded: 6, linesRemoved: 0, testsChanged: [], configOrSchemaChanged: [], securitySurfacesChanged: [], apiSurfacesChanged: ['src/api/orders.ts'], dependencyManifestsChanged: [] },
    })
    const nature = identifyChangeNature(change)
    expect(nature).toContain('api')
    expect(nature).toContain('architecture')
  })

  it('defaults to general for a trivial change', () => {
    const change = makeChange({
      files: [{ path: 'src/hello.ts', kind: 'modified', additions: 1, deletions: 1, symbols: [], importsChanged: [], exportsChanged: [], isTest: false, isConfigOrSchema: false, isSecuritySurface: false, isApiSurface: false, isDependencyManifest: false }],
    })
    expect(identifyChangeNature(change)).toEqual(['general'])
  })
})

describe('planAnalysis', () => {
  it('plans the minimum set for pre_ship', () => {
    const plan = planAnalysis('pre_ship')
    expect(plan.steps.map((s) => s.tool)).toEqual(['predictive_impact', 'adversarial_verify', 'spec_verify', 'multi_modal_review'])
    expect(plan.steps[0]!.priority).toBe('required')
    expect(plan.steps[1]!.priority).toBe('required')
  })

  it('never runs everything', () => {
    const plan = planAnalysis('pre_ship')
    expect(plan.steps.length).toBeLessThan(10)
    expect(plan.steps.some((s) => s.tool === 'causal_debug')).toBe(false)
    expect(plan.steps.some((s) => s.tool === 'temporal_analysis')).toBe(false)
  })

  it('production failure requires causal_debug plus memory', () => {
    const plan = planAnalysis('production_failure', { failureTarget: { file: 'src/pipeline.ts', line: 12 } })
    const causal = plan.steps.find((s) => s.tool === 'causal_debug')!
    expect(causal).toBeDefined()
    expect(causal.priority).toBe('required')
    expect(causal.inputs).toEqual({ file: 'src/pipeline.ts', line: 12 })
    expect(plan.steps.some((s) => s.tool === 'codebase_memory')).toBe(true)
  })

  it('adds nature-driven steps for a security change', () => {
    const change = makeChange({
      files: [
        { path: 'src/login.ts', kind: 'modified', additions: 1, deletions: 0, symbols: [], importsChanged: [], exportsChanged: [], isTest: false, isConfigOrSchema: false, isSecuritySurface: true, isApiSurface: false, isDependencyManifest: false },
      ],
      summary: { totalFiles: 1, linesAdded: 1, linesRemoved: 0, testsChanged: [], configOrSchemaChanged: [], securitySurfacesChanged: ['src/login.ts'], apiSurfacesChanged: [], dependencyManifestsChanged: [] },
    })
    const plan = planAnalysis('commit', { change })
    expect(plan.nature).toContain('security')
    expect(plan.steps.some((s) => s.tool === 'adversarial_verify' && s.priority === 'required')).toBe(true)
    expect(plan.nature).not.toContain('general')
  })

  it('adds dependency_audit when dependency manifests change', () => {
    const change = makeChange({
      files: [
        { path: 'package.json', kind: 'modified', additions: 1, deletions: 0, symbols: [], importsChanged: [], exportsChanged: [], isTest: false, isConfigOrSchema: true, isSecuritySurface: false, isApiSurface: false, isDependencyManifest: true },
      ],
      summary: { totalFiles: 1, linesAdded: 1, linesRemoved: 0, testsChanged: [], configOrSchemaChanged: ['package.json'], securitySurfacesChanged: [], apiSurfacesChanged: [], dependencyManifestsChanged: ['package.json'] },
    })
    const plan = planAnalysis('working_tree', { change })
    expect(plan.steps.some((s) => s.tool === 'dependency_audit' && s.priority === 'required')).toBe(true)
  })

  it('adds arch_drift for architectural change', () => {
    const change = makeChange({
      files: [
        { path: 'src/a.ts', kind: 'modified', additions: 1, deletions: 0, symbols: [{ name: 'x', kind: 'function', change: 'signature' }], importsChanged: ['./b'], exportsChanged: [], isTest: false, isConfigOrSchema: false, isSecuritySurface: false, isApiSurface: false, isDependencyManifest: false },
      ],
      summary: { totalFiles: 1, linesAdded: 1, linesRemoved: 0, testsChanged: [], configOrSchemaChanged: [], securitySurfacesChanged: [], apiSurfacesChanged: [], dependencyManifestsChanged: [] },
    })
    const plan = planAnalysis('commit', { change })
    expect(plan.steps.some((s) => s.tool === 'arch_drift' && s.priority === 'required')).toBe(true)
  })

  it('names deliberate skips', () => {
    const plan = planAnalysis('architecture_review')
    expect(plan.unnecessary).toContain('adversarial_verify')
    expect(plan.steps.some((s) => s.tool === 'adversarial_verify')).toBe(false)
  })

  it('adds memory when historical lessons exist', () => {
    const plan = planAnalysis('commit', { memoryHits: ['Previously fixed race in ledger', 'Token leak'] })
    expect(plan.steps.some((s) => s.tool === 'codebase_memory' && s.priority === 'recommended')).toBe(true)
  })

  it('is deterministic', () => {
    const a = planAnalysis('pull_request')
    const b = planAnalysis('pull_request')
    expect(a.steps).toEqual(b.steps)
    expect(formatPlan(planAnalysis('pre_ship'))).toBeTruthy()
  })
})

describe('prioritizeFindings', () => {
  const withEvidence = (importance: AnalysisFinding['importance'], tool: string): AnalysisFinding => ({
    tool,
    finding: `finding from ${tool}`,
    importance,
    evidence: [{ kind: 'test_result', description: 'reproduced', confidence: 0.9 }],
  })

  it('orders blocking before important before advisory', () => {
    const result = prioritizeFindings([
      withEvidence('advisory', 'multi_modal_review'),
      withEvidence('blocking', 'adversarial_verify'),
      withEvidence('important', 'spec_verify'),
    ])
    expect(result.actions.map((a) => a.sourceTool)).toEqual(['adversarial_verify', 'spec_verify', 'multi_modal_review'])
    expect(result.actions[0]!.priority).toBe('immediate')
    expect(result.actions[1]!.priority).toBe('next')
    expect(result.actions[2]!.priority).toBe('review')
    expect(result.blocked).toBe(true)
    expect(result.recommendation).toContain('BLOCKED')
  })

  it('passes when nothing blocks', () => {
    const result = prioritizeFindings([withEvidence('advisory', 'multi_modal_review')])
    expect(result.blocked).toBe(false)
    expect(result.recommendation).not.toContain('BLOCKED')
  })

  it('handles empty findings', () => {
    const result = prioritizeFindings([])
    expect(result.actions).toEqual([])
    expect(result.blocked).toBe(false)
    expect(result.recommendation).toContain('No blocking findings')
  })
})