// Core type definitions for the Causal Debugging & Repair Engine.
// These types distinguish between facts, evidence, inferences, and confidence levels.

/** Evidence classification: what kind of knowledge this represents. */
export type EvidenceKind = 'fact' | 'evidence' | 'inference' | 'assumption'

/** Confidence level for probabilistic claims. */
export type ConfidenceLevel = 'certain' | 'high' | 'medium' | 'low' | 'speculative'

/** Edge types in the causal graph. */
export type EdgeType =
  | 'introduced'      // commit introduced this code
  | 'modified'        // commit modified this code
  | 'moved'           // code was moved from one location to another
  | 'renamed'         // code was renamed
  | 'calls'           // function A calls function B
  | 'depends_on'      // module A imports/depends on module B
  | 'regressed'       // commit introduced a regression
  | 'tested_by'       // code is tested by a specific test
  | 'caused'          // A caused B (causal relationship)
  | 'fixed_by'        // A was fixed by B
  | 'behavioral_change'  // A's behavior changed
  | 'overlaps_with'   // code regions overlap semantically

/** Node types in the causal graph. */
export type NodeType = 'commit' | 'file' | 'function' | 'line_region' | 'test' | 'error' | 'dependency'

/** A node in the causal graph. */
export interface CausalNode {
  id: string
  type: NodeType
  label: string
  /** Path to file if applicable. */
  filePath?: string
  /** Line range if applicable. */
  startLine?: number
  endLine?: number
  /** Commit hash if type is 'commit'. */
  commitHash?: string
  /** Metadata specific to the node type. */
  metadata: Record<string, unknown>
}

/** An edge in the causal graph. */
export interface CausalEdge {
  id: string
  source: string   // node ID
  target: string   // node ID
  type: EdgeType
  /** How confident we are in this edge. */
  confidence: number
  /** Evidence supporting this edge. */
  evidence: EvidenceEntry[]
  /** Whether this edge was established from facts or inference. */
  kind: EvidenceKind
}

/** A piece of evidence supporting a claim. */
export interface EvidenceEntry {
  kind: EvidenceKind
  description: string
  source: string     // where this evidence came from (e.g., "git blame", "diff analysis")
  confidence: number // 0-1
  /** Optional detail for explainability. */
  detail?: string
}

/** The complete causal graph. */
export interface CausalGraph {
  nodes: Map<string, CausalNode>
  edges: Map<string, CausalEdge>
  /** Adjacency list: node ID -> outgoing edge IDs. */
  adjacency: Map<string, string[]>
  /** Reverse adjacency: node ID -> incoming edge IDs. */
  reverseAdj: Map<string, string[]>
}

/** A root-cause candidate with explainable scoring. */
export interface RootCauseCandidate {
  nodeId: string
  commitHash: string
  label: string
  confidence: number
  level: ConfidenceLevel
  /** Explainable breakdown of how confidence was computed. */
  scoringBreakdown: ScoringSignal[]
  /** Why this was selected or rejected. */
  explanation: string
  /** The causal chain leading to this candidate. */
  causalChain: string[]  // node IDs
  /** Whether this candidate was verified through counterfactual analysis. */
  counterfactualVerified: boolean
}

/** A single scoring signal contributing to root-cause confidence. */
export interface ScoringSignal {
  name: string
  score: number       // 0-1 contribution
  weight: number      // how important this signal is
  reason: string      // explainability
  kind: EvidenceKind  // fact, evidence, inference
}

/** Semantic change categories detected in a diff. */
export type SemanticChangeCategory =
  | 'control_flow'
  | 'return_value'
  | 'error_handling'
  | 'auth_change'
  | 'concurrency'
  | 'state_mutation'
  | 'api_contract'
  | 'dependency_change'
  | 'config_change'
  | 'type_change'
  | 'naming'
  | 'dead_code'
  | 'new_code'
  | 'removal'

/** A semantically analyzed diff. */
export interface SemanticDiff {
  filePath: string
  commitHash: string
  categories: SemanticChangeCategory[]
  /** Human-readable explanation of what behavior changed. */
  behavioralSummary: string
  /** Lines that represent behavioral changes (not just formatting). */
  behavioralChanges: Array<{
    startLine: number
    endLine: number
    description: string
    category: SemanticChangeCategory
  }>
  /** Functions/methods affected. */
  affectedSymbols: string[]
}

/** Git blame entry for a line. */
export interface BlameEntry {
  commit: string
  author: string
  date: string
  line: number
  content: string
  /** Previous commit if this line was moved/renamed. */
  previousCommit?: string
  previousPath?: string
}

/** Git commit metadata. */
export interface CommitInfo {
  hash: string
  shortHash: string
  author: string
  date: string
  message: string
  parents: string[]
  filesChanged: string[]
  insertions: number
  deletions: number
}

/** A code provenance entry tracking a line through renames/refactors. */
export interface ProvenanceEntry {
  commit: string
  path: string
  line: number
  action: 'authored' | 'modified' | 'moved' | 'renamed' | 'extracted'
  /** Similarity score for moves/renames (0-100 from git). */
  similarity?: number
}

/** Behavioral reproduction result. */
export interface ReproductionResult {
  established: boolean
  /** What command was used to reproduce. */
  command?: string
  /** Did the reproduction fail (confirming the bug exists)? */
  bugConfirmed: boolean
  /** The output of the reproduction attempt. */
  output: string
  /** Exit code if a command was run. */
  exitCode?: number
  /** Limitation message if reproduction could not be established. */
  limitation?: string
}

/** Counterfactual analysis result. */
export interface CounterfactualResult {
  /** Was the counterfactual analysis performed? */
  performed: boolean
  /** Did removing the candidate change make the failure disappear? */
  candidateCausal: boolean
  /** The worktree path used (cleaned up after). */
  worktreePath?: string
  /** Reproduction result in the counterfactual state. */
  counterfactualReproduction: ReproductionResult
  /** Explanation of the result. */
  explanation: string
  /** Limitation if analysis could not be completed. */
  limitation?: string
}

/** A repair plan entry. */
export interface RepairPlanStep {
  index: number
  description: string
  filePath: string
  startLine?: number
  endLine?: number
  /** The proposed change. */
  change: string
  /** Risk level of this step. */
  risk: 'low' | 'medium' | 'high'
  /** Why this change addresses the root cause. */
  rationale: string
}

/** A repair plan. */
export interface RepairPlan {
  steps: RepairPlanStep[]
  /** Minimal change summary. */
  summary: string
  /** Estimated risk of the entire plan. */
  overallRisk: 'low' | 'medium' | 'high'
  /** Confidence that this plan addresses the root cause. */
  confidence: number
  /** Alternative approaches considered. */
  alternatives: Array<{
    description: string
    tradeoffs: string
    rejected: boolean
  }>
}

/** A generated patch. */
export interface GeneratedPatch {
  filePath: string
  /** Unified diff format. */
  diff: string
  /** Files affected. */
  filesAffected: string[]
  /** Lines changed. */
  linesChanged: number
  /** Explanation of the change. */
  explanation: string
  /** Expected behavior after applying. */
  expectedBehavior: string
  /** Potential risks. */
  risks: string[]
  /** Confidence in the patch. */
  confidence: number
  /** Whether the patch has been applied. */
  applied: boolean
}

/** A generated regression test. */
export interface RegressionTest {
  /** The test file path. */
  filePath: string
  /** The test code. */
  code: string
  /** The behavioral invariant being tested. */
  invariant: string
  /** Framework used (jest, vitest, bun:test, etc.). */
  framework: string
  /** Did the test fail before the fix? */
  failsBeforeFix: boolean
  /** Did the test pass after the fix? */
  passesAfterFix: boolean
  /** Limitation if test generation had issues. */
  limitation?: string
}

/** Verification status for each check. */
export type VerificationStatus = 'PASS' | 'FAIL' | 'NOT_RUN' | 'NOT_AVAILABLE'

/** A single verification result. */
export interface VerificationCheck {
  name: string
  status: VerificationStatus
  command?: string
  output?: string
  exitCode?: number
}

/** Risk assessment result. */
export interface RiskAssessment {
  overallRisk: 'low' | 'medium' | 'high' | 'critical'
  score: number  // 0-100
  factors: Array<{
    name: string
    contribution: number
    description: string
  }>
  recommendation: string
}

/** The complete causal debug result. */
export interface CausalDebugResult {
  /** The target being investigated. */
  target: { file: string; line?: number }
  /** Observed behavior / failure description. */
  observedBehavior?: string
  /** The causal graph built during analysis. */
  graph: CausalGraph
  /** Root-cause candidates ranked by confidence. */
  candidates: RootCauseCandidate[]
  /** Semantic diffs for relevant commits. */
  semanticDiffs: SemanticDiff[]
  /** Code provenance trace. */
  provenance: ProvenanceEntry[]
  /** Behavioral reproduction result. */
  reproduction: ReproductionResult
  /** Counterfactual analysis result. */
  counterfactual: CounterfactualResult
  /** The causal chain from earliest cause to current code. */
  causalChainSummary: string
  /** Overall confidence in the analysis. */
  overallConfidence: number
  /** Limitations of the analysis. */
  limitations: string[]
}

/** The complete causal fix result. */
export interface CausalFixResult {
  /** The root cause that was fixed. */
  rootCause: RootCauseCandidate
  /** The repair plan. */
  repairPlan: RepairPlan
  /** The generated patch. */
  patch: GeneratedPatch
  /** Regression test generated. */
  regressionTest: RegressionTest
  /** Verification results. */
  verification: VerificationCheck[]
  /** Risk assessment. */
  risk: RiskAssessment
  /** Whether the fix was applied successfully. */
  fixApplied: boolean
  /** Whether all verifications passed. */
  allVerified: boolean
}
