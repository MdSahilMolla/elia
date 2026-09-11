// Output formatting: produce explainable, structured reports.

import type {
  CausalDebugResult, CausalFixResult, RootCauseCandidate,
  SemanticDiff, ProvenanceEntry, ReproductionResult, CounterfactualResult,
  VerificationCheck, RiskAssessment, RepairPlan, GeneratedPatch, RegressionTest,
} from './types.ts'

/** Format the complete causal debug result. */
export function formatCausalDebugResult(result: CausalDebugResult): string {
  const lines: string[] = []

  lines.push('═══════════════════════════════════════')
  lines.push('       CAUSAL DEBUG & REPAIR ENGINE')
  lines.push('═══════════════════════════════════════')
  lines.push('')

  // Target
  lines.push('Location:')
  lines.push(`  ${result.target.file}${result.target.line !== undefined ? `:${result.target.line}` : ''}`)
  lines.push('')

  // Observed behavior
  if (result.observedBehavior) {
    lines.push('Observed behavior:')
    lines.push(`  ${result.observedBehavior}`)
    lines.push('')
  }

  // Root cause candidates
  if (result.candidates.length > 0) {
    const top = result.candidates[0]!
    lines.push('Root cause candidate:')
    lines.push(`  ${top.commitHash.slice(0, 8)} — ${Math.round(top.confidence * 100)}% confidence (${top.level})`)
    lines.push(`  ${top.label}`)
    lines.push('')

    // Evidence
    lines.push('Evidence:')
    for (const signal of top.scoringBreakdown.filter((s) => s.score > 0.1)) {
      const kindIcon = signal.kind === 'fact' ? '📋' : signal.kind === 'evidence' ? '🔍' : signal.kind === 'inference' ? '💭' : '❓'
      lines.push(`  ${kindIcon} ${signal.name}: ${signal.reason}`)
    }
    lines.push('')

    // Causal chain
    if (top.causalChain.length > 0) {
      lines.push('Causal chain:')
      for (let i = 0; i < Math.min(top.causalChain.length, 10); i++) {
        const prefix = i === 0 ? '  ' : '  ↓ '
        lines.push(`${prefix}${top.causalChain[i]!.slice(0, 12)}`)
      }
      if (top.causalChain.length > 10) lines.push(`  ... (${top.causalChain.length - 10} more)`)
      lines.push('')
    }
  }

  // Alternative candidates
  if (result.candidates.length > 1) {
    lines.push('Alternative candidates:')
    for (const alt of result.candidates.slice(1, 4)) {
      lines.push(`  ${alt.commitHash.slice(0, 8)} — ${Math.round(alt.confidence * 100)}% (${alt.level})`)
      lines.push(`    ${alt.explanation.split('\n')[0]}`)
    }
    lines.push('')
  }

  // Semantic analysis
  if (result.semanticDiffs.length > 0) {
    lines.push('Behavioral analysis:')
    for (const diff of result.semanticDiffs.slice(0, 3)) {
      lines.push(`  ${diff.behavioralSummary}`)
    }
    lines.push('')
  }

  // Provenance
  if (result.provenance.length > 0) {
    lines.push('Code provenance:')
    for (const p of result.provenance.slice(0, 5)) {
      lines.push(`  ${p.action}: ${p.path} (${p.commit.slice(0, 8)}, similarity: ${p.similarity ?? 'N/A'}%)`)
    }
    lines.push('')
  }

  // Reproduction
  lines.push('Reproduction:')
  if (result.reproduction.established) {
    lines.push(`  ${result.reproduction.bugConfirmed ? '❌ fails (bug confirmed)' : '✓ passes (bug not reproduced)'}`)
    if (result.reproduction.command) lines.push(`  Command: ${result.reproduction.command}`)
    if (result.reproduction.limitation) lines.push(`  Note: ${result.reproduction.limitation}`)
  } else {
    lines.push(`  Not established: ${result.reproduction.limitation ?? 'Unknown limitation'}`)
  }
  lines.push('')

  // Counterfactual
  if (result.counterfactual.performed) {
    lines.push('Counterfactual analysis:')
    lines.push(`  ${result.counterfactual.candidateCausal ? '✓ CONFIRMED' : '✗ NOT CONFIRMED'}`)
    lines.push(`  ${result.counterfactual.explanation}`)
    lines.push('')
  }

  // Recommended fix
  lines.push('Recommended fix:')
  if (result.candidates.length > 0) {
    lines.push(`  Revert or fix commit ${result.candidates[0]!.commitHash.slice(0, 8)}`)
    lines.push(`  Confidence: ${Math.round(result.overallConfidence * 100)}%`)
  } else {
    lines.push('  No root cause identified with sufficient confidence')
  }
  lines.push('')

  // Limitations
  if (result.limitations.length > 0) {
    lines.push('Limitations:')
    for (const lim of result.limitations) {
      lines.push(`  ⚠ ${lim}`)
    }
    lines.push('')
  }

  lines.push('═══════════════════════════════════════')
  return lines.join('\n')
}

/** Format the complete causal fix result. */
export function formatCausalFixResult(result: CausalFixResult): string {
  const lines: string[] = []

  lines.push('═══════════════════════════════════════')
  lines.push('       CAUSAL FIX & VERIFICATION')
  lines.push('═══════════════════════════════════════')
  lines.push('')

  // Root cause
  lines.push('Root cause:')
  lines.push(`  ${result.rootCause.commitHash.slice(0, 8)} — ${Math.round(result.rootCause.confidence * 100)}% confidence`)
  lines.push(`  ${result.rootCause.label}`)
  lines.push('')

  // Repair plan
  lines.push('Repair plan:')
  for (const step of result.repairPlan.steps) {
    lines.push(`  ${step.index + 1}. [${step.risk}] ${step.description}`)
    lines.push(`     File: ${step.filePath}${step.startLine !== undefined ? `:${step.startLine}` : ''}`)
    lines.push(`     Change: ${step.change}`)
    lines.push(`     Rationale: ${step.rationale}`)
  }
  lines.push('')

  // Alternatives
  if (result.repairPlan.alternatives.length > 0) {
    lines.push('Alternatives considered:')
    for (const alt of result.repairPlan.alternatives) {
      lines.push(`  ${alt.rejected ? '✗' : '○'} ${alt.description}`)
      lines.push(`    Tradeoffs: ${alt.tradeoffs}`)
    }
    lines.push('')
  }

  // Patch
  lines.push('Generated patch:')
  lines.push(`  Files: ${result.patch.filesAffected.join(', ')}`)
  lines.push(`  Lines changed: ${result.patch.linesChanged}`)
  lines.push(`  ${result.patch.explanation}`)
  lines.push(`  Expected: ${result.patch.expectedBehavior}`)
  if (result.patch.risks.length > 0) {
    lines.push(`  Risks: ${result.patch.risks.join('; ')}`)
  }
  lines.push('')

  // Regression test
  if (result.regressionTest.code) {
    lines.push('Regression test:')
    lines.push(`  File: ${result.regressionTest.filePath}`)
    lines.push(`  Invariant: ${result.regressionTest.invariant}`)
    lines.push(`  Framework: ${result.regressionTest.framework}`)
    lines.push(`  Fails before fix: ${result.regressionTest.failsBeforeFix ? '✓' : '✗'}`)
    lines.push(`  Passes after fix: ${result.regressionTest.passesAfterFix ? '✓' : '✗'}`)
    if (result.regressionTest.limitation) lines.push(`  Note: ${result.regressionTest.limitation}`)
    lines.push('')
  }

  // Verification
  lines.push('Verification:')
  for (const check of result.verification) {
    const icon = check.status === 'PASS' ? '✓' : check.status === 'FAIL' ? '✗' : check.status === 'NOT_RUN' ? '○' : '?'
    lines.push(`  ${icon} ${check.name}: ${check.status}`)
  }
  lines.push('')

  // Risk assessment
  lines.push('Risk assessment:')
  lines.push(`  Overall: ${result.risk.overallRisk.toUpperCase()} (score: ${result.risk.score}/100)`)
  for (const factor of result.risk.factors) {
    if (factor.contribution > 0) {
      lines.push(`  - ${factor.name}: ${factor.description} (+${Math.round(factor.contribution)})`)
    }
  }
  lines.push(`  Recommendation: ${result.risk.recommendation}`)
  lines.push('')

  // Summary
  lines.push('Summary:')
  lines.push(`  Fix applied: ${result.fixApplied ? '✓ Yes' : '✗ No'}`)
  lines.push(`  All verified: ${result.allVerified ? '✓ Yes' : '✗ No'}`)
  lines.push('')

  lines.push('═══════════════════════════════════════')
  return lines.join('\n')
}
