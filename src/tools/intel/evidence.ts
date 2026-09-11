// Shared evidence model: every significant conclusion carries provenance.
//
// Evidence is the backbone of Elia's explainability guarantee. A finding that
// cannot point at the source of its confidence — a source location, an AST
// relationship, a git commit, a test result, a runtime output, a benchmark, a
// remembered lesson, a specification, or an architectural rule — must not be
// presented as fact.
//
// Tools create evidence deterministically from the analysis they actually ran,
// and never raise confidence beyond what that analysis supports.

export type EvidenceKind =
  | 'source_location'
  | 'ast_relationship'
  | 'data_flow'
  | 'git_commit'
  | 'test_result'
  | 'runtime_output'
  | 'benchmark'
  | 'historical_memory'
  | 'specification'
  | 'architectural_rule'
  | 'static_scan'

export interface Evidence {
  /** The category of provenance backing this claim. */
  kind: EvidenceKind
  /** Human-readable claim this evidence supports. */
  description: string
  /** Normalized 0-1 confidence. Never exceeds what `kind` can support. */
  confidence: number
  /** `file:line` style location, when the evidence is source-bound. */
  location?: string
  /** Provenance source: commit hash, memory id, spec file, rule name. */
  source?: string
  /** ISO timestamp of capture. */
  capturedAt?: string
  /** True when the finding can be reproduced by rerunning the same analysis. */
  reproducible?: boolean
}

/** Maximum confidence a given evidence kind can honestly claim. */
export const KIND_CEILING: Record<EvidenceKind, number> = {
  test_result: 0.95,
  runtime_output: 0.95,
  git_commit: 0.9,
  source_location: 0.85,
  ast_relationship: 0.8,
  data_flow: 0.75,
  benchmark: 0.85,
  specification: 0.7,
  architectural_rule: 0.7,
  historical_memory: 0.6,
  static_scan: 0.45,
}

/** Clamp any confidence value into the 0-1 range. */
export function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/** Rescale a 0-100 score into a 0-1 confidence. */
export function scaleConfidence(value: number): number {
  return clampConfidence(value / 100)
}

/**
 * Build an evidence record, capping raw confidence at what the evidence kind
 * can honestly support. A static scan may never claim test-level certainty.
 */
export function makeEvidence(input: {
  kind: EvidenceKind
  description: string
  confidence?: number
  location?: string
  source?: string
  reproducible?: boolean
}): Evidence {
  const ceiling = KIND_CEILING[input.kind]
  const raw = clampConfidence(input.confidence ?? ceiling)
  const confidence = Math.min(ceiling, raw)
  return {
    kind: input.kind,
    description: input.description,
    confidence: Math.round(confidence * 100) / 100,
    ...(input.location ? { location: input.location } : {}),
    ...(input.source ? { source: input.source } : {}),
    capturedAt: new Date().toISOString(),
    reproducible: input.reproducible ?? input.kind !== 'static_scan',
  }
}

/**
 * Merge a set of supporting evidence into an overall confidence: the strongest
 * piece sets the ceiling, corroboration adds a fraction of the remainder.
 */
export function combineEvidence(evidence: Evidence[]): { confidence: number; count: number } {
  if (evidence.length === 0) return { confidence: 0, count: 0 }
  let best = 0
  let sum = 0
  for (const e of evidence) {
    best = Math.max(best, e.confidence)
    sum += e.confidence
  }
  // The strongest piece sets the ceiling; the average of the remaining pieces
  // corroborates it, closing a fraction of the gap to 1.0.
  const rest = (sum - best) / Math.max(1, evidence.length - 1)
  const confidence = clampConfidence(best + (1 - best) * rest * 0.5)
  return { confidence: Math.round(confidence * 100) / 100, count: evidence.length }
}

/** Compact one-line rendering of an evidence record, for inclusion in reports. */
export function formatEvidence(e: Evidence): string {
  const where = e.location ? ` @${e.location}` : ''
  const source = e.source ? ` (${e.source})` : ''
  return `[${e.kind}] ${e.description}${where}${source} conf=${Math.round(e.confidence * 100)}%`
}