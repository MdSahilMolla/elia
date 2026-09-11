import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { classifyRegime, type VerificationRegime } from '../autonomy/detectChecks.ts'
import type { RoleName } from '../autonomy/types.ts'
import { readTrajectories } from '../trajectory/record.ts'

/**
 * The raw material for Loop 2: autonomous runs that genuinely succeeded.
 *
 * "Genuinely" is doing a lot of work here. A trace only enters the corpus if the
 * run reached a verified completion, verification and review both passed, and
 * the verification was mechanical or empirical — never `judgment`. Distilling a
 * habit from a run that only self-critique blessed is how a system trains itself
 * to repeat its own untested guesses.
 *
 * The run receipt gives the structure (which role did what); the trajectory row
 * (joined on `corr`) gives the graded outcome. A run that reached "verified" but
 * only after several repair passes is not a clean pattern to hold up as an
 * example, so its reward is low and it is filtered out.
 */

/** Trajectory reward below this is not a clean example, even if the run verified. */
const MIN_REWARD = 0.7

export interface DistillableTrace {
  runId: string
  goal: string
  regime: VerificationRegime
  /** Roles that did the work, with the files they touched. */
  steps: { role: RoleName; title: string; files: string[] }[]
  verification: string[]
  lessons: string[]
  failedActions: number
  at: number
  /** Graded outcome from the trajectory log, when a matching row exists (0..1). */
  reward?: number
}

interface RawReceipt {
  runId?: string
  goal?: string
  outcome?: string
  completion?: { state?: string }
  proposal?: { steps?: { role?: string; title?: string; files?: string[] }[]; verification?: string[] }
  verdict?: { verdict?: string }
  lessons?: string[]
  actions?: { failed?: number }
  completedAt?: number
  verification?: unknown[]
}

export function collectDistillableTraces(cwd = process.cwd()): DistillableTrace[] {
  const runsDir = join(cwd, '.elia', 'runs')
  if (!existsSync(runsDir)) return []

  // corr -> reward scalar, from the trajectory log (best-effort; empty on older projects).
  const rewardByCorr = new Map<string, number>()
  try {
    for (const row of readTrajectories('autonomous')) rewardByCorr.set(row.corr, row.reward.scalar)
  } catch {
    // no trajectory data yet
  }

  const traces: DistillableTrace[] = []
  for (const entry of readdirSync(runsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const receiptPath = join(runsDir, entry.name, 'receipt.json')
    if (!existsSync(receiptPath)) continue
    let receipt: RawReceipt
    try {
      receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as RawReceipt
    } catch {
      continue
    }

    if (receipt.outcome !== 'completed') continue
    if (receipt.completion?.state !== 'verified') continue
    // The review gate: a verdict must exist and must not be a "revise".
    if (receipt.verdict && receipt.verdict.verdict === 'revise') continue
    // Verification must have actually run and passed at least once.
    const verifyRecords = Array.isArray(receipt.verification) ? receipt.verification : []
    const verifyPassed = verifyRecords.some((r) => r && typeof r === 'object' && (r as { passed?: boolean }).passed === true)
    if (verifyRecords.length > 0 && !verifyPassed) continue

    const steps = (receipt.proposal?.steps ?? [])
      .filter((step): step is { role: string; title?: string; files?: string[] } => typeof step.role === 'string')
      .map((step) => ({ role: step.role as RoleName, title: step.title ?? '', files: step.files ?? [] }))

    const verification = receipt.proposal?.verification ?? []
    const regime = classifyRegime(steps.flatMap((s) => s.files), verification, cwd)
    if (regime === 'judgment') continue

    const runId = receipt.runId ?? entry.name
    const reward = rewardByCorr.get(runId)
    // A graded run that scored poorly is not a clean example — skip it. A run
    // with no trajectory row (predates the feature) is kept on the receipt
    // evidence alone.
    if (reward !== undefined && reward < MIN_REWARD) continue

    traces.push({
      runId,
      goal: receipt.goal ?? '(unknown goal)',
      regime,
      steps,
      verification,
      lessons: Array.isArray(receipt.lessons) ? receipt.lessons.filter((l): l is string => typeof l === 'string') : [],
      failedActions: receipt.actions?.failed ?? 0,
      at: receipt.completedAt ?? 0,
      reward,
    })
  }

  return traces.sort((a, b) => b.at - a.at)
}

/** Groups traces by the role that did most of the work — the unit a fragment is distilled for. */
export function clusterByDominantRole(traces: DistillableTrace[]): Map<RoleName, DistillableTrace[]> {
  const clusters = new Map<RoleName, DistillableTrace[]>()
  for (const trace of traces) {
    const counts = new Map<RoleName, number>()
    for (const step of trace.steps) counts.set(step.role, (counts.get(step.role) ?? 0) + 1)
    const dominant = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
    if (!dominant) continue
    const list = clusters.get(dominant) ?? []
    list.push(trace)
    clusters.set(dominant, list)
  }
  return clusters
}
