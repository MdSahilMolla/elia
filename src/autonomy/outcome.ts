import { outstandingActions, pendingApprovals as approvalsAwaitingAPerson, type GoalGraphSnapshot } from './goalGraph.ts'

export type CompletionState = 'verified' | 'partial' | 'blocked' | 'failed' | 'aborted'
export type CompletionConfidence = 'high' | 'medium' | 'low'

export interface CompletionAssessment {
  state: CompletionState
  confidence: CompletionConfidence
  summary: string
  evidence: string[]
  blockers: string[]
  nextActions: string[]
  completedSteps: number
  totalSteps: number
  pendingApprovals: number
}

export interface CompletionInput {
  outcome: string
  graph?: GoalGraphSnapshot
  verificationPassed: boolean
  reviewPassed: boolean
  planApproved: boolean
  actionBudget?: { maxActions: number; consumed: number; exhausted: boolean; blockedByBudget: number }
}

export function assessCompletion(input: CompletionInput): CompletionAssessment {
  const steps = input.graph?.nodes.filter((node) => node.kind === 'step' || node.kind === 'delegation') ?? []
  const completedSteps = steps.filter((node) => node.status === 'completed').length
  // Same rule the goal graph uses to decide whether the goal may complete, so
  // the report and the gate can never disagree about whether work is owed.
  const unresolvedActions = input.graph ? outstandingActions(input.graph) : []
  const pendingApprovals = input.graph ? approvalsAwaitingAPerson(input.graph).length : 0
  const blockers: string[] = []
  const evidence: string[] = []
  const nextActions: string[] = []

  if (input.planApproved) evidence.push('The execution plan was approved.')
  else blockers.push('The execution plan does not have an approved durable approval record.')
  if (steps.length > 0 && completedSteps === steps.length) evidence.push(`All ${steps.length} planned step(s) completed.`)
  else blockers.push(`${completedSteps} of ${steps.length} planned work node(s) completed.`)
  if (unresolvedActions.length > 0) blockers.push(`${unresolvedActions.length} durable action(s) remain unresolved.`)
  if (input.verificationPassed) evidence.push('Verification commands passed.')
  else blockers.push('Verification commands did not pass or were not completed.')
  if (input.reviewPassed) evidence.push('Structured review passed.')
  else blockers.push('Structured review did not pass or was not completed.')
  if (pendingApprovals > 0) blockers.push(`${pendingApprovals} approval(s) remain pending.`)
  if ((input.actionBudget?.blockedByBudget ?? 0) > 0) blockers.push(`The autonomous action budget was exhausted after ${input.actionBudget?.consumed ?? 0} governed request(s).`)

  let state: CompletionState
  let confidence: CompletionConfidence
  /** Set when the generic per-state summary would understate what the run actually achieved. */
  let summaryOverride: string | undefined
  if (input.outcome === 'aborted') {
    state = 'aborted'
    confidence = 'low'
    nextActions.push('Resume from the durable graph after confirming the environment and any pending approvals.')
  } else if (input.outcome === 'rejected' || pendingApprovals > 0 || !input.planApproved) {
    state = 'blocked'
    confidence = 'low'
    nextActions.push('Resolve the outstanding approval or revise and approve the plan before execution.')
  } else if (input.outcome === 'completed' && completedSteps === steps.length && steps.length > 0 && unresolvedActions.length === 0 && input.verificationPassed && input.reviewPassed && (input.actionBudget?.blockedByBudget ?? 0) === 0) {
    state = 'verified'
    confidence = 'high'
    nextActions.push('Review the receipt and accept the verified result, or provide a new goal for follow-up work.')
  } else if (completedSteps === steps.length && steps.length > 0 && input.verificationPassed) {
    // Every planned step completed and the project's own checks passed. Review
    // may still be outstanding and actions may be unresolved — both are already
    // recorded as blockers — but reporting this as "failed" contradicts the
    // run's own evidence. Run 2026-09-10-754n-8z17 was reported failed with
    // 4 of 4 steps done and verification green, purely because the structured
    // review had not finished.
    state = 'partial'
    confidence = 'medium'
    summaryOverride = 'The planned work completed and verification passed; the review did not finish.'
    nextActions.push('Finish the outstanding review or resolve the listed actions to reach a verified result.')
  } else if (completedSteps > 0 || input.verificationPassed || input.reviewPassed || (input.actionBudget?.blockedByBudget ?? 0) > 0) {
    state = input.outcome === 'needs-attention' ? 'failed' : 'partial'
    confidence = 'medium'
    nextActions.push('Inspect the receipt, address the listed blockers, and resume or retry only the incomplete work.')
  } else {
    state = 'failed'
    confidence = 'low'
    nextActions.push('Inspect the first failure and environment prerequisites before retrying.')
  }

  return {
    state,
    confidence,
    summary: summaryOverride ?? (state === 'verified'
      ? 'The goal has evidence-backed completion.'
      : state === 'blocked'
        ? 'The goal is blocked by approval or authorization state.'
        : state === 'aborted'
          ? 'The goal stopped before completion and can be resumed from durable state.'
          : state === 'partial'
            ? 'The goal has partial progress but completion is not proven.'
            : 'The goal did not complete successfully.'),
    evidence,
    blockers,
    nextActions,
    completedSteps,
    totalSteps: steps.length,
    pendingApprovals,
  }
}
