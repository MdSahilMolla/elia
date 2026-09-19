import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { appendSecureFile } from '../securePersistence.ts'
import { stateDir } from '../statePaths.ts'
import { askJev, jevEnabled, type JevText } from '../providers/jev.ts'

/**
 * Jev as a second, parallel judge — measured before it is trusted.
 *
 * Every decision here is one elia already makes some other way: "will the
 * checks pass on this change?", "is this run really done?", "does this code
 * hide a defect?". Jev answers the same question in parallel, and its answer is
 * written down next to elia's own and, once known, next to what actually
 * happened. That ledger is the whole point. A second opinion that has never
 * been scored is exactly the kind of gate this codebase has already shipped
 * three of — reachable, green, and vacuous — so Jev is allowed to change what
 * elia does only for a decision on which the ledger shows it beating elia's own
 * answer (`promoted`). Until then it is shadow-only.
 *
 * `ELIA_JEV_MODE`: `off` (never ask), `shadow` (ask and record, never act),
 * `auto` (default — act on promoted decisions), `always` (act regardless of the
 * record; for trying it out, not for trusting it).
 */

export type DecisionKind = 'turn-verify' | 'run-complete' | 'critic-defect'

export interface Prediction {
  type: 'predict'
  id: string
  at: string
  kind: DecisionKind
  /** elia's own answer to the same question, when it has one. `true` = passes / done / clean. */
  local?: boolean
  /** Jev's probability that the answer is `true`. */
  jev?: { pYes: number }
  error?: string
  latencyMs: number
}

export interface Resolution {
  type: 'resolve'
  id: string
  at: string
  actual: boolean
}

export interface KindSummary {
  kind: DecisionKind
  /** Predictions Jev actually answered. */
  answered: number
  errors: number
  /** Answered predictions whose outcome is known. */
  resolved: number
  jevAccuracy?: number
  localAccuracy?: number
  /** Failures (actual=false) Jev called as failures, over all resolved failures. */
  jevFailureRecall?: number
  /** Mean squared error of Jev's probability that the answer is `true`. Lower is better; 0.25 is a coin. */
  brier?: number
  meanLatencyMs?: number
  promoted: boolean
  why: string
}

/** Resolved samples needed before a decision can be promoted — below this, accuracy is noise. */
export const MIN_RESOLVED = 20
/** How much better than elia's own answer Jev must be to be allowed to act on it. */
export const MIN_MARGIN = 0.05
/** Jev acts only on confident answers. */
export const ACT_CONFIDENCE = 0.8

export function ledgerPath(dir = stateDir): string {
  return join(dir, 'system-one.ndjson')
}

export type JevMode = 'off' | 'shadow' | 'auto' | 'always'

export function jevMode(): JevMode {
  const raw = process.env.ELIA_JEV_MODE?.trim().toLowerCase()
  return raw === 'off' || raw === 'shadow' || raw === 'always' ? raw : 'auto'
}

export interface PredictOptions {
  local?: boolean
  timeoutMs?: number
  signal?: AbortSignal
  dir?: string
}

export interface PredictResult {
  id: string
  /** Jev's answer: `true` = passes / done / clean. Undefined when Jev failed to answer. */
  ok?: boolean
  /** Jev's probability of `true` — a `noul` answer. */
  pYes?: number
  /** How sure Jev is of `ok`: the probability on the side it came down on. */
  confidence?: number
  /** Whether elia should act on this answer, given the mode and the record. */
  actionable: boolean
}

/**
 * A yes/no question, asked as Jev's `noul` type. Phrase `instructions` so that
 * yes means passes / done / clean: jev-1.13 reads questions literally, and a
 * negated one flips the meaning of every number in the ledger.
 */
export interface YesNo {
  instructions: string
  criteria?: { true: string; false: string }
}

/**
 * Asks Jev a yes/no question and records the prediction. Undefined when Jev is
 * not configured — the caller's path is then exactly what it was before.
 *
 * The state is the agent's own work and words, and Jev does not treat state as
 * hostile, so text in it can sway the answer. That is tolerable only because an
 * answer never passes anything: at most it buys one more review.
 */
export async function predict(kind: DecisionKind, state: JevText, question: YesNo, options: PredictOptions = {}): Promise<PredictResult | undefined> {
  if (!jevEnabled()) return undefined
  const result = await askJev(state, { outcome: { type: 'noul', ...question } }, { timeoutMs: options.timeoutMs, signal: options.signal })
  if (!result) return undefined
  const id = randomUUID()
  const record: Prediction = { type: 'predict', id, at: new Date().toISOString(), kind, local: options.local, latencyMs: result.latencyMs }
  const answer = result.ok ? result.answers.outcome : undefined
  if (answer?.type === 'noul') record.jev = { pYes: answer.noul }
  else record.error = result.ok ? 'answer was not a noul' : result.error
  append(record, options.dir)
  if (!record.jev) return { id, actionable: false }
  const pYes = record.jev.pYes
  const ok = pYes >= 0.5
  const confidence = ok ? pYes : 1 - pYes
  const actionable = confidence >= ACT_CONFIDENCE && mayAct(kind, options.dir)
  return { id, ok, pYes, confidence, actionable }
}

const pending = new Set<Promise<unknown>>()

/**
 * Runs `work` without blocking a synchronous caller, but keeps it reachable so
 * the process can wait for it before exiting (`settleSystemOne`). Jev's answer
 * is bounded by its own timeout, so the wait is too.
 */
export function inBackground(work: () => Promise<unknown>): void {
  const promise = work().catch(() => undefined)
  pending.add(promise)
  void promise.finally(() => pending.delete(promise))
}

export async function settleSystemOne(): Promise<void> {
  while (pending.size > 0) await Promise.all(pending)
}

export function resolvePrediction(id: string | undefined, actual: boolean, dir?: string): void {
  if (!id) return
  append({ type: 'resolve', id, at: new Date().toISOString(), actual } satisfies Resolution, dir)
}

/** Records a prediction whose answer is already known (a labelled benchmark). */
export async function predictLabelled(kind: DecisionKind, state: JevText, question: YesNo, actual: boolean, options: PredictOptions = {}): Promise<PredictResult | undefined> {
  const result = await predict(kind, state, question, options)
  if (result) resolvePrediction(result.id, actual, options.dir)
  return result
}

function mayAct(kind: DecisionKind, dir?: string): boolean {
  const mode = jevMode()
  if (mode === 'always') return true
  if (mode !== 'auto') return false
  return summarize(readLedger(dir)).find((summary) => summary.kind === kind)?.promoted ?? false
}

function append(line: Prediction | Resolution, dir?: string): void {
  try {
    appendSecureFile(ledgerPath(dir), `${JSON.stringify(line)}\n`)
  } catch {
    // The ledger is evidence, not control flow — failing to write it must not fail a turn.
  }
}

export function readLedger(dir?: string): Array<Prediction | Resolution> {
  const path = ledgerPath(dir)
  if (!existsSync(path)) return []
  const out: Array<Prediction | Resolution> = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as Prediction | Resolution)
    } catch {
      // A torn line from a crashed process is skipped, not fatal.
    }
  }
  return out
}

const KINDS: DecisionKind[] = ['turn-verify', 'run-complete', 'critic-defect']

export function summarize(lines: Array<Prediction | Resolution>): KindSummary[] {
  const outcomes = new Map<string, boolean>()
  for (const line of lines) if (line.type === 'resolve') outcomes.set(line.id, line.actual)
  return KINDS.map((kind) => {
    const predictions = lines.filter((line): line is Prediction => line.type === 'predict' && line.kind === kind)
    const answered = predictions.filter((line) => line.jev)
    const resolved = answered.filter((line) => outcomes.has(line.id))
    const summary: KindSummary = {
      kind,
      answered: answered.length,
      errors: predictions.length - answered.length,
      resolved: resolved.length,
      promoted: false,
      why: '',
    }
    if (answered.length > 0) summary.meanLatencyMs = Math.round(answered.reduce((sum, line) => sum + line.latencyMs, 0) / answered.length)
    if (resolved.length === 0) {
      summary.why = answered.length === 0 ? 'no answers yet' : 'no outcomes known yet'
      return summary
    }
    const actualOf = (line: Prediction) => outcomes.get(line.id)!
    summary.jevAccuracy = resolved.filter((line) => (line.jev!.pYes >= 0.5) === actualOf(line)).length / resolved.length
    summary.brier = resolved.reduce((sum, line) => {
      return sum + (line.jev!.pYes - (actualOf(line) ? 1 : 0)) ** 2
    }, 0) / resolved.length
    const withLocal = resolved.filter((line) => line.local !== undefined)
    if (withLocal.length > 0) summary.localAccuracy = withLocal.filter((line) => line.local === actualOf(line)).length / withLocal.length
    const failures = resolved.filter((line) => !actualOf(line))
    if (failures.length > 0) summary.jevFailureRecall = failures.filter((line) => line.jev!.pYes < 0.5).length / failures.length

    if (resolved.length < MIN_RESOLVED) {
      summary.why = `${resolved.length}/${MIN_RESOLVED} outcomes — too few to trust`
    } else if (failures.length === 0) {
      summary.why = 'no failures seen yet, so nothing shows Jev can catch one'
    } else if (summary.localAccuracy !== undefined && summary.jevAccuracy < summary.localAccuracy + MIN_MARGIN) {
      summary.why = `Jev ${pct(summary.jevAccuracy)} does not beat elia's own ${pct(summary.localAccuracy)} by ${pct(MIN_MARGIN)}`
    } else if (summary.brier >= 0.25) {
      summary.why = `Brier ${summary.brier.toFixed(3)} is no better than a coin`
    } else {
      summary.promoted = true
      summary.why = summary.localAccuracy !== undefined
        ? `Jev ${pct(summary.jevAccuracy)} vs elia ${pct(summary.localAccuracy)} over ${resolved.length}`
        : `Jev ${pct(summary.jevAccuracy)} over ${resolved.length}, Brier ${summary.brier.toFixed(3)}`
    }
    return summary
  })
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`
}

export function renderSummary(summaries: KindSummary[]): string {
  const header = `Jev (System One) — ${jevEnabled() ? `on, mode ${jevMode()}` : 'off (set ELIA_JEV_API_KEY to enable)'}`
  const rows = summaries.map((s) => {
    const stats = [
      `${s.answered} answered`,
      s.errors > 0 ? `${s.errors} failed` : undefined,
      `${s.resolved} scored`,
      s.jevAccuracy !== undefined ? `Jev ${pct(s.jevAccuracy)}` : undefined,
      s.localAccuracy !== undefined ? `elia ${pct(s.localAccuracy)}` : undefined,
      s.jevFailureRecall !== undefined ? `catches ${pct(s.jevFailureRecall)} of failures` : undefined,
      s.meanLatencyMs !== undefined ? `${s.meanLatencyMs}ms` : undefined,
    ].filter(Boolean).join(' · ')
    return `  ${s.promoted ? '✓' : '·'} ${s.kind.padEnd(14)} ${stats}\n      ${s.promoted ? 'promoted' : 'shadow'} — ${s.why}`
  })
  return [header, ...rows].join('\n')
}
