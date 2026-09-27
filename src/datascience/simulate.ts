import { compileExpression } from './expr.ts'
import { createRng, type Rng } from './rng.ts'
import { mean, quantileSorted, spearman, standardDeviation } from './stats/describe.ts'

/**
 * Monte Carlo simulation, scenario and sensitivity analysis, and discrete-event queue
 * simulation. Inputs are independent unless stated; the output formula is the safe
 * expression language, so a model can describe a business model without writing code.
 */

export type Distribution =
  | { dist: 'normal'; mean: number; sd: number }
  | { dist: 'lognormal'; mean: number; sd: number }
  | { dist: 'uniform'; min: number; max: number }
  | { dist: 'triangular'; min: number; mode: number; max: number }
  | { dist: 'pert'; min: number; mode: number; max: number }
  | { dist: 'beta'; alpha: number; beta: number }
  | { dist: 'poisson'; lambda: number }
  | { dist: 'bernoulli'; p: number }
  | { dist: 'discrete'; values: number[]; probabilities: number[] }
  | { dist: 'empirical'; values: number[] }
  | { dist: 'constant'; value: number }

function gammaSample(shape: number, rng: Rng): number {
  if (shape < 1) return gammaSample(shape + 1, rng) * rng.next() ** (1 / shape)
  const d = shape - 1 / 3
  const c = 1 / Math.sqrt(9 * d)
  while (true) {
    let x: number
    let v: number
    do { x = rng.normal(); v = 1 + c * x } while (v <= 0)
    v = v * v * v
    const u = rng.next()
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v
  }
}

export function sample(distribution: Distribution, rng: Rng): number {
  switch (distribution.dist) {
    case 'constant': return distribution.value
    case 'normal': return rng.normal(distribution.mean, distribution.sd)
    case 'lognormal': {
      const variance = Math.log(1 + (distribution.sd / distribution.mean) ** 2)
      return Math.exp(rng.normal(Math.log(distribution.mean) - variance / 2, Math.sqrt(variance)))
    }
    case 'uniform': return distribution.min + rng.next() * (distribution.max - distribution.min)
    case 'triangular': {
      const { min, mode, max } = distribution
      const u = rng.next()
      const f = (mode - min) / (max - min)
      return u < f ? min + Math.sqrt(u * (max - min) * (mode - min)) : max - Math.sqrt((1 - u) * (max - min) * (max - mode))
    }
    case 'pert': {
      const { min, mode, max } = distribution
      const a = 1 + (4 * (mode - min)) / (max - min)
      const b = 1 + (4 * (max - mode)) / (max - min)
      const x = gammaSample(a, rng)
      return min + (x / (x + gammaSample(b, rng))) * (max - min)
    }
    case 'beta': { const x = gammaSample(distribution.alpha, rng); return x / (x + gammaSample(distribution.beta, rng)) }
    case 'poisson': {
      if (distribution.lambda > 50) return Math.max(0, Math.round(rng.normal(distribution.lambda, Math.sqrt(distribution.lambda))))
      const limit = Math.exp(-distribution.lambda)
      let k = 0
      let p = 1
      do { k++; p *= rng.next() } while (p > limit)
      return k - 1
    }
    case 'bernoulli': return rng.next() < distribution.p ? 1 : 0
    case 'discrete': {
      const total = distribution.probabilities.reduce((a, b) => a + b, 0)
      let u = rng.next() * total
      for (let index = 0; index < distribution.values.length; index++) {
        u -= distribution.probabilities[index]!
        if (u <= 0) return distribution.values[index]!
      }
      return distribution.values.at(-1)!
    }
    case 'empirical': return distribution.values[rng.int(distribution.values.length)]!
  }
}

function validateDistribution(name: string, value: unknown): Distribution {
  if (!value || typeof value !== 'object') throw new Error(`variable ${name} must be a distribution object like { "dist": "normal", "mean": 10, "sd": 2 }`)
  const d = value as Record<string, unknown>
  const num = (key: string) => { if (typeof d[key] !== 'number' || !Number.isFinite(d[key])) throw new Error(`variable ${name} (${String(d.dist)}) needs numeric "${key}"`); return d[key] as number }
  switch (d.dist) {
    case 'normal': { const sd = num('sd'); if (sd < 0) throw new Error(`${name}: sd must be ≥ 0`); return { dist: 'normal', mean: num('mean'), sd } }
    case 'lognormal': { const m = num('mean'); if (m <= 0) throw new Error(`${name}: lognormal mean must be > 0`); return { dist: 'lognormal', mean: m, sd: num('sd') } }
    case 'uniform': return { dist: 'uniform', min: num('min'), max: num('max') }
    case 'triangular':
    case 'pert': { const min = num('min'); const mode = num('mode'); const max = num('max'); if (!(min <= mode && mode <= max && min < max)) throw new Error(`${name}: need min ≤ mode ≤ max`); return { dist: d.dist, min, mode, max } }
    case 'beta': return { dist: 'beta', alpha: num('alpha'), beta: num('beta') }
    case 'poisson': return { dist: 'poisson', lambda: num('lambda') }
    case 'bernoulli': return { dist: 'bernoulli', p: num('p') }
    case 'constant': return { dist: 'constant', value: num('value') }
    case 'discrete': if (!Array.isArray(d.values) || !Array.isArray(d.probabilities) || d.values.length !== d.probabilities.length) throw new Error(`${name}: discrete needs equal-length values and probabilities`); return { dist: 'discrete', values: d.values as number[], probabilities: d.probabilities as number[] }
    case 'empirical': if (!Array.isArray(d.values) || d.values.length === 0) throw new Error(`${name}: empirical needs values`); return { dist: 'empirical', values: d.values as number[] }
    default: throw new Error(`variable ${name}: dist must be normal, lognormal, uniform, triangular, pert, beta, poisson, bernoulli, discrete, empirical, or constant`)
  }
}

export interface SimulationResult {
  iterations: number
  seed: number
  outputs: Record<string, { mean: number; sd: number; p01: number; p05: number; p10: number; p25: number; median: number; p75: number; p90: number; p95: number; p99: number; min: number; max: number; histogram: { edges: number[]; counts: number[] }; probabilities: Record<string, number> }>
  sensitivity: Array<{ output: string; variable: string; spearman: number; lowValue: number; highValue: number; swing: number }>
  scenarios?: Array<{ name: string; values: Record<string, number> }>
  notes: string[]
}

export function monteCarlo(input: { variables: Record<string, unknown>; outputs: Record<string, string>; iterations?: number; seed?: number; thresholds?: Record<string, number[]>; scenarios?: Record<string, Record<string, number>> }): SimulationResult {
  const names = Object.keys(input.variables)
  if (names.length === 0) throw new Error('simulation needs at least one input variable')
  const distributions = Object.fromEntries(names.map((name) => [name, validateDistribution(name, input.variables[name])]))
  const outputNames = Object.keys(input.outputs)
  if (outputNames.length === 0) throw new Error('simulation needs at least one output formula, e.g. { "profit": "units * (price - cost) - fixed" }')
  const known = [...names, ...outputNames]
  const formulas = outputNames.map((name) => ({ name, expression: compileExpression(input.outputs[name]!, known) }))
  const iterations = Math.max(100, Math.min(1_000_000, Math.floor(input.iterations ?? 10_000)))
  const seed = input.seed ?? 42
  const rng = createRng(seed)
  const draws: Record<string, number[]> = Object.fromEntries(names.map((name) => [name, new Array<number>(iterations)]))
  const results: Record<string, number[]> = Object.fromEntries(outputNames.map((name) => [name, new Array<number>(iterations)]))
  let invalid = 0
  const evaluate = (values: Record<string, number>) => {
    const scope: Record<string, number | null> = { ...values }
    for (const formula of formulas) {
      const value = formula.expression.evaluate({}, scope)
      scope[formula.name] = typeof value === 'number' ? value : null
    }
    return scope
  }
  for (let i = 0; i < iterations; i++) {
    const values: Record<string, number> = {}
    for (const name of names) {
      values[name] = sample(distributions[name]!, rng)
      draws[name]![i] = values[name]!
    }
    const scope = evaluate(values)
    for (const formula of formulas) {
      const value = scope[formula.name]
      if (typeof value !== 'number' || !Number.isFinite(value)) invalid++
      results[formula.name]![i] = typeof value === 'number' ? value : Number.NaN
    }
  }
  const outputs: SimulationResult['outputs'] = {}
  for (const name of outputNames) {
    const values = results[name]!.filter(Number.isFinite)
    const sorted = [...values].sort((a, b) => a - b)
    const bins = 30
    const min = sorted[0] ?? 0
    const max = sorted.at(-1) ?? 0
    const width = (max - min) / bins || 1
    const counts = new Array<number>(bins).fill(0)
    for (const value of sorted) counts[Math.min(bins - 1, Math.floor((value - min) / width))]!++
    const probabilities: Record<string, number> = {}
    for (const threshold of input.thresholds?.[name] ?? [0]) probabilities[`P(${name} < ${threshold})`] = sorted.filter((value) => value < threshold).length / sorted.length
    outputs[name] = { mean: mean(sorted), sd: standardDeviation(sorted), p01: quantileSorted(sorted, 0.01), p05: quantileSorted(sorted, 0.05), p10: quantileSorted(sorted, 0.1), p25: quantileSorted(sorted, 0.25), median: quantileSorted(sorted, 0.5), p75: quantileSorted(sorted, 0.75), p90: quantileSorted(sorted, 0.9), p95: quantileSorted(sorted, 0.95), p99: quantileSorted(sorted, 0.99), min, max, histogram: { edges: Array.from({ length: bins + 1 }, (_, index) => min + index * width), counts }, probabilities }
  }
  // Sensitivity: rank correlation plus a one-at-a-time swing between each input's P10 and P90.
  const medians = Object.fromEntries(names.map((name) => [name, quantileSorted([...draws[name]!].sort((a, b) => a - b), 0.5)]))
  const sensitivity: SimulationResult['sensitivity'] = []
  for (const output of outputNames) {
    for (const name of names) {
      if (distributions[name]!.dist === 'constant') continue
      const sortedInput = [...draws[name]!].sort((a, b) => a - b)
      const low = evaluate({ ...medians, [name]: quantileSorted(sortedInput, 0.1) })[output] ?? Number.NaN
      const high = evaluate({ ...medians, [name]: quantileSorted(sortedInput, 0.9) })[output] ?? Number.NaN
      const paired = results[output]!.map((value, index) => [draws[name]![index]!, value] as const).filter((pair) => Number.isFinite(pair[1]))
      sensitivity.push({ output, variable: name, spearman: spearman(paired.map((p) => p[0]), paired.map((p) => p[1])), lowValue: low as number, highValue: high as number, swing: Math.abs((high as number) - (low as number)) })
    }
  }
  sensitivity.sort((a, b) => b.swing - a.swing)
  const scenarios = input.scenarios ? Object.entries(input.scenarios).map(([name, overrides]) => {
    const values = evaluate({ ...medians, ...overrides })
    return { name, values: Object.fromEntries(outputNames.map((output) => [output, values[output] as number])) }
  }) : undefined
  return { iterations, seed, outputs, sensitivity, ...(scenarios ? { scenarios } : {}), notes: ['inputs are sampled independently; correlated drivers (e.g. price and volume) would make the true spread wider or narrower than shown', ...(invalid ? [`${invalid} output evaluations were not finite (division by zero or invalid math) and were excluded`] : []), 'tornado swings vary one input between its P10 and P90 with the others at their medians'] }
}

// ---------------------------------------------------------------- discrete-event queue

/** Erlang C probability that an arrival waits, and the mean wait, for an M/M/c queue. */
export function erlangC(arrivalRate: number, serviceRate: number, servers: number): { utilization: number; probabilityWait: number; meanWait: number } {
  const a = arrivalRate / serviceRate
  const rho = a / servers
  if (rho >= 1) return { utilization: rho, probabilityWait: 1, meanWait: Number.POSITIVE_INFINITY }
  let term = 1
  let sumTerms = 1
  for (let k = 1; k < servers; k++) { term *= a / k; sumTerms += term }
  const last = (term * a) / servers
  const pw = last / (1 - rho) / (sumTerms + last / (1 - rho))
  return { utilization: rho, probabilityWait: pw, meanWait: pw / (servers * serviceRate - arrivalRate) }
}

/** Event-driven M/M/c (or general) queue simulation with first-come-first-served service. */
export function simulateQueue(input: { arrivalRate: number; serviceRate: number; servers: number; duration: number; seed?: number; warmup?: number }): Record<string, unknown> {
  const rng = createRng(input.seed ?? 42)
  const exp = (rate: number) => -Math.log(1 - rng.next()) / rate
  const free = new Array<number>(input.servers).fill(0)
  const waits: number[] = []
  let time = 0
  let busy = 0
  const warmup = input.warmup ?? input.duration * 0.1
  while (true) {
    time += exp(input.arrivalRate)
    if (time > input.duration) break
    const server = free.indexOf(Math.min(...free))
    const start = Math.max(time, free[server]!)
    const service = exp(input.serviceRate)
    free[server] = start + service
    if (time >= warmup) { waits.push(start - time); busy += service }
  }
  const sorted = [...waits].sort((a, b) => a - b)
  const analytic = erlangC(input.arrivalRate, input.serviceRate, input.servers)
  return {
    customers: waits.length,
    meanWait: mean(waits),
    p90Wait: quantileSorted(sorted, 0.9),
    probabilityWait: waits.filter((w) => w > 1e-12).length / Math.max(1, waits.length),
    utilization: busy / (input.servers * (input.duration - warmup)),
    analytic: analytic.utilization < 1 ? analytic : { ...analytic, note: 'arrival rate ≥ capacity: the queue grows without bound' },
    notes: ['exponential inter-arrival and service times (M/M/c); the analytic Erlang-C values are shown to validate the simulation'],
  }
}
