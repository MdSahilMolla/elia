// Risk assessment: estimate the risk of applying a proposed fix.

import type { RiskAssessment, RepairPlan, GeneratedPatch } from './types.ts'

/** Assess the risk of a proposed fix. */
export function assessRisk(
  plan: RepairPlan,
  patch: GeneratedPatch,
  confidence: number,
): RiskAssessment {
  const factors: RiskAssessment['factors'] = []

  // Number of files changed
  const fileCount = patch.filesAffected.length
  const fileRisk = Math.min(1, fileCount / 5)
  factors.push({
    name: 'files_changed',
    contribution: fileRisk * 20,
    description: `${fileCount} file(s) affected`,
  })

  // Number of functions affected (estimated from lines changed)
  const funcEstimate = Math.ceil(patch.linesChanged / 20)
  const funcRisk = Math.min(1, funcEstimate / 5)
  factors.push({
    name: 'functions_affected',
    contribution: funcRisk * 15,
    description: `~${funcEstimate} function(s) estimated to be affected`,
  })

  // API changes
  const hasApiChanges = plan.steps.some((s) =>
    s.description.toLowerCase().includes('api') || s.description.toLowerCase().includes('contract'),
  )
  factors.push({
    name: 'api_changes',
    contribution: hasApiChanges ? 25 : 0,
    description: hasApiChanges ? 'Public API changes detected' : 'No public API changes',
  })

  // Control flow changes
  const hasControlFlow = plan.steps.some((s) =>
    s.description.toLowerCase().includes('control flow'),
  )
  factors.push({
    name: 'control_flow_changes',
    contribution: hasControlFlow ? 15 : 0,
    description: hasControlFlow ? 'Control flow changes involved' : 'No control flow changes',
  })

  // Confidence in causal hypothesis
  const confidenceFactor = (1 - confidence) * 25
  factors.push({
    name: 'causal_confidence',
    contribution: confidenceFactor,
    description: `Causal confidence: ${Math.round(confidence * 100)}%`,
  })

  // Plan complexity
  const stepRisk = Math.min(1, plan.steps.length / 5)
  factors.push({
    name: 'plan_complexity',
    contribution: stepRisk * 10,
    description: `${plan.steps.length} step(s) in repair plan`,
  })

  // Compute overall score
  const totalScore = factors.reduce((sum, f) => sum + f.contribution, 0)
  const normalizedScore = Math.min(100, totalScore)

  let overallRisk: RiskAssessment['overallRisk']
  if (normalizedScore >= 70) overallRisk = 'critical'
  else if (normalizedScore >= 50) overallRisk = 'high'
  else if (normalizedScore >= 25) overallRisk = 'medium'
  else overallRisk = 'low'

  const recommendation = generateRiskRecommendation(overallRisk, factors, confidence)

  return {
    overallRisk,
    score: normalizedScore,
    factors,
    recommendation,
  }
}

/**
 * Generate a risk-based recommendation.
 *
 * The bucket alone is not the whole story, and the caller already computed two
 * things that have to reach the reader:
 *
 * - `confidence` enters the score as one factor among six, so a weak hypothesis
 *   about a small patch still lands in `low`: one file, one function and 40%
 *   confidence sum to 24, a single point under the `medium` threshold. A small
 *   diff is not evidence that it is the *right* diff, so a thin hypothesis is
 *   called out whatever bucket the arithmetic produced.
 * - `factors` records which of the six actually drove the score. "Elevated
 *   risk" with no reason attached is not something a reader can act on; the
 *   dominant contributor is.
 */
const LOW_CONFIDENCE = 0.6

function generateRiskRecommendation(
  risk: RiskAssessment['overallRisk'],
  factors: RiskAssessment['factors'],
  confidence: number,
): string {
  const parts: string[] = []

  if (risk === 'critical') {
    parts.push('HIGH RISK: Do not auto-apply. Requires manual review. Consider breaking the fix into smaller, independently verifiable changes.')
  } else if (risk === 'high') {
    parts.push('Elevated risk. Apply with caution. Run full test suite before merging. Consider a code review.')
  } else if (risk === 'medium') {
    parts.push('Moderate risk. Apply with standard verification. Run existing tests to confirm no regressions.')
  } else {
    parts.push('Low risk. Safe to apply with standard verification.')
  }

  const dominant = factors
    .filter((f) => f.contribution > 0)
    .sort((a, b) => b.contribution - a.contribution)[0]
  if (dominant) parts.push(`Largest contributor: ${dominant.description}.`)

  if (confidence < LOW_CONFIDENCE) {
    parts.push(
      `Causal confidence is only ${Math.round(confidence * 100)}% — the change may be small, but the hypothesis it rests on is weak. Confirm the root cause before applying.`,
    )
  }

  return parts.join(' ')
}
