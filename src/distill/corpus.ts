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

/**
 * Above this miss rate (with enough samples to trust the ratio), a run of join
 * misses stops looking like the ordinary "predates this feature" case and
 * starts looking like `runId`/`corr` actually diverging somewhere — see the
 * module doc above. Deliberately coarse: this is a smoke alarm, not a metric.
 */
const JOIN_MISS_WARN_RATE = 0.3
const JOIN_MISS_MIN_SAMPLE = 5

export function collectDistillableTraces(cwd = process.cwd()): DistillableTrace[] {
  const runsDir = join(cwd, '.elia', 'runs')
  if (!existsSync(runsDir)) return []

  // corr -> reward scalar, from the trajectory log (best-effort; empty on older projects).
  const rewardByCorr = new Map<string, number>()
  let hasTrajectoryData = false
  try {
    for (const row of readTrajectories('autonomous')) rewardByCorr.set(row.corr, row.reward.scalar)
    hasTrajectoryData = rewardByCorr.size > 0
  } catch {
    // no trajectory data yet
  }

  // Visibility into the runId/corr join below: `receipt.runId ?? entry.name` is
  // only correct today by convention (nothing enforces `runId` and the
  // trajectory log's `corr` share an id space). A miss is silently treated as
  // "predates this feature" and kept — reasonable as a default, but if misses
  // are actually a broken join rather than old data, that should be visible
  // instead of invisible. Counted only when trajectory data exists at all;
  // with none, every lookup "misses" for the ordinary predates-the-feature
  // reason and counting would just be noise.
  let joinAttempts = 0
  let joinMisses = 0

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
    if (hasTrajectoryData) {
      joinAttempts += 1
      if (reward === undefined) joinMisses += 1
    }
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

  if (joinAttempts >= JOIN_MISS_MIN_SAMPLE) {
    const missRate = joinMisses / joinAttempts
    if (missRate > JOIN_MISS_WARN_RATE) {
      console.warn(
        `[distill/corpus] ${joinMisses}/${joinAttempts} run receipts (${Math.round(missRate * 100)}%) had no matching trajectory row for their runId. ` +
          `Trajectory data exists for this project, so this is likely a broken runId/corr join (see the module doc in src/distill/corpus.ts) rather than runs that predate the trajectory feature — check that src/autonomy/loop.ts and the interactive path record trajectories under the same id as the run receipt's runId.`,
      )
    }
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
