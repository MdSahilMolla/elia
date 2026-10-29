import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { appendSecureFile, ensureSecureDirectory } from '../securePersistence.ts'
import { paths } from '../statePaths.ts'
import { readCalibrationLog } from './calibration.ts'
import { isDispute } from './disputeNudge.ts'
import type { OutcomeRecord } from './outcomesClosure.ts'
import type { VerifyResult } from './outcomes.ts'

/**
 * Calibration against reality, not against itself.
 *
 * `calibration.ts` checks that a verdict is *consistent* with the run's own
 * facts — a "verified" run with a failed check is a contradiction. That can
 * never catch the failure that matters most: a run that was internally
 * consistent, said "verified / high", and was wrong. Only something that
 * happens *after* the claim can show that.
 *
 * This ledger records each claim's stated confidence next to what later
 * happened to it, from two sources:
 *
 * - `outcome-probe` — a delayed outcome check registered by a run (the file
 *   it promised exists, contains what it should) came back verified or failed.
 *   Strong evidence: it is the world, checked by a machine.
 * - `user-reaction` — the user's next message after an interactive turn
 *   that claimed to be done either disputed it ("that's wrong", "it doesn't
 *   work") or moved on. Weak evidence: silence is not proof, so it is scored
 *   separately and never mixed into the strong-evidence numbers.
 *
 * The score is the gap between stated and observed success per confidence
 * level. A system that says "high" and is right 55% of the time is
 * overconfident, and `reliability.ts` tightens the next run on that basis.
 */

export type GroundTruthSource = 'run' | 'turn'
export type GroundTruthEvidence = 'outcome-probe' | 'user-reaction'

export interface GroundTruthEntry {
  at: string
  /** runId for an autonomous run, the task-session id for an interactive turn. */
  claimId: string
  source: GroundTruthSource
  /** The claim as stated: `verified/high` for a run, `verify:pass` for a turn. */
  claim: string
  /** The success probability the claim implied, 0–1. */
  stated: number
  /** Whether the claim held up. */
  held: boolean
  evidence: GroundTruthEvidence
  /** Short, already-redacted reason (the probe failure, "user disputed"). */
  detail?: string
}

/**
 * What each stated confidence commits to. These are the claims' own words
 * turned into numbers so a gap can be measured; they are not tuned, and the
 * point of the ledger is to show where reality disagrees with them.
 */
const RUN_CONFIDENCE: Record<string, number> = { high: 0.9, medium: 0.65, low: 0.35 }
const TURN_VERIFY: Record<VerifyResult, number> = { pass: 0.85, skipped: 0.6, none: 0.6, fail: 0.2 }

function runsDirFor(cwd?: string): string {
  return cwd ? join(cwd, '.elia', 'runs') : paths.runs
}

function logPath(cwd?: string): string {
  return join(runsDirFor(cwd), 'ground-truth.ndjson')
}

export function recordGroundTruth(entry: Omit<GroundTruthEntry, 'at'>, cwd?: string): void {
  try {
    ensureSecureDirectory(runsDirFor(cwd))
    appendSecureFile(logPath(cwd), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`)
  } catch {
    // Ground-truth logging must never break the path that discovered the truth.
  }
}

export function readGroundTruth(cwd?: string): GroundTruthEntry[] {
  const path = logPath(cwd)
  if (!existsSync(path)) return []
  const entries: GroundTruthEntry[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      entries.push(JSON.parse(line) as GroundTruthEntry)
    } catch {
      // A corrupt line is skipped, not fatal.
    }
  }
  return entries
}

/**
 * Scores checked outcome probes against the confidence their run claimed.
 * Inconclusive and still-pending probes say nothing and are skipped; so is a
 * probe whose run never logged a completion verdict (there is no claim to score).
 */
export function resolveOutcomeProbes(checked: OutcomeRecord[], cwd?: string): number {
  const decided = checked.filter((record) => record.runId && (record.status === 'verified' || record.status === 'failed'))
  if (decided.length === 0) return 0
  const verdicts = new Map(readCalibrationLog(cwd).map((entry) => [entry.runId, entry]))
  let recorded = 0
  for (const record of decided) {
    const verdict = verdicts.get(record.runId!)
    if (!verdict) continue
    recordGroundTruth({
      claimId: record.runId!,
      source: 'run',
      claim: `${verdict.reportedState}/${verdict.confidence}`,
      stated: verdict.reportedState === 'verified' ? RUN_CONFIDENCE[verdict.confidence] ?? 0.5 : 0.2,
      held: record.status === 'verified',
      evidence: 'outcome-probe',
      ...(record.failure ? { detail: record.failure.slice(0, 200) } : {}),
    }, cwd)
    recorded += 1
  }
  return recorded
}

/** The last interactive turn that claimed to be done, waiting for the user's reaction. */
let pendingTurnClaim: { claimId: string; verify: VerifyResult } | undefined

/**
 * Remembers a finished interactive turn as a claim. Only turns that changed
 * something and ended normally are claims; a turn that asked a question or
 * failed outright never said "done".
 */
export function noteTurnClaim(claimId: string, verify: VerifyResult, changedFiles: number, endedNormally: boolean): void {
  pendingTurnClaim = endedNormally && changedFiles > 0 ? { claimId, verify } : undefined
}

/** Scores the pending turn claim against the user's next message. Returns the entry recorded, if any. */
export function resolveTurnClaim(nextUserMessage: string, cwd?: string): GroundTruthEntry | undefined {
  const claim = pendingTurnClaim
  pendingTurnClaim = undefined
  if (!claim || !nextUserMessage.trim()) return undefined
  const disputed = isDispute(nextUserMessage)
  const entry: Omit<GroundTruthEntry, 'at'> = {
    claimId: claim.claimId,
    source: 'turn',
    claim: `verify:${claim.verify}`,
    stated: TURN_VERIFY[claim.verify],
    held: !disputed,
    evidence: 'user-reaction',
    ...(disputed ? { detail: 'user disputed the result' } : {}),
  }
  recordGroundTruth(entry, cwd)
  return { at: new Date().toISOString(), ...entry }
}

/** Test-only. */
export function resetPendingTurnClaimForTests(): void {
  pendingTurnClaim = undefined
}

export interface CalibrationBucket {
  claim: string
  count: number
  /** Mean stated success probability. */
  stated: number
  /** Fraction that actually held. */
  observed: number
}

export interface GroundTruthScore {
  evidence: GroundTruthEvidence
  resolved: number
  held: number
  /** Mean squared error of stated vs actual, 0 (perfect) – 1. */
  brier: number
  buckets: CalibrationBucket[]
  /** Largest stated-minus-observed gap over buckets with enough samples; > 0 means overconfident. */
  worstGap: number
  worstClaim?: string
}

/** Fewer than this many outcomes in a bucket and its rate is noise. */
export const MIN_BUCKET = 4

export function scoreGroundTruth(entries: GroundTruthEntry[], evidence: GroundTruthEvidence): GroundTruthScore {
  const scoped = entries.filter((entry) => entry.evidence === evidence)
  const groups = new Map<string, GroundTruthEntry[]>()
  for (const entry of scoped) groups.set(entry.claim, [...(groups.get(entry.claim) ?? []), entry])
  const buckets: CalibrationBucket[] = [...groups.entries()].map(([claim, group]) => ({
    claim,
    count: group.length,
    stated: group.reduce((sum, entry) => sum + entry.stated, 0) / group.length,
    observed: group.filter((entry) => entry.held).length / group.length,
  })).sort((a, b) => b.count - a.count)
  let worstGap = 0
  let worstClaim: string | undefined
  for (const bucket of buckets) {
    if (bucket.count < MIN_BUCKET) continue
    const gap = bucket.stated - bucket.observed
    if (gap > worstGap) {
      worstGap = gap
      worstClaim = bucket.claim
    }
  }
  const brier = scoped.length === 0 ? 0 : scoped.reduce((sum, entry) => sum + (entry.stated - (entry.held ? 1 : 0)) ** 2, 0) / scoped.length
  return {
    evidence,
    resolved: scoped.length,
    held: scoped.filter((entry) => entry.held).length,
    brier,
    buckets,
    worstGap,
    ...(worstClaim ? { worstClaim } : {}),
  }
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`
}

/** Lines for `elia runs`: one per evidence source that has anything to say. */
export function renderGroundTruthLines(cwd?: string): string[] {
  const entries = readGroundTruth(cwd)
  const lines: string[] = []
  for (const evidence of ['outcome-probe', 'user-reaction'] as const) {
    const score = scoreGroundTruth(entries, evidence)
    if (score.resolved === 0) continue
    const label = evidence === 'outcome-probe' ? 'Ground truth (outcome probes)' : 'Ground truth (user reaction, weak)'
    const buckets = score.buckets.slice(0, 4).map((bucket) => `${bucket.claim} said ${pct(bucket.stated)}, held ${pct(bucket.observed)} (n=${bucket.count})`).join('; ')
    const gap = score.worstClaim ? ` Overconfident on ${score.worstClaim} by ${pct(score.worstGap)}.` : ''
    lines.push(`${label}: ${score.held}/${score.resolved} claims held, Brier ${score.brier.toFixed(2)}. ${buckets}.${gap}`)
  }
  return lines
}
