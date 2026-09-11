// Multi-signal root-cause scoring with explainable confidence.

import type { RootCauseCandidate, ScoringSignal, EvidenceKind, CausalGraph } from './types.ts'
import { findCausalChain, outgoingEdges, incomingEdges } from './graph.ts'

/** Signal weights — how much each evidence source contributes to the final score. */
const SIGNAL_WEIGHTS = {
  blame_relevance: 0.20,
  semantic_relevance: 0.15,
  temporal_proximity: 0.10,
  behavioral_change: 0.15,
  call_graph: 0.10,
  dependency_relevance: 0.05,
  test_evidence: 0.10,
  code_overlap: 0.05,
  rename_continuity: 0.05,
  counterfactual: 0.05,
} as const

/** Classify a numeric confidence into a named level. */
export function classifyConfidence(score: number): RootCauseCandidate['level'] {
  if (score >= 0.9) return 'certain'
  if (score >= 0.7) return 'high'
  if (score >= 0.4) return 'medium'
  if (score >= 0.2) return 'low'
  return 'speculative'
}

/** Compute blame relevance score (0-1). */
export function scoreBlameRelevance(
  blameEntries: Array<{ commit: string; line: number }>,
  targetCommit: string,
  targetLine?: number,
): ScoringSignal {
  const matchingBlame = blameEntries.filter((e) => e.commit.startsWith(targetCommit))
  const directMatch = matchingBlame.length > 0
  const lineClose = targetLine !== undefined && matchingBlame.some((e) => Math.abs(e.line - targetLine) < 5)

  let score = 0
  let reason = ''

  if (directMatch && lineClose) {
    score = 1.0
    reason = `Commit authored the exact target line (blame match at line ${matchingBlame[0]!.line})`
  } else if (directMatch) {
    score = 0.7
    reason = `Commit authored lines in this file (${matchingBlame.length} lines attributed)`
  } else {
    score = 0.0
    reason = 'Commit did not author any lines in current blame'
  }

  return {
    name: 'blame_relevance',
    score,
    weight: SIGNAL_WEIGHTS.blame_relevance,
    reason,
    kind: 'fact',
  }
}

/** Compute semantic diff relevance score (0-1). */
export function scoreSemanticRelevance(
  categories: string[],
  hasBehavioralChange: boolean,
): ScoringSignal {
  let score = 0
  const reasons: string[] = []

  if (hasBehavioralChange) {
    score += 0.5
    reasons.push('Commit made behavioral changes (not just formatting)')
  }

  const highImpactCategories = ['control_flow', 'error_handling', 'auth_change', 'return_value']
  const hasHighImpact = categories.some((c) => highImpactCategories.includes(c))
  if (hasHighImpact) {
    score += 0.3
    reasons.push(`High-impact categories: ${categories.filter((c) => highImpactCategories.includes(c)).join(', ')}`)
  }

  if (categories.length > 0) {
    score += 0.2
    reasons.push(`${categories.length} semantic change category(ies) detected`)
  }

  return {
    name: 'semantic_relevance',
    score: Math.min(1, score),
    weight: SIGNAL_WEIGHTS.semantic_relevance,
    reason: reasons.join('; ') || 'No semantic changes detected',
    kind: 'evidence',
  }
}

/** Compute temporal proximity score (0-1). Closer in time = higher score. */
export function scoreTemporalProximity(
  commitDate: string,
  targetDate?: string,
  totalCommitsInWindow = 1,
): ScoringSignal {
  if (!targetDate) {
    return { name: 'temporal_proximity', score: 0.5, weight: SIGNAL_WEIGHTS.temporal_proximity, reason: 'No target date for comparison', kind: 'evidence' }
  }

  const commitTime = new Date(commitDate).getTime()
  const targetTime = new Date(targetDate).getTime()
  const diffMs = Math.abs(targetTime - commitTime)
  const diffDays = diffMs / (1000 * 60 * 60 * 24)

  // Exponential decay: within 1 day = ~1.0, within 7 days = ~0.7, within 30 days = ~0.3
  const score = Math.exp(-diffDays / 7)
  const reason = `Commit is ${Math.round(diffDays)} day(s) from target`

  return {
    name: 'temporal_proximity',
    score,
    weight: SIGNAL_WEIGHTS.temporal_proximity,
    reason,
    kind: 'evidence',
  }
}

/** Compute behavioral change score. */
export function scoreBehavioralChange(
  commitMessage: string,
  diffCategories: string[],
): ScoringSignal {
  let score = 0
  const reasons: string[] = []

  const msgLower = commitMessage.toLowerCase()
  const bugIndicators = ['fix', 'bug', 'patch', 'hotfix', 'broken', 'regression', 'issue']
  for (const indicator of bugIndicators) {
    if (msgLower.includes(indicator)) {
      score += 0.2
      reasons.push(`Commit message contains "${indicator}"`)
    }
  }

  if (diffCategories.includes('error_handling')) { score += 0.2; reasons.push('Modified error handling') }
  if (diffCategories.includes('control_flow')) { score += 0.2; reasons.push('Modified control flow') }
  if (diffCategories.includes('auth_change')) { score += 0.2; reasons.push('Modified auth logic') }

  return {
    name: 'behavioral_change',
    score: Math.min(1, score),
    weight: SIGNAL_WEIGHTS.behavioral_change,
    reason: reasons.join('; ') || 'No behavioral change indicators',
    kind: 'evidence',
  }
}

/** Compute call-graph relevance score. */
export function scoreCallGraphRelevance(
  graph: CausalGraph,
  candidateNodeId: string,
  targetNodeId: string,
): ScoringSignal {
  const ancestors = new Set<string>()
  const queue = [targetNodeId]
  const visited = new Set<string>()

  while (queue.length > 0) {
    const id = queue.shift()!
    if (visited.has(id)) continue
    visited.add(id)
    ancestors.add(id)
    const incoming = incomingEdges(graph, id)
    for (const edge of incoming) {
      if (edge.type === 'calls' || edge.type === 'depends_on') {
        queue.push(edge.source)
      }
    }
  }

  const connected = ancestors.has(candidateNodeId)
  return {
    name: 'call_graph',
    score: connected ? 0.8 : 0.1,
    weight: SIGNAL_WEIGHTS.call_graph,
    reason: connected ? 'Candidate is in the call/dependency graph of the target' : 'Candidate is not in the call/dependency graph',
    kind: 'evidence',
  }
}

/** Compute test/regression evidence score. */
export function scoreTestEvidence(
  commitMessage: string,
  filesChanged: string[],
): ScoringSignal {
  let score = 0
  const reasons: string[] = []

  const msgLower = commitMessage.toLowerCase()
  if (msgLower.includes('test')) { score += 0.3; reasons.push('Commit modifies tests') }

  const testFiles = filesChanged.filter((f) => f.includes('.test.') || f.includes('.spec.') || f.includes('__tests__'))
  if (testFiles.length > 0) {
    score += 0.3
    reasons.push(`Changes ${testFiles.length} test file(s)`)
  }

  if (msgLower.includes('regression')) { score += 0.4; reasons.push('Commit mentions regression') }

  return {
    name: 'test_evidence',
    score: Math.min(1, score),
    weight: SIGNAL_WEIGHTS.test_evidence,
    reason: reasons.join('; ') || 'No test evidence',
    kind: 'evidence',
  }
}

/** Compute code-region overlap score. */
export function scoreCodeOverlap(
  blameEntries: Array<{ commit: string; line: number }>,
  targetCommit: string,
  targetLine?: number,
  fileLineCount = 100,
): ScoringSignal {
  const matchingLines = blameEntries.filter((e) => e.commit.startsWith(targetCommit))
  if (matchingLines.length === 0) {
    return { name: 'code_overlap', score: 0, weight: SIGNAL_WEIGHTS.code_overlap, reason: 'No overlapping lines', kind: 'evidence' }
  }

  const lineRatio = matchingLines.length / fileLineCount
  const nearTarget = targetLine !== undefined
    ? matchingLines.filter((e) => Math.abs(e.line - targetLine) < 20).length
    : 0
  const proximityBonus = targetLine !== undefined ? nearTarget / matchingLines.length : 0

  const score = Math.min(1, lineRatio * 2 + proximityBonus * 0.5)
  return {
    name: 'code_overlap',
    score,
    weight: SIGNAL_WEIGHTS.code_overlap,
    reason: `${matchingLines.length} lines overlap (${Math.round(lineRatio * 100)}% of file)`,
    kind: 'evidence',
  }
}

/** Compute rename continuity score. */
export function scoreRenameContinuity(
  provenance: Array<{ commit: string; action: string }>,
  candidateCommit: string,
): ScoringSignal {
  const relevant = provenance.filter((p) => p.action === 'renamed' || p.action === 'moved')
  const connected = relevant.some((p) => p.commit.startsWith(candidateCommit))

  return {
    name: 'rename_continuity',
    score: connected ? 0.8 : 0.2,
    weight: SIGNAL_WEIGHTS.rename_continuity,
    reason: connected ? 'Candidate commit is in the rename/move history' : 'Candidate is not part of rename chain',
    kind: 'evidence',
  }
}

/** Compute counterfactual score. */
export function scoreCounterfactual(
  counterfactualVerified: boolean,
  counterfactualAvailable: boolean,
): ScoringSignal {
  if (!counterfactualAvailable) {
    return { name: 'counterfactual', score: 0.5, weight: SIGNAL_WEIGHTS.counterfactual, reason: 'Counterfactual analysis not available', kind: 'assumption' }
  }
  return {
    name: 'counterfactual',
    score: counterfactualVerified ? 1.0 : 0.0,
    weight: SIGNAL_WEIGHTS.counterfactual,
    reason: counterfactualVerified ? 'Counterfactual analysis confirmed: removing this change eliminates the failure' : 'Counterfactual analysis did not confirm causality',
    kind: 'evidence',
  }
}

/** Compute the final root-cause score from all signals. */
export function computeRootCauseScore(signals: ScoringSignal[]): number {
  let weightedSum = 0
  let totalWeight = 0
  for (const signal of signals) {
    weightedSum += signal.score * signal.weight
    totalWeight += signal.weight
  }
  return totalWeight > 0 ? weightedSum / totalWeight : 0
}

/** Rank candidates and produce the final list. */
export function rankCandidates(
  candidates: Array<{
    commitHash: string
    nodeId: string
    label: string
    signals: ScoringSignal[]
    causalChain: string[]
    counterfactualVerified: boolean
  }>,
): RootCauseCandidate[] {
  const ranked = candidates.map((c) => {
    const score = computeRootCauseScore(c.signals)
    const level = classifyConfidence(score)

    const explanation = generateExplanation(c.signals, score, level)

    return {
      nodeId: c.nodeId,
      commitHash: c.commitHash,
      label: c.label,
      confidence: Math.round(score * 100) / 100,
      level,
      scoringBreakdown: c.signals,
      explanation,
      causalChain: c.causalChain,
      counterfactualVerified: c.counterfactualVerified,
    }
  })

  ranked.sort((a, b) => b.confidence - a.confidence)
  return ranked
}

/** Generate an explainable summary of why a candidate was scored as it was. */
function generateExplanation(signals: ScoringSignal[], score: number, level: string): string {
  const topSignals = signals
    .filter((s) => s.score > 0.3)
    .sort((a, b) => (b.score * b.weight) - (a.score * a.weight))
    .slice(0, 3)

  const parts = [`Overall confidence: ${Math.round(score * 100)}% (${level})`]

  if (topSignals.length > 0) {
    parts.push('Strongest signals:')
    for (const s of topSignals) {
      parts.push(`  - ${s.name}: ${s.reason}`)
    }
  }

  const weakSignals = signals.filter((s) => s.score < 0.2 && s.weight > 0.05)
  if (weakSignals.length > 0) {
    parts.push('Weak signals:')
    for (const s of weakSignals) {
      parts.push(`  - ${s.name}: ${s.reason}`)
    }
  }

  return parts.join('\n')
}
