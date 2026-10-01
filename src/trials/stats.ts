/**
 * The statistics the outcome comparison needs and nothing more.
 *
 * Small on purpose: a permutation test needs no distributional assumption about
 * commit outcomes (which are bounded, lumpy and correlated, and nothing like
 * normal), and a percentile bootstrap gives an interval without one either.
 * Sample-size arithmetic is the one place a normal approximation is the standard
 * and honest choice.
 */

/** Deterministic generator, so a reported p-value can be reproduced and a test can assert on it. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const mean = (values: readonly number[]): number => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : Number.NaN)

export function median(values: readonly number[]): number {
  if (!values.length) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/** Sample standard deviation. */
export function sd(values: readonly number[]): number {
  if (values.length < 2) return Number.NaN
  const m = mean(values)
  return Math.sqrt(values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1))
}

/** The inverse of the standard normal CDF (Acklam's rational approximation, relative error ~1e-9). */
export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) throw new RangeError('p must be strictly between 0 and 1')
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239]
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1]
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416]
  const low = 0.02425
  const tail = (q: number): number => (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
  if (p < low) return tail(Math.sqrt(-2 * Math.log(p)))
  if (p > 1 - low) return -tail(Math.sqrt(-2 * Math.log(1 - p)))
  const q = p - 0.5
  const r = q * q
  return ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1)
}

export interface Observation {
  /** Commits are only compared with commits of the same kind and size. */
  stratum: string
  treated: boolean
  y: number
}

export interface Comparison {
  /** Treated minus control, averaged over strata that hold both. */
  diff: number
  /** 95% percentile-bootstrap interval for `diff`. */
  ci: [number, number]
  /** Two-sided permutation p-value (labels shuffled within strata). */
  p: number
  treated: number
  control: number
  strata: number
  /** Observations in strata missing one arm, which say nothing about a difference. */
  dropped: number
}

interface Group {
  ys: number[]
  treated: boolean[]
  n1: number
  n0: number
  weight: number
}

function grouped(observations: readonly Observation[]): { groups: Group[]; dropped: number } {
  const byStratum = new Map<string, Observation[]>()
  for (const observation of observations) byStratum.set(observation.stratum, [...(byStratum.get(observation.stratum) ?? []), observation])
  const groups: Group[] = []
  let dropped = 0
  for (const members of byStratum.values()) {
    const n1 = members.filter((member) => member.treated).length
    const n0 = members.length - n1
    if (n1 === 0 || n0 === 0) {
      dropped += members.length
      continue
    }
    groups.push({ ys: members.map((member) => member.y), treated: members.map((member) => member.treated), n1, n0, weight: (n1 * n0) / (n1 + n0) })
  }
  return { groups, dropped }
}

function difference(groups: readonly Group[]): number {
  let weighted = 0
  let weights = 0
  for (const group of groups) {
    let treatedSum = 0
    let total = 0
    for (let index = 0; index < group.ys.length; index += 1) {
      total += group.ys[index]!
      if (group.treated[index]) treatedSum += group.ys[index]!
    }
    weighted += group.weight * (treatedSum / group.n1 - (total - treatedSum) / group.n0)
    weights += group.weight
  }
  return weights ? weighted / weights : Number.NaN
}

function shuffle<T>(items: T[], random: () => number): void {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1))
    const held = items[index]!
    items[index] = items[swap]!
    items[swap] = held
  }
}

/**
 * The difference in mean outcome between two arms, holding stratum fixed, with a
 * permutation p-value and a bootstrap interval. Not causal on its own: it says
 * how the arms differ, and only randomization says why.
 */
export function stratifiedComparison(observations: readonly Observation[], options: { permutations?: number; bootstraps?: number; seed?: number } = {}): Comparison {
  const permutations = options.permutations ?? 4000
  const bootstraps = options.bootstraps ?? 2000
  const random = seeded(options.seed ?? 1)
  const { groups, dropped } = grouped(observations)
  const observed = difference(groups)
  const treated = groups.reduce((sum, group) => sum + group.n1, 0)
  const control = groups.reduce((sum, group) => sum + group.n0, 0)
  if (!groups.length) return { diff: Number.NaN, ci: [Number.NaN, Number.NaN], p: Number.NaN, treated: 0, control: 0, strata: 0, dropped }

  const shuffled = groups.map((group) => ({ ...group, treated: [...group.treated] }))
  let extreme = 0
  for (let round = 0; round < permutations; round += 1) {
    for (const group of shuffled) shuffle(group.treated, random)
    if (Math.abs(difference(shuffled)) >= Math.abs(observed) - 1e-12) extreme += 1
  }

  const draws: number[] = []
  for (let round = 0; round < bootstraps; round += 1) {
    const resampled = groups.map((group) => {
      const arm1 = group.ys.filter((_, index) => group.treated[index])
      const arm0 = group.ys.filter((_, index) => !group.treated[index])
      const pick = (arm: number[]): number[] => arm.map(() => arm[Math.floor(random() * arm.length)]!)
      const ys = [...pick(arm1), ...pick(arm0)]
      return { ...group, ys, treated: ys.map((_, index) => index < arm1.length) }
    })
    draws.push(difference(resampled))
  }
  draws.sort((a, b) => a - b)
  const at = (fraction: number): number => draws[Math.min(draws.length - 1, Math.max(0, Math.floor(fraction * draws.length)))]!
  return { diff: observed, ci: [at(0.025), at(0.975)], p: (1 + extreme) / (permutations + 1), treated, control, strata: groups.length, dropped }
}

/** Per arm, to tell a mean shift of `delta` when outcomes have standard deviation `sigma`. */
export function requiredPerArmForMeans(sigma: number, delta: number, alpha = 0.05, power = 0.8): number {
  const z = normalQuantile(1 - alpha / 2) + normalQuantile(power)
  return Math.ceil((2 * z * z * sigma * sigma) / (delta * delta))
}

/** Per arm, to tell an event rate `p0` from `p1`. */
export function requiredPerArmForRates(p0: number, p1: number, alpha = 0.05, power = 0.8): number {
  const pooled = (p0 + p1) / 2
  const za = normalQuantile(1 - alpha / 2)
  const zb = normalQuantile(power)
  const numerator = za * Math.sqrt(2 * pooled * (1 - pooled)) + zb * Math.sqrt(p0 * (1 - p0) + p1 * (1 - p1))
  return Math.ceil((numerator * numerator) / ((p0 - p1) * (p0 - p1)))
}

/** The smallest mean shift `perArm` observations can tell from noise. */
export function minimumDetectableShift(sigma: number, perArm: number, alpha = 0.05, power = 0.8): number {
  return (normalQuantile(1 - alpha / 2) + normalQuantile(power)) * sigma * Math.sqrt(2 / perArm)
}
