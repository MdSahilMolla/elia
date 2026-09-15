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

/** One run receipt and why it did or did not become distillable material. */
export interface TraceSupplyRow {
  runId: string
  accepted: boolean
  /** The filter stages this run failed, in the order they are applied. */
  rejectedBy: string[]
}

/**
 * Why Loop 2 has the corpus it has.
 *
 * `elia distill` used to say only "Only N distillable trace(s) … Nothing to do",
 * which reads identically whether the pipeline is starved because autonomous runs
 * keep failing or because the filter is broken. Those need opposite responses, so
 * the breakdown is worth surfacing: a wall of `completion=failed` means go fix the
 * agent, while a wall of `reward=—` next to a populated trajectory log means the
 * runId/corr join has come apart.
 *
 * Deliberately a separate read rather than a by-product of
 * `collectDistillableTraces`: the hot path should not pay to describe its own
 * rejections.
 */

/**
 * A run with no receipt died before it could write one. "Run never finished" is
 * true but useless — it names no phase, no action, no error, and every such run
 * looks identical in the report. The journal it left behind holds all of that,
 * so read where it actually stopped: the phase it was in, what it last did, and
 * how long it had been running. Nine of the first twenty-three runs landed here,
 * and diagnosing them meant reading these same two files by hand.
 */
function describeUnfinishedRun(dir: string): string {
  const events = readNdjson(join(dir, 'events.ndjson'))
  const actions = readNdjson(join(dir, 'actions.ndjson'))
  if (events.length === 0) return 'no receipt (run never finished, and left no journal)'

  const startedAt = typeof events[0]?.at === 'number' ? (events[0].at as number) : undefined
  // The journal does not mark every phase, so the last action can be newer than
  // the last event — take whichever the run truly reached last.
  const lastEventAt = typeof events[events.length - 1]?.at === 'number' ? (events[events.length - 1]!.at as number) : 0
  const lastAction = actions[actions.length - 1]
  const lastActionAt = typeof lastAction?.at === 'number' ? (lastAction.at as number) : 0
  const endedAt = Math.max(lastEventAt, lastActionAt)

  const lastPhase = [...events].reverse().find((event) => event.kind === 'phase')?.data as { phase?: string; activity?: string } | undefined
  const phase = lastPhase?.phase ? `${lastPhase.phase} phase${lastPhase.activity ? `, ${lastPhase.activity}` : ''}` : undefined
  const ran = startedAt !== undefined && endedAt > startedAt ? `${Math.round((endedAt - startedAt) / 1000)}s in` : 'immediately'

  let where: string
  if (lastAction && lastActionAt >= lastEventAt) {
    const actor = typeof lastAction.actor === 'string' ? lastAction.actor : 'an agent'
    const tool = typeof lastAction.tool === 'string' ? lastAction.tool : 'a tool'
    where = `${actor} had just run ${tool}${lastAction.isError === true ? ', which failed' : ''}`
  } else {
    const kind = typeof events[events.length - 1]?.kind === 'string' ? (events[events.length - 1]!.kind as string) : 'an event'
    where = `its last journal entry was ${kind}`
  }
  return `no receipt (died ${ran}${phase ? `, during the ${phase}` : ''}; ${where})`
}

function readNdjson(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return []
  const rows: Record<string, unknown>[] = []
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        rows.push(JSON.parse(line) as Record<string, unknown>)
      } catch {
        // A run killed mid-write leaves a torn last line; the rest still counts.
      }
    }
  } catch {
    return rows
  }
  return rows
}

export function diagnoseTraceSupply(cwd = process.cwd()): TraceSupplyRow[] {
  const runsDir = join(cwd, '.elia', 'runs')
  if (!existsSync(runsDir)) return []

  const rewardByCorr = new Map<string, number>()
  try {
    for (const row of readTrajectories('autonomous')) rewardByCorr.set(row.corr, row.reward.scalar)
  } catch {
    // no trajectory data yet
  }

  const rows: TraceSupplyRow[] = []
  for (const entry of readdirSync(runsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const receiptPath = join(runsDir, entry.name, 'receipt.json')
    if (!existsSync(receiptPath)) {
      rows.push({ runId: entry.name, accepted: false, rejectedBy: [describeUnfinishedRun(join(runsDir, entry.name))] })
      continue
    }
    let receipt: RawReceipt
    try {
      receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as RawReceipt
    } catch {
      rows.push({ runId: entry.name, accepted: false, rejectedBy: ['unreadable receipt'] })
      continue
    }

    const rejectedBy: string[] = []
    if (receipt.outcome !== 'completed') rejectedBy.push(`outcome=${receipt.outcome ?? 'unknown'}`)
    if (receipt.completion?.state !== 'verified') rejectedBy.push(`completion=${receipt.completion?.state ?? 'unknown'}`)
    if (receipt.verdict?.verdict === 'revise') rejectedBy.push('review verdict=revise')
    const verifyRecords = Array.isArray(receipt.verification) ? receipt.verification : []
    const verifyPassed = verifyRecords.some((r) => r && typeof r === 'object' && (r as { passed?: boolean }).passed === true)
    if (verifyRecords.length > 0 && !verifyPassed) rejectedBy.push(`verification ran ${verifyRecords.length}× and never passed`)

    const steps = (receipt.proposal?.steps ?? []).filter((step): step is { role: string; files?: string[] } => typeof step.role === 'string')
    const regime = classifyRegime(steps.flatMap((s) => s.files ?? []), receipt.proposal?.verification ?? [], cwd)
    if (regime === 'judgment') rejectedBy.push('regime=judgment (nothing outside the model’s own opinion checked it)')

    const reward = rewardByCorr.get(receipt.runId ?? entry.name)
    if (reward !== undefined && reward < MIN_REWARD) rejectedBy.push(`reward=${reward.toFixed(2)} (below ${MIN_REWARD})`)

    rows.push({ runId: entry.name, accepted: rejectedBy.length === 0, rejectedBy })
  }
  return rows.sort((a, b) => a.runId.localeCompare(b.runId))
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
