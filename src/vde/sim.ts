import { seededRandom } from './stats.ts'

/**
 * The paper's §11 simulations, ported from its appendix so they run inside elia
 * with no Python — `elia vde simulate` prints them, and the tests pin the
 * thresholds they reproduce. They test the mathematics, not live models.
 *
 * One addition the paper's §11.4 was missing: the naive gate at the *large*
 * held-out size. Without it, the paper credits the valid threshold for a gain
 * that comes from holdout size (naive gating at n = 5,000 does as well or
 * better on true gain). `metaLoopControls` runs that control.
 */

type Rand = () => number

function normal(rand: Rand): number {
  let u = 0
  while (u === 0) u = rand()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand())
}

/** Draws a geometric count of trials until the first success (≥ 1). */
export function geometric(p: number, rand: Rand): number {
  if (p >= 1) return 1
  if (p <= 0) return Number.POSITIVE_INFINITY
  let u = 0
  while (u === 0) u = rand()
  return Math.max(1, Math.ceil(Math.log(u) / Math.log(1 - p)))
}

/** Binomial draw: waiting times when the mean is small, a clamped normal otherwise. */
export function binomial(n: number, p: number, rand: Rand): number {
  if (n <= 0 || p <= 0) return 0
  if (p >= 1) return n
  const flip = p > 0.5
  const q = flip ? 1 - p : p
  let k: number
  if (n * q < 30) {
    k = 0
    let position = geometric(q, rand)
    while (position <= n) {
      k += 1
      position += geometric(q, rand)
    }
  } else {
    const draw = Math.round(n * q + Math.sqrt(n * q * (1 - q)) * normal(rand))
    k = Math.min(n, Math.max(0, draw))
  }
  return flip ? n - k : k
}

// --- Sim 1: argmax over a learned score vs first-accept under a verifier -----

export function simArgmax(n: number, rand: Rand, options: { p?: number; eta?: number; trials?: number } = {}): number {
  const p = options.p ?? 0.05
  const eta = options.eta ?? 0.002
  const trials = options.trials ?? 20_000
  let correct = 0
  for (let t = 0; t < trials; t++) {
    const kc = binomial(n, p, rand)
    const ke = binomial(n - kc, eta, rand)
    const kw = n - kc - ke
    if (ke > 0) continue // an exploit scores above every honest candidate
    const bestCorrect = kc > 0 ? 0.6 + 0.4 * rand() ** (1 / kc) : -1
    const bestWrong = kw > 0 ? 0.8 * rand() ** (1 / kw) : -1
    if (bestCorrect > bestWrong) correct += 1
  }
  return correct / trials
}

export function simThreshold(n: number, rand: Rand, options: { p?: number; alpha?: number; beta?: number; trials?: number } = {}): { precision: number; coverage: number } {
  const p = options.p ?? 0.05
  const alpha = options.alpha ?? 0.01
  const beta = options.beta ?? 0.1
  const trials = options.trials ?? 20_000
  const pos = p * (1 - beta)
  const neg = (1 - p) * alpha
  let out = 0
  let correct = 0
  for (let t = 0; t < trials; t++) {
    if (geometric(pos + neg, rand) > n) continue
    out += 1
    if (rand() < pos / (pos + neg)) correct += 1
  }
  return { precision: out === 0 ? 0 : correct / out, coverage: out / trials }
}

// --- Sim 2: the error threshold in a finite Wright–Fisher library -------------

export function simLibrary(leap: number, rand: Rand, options: { eps?: number; sigma?: number; r?: number; population?: number; generations?: number; burn?: number; reps?: number } = {}): number {
  const eps = options.eps ?? 0.01
  const sigma = options.sigma ?? 2
  const c = 1 - (options.r ?? 0)
  const population = options.population ?? 2000
  const generations = options.generations ?? 800
  const burn = options.burn ?? 400
  const reps = options.reps ?? 8
  const q = (1 - eps) ** leap
  let total = 0
  for (let rep = 0; rep < reps; rep++) {
    let sound = population
    let sum = 0
    let count = 0
    for (let g = 0; g < generations; g++) {
      if (sound > 0) sound = binomial(population, (q * sigma * sound) / (sigma * sound + c * (population - sound)), rand)
      if (g >= burn) {
        sum += sound / population
        count += 1
      }
    }
    total += sum / count
  }
  return total / reps
}

// --- Sim 3: stepping stones and compounding slips ------------------------------

export function simSteppingStones(m: number, rand: Rand, options: { q?: number; eps?: number; trials?: number } = {}): { resample: number; archive: number; sound: number } {
  const q = options.q ?? 0.2
  const eps = options.eps ?? 0.05
  const trials = options.trials ?? 20_000
  let resample = 0
  let archive = 0
  let sound = 0
  for (let t = 0; t < trials; t++) {
    resample += geometric(q ** m, rand)
    for (let step = 0; step < m; step++) archive += geometric(q, rand)
    let ok = true
    for (let step = 0; step < m; step++) if (rand() < eps) ok = false
    if (ok) sound += 1
  }
  return { resample: resample / trials, archive: archive / trials, sound: sound / trials }
}

// --- Sim 4: meta-loop gating with task-level luck and optional tampering ------

export interface MetaOptions {
  gate: 'naive' | 'valid'
  heldOut: number
  seed: number
  proposals?: number
  fresh?: number
  tamperRate?: number
  delta?: number
}

export interface MetaResult {
  proposed: Record<string, number>
  accepted: Record<string, number>
  bar: number
  measured: number
  fresh: number
  trueGain: number
}

export function simMeta(options: MetaOptions): MetaResult {
  const rand = seededRandom(options.seed * 7919 + 17)
  const K = options.proposals ?? 400
  const nH = options.heldOut
  const nT = options.fresh ?? 5000
  const mu0 = 0.4
  const s = 0.2
  const rho = 0.8
  const pReal = 0.03
  const pHarm = 0.1
  const pTamper = options.tamperRate ?? 0
  const delta = options.delta ?? 0.05
  const uH = Array.from({ length: nH }, rand)
  const uT = Array.from({ length: nT }, rand)
  let xH = Array.from({ length: nH }, () => s * normal(rand))
  let xT = Array.from({ length: nT }, () => s * normal(rand))
  let mu = mu0
  let tamper = 0
  const score = (u: number[], x: number[], m: number) => u.map((value, i) => (value < m + x[i]! ? 1 : 0))
  let oH = score(uH, xH, mu)
  let oT = score(uT, xT, mu)
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)
  const h0 = mean(oH)
  const t0 = mean(oT)
  const lnKd = Math.log(K / delta)
  const proposed: Record<string, number> = {}
  const accepted: Record<string, number> = {}
  let barSum = 0
  const shuffle = (x: number[]) => x.map((value) => rho * value + Math.sqrt(1 - rho * rho) * s * normal(rand))
  for (let k = 0; k < K; k++) {
    const r = rand()
    const kind = r < pTamper ? 'tamper' : r < pTamper + pReal ? 'real' : r < pTamper + pReal + pHarm ? 'harm' : 'neutral'
    proposed[kind] = (proposed[kind] ?? 0) + 1
    const mu2 = Math.min(1, Math.max(0, mu + (kind === 'real' ? 0.03 : kind === 'harm' ? -0.03 : 0)))
    const xH2 = shuffle(xH)
    const xT2 = shuffle(xT)
    const tamper2 = tamper + (kind === 'tamper' ? 0.2 : 0)
    const oH2 = score(uH, xH2, mu2)
    const diff = oH2.map((value, i) => value - oH[i]!)
    const dm = mean(diff)
    const variance = diff.reduce((sum, value) => sum + (value - dm) ** 2, 0) / Math.max(1, diff.length - 1)
    const gain = dm + tamper2 - tamper
    const bar = Math.sqrt((2 * variance * lnKd) / nH) + (4 / 3) * (lnKd / nH)
    barSum += bar
    if (gain > (options.gate === 'naive' ? 0 : bar)) {
      accepted[kind] = (accepted[kind] ?? 0) + 1
      mu = mu2
      xH = xH2
      xT = xT2
      tamper = tamper2
      oH = oH2
      oT = score(uT, xT, mu)
    }
  }
  return { proposed, accepted, bar: barSum / K, measured: mean(oH) + tamper - h0, fresh: mean(oT) - t0, trueGain: mu - mu0 }
}

export interface MetaSummary {
  label: string
  realAccepted: number
  realProposed: number
  neutralAccepted: number
  tamperAccepted: number
  measured: number
  fresh: number
  trueGain: number
}

export function summarizeMeta(label: string, base: Omit<MetaOptions, 'seed'>, seeds: number): MetaSummary {
  const runs = Array.from({ length: seeds }, (_, seed) => simMeta({ ...base, seed }))
  const avg = (pick: (run: MetaResult) => number) => runs.reduce((sum, run) => sum + pick(run), 0) / runs.length
  return {
    label,
    realAccepted: avg((run) => run.accepted.real ?? 0),
    realProposed: avg((run) => run.proposed.real ?? 0),
    neutralAccepted: avg((run) => run.accepted.neutral ?? 0),
    tamperAccepted: avg((run) => run.accepted.tamper ?? 0),
    measured: avg((run) => run.measured),
    fresh: avg((run) => run.fresh),
    trueGain: avg((run) => run.trueGain),
  }
}

/** §11.4's four scenarios plus the control it lacked: naive gating with the large holdout. */
export function metaLoopControls(options: { seeds?: number; fresh?: number; small?: number; large?: number } = {}): MetaSummary[] {
  const seeds = options.seeds ?? 5
  const fresh = options.fresh ?? 2000
  const small = options.small ?? 500
  const large = options.large ?? 5000
  return [
    summarizeMeta(`A naive, n=${small}`, { gate: 'naive', heldOut: small, fresh }, seeds),
    summarizeMeta(`B valid, n=${small}`, { gate: 'valid', heldOut: small, fresh }, seeds),
    summarizeMeta(`C valid, n=${large}`, { gate: 'valid', heldOut: large, fresh }, seeds),
    summarizeMeta(`D valid, n=${large}, tampering`, { gate: 'valid', heldOut: large, fresh, tamperRate: 0.01 }, seeds),
    summarizeMeta(`A' naive, n=${large} (control)`, { gate: 'naive', heldOut: large, fresh }, seeds),
  ]
}
