// Shared risk model: risk is not severity.
//
// A finding's risk is assessed across multiple named dimensions — severity,
// exploitability, exposure, impact, affected surface, reversibility,
// production criticality, recurrence — each normalized to 0-100 and weighted.
// The result is a deterministic 0-100 score with every point explainable.
//
// Confidence is carried alongside the score rather than silently folding into
// it: weak evidence must not inflate risk, but it must also not hide a real
// problem. Tools merge their evidence strength into the dimensions they supply.

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical'

export interface RiskDimension {
  name: string
  /** Relative importance of this dimension in the final score. */
  weight: number
  /** Normalized 0-100 severity for this dimension. */
  score: number
  /** Why this score was assigned. */
  description: string
}

export interface RiskModel {
  /** Normalized 0-100 risk score. */
  score: number
  level: RiskLevel
  dimensions: RiskDimension[]
  /** Per-dimension rationale lines plus any modifiers. */
  explanation: string[]
  /** Overall confidence in the assessment (0-1). */
  confidence: number
  /** Where the confidence came from. */
  confidenceSource?: string
}

/** Standard risk dimensions, keyed for easy reuse by tools. */
export const DEFAULT_RISK_WEIGHTS: Record<string, number> = {
  severity: 0.25,
  exploitability: 0.2,
  exposure: 0.15,
  impact: 0.15,
  affected_surface: 0.1,
  reversibility: 0.05,
  production_criticality: 0.05,
  recurrence: 0.05,
}

/** Map a 0-100 score onto the four-level risk scale. */
export function riskLevelFor(score: number): RiskLevel {
  const clamped = clampRiskScore(score)
  if (clamped >= 75) return 'critical'
  if (clamped >= 50) return 'high'
  if (clamped >= 25) return 'medium'
  return 'low'
}

/** Clamp and round a normalized 0-100 risk score. */
export function clampRiskScore(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.round(Math.min(100, Math.max(0, value)))
}

/**
 * Assess risk from weighted dimensions. Weights are normalized against the sum
 * of the supplied weights, so partial dimension sets still produce a 0-100
 * score. Supply an evidence-backed `confidence` to record how much the
 * assessment can be trusted.
 */
export function assessRisk(
  dimensions: RiskDimension[],
  options?: { confidence?: number; confidenceSource?: string; levelOverride?: (score: number) => RiskLevel },
): RiskModel {
  if (dimensions.length === 0) {
    return {
      score: 0,
      level: 'low',
      dimensions: [],
      explanation: ['No risk dimensions supplied — no risk can be assessed.'],
      confidence: 0,
    }
  }

  const totalWeight = dimensions.reduce((sum, d) => sum + Math.max(0, d.weight), 0)
  const weighted = dimensions.reduce((sum, d) => sum + clampRiskScore(d.score) * Math.max(0, d.weight), 0)
  const score = clampRiskScore(totalWeight > 0 ? weighted / totalWeight : 0)

  const explanation = dimensions.map((d) => {
    const contribution = totalWeight > 0 ? (Math.max(0, d.weight) / totalWeight) * clampRiskScore(d.score) : 0
    return `${d.name} (weight ${d.weight}, score ${clampRiskScore(d.score)}): ${d.description} → contributes ${Math.round(contribution)}/100`
  })

  const level = options?.levelOverride ? options.levelOverride(score) : riskLevelFor(score)
  const confidence = options?.confidence !== undefined ? Math.min(1, Math.max(0, options.confidence)) : 0.5

  return {
    score,
    level,
    dimensions: [...dimensions],
    explanation,
    confidence,
    ...(options?.confidenceSource ? { confidenceSource: options.confidenceSource } : {}),
  }
}

/**
 * Merge multiple risk models into one for composition: the score reflects the
 * worst credible assessment and confidence reflects the weakest supporting
 * evidence.
 */
export function combineRisks(risks: RiskModel[]): RiskModel {
  if (risks.length === 0) {
    return { score: 0, level: 'low', dimensions: [], explanation: [], confidence: 0 }
  }
  const worst = risks.reduce((maxRisk, r) => (r.score > maxRisk.score ? r : maxRisk), risks[0]!)
  const confidence = Math.min(...risks.map((r) => r.confidence))
  return {
    score: worst.score,
    level: worst.level,
    dimensions: risks.flatMap((r) => r.dimensions),
    explanation: [
      `Worst credible assessment: ${worst.score}/100 (${worst.level}).`,
      ...risks.flatMap((r) => r.explanation),
    ],
    confidence,
  }
}

/** One-line rendering of a risk model for report headers. */
export function formatRisk(risk: RiskModel): string {
  return `Risk: ${risk.score}/100 (${risk.level.toUpperCase()}) — confidence ${Math.round(risk.confidence * 100)}%`
}