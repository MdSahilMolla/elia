export interface EvaluationRow {
  id: string
  probability: number
  outcome: 0 | 1
  baselineProbability?: number
  split: 'development' | 'held-out'
}

export interface EvaluationSummary {
  count: number
  brier: number | null
  baselineBrier: number | null
  calibration: { bucket: string; count: number; predicted: number; observed: number }[]
}

function probability(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error('probability must be between 0 and 1')
  return value
}

export function evaluateHeldOut(rows: EvaluationRow[]): EvaluationSummary {
  const heldOut = rows.filter((row) => row.split === 'held-out')
  if (heldOut.length === 0) return { count: 0, brier: null, baselineBrier: null, calibration: [] }
  let brier = 0
  let baselineTotal = 0
  let baselineCount = 0
  const buckets = Array.from({ length: 10 }, () => ({ count: 0, predicted: 0, observed: 0 }))
  for (const row of heldOut) {
    const p = probability(row.probability)
    brier += (p - row.outcome) ** 2
    if (row.baselineProbability !== undefined) {
      const baseline = probability(row.baselineProbability)
      baselineTotal += (baseline - row.outcome) ** 2
      baselineCount += 1
    }
    const index = Math.min(9, Math.floor(p * 10))
    const bucket = buckets[index]!
    bucket.count += 1
    bucket.predicted += p
    bucket.observed += row.outcome
  }
  return {
    count: heldOut.length,
    brier: brier / heldOut.length,
    baselineBrier: baselineCount > 0 ? baselineTotal / baselineCount : null,
    calibration: buckets.flatMap((bucket, index) => bucket.count === 0 ? [] : [{ bucket: `${index / 10}-${(index + 1) / 10}`, count: bucket.count, predicted: bucket.predicted / bucket.count, observed: bucket.observed / bucket.count }]),
  }
}
