// Repair planner: generate a minimal, low-risk repair plan from causal analysis.

import type { RepairPlan, RepairPlanStep, RootCauseCandidate, SemanticDiff } from './types.ts'
import { getFileAtHead } from './gitProvenance.ts'

/** Generate a repair plan from a root-cause candidate. */
export async function generateRepairPlan(
  candidate: RootCauseCandidate,
  semanticDiffs: SemanticDiff[],
  targetFile: string,
  cwd: string,
): Promise<RepairPlan> {
  const steps: RepairPlanStep[] = []
  const alternatives: RepairPlan['alternatives'] = []

  // Find the semantic diff associated with this commit
  const relevantDiff = semanticDiffs.find((d) => d.commitHash.startsWith(candidate.commitHash))

  if (relevantDiff) {
    // Generate steps based on the semantic categories
    for (const change of relevantDiff.behavioralChanges) {
      steps.push({
        index: steps.length,
        description: `Revert or fix: ${change.description}`,
        filePath: targetFile,
        startLine: change.startLine,
        endLine: change.endLine,
        change: generateChangeDescription(change.category, change.description),
        risk: assessChangeRisk(change.category),
        rationale: `This change (${change.category}) was identified as part of the root cause with ${Math.round(candidate.confidence * 100)}% confidence`,
      })
    }

    // Add alternative approaches
    if (relevantDiff.categories.includes('error_handling')) {
      alternatives.push({
        description: 'Add error handling instead of reverting',
        tradeoffs: 'Preserves the change but adds defensive code. May mask the root cause.',
        rejected: false,
      })
    }

    if (relevantDiff.categories.includes('control_flow')) {
      alternatives.push({
        description: 'Add guard clause before the changed control flow',
        tradeoffs: 'Minimal change but may not address the underlying logic issue.',
        rejected: false,
      })
    }
  }

  // Default fallback plan
  if (steps.length === 0) {
    steps.push({
      index: 0,
      description: `Review and potentially revert commit ${candidate.commitHash.slice(0, 8)}`,
      filePath: targetFile,
      change: `git revert ${candidate.commitHash}`,
      risk: 'medium',
      rationale: `Commit ${candidate.commitHash.slice(0, 8)} was identified as the root cause with ${Math.round(candidate.confidence * 100)}% confidence`,
    })

    alternatives.push({
      description: 'Manual investigation and targeted fix',
      tradeoffs: 'More time-consuming but may result in a more precise fix.',
      rejected: false,
    })
  }

  // Add alternatives
  alternatives.push({
    description: 'Full revert of the commit',
    tradeoffs: 'Cleanest but may lose other unrelated changes in the same commit.',
    rejected: true,
  })

  alternatives.push({
    description: 'Bisect and narrow down to specific lines',
    tradeoffs: 'Most precise but time-consuming.',
    rejected: true,
  })

  const overallRisk = steps.some((s) => s.risk === 'high')
    ? 'high'
    : steps.some((s) => s.risk === 'medium')
      ? 'medium'
      : 'low'

  return {
    steps,
    summary: `Repair plan: ${steps.length} step(s) to address root cause in ${targetFile}. Overall risk: ${overallRisk}.`,
    overallRisk,
    confidence: candidate.confidence,
    alternatives,
  }
}

/** Generate a change description based on the semantic category. */
function generateChangeDescription(category: string, description: string): string {
  const reversals: Record<string, string> = {
    control_flow: 'Revert control flow change',
    return_value: 'Restore original return value behavior',
    error_handling: 'Restore original error handling',
    auth_change: 'Revert authentication/authorization change',
    concurrency: 'Revert async behavior change',
    state_mutation: 'Restore original state management',
    api_contract: 'Revert API contract change',
    dependency_change: 'Restore original dependency',
    config_change: 'Restore original configuration',
    type_change: 'Revert type definition change',
  }

  return reversals[category] ?? `Revert change: ${description}`
}

/** Assess the risk of a change based on its category. */
function assessChangeRisk(category: string): RepairPlanStep['risk'] {
  const highRisk = ['auth_change', 'api_contract', 'dependency_change']
  const mediumRisk = ['control_flow', 'error_handling', 'concurrency', 'state_mutation']

  if (highRisk.includes(category)) return 'high'
  if (mediumRisk.includes(category)) return 'medium'
  return 'low'
}
