import { chiSquareQuantile, fQuantile, noncentralChiSquareCdf, noncentralFCdf, noncentralTCdf, normalCdf, normalQuantile, tQuantile, type Alternative } from './special.ts'

/**
 * Power and sample size. t-test power uses the exact noncentral t distribution (as G*Power
 * and statsmodels do); ANOVA and chi-square use noncentral F / chi-square; proportions use
 * the standard pooled/unpooled normal formula. Sample sizes are the smallest integer that
 * reaches the requested power, found by search rather than by rounding a formula.
 */

export type TTestDesign = 'two-sample' | 'one-sample' | 'paired'

export function tTestPower(effectSize: number, n: number, options: { alpha?: number; design?: TTestDesign; ratio?: number; alternative?: Alternative } = {}): number {
  const alpha = options.alpha ?? 0.05
  const design = options.design ?? 'two-sample'
  const alternative = options.alternative ?? 'two-sided'
  let df: number
  let ncp: number
  if (design === 'two-sample') {
    const n2 = n * (options.ratio ?? 1)
    df = n + n2 - 2
    ncp = effectSize * Math.sqrt((n * n2) / (n + n2))
  } else {
    df = n - 1
    ncp = effectSize * Math.sqrt(n)
  }
  if (df <= 0) return Number.NaN
  if (alternative === 'two-sided') {
    const critical = tQuantile(1 - alpha / 2, df)
    return 1 - noncentralTCdf(critical, df, ncp) + noncentralTCdf(-critical, df, ncp)
  }
  const critical = tQuantile(1 - alpha, df)
  return alternative === 'greater' ? 1 - noncentralTCdf(critical, df, ncp) : noncentralTCdf(-critical, df, ncp)
}

function smallestN(power: (n: number) => number, target: number, start = 2, limit = 10_000_000): number {
  if (power(limit) < target) throw new Error(`the target power ${target} is not reachable below n = ${limit}; the effect may be too small to detect`)
  let lo = start
  let hi = start
  while (power(hi) < target) {
    lo = hi
    hi *= 2
  }
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (power(mid) >= target) hi = mid
    else lo = mid + 1
  }
  return hi
}

export function tTestSampleSize(effectSize: number, targetPower = 0.8, options: { alpha?: number; design?: TTestDesign; ratio?: number; alternative?: Alternative } = {}): { n: number; achievedPower: number; total: number } {
  if (!(Math.abs(effectSize) > 0)) throw new Error('effect size must be non-zero')
  const n = smallestN((k) => tTestPower(effectSize, k, options), targetPower)
  const design = options.design ?? 'two-sample'
  return { n, achievedPower: tTestPower(effectSize, n, options), total: design === 'two-sample' ? n + Math.ceil(n * (options.ratio ?? 1)) : n }
}

/** Power of a two-sided (or one-sided) two-proportion z test with n per group (normal approximation). */
export function proportionsPower(p1: number, p2: number, n: number, options: { alpha?: number; alternative?: Alternative; ratio?: number } = {}): number {
  const alpha = options.alpha ?? 0.05
  const n2 = n * (options.ratio ?? 1)
  const pooled = (p1 * n + p2 * n2) / (n + n2)
  const se0 = Math.sqrt(pooled * (1 - pooled) * (1 / n + 1 / n2))
  const se1 = Math.sqrt((p1 * (1 - p1)) / n + (p2 * (1 - p2)) / n2)
  const diff = Math.abs(p2 - p1)
  if ((options.alternative ?? 'two-sided') === 'two-sided') {
    const z = normalQuantile(1 - alpha / 2)
    return normalCdf((diff - z * se0) / se1) + normalCdf((-diff - z * se0) / se1)
  }
  return normalCdf((diff - normalQuantile(1 - alpha) * se0) / se1)
}

export function proportionsSampleSize(p1: number, p2: number, targetPower = 0.8, options: { alpha?: number; alternative?: Alternative; ratio?: number } = {}): { n: number; achievedPower: number; total: number } {
  if (p1 === p2) throw new Error('the two proportions must differ')
  if ([p1, p2].some((p) => p <= 0 || p >= 1)) throw new Error('proportions must be strictly between 0 and 1')
  const n = smallestN((k) => proportionsPower(p1, p2, k, options), targetPower)
  return { n, achievedPower: proportionsPower(p1, p2, n, options), total: n + Math.ceil(n * (options.ratio ?? 1)) }
}

/** Smallest absolute lift from `baseline` detectable with n per group (two-proportion test). */
export function minimumDetectableEffect(baseline: number, n: number, targetPower = 0.8, options: { alpha?: number; alternative?: Alternative } = {}): { absolute: number; relative: number } {
  let lo = 1e-6
  let hi = 1 - baseline - 1e-6
  if (proportionsPower(baseline, baseline + hi, n, options) < targetPower) throw new Error('no detectable lift at this sample size')
  for (let iteration = 0; iteration < 100; iteration++) {
    const mid = (lo + hi) / 2
    if (proportionsPower(baseline, baseline + mid, n, options) >= targetPower) hi = mid
    else lo = mid
  }
  return { absolute: hi, relative: hi / baseline }
}

/** One-way ANOVA power for Cohen's f with k groups of n (noncentral F, λ = f²·N). */
export function anovaPower(f: number, groups: number, nPerGroup: number, alpha = 0.05): number {
  const N = groups * nPerGroup
  const df1 = groups - 1
  const df2 = N - groups
  if (df2 <= 0) return Number.NaN
  return 1 - noncentralFCdf(fQuantile(1 - alpha, df1, df2), df1, df2, f * f * N)
}

export function anovaSampleSize(f: number, groups: number, targetPower = 0.8, alpha = 0.05): { nPerGroup: number; total: number; achievedPower: number } {
  const n = smallestN((k) => anovaPower(f, groups, k, alpha), targetPower, 2, 1_000_000)
  return { nPerGroup: n, total: n * groups, achievedPower: anovaPower(f, groups, n, alpha) }
}

/** Chi-square test power for Cohen's w with the given df (noncentral chi-square, λ = w²·N). */
export function chiSquarePower(w: number, df: number, n: number, alpha = 0.05): number {
  return 1 - noncentralChiSquareCdf(chiSquareQuantile(1 - alpha, df), df, w * w * n)
}

export function chiSquareSampleSize(w: number, df: number, targetPower = 0.8, alpha = 0.05): { n: number; achievedPower: number } {
  const n = smallestN((k) => chiSquarePower(w, df, k, alpha), targetPower, 2, 10_000_000)
  return { n, achievedPower: chiSquarePower(w, df, n, alpha) }
}

/** Power to detect correlation r with n pairs (Fisher z approximation). */
export function correlationPower(r: number, n: number, alpha = 0.05): number {
  if (n <= 3) return Number.NaN
  const z = Math.atanh(Math.abs(r)) * Math.sqrt(n - 3)
  const critical = normalQuantile(1 - alpha / 2)
  return normalCdf(z - critical) + normalCdf(-z - critical)
}

export function correlationSampleSize(r: number, targetPower = 0.8, alpha = 0.05): { n: number; achievedPower: number } {
  const n = smallestN((k) => correlationPower(r, k, alpha), targetPower, 4)
  return { n, achievedPower: correlationPower(r, n, alpha) }
}

/** Cohen's d from two means and a pooled standard deviation, for planning from pilot data. */
export function cohensDFromMeans(mean1: number, mean2: number, pooledSd: number): number {
  if (!(pooledSd > 0)) throw new Error('pooled standard deviation must be positive')
  return (mean1 - mean2) / pooledSd
}
