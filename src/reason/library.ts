import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { wilson } from '../compounding/stats.ts'
import { withFileLock } from '../fileLock.ts'
import { writeSecureFile } from '../securePersistence.ts'
import { stateDir } from '../statePaths.ts'

/**
 * Where the search's results are kept, so the next task of the same shape
 * starts from what the last one cost to learn.
 *
 * This is the half that compounds. `solve()` on its own is a better answer, paid
 * for once and thrown away; the library is what makes the second task of a shape
 * cheaper than the first — elia stops re-deriving that repair work wants a wide
 * first round against the project's tests, or that a single-file refactor almost
 * never needs a second round.
 *
 * Two rules keep it from becoming another confident-but-vacuous gate, which is
 * the trap every previous self-improvement surface in this codebase fell into:
 *
 * 1. A harness is never preferred on a single observation. `MIN_OBSERVATIONS`
 *    has to be met before a record can beat the default at all, and until then
 *    the library is explicitly exploring rather than quietly guessing.
 * 2. Records are ranked by the *lower bound* of their success rate, not the
 *    mean. Three-for-three is a worse bet than nineteen-for-twenty, and a mean
 *    cannot see that. This is the same correction the evolve suite just made
 *    when it started scoring each task over repeated runs so noise is not a
 *    verdict; the reasoning layer should not have to learn it separately.
 * 3. Exploration stops only on evidence. A harness keeps its occasional turn
 *    for as long as its upper bound says it could still beat the leader, and
 *    loses it once the data rules that out — a bandit that eliminates arms by
 *    confidence rather than by the order they happened to be tried in.
 */

export interface HarnessOutcome {
  signature: string
  harnessId: string
  /** Did the chosen answer pass a check that ran its behaviour? The only success that counts. */
  verified: boolean
  attemptsUsed: number
  cost: number
  elapsedMs: number
  /** Epoch millis, so a stale record can be aged out when a harness changes meaning. */
  at: number
}

export interface HarnessRecord {
  signature: string
  harnessId: string
  runs: number
  verifiedRuns: number
  /** Mean attempts and cost, kept as running totals so a record stays O(1) to update. */
  totalAttempts: number
  totalCost: number
  totalElapsedMs: number
  lastAt: number
}

export interface Library {
  version: 1
  records: HarnessRecord[]
}

/** Below this, a record has not earned the right to displace the default. */
export const MIN_OBSERVATIONS = 5

/**
 * Runs after which a challenger is no longer explored even if its interval
 * still overlaps the leader's. By then the two are within noise of each other,
 * and the tie-break on attempts is the better judge of which to spend on.
 */
export const EXPLORATION_CAP = 30

const EMPTY: Library = { version: 1, records: [] }

export function libraryPath(dir = join(stateDir, 'reason')): string {
  return join(dir, 'library.json')
}

export function readLibrary(path = libraryPath()): Library {
  if (!existsSync(path)) return { ...EMPTY, records: [] }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Library
    if (parsed.version !== 1 || !Array.isArray(parsed.records)) return { ...EMPTY, records: [] }
    return parsed
  } catch {
    // A truncated library is a cache, not a source of truth: losing it costs
    // some exploration and nothing else, so it is never worth failing a turn.
    return { ...EMPTY, records: [] }
  }
}

/**
 * Fold one outcome in.
 *
 * Several elia processes share a checkout here, and two of them finishing a task
 * at once would otherwise read-modify-write over each other and silently drop an
 * observation — the same class of bug that has already put a sibling's commit
 * into a push from this repo. The whole read-update-write runs under the file
 * lock for that reason.
 */
export function recordOutcome(outcome: HarnessOutcome, path = libraryPath()): Library {
  return withFileLock(`${path}.lock`, () => {
    const library = readLibrary(path)
    const existing = library.records.find((record) => record.signature === outcome.signature && record.harnessId === outcome.harnessId)
    const record: HarnessRecord = existing ?? {
      signature: outcome.signature,
      harnessId: outcome.harnessId,
      runs: 0,
      verifiedRuns: 0,
      totalAttempts: 0,
      totalCost: 0,
      totalElapsedMs: 0,
      lastAt: 0,
    }
    record.runs += 1
    record.verifiedRuns += outcome.verified ? 1 : 0
    record.totalAttempts += outcome.attemptsUsed
    record.totalCost += outcome.cost
    record.totalElapsedMs += outcome.elapsedMs
    record.lastAt = outcome.at
    if (!existing) library.records.push(record)
    writeSecureFile(path, JSON.stringify(library, null, 2))
    return library
  })
}

/**
 * The lower end of where this record's true success rate plausibly sits
 * (Wilson, 95%).
 *
 * The point of the lower bound rather than the mean is that it prices
 * uncertainty as a cost. A harness that has gone 3-for-3 scores below one that
 * has gone 19-for-20, which is the right way round and which a mean gets exactly
 * backwards — and it is why a promising new harness has to keep earning its
 * place instead of being crowned by its first lucky run.
 */
export function successLowerBound(record: Pick<HarnessRecord, 'runs' | 'verifiedRuns'>): number {
  return wilson(record.verifiedRuns, record.runs).lo
}

/** The upper end of the same interval: how good this record could still turn out to be. */
export function successUpperBound(record: Pick<HarnessRecord, 'runs' | 'verifiedRuns'>): number {
  return wilson(record.verifiedRuns, record.runs).hi
}

/** Mean attempts a record spent, for breaking ties towards the cheaper harness. */
export function meanAttempts(record: HarnessRecord): number {
  return record.runs === 0 ? 0 : record.totalAttempts / record.runs
}

export interface Choice {
  harnessId?: string
  /** Why this one — shown in `elia compounding` so the library's state is legible rather than magic. */
  reason: string
  /** True when the library is deliberately gathering data rather than exploiting what it knows. */
  exploring: boolean
}

/**
 * Which harness to use for a signature.
 *
 * Returns no id — meaning "use the default" — until some record for this
 * signature has cleared `MIN_OBSERVATIONS`. That is the conservative direction
 * on purpose: the cost of exploring a bit too long is some extra attempts, and
 * the cost of exploiting too early is elia confidently locking itself onto a
 * harness that got lucky once and never finding out.
 */
export function chooseHarness(signature: string, candidates: string[], library: Library): Choice {
  const records = library.records.filter((record) => record.signature === signature && candidates.includes(record.harnessId))
  const unobserved = candidates.filter((id) => !records.some((record) => record.harnessId === id))
  const seasoned = records.filter((record) => record.runs >= MIN_OBSERVATIONS)

  if (seasoned.length === 0) {
    const next = unobserved[0] ?? records.sort((a, b) => a.runs - b.runs)[0]?.harnessId
    return {
      harnessId: next,
      reason: `no harness for ${signature} has ${MIN_OBSERVATIONS} runs yet — still measuring`,
      exploring: true,
    }
  }

  const best = [...seasoned].sort((a, b) => {
    const bound = successLowerBound(b) - successLowerBound(a)
    if (Math.abs(bound) > 1e-9) return bound
    return meanAttempts(a) - meanAttempts(b)
  })[0]!

  // One slot in every few goes to a challenger: a harness with no runs, or one
  // whose interval still reaches above the leader's floor. Only the unobserved
  // used to qualify, so a harness with one to four unlucky runs was never tried
  // again once another was seasoned — written off on the order it was tried in,
  // not on evidence. A challenger whose upper bound falls below the leader's
  // lower bound is ruled out and stops costing attempts.
  const floor = successLowerBound(best)
  const challengers = [
    ...unobserved.map((harnessId) => ({ harnessId, runs: 0 })),
    ...records
      .filter((record) => record !== best && record.runs < EXPLORATION_CAP && successUpperBound(record) > floor)
      .sort((a, b) => a.runs - b.runs),
  ]
  const totalRuns = records.reduce((sum, record) => sum + record.runs, 0)
  if (challengers.length > 0 && totalRuns % 4 === 3) {
    const next = challengers[0]!
    return {
      harnessId: next.harnessId,
      reason:
        next.runs === 0
          ? `trying ${next.harnessId} for ${signature}, which has no runs yet`
          : `trying ${next.harnessId} again for ${signature}: ${next.runs} run(s) is too few to rule out beating ${best.harnessId}`,
      exploring: true,
    }
  }

  return {
    harnessId: best.harnessId,
    reason: `${best.harnessId} verified ${best.verifiedRuns}/${best.runs} on ${signature} (lower bound ${(successLowerBound(best) * 100).toFixed(0)}%, ${meanAttempts(best).toFixed(1)} attempts)`,
    exploring: false,
  }
}

/** A short human-readable state of the library, for `elia compounding`. */
export function renderLibrary(library: Library): string {
  if (library.records.length === 0) return 'reasoning library: empty — no searches recorded yet'
  const bySignature = new Map<string, HarnessRecord[]>()
  for (const record of library.records) {
    const existing = bySignature.get(record.signature)
    if (existing) existing.push(record)
    else bySignature.set(record.signature, [record])
  }
  const lines = [...bySignature.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([signature, records]) => {
    const parts = [...records]
      .sort((a, b) => successLowerBound(b) - successLowerBound(a))
      .map((record) => `${record.harnessId} ${record.verifiedRuns}/${record.runs}${record.runs < MIN_OBSERVATIONS ? '*' : ''}`)
    return `  ${signature}: ${parts.join(', ')}`
  })
  return [`reasoning library: ${library.records.length} harness record(s)`, ...lines, '  (* still measuring — fewer than the runs needed to prefer it)'].join('\n')
}
