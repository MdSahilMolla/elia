import { createRng } from '../rng.ts'
import { mean, median, quantileSorted, standardDeviation } from './describe.ts'
import { normalCdf, normalQuantile, type Alternative } from './special.ts'

/**
 * Seeded resampling inference: bootstrap confidence intervals (percentile and BCa) and
 * permutation tests. The seed and resample count are part of the result so the numbers are
 * reproducible from the execution record.
 */

export type StatisticName = 'mean' | 'median' | 'std' | 'trimmed_mean' | 'p90' | 'p10' | 'sum'

export function statisticFunction(name: StatisticName): (values: number[]) => number {
  switch (name) {
    case 'mean': return mean
    case 'median': return median
    case 'std': return (values) => standardDeviation(values)
    case 'sum': return (values) => values.reduce((a, b) => a + b, 0)
    case 'p90': return (values) => quantileSorted([...values].sort((a, b) => a - b), 0.9)
    case 'p10': return (values) => quantileSorted([...values].sort((a, b) => a - b), 0.1)
    case 'trimmed_mean': return (values) => {
      const sorted = [...values].sort((a, b) => a - b)
      const cut = Math.floor(sorted.length * 0.1)
      return mean(sorted.slice(cut, sorted.length - cut))
    }
  }
}

export const STATISTICS: StatisticName[] = ['mean', 'median', 'std', 'trimmed_mean', 'p90', 'p10', 'sum']

export interface BootstrapResult {
  estimate: number
  standardError: number
  ci: { lower: number; upper: number; level: number; method: string }
  resamples: number
  seed: number
  bias: number
}

function jackknife(values: number[], fn: (values: number[]) => number): number[] {
  return values.map((_, skip) => fn(values.filter((__, index) => index !== skip)))
}

/** Bootstrap CI for a one-sample statistic. BCa by default (second-order accurate); percentile on request. */
export function bootstrap(values: number[], fn: (values: number[]) => number, options: { resamples?: number; level?: number; seed?: number; method?: 'bca' | 'percentile' } = {}): BootstrapResult {
  if (values.length < 2) throw new Error('bootstrap needs at least 2 values')
  const resamples = options.resamples ?? 5000
  const level = options.level ?? 0.95
  const seed = options.seed ?? 42
  const rng = createRng(seed)
  const estimate = fn(values)
  const draws = new Array<number>(resamples)
  const sample = new Array<number>(values.length)
  for (let b = 0; b < resamples; b++) {
    for (let index = 0; index < values.length; index++) sample[index] = values[rng.int(values.length)]!
    draws[b] = fn(sample)
  }
  draws.sort((a, b) => a - b)
  const alpha = 1 - level
  let lowerQ = alpha / 2
  let upperQ = 1 - alpha / 2
  let method = 'percentile bootstrap'
  if ((options.method ?? 'bca') === 'bca' && values.length <= 5000) {
    const below = draws.filter((draw) => draw < estimate).length / resamples
    const z0 = normalQuantile(Math.min(1 - 1e-10, Math.max(1e-10, below)))
    const jack = jackknife(values, fn)
    const jackMean = mean(jack)
    const numerator = jack.reduce((total, value) => total + (jackMean - value) ** 3, 0)
    const denominator = 6 * jack.reduce((total, value) => total + (jackMean - value) ** 2, 0) ** 1.5
    const acceleration = denominator === 0 ? 0 : numerator / denominator
    const adjust = (z: number) => normalCdf(z0 + (z0 + z) / (1 - acceleration * (z0 + z)))
    const candidateLower = adjust(normalQuantile(alpha / 2))
    const candidateUpper = adjust(normalQuantile(1 - alpha / 2))
    if (Number.isFinite(candidateLower) && Number.isFinite(candidateUpper)) {
      lowerQ = candidateLower
      upperQ = candidateUpper
      method = 'BCa bootstrap'
    }
  }
  return {
    estimate,
    standardError: standardDeviation(draws),
    ci: { lower: quantileSorted(draws, lowerQ), upper: quantileSorted(draws, upperQ), level, method },
    resamples,
    seed,
    bias: mean(draws) - estimate,
  }
}

/** Bootstrap CI for a difference (or ratio) of a statistic between two independent samples. */
export function bootstrapTwoSample(a: number[], b: number[], fn: (values: number[]) => number, options: { resamples?: number; level?: number; seed?: number; comparison?: 'difference' | 'ratio' } = {}): BootstrapResult {
  const resamples = options.resamples ?? 5000
  const level = options.level ?? 0.95
  const seed = options.seed ?? 42
  const comparison = options.comparison ?? 'difference'
  const rng = createRng(seed)
  const combine = (x: number, y: number) => (comparison === 'ratio' ? x / y : x - y)
  const estimate = combine(fn(a), fn(b))
  const draws: number[] = []
  const sa = new Array<number>(a.length)
  const sb = new Array<number>(b.length)
  for (let r = 0; r < resamples; r++) {
    for (let index = 0; index < a.length; index++) sa[index] = a[rng.int(a.length)]!
    for (let index = 0; index < b.length; index++) sb[index] = b[rng.int(b.length)]!
    const value = combine(fn(sa), fn(sb))
    if (Number.isFinite(value)) draws.push(value)
  }
  draws.sort((x, y) => x - y)
  return {
    estimate,
    standardError: standardDeviation(draws),
    ci: { lower: quantileSorted(draws, (1 - level) / 2), upper: quantileSorted(draws, 1 - (1 - level) / 2), level, method: `percentile bootstrap of the ${comparison}` },
    resamples: draws.length,
    seed,
    bias: mean(draws) - estimate,
  }
}

export interface PermutationResult {
  observed: number
  pValue: number
  permutations: number
  exact: boolean
  seed: number
  alternative: Alternative
}

/** Two-sample permutation test of a difference in a statistic; exact when the number of splits is small. */
export function permutationTest(a: number[], b: number[], fn: (values: number[]) => number, options: { permutations?: number; seed?: number; alternative?: Alternative } = {}): PermutationResult {
  const alternative = options.alternative ?? 'two-sided'
  const seed = options.seed ?? 42
  const pooled = [...a, ...b]
  const na = a.length
  const observed = fn(a) - fn(b)
  const extreme = (value: number) => alternative === 'greater' ? value >= observed - 1e-12 : alternative === 'less' ? value <= observed + 1e-12 : Math.abs(value) >= Math.abs(observed) - 1e-12
  const total = pooled.length
  let combinations = 1
  for (let k = 0; k < na; k++) combinations = (combinations * (total - k)) / (k + 1)
  if (combinations <= 20_000) {
    let count = 0
    let seen = 0
    const indices = Array.from({ length: na }, (_, index) => index)
    const inA = new Uint8Array(total)
    const walk = () => {
      inA.fill(0)
      for (const index of indices) inA[index] = 1
      const left: number[] = []
      const right: number[] = []
      for (let index = 0; index < total; index++) (inA[index] ? left : right).push(pooled[index]!)
      if (extreme(fn(left) - fn(right))) count++
      seen++
    }
    while (true) {
      walk()
      let position = na - 1
      while (position >= 0 && indices[position] === total - na + position) position--
      if (position < 0) break
      indices[position]!++
      for (let next = position + 1; next < na; next++) indices[next] = indices[next - 1]! + 1
    }
    return { observed, pValue: count / seen, permutations: seen, exact: true, seed, alternative }
  }
  const permutations = options.permutations ?? 10_000
  const rng = createRng(seed)
  let count = 0
  for (let r = 0; r < permutations; r++) {
    const shuffled = rng.shuffle(pooled)
    if (extreme(fn(shuffled.slice(0, na)) - fn(shuffled.slice(na)))) count++
  }
  return { observed, pValue: (count + 1) / (permutations + 1), permutations, exact: false, seed, alternative }
}
