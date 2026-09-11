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

/** Generate a risk-based recommendation. */
function generateRiskRecommendation(
  risk: RiskAssessment['overallRisk'],
  factors: RiskAssessment['factors'],
  confidence: number,
): string {
  if (risk === 'critical') {
    return 'HIGH RISK: Do not auto-apply. Requires manual review. Consider breaking the fix into smaller, independently verifiable changes.'
  }
  if (risk === 'high') {
    return 'Elevated risk. Apply with caution. Run full test suite before merging. Consider a code review.'
  }
  if (risk === 'medium') {
    return 'Moderate risk. Apply with standard verification. Run existing tests to confirm no regressions.'
  }
  return 'Low risk. Safe to apply with standard verification.'
}
