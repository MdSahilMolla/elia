import { kendallTauB, mean, median, pearson, rank, skewness as adjustedSkew, spearman, standardDeviation, sum, tieGroups, variance, wilsonInterval, type Interval } from './describe.ts'
import { cholesky, matMul, symmetricEigen, transpose, zeros, type Matrix } from './linalg.ts'
import { chiSquareSf, fSf, hypergeometricLogPmf, kolmogorovSf, normalCdf, normalQuantile, tPValue, tQuantile, zPValue, type Alternative } from './special.ts'

/**
 * Classical hypothesis tests. Each returns the statistic, its reference distribution, the
 * p-value, an effect size with a CI where one is standard, and the assumptions the test
 * rests on — so the caller can distinguish "significant" from "large" and "valid".
 */

export interface Assumption {
  name: string
  status: 'met' | 'violated' | 'questionable' | 'not-checked'
  detail: string
}

export interface EffectSize {
  name: string
  value: number
  magnitude?: 'negligible' | 'small' | 'medium' | 'large'
  ci?: Interval
}

export interface TestResult {
  test: string
  statistic: number
  statisticName: string
  df?: number | [number, number]
  pValue: number
  alternative?: Alternative
  estimate?: Record<string, number>
  ci?: Interval
  effectSize?: EffectSize
  n: Record<string, number>
  method?: string
  assumptions: Assumption[]
  notes: string[]
}

function magnitude(value: number, thresholds: [number, number, number]): EffectSize['magnitude'] {
  const a = Math.abs(value)
  return a < thresholds[0] ? 'negligible' : a < thresholds[1] ? 'small' : a < thresholds[2] ? 'medium' : 'large'
}

function requireSize(values: ArrayLike<number>, min: number, label: string): void {
  if (values.length < min) throw new Error(`${label} needs at least ${min} non-missing values, got ${values.length}`)
}

// ---------------------------------------------------------------- t tests

export function oneSampleT(x: number[], mu = 0, alternative: Alternative = 'two-sided', level = 0.95): TestResult {
  requireSize(x, 2, 'one-sample t test')
  const n = x.length
  const m = mean(x)
  const sd = standardDeviation(x)
  const se = sd / Math.sqrt(n)
  const t = (m - mu) / se
  const df = n - 1
  const critical = tQuantile(1 - (1 - level) / 2, df)
  const d = (m - mu) / sd
  return {
    test: 'one-sample t test',
    statistic: t,
    statisticName: 't',
    df,
    pValue: tPValue(t, df, alternative),
    alternative,
    estimate: { mean: m, hypothesizedMean: mu, difference: m - mu },
    ci: { lower: m - critical * se, upper: m + critical * se, level, method: 't interval for the mean' },
    effectSize: { name: "Cohen's d", value: d, magnitude: magnitude(d, [0.2, 0.5, 0.8]) },
    n: { n },
    assumptions: [normalityAssumption(x, 'sample'), { name: 'independence', status: 'not-checked', detail: 'observations must be independent; this cannot be verified from the values alone' }],
    notes: [],
  }
}

export function twoSampleT(a: number[], b: number[], options: { equalVariance?: boolean; alternative?: Alternative; level?: number } = {}): TestResult {
  requireSize(a, 2, 'two-sample t test (group a)')
  requireSize(b, 2, 'two-sample t test (group b)')
  const alternative = options.alternative ?? 'two-sided'
  const level = options.level ?? 0.95
  const na = a.length
  const nb = b.length
  const ma = mean(a)
  const mb = mean(b)
  const va = variance(a)
  const vb = variance(b)
  let se: number
  let df: number
  if (options.equalVariance) {
    const pooled = ((na - 1) * va + (nb - 1) * vb) / (na + nb - 2)
    se = Math.sqrt(pooled * (1 / na + 1 / nb))
    df = na + nb - 2
  } else {
    const sa = va / na
    const sb = vb / nb
    se = Math.sqrt(sa + sb)
    df = (sa + sb) ** 2 / (sa ** 2 / (na - 1) + sb ** 2 / (nb - 1))
  }
  const diff = ma - mb
  const t = diff / se
  const critical = tQuantile(1 - (1 - level) / 2, df)
  const pooledSd = Math.sqrt(((na - 1) * va + (nb - 1) * vb) / (na + nb - 2))
  const d = diff / pooledSd
  const correction = 1 - 3 / (4 * (na + nb) - 9)
  const g = d * correction
  const seG = Math.sqrt((na + nb) / (na * nb) + (g * g) / (2 * (na + nb)))
  const z = normalQuantile(1 - (1 - level) / 2)
  const varianceRatio = Math.max(va, vb) / Math.min(va, vb)
  return {
    test: options.equalVariance ? "Student's two-sample t test" : "Welch's two-sample t test",
    statistic: t,
    statisticName: 't',
    df,
    pValue: tPValue(t, df, alternative),
    alternative,
    estimate: { meanA: ma, meanB: mb, difference: diff, sdA: Math.sqrt(va), sdB: Math.sqrt(vb) },
    ci: { lower: diff - critical * se, upper: diff + critical * se, level, method: 't interval for the difference in means' },
    effectSize: { name: "Hedges' g", value: g, magnitude: magnitude(g, [0.2, 0.5, 0.8]), ci: { lower: g - z * seG, upper: g + z * seG, level, method: 'normal approximation' } },
    n: { a: na, b: nb },
    assumptions: [
      normalityAssumption(a, 'group a'),
      normalityAssumption(b, 'group b'),
      options.equalVariance
        ? { name: 'equal variances', status: varianceRatio > 4 ? 'violated' : varianceRatio > 2 ? 'questionable' : 'met', detail: `variance ratio ${varianceRatio.toFixed(2)}; Welch's test does not need this assumption` }
        : { name: 'equal variances', status: 'met', detail: "not required: Welch's test allows unequal variances" },
      { name: 'independence', status: 'not-checked', detail: 'groups and observations must be independent (use a paired test for matched data)' },
    ],
    notes: [],
  }
}

export function pairedT(a: number[], b: number[], alternative: Alternative = 'two-sided', level = 0.95): TestResult {
  if (a.length !== b.length) throw new Error('paired t test needs two samples of equal length (one pair per row)')
  const differences = a.map((value, index) => value - b[index]!)
  const inner = oneSampleT(differences, 0, alternative, level)
  const dz = mean(differences) / standardDeviation(differences)
  return {
    ...inner,
    test: 'paired t test',
    estimate: { meanDifference: mean(differences), meanA: mean(a), meanB: mean(b) },
    effectSize: { name: "Cohen's dz", value: dz, magnitude: magnitude(dz, [0.2, 0.5, 0.8]) },
    n: { pairs: a.length },
    assumptions: [normalityAssumption(differences, 'paired differences'), { name: 'pairing', status: 'not-checked', detail: 'each row must pair the same unit measured twice' }],
  }
}

// ---------------------------------------------------------------- rank tests

/** Exact null distribution of the Mann–Whitney U statistic for small samples without ties: P(U ≤ u). */
function mannWhitneyExactCdf(u: number, n1: number, n2: number): number {
  // counts(m, n)[k] = arrangements of m and n values with U = k, by the standard recurrence.
  const memo = new Map<string, number[]>()
  const counts = (m: number, n: number): number[] => {
    const key = `${m},${n}`
    const cached = memo.get(key)
    if (cached) return cached
    let result: number[]
    if (m === 0 || n === 0) result = [1]
    else {
      const left = counts(m - 1, n)
      const right = counts(m, n - 1)
      result = new Array<number>(m * n + 1).fill(0)
      for (let k = 0; k < left.length; k++) result[k + n]! += left[k]!
      for (let k = 0; k < right.length; k++) result[k]! += right[k]!
    }
    memo.set(key, result)
    return result
  }
  const distribution = counts(n1, n2)
  const total = sum(distribution)
  let cumulative = 0
  for (let k = 0; k <= Math.floor(u); k++) cumulative += distribution[k] ?? 0
  return cumulative / total
}

export function mannWhitney(a: number[], b: number[], alternative: Alternative = 'two-sided'): TestResult {
  requireSize(a, 1, 'Mann–Whitney U (group a)')
  requireSize(b, 1, 'Mann–Whitney U (group b)')
  const n1 = a.length
  const n2 = b.length
  const ranks = rank([...a, ...b])
  const r1 = sum(ranks.slice(0, n1))
  const u1 = r1 - (n1 * (n1 + 1)) / 2
  const u2 = n1 * n2 - u1
  const ties = tieGroups([...a, ...b])
  const n = n1 + n2
  // SciPy's convention: the tail statistic is U1 for "greater", U2 for "less", and
  // max(U1, U2) doubled for two-sided; exact below 8 per group when there are no ties.
  const [tailU, factor] = alternative === 'greater' ? [u1, 1] : alternative === 'less' ? [u2, 1] : [Math.max(u1, u2), 2]
  let pValue: number
  let method: string
  if (Math.min(n1, n2) < 8 && ties.length === 0) {
    method = 'exact'
    pValue = factor * (1 - mannWhitneyExactCdf(tailU - 1, n1, n2))
  } else {
    method = 'asymptotic normal approximation with tie and continuity correction'
    const tieTerm = ties.reduce((total, t) => total + (t ** 3 - t), 0)
    const sigma = Math.sqrt(((n1 * n2) / 12) * (n + 1 - tieTerm / (n * (n - 1))))
    pValue = factor * normalCdf(-(tailU - (n1 * n2) / 2 - 0.5) / sigma)
  }
  pValue = Math.min(1, Math.max(0, pValue))
  const rankBiserial = (2 * u1) / (n1 * n2) - 1
  return {
    test: 'Mann–Whitney U test',
    statistic: u1,
    statisticName: 'U (group a)',
    pValue,
    alternative,
    estimate: { medianA: median(a), medianB: median(b), probabilityOfSuperiority: u1 / (n1 * n2) },
    effectSize: { name: 'rank-biserial correlation', value: rankBiserial, magnitude: magnitude(rankBiserial, [0.1, 0.3, 0.5]) },
    n: { a: n1, b: n2 },
    method,
    assumptions: [
      { name: 'independence', status: 'not-checked', detail: 'the two samples must be independent' },
      { name: 'interpretation', status: 'met', detail: 'tests whether one distribution tends to produce larger values; it is a test of medians only if the shapes are identical' },
    ],
    notes: ties.length ? [`${ties.length} tied value group(s) — tie-corrected variance used`] : [],
  }
}

function signedRankExactCdf(t: number, n: number): number {
  const max = (n * (n + 1)) / 2
  let counts = new Array<number>(max + 1).fill(0)
  counts[0] = 1
  for (let k = 1; k <= n; k++) {
    const next = [...counts]
    for (let s = k; s <= max; s++) next[s]! += counts[s - k]!
    counts = next
  }
  const total = 2 ** n
  let cumulative = 0
  for (let s = 0; s <= Math.floor(t); s++) cumulative += counts[s]!
  return cumulative / total
}

/** Wilcoxon signed-rank test on paired samples (or one sample against `mu`). Zero differences are dropped. */
export function wilcoxonSignedRank(a: number[], b?: number[], options: { mu?: number; alternative?: Alternative } = {}): TestResult {
  const alternative = options.alternative ?? 'two-sided'
  if (b && a.length !== b.length) throw new Error('Wilcoxon signed-rank needs paired samples of equal length')
  const differences = (b ? a.map((value, index) => value - b[index]!) : a.map((value) => value - (options.mu ?? 0))).filter((value) => value !== 0)
  const zeros = a.length - differences.length
  requireSize(differences, 1, 'Wilcoxon signed-rank (non-zero differences)')
  const n = differences.length
  const ranks = rank(differences.map(Math.abs))
  let tPlus = 0
  let tMinus = 0
  differences.forEach((d, index) => (d > 0 ? (tPlus += ranks[index]!) : (tMinus += ranks[index]!)))
  const ties = tieGroups(differences.map(Math.abs))
  let pValue: number
  let method: string
  if (n <= 50 && ties.length === 0 && zeros === 0) {
    method = 'exact'
    const lower = signedRankExactCdf(tPlus, n)
    const upper = 1 - signedRankExactCdf(tPlus - 1, n)
    pValue = alternative === 'less' ? lower : alternative === 'greater' ? upper : Math.min(1, 2 * Math.min(lower, upper))
  } else if (n <= 13) {
    // Ties or dropped zeros make the tabulated distribution inexact; with 2^n ≤ 8192 sign
    // patterns the conditional distribution of T+ given these ranks is enumerated exactly.
    method = 'exact sign-flip enumeration (ties present)'
    let lower = 0
    let upper = 0
    const patterns = 2 ** n
    for (let mask = 0; mask < patterns; mask++) {
      let total = 0
      for (let bit = 0; bit < n; bit++) if (mask & (1 << bit)) total += ranks[bit]!
      if (total <= tPlus + 1e-9) lower++
      if (total >= tPlus - 1e-9) upper++
    }
    lower /= patterns
    upper /= patterns
    pValue = alternative === 'less' ? lower : alternative === 'greater' ? upper : Math.min(1, 2 * Math.min(lower, upper))
  } else {
    method = 'asymptotic normal approximation with tie correction'
    const mu = (n * (n + 1)) / 4
    const tieTerm = ties.reduce((total, t) => total + (t ** 3 - t), 0)
    const sigma = Math.sqrt((n * (n + 1) * (2 * n + 1)) / 24 - tieTerm / 48)
    const z = (tPlus - mu) / sigma
    pValue = zPValue(z, alternative)
  }
  const rankBiserial = (tPlus - tMinus) / (tPlus + tMinus)
  return {
    test: b ? 'Wilcoxon signed-rank test (paired)' : 'Wilcoxon signed-rank test (one sample)',
    statistic: alternative === 'two-sided' ? Math.min(tPlus, tMinus) : tPlus,
    statisticName: alternative === 'two-sided' ? 'min(T+, T-)' : 'T+',
    pValue,
    alternative,
    estimate: { medianDifference: median(differences), tPlus, tMinus },
    effectSize: { name: 'matched-pairs rank-biserial correlation', value: rankBiserial, magnitude: magnitude(rankBiserial, [0.1, 0.3, 0.5]) },
    n: { nonZeroDifferences: n, zeroDifferencesDropped: zeros },
    method,
    assumptions: [{ name: 'symmetry', status: 'not-checked', detail: 'differences are assumed symmetric about their median' }],
    notes: zeros ? [`${zeros} zero difference(s) dropped (Wilcoxon's method)`] : [],
  }
}

// ---------------------------------------------------------------- k-sample tests

export function oneWayAnova(groups: Record<string, number[]>): TestResult {
  const names = Object.keys(groups).filter((name) => groups[name]!.length > 0)
  if (names.length < 2) throw new Error('ANOVA needs at least two non-empty groups')
  const all = names.flatMap((name) => groups[name]!)
  const grand = mean(all)
  const k = names.length
  const N = all.length
  let ssBetween = 0
  let ssWithin = 0
  for (const name of names) {
    const values = groups[name]!
    const m = mean(values)
    ssBetween += values.length * (m - grand) ** 2
    for (const value of values) ssWithin += (value - m) ** 2
  }
  const df1 = k - 1
  const df2 = N - k
  if (df2 <= 0) throw new Error('ANOVA needs more observations than groups')
  const msWithin = ssWithin / df2
  const F = ssBetween / df1 / msWithin
  const ssTotal = ssBetween + ssWithin
  const eta2 = ssTotal === 0 ? 0 : ssBetween / ssTotal
  const omega2 = Math.max(0, (ssBetween - df1 * msWithin) / (ssTotal + msWithin))
  const lev = levene(groups)
  const welch = welchAnova(groups)
  return {
    test: 'one-way ANOVA',
    statistic: F,
    statisticName: 'F',
    df: [df1, df2],
    pValue: fSf(F, df1, df2),
    estimate: Object.fromEntries(names.map((name) => [`mean[${name}]`, mean(groups[name]!)])),
    effectSize: { name: 'omega squared', value: omega2, magnitude: magnitude(Math.sqrt(omega2 / Math.max(1e-12, 1 - omega2)), [0.1, 0.25, 0.4]) },
    n: Object.fromEntries(names.map((name) => [name, groups[name]!.length])),
    assumptions: [
      { name: 'equal variances', status: lev.pValue < 0.05 ? 'violated' : 'met', detail: `Brown–Forsythe Levene p = ${lev.pValue.toPrecision(3)}${lev.pValue < 0.05 ? `; prefer Welch's ANOVA (F = ${welch.statistic.toFixed(3)}, p = ${welch.pValue.toPrecision(3)})` : ''}` },
      ...names.slice(0, 6).map((name) => normalityAssumption(groups[name]!, `group ${name}`)),
    ],
    notes: [`eta squared = ${eta2.toFixed(4)} (biased upward; omega squared reported as the effect size)`],
  }
}

export function welchAnova(groups: Record<string, number[]>): TestResult {
  const names = Object.keys(groups).filter((name) => groups[name]!.length > 1)
  if (names.length < 2) throw new Error("Welch's ANOVA needs at least two groups of two or more values")
  const k = names.length
  const stats = names.map((name) => ({ n: groups[name]!.length, m: mean(groups[name]!), v: variance(groups[name]!) }))
  if (stats.some((s) => s.v === 0)) throw new Error("Welch's ANOVA is undefined when a group has zero variance")
  const w = stats.map((s) => s.n / s.v)
  const W = sum(w)
  const weightedMean = sum(stats.map((s, index) => w[index]! * s.m)) / W
  const A = sum(stats.map((s, index) => w[index]! * (s.m - weightedMean) ** 2)) / (k - 1)
  const tmp = sum(stats.map((s, index) => (1 - w[index]! / W) ** 2 / (s.n - 1)))
  const B = 1 + ((2 * (k - 2)) / (k * k - 1)) * tmp
  const F = A / B
  const df2 = (k * k - 1) / (3 * tmp)
  return {
    test: "Welch's one-way ANOVA",
    statistic: F,
    statisticName: 'F',
    df: [k - 1, df2],
    pValue: fSf(F, k - 1, df2),
    n: Object.fromEntries(names.map((name, index) => [name, stats[index]!.n])),
    assumptions: [{ name: 'equal variances', status: 'met', detail: 'not required by Welch’s ANOVA' }],
    notes: [],
  }
}

export function kruskalWallis(groups: Record<string, number[]>): TestResult {
  const names = Object.keys(groups).filter((name) => groups[name]!.length > 0)
  if (names.length < 2) throw new Error('Kruskal–Wallis needs at least two non-empty groups')
  const all = names.flatMap((name) => groups[name]!)
  const N = all.length
  const ranks = rank(all)
  let offset = 0
  let h = 0
  for (const name of names) {
    const size = groups[name]!.length
    const rankSum = sum(ranks.slice(offset, offset + size))
    h += (rankSum * rankSum) / size
    offset += size
  }
  h = (12 / (N * (N + 1))) * h - 3 * (N + 1)
  const ties = tieGroups(all)
  const correction = 1 - ties.reduce((total, t) => total + (t ** 3 - t), 0) / (N ** 3 - N)
  if (correction > 0) h /= correction
  const df = names.length - 1
  const epsilon2 = h / ((N * N - 1) / (N + 1))
  return {
    test: 'Kruskal–Wallis H test',
    statistic: h,
    statisticName: 'H',
    df,
    pValue: chiSquareSf(h, df),
    estimate: Object.fromEntries(names.map((name) => [`median[${name}]`, median(groups[name]!)])),
    effectSize: { name: 'epsilon squared', value: epsilon2, magnitude: magnitude(Math.sqrt(epsilon2), [0.1, 0.3, 0.5]) },
    n: Object.fromEntries(names.map((name) => [name, groups[name]!.length])),
    method: 'chi-square approximation with tie correction',
    assumptions: [{ name: 'independence', status: 'not-checked', detail: 'groups and observations must be independent' }],
    notes: [],
  }
}

/** Brown–Forsythe variant of Levene's test (deviations from group medians), SciPy's default. */
export function levene(groups: Record<string, number[]>): TestResult {
  const names = Object.keys(groups).filter((name) => groups[name]!.length > 0)
  const deviations: Record<string, number[]> = {}
  for (const name of names) {
    const m = median(groups[name]!)
    deviations[name] = groups[name]!.map((value) => Math.abs(value - m))
  }
  const all = names.flatMap((name) => deviations[name]!)
  const grand = mean(all)
  const k = names.length
  const N = all.length
  let between = 0
  let within = 0
  for (const name of names) {
    const values = deviations[name]!
    const m = mean(values)
    between += values.length * (m - grand) ** 2
    for (const value of values) within += (value - m) ** 2
  }
  const W = within === 0 ? Number.POSITIVE_INFINITY : ((N - k) / (k - 1)) * (between / within)
  return { test: "Levene's test (Brown–Forsythe, median-centred)", statistic: W, statisticName: 'W', df: [k - 1, N - k], pValue: Number.isFinite(W) ? fSf(W, k - 1, N - k) : 0, n: Object.fromEntries(names.map((name) => [name, groups[name]!.length])), assumptions: [], notes: [] }
}

export function bartlett(groups: Record<string, number[]>): TestResult {
  const names = Object.keys(groups).filter((name) => groups[name]!.length > 1)
  const k = names.length
  const ns = names.map((name) => groups[name]!.length)
  const vs = names.map((name) => variance(groups[name]!))
  const N = sum(ns)
  const pooled = sum(ns.map((n, index) => (n - 1) * vs[index]!)) / (N - k)
  const numerator = (N - k) * Math.log(pooled) - sum(ns.map((n, index) => (n - 1) * Math.log(vs[index]!)))
  const denominator = 1 + (1 / (3 * (k - 1))) * (sum(ns.map((n) => 1 / (n - 1))) - 1 / (N - k))
  const T = numerator / denominator
  return { test: "Bartlett's test for equal variances", statistic: T, statisticName: 'T', df: k - 1, pValue: chiSquareSf(T, k - 1), n: Object.fromEntries(names.map((name, index) => [name, ns[index]!])), assumptions: [{ name: 'normality', status: 'not-checked', detail: "Bartlett's test is sensitive to non-normality; Levene's test is more robust" }], notes: [] }
}

// ---------------------------------------------------------------- categorical

export function chiSquareIndependence(table: number[][], options: { yates?: boolean } = {}): TestResult & { expected: number[][] } {
  const rows = table.length
  const cols = table[0]?.length ?? 0
  if (rows < 2 || cols < 2) throw new Error('chi-square test of independence needs at least a 2×2 table')
  const rowTotals = table.map((row) => sum(row))
  const colTotals = Array.from({ length: cols }, (_, j) => sum(table.map((row) => row[j]!)))
  const total = sum(rowTotals)
  const expected = table.map((_, i) => colTotals.map((c) => (rowTotals[i]! * c) / total))
  const df = (rows - 1) * (cols - 1)
  const yates = options.yates ?? df === 1
  let statistic = 0
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const e = expected[i]![j]!
      if (e === 0) continue
      const diff = Math.abs(table[i]![j]! - e)
      const corrected = yates ? Math.max(0, diff - Math.min(0.5, diff)) : diff
      statistic += (corrected * corrected) / e
    }
  }
  const minExpected = Math.min(...expected.flat())
  const smallCells = expected.flat().filter((e) => e < 5).length
  const cramersV = Math.sqrt(statistic / (total * Math.min(rows - 1, cols - 1)))
  return {
    test: `Pearson chi-square test of independence${yates ? ' (Yates continuity correction)' : ''}`,
    statistic,
    statisticName: 'chi-square',
    df,
    pValue: chiSquareSf(statistic, df),
    effectSize: { name: "Cramér's V", value: cramersV, magnitude: magnitude(cramersV, [0.1, 0.3, 0.5]) },
    n: { total },
    expected,
    assumptions: [{ name: 'expected counts', status: smallCells === 0 ? 'met' : smallCells / (rows * cols) > 0.2 || minExpected < 1 ? 'violated' : 'questionable', detail: `${smallCells} of ${rows * cols} cells have expected count < 5 (min ${minExpected.toFixed(2)})${smallCells && rows === 2 && cols === 2 ? "; use Fisher's exact test" : ''}` }],
    notes: [],
  }
}

export function chiSquareGoodnessOfFit(observed: number[], expectedProportions?: number[]): TestResult {
  const total = sum(observed)
  const k = observed.length
  const proportions = expectedProportions ?? new Array<number>(k).fill(1 / k)
  if (proportions.length !== k) throw new Error('expected proportions must match the number of categories')
  const scale = sum(proportions)
  const expected = proportions.map((p) => (p / scale) * total)
  const statistic = sum(observed.map((o, index) => (o - expected[index]!) ** 2 / expected[index]!))
  const small = expected.filter((e) => e < 5).length
  return { test: 'chi-square goodness-of-fit test', statistic, statisticName: 'chi-square', df: k - 1, pValue: chiSquareSf(statistic, k - 1), n: { total }, assumptions: [{ name: 'expected counts', status: small ? 'questionable' : 'met', detail: `${small} categories have expected count < 5` }], notes: [] }
}

/** Fisher's exact test on a 2×2 table [[a, b], [c, d]]; two-sided p sums tables no more likely than observed. */
export function fisherExact(table: number[][], alternative: Alternative = 'two-sided', level = 0.95): TestResult {
  const [[a, b], [c, d]] = table as [[number, number], [number, number]]
  const n = a + b + c + d
  const row1 = a + b
  const col1 = a + c
  const minA = Math.max(0, row1 + col1 - n)
  const maxA = Math.min(row1, col1)
  const logP = (x: number) => hypergeometricLogPmf(x, n, col1, row1)
  const observed = logP(a)
  let pValue = 0
  if (alternative === 'less') for (let x = minA; x <= a; x++) pValue += Math.exp(logP(x))
  else if (alternative === 'greater') for (let x = a; x <= maxA; x++) pValue += Math.exp(logP(x))
  else for (let x = minA; x <= maxA; x++) if (logP(x) <= observed + 1e-7 * Math.abs(observed) + 1e-12) pValue += Math.exp(logP(x))
  const haldane = a === 0 || b === 0 || c === 0 || d === 0
  const [aa, bb, cc, dd] = haldane ? [a + 0.5, b + 0.5, c + 0.5, d + 0.5] : [a, b, c, d]
  const oddsRatio = (aa * dd) / (bb * cc)
  const seLog = Math.sqrt(1 / aa + 1 / bb + 1 / cc + 1 / dd)
  const z = normalQuantile(1 - (1 - level) / 2)
  return {
    test: "Fisher's exact test",
    statistic: b * c === 0 ? Number.POSITIVE_INFINITY : (a * d) / (b * c),
    statisticName: 'sample odds ratio',
    pValue: Math.min(1, pValue),
    alternative,
    effectSize: { name: 'odds ratio', value: oddsRatio, ci: { lower: Math.exp(Math.log(oddsRatio) - z * seLog), upper: Math.exp(Math.log(oddsRatio) + z * seLog), level, method: `Woolf log interval${haldane ? ' with Haldane +0.5 correction' : ''}` } },
    n: { total: n },
    assumptions: [{ name: 'fixed margins', status: 'met', detail: 'conditions on the observed row and column totals; valid for any sample size' }],
    notes: [],
  }
}

/** Two-proportion z test with a Newcombe (Wilson-score) CI for the difference and a log CI for the ratio. */
export function twoProportionZ(successesA: number, nA: number, successesB: number, nB: number, alternative: Alternative = 'two-sided', level = 0.95): TestResult {
  if (nA <= 0 || nB <= 0) throw new Error('two-proportion test needs positive group sizes')
  const pA = successesA / nA
  const pB = successesB / nB
  const pooled = (successesA + successesB) / (nA + nB)
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / nA + 1 / nB))
  const z = se === 0 ? 0 : (pA - pB) / se
  const wa = wilsonInterval(successesA, nA, level)
  const wb = wilsonInterval(successesB, nB, level)
  const diff = pA - pB
  const lower = diff - Math.sqrt((pA - wa.lower) ** 2 + (wb.upper - pB) ** 2)
  const upper = diff + Math.sqrt((wa.upper - pA) ** 2 + (pB - wb.lower) ** 2)
  const h = 2 * Math.asin(Math.sqrt(pA)) - 2 * Math.asin(Math.sqrt(pB))
  const notes: string[] = []
  let ratioCi: Interval | undefined
  if (successesA > 0 && successesB > 0) {
    const seLogRatio = Math.sqrt(1 / successesA - 1 / nA + 1 / successesB - 1 / nB)
    const zc = normalQuantile(1 - (1 - level) / 2)
    ratioCi = { lower: Math.exp(Math.log(pA / pB) - zc * seLogRatio), upper: Math.exp(Math.log(pA / pB) + zc * seLogRatio), level, method: 'Katz log interval for the risk ratio' }
  } else notes.push('risk ratio CI omitted because a group has zero successes')
  const smallCounts = [successesA, nA - successesA, successesB, nB - successesB].some((count) => count < 5)
  return {
    test: 'two-proportion z test',
    statistic: z,
    statisticName: 'z',
    pValue: zPValue(z, alternative),
    alternative,
    estimate: { proportionA: pA, proportionB: pB, difference: diff, relativeLift: pB === 0 ? Number.NaN : pA / pB - 1, ...(ratioCi ? { riskRatioLower: ratioCi.lower, riskRatioUpper: ratioCi.upper } : {}) },
    ci: { lower, upper, level, method: 'Newcombe hybrid score interval for the difference' },
    effectSize: { name: "Cohen's h", value: h, magnitude: magnitude(h, [0.2, 0.5, 0.8]) },
    n: { a: nA, b: nB },
    assumptions: [{ name: 'large-sample approximation', status: smallCounts ? 'questionable' : 'met', detail: smallCounts ? "a success or failure count is below 5; prefer Fisher's exact test" : 'every success and failure count is at least 5' }],
    notes,
  }
}

// ---------------------------------------------------------------- normality

function poly(coefficients: number[], x: number): number {
  let result = coefficients[0]!
  if (coefficients.length > 1) {
    let p = x * coefficients[coefficients.length - 1]!
    for (let j = coefficients.length - 2; j > 0; j--) p = (p + coefficients[j]!) * x
    result += p
  }
  return result
}

/** Shapiro–Wilk W test (Royston 1995, algorithm AS R94), valid for 3 ≤ n ≤ 5000. */
export function shapiroWilk(values: number[]): TestResult {
  const n = values.length
  if (n < 3) throw new Error('Shapiro–Wilk needs at least 3 values')
  const x = [...values].sort((p, q) => p - q)
  const middle = x[Math.floor(n / 2)]!
  for (let index = 0; index < n; index++) x[index]! -= middle
  const nn2 = Math.floor(n / 2)
  const a = new Array<number>(nn2 + 1).fill(0)
  const small = 1e-19
  const g = [-2.273, 0.459]
  const c1 = [0, 0.221157, -0.147981, -2.07119, 4.434685, -2.706056]
  const c2 = [0, 0.042981, -0.293762, -1.752461, 5.682633, -3.582633]
  const c3 = [0.544, -0.39978, 0.025054, -6.714e-4]
  const c4 = [1.3822, -0.77857, 0.062767, -0.0020322]
  const c5 = [-1.5861, -0.31082, -0.083751, 0.0038915]
  const c6 = [-0.4803, -0.082676, 0.0030302]
  const an = n
  if (n === 3) a[1] = Math.SQRT1_2
  else {
    const an25 = an + 0.25
    let summ2 = 0
    for (let i = 1; i <= nn2; i++) {
      a[i] = normalQuantile((i - 0.375) / an25)
      summ2 += a[i]! ** 2
    }
    summ2 *= 2
    const ssumm2 = Math.sqrt(summ2)
    const rsn = 1 / Math.sqrt(an)
    const a1 = poly(c1, rsn) - a[1]! / ssumm2
    let i1: number
    let fac: number
    if (n > 5) {
      i1 = 3
      const a2 = -a[2]! / ssumm2 + poly(c2, rsn)
      fac = Math.sqrt((summ2 - 2 * a[1]! ** 2 - 2 * a[2]! ** 2) / (1 - 2 * a1 ** 2 - 2 * a2 ** 2))
      a[2] = a2
    } else {
      i1 = 2
      fac = Math.sqrt((summ2 - 2 * a[1]! ** 2) / (1 - 2 * a1 ** 2))
    }
    a[1] = a1
    for (let i = i1; i <= nn2; i++) a[i] = a[i]! / -fac
  }
  const range = x[n - 1]! - x[0]!
  if (range < small) throw new Error('Shapiro–Wilk is undefined for a sample with zero range')
  let sx = x[0]! / range
  let sa = -a[1]!
  for (let i = 1, j = n - 1; i < n; j--) {
    const xi = x[i]! / range
    sx += xi
    i++
    if (i !== j) sa += Math.sign(i - j) * a[Math.min(i, j)]!
  }
  sa /= n
  sx /= n
  let ssa = 0
  let ssx = 0
  let sax = 0
  for (let i = 0, j = n - 1; i < n; i++, j--) {
    const asa = i !== j ? Math.sign(i - j) * a[1 + Math.min(i, j)]! - sa : -sa
    const xsx = x[i]! / range - sx
    ssa += asa * asa
    ssx += xsx * xsx
    sax += asa * xsx
  }
  const ssassx = Math.sqrt(ssa * ssx)
  const w1 = ((ssassx - sax) * (ssassx + sax)) / (ssa * ssx)
  const w = 1 - w1
  let pValue: number
  if (n === 3) {
    pValue = Math.max(0, 1.90985931710274 * (Math.asin(Math.sqrt(w)) - 1.0471975511966))
  } else if (n <= 11) {
    const gamma = poly(g, an)
    const y = Math.log(w1)
    pValue = y >= gamma ? 1e-99 : normalCdf(Math.log(gamma - y), -poly(c3, an), Math.exp(poly(c4, an)))
  } else {
    const lxx = Math.log(an)
    pValue = normalCdf(-Math.log(w1), -poly(c5, lxx), Math.exp(poly(c6, lxx)))
  }
  return {
    test: 'Shapiro–Wilk normality test',
    statistic: w,
    statisticName: 'W',
    pValue,
    n: { n },
    method: 'Royston (1995) approximation',
    assumptions: n > 5000 ? [{ name: 'sample size', status: 'questionable', detail: 'the approximation is calibrated for n ≤ 5000' }] : [],
    notes: ['A small p-value is evidence against normality; with large n even trivial departures become significant, so read it alongside skewness, kurtosis, and a Q-Q view.'],
  }
}

/** D'Agostino–Pearson K² omnibus normality test (SciPy's `normaltest`). */
export function dagostinoPearson(values: number[]): TestResult {
  const n = values.length
  if (n < 8) throw new Error("D'Agostino–Pearson needs at least 8 values")
  const m = mean(values)
  let m2 = 0
  let m3 = 0
  let m4 = 0
  for (const value of values) {
    const d = value - m
    m2 += d * d
    m3 += d ** 3
    m4 += d ** 4
  }
  m2 /= n
  m3 /= n
  m4 /= n
  const b1 = m2 === 0 ? 0 : m3 / m2 ** 1.5
  let y = b1 * Math.sqrt(((n + 1) * (n + 3)) / (6 * (n - 2)))
  const beta2 = (3 * (n * n + 27 * n - 70) * (n + 1) * (n + 3)) / ((n - 2) * (n + 5) * (n + 7) * (n + 9))
  const W2 = -1 + Math.sqrt(2 * (beta2 - 1))
  const delta = 1 / Math.sqrt(0.5 * Math.log(W2))
  const alpha = Math.sqrt(2 / (W2 - 1))
  if (y === 0) y = 1
  const zSkew = delta * Math.log(y / alpha + Math.sqrt((y / alpha) ** 2 + 1))
  const b2 = m2 === 0 ? 3 : m4 / (m2 * m2)
  const E = (3 * (n - 1)) / (n + 1)
  const varb2 = (24 * n * (n - 2) * (n - 3)) / ((n + 1) ** 2 * (n + 3) * (n + 5))
  const xk = (b2 - E) / Math.sqrt(varb2)
  const sqrtbeta1 = ((6 * (n * n - 5 * n + 2)) / ((n + 7) * (n + 9))) * Math.sqrt((6 * (n + 3) * (n + 5)) / (n * (n - 2) * (n - 3)))
  const A = 6 + (8 / sqrtbeta1) * (2 / sqrtbeta1 + Math.sqrt(1 + 4 / sqrtbeta1 ** 2))
  const term1 = 1 - 2 / (9 * A)
  const denom = 1 + xk * Math.sqrt(2 / (A - 4))
  const term2 = denom === 0 ? Number.NaN : Math.sign(denom) * ((1 - 2 / A) / Math.abs(denom)) ** (1 / 3)
  const zKurt = (term1 - term2) / Math.sqrt(2 / (9 * A))
  const k2 = zSkew * zSkew + zKurt * zKurt
  return { test: "D'Agostino–Pearson K² normality test", statistic: k2, statisticName: 'K²', df: 2, pValue: chiSquareSf(k2, 2), estimate: { zSkewness: zSkew, zKurtosis: zKurt }, n: { n }, assumptions: n < 20 ? [{ name: 'sample size', status: 'questionable', detail: 'the kurtosis test is only valid for n ≥ 20' }] : [], notes: [] }
}

export function jarqueBera(values: number[]): TestResult {
  const n = values.length
  if (n < 3) throw new Error('Jarque–Bera needs at least 3 values')
  const m = mean(values)
  let m2 = 0
  let m3 = 0
  let m4 = 0
  for (const value of values) {
    const d = value - m
    m2 += d * d
    m3 += d ** 3
    m4 += d ** 4
  }
  m2 /= n
  m3 /= n
  m4 /= n
  const s = m3 / m2 ** 1.5
  const k = m4 / (m2 * m2)
  const jb = (n / 6) * (s * s + ((k - 3) ** 2) / 4)
  return { test: 'Jarque–Bera normality test', statistic: jb, statisticName: 'JB', df: 2, pValue: chiSquareSf(jb, 2), estimate: { skewness: s, kurtosis: k }, n: { n }, assumptions: n < 100 ? [{ name: 'sample size', status: 'questionable', detail: 'the chi-square approximation is poor for small samples' }] : [], notes: [] }
}

/** A cheap normality verdict for assumption lists: Shapiro–Wilk for n ≤ 5000, skew/size heuristics otherwise. */
export function normalityAssumption(values: number[], label: string): Assumption {
  const n = values.length
  if (n < 3) return { name: `normality (${label})`, status: 'not-checked', detail: 'too few values to check' }
  if (n >= 30) {
    const skew = adjustedSkew(values)
    return Math.abs(skew) > 2
      ? { name: `normality (${label})`, status: 'questionable', detail: `n = ${n} but skewness ${skew.toFixed(2)}; the mean-based test relies on the CLT and may be distorted by heavy skew — consider a rank test or a transform` }
      : { name: `normality (${label})`, status: 'met', detail: `n = ${n} ≥ 30 with skewness ${skew.toFixed(2)}; the sampling distribution of the mean is approximately normal` }
  }
  try {
    const sw = shapiroWilk(values)
    return { name: `normality (${label})`, status: sw.pValue < 0.05 ? 'violated' : 'met', detail: `Shapiro–Wilk W = ${sw.statistic.toFixed(3)}, p = ${sw.pValue.toPrecision(3)} (n = ${n})` }
  } catch (error) {
    return { name: `normality (${label})`, status: 'not-checked', detail: (error as Error).message }
  }
}

// ---------------------------------------------------------------- correlation tests

export function correlationTest(x: number[], y: number[], method: 'pearson' | 'spearman' | 'kendall' = 'pearson', level = 0.95): TestResult {
  if (x.length !== y.length) throw new Error('correlation needs paired values')
  const n = x.length
  if (n < 3) throw new Error('correlation test needs at least 3 complete pairs')
  if (method === 'kendall') {
    const { tau, z } = kendallTauB(x, y)
    return { test: "Kendall's tau-b", statistic: tau, statisticName: 'tau-b', pValue: zPValue(z), estimate: { tau }, effectSize: { name: 'tau-b', value: tau, magnitude: magnitude(tau, [0.1, 0.3, 0.5]) }, n: { pairs: n }, method: 'asymptotic normal approximation with tie correction', assumptions: [], notes: ['Correlation measures association, not causation.'] }
  }
  const r = method === 'spearman' ? spearman(x, y) : pearson(x, y)
  const df = n - 2
  const t = r * Math.sqrt(df / Math.max(1e-300, 1 - r * r))
  const pValue = Math.abs(r) >= 1 ? 0 : tPValue(t, df)
  const zc = normalQuantile(1 - (1 - level) / 2)
  const fisher = Math.atanh(Math.max(-0.999999999, Math.min(0.999999999, r)))
  const se = 1 / Math.sqrt(n - 3)
  const ci = n > 3 ? { lower: Math.tanh(fisher - zc * se), upper: Math.tanh(fisher + zc * se), level, method: 'Fisher z transform' } : undefined
  return {
    test: method === 'spearman' ? "Spearman's rank correlation" : "Pearson's product-moment correlation",
    statistic: r,
    statisticName: method === 'spearman' ? 'rho' : 'r',
    df,
    pValue,
    estimate: { r, rSquared: r * r },
    ...(ci ? { ci } : {}),
    effectSize: { name: method === 'spearman' ? 'rho' : 'r', value: r, magnitude: magnitude(r, [0.1, 0.3, 0.5]) },
    n: { pairs: n },
    method: 't distribution with n - 2 degrees of freedom',
    assumptions: method === 'pearson' ? [{ name: 'linearity', status: 'not-checked', detail: 'Pearson r measures linear association only; inspect a scatter plot or use Spearman for monotone relationships' }] : [],
    notes: ['Correlation measures association, not causation.'],
  }
}

// ---------------------------------------------------------------- distribution comparison

export function kolmogorovSmirnov2(a: number[], b: number[]): TestResult {
  requireSize(a, 1, 'KS test (sample a)')
  requireSize(b, 1, 'KS test (sample b)')
  const x = [...a].sort((p, q) => p - q)
  const y = [...b].sort((p, q) => p - q)
  let i = 0
  let j = 0
  let d = 0
  while (i < x.length && j < y.length) {
    const value = Math.min(x[i]!, y[j]!)
    while (i < x.length && x[i]! <= value) i++
    while (j < y.length && y[j]! <= value) j++
    d = Math.max(d, Math.abs(i / x.length - j / y.length))
  }
  const ne = (x.length * y.length) / (x.length + y.length)
  const lambda = (Math.sqrt(ne) + 0.12 + 0.11 / Math.sqrt(ne)) * d
  return { test: 'two-sample Kolmogorov–Smirnov test', statistic: d, statisticName: 'D', pValue: kolmogorovSf(lambda), n: { a: x.length, b: y.length }, method: 'asymptotic Kolmogorov distribution with Stephens correction', assumptions: [{ name: 'continuity', status: 'not-checked', detail: 'the test is conservative for discrete data with many ties' }], notes: [] }
}

// ---------------------------------------------------------------- MANOVA

/** One-way MANOVA with Pillai's trace (robust default) and Wilks' lambda, both with F approximations. */
export function manova(groups: Record<string, number[][]>): TestResult {
  const names = Object.keys(groups).filter((name) => groups[name]!.length > 0)
  const k = names.length
  if (k < 2) throw new Error('MANOVA needs at least two groups')
  const p = groups[names[0]!]![0]!.length
  const all = names.flatMap((name) => groups[name]!)
  const N = all.length
  if (N - k < p) throw new Error('MANOVA needs more observations than groups plus responses')
  const grand = Array.from({ length: p }, (_, j) => mean(all.map((row) => row[j]!)))
  const H = zeros(p, p)
  const E = zeros(p, p)
  for (const name of names) {
    const rows = groups[name]!
    const gm = Array.from({ length: p }, (_, j) => mean(rows.map((row) => row[j]!)))
    for (let i = 0; i < p; i++) for (let j = 0; j < p; j++) H[i]![j]! += rows.length * (gm[i]! - grand[i]!) * (gm[j]! - grand[j]!)
    for (const row of rows) for (let i = 0; i < p; i++) for (let j = 0; j < p; j++) E[i]![j]! += (row[i]! - gm[i]!) * (row[j]! - gm[j]!)
  }
  const L = cholesky(E)
  const Linv = invertLower(L)
  const M = matMul(matMul(Linv, H), transpose(Linv))
  const eigen = symmetricEigen(M).values.map((value) => Math.max(0, value))
  const pillai = sum(eigen.map((l) => l / (1 + l)))
  const wilks = eigen.reduce((product, l) => product / (1 + l), 1)
  const s = Math.min(p, k - 1)
  const m = (Math.abs(p - (k - 1)) - 1) / 2
  const nn = (N - k - p - 1) / 2
  const F = ((2 * nn + s + 1) / (2 * m + s + 1)) * (pillai / (s - pillai))
  const df1 = s * (2 * m + s + 1)
  const df2 = s * (2 * nn + s + 1)
  return {
    test: "one-way MANOVA (Pillai's trace)",
    statistic: pillai,
    statisticName: "Pillai's trace",
    df: [df1, df2],
    pValue: fSf(F, df1, df2),
    estimate: { approximateF: F, wilksLambda: wilks },
    n: Object.fromEntries(names.map((name) => [name, groups[name]!.length])),
    assumptions: [{ name: 'multivariate normality and equal covariance matrices', status: 'not-checked', detail: "Pillai's trace is the most robust of the four MANOVA statistics to violations" }],
    notes: [],
  }
}

function invertLower(l: Matrix): Matrix {
  const n = l.length
  const out = zeros(n, n)
  for (let i = 0; i < n; i++) {
    out[i]![i] = 1 / l[i]![i]!
    for (let j = 0; j < i; j++) {
      let s = 0
      for (let k = j; k < i; k++) s += l[i]![k]! * out[k]![j]!
      out[i]![j] = -s / l[i]![i]!
    }
  }
  return out
}

export { tQuantile }
