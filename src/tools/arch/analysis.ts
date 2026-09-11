// Impact and health analysis over the architecture graph.
//
// Impact answers "if this module changes, what else must I touch or verify?"
// Health turns violations and coupling into an explainable per-module score
// with the contributing factors made explicit so nothing is a black box.

import type { DepGraph, ModuleMetrics } from './graph.ts'
import { moduleMetrics, directDependentsOf, reachableFrom, detectCycles, sortedModules } from './graph.ts'
import type { Violation, ViolationType } from './types.ts'
import type { ArchitectureConfig } from './config.ts'

// ---------------------------------------------------------------------------
// Impact / blast radius
// ---------------------------------------------------------------------------

export type RiskLevel = 'low' | 'medium' | 'high'

export interface ModuleImpact {
  /** Posix project-relative path of the changed module. */
  module: string
  /** Modules that import it directly. */
  directDependents: string[]
  /** Modules that import it transitively (excluding direct and self). */
  transitiveDependents: string[]
  /** Total number of distinct dependents (direct + transitive). */
  totalImpact: number
  /** Inferred top-level layer of every affected dependent. */
  affectedLayers: string[]
  /**
   * Rule of thumb risk: high when the blast radius is large or crosses many
   * layers, medium when mid-sized, low otherwise.
   */
  risk: RiskLevel
}

export interface ChangeImpact {
  /** Per-module impact for each changed file. */
  modules: ModuleImpact[]
  /** Union of all modules that depend on any changed file. */
  unionDependents: string[]
  /** Total distinct modules touched by the change set. */
  estimatedFilesAffected: number
}

function riskFor(totalImpact: number, distinctLayers: number): RiskLevel {
  if (totalImpact >= 15 || distinctLayers >= 4) return 'high'
  if (totalImpact >= 5 || distinctLayers >= 2) return 'medium'
  return 'low'
}

/**
 * Compute the impact (blast radius) of changing one module. `moduleRel` is a
 * project-relative path; if it names an analyzed module, dependents are
 * computed from the graph, otherwise impact is reported as unknown.
 */
export function impactOf(graph: DepGraph, moduleRel: string): ModuleImpact {
  const node = [...graph.nodes.values()].find((n) => n.relativePath === moduleRel || n.path === moduleRel)
  if (!node) {
    return {
      module: moduleRel,
      directDependents: [],
      transitiveDependents: [],
      totalImpact: 0,
      affectedLayers: [],
      risk: 'low',
    }
  }
  const direct = [...new Set(directDependentsOf(graph, node.path))]
  const all = reachableFrom(graph, node.path, 'dependents')
  const transitive = all.filter((p) => p !== node.path && !direct.includes(p))
  const layers = new Set<string>()
  for (const p of [...direct, ...transitive]) {
    const relPath = graph.nodes.get(p)?.relativePath ?? p
    layers.add(relPath.split('/')[0] || 'root')
  }
  const total = direct.length + transitive.length
  return {
    module: node.relativePath,
    directDependents: direct.map((p) => graph.nodes.get(p)?.relativePath ?? p).sort(),
    transitiveDependents: transitive.map((p) => graph.nodes.get(p)?.relativePath ?? p).sort(),
    totalImpact: total,
    affectedLayers: [...layers].sort(),
    risk: riskFor(total, layers.size),
  }
}

/**
 * Combine several changed files into one impact estimate. The union is the
 * set of modules that depend on at least one changed file.
 */
export function impactOfMany(graph: DepGraph, modules: string[]): ChangeImpact {
  const impacts = modules.map((m) => impactOf(graph, m))
  const union = new Map<string, { direct: boolean; module: string }>()
  for (const imp of impacts) {
    for (const d of imp.directDependents) union.set(d, { direct: true, module: imp.module })
    for (const t of imp.transitiveDependents) {
      if (!union.has(t)) union.set(t, { direct: false, module: imp.module })
    }
  }
  return {
    modules: impacts,
    unionDependents: [...union.keys()].sort(),
    estimatedFilesAffected: union.size,
  }
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export type HealthLevel = 'good' | 'fair' | 'poor'

export interface HealthFactor {
  /** Stable identifier for the contributing signal. */
  name: string
  /** Normalized 0-1 sub-score (1 = healthy). */
  score: number
  /** Relative weight of this signal in the final score. */
  weight: number
  /** Human-readable justification for the sub-score. */
  detail: string
}

export interface ModuleHealth {
  module: string
  /** Overall score 0-1. */
  score: number
  level: HealthLevel
  /** Ordered by weight descending. */
  factors: HealthFactor[]
}

const FACTOR_WEIGHTS = {
  cycles: 0.25,
  unresolved: 0.2,
  coupling: 0.15,
  rules: 0.25,
  orphan: 0.1,
  depth: 0.05,
} as const

const CYCLIC_SEVERITY_SCORE: Record<string, number> = {
  critical: 0,
  error: 0,
  warning: 0.5,
  info: 0.8,
}
const UNRESOLVED_SEVERITY_SCORE: Record<string, number> = {
  critical: 0,
  error: 0,
  warning: 0.2,
  info: 0.5,
}
const RULE_SEVERITY_SCORE: Record<string, number> = {
  critical: 0,
  error: 0.25,
  warning: 0.6,
  info: 0.85,
}

function worstOf(entries: Violation[], severityTable: Record<string, number>, fallback: number): number {
  if (entries.length === 0) return fallback
  let score = Infinity
  for (const v of entries) {
    const s = severityTable[v.severity] ?? 0.5
    if (s < score) score = s
  }
  return score
}

/**
 * Score a single module's health using only evidenced signals. Cycles and
 * hard rule violations dominate; unresolved imports, coupling outliers and
 * orphan modules reduce the score until addressed.
 */
export function moduleHealth(
  graph: DepGraph,
  moduleRel: string,
  violations: Violation[],
  config: ArchitectureConfig = {},
): ModuleHealth | null {
  const node = [...graph.nodes.values()].find((n) => n.relativePath === moduleRel)
  if (!node) return null

  const ofModule = violations.filter(
    (v) => v.source === node.relativePath || v.source === node.path,
  )
  const metrics = moduleMetrics(graph).get(node.path)!
  const cycles = ofModule.filter((v) => v.type === 'circular_dependency')
  const unresolved = ofModule.filter((v) => v.type === 'unresolved_import')
  const coupling = ofModule.filter((v) => v.type === 'god_module' || v.type === 'excessive_coupling')
  const ruleBreaks = ofModule.filter((v) =>
    ['import_direction', 'forbidden_import', 'package_boundary_violation', 'abstraction_leakage', 'dependency_inversion'].includes(v.type),
  )
  const orphan = ofModule.filter((v) => v.type === 'orphan_module')
  const depth = ofModule.filter((v) => v.type === 'deep_dependency_chain')

  const factors: HealthFactor[] = [
    {
      name: 'cycles',
      score: worstOf(cycles, CYCLIC_SEVERITY_SCORE, 1),
      weight: FACTOR_WEIGHTS.cycles,
      detail: cycles.length > 0 ? `${cycles.length} cycle violation(s)` : 'no cycles',
    },
    {
      name: 'unresolved',
      score: worstOf(unresolved, UNRESOLVED_SEVERITY_SCORE, 1),
      weight: FACTOR_WEIGHTS.unresolved,
      detail: unresolved.length > 0 ? `${unresolved.length} unresolved import(s)` : 'all imports resolve',
    },
    {
      name: 'coupling',
      score: worstOf(coupling, CYCLIC_SEVERITY_SCORE, 1),
      weight: FACTOR_WEIGHTS.coupling,
      detail:
        coupling.length > 0
          ? `fan-in ${metrics.fanIn}, fan-out ${metrics.fanOut} (outlier)`
          : `fan-in ${metrics.fanIn}, fan-out ${metrics.fanOut}`,
    },
    {
      name: 'rules',
      score: worstOf(ruleBreaks, RULE_SEVERITY_SCORE, 1),
      weight: FACTOR_WEIGHTS.rules,
      detail: ruleBreaks.length > 0 ? `${ruleBreaks.length} rule violation(s)` : 'no rule violations',
    },
    {
      name: 'orphan',
      score: worstOf(orphan, CYCLIC_SEVERITY_SCORE, 1),
      weight: FACTOR_WEIGHTS.orphan,
      detail: orphan.length > 0 ? 'module is orphaned' : 'module is connected',
    },
  ]
  if (depth.length > 0) {
    factors.push({
      name: 'depth',
      score: 0.8,
      weight: FACTOR_WEIGHTS.depth,
      detail: 'module sits on a deep dependency chain',
    })
  } else {
    factors.push({ name: 'depth', score: 1, weight: FACTOR_WEIGHTS.depth, detail: 'chain depth within limits' })
  }

  let score = 0
  let totalWeight = 0
  for (const f of factors) {
    // Only the worst cycle engages weight once; that's fine as weights sum to 1.
    score += f.score * f.weight
    totalWeight += f.weight
  }
  const final = Math.round((score / totalWeight) * 100) / 100

  const sorted = [...factors].sort((a, b) => b.weight - a.weight)

  return {
    module: node.relativePath,
    score: final,
    level: final >= 0.85 ? 'good' : final >= 0.6 ? 'fair' : 'poor',
    factors: sorted,
  }
}

export interface HealthDistribution {
  evaluated: number
  good: number
  fair: number
  poor: number
  average: number
}

export interface RepoHealth {
  distribution: HealthDistribution
  /** Modules ordered by score ascending (worst first). */
  ranked: ModuleHealth[]
  /** The single lowest-scoring module, if any were scored. */
  worstModule: ModuleHealth | null
}

/** Score every module and rank them, worst first, deterministically. */
export function repoHealth(
  graph: DepGraph,
  violations: Violation[],
  config: ArchitectureConfig = {},
  limit = 1000,
): RepoHealth {
  const modules = sortedModules(graph)
    .slice(0, limit)
    .map((n) => n.relativePath)
  const scored = modules
    .map((m) => moduleHealth(graph, m, violations, config))
    .filter((h): h is ModuleHealth => h !== null)
    .sort((a, b) => a.score - b.score || (a.module < b.module ? -1 : 1))

  const distribution: HealthDistribution = { evaluated: scored.length, good: 0, fair: 0, poor: 0, average: 0 }
  let total = 0
  for (const h of scored) {
    distribution[h.level]++
    total += h.score
  }
  if (scored.length > 0) distribution.average = Math.round((total / scored.length) * 100) / 100

  return { distribution, ranked: scored, worstModule: scored[0] ?? null }
}

// ---------------------------------------------------------------------------
// Hotspots
// ---------------------------------------------------------------------------

export interface Hotspot {
  module: string
  /** Higher = more risk signals overlap. Scaled to 0-100. */
  score: number
  /** Fan-in from module metrics. */
  fanIn: number
  fanOut: number
  /** Number of violations touching this module. */
  violationCount: number
  /** Dominant severity of the violations. */
  severity: string
  /** Optionally provided recent-commit activity (from git analysis). */
  changes: number
}

/**
 * Rank change hotspots: modules where structural risk (fan-in as blast
 * radius) overlaps with rule violations and/or recent churn. `changeRates`
 * maps a module-relative path to its frequency in recent git history; when
 * absent the module scores on structure alone.
 */
export function hotspots(
  graph: DepGraph,
  violations: Violation[],
  changeRates: Record<string, number> = {},
  limit = 20,
): Hotspot[] {
  const metrics = moduleMetrics(graph)
  const byModule = new Map<string, Violation[]>()
  for (const v of violations) {
    const list = byModule.get(v.source) ?? []
    list.push(v)
    byModule.set(v.source, list)
  }

  const severities = ['info', 'warning', 'error', 'critical'] as const
  const severityWeight: Record<string, number> = { info: 0.2, warning: 0.5, error: 0.8, critical: 1 }
  const fanInMax = Math.max(1, ...[...metrics.values()].map((m: ModuleMetrics) => m.fanIn))
  const changeMax = Math.max(1, ...Object.values(changeRates))

  const out: Hotspot[] = []
  for (const node of sortedModules(graph)) {
    const m = metrics.get(node.path)!
    const vios = byModule.get(node.relativePath) ?? byModule.get(node.path) ?? []
    let severity = 'info'
    for (const s of severities) if (vios.some((v) => v.severity === s)) severity = s
    const changes = changeRates[node.relativePath] ?? 0
    // Ranges sum to <= 100: fan-in (45) + violations (30) + churn (25).
    const score = Math.min(
      100,
      Math.round(45 * (Math.log1p(m.fanIn) / Math.log1p(fanInMax)) +
        30 * Math.min(1, vios.length / 3) * (severityWeight[severity] ?? 0.5) +
        25 * (Math.log1p(changes) / Math.log1p(changeMax))),
    )
    out.push({
      module: node.relativePath,
      score,
      fanIn: m.fanIn,
      fanOut: m.fanOut,
      violationCount: vios.length,
      severity,
      changes,
    })
  }
  return out.sort((a, b) => b.score - a.score || (a.module < b.module ? -1 : 1)).slice(0, limit)
}

/** Human-readable one-sentence status for a health score. */
export function healthSummary(level: HealthLevel): string {
  switch (level) {
    case 'good':
      return 'healthy — no structural risk signals detected'
    case 'fair':
      return 'acceptable but warrants attention — address the listed factors'
    case 'poor':
      return 'at risk — the contributing factors below should be addressed before further changes'
  }
}

/** Re-exported for the report generator. */
export type { ViolationType }
export { detectCycles }