// Dependency graph construction and analysis over parsed modules.
//
// Builds the resolved module graph from parsed files, computes per-node
// fan-in/fan-out, detects dependency cycles (Tarjan strongly-connected
// components), and provides reachability queries used for impact analysis.

import type { ImportEdge, ModuleNode, ParsedFile, ParserOptions } from './types.ts'
import { loadTsconfigAliases, resolveSpecifier } from './resolver.ts'

export interface DepGraph {
  /** All analyzed modules keyed by normalized absolute path. */
  nodes: Map<string, ModuleNode>
  /** Internal edges where both endpoints are analyzed nodes. */
  edges: ImportEdge[]
  /** Edges from an analyzed node into a project file outside the analyzed set. */
  boundaryEdges: ImportEdge[]
  /** External and unresolved edges kept for reporting. */
  externalEdges: ImportEdge[]
  /** Posix-normalized project root. */
  projectRoot: string
}

export interface Cycle {
  /** Node paths forming the cycle, sorted. */
  members: string[]
  /** True when the cycle is a single node importing itself. */
  selfLoop: boolean
}

export interface ModuleMetrics {
  fanIn: number
  fanOut: number
  /** Count of value (static/dynamic/reexport) incoming edges. */
  valueFanIn: number
  /** Count of type-only incoming edges. */
  typeFanIn: number
  /** True when the module imports outside its own directory. */
  couplesToOthers: boolean
}

/**
 * Build the resolved module graph from parsed files.
 * `parsed` must be the sorted, capped output of {@link parseProject}.
 */
export function buildGraph(parsed: ParsedFile[], options: ParserOptions): DepGraph {
  const aliases = loadTsconfigAliases(options.tsconfigPath)
  const nodes = new Map<string, ModuleNode>()
  const edges: ImportEdge[] = []
  const boundaryEdges: ImportEdge[] = []
  const externalEdges: ImportEdge[] = []
  const root = options.projectRoot.replace(/\\/g, '/')

  for (const file of parsed) {
    nodes.set(file.path, {
      path: file.path,
      relativePath: toRelative(file.path, root),
      imports: [],
      exports: file.exports,
    })
  }

  for (const file of parsed) {
    const node = nodes.get(file.path)!
    for (const raw of file.imports) {
      const result = resolveSpecifier(file.path, raw.specifier, {
        projectRoot: root,
        paths: aliases.paths,
        baseUrl: aliases.baseUrl,
      })
      const resolvedPath = result.path ? result.path : null
      const edge: ImportEdge = {
        source: file.path,
        target: resolvedPath ?? result.externalSpecifier ?? raw.specifier,
        specifier: raw.specifier,
        kind: raw.kind,
        isTypeOnly: raw.isTypeOnly,
        names: raw.names,
        resolved: result.status === 'file',
        external: result.status === 'external',
        unresolved: result.status === 'unresolved',
        line: raw.line,
        column: raw.column,
      }
      node.imports.push(edge)
      if (result.status === 'file' && resolvedPath) {
        if (nodes.has(resolvedPath)) {
          edges.push(edge)
        } else if (resolvedPath.startsWith(root + '/')) {
          boundaryEdges.push(edge)
        } else {
          externalEdges.push(edge)
        }
      } else {
        externalEdges.push(edge)
      }
    }
  }

  return { nodes, edges, boundaryEdges, externalEdges, projectRoot: root }
}

function toRelative(path: string, root: string): string {
  if (path.startsWith(root + '/')) return path.slice(root.length + 1)
  return path
}

/** Compute per-node fan-in/fan-out metrics in one pass. */
export function moduleMetrics(graph: DepGraph): Map<string, ModuleMetrics> {
  const metrics = new Map<string, ModuleMetrics>()
  for (const node of graph.nodes.keys()) {
    metrics.set(node, { fanIn: 0, fanOut: 0, valueFanIn: 0, typeFanIn: 0, couplesToOthers: false })
  }
  for (const edge of graph.edges) {
    const out = metrics.get(edge.source)
    if (out) out.fanOut++
    const inc = metrics.get(edge.target)
    if (inc) {
      inc.fanIn++
      if (edge.isTypeOnly) inc.typeFanIn++
      else inc.valueFanIn++
    }
  }
  for (const edge of graph.boundaryEdges) {
    const out = metrics.get(edge.source)
    if (out) {
      out.fanOut++
      out.couplesToOthers = true
    }
  }
  for (const edge of graph.externalEdges) {
    const out = metrics.get(edge.source)
    if (out) out.fanOut++
  }
  return metrics
}

/** All in-project dependency targets of a node that are themselves analyzed. */
export function dependenciesOf(graph: DepGraph, path: string): string[] {
  const node = graph.nodes.get(path)
  if (!node) return []
  return node.imports
    .filter((e) => graph.nodes.has(e.target))
    .map((e) => e.target)
}

/** All in-project analyzed modules that depend (transitively, directly) on a node. */
export function directDependentsOf(graph: DepGraph, path: string): string[] {
  const result: string[] = []
  for (const edge of graph.edges) {
    if (edge.target === path && graph.nodes.has(edge.source)) result.push(edge.source)
  }
  return result
}

/**
 * Detect dependency cycles via Tarjan's algorithm. Returns all
 * non-trivial strongly-connected components (self-loops included).
 */
export function detectCycles(graph: DepGraph): Cycle[] {
  const index = new Map<string, number>()
  const lowlink = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const cycles: Cycle[] = []
  let counter = 0

  const paths = new Set<string>(graph.nodes.keys())

  function strongconnect(v: string): void {
    index.set(v, counter)
    lowlink.set(v, counter)
    counter++
    stack.push(v)
    onStack.add(v)

    for (const w of dependenciesOf(graph, v)) {
      if (!index.has(w)) {
        strongconnect(w)
        lowlink.set(v, Math.min(lowlink.get(v) ?? 0, lowlink.get(w) ?? 0))
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v) ?? 0, index.get(w) ?? 0))
      }
    }

    if (lowlink.get(v) === index.get(v)) {
      const component: string[] = []
      let w: string | undefined
      do {
        w = stack.pop()
        onStack.delete(w!)
        if (w !== undefined) component.push(w)
      } while (w !== v)
      component.sort()
      if (component.length > 1 || graph.edges.some((e) => e.source === v && e.target === v)) {
        cycles.push({ members: component, selfLoop: component.length === 1 })
      }
    }
  }

  for (const v of [...paths].sort()) {
    if (!index.has(v)) strongconnect(v)
  }
  return cycles
}

/**
 * Longest transitive distance from a node to any of its dependents
 * (the "upstream" blast radius measured in dependency hops, excluding cycles).
 */
export function maxDependentsDistance(graph: DepGraph, path: string): number {
  const visited = new Set<string>()
  const queue: Array<{ p: string; depth: number }> = [{ p: path, depth: 0 }]
  let max = 0
  while (queue.length > 0) {
    const { p, depth } = queue.shift()!
    if (visited.has(p)) continue
    visited.add(p)
    max = Math.max(max, depth)
    for (const dep of directDependentsOf(graph, p)) queue.push({ p: dep, depth: depth + 1 })
  }
  return max
}

/** All modules reachable from `path` following import edges (transitively). */
export function reachableFrom(graph: DepGraph, path: string, direction: 'dependents' | 'dependencies'): string[] {
  const visited = new Set<string>()
  const queue: string[] = [path]
  const follow = (p: string): string[] =>
    direction === 'dependents' ? directDependentsOf(graph, p) : dependenciesOf(graph, p)
  while (queue.length > 0) {
    const cur = queue.shift()!
    for (const nxt of follow(cur)) {
      if (visited.has(nxt)) continue
      visited.add(nxt)
      queue.push(nxt)
    }
  }
  return [...visited].sort()
}

/** Graph-level statistics. */
export function graphStats(graph: DepGraph): {
  nodeCount: number
  edgeCount: number
  boundaryCount: number
  externalCount: number
  unresolvedCount: number
} {
  return {
    nodeCount: graph.nodes.size,
    edgeCount: graph.edges.length,
    boundaryCount: graph.boundaryEdges.length,
    externalCount: graph.externalEdges.filter((e) => e.external).length,
    unresolvedCount: graph.externalEdges.filter((e) => e.unresolved).length,
  }
}

/** Sort modules by relative path for deterministic output. */
export function sortedModules(graph: DepGraph): ModuleNode[] {
  return [...graph.nodes.values()].sort((a, b) => (a.path < b.path ? -1 : 1))
}