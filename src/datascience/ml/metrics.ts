import { mean, median } from '../stats/describe.ts'

/**
 * Evaluation metrics. Classification metrics take integer class indices (0..k-1) and, where
 * needed, a probability matrix with one column per class. Every metric is defined for the
 * degenerate cases (a single class present, zero predicted positives) rather than NaN-ing.
 */

export function regressionMetrics(actual: number[], predicted: number[]): Record<string, number> {
  const n = actual.length
  const errors = actual.map((value, index) => value - predicted[index]!)
  const absolute = errors.map(Math.abs)
  const my = mean(actual)
  const sse = errors.reduce((total, e) => total + e * e, 0)
  const sst = actual.reduce((total, value) => total + (value - my) ** 2, 0)
  const nonZero = actual.map((value, index) => ({ value, index })).filter(({ value }) => value !== 0)
  const mape = nonZero.length ? mean(nonZero.map(({ value, index }) => Math.abs((value - predicted[index]!) / value))) : Number.NaN
  const smape = mean(actual.map((value, index) => { const d = Math.abs(value) + Math.abs(predicted[index]!); return d === 0 ? 0 : (2 * Math.abs(value - predicted[index]!)) / d }))
  return {
    rmse: Math.sqrt(sse / n),
    mae: mean(absolute),
    medianAbsoluteError: median(absolute),
    r2: sst === 0 ? 0 : 1 - sse / sst,
    mape,
    smape,
    bias: -mean(errors),
    n,
  }
}

export function confusionMatrix(actual: number[], predicted: number[], k: number): number[][] {
  const matrix = Array.from({ length: k }, () => new Array<number>(k).fill(0))
  actual.forEach((value, index) => { matrix[value]![predicted[index]!]!++ })
  return matrix
}

/** Area under the ROC curve by the rank statistic, with ties handled. */
export function rocAuc(labels: number[], scores: number[]): number {
  const positives = labels.filter((label) => label === 1).length
  const negatives = labels.length - positives
  if (positives === 0 || negatives === 0) return Number.NaN
  const order = scores.map((score, index) => ({ score, label: labels[index]! })).sort((a, b) => a.score - b.score)
  let rankSum = 0
  let index = 0
  while (index < order.length) {
    let end = index
    while (end + 1 < order.length && order[end + 1]!.score === order[index]!.score) end++
    const averageRank = (index + end) / 2 + 1
    for (let k = index; k <= end; k++) if (order[k]!.label === 1) rankSum += averageRank
    index = end + 1
  }
  return (rankSum - (positives * (positives + 1)) / 2) / (positives * negatives)
}

/** Average precision (area under the precision–recall curve, step interpolation as in scikit-learn). */
export function averagePrecision(labels: number[], scores: number[]): number {
  const positives = labels.filter((label) => label === 1).length
  if (positives === 0) return Number.NaN
  const order = scores.map((score, index) => ({ score, label: labels[index]! })).sort((a, b) => b.score - a.score)
  let tp = 0
  let fp = 0
  let previousRecall = 0
  let ap = 0
  let index = 0
  while (index < order.length) {
    let end = index
    while (end + 1 < order.length && order[end + 1]!.score === order[index]!.score) end++
    for (let k = index; k <= end; k++) (order[k]!.label === 1 ? tp++ : fp++)
    const recall = tp / positives
    const precision = tp / (tp + fp)
    ap += (recall - previousRecall) * precision
    previousRecall = recall
    index = end + 1
  }
  return ap
}

export function logLoss(labels: number[], probabilities: number[][]): number {
  const eps = 1e-15
  return mean(labels.map((label, index) => -Math.log(Math.min(1 - eps, Math.max(eps, probabilities[index]![label]!)))))
}

export function classificationMetrics(actual: number[], predicted: number[], probabilities: number[][] | undefined, classes: string[]): Record<string, unknown> {
  const k = classes.length
  const n = actual.length
  const cm = confusionMatrix(actual, predicted, k)
  const perClass = classes.map((label, c) => {
    const tp = cm[c]![c]!
    const fp = cm.reduce((total, row, r) => total + (r === c ? 0 : row[c]!), 0)
    const fn = cm[c]!.reduce((total, value, j) => total + (j === c ? 0 : value), 0)
    const precision = tp + fp === 0 ? 0 : tp / (tp + fp)
    const recall = tp + fn === 0 ? 0 : tp / (tp + fn)
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)
    return { class: label, precision, recall, f1, support: tp + fn }
  })
  const accuracy = actual.filter((value, index) => value === predicted[index]).length / n
  const macro = (key: 'precision' | 'recall' | 'f1') => mean(perClass.map((entry) => entry[key]))
  const weighted = (key: 'precision' | 'recall' | 'f1') => perClass.reduce((total, entry) => total + entry[key] * entry.support, 0) / n
  const expectedAgreement = cm.reduce((total, row, c) => total + (row.reduce((a, b) => a + b, 0) * cm.reduce((t, r) => t + r[c]!, 0)) / (n * n), 0)
  const kappa = expectedAgreement === 1 ? 0 : (accuracy - expectedAgreement) / (1 - expectedAgreement)
  const out: Record<string, unknown> = {
    accuracy,
    balancedAccuracy: macro('recall'),
    macroF1: macro('f1'),
    weightedF1: weighted('f1'),
    macroPrecision: macro('precision'),
    macroRecall: macro('recall'),
    cohenKappa: kappa,
    confusionMatrix: { labels: classes, matrix: cm },
    perClass,
    n,
  }
  if (k === 2) {
    const tp = cm[1]![1]!
    const tn = cm[0]![0]!
    const fp = cm[0]![1]!
    const fn = cm[1]![0]!
    const denominator = Math.sqrt((tp + fp) * (tp + fn) * (tn + fp) * (tn + fn))
    out.precision = perClass[1]!.precision
    out.recall = perClass[1]!.recall
    out.f1 = perClass[1]!.f1
    out.specificity = tn + fp === 0 ? 0 : tn / (tn + fp)
    out.mcc = denominator === 0 ? 0 : (tp * tn - fp * fn) / denominator
    out.positiveClass = classes[1]
  }
  if (probabilities) {
    out.logLoss = logLoss(actual, probabilities)
    if (k === 2) {
      const scores = probabilities.map((row) => row[1]!)
      out.rocAuc = rocAuc(actual, scores)
      out.prAuc = averagePrecision(actual, scores)
      out.brier = mean(actual.map((label, index) => (scores[index]! - label) ** 2))
    } else {
      const aucs = classes.map((_, c) => rocAuc(actual.map((label) => (label === c ? 1 : 0)), probabilities.map((row) => row[c]!))).filter(Number.isFinite)
      out.rocAucOvrMacro = aucs.length ? mean(aucs) : Number.NaN
    }
  }
  return out
}

export interface CalibrationBin {
  lower: number
  upper: number
  meanPredicted: number
  observedRate: number
  count: number
}

/** Reliability diagram bins and the expected calibration error for binary probabilities. */
export function calibration(labels: number[], scores: number[], bins = 10): { bins: CalibrationBin[]; ece: number; maxCalibrationError: number } {
  const out: CalibrationBin[] = []
  let ece = 0
  let mce = 0
  for (let b = 0; b < bins; b++) {
    const lower = b / bins
    const upper = (b + 1) / bins
    const members = scores.map((score, index) => ({ score, label: labels[index]! })).filter(({ score }) => score >= lower && (b === bins - 1 ? score <= upper : score < upper))
    if (members.length === 0) continue
    const meanPredicted = mean(members.map((m) => m.score))
    const observedRate = mean(members.map((m) => m.label))
    out.push({ lower, upper, meanPredicted, observedRate, count: members.length })
    const gap = Math.abs(meanPredicted - observedRate)
    ece += (members.length / scores.length) * gap
    mce = Math.max(mce, gap)
  }
  return { bins: out, ece, maxCalibrationError: mce }
}

export interface ThresholdRow {
  threshold: number
  precision: number
  recall: number
  f1: number
  specificity: number
  predictedPositiveRate: number
  expectedCost?: number
}

/** Metrics across decision thresholds, and the thresholds that maximise F1 and Youden's J (or minimise cost). */
export function thresholdAnalysis(labels: number[], scores: number[], costs?: { falsePositive: number; falseNegative: number }): { table: ThresholdRow[]; bestF1: ThresholdRow; bestYouden: ThresholdRow; minimumCost?: ThresholdRow } {
  const table: ThresholdRow[] = []
  const positives = labels.filter((label) => label === 1).length
  const negatives = labels.length - positives
  for (let step = 1; step < 100; step++) {
    const threshold = step / 100
    let tp = 0
    let fp = 0
    for (let index = 0; index < labels.length; index++) {
      if (scores[index]! >= threshold) labels[index] === 1 ? tp++ : fp++
    }
    const fn = positives - tp
    const tn = negatives - fp
    const precision = tp + fp === 0 ? 1 : tp / (tp + fp)
    const recall = positives === 0 ? 0 : tp / positives
    const row: ThresholdRow = { threshold, precision, recall, f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall), specificity: negatives === 0 ? 0 : tn / negatives, predictedPositiveRate: (tp + fp) / labels.length }
    if (costs) row.expectedCost = (fp * costs.falsePositive + fn * costs.falseNegative) / labels.length
    table.push(row)
  }
  const bestF1 = table.reduce((best, row) => (row.f1 > best.f1 ? row : best))
  const bestYouden = table.reduce((best, row) => (row.recall + row.specificity > best.recall + best.specificity ? row : best))
  return { table: table.filter((_, index) => index % 5 === 4 || table[index] === bestF1 || table[index] === bestYouden), bestF1, bestYouden, ...(costs ? { minimumCost: table.reduce((best, row) => (row.expectedCost! < best.expectedCost! ? row : best)) } : {}) }
}

/** Cumulative gains and lift by score decile. */
export function liftTable(labels: number[], scores: number[], groups = 10): Array<{ decile: number; rows: number; positives: number; rate: number; lift: number; cumulativeCapture: number }> {
  const order = scores.map((score, index) => ({ score, label: labels[index]! })).sort((a, b) => b.score - a.score)
  const base = mean(labels)
  const total = labels.filter((label) => label === 1).length
  const out = []
  let captured = 0
  for (let g = 0; g < groups; g++) {
    const slice = order.slice(Math.floor((g * order.length) / groups), Math.floor(((g + 1) * order.length) / groups))
    const positives = slice.filter((entry) => entry.label === 1).length
    captured += positives
    out.push({ decile: g + 1, rows: slice.length, positives, rate: slice.length ? positives / slice.length : 0, lift: base === 0 || slice.length === 0 ? 0 : positives / slice.length / base, cumulativeCapture: total ? captured / total : 0 })
  }
  return out
}

export type MetricName = 'rmse' | 'mae' | 'r2' | 'mape' | 'accuracy' | 'balancedAccuracy' | 'macroF1' | 'f1' | 'rocAuc' | 'prAuc' | 'logLoss' | 'brier' | 'rocAucOvrMacro' | 'weightedF1' | 'mcc'

export const LOWER_IS_BETTER = new Set<string>(['rmse', 'mae', 'mape', 'smape', 'logLoss', 'brier', 'medianAbsoluteError'])

export function metricValue(metrics: Record<string, unknown>, name: string): number {
  const value = metrics[name]
  return typeof value === 'number' ? value : Number.NaN
}
