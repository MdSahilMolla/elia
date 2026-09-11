// Architectural violation detection.
//
// Each detector makes only claims the evidence supports; structures that cannot
// be justified (e.g. a "dependency inversion" that is purely speculative) are
// skipped rather than reported. Configuration explicitly defines rules; anything
// derived from the graph without configuration is labeled inference in the
// report and is not surfaced as a hard failure.

import type { Severity, Violation } from './types.ts'
import type { DepGraph } from './graph.ts'
import { detectCycles, moduleMetrics, sortedModules } from './graph.ts'
import type { ArchitectureConfig } from './config.ts'
import { matchesAny, basenameNoExt } from './config.ts'

export interface DetectionResult {
  violations: Violation[]
  /** Module layer assignment used by the detectors. */
  layers: Map<string, string>
}

const ENTRY_NAMES = new Set(['index', 'main', 'cli', 'config', 'constants', 'types', 'registry', 'router'])

function rel(graph: DepGraph, path: string): string {
  return graph.nodes.get(path)?.relativePath ?? path
}

function layerOf(relativePath: string): string {
  const seg = relativePath.split('/')[0]
  return seg || 'root'
}

/** True when `name` appears as a path component (e.g. `lib` in `src/lib/x.ts`). */
function hasDirComponent(relativePath: string, name: string): boolean {
  return relativePath.split('/').includes(name)
}

/** Assign each module a layer, using config layers first, then inference. */
export function assignLayers(graph: DepGraph, config: ArchitectureConfig): Map<string, string> {
  const layers = new Map<string, string>()
  for (const node of sortedModules(graph)) {
    const relPath = node.relativePath
    let assigned = ''
    if (config.layers && config.layers.length > 0) {
      const match = config.layers.find((l) => matchesAny(relPath, l.include))
      assigned = match ? match.name : 'unassigned'
    }
    if (!assigned) assigned = layerOf(relPath)
    layers.set(node.path, assigned)
  }
  return layers
}

function layerIndex(layers: Map<string, string>, path: string): number {
  return [...layers.values()].indexOf(layers.get(path) ?? '')
}

function severityFor(critical: boolean): Severity {
  return critical ? 'critical' : 'error'
}

function longChainDepth(graph: DepGraph, path: string): number {
  const memo = new Map<string, number>()
  const visited = new Set<string>()
  function depth(p: string): { depth: number; cyclic: boolean } {
    if (memo.has(p)) return { depth: memo.get(p)!, cyclic: false }
    if (visited.has(p)) return { depth: 0, cyclic: true }
    visited.add(p)
    const node = graph.nodes.get(p)
    let best = 0
    if (node) {
      for (const edge of node.imports) {
        if (graph.nodes.has(edge.target)) {
          const d = depth(edge.target)
          if (d.cyclic) continue
          best = Math.max(best, d.depth + 1)
        }
      }
    }
    visited.delete(p)
    memo.set(p, best)
    return { depth: best, cyclic: false }
  }
  return depth(path).depth
}

function stats(values: number[]): { mean: number; std: number } {
  if (values.length === 0) return { mean: 0, std: 0 }
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length
  return { mean, std: Math.sqrt(variance) }
}

/** Detect every supported violation type over the graph. */
export function detectViolations(graph: DepGraph, config: ArchitectureConfig): DetectionResult {
  const violations: Violation[] = []
  const metrics = moduleMetrics(graph)
  const layers = assignLayers(graph, config)
  const nodes = sortedModules(graph)
  const configLayerList = config.layers ?? []

  // 1 + 2: cycle detection is graph-wide; each SCC becomes a violation.
  const cycles = detectCycles(graph)
  for (const cycle of cycles) {
    const members = cycle.members.map((m) => rel(graph, m))
    const critical = cycle.members.length === 2 || cycle.selfLoop
    for (const member of cycle.members) {
      const closing = graph.nodes.get(member)?.imports.find((e) => cycle.members.includes(e.target))
      violations.push({
        type: 'circular_dependency',
        severity: severityFor(critical || cycle.selfLoop),
        source: rel(graph, member),
        target: closing ? rel(graph, closing.target) : '',
        specifier: closing?.specifier,
        line: closing?.line,
        description: `Module participates in a dependency cycle${cycle.selfLoop ? ' (imports itself)' : ''}: ${members.join(' -> ')}`,
        suggestion: cycle.selfLoop
          ? 'Break the self-import: move the shared code into a dependency of this module.'
          : 'Extract the shared types or behavior into a third module to break the cycle.',
        why: '',
      })
    }
  }

  // Layer direction + forbidden/package/leakage/unresolved detectors over edges.
  for (const node of nodes) {
    for (const edge of node.imports) {
      const sourceLayer = layers.get(edge.source) ?? 'unassigned'
      const targetLayer = edge.external ? 'external' : (layers.get(edge.target) ?? 'unassigned')
      const srcRel = rel(graph, edge.source)
      const tgtRel = edge.external ? edge.target : rel(graph, edge.target)

      if (config.direction === 'downward' && configLayerList.length > 0 && !edge.external) {
        const si = configLayerList.findIndex((l) => l.name === sourceLayer)
        const ti = configLayerList.findIndex((l) => l.name === targetLayer)
        if (si >= 0 && ti >= 0 && ti < si) {
          violations.push({
            type: 'import_direction',
            severity: 'error',
            source: srcRel,
            target: tgtRel,
            specifier: edge.specifier,
            line: edge.line,
            description: `Layer "${sourceLayer}" imports from upper layer "${targetLayer}" (${edge.specifier}).`,
            suggestion: `Move the imported code into ${sourceLayer} or a shared layer below both.`,
            why: '',
          })
          continue
        }
      }

      if (config.legacyLibAppRule && !edge.external) {
        if (hasDirComponent(srcRel, 'lib') && hasDirComponent(tgtRel, 'app')) {
          violations.push({
            type: 'import_direction',
            severity: 'error',
            source: srcRel,
            target: tgtRel,
            specifier: edge.specifier,
            line: edge.line,
            description: `Library module imports from app module (${edge.specifier}). Libraries must not depend on application code.`,
            suggestion: 'Extract the needed functionality into a shared module, or invert the dependency.',
            why: '',
          })
          continue
        }
      }

      if (edge.unresolved) {
        const exempt = matchesAny(srcRel, config.exempt)
        if (!exempt) {
          violations.push({
            type: 'unresolved_import',
            severity: 'warning',
            source: srcRel,
            target: '',
            specifier: edge.specifier,
            line: edge.line,
            description: `Cannot resolve "${edge.specifier}" (module not found).`,
            suggestion: 'Install the dependency or fix the specifier to a real file.',
            why: '',
          })
        }
        continue
      }

      for (const rule of config.forbiddenImports ?? []) {
        const fromMatch = matchesAny(srcRel, [rule.from])
        if (!fromMatch) continue
        let toMatch = false
        if (rule.to.startsWith('ext:')) toMatch = edge.external && edge.specifier === rule.to.slice(4)
        else if (rule.to === '*' || rule.to === '**') toMatch = edge.external
        else toMatch = matchesAny(tgtRel, [rule.to])
        if (!toMatch) continue
        violations.push({
          type: 'forbidden_import',
          severity: 'error',
          source: srcRel,
          target: tgtRel,
          specifier: edge.specifier,
          line: edge.line,
          description: `Forbidden import ${edge.specifier}${rule.reason ? ` — ${rule.reason}` : ''}.`,
          suggestion: rule.reason ?? 'Refactor to respect the rule.',
          why: '',
        })
      }

      // Package boundaries.
      if (!edge.external && config.packages) {
        const srcPkg = config.packages.find((p) => matchesAny(srcRel, p.include))
        const tgtPkg = config.packages.find((p) => matchesAny(tgtRel, p.include))
        if (srcPkg && tgtPkg && srcPkg.name !== tgtPkg.name) {
          const publicOk = !tgtPkg.publicApi || matchesAny(tgtRel, tgtPkg.publicApi)
          if (!publicOk) {
            violations.push({
              type: 'package_boundary_violation',
              severity: 'error',
              source: srcRel,
              target: tgtRel,
              specifier: edge.specifier,
              line: edge.line,
              description: `Package "${srcPkg.name}" imports non-public path "${tgtRel}" of package "${tgtPkg.name}".`,
              suggestion: 'Route the import through the target package’s public API.',
              why: '',
            })
          }
        }
      }

      // Abstraction leakage: cross-layer import bypasses the target layer's
      // public API when one is declared.
      if (!edge.external && config.layers && configLayerList.length > 0) {
        const srcLayerDef = configLayerList.find((l) => l.name === sourceLayer)
        const tgtLayerDef = configLayerList.find((l) => l.name === targetLayer)
        if (srcLayerDef && tgtLayerDef && tgtLayerDef.publicApi && sourceLayer !== targetLayer) {
          if (!matchesAny(tgtRel, tgtLayerDef.publicApi)) {
            violations.push({
              type: 'abstraction_leakage',
              severity: 'warning',
              source: srcRel,
              target: tgtRel,
              specifier: edge.specifier,
              line: edge.line,
              description: `Layer "${sourceLayer}" reaches into implementation path "${tgtRel}" of layer "${targetLayer}", bypassing its public API.`,
              suggestion: `Import from ${targetLayer}’s public surface instead of its internals.`,
              why: '',
            })
          }
        }
      }

      // Dependency inversion pairs.
      if (!edge.external && config.dependencyInversion) {
        for (const pair of config.dependencyInversion) {
          const implTarget = matchesAny(tgtRel, [pair.implementation])
          const intfTarget = matchesAny(tgtRel, [pair.interface])
          if (implTarget && !intfTarget) {
            violations.push({
              type: 'dependency_inversion',
              severity: 'error',
              source: srcRel,
              target: tgtRel,
              specifier: edge.specifier,
              line: edge.line,
              description: `Concrete implementation accessed directly instead of through its interface (${pair.interface}).`,
              suggestion: `Depend on "${pair.interface}" and receive the implementation by injection.`,
              why: '',
            })
          }
        }
      }
    }
  }

  // God modules and excessive coupling use distribution outliers to limit
  // false positives; unassigned/inferred layers never drive these.
  const fanOutValues = [...metrics.values()].map((m) => m.fanOut)
  const fanInValues = [...metrics.values()].map((m) => m.fanIn)
  const { mean: outMean, std: outStd } = stats(fanOutValues)
  const { mean: inMean, std: inStd } = stats(fanInValues)

  for (const node of nodes) {
    const m = metrics.get(node.path)!
    const relPath = node.relativePath
    if (m.fanOut > outMean + 2 * outStd && m.fanOut >= 12 && m.fanIn > 0) {
      violations.push({
        type: 'god_module',
        severity: 'warning',
        source: relPath,
        target: '',
        description: `Module has ${m.fanOut} outgoing dependencies (${Math.round(m.fanOut / Math.max(outMean, 1))}x the average) — it coordinates too much.`,
        suggestion: 'Split it into focused sub-modules and have callers use the pieces.',
        why: '',
      })
    }
    if (m.fanIn > inMean + 2 * inStd && m.fanIn >= 8) {
      const dependentLayers = new Set<string>()
      for (const edge of graph.edges) {
        if (edge.target === node.path) dependentLayers.add(layers.get(edge.source) ?? '')
      }
      if (dependentLayers.size > 1) {
        violations.push({
          type: 'excessive_coupling',
          severity: 'warning',
          source: relPath,
          target: '',
          description: `Module is depended on by ${m.fanIn} modules across ${dependentLayers.size} layers — a hidden hub.`,
          suggestion: 'Decouple dependents by introducing shared abstractions behind it.',
          why: '',
        })
      }
    }
    if (m.fanIn === 0 && m.fanOut === 0 && node.imports.length === 0) {
      const exempt = matchesAny(relPath, config.exempt) || isEntryLike(relPath) || node.exports.length === 0
      if (!exempt) {
        violations.push({
          type: 'orphan_module',
          severity: 'info',
          source: relPath,
          target: '',
          description: 'Module has no imports and no dependents.',
          suggestion: 'Connect it to the graph (import it) or remove it.',
          why: '',
        })
      }
    }
  }

  // Deep dependency chains (bounded to avoid noise).
  const maxDepth = config.maxChainDepth ?? 12
  if (maxDepth > 0) {
    for (const node of nodes) {
      const d = longChainDepth(graph, node.path)
      if (d > maxDepth) {
        violations.push({
          type: 'deep_dependency_chain',
          severity: 'info',
          source: node.relativePath,
          target: '',
          description: `Transitive dependency chain reaches depth ${d} (limit ${maxDepth}).`,
          suggestion: 'Flatten the middle layers or introduce a facade to shorten the chain.',
          why: '',
        })
      }
    }
  }

  return { violations, layers }
}

function isEntryLike(relPath: string): boolean {
  const base = basenameNoExt(relPath)
  if (ENTRY_NAMES.has(base)) return true
  const parts = relPath.split('/')
  return parts[0] === 'scripts' || parts.includes('fixtures') || parts.includes('mocks')
}