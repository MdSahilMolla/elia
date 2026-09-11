import type { Tool } from './types.ts'
import { optionalString } from './args.ts'
import { resolveWorkspacePath } from '../autonomy/context.ts'
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildChangeModel, type ChangeKind, type ChangeModel, type ChangedFile } from './intel/change.ts'
import { indexCodebase, importersOf, findFile, type CodebaseModel } from './intel/codebase.ts'
import { assessRisk, combineRisks, type RiskModel, type RiskDimension } from './intel/risk.ts'
import { makeEvidence, combineEvidence, type Evidence } from './intel/evidence.ts'

const MAX_FILES_ANALYZED = 100
const PROJECT_INDEX_CACHE = '.elia/intel-codebase.json'

export interface ImpactFileResult {
  file: string
  changeType: ChangeKind
  downstreamFiles: string[]
  testsAffected: string[]
  fileRisk: RiskModel
  riskReason: string
  evidence: Evidence[]
}

export interface ImpactAnalysis {
  changedFiles: ImpactFileResult[]
  totalDownstreamFiles: number
  totalTestsAffected: number
  overallRisk: RiskModel
  summary: string
  recommendations: string[]
  evidence: Evidence[]
  cached: boolean
}

interface FileSurface {
  isTest: boolean
  isSecuritySurface: boolean
  isConfigOrSchema: boolean
  isDependencyManifest: boolean
  lineCount: number
  downstream: string[]
  tests: string[]
}

function surfaceOf(file: ChangedFile, codebase: CodebaseModel | undefined): FileSurface {
  let lineCount = 0
  if (codebase) {
    const indexed = findFile(codebase, file.path)
    lineCount = indexed?.lineCount ?? 0
  }
  return {
    isTest: file.isTest,
    isSecuritySurface: file.isSecuritySurface,
    isConfigOrSchema: file.isConfigOrSchema,
    isDependencyManifest: file.isDependencyManifest,
    lineCount,
    downstream: codebase ? importersOf(codebase, file.path) : [],
    tests: testFilesFor(file.path, codebase),
  }
}

function testFilesFor(path: string, codebase: CodebaseModel | undefined): string[] {
  if (!codebase) return []
  const baseName = path.replace(/\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/i, '')
  const stem = baseName.split('/').pop()!
  const same = codebase.testFiles.filter((t) => t === `${baseName}.test.ts`)
  const importers = importersOf(codebase, path)
  const directTests = importers.filter((p) => codebase.testFiles.includes(p) && p !== `${baseName}.test.ts`)
  const viaStem = codebase.testFiles.filter((t) => stem.length > 1 && t !== `${baseName}.test.ts` && t.includes(stem))
  return [...new Set([...same, ...directTests, ...viaStem])].slice(0, 20)
}

/** Deterministic per-file risk scoring without shell or network access. */
export function assessFileRisk(file: ChangedFile, surface: FileSurface): { risk: RiskModel; reason: string; evidence: Evidence[] } {
  const path = file.path
  const gitEvidence = makeEvidence({
    kind: 'git_commit',
    description: `File ${file.kind}: ${path} (${file.additions}+/${file.deletions}-)`,
    location: path,
    reproducible: true,
  })

  if (file.kind === 'deleted') {
    const risk = assessRisk([
      { name: 'severity', weight: 1, score: 80, description: 'Deleting a file breaks every remaining importer.' },
      { name: 'affected_surface', weight: 1, score: Math.min(100, surface.downstream.length * 10 + 30), description: `${surface.downstream.length} importer(s) known in the index.` },
    ], { confidence: 0.9, confidenceSource: 'git name-status + codebase index' })
    return {
      risk,
      reason: `File deletion may break ${surface.downstream.length} importer(s)`,
      evidence: [gitEvidence, makeEvidence({ kind: 'source_location', description: 'Deleted path', location: path })],
    }
  }

  if (file.kind === 'renamed' || file.kind === 'copied') {
    const risk = assessRisk([
      { name: 'severity', weight: 1, score: 55, description: 'Rename/copy requires updating every importer of the old path.' },
      { name: 'affected_surface', weight: 1, score: Math.min(100, surface.downstream.length * 8 + 20), description: `${surface.downstream.length} importer(s) known in the index.` },
    ], { confidence: 0.85, confidenceSource: 'git name-status -M' })
    return { risk, reason: 'File rename requires updating all importers', evidence: [gitEvidence] }
  }

  const dimensions: RiskDimension[] = []
  const evidence: Evidence[] = [gitEvidence]

  if (file.isSecuritySurface) {
    dimensions.push({ name: 'severity', weight: 0.25, score: 85, description: 'File is part of the security surface (auth/token/secret/validation).' })
    evidence.push(makeEvidence({ kind: 'static_scan', description: 'Path matched security surface', location: path }))
  }
  if (/\.(sql|prisma)$|(^|[/\\])(migrations?|seed)([/\\]|$)/i.test(path)) {
    dimensions.push({ name: 'severity', weight: 0.25, score: 92, description: 'Schema/migration change — high reversibility cost in production.' })
    evidence.push(makeEvidence({ kind: 'static_scan', description: 'Schema or migration path', location: path }))
  }
  if (file.isConfigOrSchema) {
    dimensions.push({ name: 'severity', weight: 0.25, score: 60, description: 'Configuration change may affect behavior globally.' })
  }
  if (file.isDependencyManifest) {
    dimensions.push({ name: 'severity', weight: 0.25, score: 55, description: 'Dependency manifest change alters the dependency graph.' })
    dimensions.push({ name: 'production_criticality', weight: 0.05, score: 40, description: 'Supply-chain and reproducibility impact.' })
  }
  if (surface.lineCount > 500) {
    dimensions.push({ name: 'affected_surface', weight: 0.1, score: 45, description: `Large file (${surface.lineCount} lines) — high blast radius.` })
  }

  if (surface.downstream.length > 0) {
    dimensions.push({ name: 'affected_surface', weight: 0.1, score: Math.min(80, surface.downstream.length * 12), description: `${surface.downstream.length} importer(s).` })
  }
  if (file.symbols.length > 0) {
    const sig = file.symbols.filter((s) => s.change === 'signature').length
    dimensionizeSymbols(dimensions, file.symbols)
    if (sig > 0) {
      evidence.push(makeEvidence({ kind: 'ast_relationship', description: `${sig} exported signature(s) changed`, location: path }))
    }
  }
  if (surface.isTest) dimensions.push({ name: 'severity', weight: 0.25, score: 10, description: 'Test-only change.' })

  if (dimensions.length === 0) {
    dimensions.push({ name: 'severity', weight: 0.25, score: 20, description: 'Standard source file change.' })
  }

  const risk = assessRisk(dimensions, {
    confidence: combineEvidence(evidence).confidence,
    confidenceSource: 'blend of git diff facts and codebase index',
  })
  return { risk, reason: dimensions.map((d) => d.description).join('; '), evidence }
}

function dimensionizeSymbols(dimensions: RiskDimension[], symbols: ChangedFile['symbols']): void {
  const removed = symbols.filter((s) => s.change === 'removed').length
  const added = symbols.filter((s) => s.change === 'added').length
  if (removed > 0) dimensions.push({ name: 'impact', weight: 0.15, score: 55, description: `${removed} exported symbol(s) removed.` })
  if (added > 0) dimensions.push({ name: 'impact', weight: 0.15, score: 25, description: `${added} exported symbol(s) added.` })
}

/**
 * Predict the blast radius of a change. Deterministic and independent of shell:
 * feed it a {@link ChangeModel} (from `buildChangeModel`) and optionally a
 * {@link CodebaseModel} (from `indexCodebase`) to enrich downstream/test impact.
 */
export function analyzePredictiveImpact(change: ChangeModel, opts: { codebase?: CodebaseModel; maxFiles?: number; cached?: boolean } = {}): ImpactAnalysis {
  const maxFiles = Math.min(Math.max(opts.maxFiles ?? 30, 1), MAX_FILES_ANALYZED)
  const codebase = opts.codebase
  const files = change.files.slice(0, maxFiles)

  const results: ImpactFileResult[] = []
  let totalDownstream = 0
  let totalTests = 0
  const allEvidence: Evidence[] = []

  for (const cf of files) {
    const surface = surfaceOf(cf, codebase)
    const { risk, reason, evidence } = assessFileRisk(cf, surface)
    totalDownstream += surface.downstream.length
    totalTests += surface.tests.length
    allEvidence.push(...evidence)
    results.push({
      file: cf.path,
      changeType: cf.kind,
      downstreamFiles: surface.downstream.slice(0, 10),
      testsAffected: surface.tests.slice(0, 10),
      fileRisk: risk,
      riskReason: reason,
      evidence,
    })
  }

  const overallRisk = combineRisks(results.map((r) => r.fileRisk))
  const strongest = [...results].sort((a, b) => b.fileRisk.score - a.fileRisk.score)[0]

  const recommendations = buildRecommendations(results, totalDownstream, totalTests)

  const summary =
    `Analyzed ${results.length} changed file(s). ${totalDownstream} downstream file(s) and ${totalTests} test(s) may be affected. ` +
    `Overall risk ${overallRisk.score}/100 (${overallRisk.level.toUpperCase()}).` +
    (strongest ? ` Highest-risk file: ${strongest.file}.` : '')

  return {
    changedFiles: results,
    totalDownstreamFiles: totalDownstream,
    totalTestsAffected: totalTests,
    overallRisk,
    summary,
    recommendations,
    evidence: allEvidence,
    cached: opts.cached ?? false,
  }
}

function buildRecommendations(results: ImpactFileResult[], totalDownstream: number, totalTests: number): string[] {
  const recommendations: string[] = []
  if (results.some((n) => n.fileRisk.level === 'critical')) {
    recommendations.push('DO NOT commit without thorough review — critical risk detected')
  }
  if (totalTests > 0) recommendations.push(`Run ${totalTests} affected test(s) before committing`)
  if (totalDownstream > 5) recommendations.push(`High downstream impact (${totalDownstream} files) — consider smaller PRs`)
  const highRiskFiles = results
    .filter((n) => n.fileRisk.level === 'high' || n.fileRisk.level === 'critical')
    .map((n) => n.file)
  if (highRiskFiles.length > 0) recommendations.push(`Review high-risk files: ${highRiskFiles.join(', ')}`)
  if (results.some((n) => n.changeType === 'deleted')) recommendations.push('Deleted files detected — verify no remaining imports reference them')
  if (recommendations.length === 0) recommendations.push('Changes appear low-risk. Standard testing recommended.')
  return recommendations
}

/** Persist the codebase index alongside results so prediction is repeatable. */
export function persistCodebaseIndex(codebase: CodebaseModel, root: string): string {
  const file = join(root, PROJECT_INDEX_CACHE)
  const dir = join(root, '.elia')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(file, JSON.stringify(codebase, null, 2))
  return file
}

/** Read back a persisted codebase index. */
export function loadCodebaseIndex(root: string): CodebaseModel | undefined {
  const file = join(root, PROJECT_INDEX_CACHE)
  if (!existsSync(file)) return undefined
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as CodebaseModel
  } catch {
    return undefined
  }
}

export const predictiveImpactTool: Tool = {
  name: 'predictive_impact',
  description:
    'Predict the blast radius of code changes before they are committed. Analyzes which downstream files, modules, and tests will be affected, scores each changed file on deterministic risk dimensions, and provides actionable recommendations. Use with git diff, a specific commit, a file path, or the current working tree.',
  input_schema: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'Specific file to analyze impact for' },
      commit: { type: 'string', description: 'Commit hash to analyze' },
      maxFiles: { type: 'number', description: `Max changed files to analyze (1-${MAX_FILES_ANALYZED}, default 30)` },
    },
  },
  async execute(input) {
    const cwd = resolveWorkspacePath('.')
    const file = optionalString(input.file, 'file')
    const commit = optionalString(input.commit, 'commit')
    const maxFiles = Math.min(Math.max(typeof input.maxFiles === 'number' ? input.maxFiles : 30, 1), MAX_FILES_ANALYZED)

    const cachePath = join(cwd, PROJECT_INDEX_CACHE)
    const codebase = loadCodebaseIndex(cwd) ?? indexCodebase(cwd, { maxFiles: 5_000 })
    const cached = existsSync(cachePath)

    let change: ChangeModel
    if (commit) {
      change = await buildChangeModel({ cwd, base: `${commit}~1`, head: commit })
    } else {
      change = await buildChangeModel({ cwd })
    }

    if (file) {
      const target = change.files.find((f) => f.path === file)
      if (!target) {
        return `No change recorded for ${file} in the current working tree or HEAD context.`
      }
      change = { ...change, files: [target] }
    }

    if (change.files.length === 0) {
      return 'No changes detected. Ensure there are uncommitted changes or provide a valid commit hash.'
    }

    const analysis = analyzePredictiveImpact(change, { codebase, maxFiles, cached })
    return formatReport(analysis)
  },
}

function formatReport(report: ImpactAnalysis): string {
  const lines: string[] = []
  lines.push('=== Predictive Impact Analysis Report ===')
  lines.push(`Overall risk: ${report.overallRisk.level.toUpperCase()} (score: ${report.overallRisk.score}/100, confidence ${Math.round(report.overallRisk.confidence * 100)}%)`)
  lines.push(`Changed files: ${report.changedFiles.length}`)
  lines.push(`Downstream files affected: ${report.totalDownstreamFiles}`)
  lines.push(`Tests affected: ${report.totalTestsAffected}`)
  if (report.cached) lines.push('Note: prediction enriched from a persisted codebase index.')
  lines.push('')
  lines.push(report.summary)

  lines.push('')
  lines.push('--- Changed Files ---')
  for (const node of report.changedFiles) {
    const icon = node.fileRisk.level === 'critical' ? '!!!' : node.fileRisk.level === 'high' ? '!!' : node.fileRisk.level === 'medium' ? '!' : '-'
    lines.push(`  ${icon} [${node.changeType}] ${node.file} (${node.fileRisk.level}, ${node.fileRisk.score}/100)`)
    lines.push(`    Reason: ${node.riskReason}`)
    if (node.downstreamFiles.length > 0) lines.push(`    Downstream: ${node.downstreamFiles.join(', ')}`)
    if (node.testsAffected.length > 0) lines.push(`    Tests: ${node.testsAffected.join(', ')}`)
    lines.push('')
  }

  lines.push('--- Recommendations ---')
  for (const rec of report.recommendations) lines.push(`  * ${rec}`)

  lines.push('')
  lines.push('--- Supporting Evidence ---')
  for (const e of report.evidence.slice(0, 10)) {
    const where = e.location ? ` @${e.location}` : ''
    const source = e.source ? ` (${e.source})` : ''
    lines.push(`  [${e.kind}] ${e.description}${where}${source} conf=${Math.round(e.confidence * 100)}%`)
  }

  return lines.join('\n')
}