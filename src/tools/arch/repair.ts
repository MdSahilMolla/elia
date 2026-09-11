// Minimal, behavior-preserving repair planning for architecture violations.
//
// The engine never edits the working tree unless the caller explicitly invokes
// {@link applyRepairPlans} (a separate entry from the read-only report path,
// gated by the tool's own approval flow). Plans are generated as candidates,
// simulated against a remapped copy of the graph, and only a plan whose
// simulation actually removes the violation is marked `resolvable`.

import { readFileSync, writeFileSync } from 'node:fs'
import type { ImportEdge, ModuleNode, Violation } from './types.ts'
import type { DepGraph } from './graph.ts'
import { detectViolations } from './violations.ts'
import type { ArchitectureConfig, LayerDef, PackageDef } from './config.ts'
import { matchesAny } from './config.ts'
import { violationKey } from './git.ts'

export type PlanResolution = 'resolvable' | 'manual' | 'unsupported'

export interface RepairAction {
  /** Project-relative file to edit. */
  file: string
  /** 1-based line containing the import to retarget. */
  line: number
  /** Original specifier as written (e.g. `../impl`). */
  oldSpecifier: string
  /** Replacement specifier (e.g. `../contracts`). */
  newSpecifier: string
  kind: 'retarget'
  /** Note on what the edit changes and what must still be verified. */
  note: string
}

export interface RepairPlan {
  /** Stable key of the violation being repaired. */
  violation: string
  /** Human-readable summary of the intended change. */
  summary: string
  resolution: PlanResolution
  actions: RepairAction[]
  /** Residual violation count after simulating the plan on a graph copy. */
  residualCount: number
  /** True when a graph-level simulation backed the decision. */
  simulated: boolean
  /** Verification that the replacement module exports the imported names. */
  namesVerified: boolean
}

export interface RepairSet {
  plans: RepairPlan[]
  /** Violations the engine has no mechanical plan for (still described). */
  manual: Violation[]
}

export interface SpecifierRemap {
  file: string
  oldSpecifier: string
  oldTarget: string
  newTarget: string
  newSpecifier: string
  line: number
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

function findEdge(graph: DepGraph, sourceRelOrPath: string, targetRelOrPath: string): ImportEdge | null {
  const src = findPath(graph, sourceRelOrPath)
  const tgt = findPath(graph, targetRelOrPath)
  if (!src || !tgt) return null
  return graph.nodes.get(src)?.imports.find((e) => e.target === tgt) ?? null
}

function findPath(graph: DepGraph, relOrAbs: string): string | null {
  if (graph.nodes.has(relOrAbs)) return relOrAbs
  for (const n of graph.nodes.values()) if (n.relativePath === relOrAbs) return n.path
  return null
}

function targetPath(graph: DepGraph, rel: string): string {
  return `${graph.projectRoot}/${rel.replace(/^\.?\//, '')}`
}

function relOf(graph: DepGraph, path: string): string {
  return graph.nodes.get(path)?.relativePath ?? path
}

/** Compute a relative specifier from `edge.source`'s directory to `targetRel`. */
function specifierFor(graph: DepGraph, edge: ImportEdge, targetRel: string): string {
  const file = targetRel.replace(/\.(ts|tsx|mts|cts)$/, '')
  const fromDir = relOf(graph, edge.source).split('/').slice(0, -1)
  const toParts = file.split('/')
  let common = 0
  while (common < fromDir.length && common < toParts.length && fromDir[common] === toParts[common]) common++
  const ups = fromDir.length - common
  const folder = toParts.slice(common)
  const spec = `${ups > 0 ? '../'.repeat(ups) : ''}${folder.join('/')}`
  return spec.startsWith('.') ? spec : `./${spec}`
}

/** Names the imports of one edge actually bring in ([] for `import * as`/dynamic). */
function requiredNames(edge: ImportEdge): string[] {
  return edge.names
}

/** True when a module's exports cover the required names (`export *` is assumed to). */
function exportsCover(node: ModuleNode, required: string[]): boolean {
  if (required.length === 0) return true
  if (node.exports.some((e) => e.kind === 'star' || e.kind === 'export-assign')) return true
  const exported = new Set<string>()
  for (const e of node.exports) for (const n of e.names) exported.add(n)
  return required.every((n) => exported.has(n))
}

/** True when editing this directory existed in-phase would be unsafe to auto-apply. */
interface Candidate {
  newSpecifier: string
  newTargetRel: string
  note: string
  namesVerified: boolean
}

function candidateInversion(graph: DepGraph, v: Violation, config: ArchitectureConfig): Candidate | null {
  const pair = config.dependencyInversion?.find((p) => matchesAny(v.target, [p.implementation]))
  if (!pair) return null
  if (matchesAny(v.target, [pair.interface])) return null
  const intf = [...graph.nodes.values()].find((n) => matchesAny(n.relativePath, [pair.interface]))
  if (!intf) return null
  const edge = findEdge(graph, v.source, v.target)
  const names = edge ? requiredNames(edge) : []
  return {
    newSpecifier: edge ? specifierFor(graph, edge, intf.relativePath) : `./${intf.relativePath.split('/').pop()}`,
    newTargetRel: intf.relativePath,
    note: `Depend on the declared interface ${pair.interface} instead of the concrete implementation.`,
    namesVerified: exportsCover(intf, names),
  }
}

function candidatePublicEntry(graph: DepGraph, v: Violation, config: ArchitectureConfig): Candidate | null {
  const layerDef: LayerDef | undefined = config.layers?.find((l) => matchesAny(v.target, l.include))
  const pkgDef: PackageDef | undefined = config.packages?.find((p) => matchesAny(v.target, p.include))
  const def = layerDef ?? pkgDef
  if (!def || !def.publicApi || def.publicApi.length !== 1) return null
  const entry = def.publicApi[0]!
  const entryNode = [...graph.nodes.values()].find((n) => n.relativePath === entry)
  if (!entryNode) return null
  const edge = findEdge(graph, v.source, v.target)
  const names = edge ? requiredNames(edge) : []
  return {
    newSpecifier: edge ? specifierFor(graph, edge, entryNode.relativePath) : `./${entry}`,
    newTargetRel: entryNode.relativePath,
    note: `Route the import through ${def.name}’s public entry (${entry}) instead of its internals.`,
    namesVerified: exportsCover(entryNode, names),
  }
}

/** Produce a plan for one violation, or null when nothing mechanical is known. */
export function planForViolation(graph: DepGraph, v: Violation, config: ArchitectureConfig): RepairPlan | null {
  if (!v.target || v.target.length === 0) return null
  const edge = findEdge(graph, v.source, v.target)
  if (!edge) return null

  let candidate: Candidate | null = null
  if (v.type === 'dependency_inversion') candidate = candidateInversion(graph, v, config)
  else if (v.type === 'package_boundary_violation' || v.type === 'abstraction_leakage') {
    candidate = candidatePublicEntry(graph, v, config)
  }
  if (!candidate) return null

  const remap: SpecifierRemap = {
    file: edge.source,
    oldSpecifier: edge.specifier,
    oldTarget: edge.target,
    newTarget: targetPath(graph, candidate.newTargetRel),
    newSpecifier: candidate.newSpecifier,
    line: edge.line,
  }
  const residual = detectViolations(simulateRemap(graph, [remap]), config)
  const stillViolates = residual.violations.some((rv) => violationKey(rv) === violationKey(v))

  return {
    violation: violationKey(v),
    summary: `${v.type}: ${relOf(graph, edge.source)} -> ${candidate.newTargetRel} (${edge.specifier})`,
    resolution: stillViolates ? 'manual' : 'resolvable',
    actions: [
      {
        file: relOf(graph, edge.source),
        line: edge.line,
        oldSpecifier: edge.specifier,
        newSpecifier: candidate.newSpecifier,
        kind: 'retarget',
        note: candidate.note,
      },
    ],
    residualCount: residual.violations.length,
    simulated: true,
    namesVerified: candidate.namesVerified,
  }
}

/** Generate repair candidates for a set of violations; read-only. */
export function generateRepairPlans(graph: DepGraph, violations: Violation[], config: ArchitectureConfig): RepairSet {
  const plans: RepairPlan[] = []
  const manual: Violation[] = []
  for (const v of violations) {
    const plan = planForViolation(graph, v, config)
    if (plan) plans.push(plan)
    else manual.push(v)
  }
  return { plans, manual }
}

// ---------------------------------------------------------------------------
// Simulation + application
// ---------------------------------------------------------------------------

/**
 * Copy the graph, retargeting the described edges. Only the graph is touched —
 * nothing reads or writes source files, so simulation is always safe to run.
 */
export function simulateRemap(graph: DepGraph, remaps: SpecifierRemap[]): DepGraph {
  const known = new Set(graph.nodes.keys())
  const nodes = new Map<string, ModuleNode>()
  for (const [path, node] of graph.nodes) {
    nodes.set(path, { ...node, imports: node.imports.map((e) => {
      const hit = remaps.find((r) => r.file === e.source && r.oldSpecifier === e.specifier && r.oldTarget === e.target && r.line === e.line)
      if (!hit) return e
      const inProject = hit.newTarget.startsWith(graph.projectRoot + '/')
      const targetInNodes = known.has(hit.newTarget)
      return {
        ...e,
        target: hit.newTarget,
        specifier: hit.newSpecifier,
        resolved: targetInNodes,
        external: !targetInNodes && !inProject,
        unresolved: !targetInNodes && inProject,
      }
    }) })
  }
  const edges: ImportEdge[] = []
  const boundaryEdges: ImportEdge[] = []
  const externalEdges: ImportEdge[] = []
  for (const node of nodes.values()) {
    for (const e of node.imports) {
      if (e.external || e.unresolved) externalEdges.push(e)
      else if (nodes.has(e.target)) edges.push(e)
      else boundaryEdges.push(e)
    }
  }
  return { nodes, edges, boundaryEdges, externalEdges, projectRoot: graph.projectRoot }
}

export interface ApplyResult {
  applied: string[]
  actions: RepairAction[]
}

/**
 * Apply repair plans by rewriting the targeted import lines on disk.
 *
 * This WRITES files; only the explicit patch entry point may call it, never
 * the default read-only report path. Each edit is minimal and
 * behavior-preserving: only the quoted specifier token changes on the line.
 */
export function applyRepairPlans(projectRoot: string, plans: RepairPlan[]): ApplyResult {
  const applied: string[] = []
  const actions: RepairAction[] = []
  for (const plan of plans) {
    if (plan.resolution !== 'resolvable') continue
    for (const action of plan.actions) {
      const file = joinPath(projectRoot, action.file)
      const lines = readFileSync(file, 'utf8').split('\n')
      const idx = action.line - 1
      if (idx < 0 || idx >= lines.length) continue
      const after = replaceSpecifierInLine(lines[idx]!, action.oldSpecifier, action.newSpecifier)
      if (after === lines[idx]) continue
      lines[idx] = after
      writeFileSync(file, lines.join('\n'), 'utf8')
      applied.push(action.file)
      actions.push(action)
    }
  }
  return { applied: [...new Set(applied)], actions }
}

/** Replace only the quoted specifier token (`'x'` or `"x"`) on an import line. */
export function replaceSpecifierInLine(line: string, oldSpec: string, newSpec: string): string {
  for (const quote of ["'", '"']) {
    const needle = `${quote}${oldSpec}${quote}`
    if (!line.includes(needle)) continue
    return line.replace(needle, `${quote}${newSpec}${quote}`)
  }
  return line
}

/** Posix join that tolerates both separators in the root. */
function joinPath(root: string, rel: string): string {
  return `${root.replace(/\\/g, '/').replace(/\/+$/, '')}/${rel}`
}