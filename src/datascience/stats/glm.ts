import { mean, sum } from './describe.ts'
import { crossVec, gram, independentColumns, inverseSPD, matVec, SingularMatrixError, symmetricEigen, type Matrix, type Vector } from './linalg.ts'
import { chiSquareSf, fSf, logGamma, normalCdf, normalQuantile, tPValue, tQuantile, zPValue } from './special.ts'
import type { Assumption } from './tests.ts'
import { jarqueBera } from './tests.ts'

/**
 * Regression models with full inference: OLS (classical, HC3, and cluster-robust errors),
 * logistic, Poisson, and negative-binomial GLMs by IRLS, Huber robust regression, and a
 * random-intercept linear mixed model by profiled REML. Coefficients carry standard errors,
 * test statistics, p-values, and confidence intervals; fit statistics and diagnostics say
 * whether the model's assumptions hold.
 */

export interface Coefficient {
  term: string
  estimate: number
  se: number
  statistic: number
  pValue: number
  ciLower: number
  ciUpper: number
  exponentiated?: { label: string; value: number; lower: number; upper: number }
  vif?: number
}

export interface RegressionResult {
  model: string
  n: number
  parameters: number
  coefficients: Coefficient[]
  aliased: string[]
  fit: Record<string, number | null>
  diagnostics: Record<string, unknown>
  assumptions: Assumption[]
  notes: string[]
  fitted: number[]
  residuals: number[]
}

export type CovarianceType = 'classical' | 'HC3' | 'cluster'

function dropAliased(x: Matrix, names: string[]): { x: Matrix; names: string[]; aliased: string[] } {
  const { keep, aliased } = independentColumns(x)
  if (aliased.length === 0) return { x, names, aliased: [] }
  return { x: x.map((row) => keep.map((index) => row[index]!)), names: keep.map((index) => names[index]!), aliased: aliased.map((index) => names[index]!) }
}

function coefficientTable(names: string[], beta: Vector, covariance: Matrix, level: number, df: number | null, exponentiate?: string): Coefficient[] {
  const critical = df === null ? normalQuantile(1 - (1 - level) / 2) : tQuantile(1 - (1 - level) / 2, df)
  return names.map((term, index) => {
    const se = Math.sqrt(Math.max(0, covariance[index]![index]!))
    const statistic = beta[index]! / se
    const lower = beta[index]! - critical * se
    const upper = beta[index]! + critical * se
    return {
      term,
      estimate: beta[index]!,
      se,
      statistic,
      pValue: df === null ? zPValue(statistic) : tPValue(statistic, df),
      ciLower: lower,
      ciUpper: upper,
      ...(exponentiate && term !== '(Intercept)' ? { exponentiated: { label: exponentiate, value: Math.exp(beta[index]!), lower: Math.exp(lower), upper: Math.exp(upper) } } : {}),
    }
  })
}

function varianceInflation(x: Matrix, names: string[]): Map<string, number> {
  const out = new Map<string, number>()
  const hasIntercept = names[0] === '(Intercept)'
  const predictors = names.map((_, index) => index).filter((index) => names[index] !== '(Intercept)')
  if (predictors.length < 2) return out
  for (const j of predictors) {
    const others = [...(hasIntercept ? [0] : []), ...predictors.filter((k) => k !== j)]
    const xo = x.map((row) => others.map((k) => row[k]!))
    const y = x.map((row) => row[j]!)
    try {
      const beta = solveNormal(xo, y)
      const fitted = matVec(xo, beta)
      const my = mean(y)
      const ssr = sum(y.map((value, index) => (value - fitted[index]!) ** 2))
      const sst = sum(y.map((value) => (value - my) ** 2))
      const r2 = sst === 0 ? 1 : 1 - ssr / sst
      out.set(names[j]!, r2 >= 1 ? Number.POSITIVE_INFINITY : 1 / (1 - r2))
    } catch {
      out.set(names[j]!, Number.POSITIVE_INFINITY)
    }
  }
  return out
}

function solveNormal(x: Matrix, y: Vector, weights?: Vector): Vector {
  const xtx = gram(x, weights)
  const xty = crossVec(x, y, weights)
  const inverse = inverseSPD(xtx)
  return matVec(inverse, xty)
}

function assertRows(n: number, p: number, model: string): void {
  if (n <= p) throw new Error(`${model} needs more complete rows (${n}) than parameters (${p}); drop features or collect more data`)
}

// ---------------------------------------------------------------- OLS

export interface OlsOptions {
  level?: number
  covariance?: CovarianceType
  /** Cluster labels aligned with rows, for cluster-robust errors. */
  clusters?: string[]
}

export function ols(xInput: Matrix, y: Vector, namesInput: string[], options: OlsOptions = {}): RegressionResult {
  const level = options.level ?? 0.95
  const { x, names, aliased } = dropAliased(xInput, namesInput)
  const n = x.length
  const p = names.length
  assertRows(n, p, 'OLS')
  const xtx = gram(x)
  const xtxInv = inverseSPD(xtx)
  const beta = matVec(xtxInv, crossVec(x, y))
  const fitted = matVec(x, beta)
  const residuals = y.map((value, index) => value - fitted[index]!)
  const rss = sum(residuals.map((r) => r * r))
  const df = n - p
  const sigma2 = rss / df
  const hasIntercept = names.includes('(Intercept)')
  const my = mean(y)
  const tss = sum(y.map((value) => (hasIntercept ? (value - my) ** 2 : value * value)))
  const r2 = tss === 0 ? null : 1 - rss / tss
  const dfModel = p - (hasIntercept ? 1 : 0)
  const adjR2 = r2 === null ? null : 1 - ((1 - r2) * (n - (hasIntercept ? 1 : 0))) / df
  const leverage = x.map((row) => {
    const v = matVec(xtxInv, row)
    return sum(row.map((value, index) => value * v[index]!))
  })
  let covariance: Matrix
  let covarianceLabel = 'classical (homoskedastic)'
  if (options.covariance === 'HC3') {
    const weights = residuals.map((r, index) => (r / (1 - Math.min(0.999999, leverage[index]!))) ** 2)
    covariance = sandwich(xtxInv, gram(x, weights))
    covarianceLabel = 'HC3 heteroskedasticity-robust'
  } else if (options.covariance === 'cluster') {
    if (!options.clusters || options.clusters.length !== n) throw new Error('cluster-robust errors need a cluster column aligned with the rows')
    const scores = new Map<string, Vector>()
    x.forEach((row, index) => {
      const key = options.clusters![index]!
      const score = scores.get(key) ?? new Array<number>(p).fill(0)
      for (let j = 0; j < p; j++) score[j]! += row[j]! * residuals[index]!
      scores.set(key, score)
    })
    const G = scores.size
    if (G < 2) throw new Error('cluster-robust errors need at least two clusters')
    const meat: Matrix = Array.from({ length: p }, () => new Array<number>(p).fill(0))
    for (const score of scores.values()) for (let i = 0; i < p; i++) for (let j = 0; j < p; j++) meat[i]![j]! += score[i]! * score[j]!
    const correction = (G / (G - 1)) * ((n - 1) / (n - p))
    covariance = sandwich(xtxInv, meat).map((row) => row.map((value) => value * correction))
    covarianceLabel = `cluster-robust (CR1, ${G} clusters)`
  } else {
    covariance = xtxInv.map((row) => row.map((value) => value * sigma2))
  }
  const tDf = options.covariance === 'cluster' ? new Set(options.clusters).size - 1 : df
  const coefficients = coefficientTable(names, beta, covariance, level, tDf)
  const vif = varianceInflation(x, names)
  for (const coefficient of coefficients) if (vif.has(coefficient.term)) coefficient.vif = vif.get(coefficient.term)!
  const fStatistic = dfModel > 0 && r2 !== null ? (r2 / dfModel) / ((1 - r2) / df) : null
  const logLik = (-n / 2) * (Math.log(2 * Math.PI) + Math.log(rss / n) + 1)
  // Diagnostics
  let dw = 0
  for (let index = 1; index < n; index++) dw += (residuals[index]! - residuals[index - 1]!) ** 2
  dw /= rss || 1
  const squared = residuals.map((r) => r * r)
  let bpLm: number | null = null
  let bpP: number | null = null
  if (dfModel > 0) {
    try {
      const gamma = solveNormal(x, squared)
      const fittedSquares = matVec(x, gamma)
      const ms = mean(squared)
      const ess = sum(fittedSquares.map((value) => (value - ms) ** 2))
      const tssSq = sum(squared.map((value) => (value - ms) ** 2))
      bpLm = tssSq === 0 ? 0 : n * (ess / tssSq)
      bpP = chiSquareSf(bpLm, dfModel)
    } catch {
      // A degenerate auxiliary regression leaves Breusch–Pagan unreported rather than wrong.
    }
  }
  const jb = n >= 3 ? jarqueBera(residuals) : null
  const cooks = residuals.map((r, index) => {
    const h = leverage[index]!
    return ((r * r) / (p * sigma2)) * (h / (1 - h) ** 2)
  })
  const influential = cooks.filter((d) => d > 4 / n).length
  const eigen = symmetricEigen(xtx).values
  const condition = eigen.at(-1)! <= 0 ? Number.POSITIVE_INFINITY : Math.sqrt(eigen[0]! / eigen.at(-1)!)
  const maxVif = Math.max(0, ...[...vif.values()].filter(Number.isFinite))
  const infiniteVif = [...vif.values()].some((value) => !Number.isFinite(value))
  const assumptions: Assumption[] = [
    { name: 'homoskedasticity', status: bpP === null ? 'not-checked' : bpP < 0.05 ? 'violated' : 'met', detail: bpP === null ? 'Breusch–Pagan not computed' : `Breusch–Pagan LM = ${bpLm!.toFixed(3)}, p = ${bpP.toPrecision(3)}${bpP < 0.05 && options.covariance !== 'HC3' && options.covariance !== 'cluster' ? '; refit with covariance "HC3" for valid standard errors' : ''}` },
    { name: 'normal residuals', status: jb === null ? 'not-checked' : jb.pValue < 0.05 ? (n >= 100 ? 'questionable' : 'violated') : 'met', detail: jb === null ? 'too few rows' : `Jarque–Bera = ${jb.statistic.toFixed(3)}, p = ${jb.pValue.toPrecision(3)}${n >= 100 ? '; with n ≥ 100 inference on coefficients is robust to moderate non-normality' : ''}` },
    { name: 'independent errors', status: dw < 1.5 || dw > 2.5 ? 'questionable' : 'met', detail: `Durbin–Watson = ${dw.toFixed(3)} (≈2 means no first-order autocorrelation; only meaningful when rows are in time or sequence order)` },
    { name: 'no severe multicollinearity', status: infiniteVif || maxVif > 10 ? 'violated' : maxVif > 5 ? 'questionable' : 'met', detail: `max VIF ${infiniteVif ? '∞' : maxVif.toFixed(2)}; condition number ${Number.isFinite(condition) ? condition.toFixed(1) : '∞'}` },
    { name: 'influential observations', status: influential > 0.05 * n ? 'questionable' : 'met', detail: `${influential} rows with Cook's distance > 4/n` },
  ]
  return {
    model: 'ordinary least squares',
    n,
    parameters: p,
    coefficients,
    aliased,
    fit: {
      rSquared: r2,
      adjustedRSquared: adjR2,
      fStatistic,
      fPValue: fStatistic === null ? null : fSf(fStatistic, dfModel, df),
      residualStdError: Math.sqrt(sigma2),
      rmse: Math.sqrt(rss / n),
      logLikelihood: logLik,
      aic: -2 * logLik + 2 * p,
      bic: -2 * logLik + Math.log(n) * p,
      dfResidual: df,
    },
    diagnostics: { covariance: covarianceLabel, durbinWatson: dw, breuschPagan: bpLm === null ? null : { lm: bpLm, pValue: bpP }, jarqueBera: jb ? { statistic: jb.statistic, pValue: jb.pValue } : null, conditionNumber: condition, influentialRows: influential, maxLeverage: Math.max(...leverage) },
    assumptions,
    notes: [
      ...(aliased.length ? [`Dropped aliased (perfectly collinear) terms: ${aliased.join(', ')}`] : []),
      'Coefficients describe conditional associations under the model; they are not causal effects unless the design identifies them.',
    ],
    fitted,
    residuals,
  }
}

function sandwich(bread: Matrix, meat: Matrix): Matrix {
  const p = bread.length
  const temp: Matrix = Array.from({ length: p }, () => new Array<number>(p).fill(0))
  for (let i = 0; i < p; i++) for (let j = 0; j < p; j++) { let s = 0; for (let k = 0; k < p; k++) s += bread[i]![k]! * meat[k]![j]!; temp[i]![j] = s }
  const out: Matrix = Array.from({ length: p }, () => new Array<number>(p).fill(0))
  for (let i = 0; i < p; i++) for (let j = 0; j < p; j++) { let s = 0; for (let k = 0; k < p; k++) s += temp[i]![k]! * bread[k]![j]!; out[i]![j] = s }
  return out
}

// ---------------------------------------------------------------- GLMs by IRLS

interface IrlsFamily {
  name: string
  linkInverse(eta: number): number
  /** dμ/dη */
  derivative(eta: number, mu: number): number
  variance(mu: number): number
  deviance(y: number, mu: number): number
  logLikelihood(y: Vector, mu: Vector): number
  initialMu(y: number, meanY: number): number
}

const LOGISTIC: IrlsFamily = {
  name: 'binomial (logit link)',
  linkInverse: (eta) => 1 / (1 + Math.exp(-Math.max(-35, Math.min(35, eta)))),
  derivative: (_eta, mu) => Math.max(1e-12, mu * (1 - mu)),
  variance: (mu) => Math.max(1e-12, mu * (1 - mu)),
  deviance: (y, mu) => -2 * (y * Math.log(Math.max(1e-300, mu)) + (1 - y) * Math.log(Math.max(1e-300, 1 - mu))),
  logLikelihood: (y, mu) => sum(y.map((value, index) => value * Math.log(Math.max(1e-300, mu[index]!)) + (1 - value) * Math.log(Math.max(1e-300, 1 - mu[index]!)))),
  initialMu: (y) => (y + 0.5) / 2,
}

const POISSON: IrlsFamily = {
  name: 'Poisson (log link)',
  linkInverse: (eta) => Math.exp(Math.min(700, eta)),
  derivative: (_eta, mu) => Math.max(1e-12, mu),
  variance: (mu) => Math.max(1e-12, mu),
  deviance: (y, mu) => 2 * ((y > 0 ? y * Math.log(y / mu) : 0) - (y - mu)),
  logLikelihood: (y, mu) => sum(y.map((value, index) => value * Math.log(Math.max(1e-300, mu[index]!)) - mu[index]! - logGamma(value + 1))),
  initialMu: (y, meanY) => (y + meanY) / 2,
}

function negativeBinomialFamily(alpha: number): IrlsFamily {
  return {
    name: `negative binomial NB2 (log link, α = ${alpha.toPrecision(4)})`,
    linkInverse: POISSON.linkInverse,
    derivative: POISSON.derivative,
    variance: (mu) => Math.max(1e-12, mu + alpha * mu * mu),
    deviance: (y, mu) => {
      const r = 1 / alpha
      return 2 * ((y > 0 ? y * Math.log(y / mu) : 0) - (y + r) * Math.log((y + r) / (mu + r)))
    },
    logLikelihood: (y, mu) => {
      const r = 1 / alpha
      return sum(y.map((value, index) => logGamma(value + r) - logGamma(r) - logGamma(value + 1) + r * Math.log(r / (r + mu[index]!)) + value * Math.log(mu[index]! / (r + mu[index]!))))
    },
    initialMu: POISSON.initialMu,
  }
}

interface IrlsFit {
  beta: Vector
  mu: Vector
  eta: Vector
  covarianceUnscaled: Matrix
  iterations: number
  converged: boolean
}

function irls(x: Matrix, y: Vector, family: IrlsFamily, offset?: Vector, maxIterations = 100): IrlsFit {
  const n = x.length
  const meanY = mean(y)
  let mu = y.map((value) => family.initialMu(value, meanY))
  let eta = mu.map((m, index) => (family === LOGISTIC ? Math.log(m / (1 - m)) : Math.log(Math.max(1e-8, m))) )
  let beta: Vector = new Array<number>(x[0]!.length).fill(0)
  let deviance = Number.POSITIVE_INFINITY
  let converged = false
  let iterations = 0
  for (; iterations < maxIterations; iterations++) {
    const weights: Vector = new Array<number>(n)
    const z: Vector = new Array<number>(n)
    for (let i = 0; i < n; i++) {
      const d = family.derivative(eta[i]!, mu[i]!)
      weights[i] = (d * d) / family.variance(mu[i]!)
      z[i] = eta[i]! - (offset?.[i] ?? 0) + (y[i]! - mu[i]!) / d
    }
    const target = solveNormal(x, z, weights)
    let step = 1
    let accepted: { beta: Vector; eta: Vector; mu: Vector; deviance: number } | undefined
    for (let halving = 0; halving < 30; halving++) {
      const trial = beta.map((value, index) => value + step * (target[index]! - value))
      const trialEta = matVec(x, trial).map((value, index) => value + (offset?.[index] ?? 0))
      const trialMu = trialEta.map((value) => family.linkInverse(value))
      const trialDeviance = sum(y.map((value, index) => family.deviance(value, trialMu[index]!)))
      if (Number.isFinite(trialDeviance) && trialDeviance <= deviance * (1 + 1e-10)) {
        accepted = { beta: trial, eta: trialEta, mu: trialMu, deviance: trialDeviance }
        break
      }
      step /= 2
    }
    if (!accepted) {
      // No step improves the deviance: the current estimate is as good as IRLS can make it.
      converged = true
      break
    }
    const newDeviance = accepted.deviance
    const candidate = accepted.beta
    const newEta = accepted.eta
    const newMu = accepted.mu
    const change = Math.abs(newDeviance - deviance) / (Math.abs(newDeviance) + 0.1)
    beta = candidate
    eta = newEta
    mu = newMu
    deviance = newDeviance
    if (change < 1e-10) {
      converged = true
      iterations++
      break
    }
  }
  const weights = mu.map((m, index) => {
    const d = family.derivative(eta[index]!, m)
    return (d * d) / family.variance(m)
  })
  return { beta, mu, eta, covarianceUnscaled: inverseSPD(gram(x, weights)), iterations, converged }
}

export interface GlmOptions {
  level?: number
  offset?: Vector
}

function glmResult(model: string, x: Matrix, y: Vector, names: string[], aliased: string[], fit: IrlsFit, family: IrlsFamily, nullFit: { deviance: number; logLik: number }, extraParams: number, level: number, exponentiate: string, dispersion = 1): Omit<RegressionResult, 'assumptions' | 'notes'> & { deviance: number; pearsonChi2: number } {
  const n = x.length
  const p = names.length
  const covariance = fit.covarianceUnscaled.map((row) => row.map((value) => value * dispersion))
  const coefficients = coefficientTable(names, fit.beta, covariance, level, null, exponentiate)
  const deviance = sum(y.map((value, index) => family.deviance(value, fit.mu[index]!)))
  const pearsonChi2 = sum(y.map((value, index) => (value - fit.mu[index]!) ** 2 / family.variance(fit.mu[index]!)))
  const logLik = family.logLikelihood(y, fit.mu)
  const k = p + extraParams
  const lr = 2 * (logLik - nullFit.logLik)
  return {
    model,
    n,
    parameters: p,
    coefficients,
    aliased,
    fit: {
      logLikelihood: logLik,
      nullLogLikelihood: nullFit.logLik,
      deviance,
      nullDeviance: nullFit.deviance,
      mcFaddenR2: nullFit.logLik === 0 ? null : 1 - logLik / nullFit.logLik,
      likelihoodRatio: lr,
      likelihoodRatioPValue: p > 1 ? chiSquareSf(lr, p - 1) : null,
      aic: -2 * logLik + 2 * k,
      bic: -2 * logLik + Math.log(n) * k,
      pearsonChi2OverDf: pearsonChi2 / Math.max(1, n - p),
      iterations: fit.iterations,
    },
    diagnostics: { converged: fit.converged, iterations: fit.iterations },
    deviance,
    pearsonChi2,
    fitted: fit.mu,
    residuals: y.map((value, index) => value - fit.mu[index]!),
  }
}

function interceptOnlyFit(y: Vector, family: IrlsFamily, offset?: Vector): { deviance: number; logLik: number } {
  const x = y.map(() => [1])
  const fit = irls(x, y, family, offset)
  return { deviance: sum(y.map((value, index) => family.deviance(value, fit.mu[index]!))), logLik: family.logLikelihood(y, fit.mu) }
}

export function logisticRegression(xInput: Matrix, y: Vector, namesInput: string[], options: GlmOptions = {}): RegressionResult {
  const level = options.level ?? 0.95
  const { x, names, aliased } = dropAliased(xInput, namesInput)
  assertRows(x.length, names.length, 'logistic regression')
  if (y.some((value) => value !== 0 && value !== 1)) throw new Error('logistic regression needs a 0/1 target')
  const positives = sum(y)
  if (positives === 0 || positives === y.length) throw new Error('logistic regression needs both classes present')
  let fit: IrlsFit
  try {
    fit = irls(x, y, LOGISTIC)
  } catch (error) {
    if (error instanceof SingularMatrixError) throw new Error('logistic regression information matrix is singular — likely perfect separation or a constant feature')
    throw error
  }
  const separated = fit.mu.filter((m) => m < 1e-8 || m > 1 - 1e-8).length
  const hasIntercept = names.includes('(Intercept)')
  const base = glmResult('logistic regression', x, y, names, aliased, fit, LOGISTIC, hasIntercept ? interceptOnlyFit(y, LOGISTIC) : { deviance: Number.NaN, logLik: Number.NaN }, 0, level, 'odds ratio')
  const eventsPerParameter = Math.min(positives, y.length - positives) / names.length
  return {
    ...base,
    assumptions: [
      { name: 'no separation', status: separated > 0 || !fit.converged ? 'violated' : 'met', detail: separated > 0 ? `${separated} rows fitted at probability 0 or 1 — (quasi-)complete separation makes coefficients and SEs unreliable; consider a penalized model` : `IRLS converged in ${fit.iterations} iterations` },
      { name: 'events per parameter', status: eventsPerParameter < 10 ? 'questionable' : 'met', detail: `${eventsPerParameter.toFixed(1)} minority-class events per parameter (≥ 10 is a common rule of thumb)` },
      { name: 'linearity in the log-odds', status: 'not-checked', detail: 'continuous features are assumed to act linearly on the log-odds' },
    ],
    notes: [
      ...(aliased.length ? [`Dropped aliased terms: ${aliased.join(', ')}`] : []),
      'Odds ratios are multiplicative changes in the odds per unit change in a feature, holding the others fixed; they are associations, not causal effects, unless the design identifies them.',
    ],
  }
}

export function poissonRegression(xInput: Matrix, y: Vector, namesInput: string[], options: GlmOptions = {}): RegressionResult {
  const level = options.level ?? 0.95
  const { x, names, aliased } = dropAliased(xInput, namesInput)
  assertRows(x.length, names.length, 'Poisson regression')
  if (y.some((value) => value < 0 || !Number.isInteger(value))) throw new Error('Poisson regression needs a non-negative integer count target')
  const fit = irls(x, y, POISSON, options.offset)
  const base = glmResult('Poisson regression', x, y, names, aliased, fit, POISSON, names.includes('(Intercept)') ? interceptOnlyFit(y, POISSON, options.offset) : { deviance: Number.NaN, logLik: Number.NaN }, 0, level, 'rate ratio')
  const dispersion = base.pearsonChi2 / Math.max(1, x.length - names.length)
  return {
    ...base,
    assumptions: [
      { name: 'equidispersion', status: dispersion > 1.5 ? 'violated' : dispersion < 0.7 ? 'questionable' : 'met', detail: `Pearson χ²/df = ${dispersion.toFixed(3)}${dispersion > 1.5 ? ' — overdispersed: standard errors are too small; use negative binomial regression' : ''}` },
    ],
    notes: [...(aliased.length ? [`Dropped aliased terms: ${aliased.join(', ')}`] : []), ...(options.offset ? ['An offset (log exposure) was used, so coefficients describe rates.'] : [])],
  }
}

/** NB2 negative binomial regression; α is estimated by maximum likelihood over a profiled IRLS fit. */
export function negativeBinomialRegression(xInput: Matrix, y: Vector, namesInput: string[], options: GlmOptions = {}): RegressionResult {
  const level = options.level ?? 0.95
  const { x, names, aliased } = dropAliased(xInput, namesInput)
  assertRows(x.length, names.length + 1, 'negative binomial regression')
  if (y.some((value) => value < 0 || !Number.isInteger(value))) throw new Error('negative binomial regression needs a non-negative integer count target')
  const profile = (logAlpha: number) => {
    const family = negativeBinomialFamily(Math.exp(logAlpha))
    const fit = irls(x, y, family, options.offset)
    return { fit, family, logLik: family.logLikelihood(y, fit.mu) }
  }
  let lo = Math.log(1e-6)
  let hi = Math.log(100)
  const phi = (Math.sqrt(5) - 1) / 2
  let c = hi - phi * (hi - lo)
  let d = lo + phi * (hi - lo)
  let fc = profile(c).logLik
  let fd = profile(d).logLik
  for (let iteration = 0; iteration < 60 && hi - lo > 1e-5; iteration++) {
    if (fc > fd) {
      hi = d; d = c; fd = fc; c = hi - phi * (hi - lo); fc = profile(c).logLik
    } else {
      lo = c; c = d; fc = fd; d = lo + phi * (hi - lo); fd = profile(d).logLik
    }
  }
  const best = profile((lo + hi) / 2)
  const alpha = Math.exp((lo + hi) / 2)
  const nullFamily = best.family
  const base = glmResult('negative binomial regression (NB2)', x, y, names, aliased, best.fit, best.family, names.includes('(Intercept)') ? interceptOnlyFit(y, nullFamily, options.offset) : { deviance: Number.NaN, logLik: Number.NaN }, 1, level, 'rate ratio')
  const poissonLogLik = POISSON.logLikelihood(y, irls(x, y, POISSON, options.offset).mu)
  const lrAlpha = 2 * (best.logLik - poissonLogLik)
  return {
    ...base,
    fit: { ...base.fit, alpha, lrTestAlphaVsPoisson: lrAlpha, lrTestAlphaPValue: 0.5 * chiSquareSf(Math.max(0, lrAlpha), 1) },
    assumptions: [{ name: 'overdispersion present', status: lrAlpha > 2.71 ? 'met' : 'questionable', detail: `LR test of α = 0 (Poisson) vs NB: χ² = ${lrAlpha.toFixed(3)}; ${lrAlpha > 2.71 ? 'overdispersion is supported' : 'Poisson may suffice'}` }],
    notes: ['Coefficient standard errors are conditional on the estimated α.', ...(aliased.length ? [`Dropped aliased terms: ${aliased.join(', ')}`] : [])],
  }
}

// ---------------------------------------------------------------- robust regression

/** Huber M-estimation by IRLS with a MAD scale (k = 1.345, 95% efficiency under normality). */
export function huberRegression(xInput: Matrix, y: Vector, namesInput: string[], options: { level?: number; k?: number } = {}): RegressionResult {
  const level = options.level ?? 0.95
  const k = options.k ?? 1.345
  const { x, names, aliased } = dropAliased(xInput, namesInput)
  const n = x.length
  const p = names.length
  assertRows(n, p, 'robust regression')
  let beta = solveNormal(x, y)
  let scale = 1
  let weights = new Array<number>(n).fill(1)
  let iterations = 0
  for (; iterations < 200; iterations++) {
    const residuals = y.map((value, index) => value - sum(x[index]!.map((v, j) => v * beta[j]!)))
    const absolute = residuals.map(Math.abs).sort((a, b) => a - b)
    scale = (absolute[Math.floor((n - 1) / 2)]! + absolute[Math.ceil((n - 1) / 2)]!) / 2 / 0.6744897501960817 || 1e-12
    weights = residuals.map((r) => { const u = Math.abs(r / scale); return u <= k ? 1 : k / u })
    const next = solveNormal(x, y, weights)
    const change = Math.max(...next.map((value, index) => Math.abs(value - beta[index]!) / (Math.abs(beta[index]!) + 1e-8)))
    beta = next
    if (change < 1e-10) break
  }
  const fitted = matVec(x, beta)
  const residuals = y.map((value, index) => value - fitted[index]!)
  const psi = residuals.map((r) => { const u = r / scale; return Math.abs(u) <= k ? u : k * Math.sign(u) })
  const psiPrime = residuals.map((r) => (Math.abs(r / scale) <= k ? 1 : 0))
  const mPrime = mean(psiPrime) || 1e-12
  const factor = (scale * scale * (sum(psi.map((v) => v * v)) / (n - p))) / (mPrime * mPrime)
  const covariance = inverseSPD(gram(x)).map((row) => row.map((value) => value * factor))
  const downweighted = weights.filter((w) => w < 1).length
  return {
    model: `Huber robust regression (k = ${k})`,
    n,
    parameters: p,
    coefficients: coefficientTable(names, beta, covariance, level, n - p),
    aliased,
    fit: { scale, downweightedRows: downweighted, iterations },
    diagnostics: { downweightedShare: downweighted / n },
    assumptions: [{ name: 'outlier influence', status: 'met', detail: `${downweighted} rows (${((100 * downweighted) / n).toFixed(1)}%) were down-weighted as outliers` }],
    notes: ['Compare with the OLS fit: large coefficient differences mean a few rows drive the OLS result.'],
    fitted,
    residuals,
  }
}

// ---------------------------------------------------------------- linear mixed model

/**
 * Random-intercept linear mixed model y = Xβ + u_group + ε by profiled REML. The variance
 * ratio θ = σ²_u/σ² is optimised on a log grid then refined; β are GLS estimates.
 */
export function randomInterceptModel(xInput: Matrix, y: Vector, namesInput: string[], groups: string[], options: { level?: number } = {}): RegressionResult {
  const level = options.level ?? 0.95
  const { x, names, aliased } = dropAliased(xInput, namesInput)
  const n = x.length
  const p = names.length
  assertRows(n, p + 1, 'mixed model')
  const byGroup = new Map<string, number[]>()
  groups.forEach((group, index) => { const list = byGroup.get(group) ?? []; list.push(index); byGroup.set(group, list) })
  if (byGroup.size < 3) throw new Error('a random-intercept model needs at least 3 groups')
  const groupList = [...byGroup.values()]
  const evaluate = (theta: number) => {
    const xtvx: Matrix = Array.from({ length: p }, () => new Array<number>(p).fill(0))
    const xtvy: Vector = new Array<number>(p).fill(0)
    let logDetV = 0
    for (const rows of groupList) {
      const ng = rows.length
      const c = theta / (1 + theta * ng)
      logDetV += Math.log(1 + theta * ng)
      const sx = new Array<number>(p).fill(0)
      let sy = 0
      for (const r of rows) { for (let j = 0; j < p; j++) sx[j]! += x[r]![j]!; sy += y[r]! }
      for (const r of rows) {
        for (let i = 0; i < p; i++) {
          xtvy[i]! += x[r]![i]! * y[r]!
          for (let j = 0; j < p; j++) xtvx[i]![j]! += x[r]![i]! * x[r]![j]!
        }
      }
      for (let i = 0; i < p; i++) {
        xtvy[i]! -= c * sx[i]! * sy
        for (let j = 0; j < p; j++) xtvx[i]![j]! -= c * sx[i]! * sx[j]!
      }
    }
    const inv = inverseSPD(xtvx)
    const beta = matVec(inv, xtvy)
    let quad = 0
    for (const rows of groupList) {
      const c = theta / (1 + theta * rows.length)
      let s = 0
      for (const r of rows) {
        const e = y[r]! - sum(x[r]!.map((v, j) => v * beta[j]!))
        quad += e * e
        s += e
      }
      quad -= c * s * s
    }
    const sigma2 = quad / (n - p)
    const logDetXtVX = Math.log(Math.max(1e-300, symmetricEigen(xtvx).values.reduce((product, value) => product * Math.max(1e-300, value), 1)))
    const reml = -0.5 * ((n - p) * Math.log(sigma2) + logDetV + logDetXtVX)
    return { reml, beta, sigma2, inv }
  }
  let bestLog = -12
  let best = evaluate(0)
  let bestTheta = 0
  for (let logTheta = -12; logTheta <= 8; logTheta += 0.5) {
    const candidate = evaluate(Math.exp(logTheta))
    if (candidate.reml > best.reml) { best = candidate; bestLog = logTheta; bestTheta = Math.exp(logTheta) }
  }
  if (bestTheta > 0) {
    let lo = bestLog - 0.5
    let hi = bestLog + 0.5
    for (let iteration = 0; iteration < 50; iteration++) {
      const m1 = lo + (hi - lo) / 3
      const m2 = hi - (hi - lo) / 3
      if (evaluate(Math.exp(m1)).reml > evaluate(Math.exp(m2)).reml) hi = m2
      else lo = m1
    }
    bestTheta = Math.exp((lo + hi) / 2)
    best = evaluate(bestTheta)
  }
  const sigma2 = best.sigma2
  const sigmaU2 = bestTheta * sigma2
  const covariance = best.inv.map((row) => row.map((value) => value * sigma2))
  const fitted = x.map((row) => sum(row.map((v, j) => v * best.beta[j]!)))
  const icc = sigmaU2 / (sigmaU2 + sigma2)
  return {
    model: 'linear mixed model (random intercept, REML)',
    n,
    parameters: p,
    coefficients: coefficientTable(names, best.beta, covariance, level, n - p - 1),
    aliased,
    fit: { residualVariance: sigma2, groupVariance: sigmaU2, intraclassCorrelation: icc, groups: byGroup.size, remlLogLikelihood: best.reml },
    diagnostics: { boundaryFit: bestTheta === 0 },
    assumptions: [{ name: 'random-intercept structure', status: bestTheta === 0 ? 'questionable' : 'met', detail: bestTheta === 0 ? 'the group variance estimate is 0 (boundary); an ordinary regression is adequate' : `ICC = ${icc.toFixed(3)}: ${(100 * icc).toFixed(1)}% of residual variance is between groups` }],
    notes: ['Fixed-effect tests use Wald t statistics with n − p − 1 residual degrees of freedom, an approximation (no Satterthwaite or Kenward–Roger correction).'],
    fitted,
    residuals: y.map((value, index) => value - fitted[index]!),
  }
}

/** Normal-approximation CDF re-exported for callers that build their own Wald tests. */
export { normalCdf }
