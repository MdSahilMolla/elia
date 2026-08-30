import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { appendSecureFile, ensureSecureDirectory } from '../securePersistence.ts'
import type { CompletionAssessment } from './outcome.ts'

/**
 * "Is the completion assessor honest?" — measured, not assumed.
 *
 * A model saying "done" is already not trusted; the assessor downgrades a run to
 * needs-attention when the durable graph can't prove completion. But nothing
 * checked whether the assessor's *own* verdicts hold up: does a "verified /
 * high" run ever ship with unresolved actions or a failed verification hiding
 * behind it? This records every finished run's verdict alongside the objective
 * facts and flags the contradictions, so the rate is visible and drifts are
 * catchable instead of invisible.
 */

export interface CompletionFacts {
  verificationPassed: boolean
  reviewPassed: boolean
  completedSteps: number
  totalSteps: number
  unresolvedActions: number
  pendingApprovals: number
  blockedByBudget: number
}

export interface CalibrationEntry {
  at: string
  runId: string
  reportedState: CompletionAssessment['state']
  confidence: CompletionAssessment['confidence']
  facts: CompletionFacts
  /** Deterministic inconsistencies between the verdict and the facts. Empty is good. */
  contradictions: string[]
}

/**
 * Deterministic checks for a verdict that claims more than the facts support.
 * These are hard contradictions (the assessor said X, the recorded state says
 * not-X), not judgement calls.
 */
export function detectContradictions(state: CompletionAssessment['state'], confidence: CompletionAssessment['confidence'], facts: CompletionFacts): string[] {
  const out: string[] = []

  if (state === 'verified') {
    if (!facts.verificationPassed) out.push('reported verified but verification did not pass')
    if (!facts.reviewPassed) out.push('reported verified but structured review did not pass')
    if (facts.totalSteps > 0 && facts.completedSteps < facts.totalSteps) out.push(`reported verified with ${facts.completedSteps}/${facts.totalSteps} steps complete`)
    if (facts.unresolvedActions > 0) out.push(`reported verified with ${facts.unresolvedActions} unresolved durable action(s)`)
    if (facts.pendingApprovals > 0) out.push(`reported verified with ${facts.pendingApprovals} pending approval(s)`)
    if (facts.blockedByBudget > 0) out.push('reported verified after the action budget was exhausted')
  }

  if (confidence === 'high' && state !== 'verified') {
    out.push(`high confidence on a non-verified state (${state})`)
  }

  if (state === 'partial' && facts.completedSteps === 0 && !facts.verificationPassed && !facts.reviewPassed) {
    out.push('reported partial progress with no completed step, verification, or review')
  }

  return out
}

function logPath(cwd = process.cwd()): string {
  return join(cwd, '.elia', 'runs', 'completion-calibration.ndjson')
}

export function recordCompletion(runId: string, completion: CompletionAssessment, facts: CompletionFacts, cwd = process.cwd()): void {
  const entry: CalibrationEntry = {
    at: new Date().toISOString(),
    runId,
    reportedState: completion.state,
    confidence: completion.confidence,
    facts,
    contradictions: detectContradictions(completion.state, completion.confidence, facts),
  }
  try {
    ensureSecureDirectory(join(cwd, '.elia', 'runs'))
    appendSecureFile(logPath(cwd), `${JSON.stringify(entry)}\n`)
  } catch {
    // Calibration logging must never break a run's own completion path.
  }
}

export function readCalibrationLog(cwd = process.cwd()): CalibrationEntry[] {
  const path = logPath(cwd)
  if (!existsSync(path)) return []
  const entries: CalibrationEntry[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      entries.push(JSON.parse(trimmed) as CalibrationEntry)
    } catch {
      // Skip a corrupt line rather than failing the whole report.
    }
  }
  return entries
}

export interface CalibrationSummary {
  total: number
  contradicting: number
  byState: Record<string, { count: number; contradicting: number }>
}

export function summarizeCalibration(entries: CalibrationEntry[]): CalibrationSummary {
  const byState: CalibrationSummary['byState'] = {}
  let contradicting = 0
  for (const entry of entries) {
    const key = `${entry.reportedState}/${entry.confidence}`
    byState[key] ??= { count: 0, contradicting: 0 }
    byState[key].count += 1
    if (entry.contradictions.length > 0) {
      byState[key].contradicting += 1
      contradicting += 1
    }
  }
  return { total: entries.length, contradicting, byState }
}

/** One line for `elia runs`, or empty when there's nothing logged yet. */
export function renderCalibrationLine(cwd = process.cwd()): string {
  const summary = summarizeCalibration(readCalibrationLog(cwd))
  if (summary.total === 0) return ''
  const rate = summary.total > 0 ? Math.round((summary.contradicting / summary.total) * 100) : 0
  return `Completion calibration: ${summary.total} run(s) logged, ${summary.contradicting} with a verdict/facts contradiction (${rate}%).`
}
