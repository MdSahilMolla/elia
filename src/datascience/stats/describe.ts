import { betaQuantile, normalQuantile, tQuantile } from './special.ts'

/** Descriptive statistics on plain number arrays. Callers strip missing values first. */

export function sum(values: ArrayLike<number>): number {
  // Neumaier summation: a revenue column of a million rows should not drift in the last cents.
  let total = 0
  let compensation = 0
  for (let index = 0; index < values.length; index++) {
    const value = values[index]!
    const t = total + value
    compensation += Math.abs(total) >= Math.abs(value) ? total - t + value : value - t + total
    total = t
  }
  return total + compensation
}

export function mean(values: ArrayLike<number>): number {
  return values.length ? sum(values) / values.length : Number.NaN
}

/** Variance with `ddof` delta degrees of freedom (1 = sample variance), two-pass for stability. */
export function variance(values: ArrayLike<number>, ddof = 1): number {
  const n = values.length
  if (n - ddof <= 0) return Number.NaN
  const m = mean(values)
  let squares = 0
  let correction = 0
  for (let index = 0; index < n; index++) {
    const d = values[index]! - m
    squares += d * d
    correction += d
  }
  return (squares - (correction * correction) / n) / (n - ddof)
}

export function standardDeviation(values: ArrayLike<number>, ddof = 1): number {
  return Math.sqrt(variance(values, ddof))
}

export function sorted(values: ArrayLike<number>): number[] {
  return Array.from(values).sort((a, b) => a - b)
}

/** Linear-interpolation quantile of an ascending array (NumPy's default "linear", R type 7). */
export function quantileSorted(ascending: number[], probability: number): number {
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) throw new RangeError(`quantile probability must be between 0 and 1, got ${probability}`)
  if (ascending.length === 0) return Number.NaN
  const position = (ascending.length - 1) * probability
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  return ascending[lower]! + (ascending[upper]! - ascending[lower]!) * (position - lower)
}

export function quantile(values: ArrayLike<number>, probability: number): number {
  return quantileSorted(sorted(values), probability)
}

export function median(values: ArrayLike<number>): number {
  return quantile(values, 0.5)
}

/** Adjusted Fisher–Pearson skewness G1 (what pandas and Excel report). */
export function skewness(values: ArrayLike<number>): number {
  const n = values.length
  if (n < 3) return Number.NaN
  const m = mean(values)
  let m2 = 0
  let m3 = 0
  for (let index = 0; index < n; index++) {
    const d = values[index]! - m
    m2 += d * d
    m3 += d * d * d
  }
  m2 /= n
  m3 /= n
  if (m2 === 0) return 0
  const g1 = m3 / m2 ** 1.5
  return (Math.sqrt(n * (n - 1)) / (n - 2)) * g1
}

/** Adjusted excess kurtosis G2 (what pandas and Excel report). */
export function kurtosis(values: ArrayLike<number>): number {
  const n = values.length
  if (n < 4) return Number.NaN
  const m = mean(values)
  let m2 = 0
  let m4 = 0
  for (let index = 0; index < n; index++) {
    const d = values[index]! - m
    m2 += d * d
    m4 += d ** 4
  }
  m2 /= n
  m4 /= n
  if (m2 === 0) return 0
  const g2 = m4 / (m2 * m2) - 3
  return ((n - 1) / ((n - 2) * (n - 3))) * ((n + 1) * g2 + 6)
}

export function medianAbsoluteDeviation(values: ArrayLike<number>): number {
  const m = median(values)
  return median(Array.from(values, (value) => Math.abs(value - m)))
}

export function covariance(x: ArrayLike<number>, y: ArrayLike<number>, ddof = 1): number {
  const n = x.length
  if (n - ddof <= 0) return Number.NaN
  const mx = mean(x)
  const my = mean(y)
  let total = 0
  for (let index = 0; index < n; index++) total += (x[index]! - mx) * (y[index]! - my)
  return total / (n - ddof)
}

export function pearson(x: ArrayLike<number>, y: ArrayLike<number>): number {
  const mx = mean(x)
  const my = mean(y)
  let sxy = 0
  let sxx = 0
  let syy = 0
  for (let index = 0; index < x.length; index++) {
    const dx = x[index]! - mx
    const dy = y[index]! - my
    sxy += dx * dy
    sxx += dx * dx
    syy += dy * dy
  }
  return sxx === 0 || syy === 0 ? Number.NaN : sxy / Math.sqrt(sxx * syy)
}

/** Average ranks (1-based), ties sharing the mean rank. */
export function rank(values: ArrayLike<number>): number[] {
  const order = Array.from({ length: values.length }, (_, index) => index).sort((a, b) => values[a]! - values[b]!)
  const ranks = new Array<number>(values.length)
  let index = 0
  while (index < order.length) {
    let end = index
    while (end + 1 < order.length && values[order[end + 1]!] === values[order[index]!]) end++
    const shared = (index + end) / 2 + 1
    for (let k = index; k <= end; k++) ranks[order[k]!] = shared
    index = end + 1
  }
  return ranks
}

/** Sizes of tied groups, for tie corrections in rank tests. */
export function tieGroups(values: ArrayLike<number>): number[] {
  const counts = new Map<number, number>()
  for (let index = 0; index < values.length; index++) counts.set(values[index]!, (counts.get(values[index]!) ?? 0) + 1)
  return [...counts.values()].filter((count) => count > 1)
}

export function spearman(x: ArrayLike<number>, y: ArrayLike<number>): number {
  return pearson(rank(x), rank(y))
}

/** Kendall's tau-b with its variance under H0 (for the normal-approximation test). */
export function kendallTauB(x: ArrayLike<number>, y: ArrayLike<number>): { tau: number; z: number } {
  const n = x.length
  let concordant = 0
  let discordant = 0
  let tiesX = 0
  let tiesY = 0
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = Math.sign(x[i]! - x[j]!)
      const dy = Math.sign(y[i]! - y[j]!)
      if (dx === 0 && dy === 0) continue
      if (dx === 0) tiesX++
      else if (dy === 0) tiesY++
      else if (dx === dy) concordant++
      else discordant++
    }
  }
  const denominator = Math.sqrt((concordant + discordant + tiesX) * (concordant + discordant + tiesY))
  const tau = denominator === 0 ? Number.NaN : (concordant - discordant) / denominator
  const xt = tieGroups(x)
  const yt = tieGroups(y)
  const v0 = n * (n - 1) * (2 * n + 5)
  const vt = xt.reduce((total, t) => total + t * (t - 1) * (2 * t + 5), 0)
  const vu = yt.reduce((total, u) => total + u * (u - 1) * (2 * u + 5), 0)
  const v1 = (xt.reduce((total, t) => total + t * (t - 1), 0) * yt.reduce((total, u) => total + u * (u - 1), 0)) / (2 * n * (n - 1))
  const v2 = n > 2 ? (xt.reduce((total, t) => total + t * (t - 1) * (t - 2), 0) * yt.reduce((total, u) => total + u * (u - 1) * (u - 2), 0)) / (9 * n * (n - 1) * (n - 2)) : 0
  const varS = (v0 - vt - vu) / 18 + v1 + v2
  const z = varS <= 0 ? Number.NaN : (concordant - discordant) / Math.sqrt(varS)
  return { tau, z }
}

export interface Interval {
  lower: number
  upper: number
  level: number
  method: string
}

export function meanInterval(values: ArrayLike<number>, level = 0.95): Interval {
  const n = values.length
  const m = mean(values)
  const se = standardDeviation(values) / Math.sqrt(n)
  const critical = n > 1 ? tQuantile(1 - (1 - level) / 2, n - 1) : Number.NaN
  return { lower: m - critical * se, upper: m + critical * se, level, method: 't interval' }
}

/** Wilson score interval for a binomial proportion — well behaved near 0 and 1, unlike Wald. */
export function wilsonInterval(successes: number, n: number, level = 0.95): Interval {
  if (n === 0) return { lower: Number.NaN, upper: Number.NaN, level, method: 'wilson' }
  const z = normalQuantile(1 - (1 - level) / 2)
  const p = successes / n
  const denominator = 1 + (z * z) / n
  const centre = (p + (z * z) / (2 * n)) / denominator
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denominator
  return { lower: Math.max(0, centre - half), upper: Math.min(1, centre + half), level, method: 'wilson' }
}

/** Exact Clopper–Pearson interval for a binomial proportion. */
export function clopperPearsonInterval(successes: number, n: number, level = 0.95): Interval {
  const alpha = 1 - level
  return {
    lower: successes === 0 ? 0 : betaQuantile(alpha / 2, successes, n - successes + 1),
    upper: successes === n ? 1 : betaQuantile(1 - alpha / 2, successes + 1, n - successes),
    level,
    method: 'clopper-pearson',
  }
}

export interface NumericSummary {
  count: number
  mean: number
  std: number
  min: number
  p01: number
  p05: number
  p25: number
  median: number
  p75: number
  p95: number
  p99: number
  max: number
  iqr: number
  skewness: number
  excessKurtosis: number
  cv: number | null
  sem: number
  meanCI95: [number, number]
  zeros: number
  negatives: number
}

export function summarize(values: ArrayLike<number>): NumericSummary {
  const ascending = sorted(values)
  const m = mean(ascending)
  const sd = standardDeviation(ascending)
  const interval = meanInterval(ascending)
  let zeros = 0
  let negatives = 0
  for (const value of ascending) {
    if (value === 0) zeros++
    if (value < 0) negatives++
  }
  return {
    count: ascending.length,
    mean: m,
    std: sd,
    min: ascending[0] ?? Number.NaN,
    p01: quantileSorted(ascending, 0.01),
    p05: quantileSorted(ascending, 0.05),
    p25: quantileSorted(ascending, 0.25),
    median: quantileSorted(ascending, 0.5),
    p75: quantileSorted(ascending, 0.75),
    p95: quantileSorted(ascending, 0.95),
    p99: quantileSorted(ascending, 0.99),
    max: ascending.at(-1) ?? Number.NaN,
    iqr: quantileSorted(ascending, 0.75) - quantileSorted(ascending, 0.25),
    skewness: skewness(ascending),
    excessKurtosis: kurtosis(ascending),
    cv: m !== 0 && Number.isFinite(sd) ? sd / Math.abs(m) : null,
    sem: sd / Math.sqrt(ascending.length),
    meanCI95: [interval.lower, interval.upper],
    zeros,
    negatives,
  }
}

/** Freedman–Diaconis histogram with a Sturges fallback; returns bin edges and counts. */
export function histogram(values: ArrayLike<number>, bins?: number): { edges: number[]; counts: number[] } {
  const ascending = sorted(values)
  if (ascending.length === 0) return { edges: [], counts: [] }
  const min = ascending[0]!
  const max = ascending.at(-1)!
  if (min === max) return { edges: [min, max], counts: [ascending.length] }
  let k = bins
  if (!k) {
    const iqr = quantileSorted(ascending, 0.75) - quantileSorted(ascending, 0.25)
    const width = (2 * iqr) / Math.cbrt(ascending.length)
    k = width > 0 ? Math.ceil((max - min) / width) : Math.ceil(Math.log2(ascending.length) + 1)
    k = Math.max(5, Math.min(60, k))
  }
  const width = (max - min) / k
  const counts = new Array<number>(k).fill(0)
  for (const value of ascending) counts[Math.min(k - 1, Math.floor((value - min) / width))]!++
  return { edges: Array.from({ length: k + 1 }, (_, index) => min + index * width), counts }
}
