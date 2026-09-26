import type { Frame } from '../frame.ts'
import type { Rng } from '../rng.ts'
import { mean, quantileSorted } from '../stats/describe.ts'
import { isMissing, toNumber, type Scalar } from '../values.ts'
import type { ModelArtifact } from './automl.ts'
import { explainRow, predictModel } from './models.ts'
import { transformRecord } from './preprocess.ts'

/**
 * Model explanation: partial dependence with individual conditional expectation curves for
 * a feature, and local explanations of single predictions in terms of the original input
 * columns (one-hot and date parts are summed back to the column they came from).
 */

function outputOf(artifact: ModelArtifact, x: number[][]): number[] {
  const prediction = predictModel(artifact.model, x)
  if (artifact.task === 'regression') return prediction.values
  if (artifact.task === 'binary') return prediction.probabilities!.map((row) => row[1]!)
  return prediction.probabilities!.map((row) => Math.max(...row))
}

export function partialDependence(artifact: ModelArtifact, frame: Frame, feature: string, rng: Rng, options: { gridSize?: number; sample?: number; iceLines?: number } = {}): { feature: string; grid: Scalar[]; average: number[]; ice: Array<{ row: number; values: number[] }>; output: string; note: string } {
  if (!artifact.features.includes(feature)) throw new Error(`"${feature}" is not a feature of this model; features: ${artifact.features.join(', ')}`)
  const rows = frame.rows.length > (options.sample ?? 500) ? rng.shuffle(frame.rows.map((_, index) => index)).slice(0, options.sample ?? 500) : frame.rows.map((_, index) => index)
  const values = rows.map((index) => frame.rows[index]![feature]).filter((value) => !isMissing(value)) as Scalar[]
  let grid: Scalar[]
  const numeric = values.every((value) => toNumber(value) !== undefined) && frame.types[feature] !== 'string'
  if (numeric) {
    const sorted = values.map((value) => toNumber(value)!).sort((a, b) => a - b)
    const size = options.gridSize ?? 20
    grid = [...new Set(Array.from({ length: size }, (_, index) => quantileSorted(sorted, 0.02 + (0.96 * index) / (size - 1))))]
  } else {
    const counts = new Map<string, number>()
    for (const value of values) counts.set(String(value), (counts.get(String(value)) ?? 0) + 1)
    grid = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([level]) => level)
  }
  const curves = rows.map((index) => {
    const record = frame.rows[index]!
    return outputOf(artifact, grid.map((value) => transformRecord(artifact.preprocessor, { ...record, [feature]: value })))
  })
  const average = grid.map((_, g) => mean(curves.map((curve) => curve[g]!)))
  const iceCount = Math.min(options.iceLines ?? 10, rows.length)
  return {
    feature,
    grid,
    average,
    ice: rows.slice(0, iceCount).map((row, index) => ({ row, values: curves[index]! })),
    output: artifact.task === 'regression' ? `predicted ${artifact.target}` : artifact.task === 'binary' ? `P(${artifact.target} = ${artifact.positiveClass})` : 'probability of the predicted class',
    note: 'Partial dependence shows the model’s average response when this feature is set to each value with the others held at their observed values. It describes the model, not causation, and can mislead when features are strongly correlated (the curve then visits combinations that never occur); diverging ICE lines indicate interactions.',
  }
}

export function explainPrediction(artifact: ModelArtifact, record: Record<string, Scalar>, top = 10): { prediction: number; method: string; baseValue: number; contributions: Array<{ feature: string; value: Scalar; contribution: number }>; output: string } {
  const row = transformRecord(artifact.preprocessor, record)
  const baseline = transformRecord(artifact.preprocessor, Object.fromEntries(artifact.preprocessor.features.map((feature) => [feature.name, null])))
  const explanation = explainRow(artifact.model, row, baseline)
  const totals = new Map<string, number>()
  explanation.contributions.forEach((value, index) => {
    const source = artifact.preprocessor.sources[index]!
    totals.set(source, (totals.get(source) ?? 0) + value)
  })
  const contributions = [...totals.entries()].map(([feature, contribution]) => ({ feature, value: record[feature] ?? null, contribution })).sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution)).slice(0, top)
  const prediction = predictModel(artifact.model, [row])
  const value = artifact.task === 'regression' ? prediction.values[0]! : artifact.task === 'binary' ? prediction.probabilities![0]![1]! : Math.max(...prediction.probabilities![0]!)
  return { prediction: value, method: explanation.method, baseValue: explanation.bias, contributions, output: artifact.task === 'regression' ? artifact.target : artifact.task === 'binary' ? `P(${artifact.target} = ${artifact.positiveClass}); tree and logistic contributions are in log-odds` : 'class probability' }
}
