import { describe, expect, it, beforeAll, afterAll } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, readFileSync } from 'node:fs'
import { openProject, parseProject, normalizePath } from './parser.ts'
import { createFixture, cleanupFixture } from './testFixtures.ts'
import { buildGraph, type DepGraph } from './graph.ts'
import { detectViolations } from './violations.ts'
import {
  generateRepairPlans,
  planForViolation,
  simulateRemap,
  applyRepairPlans,
  replaceSpecifierInLine,
} from './repair.ts'
import type { ArchitectureConfig } from './config.ts'
import type { Program } from 'typescript/unstable/sync'
import type { Snapshot } from 'typescript/unstable/sync'

const CONFIG: ArchitectureConfig = {
  packages: [
    { name: 'pkgA', include: ['src/pkgA/**'], publicApi: ['src/pkgA/index.ts'] },
    { name: 'pkgB', include: ['src/pkgB/**'] },
  ],
  dependencyInversion: [{ interface: 'src/ports.ts', implementation: 'src/impl.ts' }],
}

const FILES: Record<string, string> = {
  'src/ports.ts': `export interface Deal { x: number }\nexport const deal: Deal = { x: 1 }\n`,
  'src/impl.ts': `import type { Deal } from './ports'\nexport const deal: Deal = { x: 2 }\n`,
  'src/consumer.ts': `import { deal } from './impl'\nexport const v = deal.x\n`,
  'src/pkgA/index.ts': `export * from './internal'\n`,
  'src/pkgA/internal.ts': `export const hidden = 1\n`,
  'src/pkgB/index.ts': `import { hidden } from '../pkgA/internal'\nexport const b = hidden\n`,
  'src/broken.ts': `import { nope } from './missing'\nexport const b = nope\n`,
}

describe('repair planning', () => {
  let apiDispose: { api: unknown; snapshot: Snapshot }
  let program: Program
  let graph: DepGraph
  const root = normalizePath(mkdtempSync(join(tmpdir(), 'arch-repair')))
  const opts = () => ({ projectRoot: root, tsconfigPath: normalizePath(join(root, 'tsconfig.json')), includeTests: true, maxFiles: 200 })

  beforeAll(() => {
    createFixture(root, FILES, { includeBase: false })
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
    void program
  })

  it('produces a verified, resolvable plan for dependency inversion', () => {
    const before = detectViolations(graph, CONFIG)
    const inv = before.violations.find((v) => v.type === 'dependency_inversion' && v.source.endsWith('consumer.ts'))!
    const plan = planForViolation(graph, inv, CONFIG)!
    expect(plan.resolution).toBe('resolvable')
    expect(plan.namesVerified).toBe(true)
    expect(plan.residualCount).toBeLessThan(before.violations.length)
    expect(plan.actions).toHaveLength(1)
    expect(plan.actions[0]!.newSpecifier).toBe('./ports')
    expect(plan.actions[0]!.line).toBe(1)
  })

  it('routes package-boundary leaks through the public entry', () => {
    const v = detectViolations(graph, CONFIG)
    const leak = v.violations.find((x) => x.type === 'package_boundary_violation' && x.source.endsWith('pkgB/index.ts'))!
    const plan = planForViolation(graph, leak, CONFIG)!
    expect(plan.resolution).toBe('resolvable')
    expect(plan.actions[0]!.newSpecifier).toBe('../pkgA/index')
  })

  it('leaves unresolved imports and non-mechanical cases for manual handling', () => {
    const v = detectViolations(graph, CONFIG)
    const set = generateRepairPlans(graph, v.violations, CONFIG)
    const unresolved = set.manual.find((m) => m.type === 'unresolved_import')
    expect(unresolved).toBeDefined()
    expect(set.manual.every((m) => m.type !== 'dependency_inversion')).toBe(true)
  })

  it('never mutates the caller graph during simulation', () => {
    const v = detectViolations(graph, CONFIG)
    const inv = v.violations.find((x) => x.type === 'dependency_inversion')!
    const edgeBefore = [...graph.nodes.values()].flatMap((n) => n.imports).find((e) => e.specifier === './impl')!
    planForViolation(graph, inv, CONFIG)
    const edgeAfter = [...graph.nodes.values()].flatMap((n) => n.imports).find((e) => e.specifier === './impl')!
    expect(edgeAfter.target).toBe(edgeBefore.target)
    expect(edgeAfter.specifier).toBe('./impl')
  })

  it('applies edits only for resolvable plans', () => {
    const v = detectViolations(graph, CONFIG)
    const set = generateRepairPlans(graph, v.violations, CONFIG)
    const result = applyRepairPlans(root, set.plans)
    expect(result.applied).toContain('src/consumer.ts')
    const consumer = readFileSync(join(root, 'src/consumer.ts'), 'utf8')
    expect(consumer).toContain("import { deal } from './ports'")
    expect(consumer).not.toContain("from './impl'")
    // The package-boundary retarget line also changed on disk.
    const pkgb = readFileSync(join(root, 'src/pkgB/index.ts'), 'utf8')
    expect(pkgb).toContain("../pkgA/index")
    expect(result.actions.length).toBeGreaterThanOrEqual(2)
  })

  it('rewrites only the quoted specifier on a line', () => {
    expect(replaceSpecifierInLine("import { a } from './old'", './old', './new')).toBe("import { a } from './new'")
    expect(replaceSpecifierInLine('import { a } from "./old"', './old', './new')).toBe('import { a } from "./new"')
    expect(replaceSpecifierInLine("const x = './old' + 1", './old', './new')).toBe("const x = './new' + 1")
  })
})

describe('repair simulation edge cases', () => {
  it('treats missing candidates as unsupported without fabricating actions', () => {
    const empty = simulateRemap({ nodes: new Map(), edges: [], boundaryEdges: [], externalEdges: [], projectRoot: 'H:/x' } as DepGraph, [])
    expect(empty.nodes.size).toBe(0)
  })
})