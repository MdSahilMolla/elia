import { describe, expect, it, beforeAll, afterAll } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync } from 'node:fs'
import { openProject, parseProject, normalizePath } from './parser.ts'
import { createFixture, cleanupFixture } from './testFixtures.ts'
import { buildGraph, type DepGraph } from './graph.ts'
import { detectViolations } from './violations.ts'
import {
  impactOf,
  impactOfMany,
  moduleHealth,
  repoHealth,
  hotspots,
  healthSummary,
} from './analysis.ts'
import type { Program } from 'typescript/unstable/sync'
import type { Snapshot } from 'typescript/unstable/sync'

describe('analysis.impact', () => {
  let apiDispose: { api: unknown; snapshot: Snapshot }
  let program: Program
  let graph: DepGraph
  const root = normalizePath(mkdtempSync(join(tmpdir(), 'arch-analysis')))
  const opts = () => ({ projectRoot: root, tsconfigPath: normalizePath(join(root, 'tsconfig.json')), includeTests: true, maxFiles: 200 })

  beforeAll(() => {
    const fixture = createFixture(root)
    const { api, snapshot, program: p } = openProject(opts())
    apiDispose = { api, snapshot }
    program = p
    const { files } = parseProject(program, opts())
    graph = buildGraph(files, opts())
    void fixture
  })

  afterAll(() => {
    apiDispose.snapshot.dispose()
    ;(apiDispose.api as { close: () => void }).close()
    cleanupFixture(root)
  })

  it('computes direct dependents of a leaf module', () => {
    const imp = impactOf(graph, 'src/core/types.ts')
    expect(imp.directDependents).toEqual(['src/app.ts', 'src/core/util.ts', 'src/dyn.ts', 'src/index.ts', 'src/mix.ts'])
    expect(imp.totalImpact).toBeGreaterThanOrEqual(5)
    expect(imp.risk).toBe('medium')
  })

  it('reports the dependents of a hub module', () => {
    const imp = impactOf(graph, 'src/app.ts')
    expect(imp.directDependents).toContain('src/app.spec.ts')
    expect(imp.totalImpact).toBeGreaterThanOrEqual(1)
  })

  it('reports unknown modules without fabrication', () => {
    const imp = impactOf(graph, 'src/does-not-exist.ts')
    expect(imp.totalImpact).toBe(0)
    expect(imp.directDependents).toEqual([])
    expect(imp.risk).toBe('low')
  })

  it('combines several files into one change impact', () => {
    const change = impactOfMany(graph, ['src/core/types.ts', 'src/core/util.ts'])
    expect(change.unionDependents).toContain('src/app.ts')
    expect(change.unionDependents).toContain('src/dyn.ts')
    expect(change.estimatedFilesAffected).toBeGreaterThanOrEqual(6)
  })
})

describe('analysis.health', () => {
  let apiDispose: { api: unknown; snapshot: Snapshot }
  let program: Program
  let graph: DepGraph
  const root = normalizePath(mkdtempSync(join(tmpdir(), 'arch-health')))
  const opts = () => ({ projectRoot: root, tsconfigPath: normalizePath(join(root, 'tsconfig.json')), includeTests: true, maxFiles: 200 })

  beforeAll(() => {
    createFixture(root, {
      'src/pkga/one.ts': `import { two } from '../pkgb/two'\nexport const one = two\n`,
      'src/pkgb/two.ts': `import { one } from '../pkga/one'\nimport { missing } from './no'\nexport const two = one ?? missing\n`,
    })
    const { api, snapshot, program: p } = openProject(opts())
    apiDispose = { api, snapshot }
    program = p
    const { files } = parseProject(program, opts())
    graph = buildGraph(files, opts())
  })

  afterAll(() => {
    apiDispose.snapshot.dispose()
    ;(apiDispose.api as { close: () => void }).close()
    cleanupFixture(root)
  })

  it('scores a module in a cycle as fair with the cycle factor zeroed', () => {
    const { violations } = detectViolations(graph, {})
    const health = moduleHealth(graph, 'src/alpha.ts', violations)!
    expect(health.level).toBe('fair')
    expect(health.score).toBeLessThan(0.8)
    const cycle = health.factors.find((f) => f.name === 'cycles')!
    expect(cycle.score).toBe(0)
  })

  it('scores a module in a cycle with unresolved imports as poor', () => {
    const { violations } = detectViolations(graph, {})
    const health = moduleHealth(graph, 'src/pkgb/two.ts', violations)!
    expect(health.level).toBe('poor')
    expect(health.score).toBeLessThan(0.6)
  })

  it('scores a clean leaf module well', () => {
    const { violations } = detectViolations(graph, {})
    const health = moduleHealth(graph, 'src/core/types.ts', violations)!
    expect(health.score).toBeGreaterThanOrEqual(0.85)
    expect(health.level).toBe('good')
    expect(health.factors.every((f) => f.score > 0.8)).toBe(true)
  })

  it('returns null for unknown modules', () => {
    expect(moduleHealth(graph, 'src/nope.ts', [])).toBeNull()
  })

  it('summarizes a whole repository with a worst module', () => {
    const { violations } = detectViolations(graph, {})
    const health = repoHealth(graph, violations)
    expect(health.distribution.evaluated).toBeGreaterThan(0)
    expect(health.distribution.poor).toBeGreaterThanOrEqual(1)
    expect(health.worstModule!.module).toBe('src/pkgb/two.ts')
    expect(health.ranked[0]!.score).toBeLessThanOrEqual(health.ranked[1]!.score)
  })

  it('ranks hotspots with violation overlap first', () => {
    const { violations } = detectViolations(graph, {})
    const list = hotspots(graph, violations, { 'src/core/types.ts': 4 }, 10)
    expect(list.length).toBeGreaterThan(0)
    const alpha = list.find((h) => h.module === 'src/alpha.ts')
    expect(alpha!.violationCount).toBeGreaterThan(0)
    const types = list.find((h) => h.module === 'src/core/types.ts')
    expect(types!.changes).toBe(4)
    expect(list[0]!.score).toBeGreaterThanOrEqual(list[1]!.score)
  })

  it('maps health levels to readable summaries', () => {
    expect(healthSummary('good')).toMatch(/healthy/)
    expect(healthSummary('fair')).toMatch(/attention/)
    expect(healthSummary('poor')).toMatch(/at risk/)
  })
})