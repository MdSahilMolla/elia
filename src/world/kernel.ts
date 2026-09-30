import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { stateDir } from '../statePaths.ts'
import { appendSecureFile, ensureSecureDirectory } from '../securePersistence.ts'

/**
 * The world model's kernel: a belief about one number, and the record of how
 * often that belief was right.
 *
 * A world model earns trust the only way one can — by committing to a
 * prediction *before* the measurement and being scored after. Everything the
 * twin says about a candidate is therefore a `Belief` over
 * `θ = ln(candidate tokens ÷ baseline tokens)`, written to the receipt ledger
 * before a single benchmark task runs, and closed with the measured θ once one
 * exists. The ledger is what the model is calibrated on: the correction it
 * applies to its own arithmetic, and how wide it makes its intervals, are read
 * back from it. Each paid verdict makes the next screen more accurate, which is
 * the only sense in which this is a model that improves.
 *
 * The ledger is hash-chained. A prediction that could be quietly rewritten after
 * the fact would be a calibration record that always looks right.
 */

/** A normal belief about θ. `mean` is a log ratio: −0.05 is about 5% fewer tokens. */
export interface Belief {
  mean: number
  sd: number
}

/**
 * Noise of one whole-suite token total between two runs of the *same* code.
 * Totals swing by about ±8% (two standard deviations) run to run, measured on
 * this suite; the twin has to clear that, not just the arithmetic.
 */
export const MEASURE_SD = 0.04

/** The margin a candidate must beat to win on tokens alone (fitness.ts EFFICIENCY_MARGIN). */
export const TOKEN_MARGIN = 0.05

/** Standard normal CDF (Abramowitz–Stegun 7.1.26, |error| < 1.5e-7). */
export function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z))
  const density = Math.exp(-(z * z) / 2) / Math.sqrt(2 * Math.PI)
  const tail = density * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
  return z >= 0 ? 1 - tail : tail
}

/**
 * The chance a measurement of a candidate believed to be `belief` shows at
 * least `margin` fewer tokens. The measurement adds its own noise on top of
 * the belief's, because a true saving can still read as none on the day.
 */
export function winProbability(belief: Belief, margin = TOKEN_MARGIN, measurementSd = MEASURE_SD): number {
  const sd = Math.hypot(belief.sd, measurementSd)
  return normalCdf((Math.log(1 - margin) - belief.mean) / sd)
}

export type SurfaceKind = 'inert' | 'prefix' | 'mixed' | 'other'

/** What the twin committed to about one candidate, and — once measured — what happened. */
export interface Receipt {
  generation: number
  at: number
  surface: SurfaceKind
  /** The uncalibrated arithmetic, so the correction can be re-derived from the ledger alone. */
  raw: number
  predicted: Belief
  decision: 'proceed' | 'skip'
  reason: string
  /** Measured θ, once the candidate's tokens were compared with the baseline's. */
  actual?: number
  /** (actual − predicted.mean) ÷ predicted.sd. */
  z?: number
  /** The hash of the previous receipt, then of this one: a chain, not a list. */
  prev: string
  hash: string
}

export type ReceiptBody = Omit<Receipt, 'prev' | 'hash'>

const GENESIS = 'genesis'

export const RECEIPTS_PATH = join(stateDir, 'world', 'receipts.jsonl')

export function chainHash(prev: string, body: ReceiptBody): string {
  return createHash('sha256').update(`${prev}\n${JSON.stringify(body)}`).digest('hex')
}

export function readReceipts(path = RECEIPTS_PATH): Receipt[] {
  if (!existsSync(path)) return []
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.trim())
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as Receipt]
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}

/** Index of the first receipt whose hash does not follow from the one before it, or undefined when the chain holds. */
export function brokenAt(receipts: readonly Receipt[]): number | undefined {
  let prev = GENESIS
  for (const [index, receipt] of receipts.entries()) {
    const { prev: recordedPrev, hash, ...body } = receipt
    if (recordedPrev !== prev || chainHash(prev, body) !== hash) return index
    prev = hash
  }
  return undefined
}

/** Appends a receipt to the chain. Never throws: a lost receipt costs one calibration point, not the run. */
export function appendReceipt(body: ReceiptBody, path = RECEIPTS_PATH): Receipt | undefined {
  try {
    const existing = readReceipts(path)
    const prev = existing.at(-1)?.hash ?? GENESIS
    const receipt: Receipt = { ...body, prev, hash: chainHash(prev, body) }
    ensureSecureDirectory(dirname(path))
    appendSecureFile(path, `${JSON.stringify(receipt)}\n`)
    return receipt
  } catch {
    return undefined
  }
}

/**
 * Closes a generation's receipt with what was measured. Appended as a new
 * receipt rather than rewriting the old one, so the chain stays append-only and
 * the prediction stays exactly as committed.
 */
export function closeReceipt(open: Receipt, actual: number, path = RECEIPTS_PATH): Receipt | undefined {
  const { prev: _prev, hash: _hash, ...body } = open
  return appendReceipt({ ...body, at: Date.now(), actual, z: (actual - open.predicted.mean) / Math.max(open.predicted.sd, 1e-9) }, path)
}

/** The receipts that were scored: the last one recorded for each generation, and only if it has a measurement. */
export function scored(receipts: readonly Receipt[]): Receipt[] {
  const latest = new Map<number, Receipt>()
  for (const receipt of receipts) latest.set(receipt.generation, receipt)
  return [...latest.values()].filter((receipt) => receipt.actual !== undefined && receipt.z !== undefined)
}

export interface Calibration {
  /** Scored predictions the numbers below stand on. */
  n: number
  /** Multiplier on the arithmetic's predicted effect: 1 until enough evidence says otherwise. */
  k: number
  /** Multiplier on every predicted sd: above 1 when the model has been overconfident. */
  sdScale: number
  /** Share of measurements that landed inside the model's own 95% interval. */
  coverage: number | undefined
}

/** Scored predictions needed before the ledger is allowed to move the model at all. */
export const MIN_CALIBRATION = 3

const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value))

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/**
 * What the ledger says about the model's own accuracy.
 *
 * `k` is the median ratio of measured to predicted effect over the predictions
 * that had an effect worth measuring (a candidate predicted at 0.1% says
 * nothing about the coefficient), clamped so one strange run cannot turn the
 * model off. `sdScale` is the root-mean-square z: 1 for a model that is exactly
 * as unsure as it should be, more when it was too sure. Both stay at 1 until
 * `MIN_CALIBRATION` scored predictions exist.
 */
export function calibrate(receipts: readonly Receipt[]): Calibration {
  const done = scored(receipts)
  if (done.length < MIN_CALIBRATION) return { n: done.length, k: 1, sdScale: 1, coverage: done.length === 0 ? undefined : coverageOf(done) }
  const informative = done.filter((receipt) => receipt.surface === 'prefix' && Math.abs(receipt.raw) >= 0.01)
  const k = informative.length >= MIN_CALIBRATION ? clamp(median(informative.map((receipt) => receipt.actual! / receipt.raw)), 0.5, 1.5) : 1
  const rms = Math.sqrt(done.reduce((sum, receipt) => sum + receipt.z! ** 2, 0) / done.length)
  return { n: done.length, k, sdScale: clamp(rms, 0.5, 3), coverage: coverageOf(done) }
}

function coverageOf(done: Receipt[]): number {
  return done.filter((receipt) => Math.abs(receipt.z!) <= 1.96).length / done.length
}
