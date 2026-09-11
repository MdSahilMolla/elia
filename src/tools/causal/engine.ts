// Main engine: orchestrates the full causal debug/fix/verify pipeline.
// This is the shared internal engine used by all three tool APIs.

import type {
  CausalDebugResult, CausalFixResult, CausalGraph, RootCauseCandidate,
  SemanticDiff, ProvenanceEntry, ReproductionResult, CounterfactualResult,
  VerificationCheck, RiskAssessment, RepairPlan, GeneratedPatch, RegressionTest,
  EvidenceEntry, ScoringSignal,
} from './types.ts'
import { createGraph, addNode, addEdge, findNodesByCommit, findNodesByFile, findCausalChain } from './graph.ts'
import { getBlame, getFileHistory, getCommitFiles, getFileAtHead, getFileAtCommit, traceFileRenames, isShallowRepo, hasDirtyWorkingTree } from './gitProvenance.ts'
import { analyzeSemanticDiff } from './semanticDiff.ts'
import {
  scoreBlameRelevance, scoreSemanticRelevance, scoreTemporalProximity,
  scoreBehavioralChange, scoreCallGraphRelevance, scoreTestEvidence,
  scoreCodeOverlap, scoreRenameContinuity, scoreCounterfactual,
  rankCandidates,
} from './scoring.ts'
import { reproduceFromFile, deriveReproductionCommand } from './reproduction.ts'
import { performCounterfactual } from './counterfactual.ts'
import { generateRepairPlan } from './repair.ts'
import { generatePatch } from './patch.ts'
import { generateRegressionTest, verifyTestFailsBeforeFix } from './regressionTest.ts'
import { runAllVerifications } from './verify.ts'
import { assessRisk } from './risk.ts'

const MAX_HISTORY_DEPTH = 50

export interface EngineOptions {
  file: string
  line?: number
  depth?: number
  keyword?: string
  observedBehavior?: string
  cwd: string
}

/** Run the full causal debug pipeline. */
export async function runCausalDebug(options: EngineOptions): Promise<CausalDebugResult> {
  const { file, line, cwd, keyword } = options
  const limitations: string[] = []

  // Build the causal graph
  const graph = createGraph()

  // Add target file node
  const targetNodeId = addNode(graph, 'file', file, {}, file, line, line)

  // Check for shallow repo / dirty tree
  const shallow = await isShallowRepo(cwd)
  if (shallow) limitations.push('Repository is shallow — some history may be missing')

  const dirty = await hasDirtyWorkingTree(cwd)
  if (dirty) limitations.push('Working tree has uncommitted changes — results may differ from committed state')

  // Get blame
  const blameEntries = await getBlame(file, cwd, line, line ? line + 1 : undefined)

  // Get file history
  let history = await getFileHistory(file, cwd, options.depth ?? MAX_HISTORY_DEPTH)

  // Filter by keyword if provided
  if (keyword) {
    const needle = keyword.toLowerCase()
    history = history.filter((c) => c.message.toLowerCase().includes(needle) || c.author.toLowerCase().includes(needle))
    if (history.length === 0) {
      limitations.push(`No commits matched keyword "${keyword}"`)
    }
  }

  // Add commit nodes and edges
  const commitNodeIds: string[] = []
  for (const commit of history) {
    const commitNodeId = addNode(graph, 'commit', commit.message.slice(0, 60), {
      author: commit.author,
      date: commit.date,
      filesChanged: commit.filesChanged,
    }, file, undefined, undefined, commit.hash)

    addEdge(graph, commitNodeId, targetNodeId, 'modified', 0.5, 'evidence', [{
      kind: 'evidence',
      description: `Commit ${commit.hash.slice(0, 8)} modified ${file}`,
      source: 'git log',
      confidence: 0.5,
    }])

    commitNodeIds.push(commitNodeId)
  }

  // Add blame edges
  for (const entry of blameEntries) {
    const commitNode = findNodesByCommit(graph, entry.commit)[0]
    if (commitNode) {
      addEdge(graph, commitNode.id, targetNodeId, 'introduced', 0.7, 'fact', [{
        kind: 'fact',
        description: `Commit ${entry.commit.slice(0, 8)} authored line ${entry.line}`,
        source: 'git blame',
        confidence: 0.9,
      }])
    }
  }

  // Add rename/provenance
  const provenance = await traceFileRenames(file, cwd)
  for (const p of provenance) {
    if (p.action === 'renamed' || p.action === 'moved') {
      const fromNode = addNode(graph, 'file', p.path, {}, p.path, undefined, undefined, p.commit)
      addEdge(graph, fromNode, targetNodeId, 'renamed', (p.similarity ?? 50) / 100, 'fact', [{
        kind: 'fact',
        description: `File renamed from ${p.path} in commit ${p.commit.slice(0, 8)}`,
        source: 'git log --diff-filter',
        confidence: 0.9,
      }])
    }
  }

  // Get current file content
  const currentContent = await getFileAtHead(file, cwd)

  // Analyze semantic diffs for relevant commits
  const semanticDiffs: SemanticDiff[] = []
  const targetDate = new Date().toISOString()

  for (const commit of history.slice(0, 10)) {
    const commitFiles = await getCommitFiles(commit.hash, cwd)
    if (!commitFiles.includes(file)) continue

    // Get the file content at the parent commit (returns '' if file didn't exist)
    const prevContent = await getFileAtCommit(file, `${commit.hash}^`, cwd)

    if (prevContent.length > 0 && currentContent.length > 0) {
      const diff = analyzeSemanticDiff(prevContent, currentContent, file, commit.hash)
      semanticDiffs.push(diff)
    }
  }

  // Perform reproduction
  const reproduction = await reproduceFromFile(file, cwd)
  if (!reproduction.established) {
    limitations.push(reproduction.limitation ?? 'Could not establish reproduction')
  }

  // Score candidates
  const candidates = rankCandidates(
    history.map((commit) => {
      const commitNodeId = findNodesByCommit(graph, commit.hash)[0]?.id ?? ''
      const signals: ScoringSignal[] = [
        scoreBlameRelevance(blameEntries, commit.hash, line),
        scoreSemanticRelevance(
          semanticDiffs.find((d) => d.commitHash.startsWith(commit.hash))?.categories ?? [],
          (semanticDiffs.find((d) => d.commitHash.startsWith(commit.hash))?.behavioralChanges.length ?? 0) > 0,
        ),
        scoreTemporalProximity(commit.date, targetDate, history.length),
        scoreBehavioralChange(commit.message, semanticDiffs.find((d) => d.commitHash.startsWith(commit.hash))?.categories ?? []),
        scoreCallGraphRelevance(graph, commitNodeId, targetNodeId),
        scoreTestEvidence(commit.message, commit.filesChanged),
        scoreCodeOverlap(blameEntries, commit.hash, line, currentContent?.split('\n').length ?? 100),
        scoreRenameContinuity(provenance, commit.hash),
        scoreCounterfactual(false, false),
      ]

      const chain = findCausalChain(graph, commit.hash, targetNodeId)

      return {
        commitHash: commit.hash,
        nodeId: commitNodeId,
        label: commit.message.slice(0, 80),
        signals,
        causalChain: chain ?? [commit.hash, targetNodeId],
        counterfactualVerified: false,
      }
    }),
  )

  // Try counterfactual on top candidate
  let counterfactual: CounterfactualResult = {
    performed: false,
    candidateCausal: false,
    counterfactualReproduction: { established: false, bugConfirmed: false, output: '' },
    explanation: 'Counterfactual analysis not performed',
  }

  if (candidates.length > 0 && reproduction.bugConfirmed) {
    const topCandidate = candidates[0]!
    counterfactual = await performCounterfactual(topCandidate.commitHash, file, cwd)

    if (counterfactual.performed) {
      topCandidate.counterfactualVerified = counterfactual.candidateCausal

      // Re-score with counterfactual evidence
      const cfSignal = scoreCounterfactual(counterfactual.candidateCausal, true)
      topCandidate.scoringBreakdown.push(cfSignal)
      topCandidate.confidence = Math.round(
        (topCandidate.scoringBreakdown.reduce((sum, s) => sum + s.score * s.weight, 0) /
          topCandidate.scoringBreakdown.reduce((sum, s) => sum + s.weight, 0)) * 100,
      ) / 100
    }
  }

  // Build causal chain summary
  const chainSummary = candidates.length > 0
    ? buildChainSummary(candidates[0]!, history, file)
    : 'No causal chain identified'

  // Compute overall confidence
  const overallConfidence = candidates.length > 0
    ? candidates[0]!.confidence
    : 0

  return {
    target: { file, line },
    observedBehavior: options.observedBehavior,
    graph,
    candidates,
    semanticDiffs,
    provenance,
    reproduction,
    counterfactual,
    causalChainSummary: chainSummary,
    overallConfidence,
    limitations,
  }
}

/** Run the full causal fix pipeline. */
export async function runCausalFix(
  debugResult: CausalDebugResult,
  cwd: string,
): Promise<CausalFixResult> {
  const { candidates, semanticDiffs, target } = debugResult

  if (candidates.length === 0) {
    throw new Error('No root cause identified — cannot generate fix')
  }

  const rootCause = candidates[0]!

  // Generate repair plan
  const repairPlan = await generateRepairPlan(rootCause, semanticDiffs, target.file, cwd)

  // Generate patch
  const patch = await generatePatch(repairPlan, target.file, rootCause.commitHash, cwd)

  // Generate regression test
  const regressionTest = await generateRegressionTest(rootCause, target.file, semanticDiffs, cwd)

  // Verify test fails before fix (if we have a test)
  let failsBeforeFix = false
  if (regressionTest.code) {
    failsBeforeFix = await verifyTestFailsBeforeFix(regressionTest.code, regressionTest.filePath, cwd)
    regressionTest.failsBeforeFix = failsBeforeFix
  }

  // Run verifications
  const verification = await runAllVerifications(cwd)

  // Risk assessment
  const risk = assessRisk(repairPlan, patch, rootCause.confidence)

  // Determine if fix was applied
  const fixApplied = patch.applied

  // Determine if all verifications passed
  const allVerified = verification.every((v) => v.status === 'PASS' || v.status === 'NOT_AVAILABLE')

  return {
    rootCause,
    repairPlan,
    patch,
    regressionTest,
    verification,
    risk,
    fixApplied,
    allVerified,
  }
}

/** Build a human-readable causal chain summary. */
function buildChainSummary(
  candidate: RootCauseCandidate,
  history: Array<{ hash: string; message: string }>,
  file: string,
): string {
  const parts: string[] = []
  parts.push(`Root cause: ${candidate.commitHash.slice(0, 8)} — "${candidate.label}"`)
  parts.push(`Confidence: ${Math.round(candidate.confidence * 100)}% (${candidate.level})`)

  if (candidate.causalChain.length > 2) {
    parts.push(`Chain: ${candidate.causalChain.length} node(s)`)
  }

  return parts.join(' | ')
}
