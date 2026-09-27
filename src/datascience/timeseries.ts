import type { Frame } from './frame.ts'
import { fitModel, predictModel } from './ml/models.ts'
import { createRng } from './rng.ts'
import { mean, median, quantileSorted, standardDeviation } from './stats/describe.ts'
import { ols } from './stats/glm.ts'
import { nelderMead } from './stats/optimize.ts'
import { crossVec, gram, inverseSPD, matVec } from './stats/linalg.ts'
import { chiSquareSf, normalQuantile } from './stats/special.ts'
import { isoDate, isoDateTime, toDateMs, toNumber } from './values.ts'

/**
 * Time-series analysis and forecasting. Series are first put on a regular calendar grid
 * (missing periods are made explicit, never silently skipped). Forecast models are compared
 * by rolling-origin backtests — always trained on the past and scored on the future — and
 * prediction intervals come from the backtest errors at each horizon step, so their width
 * reflects how wrong the model has actually been.
 */

export type Frequency = 'hour' | 'day' | 'week' | 'month' | 'quarter' | 'year'

export interface Series {
  dates: string[]
  values: Array<number | null>
  frequency: Frequency
  seasonPeriod: number
  filledPeriods: number
  aggregatedRows: number
}

const PERIODS: Record<Frequency, number> = { hour: 24, day: 7, week: 52, month: 12, quarter: 4, year: 1 }

function truncate(ms: number, frequency: Frequency): number {
  const d = new Date(ms)
  switch (frequency) {
    case 'hour': return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours())
    case 'day': return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
    case 'week': { const day = (d.getUTCDay() + 6) % 7; return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day) }
    case 'month': return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
    case 'quarter': return Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3, 1)
    case 'year': return Date.UTC(d.getUTCFullYear(), 0, 1)
  }
}

export function advance(ms: number, frequency: Frequency, steps = 1): number {
  const d = new Date(ms)
  switch (frequency) {
    case 'hour': return ms + steps * 3_600_000
    case 'day': return ms + steps * 86_400_000
    case 'week': return ms + steps * 7 * 86_400_000
    case 'month': return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + steps, 1)
    case 'quarter': return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 3 * steps, 1)
    case 'year': return Date.UTC(d.getUTCFullYear() + steps, 0, 1)
  }
}

export function inferFrequency(ms: number[]): Frequency {
  const unique = [...new Set(ms)].sort((a, b) => a - b)
  if (unique.length < 3) return 'day'
  const gaps = unique.slice(1).map((value, index) => (value - unique[index]!) / 86_400_000).sort((a, b) => a - b)
  const gap = gaps[Math.floor(gaps.length / 2)]!
  if (gap < 0.9) return 'hour'
  if (gap < 3) return 'day'
  if (gap < 15) return 'week'
  if (gap < 60) return 'month'
  if (gap < 200) return 'quarter'
  return 'year'
}

export function prepareSeries(frame: Frame, timeColumn: string, valueColumn: string, options: { frequency?: Frequency; aggregate?: 'sum' | 'mean' | 'last' | 'count'; fill?: 'zero' | 'interpolate' | 'none'; where?: (row: Record<string, unknown>) => boolean } = {}): Series {
  const points: Array<[number, number]> = []
  for (const row of frame.rows) {
    if (options.where && !options.where(row)) continue
    const ms = toDateMs(row[timeColumn])
    const value = options.aggregate === 'count' ? 1 : toNumber(row[valueColumn])
    if (ms !== undefined && value !== undefined) points.push([ms, value])
  }
  if (points.length < 3) throw new Error(`fewer than 3 dated, numeric points for ${valueColumn} over ${timeColumn}`)
  const frequency = options.frequency ?? inferFrequency(points.map((point) => point[0]))
  const buckets = new Map<number, number[]>()
  for (const [ms, value] of points) {
    const key = truncate(ms, frequency)
    buckets.set(key, [...(buckets.get(key) ?? []), value])
  }
  const keys = [...buckets.keys()].sort((a, b) => a - b)
  const aggregate = options.aggregate ?? 'sum'
  const dates: string[] = []
  const values: Array<number | null> = []
  let filled = 0
  for (let ms = keys[0]!; ms <= keys.at(-1)!; ms = advance(ms, frequency)) {
    dates.push(frequency === 'hour' ? isoDateTime(ms) : isoDate(ms))
    const bucket = buckets.get(ms)
    if (!bucket) {
      filled++
      values.push(options.fill === 'zero' ? 0 : null)
      continue
    }
    values.push(aggregate === 'mean' ? mean(bucket) : aggregate === 'last' ? bucket.at(-1)! : bucket.reduce((a, b) => a + b, 0))
  }
  if (options.fill === 'interpolate' || options.fill === undefined) interpolateGaps(values)
  return { dates, values, frequency, seasonPeriod: PERIODS[frequency], filledPeriods: filled, aggregatedRows: points.length }
}

function interpolateGaps(values: Array<number | null>): void {
  for (let index = 0; index < values.length; index++) {
    if (values[index] !== null) continue
    let next = index
    while (next < values.length && values[next] === null) next++
    const before = index > 0 ? values[index - 1]! : null
    const after = next < values.length ? values[next]! : null
    for (let k = index; k < next; k++) values[k] = before !== null && after !== null ? before + ((after - before) * (k - index + 1)) / (next - index + 1) : (before ?? after ?? 0)
    index = next
  }
}

// ---------------------------------------------------------------- diagnostics

export function acf(values: number[], lags: number): number[] {
  const m = mean(values)
  const denominator = values.reduce((total, value) => total + (value - m) ** 2, 0)
  return Array.from({ length: lags + 1 }, (_, lag) => {
    let total = 0
    for (let t = lag; t < values.length; t++) total += (values[t]! - m) * (values[t - lag]! - m)
    return denominator === 0 ? 0 : total / denominator
  })
}

/** Partial autocorrelation by the Durbin–Levinson recursion. */
export function pacf(values: number[], lags: number): number[] {
  const r = acf(values, lags)
  const out = [1]
  let phi: number[] = []
  for (let k = 1; k <= lags; k++) {
    const numerator = r[k]! - phi.reduce((total, value, j) => total + value * r[k - 1 - j]!, 0)
    const denominator = 1 - phi.reduce((total, value, j) => total + value * r[j + 1]!, 0)
    const phiKK = denominator === 0 ? 0 : numerator / denominator
    phi = [...phi.map((value, j) => value - phiKK * phi[k - 2 - j]!), phiKK]
    out.push(phiKK)
  }
  return out
}

export function ljungBox(values: number[], lags: number, fittedParameters = 0): { statistic: number; df: number; pValue: number } {
  const n = values.length
  const r = acf(values, lags)
  let q = 0
  for (let k = 1; k <= lags; k++) q += (r[k]! * r[k]!) / (n - k)
  q *= n * (n + 2)
  const df = Math.max(1, lags - fittedParameters)
  return { statistic: q, df, pValue: chiSquareSf(q, df) }
}

/** t statistic of the lagged level in the Dickey–Fuller regression, by lean normal equations. */
function adfStatistic(values: number[], lags: number, trend: 'c' | 'ct'): number {
  const dy = values.slice(1).map((value, index) => value - values[index]!)
  const rows: number[][] = []
  const y: number[] = []
  for (let t = lags; t < dy.length; t++) {
    const row = [1]
    if (trend === 'ct') row.push(t)
    row.push(values[t]!)
    for (let lag = 1; lag <= lags; lag++) row.push(dy[t - lag]!)
    rows.push(row)
    y.push(dy[t]!)
  }
  const k = rows[0]!.length
  const position = trend === 'ct' ? 2 : 1
  try {
    const inverse = inverseSPD(gram(rows))
    const beta = matVec(inverse, crossVec(rows, y))
    let sse = 0
    rows.forEach((row, index) => { const e = y[index]! - row.reduce((total, value, j) => total + value * beta[j]!, 0); sse += e * e })
    const sigma2 = sse / Math.max(1, rows.length - k)
    return beta[position]! / Math.sqrt(sigma2 * inverse[position]![position]!)
  } catch {
    return Number.NaN
  }
}

const ADF_CRITICAL: Record<'c' | 'ct', Record<string, [number, number, number, number]>> = {
  // MacKinnon (2010) response-surface coefficients: cv = b0 + b1/T + b2/T² + b3/T³
  c: { '1%': [-3.43035, -6.5393, -16.786, -79.433], '5%': [-2.86154, -2.8903, -4.234, -40.04], '10%': [-2.56677, -1.5384, -2.809, 0] },
  ct: { '1%': [-3.95877, -9.0531, -28.428, -134.155], '5%': [-3.41049, -4.3904, -9.036, -45.374], '10%': [-3.12705, -2.5856, -3.925, -22.38] },
}

/**
 * Augmented Dickey–Fuller unit-root test (H0: a unit root, i.e. non-stationary). Lag order by
 * AIC up to Schwert's bound; critical values from MacKinnon (2010); the p-value is estimated
 * by simulating the test statistic under H0 for this sample size (seeded, reproducible).
 */
export function adfTest(values: number[], options: { trend?: 'c' | 'ct'; maxLags?: number; simulations?: number; seed?: number } = {}): { statistic: number; lags: number; pValue: number; criticalValues: Record<string, number>; stationary: boolean; method: string } {
  const n = values.length
  if (n < 20) throw new Error('ADF needs at least 20 observations')
  const trend = options.trend ?? 'c'
  const maxLags = options.maxLags ?? Math.min(Math.floor(12 * (n / 100) ** 0.25), Math.floor(n / 4))
  let bestLags = 0
  let bestAic = Number.POSITIVE_INFINITY
  for (let lags = 0; lags <= maxLags; lags++) {
    const dy = values.slice(1).map((value, index) => value - values[index]!)
    const rows: number[][] = []
    const y: number[] = []
    for (let t = maxLags; t < dy.length; t++) {
      const row = [1, ...(trend === 'ct' ? [t] : []), values[t]!]
      for (let lag = 1; lag <= lags; lag++) row.push(dy[t - lag]!)
      rows.push(row)
      y.push(dy[t]!)
    }
    try {
      const fit = ols(rows, y, rows[0]!.map((_, index) => `x${index}`))
      if ((fit.fit.aic ?? Number.POSITIVE_INFINITY) < bestAic) { bestAic = fit.fit.aic!; bestLags = lags }
    } catch {
      break
    }
  }
  const statistic = adfStatistic(values, bestLags, trend)
  const T = n - bestLags - 1
  const criticalValues = Object.fromEntries(Object.entries(ADF_CRITICAL[trend]).map(([level, [b0, b1, b2, b3]]) => [level, b0 + b1 / T + b2 / T ** 2 + b3 / T ** 3]))
  const simulations = options.simulations ?? 1000
  const rng = createRng(options.seed ?? 42)
  const length = Math.min(n, 500)
  let asExtreme = 0
  for (let s = 0; s < simulations; s++) {
    const walk = [0]
    for (let t = 1; t < length; t++) walk.push(walk[t - 1]! + rng.normal())
    if (adfStatistic(walk, 0, trend) <= statistic) asExtreme++
  }
  const pValue = (asExtreme + 1) / (simulations + 1)
  return { statistic, lags: bestLags, pValue, criticalValues, stationary: statistic < criticalValues['5%']!, method: `ADF with ${trend === 'c' ? 'a constant' : 'a constant and trend'}, ${bestLags} lag(s) by AIC; p-value by ${simulations} seeded simulations of the Dickey–Fuller distribution` }
}

/** KPSS test (H0: stationary). p-value interpolated from the Kwiatkowski et al. (1992) table, clipped to [0.01, 0.10]. */
export function kpssTest(values: number[], trend: 'c' | 'ct' = 'c'): { statistic: number; lags: number; pValue: number; pValueBound: string; stationary: boolean } {
  const n = values.length
  const t = values.map((_, index) => index)
  let residuals: number[]
  if (trend === 'ct') residuals = ols(values.map((_, index) => [1, t[index]!]), values, ['c', 't']).residuals
  else { const m = mean(values); residuals = values.map((value) => value - m) }
  const lags = Math.floor(4 * (n / 100) ** 0.25)
  let s2 = residuals.reduce((total, value) => total + value * value, 0) / n
  for (let lag = 1; lag <= lags; lag++) {
    let gamma = 0
    for (let k = lag; k < n; k++) gamma += residuals[k]! * residuals[k - lag]!
    s2 += 2 * (1 - lag / (lags + 1)) * (gamma / n)
  }
  let cumulative = 0
  let eta = 0
  for (const value of residuals) { cumulative += value; eta += cumulative * cumulative }
  const statistic = eta / (n * n * s2)
  const table = trend === 'c' ? [[0.347, 0.1], [0.463, 0.05], [0.574, 0.025], [0.739, 0.01]] : [[0.119, 0.1], [0.146, 0.05], [0.176, 0.025], [0.216, 0.01]]
  let pValue: number
  let bound = 'interpolated'
  if (statistic <= table[0]![0]!) { pValue = 0.1; bound = 'p ≥ 0.10 (table limit)' }
  else if (statistic >= table[3]![0]!) { pValue = 0.01; bound = 'p ≤ 0.01 (table limit)' }
  else {
    const i = table.findIndex((row) => statistic < row[0]!) - 1
    const [c0, p0] = table[i]!
    const [c1, p1] = table[i + 1]!
    pValue = p0! + ((statistic - c0!) * (p1! - p0!)) / (c1! - c0!)
  }
  return { statistic, lags, pValue, pValueBound: bound, stationary: pValue > 0.05 }
}

export interface Decomposition {
  model: 'additive' | 'multiplicative'
  period: number
  trend: Array<number | null>
  seasonal: number[]
  residual: Array<number | null>
  seasonalStrength: number
  trendStrength: number
}

/** Classical decomposition with a centred moving-average trend. */
export function decompose(values: number[], period: number, model: 'additive' | 'multiplicative' = 'additive'): Decomposition {
  const n = values.length
  if (period < 2 || n < 2 * period) throw new Error(`decomposition needs at least two full seasons (${2 * period} points) for period ${period}`)
  if (model === 'multiplicative' && values.some((value) => value <= 0)) throw new Error('multiplicative decomposition needs strictly positive values')
  const trend: Array<number | null> = new Array(n).fill(null)
  const half = Math.floor(period / 2)
  for (let t = half; t < n - half; t++) {
    if (period % 2 === 0) {
      let total = 0.5 * values[t - half]! + 0.5 * values[t + half]!
      for (let k = t - half + 1; k < t + half; k++) total += values[k]!
      trend[t] = total / period
    } else {
      let total = 0
      for (let k = t - half; k <= t + half; k++) total += values[k]!
      trend[t] = total / period
    }
  }
  const detrended = values.map((value, index) => (trend[index] === null ? null : model === 'additive' ? value - trend[index]! : value / trend[index]!))
  const seasonalMeans = Array.from({ length: period }, (_, phase) => mean(detrended.filter((value, index) => value !== null && index % period === phase) as number[]))
  const adjust = model === 'additive' ? mean(seasonalMeans) : mean(seasonalMeans)
  const normalized = seasonalMeans.map((value) => (model === 'additive' ? value - adjust : value / adjust))
  const seasonal = values.map((_, index) => normalized[index % period]!)
  const residual = values.map((value, index) => (trend[index] === null ? null : model === 'additive' ? value - trend[index]! - seasonal[index]! : value / (trend[index]! * seasonal[index]!)))
  const pairs = residual.map((r, index) => ({ r, s: seasonal[index]!, t: trend[index] })).filter((entry) => entry.r !== null) as Array<{ r: number; s: number; t: number }>
  const variance = (xs: number[]) => (xs.length > 1 ? standardDeviation(xs) ** 2 : 0)
  const varR = variance(pairs.map((p) => p.r))
  const seasonalStrength = Math.max(0, 1 - varR / Math.max(1e-12, variance(pairs.map((p) => (model === 'additive' ? p.s + p.r : p.s * p.r)))))
  const trendStrength = Math.max(0, 1 - varR / Math.max(1e-12, variance(pairs.map((p) => (model === 'additive' ? p.t + p.r : p.t * p.r)))))
  return { model, period, trend, seasonal, residual, seasonalStrength, trendStrength }
}

/** Mean-shift change points by binary segmentation with a BIC-style penalty. */
export function changePoints(values: number[], options: { minSegment?: number; maxPoints?: number } = {}): Array<{ index: number; before: number; after: number; shift: number }> {
  const n = values.length
  const minSegment = options.minSegment ?? Math.max(3, Math.floor(n / 20))
  const diffs = values.slice(1).map((value, index) => value - values[index]!)
  const sigma = (median(diffs.map((value) => Math.abs(value - median(diffs)))) * 1.4826) / Math.SQRT2 || standardDeviation(values) || 1
  const penalty = 2 * Math.log(n) * sigma * sigma
  const cost = (start: number, end: number) => {
    const segment = values.slice(start, end)
    const m = mean(segment)
    return segment.reduce((total, value) => total + (value - m) ** 2, 0)
  }
  const found: number[] = []
  const segments: Array<[number, number]> = [[0, n]]
  while (segments.length && found.length < (options.maxPoints ?? 10)) {
    let best: { gain: number; index: number; segment: number } | undefined
    segments.forEach(([start, end], s) => {
      const whole = cost(start, end)
      for (let split = start + minSegment; split <= end - minSegment; split++) {
        const gain = whole - cost(start, split) - cost(split, end)
        if (!best || gain > best.gain) best = { gain, index: split, segment: s }
      }
    })
    if (!best || best.gain < penalty) break
    const [start, end] = segments[best.segment]!
    segments.splice(best.segment, 1, [start, best.index], [best.index, end])
    found.push(best.index)
  }
  const sortedPoints = found.sort((a, b) => a - b)
  return sortedPoints.map((index, k) => {
    const start = k === 0 ? 0 : sortedPoints[k - 1]!
    const end = k === sortedPoints.length - 1 ? n : sortedPoints[k + 1]!
    const before = mean(values.slice(start, index))
    const after = mean(values.slice(index, end))
    return { index, before, after, shift: after - before }
  })
}

/** Points whose residual (after trend and seasonality) has a robust z-score above the threshold. */
export function seriesAnomalies(values: number[], period: number, threshold = 3.5): Array<{ index: number; value: number; expected: number; robustZ: number }> {
  let expected: number[]
  if (period >= 2 && values.length >= 2 * period) {
    const d = decompose(values, period)
    expected = values.map((value, index) => (d.residual[index] === null ? value : value - d.residual[index]!))
    const firstTrend = d.trend.findIndex((value) => value !== null)
    const lastTrend = d.trend.length - 1 - [...d.trend].reverse().findIndex((value) => value !== null)
    for (let index = 0; index < values.length; index++) if (d.trend[index] === null) expected[index] = (d.trend[index < firstTrend ? firstTrend : lastTrend] as number) + d.seasonal[index]!
  } else {
    const window = Math.max(3, Math.min(15, Math.floor(values.length / 5)))
    expected = values.map((_, index) => median(values.slice(Math.max(0, index - window), Math.min(values.length, index + window + 1))))
  }
  const residuals = values.map((value, index) => value - expected[index]!)
  const med = median(residuals)
  const mad = median(residuals.map((value) => Math.abs(value - med))) * 1.4826 || standardDeviation(residuals) || 1
  return residuals.map((r, index) => ({ index, value: values[index]!, expected: expected[index]!, robustZ: (r - med) / mad })).filter((point) => Math.abs(point.robustZ) > threshold)
}

// ---------------------------------------------------------------- forecasting models

export type ForecastMethod = 'naive' | 'seasonal_naive' | 'drift' | 'mean' | 'moving_average' | 'ses' | 'holt' | 'holt_damped' | 'holt_winters_additive' | 'holt_winters_multiplicative' | 'arima' | 'gbm_lags'

export const FORECAST_METHODS: ForecastMethod[] = ['naive', 'seasonal_naive', 'drift', 'mean', 'moving_average', 'ses', 'holt', 'holt_damped', 'holt_winters_additive', 'holt_winters_multiplicative', 'arima', 'gbm_lags']

interface Forecaster {
  fitForecast(history: number[], horizon: number): { forecast: number[]; description: string; fittedOneStep?: number[] }
}

function etsFit(y: number[], m: number, kind: 'ses' | 'holt' | 'damped' | 'hwa' | 'hwm'): { params: number[]; sse: number; forecast: (h: number) => number[]; fitted: number[] } {
  const seasonal = kind === 'hwa' || kind === 'hwm'
  const hasTrend = kind !== 'ses'
  const run = (params: number[], h: number) => {
    const [alpha, beta = 0, gamma = 0, phi = 1] = params
    let level = seasonal ? mean(y.slice(0, m)) : y[0]!
    let trend = hasTrend ? (seasonal && y.length >= 2 * m ? (mean(y.slice(m, 2 * m)) - mean(y.slice(0, m))) / m : y[1]! - y[0]!) : 0
    const season = seasonal ? y.slice(0, m).map((value) => (kind === 'hwa' ? value - level : value / level)) : []
    let sse = 0
    const fitted: number[] = []
    const start = seasonal ? m : 1
    for (let t = 0; t < start; t++) fitted.push(y[t]!)
    for (let t = start; t < y.length; t++) {
      const s = seasonal ? season[t % m]! : kind === 'hwm' ? 1 : 0
      const damp = kind === 'damped' ? phi! : 1
      const prediction = kind === 'hwm' ? (level + damp * trend) * s : level + damp * trend + (seasonal ? s : 0)
      fitted.push(prediction)
      const error = y[t]! - prediction
      sse += error * error
      const previousLevel = level
      if (kind === 'hwm') level = alpha! * (y[t]! / s) + (1 - alpha!) * (level + trend)
      else level = alpha! * (y[t]! - (seasonal ? s : 0)) + (1 - alpha!) * (level + damp * trend)
      if (hasTrend) trend = beta! * (level - previousLevel) + (1 - beta!) * damp * trend
      if (seasonal) season[t % m] = kind === 'hwm' ? gamma! * (y[t]! / level) + (1 - gamma!) * s : gamma! * (y[t]! - level) + (1 - gamma!) * s
    }
    const forecast: number[] = []
    let dampSum = 0
    for (let step = 1; step <= h; step++) {
      dampSum += kind === 'damped' ? phi! ** step : 1
      const trendPart = hasTrend ? dampSum * trend : 0
      const s = seasonal ? season[(y.length + step - 1) % m]! : 0
      forecast.push(kind === 'hwm' ? (level + trendPart) * s : level + trendPart + s)
    }
    return { sse, forecast, fitted }
  }
  const start = kind === 'ses' ? [0.3] : kind === 'holt' ? [0.3, 0.1] : kind === 'damped' ? [0.3, 0.1, 0, 0.95] : [0.3, 0.1, 0.1]
  const lower = start.map(() => 0.0001)
  const upper = start.map((_, index) => (kind === 'damped' && index === 3 ? 0.999 : 0.9999))
  if (kind === 'damped') { lower[3] = 0.8; lower[2] = 0; upper[2] = 0 }
  const result = nelderMead((params) => run(params, 0).sse, start, { lower, upper, maxIterations: 600 })
  return { params: result.x, sse: result.value, forecast: (h) => run(result.x, h).forecast, fitted: run(result.x, 0).fitted }
}

/** ARIMA(p,d,q) by conditional sum of squares (Nelder–Mead), on the d-times differenced series. */
function arimaFit(y: number[], p: number, d: number, q: number): { aic: number; forecast: (h: number) => number[]; params: number[]; sigma2: number } {
  let series = [...y]
  const tails: number[][] = []
  for (let k = 0; k < d; k++) {
    tails.push(series.slice(-1))
    series = series.slice(1).map((value, index) => value - series[index]!)
  }
  const mu = d === 0 ? mean(series) : mean(series)
  const z = series.map((value) => value - mu)
  const n = z.length
  const residualsOf = (params: number[]) => {
    const phi = params.slice(0, p)
    const theta = params.slice(p, p + q)
    const e = new Array<number>(n).fill(0)
    let sse = 0
    const start = Math.max(p, q)
    for (let t = start; t < n; t++) {
      let prediction = 0
      for (let i = 0; i < p; i++) prediction += phi[i]! * z[t - 1 - i]!
      for (let j = 0; j < q; j++) prediction += theta[j]! * e[t - 1 - j]!
      e[t] = z[t]! - prediction
      sse += e[t]! * e[t]!
    }
    return { e, sse }
  }
  let params: number[] = []
  if (p + q > 0) {
    const result = nelderMead((values) => {
      if (values.slice(0, p).reduce((a, b) => a + Math.abs(b), 0) >= 0.999 * (p > 0 ? 1.5 : 1) || values.slice(p).some((value) => Math.abs(value) >= 0.999)) return Number.POSITIVE_INFINITY
      return residualsOf(values).sse
    }, new Array<number>(p + q).fill(0.1), { lower: new Array<number>(p + q).fill(-0.99), upper: new Array<number>(p + q).fill(0.99), maxIterations: 800 })
    params = result.x
  }
  const { e, sse } = residualsOf(params)
  const effective = n - Math.max(p, q)
  const sigma2 = sse / Math.max(1, effective)
  const k = p + q + 1
  const aic = effective * Math.log(Math.max(1e-300, sse / effective)) + 2 * k
  const forecast = (h: number) => {
    const zz = [...z]
    const ee = [...e]
    const phi = params.slice(0, p)
    const theta = params.slice(p, p + q)
    for (let step = 0; step < h; step++) {
      const t = zz.length
      let prediction = 0
      for (let i = 0; i < p; i++) prediction += phi[i]! * zz[t - 1 - i]!
      for (let j = 0; j < q; j++) prediction += theta[j]! * (ee[t - 1 - j] ?? 0)
      zz.push(prediction)
      ee.push(0)
    }
    let out = zz.slice(n).map((value) => value + mu)
    for (let k2 = d - 1; k2 >= 0; k2--) {
      let last = tails[k2]![0]!
      out = out.map((value) => (last = last + value))
    }
    return out
  }
  return { aic, forecast, params, sigma2 }
}

function autoArima(y: number[]): { forecast: (h: number) => number[]; description: string } {
  let d = 0
  try {
    if (y.length >= 20 && !adfTest(y, { simulations: 200 }).stationary) d = 1
    if (d === 1 && y.length >= 25) {
      const diffed = y.slice(1).map((value, index) => value - y[index]!)
      if (!adfTest(diffed, { simulations: 200 }).stationary) d = 2
    }
  } catch {
    d = 1
  }
  let best: ReturnType<typeof arimaFit> | undefined
  let order = [0, d, 0]
  for (let p = 0; p <= 3; p++) for (let q = 0; q <= 2; q++) {
    if (y.length - d < 3 * (p + q + 2)) continue
    const fit = arimaFit(y, p, d, q)
    if (!best || fit.aic < best.aic) { best = fit; order = [p, d, q] }
  }
  if (!best) { best = arimaFit(y, 0, d, 0); order = [0, d, 0] }
  return { forecast: best.forecast, description: `ARIMA(${order.join(',')}) chosen by AIC, conditional-sum-of-squares estimates, d from ADF tests` }
}

function lagFeatures(history: number[], t: number, m: number): number[] {
  const at = (k: number) => history[t - k] ?? history[0]!
  const window = history.slice(Math.max(0, t - m), t)
  return [at(1), at(2), at(3), at(m), m > 1 ? at(2 * m) : at(4), mean(window.length ? window : [at(1)]), t % m, t]
}

function forecaster(method: ForecastMethod, m: number, seed: number): Forecaster {
  return {
    fitForecast(y, h) {
      const n = y.length
      switch (method) {
        case 'naive': return { forecast: new Array(h).fill(y[n - 1]!), description: 'last value carried forward' }
        case 'seasonal_naive': return { forecast: Array.from({ length: h }, (_, step) => y[n - m + (step % m)] ?? y[n - 1]!), description: `value from the same period one season (${m}) earlier` }
        case 'mean': return { forecast: new Array(h).fill(mean(y)), description: 'historical mean' }
        case 'drift': { const slope = (y[n - 1]! - y[0]!) / Math.max(1, n - 1); return { forecast: Array.from({ length: h }, (_, step) => y[n - 1]! + slope * (step + 1)), description: 'last value plus the average historical change' } }
        case 'moving_average': { const window = Math.min(m > 1 ? m : 3, n); return { forecast: new Array(h).fill(mean(y.slice(-window))), description: `mean of the last ${window} periods` } }
        case 'ses': { const fit = etsFit(y, m, 'ses'); return { forecast: fit.forecast(h), description: `simple exponential smoothing (α=${fit.params[0]!.toFixed(3)})`, fittedOneStep: fit.fitted } }
        case 'holt': { const fit = etsFit(y, m, 'holt'); return { forecast: fit.forecast(h), description: `Holt linear trend (α=${fit.params[0]!.toFixed(3)}, β=${fit.params[1]!.toFixed(3)})`, fittedOneStep: fit.fitted } }
        case 'holt_damped': { const fit = etsFit(y, m, 'damped'); return { forecast: fit.forecast(h), description: `damped-trend Holt (α=${fit.params[0]!.toFixed(3)}, β=${fit.params[1]!.toFixed(3)}, φ=${fit.params[3]!.toFixed(3)})`, fittedOneStep: fit.fitted } }
        case 'holt_winters_additive':
        case 'holt_winters_multiplicative': {
          if (m < 2 || n < 2 * m) throw new Error(`Holt–Winters needs two full seasons (${2 * m} points)`)
          const multiplicative = method === 'holt_winters_multiplicative'
          if (multiplicative && y.some((value) => value <= 0)) throw new Error('multiplicative seasonality needs strictly positive values')
          const fit = etsFit(y, m, multiplicative ? 'hwm' : 'hwa')
          return { forecast: fit.forecast(h), description: `Holt–Winters ${multiplicative ? 'multiplicative' : 'additive'} seasonality, period ${m} (α=${fit.params[0]!.toFixed(3)}, β=${fit.params[1]!.toFixed(3)}, γ=${fit.params[2]!.toFixed(3)})`, fittedOneStep: fit.fitted }
        }
        case 'arima': { const fit = autoArima(y); return { forecast: fit.forecast(h), description: fit.description } }
        case 'gbm_lags': {
          const start = Math.max(2 * m, 4)
          if (n - start < 30) throw new Error('boosted lag model needs at least 30 points after the initial lags')
          const x: number[][] = []
          const target: number[] = []
          for (let t = start; t < n; t++) { x.push(lagFeatures(y, t, m)); target.push(y[t]!) }
          const model = fitModel('gradient_boosting', 'regression', x, target, 0, { nEstimators: 200, maxDepth: 3, learningRate: 0.05, earlyStopping: false }, seed)
          const history = [...y]
          for (let step = 0; step < h; step++) history.push(predictModel(model, [lagFeatures(history, history.length, m)]).values[0]!)
          return { forecast: history.slice(n), description: 'gradient boosting on lags, a seasonal lag, a rolling mean, and calendar position; recursive multi-step (cannot extrapolate beyond the training range)' }
        }
      }
    },
  }
}

export interface BacktestResult {
  method: ForecastMethod
  description: string
  mae: number
  rmse: number
  mape: number | null
  smape: number
  mase: number | null
  origins: number
  errorsByStep: number[][]
  failed?: string
}

function scaleForMase(y: number[], m: number): number | null {
  const lag = y.length > m ? m : 1
  const diffs = y.slice(lag).map((value, index) => Math.abs(value - y[index]!))
  const scale = mean(diffs)
  return scale > 0 ? scale : null
}

/** Rolling-origin evaluation: each origin trains on everything before it and forecasts `horizon` steps. */
export function backtest(y: number[], method: ForecastMethod, horizon: number, m: number, origins: number, seed = 42): BacktestResult {
  const n = y.length
  const errorsByStep: number[][] = Array.from({ length: horizon }, () => [])
  const actuals: number[] = []
  const predictions: number[] = []
  let description = ''
  let used = 0
  const minTrain = Math.max(m > 1 ? 2 * m : 8, 8)
  for (let o = origins; o >= 1; o--) {
    const end = n - horizon - (o - 1) * Math.max(1, Math.floor(horizon / 2))
    if (end < minTrain) continue
    const history = y.slice(0, end)
    const truth = y.slice(end, end + horizon)
    const result = forecaster(method, m, seed).fitForecast(history, truth.length)
    description = result.description
    truth.forEach((value, step) => {
      errorsByStep[step]!.push(value - result.forecast[step]!)
      actuals.push(value)
      predictions.push(result.forecast[step]!)
    })
    used++
  }
  if (used === 0) throw new Error(`not enough history for a ${horizon}-step backtest (need at least ${minTrain + horizon} points)`)
  const errors = actuals.map((value, index) => value - predictions[index]!)
  const nonZero = actuals.map((value, index) => ({ value, index })).filter(({ value }) => value !== 0)
  const scale = scaleForMase(y, m)
  const mae = mean(errors.map(Math.abs))
  return {
    method,
    description,
    mae,
    rmse: Math.sqrt(mean(errors.map((e) => e * e))),
    mape: nonZero.length ? mean(nonZero.map(({ value, index }) => Math.abs(errors[index]! / value))) : null,
    smape: mean(actuals.map((value, index) => { const d = Math.abs(value) + Math.abs(predictions[index]!); return d === 0 ? 0 : (2 * Math.abs(errors[index]!)) / d })),
    mase: scale === null ? null : mae / scale,
    origins: used,
    errorsByStep,
  }
}

export interface ForecastResult {
  frequency: Frequency
  seasonPeriod: number
  horizon: number
  method: ForecastMethod
  description: string
  leaderboard: Array<Omit<BacktestResult, 'errorsByStep'>>
  forecast: Array<{ date: string; forecast: number; lower: number; upper: number }>
  intervalMethod: string
  level: number
  history: { dates: string[]; values: number[] }
  selectionReason: string
  beatsNaive: boolean | null
}

export function forecastSeries(series: Series, options: { horizon: number; methods?: ForecastMethod[]; level?: number; origins?: number; seed?: number; nonNegative?: boolean }): ForecastResult {
  const y = series.values.map((value) => value ?? 0)
  const m = series.seasonPeriod
  const horizon = Math.max(1, Math.floor(options.horizon))
  const level = options.level ?? 0.9
  const seed = options.seed ?? 42
  const origins = options.origins ?? Math.min(12, Math.max(3, Math.floor((y.length - 2 * m) / Math.max(1, Math.floor(horizon / 2)))))
  const methods = options.methods ?? (['naive', 'seasonal_naive', 'drift', 'ses', 'holt_damped', 'holt_winters_additive', 'holt_winters_multiplicative', 'arima', 'gbm_lags'] as ForecastMethod[])
  const results: BacktestResult[] = []
  for (const method of methods) {
    try {
      if ((method === 'seasonal_naive' || method.startsWith('holt_winters')) && m < 2) continue
      results.push(backtest(y, method, horizon, m, origins, seed))
    } catch (error) {
      results.push({ method, description: '', mae: Number.NaN, rmse: Number.NaN, mape: null, smape: Number.NaN, mase: null, origins: 0, errorsByStep: [], failed: (error as Error).message })
    }
  }
  const valid = results.filter((result) => !result.failed && Number.isFinite(result.mae))
  if (valid.length === 0) throw new Error(`no forecast method could be evaluated: ${results.map((r) => `${r.method}: ${r.failed}`).join('; ')}`)
  const key = (result: BacktestResult) => result.mase ?? result.mae
  valid.sort((a, b) => key(a) - key(b))
  const best = valid[0]!
  const naive = valid.find((result) => result.method === (m > 1 && valid.some((r) => r.method === 'seasonal_naive') ? 'seasonal_naive' : 'naive'))
  const final = forecaster(best.method, m, seed).fitForecast(y, horizon)
  const z = normalQuantile(1 - (1 - level) / 2)
  const oneStep = best.errorsByStep[0] ?? []
  const sigma1 = oneStep.length > 1 ? Math.sqrt(mean(oneStep.map((e) => e * e))) : standardDeviation(y.slice(1).map((value, index) => value - y[index]!))
  let intervalMethod = `empirical ${Math.round(level * 100)}% quantiles of backtest errors at each horizon step`
  const lastMs = toDateMs(series.dates.at(-1)!)!
  const forecast = final.forecast.map((value, step) => {
    const errors = best.errorsByStep[step] ?? []
    let lower: number
    let upper: number
    if (errors.length >= 8) {
      const sortedErrors = [...errors].sort((a, b) => a - b)
      lower = value + quantileSorted(sortedErrors, (1 - level) / 2)
      upper = value + quantileSorted(sortedErrors, 1 - (1 - level) / 2)
    } else {
      intervalMethod = `normal approximation from ${oneStep.length} backtest one-step errors, widened by √h (too few origins for empirical quantiles)`
      const width = z * sigma1 * Math.sqrt(step + 1)
      lower = value - width
      upper = value + width
    }
    if (options.nonNegative) { lower = Math.max(0, lower); value = Math.max(0, value) }
    const ms = advance(lastMs, series.frequency, step + 1)
    return { date: series.frequency === 'hour' ? isoDateTime(ms) : isoDate(ms), forecast: value, lower, upper }
  })
  return {
    frequency: series.frequency,
    seasonPeriod: m,
    horizon,
    method: best.method,
    description: final.description,
    leaderboard: results.map(({ errorsByStep: _errors, ...rest }) => rest).sort((a, b) => (a.failed ? 1 : 0) - (b.failed ? 1 : 0) || (a.mase ?? a.mae) - (b.mase ?? b.mae)),
    forecast,
    intervalMethod,
    level,
    history: { dates: series.dates, values: y },
    selectionReason: `${best.method} had the lowest ${best.mase !== null ? 'MASE' : 'MAE'} (${key(best).toFixed(3)}) over ${best.origins} rolling origins${naive && naive.method !== best.method ? ` vs ${naive.method} ${key(naive).toFixed(3)}` : ''}`,
    beatsNaive: naive ? naive.method !== best.method && key(best) < key(naive) : null,
  }
}
