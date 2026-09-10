// Architecture report: one deterministic, read-only snapshot of a project's
// structure, health, drift, and repair guidance.
//
// `buildReport` assembles everything the engine can say about a project into a
// single structured object; the tool layer renders it via `formatReport`.
// Nothing in this module writes to disk or mutates source — repair *plans* are
// produced (for the human and the explicit patch path) but never applied here.

import { joinPath, normalizePath, openProject, parseProject } from './parser.ts'
import type { ParserOptions, Violation } from './types.ts'
import { buildGraph, graphStats, type DepGraph } from './graph.ts'
import { loadArchitectureConfig, type ArchitectureConfig, type LoadedConfig } from './config.ts'
import { detectViolations } from './violations.ts'
import { explainViolation } from './explain.ts'
import { repoHealth, hotspots, healthSummary, type Hotspot, type RepoHealth } from './analysis.ts'
import {
  baselineDiff,
  churnRates,
  detectGitFacts,
  driftSince,
  evidenceKindFor,
  loadBaseline,
  type BaselineDiff,
  type DriftReport,
  type GitFacts,
} from './git.ts'
import { generateRepairPlans, type RepairSet } from './repair.ts'

export interface ArchReportOptions {
  /** Absolute posix-normalized project root. */
  projectRoot: string
  /** Absolute path of tsconfig.json (default `<projectRoot>/tsconfig.json`). */
  tsconfigPath?: string
  includeTests?: boolean
  maxFiles?: number
  /** Explicit architecture config file; when absent, discovery is used. */
  configPath?: string
  /** Git revision to measure drift since (e.g. `HEAD~5`). */
  base?: string
  /** Baseline snapshot file name inside the project root. */
  baselineFile?: string
}

export interface ArchReport {
  projectRoot: string
  tsconfigPath: string
  configSource: string
  config: ArchitectureConfig
  truncated: boolean
  moduleCount: number
  edges: { internal: number; boundary: number; external: number; unresolved: number }
  cycles: number
  layers: Record<string, string[]>
  violations: Violation[]
  /** Fact vs inference split, so readers never mistake inference for fact. */
  evidence: { facts: number; inferences: number }
  health: RepoHealth
  hotspots: Hotspot[]
  git: GitFacts
  drift: DriftReport | null
  baseline: BaselineDiff | null
  baselineFile: string | null
  repairs: RepairSet
  summary: string
}

const SEVERITY_ORDER: Record<string, number> = { critical: 0, error: 1, warning: 2, info: 3 }

function sortViolations(v: Violation[]): Violation[] {
  return [...v].sort((a, b) => {
    const sa = SEVERITY_ORDER[a.severity] ?? 9
    const sb = SEVERITY_ORDER[b.severity] ?? 9
    if (sa !== sb) return sa - sb
    const key = (x: Violation) => `${x.type}|${x.source}|${x.target}|${x.specifier ?? ''}`
    return key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0
  })
}

function layerRollup(graph: DepGraph): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const node of graph.nodes.values()) {
    const layer = node.relativePath.split('/')[0] || 'root'
    ;(out[layer] ??= []).push(node.relativePath)
    out[layer]!.sort()
  }
  return Object.fromEntries(Object.keys(out).sort().map((k) => [k, out[k]!]))
}

/** Assemble the full architecture report. Never writes; never patches. */
export async function buildReport(options: ArchReportOptions): Promise<ArchReport> {
  const projectRoot = normalizePath(options.projectRoot)
  const tsconfigPath = normalizePath(options.tsconfigPath ?? joinPath(projectRoot, 'tsconfig.json'))
  const includeTests = options.includeTests === true
  const maxFiles = options.maxFiles && options.maxFiles > 0 ? Math.min(options.maxFiles, 5000) : 200

  const parserOptions: ParserOptions = { projectRoot, tsconfigPath, includeTests, maxFiles }
  const { api, snapshot, program } = openProject(parserOptions)
  try {
    const { files, truncated } = parseProject(program, parserOptions)
    const graph = buildGraph(files, parserOptions)
    const loaded: LoadedConfig = loadArchitectureConfig(projectRoot, options.configPath)
    const config = loaded.config
    const configSource = loaded.source.startsWith(projectRoot)
      ? loaded.source.slice(projectRoot.length + 1)
      : loaded.source

    const detected = detectViolations(graph, config)
    const violations = sortViolations(
      detected.violations.map((v) => ({ ...v, why: explainViolation(v).why })),
    )
    const facts = violations.filter((v) => evidenceKindFor(v) === 'fact').length
    const inferences = violations.length - facts

    const health = repoHealth(graph, violations, config)
    const git: GitFacts = await detectGitFacts(projectRoot, graph)
    const changeRates = git.detected ? churnRates(git) : {}
    const hot = hotspots(graph, violations, changeRates)

    const drift: DriftReport | null = options.base
      ? await driftSince(projectRoot, options.base, graph)
      : null
    const baselineFile = options.baselineFile
    let baseline: BaselineDiff | null = null
    if (baselineFile) {
      const snap = loadBaseline(projectRoot, baselineFile)
      if (snap) baseline = baselineDiff(violations, snap)
    }

    const repairs = generateRepairPlans(graph, violations, config)
    const stats = graphStats(graph)
    const cycles = graph.edges.length > 0 ? [...new Set(detected.violations.filter((v) => v.type === 'circular_dependency').map((v) => v.source))].length : 0

    const avg = health.distribution.average
    const summaryParts: string[] = [
      `${graph.nodes.size} modules, ${stats.edgeCount} internal edges, ${violations.length} violation(s), ${Math.round(avg * 100)}/100 average health`,
    ]
    if (git.detected) summaryParts.push(`git: ${git.branch || '(detached)'}${git.dirty ? ', dirty' : ''}`)
    if (drift && drift.changedModules.length > 0) summaryParts.push(`${drift.changedModules.length} module(s) changed since ${options.base}`)

    return {
      projectRoot,
      tsconfigPath,
      configSource,
      config,
      truncated,
      moduleCount: graph.nodes.size,
      edges: {
        internal: stats.edgeCount,
        boundary: stats.boundaryCount,
        external: stats.externalCount,
        unresolved: stats.unresolvedCount,
      },
      cycles,
      layers: layerRollup(graph),
      violations,
      evidence: { facts, inferences },
      health,
      hotspots: hot,
      git,
      drift,
      baseline,
      baselineFile: baseline ? baselineFile ?? null : null,
      repairs,
      summary: summaryParts.join(' · '),
    }
  } finally {
    snapshot.dispose()
    api.close()
  }
}

/** Render an {@link ArchReport} as deterministic, readable text. */
export function formatReport(report: ArchReport): string {
  const lines: string[] = []
  lines.push('=== Architecture Report ===')
  lines.push(`Project: ${report.projectRoot}`)
  if (report.configSource) lines.push(`Config: ${report.configSource}`)
  lines.push(report.summary)
  if (report.truncated) lines.push('Note: file limit reached; results are over the analyzed subset, not the whole tree.')

  const h = report.health
  lines.push(formatSection('Health'))
  lines.push(`  average ${Math.round(h.distribution.average * 100)}/100 · ${h.distribution.good} good, ${h.distribution.fair} fair, ${h.distribution.poor} poor (${h.distribution.evaluated} scored)`)
  if (h.worstModule) {
    lines.push(`  worst: ${h.worstModule.module} (${h.worstModule.level}) — ${healthSummary(h.worstModule.level)}`)
    for (const factor of h.worstModule.factors) {
      lines.push(`    · ${factor.name}: ${Math.round(factor.score * 100)}/100 — ${factor.detail}`)
    }
  }

  const v = report.violations
  lines.push(formatSection(`Violations (${v.length})`))
  if (v.length === 0) {
    lines.push('  No architectural violations detected.')
  } else {
    lines.push(`  ${report.evidence.facts} verified fact(s), ${report.evidence.inferences} inference(s)`)
    for (const item of v) {
      const route = item.target ? `${item.source} -> ${item.target}` : item.source
      const spec = item.specifier ? ` via "${item.specifier}"` : ''
      const line = item.line !== undefined ? `:${item.line}` : ''
      lines.push(`  [${item.severity}] ${item.type}: ${route}${spec}${line}`)
      if (item.why) lines.push(`    ${item.why}`)
      if (item.suggestion) lines.push(`    fix: ${item.suggestion}`)
    }
  }

  if (report.hotspots.length > 0) {
    lines.push(`${formatSection('Hotspots')}`)
    for (const spot of report.hotspots.slice(0, 10)) {
      lines.push(`  ${spot.module}: score ${spot.score} (fan-in ${spot.fanIn}, fan-out ${spot.fanOut}, violations ${spot.violationCount}${spot.changes > 0 ? `, churn ${spot.changes}` : ''})`)
    }
  }

  const r = report.repairs
  const resolvable = r.plans.filter((p) => p.resolution === 'resolvable')
  lines.push(`${formatSection(`Repair guidance (${resolvable.length} mechanical, ${r.manual.length} manual)`)}`)
  for (const plan of resolvable) {
    lines.push(`  [${plan.resolution}${plan.namesVerified ? '' : ', verify exports'}] ${plan.summary}`)
    for (const a of plan.actions) lines.push(`    ${a.file}:${a.line} ${a.oldSpecifier} -> ${a.newSpecifier}`)
  }
  for (const m of r.manual.slice(0, 5)) {
    lines.push(`  [manual] ${m.type} ${m.source} — ${m.suggestion}`)
  }

  const g = report.git
  if (g.detected) {
    lines.push(`${formatSection('Git')}`)
    lines.push(`  branch ${g.branch || '(detached)'} · HEAD ${g.head?.shortHash ?? 'n/a'} · ${g.dirty ? 'working tree dirty' : 'working tree clean'}`)
    const churned = [...g.files].sort((a, b) => b.churn - a.churn).slice(0, 5).filter((f) => f.churn > 0)
    if (churned.length > 0) {
      lines.push(`  most churned: ${churned.map((f) => `${f.module} (${f.churn})`).join(', ')}`)
    }
  }

  if (report.drift) {
    lines.push(`${formatSection('Drift')}`)
    lines.push(`  base ${report.drift.baseSha ?? 'unresolved'} · ${report.drift.changedFiles.length} file(s) changed, ${report.drift.changedModules.length} in analyzed modules`)
    for (const m of report.drift.changedModules) lines.push(`    ${m}`)
  }

  if (report.baseline) {
    const b = report.baseline
    lines.push(`${formatSection('Baseline')}`)
    lines.push(`  ${b.newlyAppeared.length} new, ${b.resolved.length} resolved, ${b.stillPresent.length} still present`)
  }

  lines.push('')
  lines.push('Read-only analysis: no files were modified.')
  return lines.join('\n')
}

function formatSection(title: string): string {
  return `--- ${title} ---`
}