import { describe, expect, it, beforeAll, afterAll } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync } from 'node:fs'
import { openProject, parseProject, normalizePath, closeProject } from './parser.ts'
import { createFixture, cleanupFixture, type Fixture } from './testFixtures.ts'
import { buildGraph, detectCycles, moduleMetrics, dependenciesOf, directDependentsOf, graphStats, reachableFrom } from './graph.ts'
import type { Program } from 'typescript/unstable/async'
import type { API, Snapshot } from 'typescript/unstable/async'

describe('graph', () => {
  let fixture: Fixture
  let apiDispose: { api: API; snapshot: Snapshot } | undefined
  let program: Program
  const root = normalizePath(mkdtempSync(join(tmpdir(), 'arch-graph')))

  beforeAll(async () => {
    fixture = createFixture(root)
    const { api, snapshot, program: p } = await openProject({
      projectRoot: normalizePath(root),
      tsconfigPath: normalizePath(join(root, 'tsconfig.json')),
      includeTests: true,
      maxFiles: 50,
    })
    apiDispose = { api, snapshot }
    program = p
  })

  afterAll(async () => {
    if (apiDispose) await closeProject(apiDispose)
    cleanupFixture(root)
  })

  it('builds a graph with the expected node count', async () => {
    const opts = { projectRoot: normalizePath(root), tsconfigPath: normalizePath(join(root, 'tsconfig.json')), includeTests: true, maxFiles: 50 }
    const { files } = await parseProject(program, opts)
    const graph = buildGraph(files, opts)
    expect(graph.nodes.size).toBe(10)
  })

  it('resolves cycles between alpha and beta', async () => {
    const opts = { projectRoot: normalizePath(root), tsconfigPath: normalizePath(join(root, 'tsconfig.json')), includeTests: true, maxFiles: 50 }
    const { files } = await parseProject(program, opts)
    const graph = buildGraph(files, opts)
    const cycles = detectCycles(graph)
    expect(cycles.length).toBeGreaterThanOrEqual(1)
    const abCycle = cycles.find((c) => c.members.some((m) => m.endsWith('alpha.ts')) && c.members.some((m) => m.endsWith('beta.ts')))
    expect(abCycle).toBeDefined()
    expect(abCycle!.members.length).toBe(2)
  })

  it('detects self-loop on self.ts', async () => {
    const opts = { projectRoot: normalizePath(root), tsconfigPath: normalizePath(join(root, 'tsconfig.json')), includeTests: true, maxFiles: 50 }
    const { files } = await parseProject(program, opts)
    const graph = buildGraph(files, opts)
    const cycles = detectCycles(graph)
    const selfCycle = cycles.find((c) => c.members.some((m) => m.endsWith('self.ts')))
    expect(selfCycle).toBeDefined()
    expect(selfCycle!.selfLoop).toBe(true)
  })

  it('computes fan-in and fan-out per module', async () => {
    const opts = { projectRoot: normalizePath(root), tsconfigPath: normalizePath(join(root, 'tsconfig.json')), includeTests: true, maxFiles: 50 }
    const { files } = await parseProject(program, opts)
    const graph = buildGraph(files, opts)
    const metrics = moduleMetrics(graph)
    const typesNode = [...metrics.entries()].find(([k]) => k.endsWith('core/types.ts'))
    expect(typesNode).toBeDefined()
    expect(typesNode![1].fanOut).toBe(0)
    expect(typesNode![1].fanIn).toBeGreaterThanOrEqual(2)
  })

  it('reports dependenciesOf and directDependentsOf', async () => {
    const opts = { projectRoot: normalizePath(root), tsconfigPath: normalizePath(join(root, 'tsconfig.json')), includeTests: true, maxFiles: 50 }
    const { files } = await parseProject(program, opts)
    const graph = buildGraph(files, opts)
    const typesPath = [...graph.nodes.keys()].find((k) => k.endsWith('core/types.ts'))!
    const utilPath = [...graph.nodes.keys()].find((k) => k.endsWith('core/util.ts'))!
    expect(directDependentsOf(graph, typesPath).length).toBeGreaterThanOrEqual(2)
    expect(dependenciesOf(graph, utilPath)).toContain(typesPath)
  })

  it('reports reachableFrom downstream and upstream', async () => {
    const opts = { projectRoot: normalizePath(root), tsconfigPath: normalizePath(join(root, 'tsconfig.json')), includeTests: true, maxFiles: 50 }
    const { files } = await parseProject(program, opts)
    const graph = buildGraph(files, opts)
    const typesPath = [...graph.nodes.keys()].find((k) => k.endsWith('core/types.ts'))!
    const utilPath = [...graph.nodes.keys()].find((k) => k.endsWith('core/util.ts'))!
    const downstream = reachableFrom(graph, typesPath, 'dependents')
    expect(downstream.some((p) => p.endsWith('app.ts'))).toBe(true)
    const upstream = reachableFrom(graph, utilPath, 'dependencies')
    expect(upstream).toContain(typesPath)
  })

  it('graphStats returns correct counts', async () => {
    const opts = { projectRoot: normalizePath(root), tsconfigPath: normalizePath(join(root, 'tsconfig.json')), includeTests: true, maxFiles: 50 }
    const { files } = await parseProject(program, opts)
    const graph = buildGraph(files, opts)
    const stats = graphStats(graph)
    expect(stats.nodeCount).toBe(10)
    expect(stats.externalCount).toBeGreaterThanOrEqual(1)
  })
})