/**
 * The estimators the Verified Discovery Engine measures itself with.
 *
 * The paper's Phase 0 exit criterion is "α, β, ε, σ, γ and λ logged per family,
 * with confidence intervals", and its gate for self-modification is an
 * anytime-valid test. Both need a handful of small, exact statistical tools;
 * they live here so every caller computes an interval, a correlation or an
 * e-value the same way.
 */

export interface RateEstimate {
  /** Successes over trials; `undefined` when there were no trials. */
  mean: number | undefined
  /** Wilson score interval. [0, 1] when there is no data. */
  lo: number
  hi: number
  successes: number
  trials: number
}

/**
 * A rate with its Wilson interval. Wilson rather than the normal approximation
 * because the rates this engine cares about sit near 0 (false accepts) or 1
 * (saturated tasks), where the normal interval claims certainty it has not got.
 */
export function wilson(successes: number, trials: number, z = 1.96): RateEstimate {
  if (trials <= 0) return { mean: undefined, lo: 0, hi: 1, successes: 0, trials: 0 }
  const k = Math.min(Math.max(0, successes), trials)
  const phat = k / trials
  const z2 = z * z
  const denominator = 1 + z2 / trials
  const centre = (phat + z2 / (2 * trials)) / denominator
  const half = (z * Math.sqrt((phat * (1 - phat)) / trials + z2 / (4 * trials * trials))) / denominator
  return { mean: phat, lo: Math.max(0, centre - half), hi: Math.min(1, centre + half), successes: k, trials }
}

/**
 * Pearson correlation of two 0/1 series (the φ coefficient). Used for §3.2's
 * ρ: pass two verifiers the same wrong candidates, mark each false accept as 1,
 * and this says how much the second judge actually adds. `undefined` when
 * either series is constant — ρ is not identified from data that never varies.
 */
export function phi(a: readonly boolean[], b: readonly boolean[]): number | undefined {
  const n = Math.min(a.length, b.length)
  if (n < 2) return undefined
  let n11 = 0
  let n1x = 0
  let nx1 = 0
  for (let i = 0; i < n; i++) {
    if (a[i]) n1x += 1
    if (b[i]) nx1 += 1
    if (a[i] && b[i]) n11 += 1
  }
  const pa = n1x / n
  const pb = nx1 / n
  const variance = pa * (1 - pa) * pb * (1 - pb)
  if (variance === 0) return undefined
  return (n11 / n - pa * pb) / Math.sqrt(variance)
}

/** Betting fractions the e-value mixes over — spread so a small or a large true gain both register. */
const BETTING_FRACTIONS = [0.05, 0.1, 0.2, 0.3, 0.5, 0.75]

/**
 * An e-value against "the mean paired difference is ≤ 0", for differences in
 * [−1, 1].
 *
 * Each fixed betting fraction λ gives a wealth `Π(1 + λxᵢ)` that is a
 * non-negative supermartingale under the null, and an average of them is too.
 * So `e ≥ 1/δ` rejects the null at level δ however the evidence was gathered —
 * including stopping early the moment it crosses, which is what makes it
 * anytime-valid (§8.2, PACE). Fixed fractions also make the product
 * independent of the order the tasks were scored in, so nobody can choose an
 * order that helps.
 */
export function eValue(differences: readonly number[]): number {
  let total = 0
  for (const lambda of BETTING_FRACTIONS) {
    let logWealth = 0
    for (const raw of differences) {
      const x = Math.min(1, Math.max(-1, raw))
      logWealth += Math.log(1 + lambda * x)
    }
    total += Math.exp(logWealth)
  }
  return total / BETTING_FRACTIONS.length
}

/**
 * The level spent on the `index`-th comparison (1-based) so the lifetime total
 * stays below `delta`: `δ · 6/(π²k²)`, which sums to δ over every k. This is the
 * comparison budget of §8.1 made open-ended — a loop that never stops proposing
 * still cannot accumulate more than δ of false acceptances.
 */
export function spentLevel(index: number, delta = 0.05): number {
  const k = Math.max(1, Math.floor(index))
  return (delta * 6) / (Math.PI * Math.PI * k * k)
}

export interface Summary {
  n: number
  mean: number
  variance: number
  sd: number
}

export function summarize(values: readonly number[]): Summary {
  const n = values.length
  if (n === 0) return { n: 0, mean: 0, variance: 0, sd: 0 }
  const mean = values.reduce((sum, value) => sum + value, 0) / n
  const variance = n < 2 ? 0 : values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1)
  return { n, mean, variance, sd: Math.sqrt(variance) }
}

export interface Slope {
  slope: number
  intercept: number
  /** Standard error of the slope; Infinity when it cannot be estimated. */
  se: number
  n: number
}

/**
 * Ordinary least squares of y on x. §6.1 measures the library elasticity γ as
 * the slope of log success on log library size; this is that regression.
 */
export function olsSlope(xs: readonly number[], ys: readonly number[]): Slope | undefined {
  const n = Math.min(xs.length, ys.length)
  if (n < 3) return undefined
  const mx = xs.slice(0, n).reduce((sum, x) => sum + x, 0) / n
  const my = ys.slice(0, n).reduce((sum, y) => sum + y, 0) / n
  let sxx = 0
  let sxy = 0
  for (let i = 0; i < n; i++) {
    sxx += (xs[i]! - mx) ** 2
    sxy += (xs[i]! - mx) * (ys[i]! - my)
  }
  if (sxx === 0) return undefined
  const slope = sxy / sxx
  const intercept = my - slope * mx
  let rss = 0
  for (let i = 0; i < n; i++) rss += (ys[i]! - (intercept + slope * xs[i]!)) ** 2
  const se = n > 2 ? Math.sqrt(rss / (n - 2) / sxx) : Number.POSITIVE_INFINITY
  return { slope, intercept, se, n }
}

/**
 * A small deterministic PRNG (mulberry32), so every simulation and every
 * randomized split in this directory is reproducible from its seed.
 */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
