import { describe, expect, it, beforeAll, afterAll } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync } from 'node:fs'
import { openProject, parseProject, normalizePath } from './parser.ts'
import { createFixture, cleanupFixture, type Fixture } from './testFixtures.ts'
import { buildGraph, detectCycles, moduleMetrics, dependenciesOf, directDependentsOf, graphStats, reachableFrom } from './graph.ts'
import type { Program } from 'typescript/unstable/sync'
import type { Snapshot } from 'typescript/unstable/sync'

describe('graph', () => {
  let fixture: Fixture
  let apiDispose: { api: unknown; snapshot: Snapshot }
  let program: Program
  const root = normalizePath(mkdtempSync(join(tmpdir(), 'arch-graph')))

  beforeAll(() => {
    fixture = createFixture(root)
    const { api, snapshot, program: p } = openProject({
      projectRoot: normalizePath(root),
      tsconfigPath: normalizePath(join(root, 'tsconfig.json')),
      includeTests: true,
      maxFiles: 50,
    })
    apiDispose = { api, snapshot }
    program = p
  })

  afterAll(() => {
    apiDispose.snapshot.dispose()
    ;(apiDispose.api as { close: () => void }).close()
    cleanupFixture(root)
  })

  it('builds a graph with the expected node count', () => {
    const opts = { projectRoot: normalizePath(root), tsconfigPath: normalizePath(join(root, 'tsconfig.json')), includeTests: true, maxFiles: 50 }
    const { files } = parseProject(program, opts)
    const graph = buildGraph(files, opts)
    expect(graph.nodes.size).toBe(10)
  })

  it('resolves cycles between alpha and beta', () => {
    const opts = { projectRoot: normalizePath(root), tsconfigPath: normalizePath(join(root, 'tsconfig.json')), includeTests: true, maxFiles: 50 }
    const { files } = parseProject(program, opts)
    const graph = buildGraph(files, opts)
    const cycles = detectCycles(graph)
    expect(cycles.length).toBeGreaterThanOrEqual(1)
    const abCycle = cycles.find((c) => c.members.some((m) => m.endsWith('alpha.ts')) && c.members.some((m) => m.endsWith('beta.ts')))
    expect(abCycle).toBeDefined()
    expect(abCycle!.members.length).toBe(2)
  })

  it('detects self-loop on self.ts', () => {
    const opts = { projectRoot: normalizePath(root), tsconfigPath: normalizePath(join(root, 'tsconfig.json')), includeTests: true, maxFiles: 50 }
    const { files } = parseProject(program, opts)
    const graph = buildGraph(files, opts)
    const cycles = detectCycles(graph)
    const selfCycle = cycles.find((c) => c.members.some((m) => m.endsWith('self.ts')))
    expect(selfCycle).toBeDefined()
    expect(selfCycle!.selfLoop).toBe(true)
  })

  it('computes fan-in and fan-out per module', () => {
    const opts = { projectRoot: normalizePath(root), tsconfigPath: normalizePath(join(root, 'tsconfig.json')), includeTests: true, maxFiles: 50 }
    const { files } = parseProject(program, opts)
    const graph = buildGraph(files, opts)
    const metrics = moduleMetrics(graph)
    const typesNode = [...metrics.entries()].find(([k]) => k.endsWith('core/types.ts'))
    expect(typesNode).toBeDefined()
    expect(typesNode![1].fanOut).toBe(0)
    expect(typesNode![1].fanIn).toBeGreaterThanOrEqual(2)
  })

  it('reports dependenciesOf and directDependentsOf', () => {
    const opts = { projectRoot: normalizePath(root), tsconfigPath: normalizePath(join(root, 'tsconfig.json')), includeTests: true, maxFiles: 50 }
    const { files } = parseProject(program, opts)
    const graph = buildGraph(files, opts)
    const typesPath = [...graph.nodes.keys()].find((k) => k.endsWith('core/types.ts'))!
    const utilPath = [...graph.nodes.keys()].find((k) => k.endsWith('core/util.ts'))!
    expect(directDependentsOf(graph, typesPath).length).toBeGreaterThanOrEqual(2)
    expect(dependenciesOf(graph, utilPath)).toContain(typesPath)
  })

  it('reports reachableFrom downstream and upstream', () => {
    const opts = { projectRoot: normalizePath(root), tsconfigPath: normalizePath(join(root, 'tsconfig.json')), includeTests: true, maxFiles: 50 }
    const { files } = parseProject(program, opts)
    const graph = buildGraph(files, opts)
    const typesPath = [...graph.nodes.keys()].find((k) => k.endsWith('core/types.ts'))!
    const utilPath = [...graph.nodes.keys()].find((k) => k.endsWith('core/util.ts'))!
    const downstream = reachableFrom(graph, typesPath, 'dependents')
    expect(downstream.some((p) => p.endsWith('app.ts'))).toBe(true)
    const upstream = reachableFrom(graph, utilPath, 'dependencies')
    expect(upstream).toContain(typesPath)
  })

  it('graphStats returns correct counts', () => {
    const opts = { projectRoot: normalizePath(root), tsconfigPath: normalizePath(join(root, 'tsconfig.json')), includeTests: true, maxFiles: 50 }
    const { files } = parseProject(program, opts)
    const graph = buildGraph(files, opts)
    const stats = graphStats(graph)
    expect(stats.nodeCount).toBe(10)
    expect(stats.externalCount).toBeGreaterThanOrEqual(1)
  })
})