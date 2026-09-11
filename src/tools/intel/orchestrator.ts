// Orchestration/planning layer.
//
// Given a user request, failure, commit, or PR, decide the minimum set of
// lifecycle analyses that can answer the question reliably — never execute
// every tool blindly. Plans are deterministic: given a trigger, a change
// model, and historical-memory hits, the same inputs produce the same ordered
// step list with reasons, and the analyses the trigger makes unnecessary are
// named rather than silently dropped.

import type { ChangeModel } from './change.ts'
import type { Evidence } from './evidence.ts'
import type { RiskModel } from './risk.ts'

export type AnalysisTrigger =
  | 'commit'
  | 'working_tree'
  | 'pull_request'
  | 'production_failure'
  | 'recurring_incident'
  | 'architecture_review'
  | 'pre_ship'
  | 'security_review'
  | 'general'

export type ChangeNature = 'security' | 'architecture' | 'schema' | 'dependencies' | 'api' | 'general'

export type StepPriority = 'required' | 'recommended' | 'optional'

export interface AnalysisStep {
  tool: string
  reason: string
  priority: StepPriority
  inputs?: Record<string, unknown>
}

export interface AnalysisPlan {
  trigger: AnalysisTrigger
  nature: ChangeNature[]
  steps: AnalysisStep[]
  /** Analyses deliberately not run, with why. */
  unnecessary: string[]
  summary: string
}

export interface PlanContext {
  change?: ChangeModel
  /** Failed or suspicious file, for failure-driven triggers. */
  failureTarget?: { file: string; line?: number }
  /** Historical-memory titles relevant to this request (from codebase_memory). */
  memoryHits?: string[]
  /** True when the project already runs a regression suite. */
  hasRegressionTests?: boolean
}

const SECURITY_IMPORT_HINTS = [
  'jsonwebtoken',
  'bcrypt',
  'crypto',
  'jose',
  'passport',
  'oauth',
  'helmet',
  'cors',
  'sanitize-html',
  'validator',
  'xss',
  'csrf',
  'otp',
  'totp',
]

const PROCESS_HINTS = /\b(exec|spawn|child_process|eval|Function|innerHTML|dangerouslySetInnerHTML)\b/

/** Classify what a change touches, purely from the change model. */
export function identifyChangeNature(change: ChangeModel): ChangeNature[] {
  const found = new Set<ChangeNature>()
  const summary = change.summary

  if (summary.securitySurfacesChanged.length > 0) found.add('security')
  if (summary.dependencyManifestsChanged.length > 0) found.add('dependencies')
  if (summary.apiSurfacesChanged.length > 0) found.add('api')

  const schemaHits = summary.configOrSchemaChanged.filter(
    (p) => /\.(prisma|sql|graphql)$|(^|[/\\])(migrations?|seed)([/\\]|$)|schema/i.test(p),
  )
  if (schemaHits.length > 0) found.add('schema')

  for (const file of change.files) {
    if (file.isSecuritySurface) found.add('security')
    if (file.isConfigOrSchema) found.add('schema')
    for (const spec of file.importsChanged) {
      if (SECURITY_IMPORT_HINTS.some((hint) => spec.toLowerCase().includes(hint))) found.add('security')
    }
    for (const line of file.symbols) {
      if (line.change !== 'removed' && file.path.split('/').some((seg) => /auth|token|secret|login|session|permission|security/i.test(seg))) {
        found.add('security')
      }
    }
  }

  // Import-surface analysis counts imports/exports/symbol signatures towards
  // "architecture" only when the change is more than a one-line tweak.
  const touched = change.files.filter((f) => f.additions + f.deletions > 0)
  const signatureChanges = change.files.flatMap((f) => f.symbols.filter((s) => s.change === 'signature'))
  const importChangingFiles = change.files.filter((f) => f.importsChanged.length > 0).length
  if (signatureChanges.length > 0 || touched.length > 5 || importChangingFiles >= 3 || change.files.some((f) => f.kind === 'deleted' && f.path.startsWith('src/'))) {
    found.add('architecture')
  }

  if (found.size === 0) found.add('general')
  return [...found].sort()
}

const BASE_STEPS: Record<AnalysisTrigger, AnalysisStep[]> = {
  pre_ship: [
    { tool: 'predictive_impact', priority: 'required', reason: 'Every pre-ship change must estimate its blast radius.' },
    { tool: 'adversarial_verify', priority: 'required', reason: 'Pre-ship verification must attempt to break the change before it ships.' },
    { tool: 'spec_verify', priority: 'recommended', reason: 'Confirm the change satisfies the intended specification when one exists.' },
    { tool: 'multi_modal_review', priority: 'optional', reason: 'Broad engineering review for a change destined for production.' },
  ],
  security_review: [
    { tool: 'predictive_impact', priority: 'required', reason: 'A security review must know every surface the change touches.' },
    { tool: 'adversarial_verify', priority: 'required', reason: 'Adversarial verification is the core of a security review.' },
    { tool: 'spec_verify', priority: 'recommended', reason: 'Verify auth/validation behavior matches the intended contract.' },
    { tool: 'codebase_memory', priority: 'optional', reason: 'Past security bugs in this code should inform the review.' },
  ],
  architecture_review: [
    { tool: 'predictive_impact', priority: 'required', reason: 'Impact of a structural change must be bounded before it lands.' },
    { tool: 'arch_drift', priority: 'required', reason: 'The core question is whether the implementation respects the intended architecture.' },
    { tool: 'temporal_analysis', priority: 'recommended', reason: 'Structural trends show whether the change accelerates degradation.' },
    { tool: 'codebase_memory', priority: 'optional', reason: 'Recorded architecture decisions should be honoured.' },
  ],
  production_failure: [
    { tool: 'causal_debug', priority: 'required', reason: 'A production failure is a why-did-this-happen investigation.' },
    { tool: 'codebase_memory', priority: 'required', reason: 'Check whether this failure was seen and understood before.' },
    { tool: 'temporal_analysis', priority: 'recommended', reason: 'Was this in a trending problem area, or a fresh anomaly?' },
    { tool: 'predictive_impact', priority: 'recommended', reason: 'Bound what the failure and its fix affect in production.' },
    { tool: 'adversarial_verify', priority: 'optional', reason: 'Protect the surrounding code from the class of failure.' },
  ],
  recurring_incident: [
    { tool: 'causal_debug', priority: 'required', reason: 'Recurrence demands a root cause, not a patch.' },
    { tool: 'codebase_memory', priority: 'required', reason: 'Compare with previous incidents to find the pattern.' },
    { tool: 'self_healing_monitor', priority: 'recommended', reason: 'Horizon-scan for the systemic problem behind recurrence.' },
    { tool: 'arch_drift', priority: 'recommended', reason: 'Recurring incidents often hide architectural debt.' },
  ],
  commit: [
    { tool: 'predictive_impact', priority: 'required', reason: 'Every commit needs its blast radius estimated.' },
    { tool: 'spec_verify', priority: 'optional', reason: 'Check the commit against any governing specification.' },
  ],
  working_tree: [
    { tool: 'predictive_impact', priority: 'required', reason: 'Uncommitted work needs an impact estimate before it is committed.' },
    { tool: 'adversarial_verify', priority: 'recommended', reason: 'Attack the uncommitted change before it lands.' },
  ],
  pull_request: [
    { tool: 'predictive_impact', priority: 'required', reason: 'PR review starts with what the change affects.' },
    { tool: 'spec_verify', priority: 'recommended', reason: 'A PR should satisfy its intent.' },
    { tool: 'multi_modal_review', priority: 'optional', reason: 'Broad review makes sense at PR time.' },
  ],
  general: [
    { tool: 'predictive_impact', priority: 'recommended', reason: 'Default first analysis for a general request.' },
    { tool: 'codebase_memory', priority: 'optional', reason: 'Relevant lessons may already exist.' },
  ],
}

const NATURE_ADDITIONS: Record<ChangeNature, { tool: string; priority: StepPriority; reason: string; inputs?: Record<string, unknown> }[]> = {
  security: [
    { tool: 'adversarial_verify', priority: 'required', reason: 'The change touches a security surface.' },
    { tool: 'codebase_memory', priority: 'optional', reason: 'Mirror past security lessons against this change.' },
  ],
  architecture: [
    { tool: 'arch_drift', priority: 'required', reason: 'The change is structural enough to risk architectural drift.' },
    { tool: 'temporal_analysis', priority: 'recommended', reason: 'Check whether the structural change accelerates degradation.' },
  ],
  schema: [
    { tool: 'spec_verify', priority: 'recommended', reason: 'Schema/migration changes must satisfy the intended data contract.' },
    { tool: 'predictive_impact', priority: 'required', reason: 'Schema changes have wide blast radius.' },
  ],
  dependencies: [
    { tool: 'dependency_audit', priority: 'required', reason: 'Dependency changes bring new external risk.' },
  ],
  api: [
    { tool: 'spec_verify', priority: 'recommended', reason: 'API surface changes should be checked against their contract.' },
  ],
  general: [],
}

const UNNECESSARY_BY_TRIGGER: Record<AnalysisTrigger, string[]> = {
  commit: ['temporal_analysis', 'arch_drift'],
  working_tree: ['temporal_analysis', 'arch_drift'],
  pull_request: ['causal_debug'],
  production_failure: ['dependency_audit'],
  recurring_incident: ['dependency_audit'],
  architecture_review: ['adversarial_verify', 'dependency_audit'],
  pre_ship: ['causal_debug', 'arch_drift'],
  security_review: ['temporal_analysis', 'arch_drift'],
  general: [],
}

function isRequired(priority: StepPriority): boolean {
  return priority === 'required'
}

const UNREASONABLE = new Set(['causal_debug', 'arch_drift', 'temporal_analysis', 'dependency_audit', 'adversarial_verify', 'multi_modal_review', 'spec_verify', 'self_healing_monitor', 'cross_project_learn', 'federated_collab'])

/**
 * Plan the minimum analysis set for a trigger given the available context.
 * Reasoned and deterministic. Never runs every tool.
 */
export function planAnalysis(trigger: AnalysisTrigger, context: PlanContext = {}): AnalysisPlan {
  const nature = context.change ? identifyChangeNature(context.change) : []
  const steps: AnalysisStep[] = [...BASE_STEPS[trigger].map((s) => ({ ...s }))]

  if (context.change) {
    for (const n of nature) {
      if (n === 'general') continue
      for (const addition of NATURE_ADDITIONS[n] ?? []) {
        const existing = steps.find((s) => s.tool === addition.tool)
        if (existing) {
          if (isRequired(addition.priority)) existing.priority = 'required'
          existing.reason = `${existing.reason}; ${addition.reason}`
        } else {
          steps.push({ ...addition })
        }
      }
    }
  }

  if (context.memoryHits && context.memoryHits.length > 0 && !steps.some((s) => s.tool === 'codebase_memory')) {
    steps.push({ tool: 'codebase_memory', priority: 'recommended', reason: `${context.memoryHits.length} relevant lesson(s) exist in memory.` })
  }

  if (context.failureTarget) {
    const idx = steps.findIndex((s) => s.tool === 'causal_debug')
    if (idx >= 0) {
      steps[idx] = {
        ...steps[idx]!,
        inputs: { file: context.failureTarget.file, ...(context.failureTarget.line ? { line: context.failureTarget.line } : {}) },
      }
    } else {
      steps.push({ tool: 'causal_debug', priority: 'required', reason: 'A concrete failure target was provided.', inputs: { file: context.failureTarget.file, ...(context.failureTarget.line ? { line: context.failureTarget.line } : {}) } })
    }
  }

  const unnecessary = (UNNECESSARY_BY_TRIGGER[trigger] ?? []).filter((tool) => !steps.some((s) => s.tool === tool) && UNREASONABLE.has(tool))

  // Required-first ordering, stable by priority.
  const order: Record<StepPriority, number> = { required: 0, recommended: 1, optional: 2 }
  steps.sort((a, b) => order[a.priority] - order[b.priority])

  const summary =
    `${steps.length} analysis step(s) planned for ${trigger} (${nature.length > 0 ? nature.join(', ') : 'undetermined nature'})` +
    (unnecessary.length > 0 ? `; not running: ${unnecessary.join(', ')}` : '')

  return { trigger, nature, steps, unnecessary, summary }
}

/** One output channel of an executed analysis. */
export interface AnalysisFinding {
  tool: string
  finding: string
  importance: 'blocking' | 'important' | 'advisory'
  evidence: Evidence[]
  risk?: RiskModel
}

export interface PrioritizedAction {
  action: string
  sourceTool: string
  priority: 'immediate' | 'next' | 'review'
  evidence: Evidence[]
  riskScore?: number
}

/** Turn raw findings from executed tools into a prioritized action list. */
export function prioritizeFindings(findings: AnalysisFinding[]): { actions: PrioritizedAction[]; blocked: boolean; recommendation: string } {
  const severityOrder: Record<AnalysisFinding['importance'], number> = { blocking: 0, important: 1, advisory: 2 }

  const sorted = [...findings].sort((a, b) => severityOrder[a.importance] - severityOrder[b.importance])
  const evidencePresent = sorted.filter((f) => f.evidence.length > 0).length

  const actions: PrioritizedAction[] = sorted.map((f) => ({
    action: f.finding,
    sourceTool: f.tool,
    priority: f.importance === 'blocking' ? 'immediate' : f.importance === 'important' ? 'next' : 'review',
    evidence: f.evidence,
    riskScore: f.risk?.score,
  }))

  const blocked = sorted.some((f) => f.importance === 'blocking')
  const recommendation = blocked
    ? `BLOCKED — ${sorted.filter((f) => f.importance === 'blocking').length} blocking finding(s) require action before shipping.`
    : sorted.some((f) => f.importance === 'important')
      ? `Approved with conditions — address ${sorted.filter((f) => f.importance === 'important').length} important finding(s) before or shortly after shipping.`
      : 'No blocking findings. Standard testing and review recommended.'
  return { actions, blocked, recommendation }
}

/** One-line summary of a plan, formatted for tool output. */
export function formatPlan(plan: AnalysisPlan): string {
  const lines: string[] = []
  lines.push(`=== Analysis Plan (${plan.trigger}) ===`)
  lines.push(plan.summary)
  lines.push('')
  for (const step of plan.steps) {
    lines.push(`  [${step.priority.toUpperCase()}] ${step.tool}`)
    lines.push(`    → ${step.reason}`)
    if (step.inputs) lines.push(`    inputs: ${JSON.stringify(step.inputs)}`)
  }
  if (plan.unnecessary.length > 0) {
    lines.push('')
    lines.push(`Deliberately skipped: ${plan.unnecessary.join(', ')}`)
  }
  return lines.join('\n')
}