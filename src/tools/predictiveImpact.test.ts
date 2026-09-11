import { describe, expect, it } from 'bun:test'
import { analyzePredictiveImpact, assessFileRisk, persistCodebaseIndex, loadCodebaseIndex } from './predictiveImpact.ts'
import type { ChangeModel, ChangedFile } from './intel/change.ts'
import { indexCodebase } from './intel/codebase.ts'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

function file(partial: Partial<ChangedFile>): ChangedFile {
  return {
    path: 'src/foo.ts',
    kind: 'modified',
    additions: 1,
    deletions: 0,
    symbols: [],
    importsChanged: [],
    exportsChanged: [],
    isTest: false,
    isConfigOrSchema: false,
    isSecuritySurface: false,
    isApiSurface: false,
    isDependencyManifest: false,
    ...partial,
  }
}

function change(files: ChangedFile[]): ChangeModel {
  return {
    files,
    summary: {
      totalFiles: files.length,
      linesAdded: files.reduce((a, f) => a + f.additions, 0),
      linesRemoved: files.reduce((a, f) => a + f.deletions, 0),
      testsChanged: [],
      configOrSchemaChanged: [],
      securitySurfacesChanged: [],
      apiSurfacesChanged: [],
      dependencyManifestsChanged: [],
    },
    generatedAtMs: Date.now(),
  }
}

describe('assessFileRisk', () => {
  it('scores deletion as high risk that grows with importers', () => {
    const low = assessFileRisk(file({ path: 'src/a.ts', kind: 'deleted' }), { isTest: false, isSecuritySurface: false, isConfigOrSchema: false, isDependencyManifest: false, lineCount: 20, downstream: [], tests: [] })
    const withImporters = assessFileRisk(file({ path: 'src/a.ts', kind: 'deleted' }), { isTest: false, isSecuritySurface: false, isConfigOrSchema: false, isDependencyManifest: false, lineCount: 20, downstream: ['src/b.ts', 'src/c.ts'], tests: [] })
    expect(low.risk.score).toBeGreaterThanOrEqual(50)
    expect(withImporters.risk.score).toBeGreaterThan(low.risk.score)
    expect(withImporters.risk.level).toBeOneOf(['high', 'critical'])
  })

  it('scores security surface as critical', () => {
    const r = assessFileRisk(file({ path: 'src/auth.ts', kind: 'modified', isSecuritySurface: true }), { isTest: false, isSecuritySurface: true, isConfigOrSchema: false, isDependencyManifest: false, lineCount: 50, downstream: [], tests: [] })
    expect(r.risk.score).toBeGreaterThanOrEqual(75)
    expect(r.risk.level).toBe('critical')
    expect(r.risk.confidence).toBeGreaterThan(0.8)
  })

  it('scores test-only change as low risk', () => {
    const r = assessFileRisk(file({ path: 'src/foo.test.ts', isTest: true }), { isTest: true, isSecuritySurface: false, isConfigOrSchema: false, isDependencyManifest: false, lineCount: 10, downstream: [], tests: [] })
    expect(r.risk.level).toBe('low')
  })

  it('tags schema/migration paths as high risk even when not flagged', () => {
    const r = assessFileRisk(file({ path: 'prisma/migrations/001_init/migration.sql', kind: 'added' }), { isTest: false, isSecuritySurface: false, isConfigOrSchema: false, isDependencyManifest: false, lineCount: 30, downstream: [], tests: [] })
    expect(r.risk.score).toBeGreaterThanOrEqual(75)
    expect(r.risk.level).toBe('critical')
  })

  it('removed signature symbols add impact evidence', () => {
    const r = assessFileRisk(file({ symbols: [{ name: 'doThing', kind: 'function', change: 'removed' }] }), { isTest: false, isSecuritySurface: false, isConfigOrSchema: false, isDependencyManifest: false, lineCount: 40, downstream: [], tests: [] })
    expect(r.evidence.some((e) => e.kind === 'ast_relationship')).toBe(false)
    expect(r.risk.dimensions.some((d) => d.name === 'impact')).toBe(true)
  })
})

describe('analyzePredictiveImpact', () => {
  it('aggregates files and reports downstream/test impact', () => {
    const dir = mkdtempSync(join(tmpdir(), 'impact-test-'))
    const root = join(dir, 'proj')
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'core.ts'), 'export function core() {}\n')
    writeFileSync(join(root, 'src', 'use.ts'), 'import { core } from "./core"\nexport const use = core()\n')
    writeFileSync(join(root, 'src', 'core.test.ts'), 'import { core } from "./core"\ntest("x", () => core())\n')
    const codebase = indexCodebase(root, { maxFiles: 100 })
    const changeModel = change([
      file({ path: 'src/core.ts', kind: 'modified', symbols: [{ name: 'core', kind: 'function', change: 'signature' }] }),
    ])
    const analysis = analyzePredictiveImpact(changeModel, { codebase })
    expect(analysis.changedFiles.length).toBe(1)
    expect(analysis.totalDownstreamFiles).toBe(2)
    expect(analysis.totalTestsAffected).toBe(1)
    expect(analysis.overallRisk).toBeDefined()
    expect(analysis.recommendations.length).toBeGreaterThan(0)
    expect(analysis.recommendations.join(' ')).toContain('Run 1 affected test')
    expect(typeof analysis.summary).toBe('string')
  })

  it('respects maxFiles', () => {
    const files = Array.from({ length: 20 }, (_, i) => file({ path: `src/lib/f${i}.ts` }))
    const analysis = analyzePredictiveImpact(change(files), { maxFiles: 5 })
    expect(analysis.changedFiles.length).toBe(5)
  })

  it('produces deterministic output', () => {
    const changeModel = change([file({ path: 'src/conf.ts', isConfigOrSchema: true })])
    const a = analyzePredictiveImpact(changeModel)
    const b = analyzePredictiveImpact(changeModel)
    expect(a.overallRisk.score).toBe(b.overallRisk.score)
    expect(a.summary).toBe(b.summary)
    expect(a.recommendations).toEqual(b.recommendations)
  })
})

describe('persistCodebaseIndex / loadCodebaseIndex', () => {
  it('round-trips an index through .elia cache', () => {
    const dir = mkdtempSync(join(tmpdir(), 'intel-test-'))
    const root = join(dir, 'proj')
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'app.ts'), 'export const x = 1\n')
    const model = indexCodebase(root, { maxFiles: 10 })
    const saved = persistCodebaseIndex(model, root)
    expect(existsSync(saved)).toBe(true)
    const loaded = loadCodebaseIndex(root)!
    expect(loaded.root).toBe(root)
    expect(loaded.files.some((f) => f.path === 'src/app.ts')).toBe(true)
    expect(readFileSync(saved, 'utf-8')).toContain('app.ts')
  })
})