import { currentStage, evaluateStage, reviewIsFresh, type GateContext, type RequirementStatus } from './gates.ts'
import { FLAG_MEANING, LIFECYCLES, type Condition, type LifecycleSpec, type PlannedStage, type RequirementSpec } from './lifecycles.ts'
import { ORG_ROLES, REVIEW_KINDS, SIGNOFF_GATES, TEAMS } from './org.ts'
import type { Initiative, StageState } from './store.ts'

/** Plain-text views of the org model and the record, for the model and for the operator. */

export function renderGate(statuses: RequirementStatus[]): string {
  if (!statuses.length) return '    (no requirements)'
  return statuses.map((status) => `    ${status.met ? '✓' : '✗'} ${status.requirement.type === 'artifact' ? `${status.requirement.artifact}` : status.requirement.type === 'review' ? `${status.requirement.review}${status.requirement.hat ? ` (${status.requirement.hat})` : ''}${status.requirement.subject === 'artifact' ? ' of the design' : ''}` : status.requirement.type === 'signoff' ? `${status.requirement.gate} sign-off` : status.requirement.type === 'check' && status.requirement.fresh ? 'check (on current code)' : status.requirement.type}: ${status.detail}${status.hint ? `\n        → ${status.hint}` : ''}${status.requirement.why !== 'always' ? `  [${status.requirement.why}]` : ''}`).join('\n')
}

function stageMark(stage: StageState): string {
  return stage.status === 'done' ? '✓' : stage.status === 'active' ? '▶' : '·'
}

export function renderStages(initiative: Initiative, context?: GateContext): string {
  const lines: string[] = []
  for (const stage of initiative.stages) {
    const owner = ORG_ROLES[stage.owner]?.title ?? stage.owner
    lines.push(`  ${stageMark(stage)} ${stage.id} — ${owner}${stage.visits > 1 ? ` (visit ${stage.visits})` : ''}`)
    if (stage.status === 'active' && context) {
      lines.push(`      ${stage.does}`)
      lines.push(renderGate(evaluateStage(initiative, stage, context)))
    }
  }
  return lines.join('\n')
}

export function renderInitiative(initiative: Initiative, context?: GateContext): string {
  const lines = [
    `${initiative.id} · ${initiative.title}  [${initiative.status}${initiative.blockedReason ? `: ${initiative.blockedReason}` : ''}]`,
    `origin ${initiative.origin}${initiative.team ? ` · team ${TEAMS.find((team) => team.id === initiative.team)?.name ?? initiative.team}` : ''} · lifecycle ${initiative.lifecycle} · scale ${initiative.scale}${initiative.flags.length ? ` · flags ${initiative.flags.join(', ')}` : ''}${initiative.iterations ? ` · ${initiative.iterations} iteration(s)` : ''}`,
    `problem: ${initiative.problem}`,
    `triage: ${initiative.triage.join('; ')}`,
    'stages:',
    renderStages(initiative, context),
  ]
  if (initiative.items.length) {
    lines.push('work items:')
    for (const item of initiative.items) lines.push(`  ${item.id} [${item.status}] ${item.priority} ${item.title} — ${ORG_ROLES[item.owner]?.title ?? item.owner}${item.estimate ? ` · ${item.estimate}` : ''}${item.dependsOn.length ? ` · after ${item.dependsOn.join(', ')}` : ''}`)
  }
  if (initiative.artifacts.length) {
    lines.push('artifacts:')
    const latest = new Map<string, number>()
    for (const artifact of initiative.artifacts) latest.set(artifact.kind, Math.max(latest.get(artifact.kind) ?? 0, artifact.version))
    for (const artifact of initiative.artifacts.filter((a) => latest.get(a.kind) === a.version)) lines.push(`  ${artifact.id} ${artifact.valid ? 'valid' : `INVALID (${artifact.errors.length} problem(s))`} — ${artifact.path}`)
  }
  if (initiative.reviews.length) {
    lines.push('reviews:')
    for (const review of initiative.reviews.slice(-8)) lines.push(`  ${review.kind} ${review.verdict} by ${review.by.name} as ${review.hat}${review.independent ? '' : ' (self-review — does not count)'}${context && !reviewIsFresh(review, initiative, context) ? ' (stale)' : ''}${review.findings.length ? ` — ${review.findings.length} finding(s)` : ''}`)
  }
  const checks = initiative.evidence.filter((item) => item.kind === 'check')
  if (checks.length) {
    lines.push('checks:')
    for (const check of checks.slice(-5)) lines.push(`  ${check.passed ? 'PASS' : 'FAIL'} ${check.command} (${check.stage}, ${check.at.slice(0, 16)})`)
  }
  if (initiative.decisions.length) {
    lines.push('decisions:')
    for (const decision of initiative.decisions) lines.push(`  ${decision.id} ${decision.title}: ${decision.decision}`.slice(0, 220))
  }
  const openRisks = initiative.risks.filter((risk) => risk.status === 'open')
  if (initiative.risks.length) lines.push(`risks: ${initiative.risks.length} (${openRisks.length} open)${openRisks.length ? ` — ${openRisks.map((risk) => `${risk.id} ${risk.title} [${risk.likelihood}/${risk.impact}]`).join('; ')}` : ''}`)
  const relations = [
    initiative.parent ? `${initiative.relation ?? 'from'} of ${initiative.parent}` : '',
    initiative.children.length ? `follow-ups ${initiative.children.join(', ')}` : '',
    initiative.dependsOn.length ? `depends on ${initiative.dependsOn.join(', ')}` : '',
  ].filter(Boolean)
  if (relations.length) lines.push(`relations: ${relations.join(' · ')}`)
  if (initiative.outcome) lines.push(`outcome: ${initiative.outcome}`)
  return lines.join('\n')
}

export function renderBoardLine(initiative: Initiative, context?: GateContext): string {
  const stage = currentStage(initiative)
  const unmet = stage && context ? evaluateStage(initiative, stage, context).filter((status) => !status.met).length : undefined
  const where = stage ? `${stage.id} (${ORG_ROLES[stage.owner]?.title ?? stage.owner})${unmet !== undefined ? ` · ${unmet ? `${unmet} gate(s) open` : 'ready to advance'}` : ''}` : initiative.status
  return `${initiative.id.padEnd(6)} ${initiative.status.padEnd(9)} ${`${initiative.lifecycle}/${initiative.scale}`.padEnd(22)} ${where} — ${initiative.title}${initiative.team ? ` [${initiative.team}]` : ''}`
}

function conditionText(condition: Condition | undefined): string {
  if (!condition) return ''
  const parts = [condition.minScale ? `${condition.minScale}+` : '', condition.flags ? `if ${condition.flags.join('|')}` : ''].filter(Boolean)
  return parts.length ? ` [${parts.join(', ')}]` : ''
}

function requirementText(requirement: RequirementSpec): string {
  const what = requirement.type === 'artifact' ? requirement.artifact : requirement.type === 'review' ? `${requirement.review}${requirement.hat ? ` (${requirement.hat})` : ''}${requirement.subject === 'artifact' ? ' of the design' : ''}` : requirement.type === 'signoff' ? `${requirement.gate} sign-off` : requirement.type === 'check' && requirement.fresh ? 'check on current code' : requirement.type
  return `${what}${conditionText(requirement.when)}`
}

export function renderLifecycle(spec: LifecycleSpec): string {
  const lines = [`${spec.id} — ${spec.title}`, `  ${spec.summary}`]
  for (const stage of spec.stages) lines.push(`  ${stage.id}${conditionText(stage.when)} — ${ORG_ROLES[stage.owner].title}: ${stage.does}\n      exit: ${stage.requires.map(requirementText).join(', ')}`)
  return lines.join('\n')
}

export function renderPlanned(stages: PlannedStage[]): string {
  return stages.map((stage, index) => `  ${index + 1}. ${stage.id} — ${ORG_ROLES[stage.owner].title}: ${stage.requirements.map((requirement) => requirement.type === 'artifact' ? requirement.artifact : requirement.type === 'review' ? `${requirement.review}${requirement.hat ? ` (${requirement.hat})` : ''}${requirement.subject === 'artifact' ? ' of the design' : ''}` : requirement.type === 'signoff' ? `${requirement.gate} sign-off` : requirement.type === 'check' && requirement.fresh ? 'check on current code' : requirement.type).join(', ') || '—'}`).join('\n')
}

export function renderLifecycleIndex(): string {
  return LIFECYCLES.map((spec) => `${spec.id.padEnd(14)} ${spec.title} — ${spec.summary}`).join('\n')
}

export function renderReviewKinds(): string {
  const reviews = Object.entries(REVIEW_KINDS).map(([kind, spec]) => `${kind.padEnd(21)} given by ${ORG_ROLES[spec.by].title} (independent workers: ${spec.workers.join(', ')}; reviews the ${spec.subject === 'tree' ? 'exact code' : 'artifact version'}) — ${spec.asks}`)
  const gates = Object.entries(SIGNOFF_GATES).map(([gate, text]) => `${gate.padEnd(16)} ${text}`)
  const flags = Object.entries(FLAG_MEANING).map(([flag, meaning]) => `${flag.padEnd(15)} ${meaning}`)
  return ['Reviews (only an independent reviewer\'s approval counts; any later change makes it stale):', ...reviews.map((line) => `  ${line}`), '', 'Sign-offs (a person decides; elia asks, never assumes):', ...gates.map((line) => `  ${line}`), '', 'Triage flags:', ...flags.map((line) => `  ${line}`)].join('\n')
}
