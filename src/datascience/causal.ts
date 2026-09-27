import { createRng } from './rng.ts'
import { mean, standardDeviation, variance, quantileSorted, covariance } from './stats/describe.ts'
import { gram, crossVec, inverseSPD, matVec } from './stats/linalg.ts'
import { logisticRegression, ols } from './stats/glm.ts'
import { adjustPValues } from './stats/multiple.ts'
import { minimumDetectableEffect, proportionsPower, proportionsSampleSize, tTestPower, tTestSampleSize } from './stats/power.ts'
import { binomialCdf, chiSquareSf, fSf, normalQuantile, tPValue, tQuantile, zPValue } from './stats/special.ts'
import { chiSquareGoodnessOfFit, twoProportionZ, twoSampleT } from './stats/tests.ts'
import type { Assumption } from './stats/tests.ts'

/**
 * Causal inference and experimentation. Every estimator returns the assumptions it needs
 * next to the estimate, and observational methods say plainly that their estimate is
 * causal only if those assumptions hold. Nothing here turns a correlation into a causal
 * claim on its own.
 */

export interface EffectEstimate {
  estimand: string
  estimate: number
  se: number
  ci: [number, number]
  pValue: number
  method: string
}

function effect(estimand: string, estimate: number, se: number, method: string, df?: number, level = 0.95): EffectEstimate {
  const critical = df ? tQuantile(1 - (1 - level) / 2, df) : normalQuantile(1 - (1 - level) / 2)
  const statistic = estimate / se
  return { estimand, estimate, se, ci: [estimate - critical * se, estimate + critical * se], pValue: df ? tPValue(statistic, df) : zPValue(statistic), method }
}

// ================================================================ A/B testing

export interface VariantData {
  name: string
  values?: number[]
  successes?: number
  n?: number
  covariate?: number[]
}

export interface AbTestResult {
  hypothesis: string
  method: string
  sample: Record<string, unknown>
  results: Array<{ treatment: string; control: string; controlValue: number; treatmentValue: number; absoluteLift: number; relativeLift: number; ci: [number, number]; relativeCi?: [number, number]; pValue: number; adjustedPValue: number; significant: boolean; practicallySignificant: boolean | null; power: number | null }>
  srm: { pValue: number; observed: number[]; expectedShares: number[]; failed: boolean } | null
  cuped?: { theta: number; varianceReduction: number }
  interpretation: string[]
  limitations: string[]
  assumptions: Assumption[]
}

export function analyzeAbTest(input: { variants: VariantData[]; control: string; metricType: 'proportion' | 'mean'; alpha?: number; expectedShares?: number[]; minimumEffect?: number; correction?: 'holm' | 'bonferroni' | 'fdr_bh'; alternative?: 'two-sided' | 'less' | 'greater' }): AbTestResult {
  const alpha = input.alpha ?? 0.05
  const control = input.variants.find((variant) => variant.name === input.control)
  if (!control) throw new Error(`control variant "${input.control}" not found; variants: ${input.variants.map((v) => v.name).join(', ')}`)
  const treatments = input.variants.filter((variant) => variant !== control)
  if (treatments.length === 0) throw new Error('an A/B test needs at least one treatment variant besides the control')
  const sizes = input.variants.map((variant) => (input.metricType === 'proportion' ? variant.n ?? variant.values?.length ?? 0 : variant.values?.length ?? 0))
  let srm: AbTestResult['srm'] = null
  const shares = input.expectedShares ?? input.variants.map(() => 1 / input.variants.length)
  if (sizes.every((size) => size > 0)) {
    const test = chiSquareGoodnessOfFit(sizes, shares)
    srm = { pValue: test.pValue, observed: sizes, expectedShares: shares, failed: test.pValue < 0.001 }
  }
  let cuped: AbTestResult['cuped']
  const adjust = (variant: VariantData, theta: number, covariateMean: number) => variant.values!.map((value, index) => value - theta * (variant.covariate![index]! - covariateMean))
  let transformed = input.variants.map((variant) => ({ ...variant }))
  if (input.metricType === 'mean' && input.variants.every((variant) => variant.covariate && variant.values && variant.covariate.length === variant.values.length)) {
    const allY = input.variants.flatMap((variant) => variant.values!)
    const allX = input.variants.flatMap((variant) => variant.covariate!)
    const theta = covariance(allX, allY) / variance(allX)
    const xm = mean(allX)
    const before = mean(input.variants.map((variant) => variance(variant.values!)))
    transformed = input.variants.map((variant) => ({ ...variant, values: adjust(variant, theta, xm) }))
    const after = mean(transformed.map((variant) => variance(variant.values!)))
    cuped = { theta, varianceReduction: 1 - after / before }
  }
  const tControl = transformed.find((variant) => variant.name === control.name)!
  const raw = treatments.map((treatment) => {
    const t = transformed.find((variant) => variant.name === treatment.name)!
    if (input.metricType === 'proportion') {
      const cs = control.successes ?? control.values!.filter((value) => value === 1).length
      const cn = control.n ?? control.values!.length
      const ts = treatment.successes ?? treatment.values!.filter((value) => value === 1).length
      const tn = treatment.n ?? treatment.values!.length
      const test = twoProportionZ(ts, tn, cs, cn, input.alternative ?? 'two-sided', 1 - alpha)
      const pc = cs / cn
      const pt = ts / tn
      return { treatment: treatment.name, control: control.name, controlValue: pc, treatmentValue: pt, absoluteLift: pt - pc, relativeLift: pc === 0 ? Number.NaN : pt / pc - 1, ci: [test.ci!.lower, test.ci!.upper] as [number, number], relativeCi: test.estimate!.riskRatioLower !== undefined ? [test.estimate!.riskRatioLower - 1, test.estimate!.riskRatioUpper! - 1] as [number, number] : undefined, pValue: test.pValue, power: input.minimumEffect ? proportionsPower(pc, pc + input.minimumEffect, Math.min(cn, tn), { alpha }) : null }
    }
    const test = twoSampleT(t.values!, tControl.values!, { alternative: input.alternative ?? 'two-sided', level: 1 - alpha })
    const mc = mean(control.values!)
    const mt = mean(treatment.values!)
    const diff = test.estimate!.difference!
    const seDiff = (test.ci!.upper - test.ci!.lower) / (2 * tQuantile(1 - alpha / 2, test.df as number))
    const relative = mc === 0 ? Number.NaN : diff / mc
    const seRelative = mc === 0 ? Number.NaN : Math.sqrt((seDiff / mc) ** 2 + ((diff * standardDeviation(control.values!)) / (mc * mc)) ** 2 / control.values!.length)
    const z = normalQuantile(1 - alpha / 2)
    const pooledSd = Math.sqrt((variance(control.values!) + variance(treatment.values!)) / 2)
    return { treatment: treatment.name, control: control.name, controlValue: mc, treatmentValue: mt, absoluteLift: diff, relativeLift: relative, ci: [test.ci!.lower, test.ci!.upper] as [number, number], relativeCi: Number.isFinite(seRelative) ? [relative - z * seRelative, relative + z * seRelative] as [number, number] : undefined, pValue: test.pValue, power: input.minimumEffect && pooledSd > 0 ? tTestPower(input.minimumEffect / pooledSd, Math.min(control.values!.length, treatment.values!.length), { alpha }) : null }
  })
  const adjusted = adjustPValues(raw.map((row) => row.pValue), treatments.length > 1 ? input.correction ?? 'holm' : 'none')
  const results = raw.map((row, index) => ({
    ...row,
    adjustedPValue: adjusted[index]!,
    significant: adjusted[index]! < alpha,
    practicallySignificant: input.minimumEffect === undefined ? null : row.ci[0] > input.minimumEffect || row.ci[1] < -input.minimumEffect ? true : row.ci[1] < input.minimumEffect && row.ci[0] > -input.minimumEffect ? false : null,
  }))
  const interpretation: string[] = []
  if (srm?.failed) interpretation.push(`SAMPLE RATIO MISMATCH: observed allocation ${sizes.join(' / ')} is inconsistent with the design (p = ${srm.pValue.toExponential(2)}). The randomisation or tracking is broken, so the effect estimates below are not trustworthy until the cause is found.`)
  for (const row of results) {
    const unit = input.metricType === 'proportion' ? ' percentage points' : ''
    const scale = input.metricType === 'proportion' ? 100 : 1
    interpretation.push(`${row.treatment} vs ${row.control}: ${(row.absoluteLift * scale).toPrecision(3)}${unit} (${(row.relativeLift * 100).toFixed(1)}% relative), ${Math.round((1 - alpha) * 100)}% CI [${(row.ci[0] * scale).toPrecision(3)}, ${(row.ci[1] * scale).toPrecision(3)}]${unit}, ${treatments.length > 1 ? 'adjusted ' : ''}p = ${row.adjustedPValue.toPrecision(3)} — ${row.significant ? 'statistically significant' : 'not statistically significant'}${row.practicallySignificant === true ? ' and larger than the minimum effect of interest' : row.practicallySignificant === false ? ', and the CI rules out an effect as large as the minimum of interest' : input.minimumEffect !== undefined ? ', but the CI cannot tell whether the effect reaches the minimum of interest' : ''}.${row.power !== null && row.power < 0.8 ? ` Power to detect the minimum effect was only ${(row.power * 100).toFixed(0)}%, so a null result is weak evidence of no effect.` : ''}`)
  }
  return {
    hypothesis: `H0: the ${input.metricType === 'proportion' ? 'conversion rate' : 'mean'} is the same in ${treatments.map((t) => t.name).join(', ')} as in ${control.name}; H1: it differs${input.alternative && input.alternative !== 'two-sided' ? ` (${input.alternative})` : ''}.`,
    method: input.metricType === 'proportion' ? `two-proportion z tests with Newcombe CIs${treatments.length > 1 ? `, ${input.correction ?? 'holm'} correction across ${treatments.length} comparisons` : ''}` : `Welch t tests${cuped ? ' on CUPED-adjusted values (pre-period covariate)' : ''}${treatments.length > 1 ? `, ${input.correction ?? 'holm'} correction` : ''}`,
    sample: Object.fromEntries(input.variants.map((variant, index) => [variant.name, sizes[index]!])),
    results,
    srm,
    ...(cuped ? { cuped } : {}),
    interpretation,
    limitations: ['Valid only if assignment was random and units did not interfere with each other (SUTVA).', 'Peeking at results repeatedly and stopping when significant inflates false positives; this analysis assumes a fixed horizon.', 'Novelty and primacy effects mean a short test may not reflect the long-run effect.'],
    assumptions: [
      { name: 'randomised assignment', status: srm?.failed ? 'violated' : 'not-checked', detail: srm ? `sample-ratio check p = ${srm.pValue.toPrecision(3)}` : 'no allocation information' },
      { name: 'independent units', status: 'not-checked', detail: 'each unit appears in one variant and does not affect others' },
    ],
  }
}

export function designExperiment(input: { metricType: 'proportion' | 'mean'; baseline: number; minimumEffect: number; relative?: boolean; sd?: number; alpha?: number; power?: number; variants?: number; dailyTraffic?: number; allocation?: number }): Record<string, unknown> {
  const alpha = input.alpha ?? 0.05
  const power = input.power ?? 0.8
  const variants = input.variants ?? 2
  const comparisons = variants - 1
  const adjustedAlpha = comparisons > 1 ? alpha / comparisons : alpha
  const absolute = input.relative ? input.baseline * input.minimumEffect : input.minimumEffect
  let perGroup: number
  let achieved: number
  if (input.metricType === 'proportion') {
    const plan = proportionsSampleSize(input.baseline, input.baseline + absolute, power, { alpha: adjustedAlpha })
    perGroup = plan.n
    achieved = plan.achievedPower
  } else {
    if (!input.sd || input.sd <= 0) throw new Error('a mean metric needs sd (the standard deviation of the metric)')
    const plan = tTestSampleSize(absolute / input.sd, power, { alpha: adjustedAlpha })
    perGroup = plan.n
    achieved = plan.achievedPower
  }
  const total = perGroup * variants
  const exposed = (input.allocation ?? 1) * (input.dailyTraffic ?? 0)
  return {
    hypothesis: `H0: no difference in the ${input.metricType === 'proportion' ? 'rate' : 'mean'}; detect an absolute change of ${absolute}${input.relative ? ` (${input.minimumEffect * 100}% relative)` : ''} from ${input.baseline}`,
    perVariant: perGroup,
    total,
    variants,
    alpha,
    alphaPerComparison: adjustedAlpha,
    power,
    achievedPower: achieved,
    ...(exposed > 0 ? { days: Math.ceil(total / exposed), note: `at ${exposed} eligible units/day; run whole weeks to average out day-of-week effects` } : {}),
    ...(input.metricType === 'proportion' && input.dailyTraffic ? { mdeAtFourWeeks: minimumDetectableEffect(input.baseline, Math.floor((28 * exposed) / variants), power, { alpha: adjustedAlpha }) } : {}),
    guidance: ['Fix the sample size and metric before launch; do not stop early on significance.', 'Pre-register guardrail metrics (e.g. revenue per user, latency, cancellations) and check them for harm.', 'Check the sample ratio before reading any result.'],
  }
}

// ================================================================ difference-in-differences

export function differenceInDifferences(input: { y: number[]; treated: number[]; post: number[]; controls?: number[][]; controlNames?: string[]; clusters?: string[]; time?: number[] }): { effect: EffectEstimate; groupMeans: Record<string, number>; preTrend: { difference: number; pValue: number } | null; assumptions: Assumption[]; notes: string[] } {
  const n = input.y.length
  const x = input.y.map((_, i) => [1, input.treated[i]!, input.post[i]!, input.treated[i]! * input.post[i]!, ...(input.controls?.[i] ?? [])])
  const names = ['(Intercept)', 'treated', 'post', 'treated:post', ...(input.controlNames ?? (input.controls?.[0] ?? []).map((_, j) => `control${j + 1}`))]
  const fit = ols(x, input.y, names, input.clusters ? { covariance: 'cluster', clusters: input.clusters } : { covariance: 'HC3' })
  const coefficient = fit.coefficients.find((c) => c.term === 'treated:post')!
  const cell = (t: number, p: number) => mean(input.y.filter((_, i) => input.treated[i] === t && input.post[i] === p))
  let preTrend: { difference: number; pValue: number } | null = null
  const assumptions: Assumption[] = []
  if (input.time) {
    const pre = input.y.map((_, i) => i).filter((i) => input.post[i] === 0)
    const times = [...new Set(pre.map((i) => input.time![i]!))]
    if (times.length >= 3) {
      const trendFit = ols(pre.map((i) => [1, input.time![i]!, input.treated[i]!, input.time![i]! * input.treated[i]!]), pre.map((i) => input.y[i]!), ['(Intercept)', 't', 'treated', 't:treated'], input.clusters ? { covariance: 'cluster', clusters: pre.map((i) => input.clusters![i]!) } : { covariance: 'HC3' })
      const slope = trendFit.coefficients.find((c) => c.term === 't:treated')!
      preTrend = { difference: slope.estimate, pValue: slope.pValue }
      assumptions.push({ name: 'parallel pre-treatment trends', status: slope.pValue < 0.05 ? 'violated' : 'met', detail: `difference in pre-period slopes ${slope.estimate.toPrecision(3)} per period, p = ${slope.pValue.toPrecision(3)}${slope.pValue >= 0.05 ? ' (failing to reject is not proof of parallel trends; low power is common)' : ''}` })
    } else assumptions.push({ name: 'parallel pre-treatment trends', status: 'not-checked', detail: 'fewer than three pre-treatment periods; the assumption cannot be tested' })
  } else assumptions.push({ name: 'parallel pre-treatment trends', status: 'not-checked', detail: 'pass a time column to test pre-period trends' })
  assumptions.push({ name: 'no anticipation and no spillovers', status: 'not-checked', detail: 'the treated group did not react before treatment, and control units were unaffected' })
  assumptions.push({ name: 'stable composition', status: 'not-checked', detail: 'the groups did not change membership because of the treatment' })
  return {
    effect: { ...effect('ATT (difference-in-differences)', coefficient.estimate, coefficient.se, `OLS with treated×post interaction, ${fit.diagnostics.covariance} errors`, input.clusters ? new Set(input.clusters).size - 1 : n - names.length), pValue: coefficient.pValue, ci: [coefficient.ciLower, coefficient.ciUpper] },
    groupMeans: { treatedPre: cell(1, 0), treatedPost: cell(1, 1), controlPre: cell(0, 0), controlPost: cell(0, 1) },
    preTrend,
    assumptions,
    notes: [`${n} observations; the estimate is causal only under parallel trends${input.clusters ? '' : '; pass clusters (e.g. unit id) because repeated observations of a unit are correlated'}`],
  }
}

// ================================================================ propensity-score methods

export interface PropensityResult {
  ate: EffectEstimate
  att: EffectEstimate
  aipw: EffectEstimate
  matching: { att: number; matchedTreated: number; unmatchedTreated: number; caliper: number }
  overlap: { treatedRange: [number, number]; controlRange: [number, number]; trimmed: number }
  balance: Array<{ covariate: string; smdBefore: number; smdWeighted: number; smdMatched: number }>
  assumptions: Assumption[]
  notes: string[]
}

function smd(values: number[], treated: number[], weights?: number[]): number {
  const wt = weights ?? values.map(() => 1)
  const group = (g: number) => {
    const idx = values.map((_, i) => i).filter((i) => treated[i] === g)
    const w = idx.map((i) => wt[i]!)
    const total = w.reduce((a, b) => a + b, 0)
    const m = idx.reduce((acc, i, k) => acc + w[k]! * values[i]!, 0) / total
    const v = idx.reduce((acc, i, k) => acc + w[k]! * (values[i]! - m) ** 2, 0) / total
    return { m, v }
  }
  const a = group(1)
  const b = group(0)
  const pooled = Math.sqrt((a.v + b.v) / 2)
  return pooled === 0 ? 0 : (a.m - b.m) / pooled
}

/**
 * Propensity-score estimation of treatment effects from observational data: inverse
 * probability weighting (ATE and ATT), 1:1 nearest-neighbour matching with a caliper, and a
 * doubly robust AIPW estimator, with overlap trimming and covariate balance diagnostics.
 * Bootstrap CIs are seeded. Valid only under no unmeasured confounding.
 */
export function propensityAnalysis(input: { y: number[]; treated: number[]; x: number[][]; names: string[]; seed?: number; bootstrap?: number; trim?: [number, number] }): PropensityResult {
  const n = input.y.length
  const trim = input.trim ?? [0.01, 0.99]
  const design = input.x.map((row) => [1, ...row])
  const model = logisticRegression(design, input.treated, ['(Intercept)', ...input.names])
  const scores = model.fitted
  const keep = scores.map((score, i) => (score >= trim[0] && score <= trim[1] ? i : -1)).filter((i) => i >= 0)
  const trimmed = n - keep.length
  const estimate = (rows: number[]) => {
    const e = rows.map((i) => scores[i]!)
    const t = rows.map((i) => input.treated[i]!)
    const y = rows.map((i) => input.y[i]!)
    const w1 = t.map((ti, k) => ti / e[k]!)
    const w0 = t.map((ti, k) => (1 - ti) / (1 - e[k]!))
    const mu1 = y.reduce((acc, yi, k) => acc + w1[k]! * yi, 0) / w1.reduce((a, b) => a + b, 0)
    const mu0 = y.reduce((acc, yi, k) => acc + w0[k]! * yi, 0) / w0.reduce((a, b) => a + b, 0)
    const wAtt = t.map((ti, k) => (ti === 1 ? 1 : e[k]! / (1 - e[k]!)))
    const treatedMean = mean(y.filter((_, k) => t[k] === 1))
    const controlWeighted = y.reduce((acc, yi, k) => acc + (t[k] === 0 ? wAtt[k]! * yi : 0), 0) / t.reduce((acc, ti, k) => acc + (ti === 0 ? wAtt[k]! : 0), 0)
    // AIPW with linear outcome models fitted separately in each arm.
    const fitArm = (arm: number) => {
      const idx = rows.filter((i) => input.treated[i] === arm)
      const xa = idx.map((i) => [1, ...input.x[i]!])
      const beta = matVec(inverseSPD(gram(xa).map((r, a) => r.map((v, b) => v + (a === b ? 1e-8 : 0)))), crossVec(xa, idx.map((i) => input.y[i]!)))
      return (i: number) => [1, ...input.x[i]!].reduce((acc, v, j) => acc + v * beta[j]!, 0)
    }
    let aipw = Number.NaN
    try {
      const m1 = fitArm(1)
      const m0 = fitArm(0)
      aipw = mean(rows.map((i, k) => m1(i) - m0(i) + (t[k]! * (y[k]! - m1(i))) / e[k]! - ((1 - t[k]!) * (y[k]! - m0(i))) / (1 - e[k]!)))
    } catch {
      aipw = Number.NaN
    }
    return { ate: mu1 - mu0, att: treatedMean - controlWeighted, aipw }
  }
  const point = estimate(keep)
  const rng = createRng(input.seed ?? 42)
  const draws: Array<{ ate: number; att: number; aipw: number }> = []
  for (let b = 0; b < (input.bootstrap ?? 300); b++) {
    const sample = Array.from({ length: keep.length }, () => keep[rng.int(keep.length)]!)
    if (new Set(sample.map((i) => input.treated[i])).size < 2) continue
    draws.push(estimate(sample))
  }
  const interval = (key: 'ate' | 'att' | 'aipw', label: string, method: string): EffectEstimate => {
    const values = draws.map((draw) => draw[key]).filter(Number.isFinite).sort((a, b) => a - b)
    const se = standardDeviation(values)
    return { estimand: label, estimate: point[key], se, ci: [quantileSorted(values, 0.025), quantileSorted(values, 0.975)], pValue: zPValue(point[key] / se), method: `${method}; percentile bootstrap (${values.length} resamples, seed ${input.seed ?? 42})` }
  }
  // Matching on the logit of the propensity score with a 0.2 SD caliper.
  const logit = scores.map((s) => Math.log(s / (1 - s)))
  const caliper = 0.2 * standardDeviation(logit)
  const controls = keep.filter((i) => input.treated[i] === 0).sort((a, b) => logit[a]! - logit[b]!)
  const used = new Set<number>()
  const matches: Array<[number, number]> = []
  let unmatched = 0
  for (const i of keep.filter((k) => input.treated[k] === 1)) {
    let best = -1
    let bestDistance = caliper
    for (const j of controls) {
      if (used.has(j)) continue
      const distance = Math.abs(logit[i]! - logit[j]!)
      if (distance <= bestDistance) { bestDistance = distance; best = j }
    }
    if (best >= 0) { used.add(best); matches.push([i, best]) } else unmatched++
  }
  const matchedAtt = matches.length ? mean(matches.map(([i, j]) => input.y[i]! - input.y[j]!)) : Number.NaN
  const matchedIdx = matches.flat()
  const weights = scores.map((s, i) => (input.treated[i] === 1 ? 1 / s : 1 / (1 - s)))
  const balance = input.names.map((name, j) => {
    const column = input.x.map((row) => row[j]!)
    const kept = keep.map((i) => column[i]!)
    const keptTreat = keep.map((i) => input.treated[i]!)
    return { covariate: name, smdBefore: smd(column, input.treated), smdWeighted: smd(kept, keptTreat, keep.map((i) => weights[i]!)), smdMatched: matchedIdx.length ? smd(matchedIdx.map((i) => column[i]!), matchedIdx.map((i) => input.treated[i]!)) : Number.NaN }
  })
  const imbalanced = balance.filter((row) => Math.abs(row.smdWeighted) > 0.1)
  const treatedScores = scores.filter((_, i) => input.treated[i] === 1)
  const controlScores = scores.filter((_, i) => input.treated[i] === 0)
  return {
    ate: interval('ate', 'ATE (inverse probability weighting)', 'Hájek IPW'),
    att: interval('att', 'ATT (odds weighting)', 'IPW for the treated'),
    aipw: interval('aipw', 'ATE (augmented IPW, doubly robust)', 'AIPW with per-arm linear outcome models'),
    matching: { att: matchedAtt, matchedTreated: matches.length, unmatchedTreated: unmatched, caliper },
    overlap: { treatedRange: [Math.min(...treatedScores), Math.max(...treatedScores)], controlRange: [Math.min(...controlScores), Math.max(...controlScores)], trimmed },
    balance,
    assumptions: [
      { name: 'no unmeasured confounding', status: 'not-checked', detail: 'every variable that affects both treatment and outcome is among the covariates — untestable from the data' },
      { name: 'overlap (positivity)', status: trimmed / n > 0.1 ? 'questionable' : 'met', detail: `${trimmed} of ${n} rows had propensity outside [${trim[0]}, ${trim[1]}] and were trimmed` },
      { name: 'covariate balance after weighting', status: imbalanced.length ? 'violated' : 'met', detail: imbalanced.length ? `|SMD| > 0.1 remains for ${imbalanced.map((row) => row.covariate).join(', ')}` : 'all weighted standardized mean differences within ±0.1' },
      { name: 'correct propensity model', status: 'not-checked', detail: 'logistic, linear in the covariates; AIPW stays consistent if either the propensity or the outcome model is right' },
    ],
    notes: [`${unmatched} treated rows found no control within the caliper (${caliper.toFixed(3)} on the logit scale) and were excluded from the matched ATT`],
  }
}

// ================================================================ regression discontinuity

export function regressionDiscontinuity(input: { y: number[]; running: number[]; cutoff: number; bandwidth?: number }): { effect: EffectEstimate; bandwidth: number; nLeft: number; nRight: number; densityTest: { below: number; above: number; pValue: number }; assumptions: Assumption[] } {
  const centered = input.running.map((value) => value - input.cutoff)
  const sd = standardDeviation(centered)
  const bandwidth = input.bandwidth ?? 1.84 * sd * input.y.length ** -0.2
  const rows = centered.map((value, i) => ({ value, y: input.y[i]!, weight: Math.max(0, 1 - Math.abs(value) / bandwidth) })).filter((row) => row.weight > 0)
  const x = rows.map((row) => [1, row.value >= 0 ? 1 : 0, row.value, row.value >= 0 ? row.value : 0])
  const w = rows.map((row) => row.weight)
  const xtwx = gram(x, w)
  const inverse = inverseSPD(xtwx)
  const beta = matVec(inverse, crossVec(x, rows.map((row) => row.y), w))
  const residuals = rows.map((row, i) => row.y - x[i]!.reduce((acc, v, j) => acc + v * beta[j]!, 0))
  const meat = gram(x, rows.map((row, i) => row.weight * row.weight * residuals[i]! * residuals[i]!))
  const cov = inverse.map((r) => r.map(() => 0))
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { let s = 0; for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) s += inverse[i]![a]! * meat[a]![b]! * inverse[b]![j]!; cov[i]![j] = s }
  const nLeft = rows.filter((row) => row.value < 0).length
  const nRight = rows.length - nLeft
  const narrow = bandwidth / 4
  const below = centered.filter((value) => value < 0 && value >= -narrow).length
  const above = centered.filter((value) => value >= 0 && value < narrow).length
  const k = Math.min(below, above)
  const densityP = below + above === 0 ? 1 : Math.min(1, 2 * binomialCdf(k, below + above, 0.5))
  return {
    effect: effect('local average treatment effect at the cutoff', beta[1]!, Math.sqrt(cov[1]![1]!), `local linear regression with a triangular kernel, bandwidth ${bandwidth.toPrecision(3)}, HC0 errors`),
    bandwidth,
    nLeft,
    nRight,
    densityTest: { below, above, pValue: densityP },
    assumptions: [
      { name: 'no manipulation of the running variable', status: densityP < 0.05 ? 'violated' : 'met', detail: `${below} vs ${above} observations just below/above the cutoff (binomial p = ${densityP.toPrecision(3)}); bunching suggests sorting around the threshold` },
      { name: 'continuity of other factors at the cutoff', status: 'not-checked', detail: 'covariates should not jump at the cutoff; test them as placebo outcomes' },
      { name: 'local validity', status: 'met', detail: 'the estimate applies to units near the cutoff, not the whole population' },
    ],
  }
}

// ================================================================ instrumental variables

export function twoStageLeastSquares(input: { y: number[]; endogenous: number[]; instruments: number[][]; exogenous?: number[][]; names?: { endogenous?: string; instruments?: string[]; exogenous?: string[] } }): { effect: EffectEstimate; firstStageF: number; weakInstruments: boolean; olsEstimate: number; assumptions: Assumption[] } {
  const n = input.y.length
  const exog = input.exogenous ?? input.y.map(() => [])
  const z = input.y.map((_, i) => [1, ...exog[i]!, ...input.instruments[i]!])
  const first = ols(z, input.endogenous, z[0]!.map((_, j) => `z${j}`))
  const restricted = ols(input.y.map((_, i) => [1, ...exog[i]!]), input.endogenous, ['(Intercept)', ...exog[0]!.map((_, j) => `w${j}`)])
  const q = input.instruments[0]!.length
  const rssR = restricted.residuals.reduce((a, r) => a + r * r, 0)
  const rssU = first.residuals.reduce((a, r) => a + r * r, 0)
  const dfU = n - z[0]!.length
  const firstStageF = ((rssR - rssU) / q) / (rssU / dfU)
  const xhat = first.fitted
  const second = input.y.map((_, i) => [1, ...exog[i]!, xhat[i]!])
  const beta = matVec(inverseSPD(gram(second)), crossVec(second, input.y))
  const actual = input.y.map((_, i) => [1, ...exog[i]!, input.endogenous[i]!])
  const residuals = input.y.map((value, i) => value - actual[i]!.reduce((acc, v, j) => acc + v * beta[j]!, 0))
  const k = second[0]!.length
  const sigma2 = residuals.reduce((a, r) => a + r * r, 0) / (n - k)
  const cov = inverseSPD(gram(second)).map((row) => row.map((value) => value * sigma2))
  const index = k - 1
  const olsFit = ols(actual, input.y, actual[0]!.map((_, j) => `x${j}`))
  return {
    effect: effect(`effect of ${input.names?.endogenous ?? 'the endogenous regressor'} (2SLS)`, beta[index]!, Math.sqrt(cov[index]![index]!), 'two-stage least squares with structural-residual standard errors', n - k),
    firstStageF,
    weakInstruments: firstStageF < 10,
    olsEstimate: olsFit.coefficients[index]!.estimate,
    assumptions: [
      { name: 'instrument relevance', status: firstStageF < 10 ? 'violated' : 'met', detail: `first-stage F = ${firstStageF.toFixed(2)} (< 10 signals weak instruments and biased, unreliable 2SLS estimates); F p = ${fSf(firstStageF, q, dfU).toPrecision(3)}` },
      { name: 'exclusion restriction', status: 'not-checked', detail: 'the instrument affects the outcome only through the endogenous variable — untestable, must be argued from domain knowledge' },
      { name: 'instrument independence', status: 'not-checked', detail: 'the instrument is as good as randomly assigned relative to unobserved confounders' },
    ],
  }
}

// ================================================================ synthetic control

/** Synthetic control: non-negative donor weights summing to one that best reproduce the treated unit before treatment. */
export function syntheticControl(input: { treated: number[]; donors: Record<string, number[]>; preperiods: number }): { weights: Record<string, number>; preRmspe: number; postRmspe: number; gaps: number[]; averagePostGap: number; placebo: { rank: number; of: number; pValue: number }; assumptions: Assumption[] } {
  const names = Object.keys(input.donors)
  if (names.length < 2) throw new Error('synthetic control needs at least two donor units')
  const T0 = input.preperiods
  const fit = (target: number[], pool: string[]) => {
    let w = pool.map(() => 1 / pool.length)
    const series = pool.map((name) => input.donors[name] ?? input.treated)
    const loss = (weights: number[]) => { let s = 0; for (let t = 0; t < T0; t++) { const synth = weights.reduce((acc, wi, j) => acc + wi * series[j]![t]!, 0); s += (target[t]! - synth) ** 2 } return s / T0 }
    let step = 0.5
    for (let iteration = 0; iteration < 3000; iteration++) {
      const gradient = w.map((_, j) => { let g = 0; for (let t = 0; t < T0; t++) { const synth = w.reduce((acc, wi, k) => acc + wi * series[k]![t]!, 0); g += -2 * (target[t]! - synth) * series[j]![t]! } return g / T0 })
      const candidate = projectSimplex(w.map((wi, j) => wi - step * gradient[j]! / (1 + Math.abs(gradient[j]!))))
      if (loss(candidate) <= loss(w)) w = candidate
      else step *= 0.7
      if (step < 1e-8) break
    }
    const gaps = target.map((value, t) => value - w.reduce((acc, wi, j) => acc + wi * series[j]![t]!, 0))
    const rmspe = (from: number, to: number) => Math.sqrt(mean(gaps.slice(from, to).map((g) => g * g)))
    return { w, gaps, pre: rmspe(0, T0), post: rmspe(T0, target.length) }
  }
  const main = fit(input.treated, names)
  const ratios = names.map((placeboName) => {
    const pool = names.filter((name) => name !== placeboName)
    const result = fit(input.donors[placeboName]!, pool)
    return result.post / Math.max(result.pre, 1e-12)
  })
  const mainRatio = main.post / Math.max(main.pre, 1e-12)
  const rank = 1 + ratios.filter((ratio) => ratio >= mainRatio).length
  return {
    weights: Object.fromEntries(names.map((name, j) => [name, main.w[j]!]).filter(([, w]) => (w as number) > 1e-4)),
    preRmspe: main.pre,
    postRmspe: main.post,
    gaps: main.gaps,
    averagePostGap: mean(main.gaps.slice(T0)),
    placebo: { rank, of: names.length + 1, pValue: rank / (names.length + 1) },
    assumptions: [
      { name: 'good pre-treatment fit', status: main.pre > 0.1 * Math.abs(mean(input.treated.slice(0, T0))) ? 'questionable' : 'met', detail: `pre-period RMSPE ${main.pre.toPrecision(3)}` },
      { name: 'no spillovers to donors and no simultaneous shocks', status: 'not-checked', detail: 'donor units must be unaffected by the intervention' },
      { name: 'placebo inference', status: 'met', detail: `the treated unit's post/pre RMSPE ratio ranks ${rank} of ${names.length + 1} (permutation p = ${(rank / (names.length + 1)).toFixed(3)}; the smallest attainable p is ${(1 / (names.length + 1)).toFixed(3)})` },
    ],
  }
}

function projectSimplex(v: number[]): number[] {
  const sorted = [...v].sort((a, b) => b - a)
  let cumulative = 0
  let theta = 0
  for (let i = 0; i < sorted.length; i++) {
    cumulative += sorted[i]!
    const t = (cumulative - 1) / (i + 1)
    if (sorted[i]! - t > 0) theta = t
  }
  return v.map((value) => Math.max(0, value - theta))
}

// ================================================================ causal graphs

export function analyzeDag(input: { edges: Array<[string, string]>; treatment: string; outcome: string; controls?: string[] }): { nodes: string[]; acyclic: boolean; parentsOfTreatment: string[]; recommendedAdjustment: string[]; badControls: Array<{ variable: string; reason: string }>; mediators: string[]; notes: string[] } {
  const nodes = [...new Set(input.edges.flat())]
  const children = new Map<string, string[]>()
  const parents = new Map<string, string[]>()
  for (const [from, to] of input.edges) {
    children.set(from, [...(children.get(from) ?? []), to])
    parents.set(to, [...(parents.get(to) ?? []), from])
  }
  const descendants = (node: string) => {
    const seen = new Set<string>()
    const stack = [...(children.get(node) ?? [])]
    while (stack.length) { const next = stack.pop()!; if (seen.has(next)) continue; seen.add(next); stack.push(...(children.get(next) ?? [])) }
    return seen
  }
  const acyclic = nodes.every((node) => !descendants(node).has(node))
  if (!acyclic) throw new Error('the graph has a cycle; a causal DAG must be acyclic')
  if (!nodes.includes(input.treatment) || !nodes.includes(input.outcome)) throw new Error('treatment and outcome must both appear in the edges')
  const treatmentDescendants = descendants(input.treatment)
  const outcomeAncestors = new Set(nodes.filter((node) => descendants(node).has(input.outcome)))
  const mediators = [...treatmentDescendants].filter((node) => node !== input.outcome && outcomeAncestors.has(node))
  const badControls = (input.controls ?? []).flatMap((variable) => {
    if (treatmentDescendants.has(variable)) return [{ variable, reason: mediators.includes(variable) ? 'a mediator (on the path from treatment to outcome): adjusting removes part of the effect you want to measure' : 'a descendant of the treatment: adjusting can introduce bias (e.g. collider or post-treatment bias)' }]
    const variableParents = parents.get(variable) ?? []
    if (variableParents.includes(input.treatment) && variableParents.includes(input.outcome)) return [{ variable, reason: 'a collider of treatment and outcome: adjusting opens a spurious path' }]
    return []
  })
  const parentsOfTreatment = parents.get(input.treatment) ?? []
  return {
    nodes,
    acyclic,
    parentsOfTreatment,
    recommendedAdjustment: parentsOfTreatment.filter((node) => !treatmentDescendants.has(node)),
    badControls,
    mediators,
    notes: ['Adjusting for all (observed) parents of the treatment blocks every back-door path in a DAG; this is sufficient, not always minimal.', 'The conclusions are only as good as the graph: an omitted common cause invalidates them.'],
  }
}

export { chiSquareSf }
