import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { wilson } from '../compounding/stats.ts'
import { withFileLock } from '../fileLock.ts'
import { ensureSecureDirectory, writeSecureFile } from '../securePersistence.ts'
import { paths } from '../statePaths.ts'
import type { Priors } from '../world/runtime.ts'
import { MIN_OBSERVATIONS, EXPLORATION_CAP, chooseHarness, type Choice, type HarnessRecord, type Library } from './library.ts'

/**
 * Reasoning about how to reason, with a model of the world under it.
 *
 * `chooseHarness` (library.ts) is a bandit over search shapes, one independent
 * cell per task signature. It is honest — it ranks by a lower bound and will not
 * prefer anything on a handful of runs — and it is slow and blind in four ways
 * that a model of the world fixes:
 *
 *   1. Every cell learns alone. `repair/checked/single` and `repair/checked/multi`
 *      are the same kind of work, and what one learned about `wide` says a great
 *      deal about the other, but no evidence crosses the boundary, so each needs
 *      its own five runs before the library will prefer anything. Here a cell's
 *      estimate is shrunk toward its siblings' and theirs toward everything the
 *      harness has done (partial pooling), and the uncertainty that remains is
 *      priced exactly as before.
 *   2. It breaks ties on attempts, and attempts are not tokens. Verification comes
 *      first, always: a search that is cheaper because it verifies less has not
 *      saved anything (the first version of this planner minimised tokens per
 *      verified fix, and the simulation in metaSim.ts showed it winning that
 *      metric by giving up 18 points of verification). So the planner takes the
 *      best lower bound, then the *cheapest in tokens* of every harness within a
 *      stated tolerance of it (`ELIA_META_TOLERANCE`, five points by default): a
 *      cost saving is taken only where the record cannot tell the harnesses apart.
 *   3. It records how many attempts a run spent and not which one paid off, so a
 *      harness's budget can never be learned. `attemptCap` reads where the
 *      successes fall, and stops paying for the tail only when the record says
 *      there is nothing in it.
 *   4. Nothing about the project reaches the choice. The runtime world model
 *      (world/runtime.ts) measures what checks cost here, whether they answer the
 *      same way twice, how familiar the project is and how steady the agent's
 *      picture of it has been; those become flags, and a flag changes a
 *      prediction only after the library has seen it change outcomes.
 *
 * It keeps the axiom `uncertainty-is-priced`: choices rank by a lower bound, and
 * nothing overrides the default without evidence — where there is not enough, this
 * defers to `chooseHarness` unchanged. And it scores itself the way the world
 * model does: each plan commits to a predicted verification rate before the
 * search and is compared, on the same runs, with what the old independent-cell
 * estimate would have said, so "better" is a measured number that accumulates
 * (`recordMeta`), not a claim.
 *
 * Immutable to the loop (sandbox.ts): a planner a candidate could edit could
 * grade itself.
 */

export const WORLD_FLAGS = ['slow', 'flaky', 'cold', 'unsteady'] as const
export type WorldFlag = (typeof WORLD_FLAGS)[number]

/** A test command that takes this long makes every extra attempt expensive in the time a person waits. */
export const SLOW_CHECK_MS = 60_000
/** A check that answers differently this often against an unchanged tree is not a reliable judge. */
export const FLAKY_RATE = 0.15
/** Modelled actions below which a project is new to the world model. */
export const COLD_UNDER = 30
/** Stale-picture warnings and repeated failing re-runs per modelled action, past which the agent has not had a steady picture. */
export const UNSTEADY_RATE = 0.03

export interface WorldContext {
  flags: Record<WorldFlag, boolean>
  /** Mean milliseconds one run of the project's tests takes, when measured. */
  checkMs?: number
  /** How often the tests answered differently against an unchanged tree, when measured. */
  flipRate?: number
  /** Actions the world model has predicted and scored in this project. */
  modelled: number
}

const noFlags = (): Record<WorldFlag, boolean> => ({ slow: false, flaky: false, cold: true, unsteady: false })

/** What the runtime world model has measured about this project, as the planner's flags. */
export function worldContext(priors: Priors | undefined): WorldContext {
  if (!priors) return { flags: noFlags(), modelled: 0 }
  const modelled = priors.calibration.n
  const measured = ['run_command:test', 'run_command:typecheck', 'run_command:build']
    .map((key) => priors.keys[key])
    .find((count) => count && count.ok + count.fail >= 3 && count.ms)
  const checkMs = measured ? measured.ms! / (measured.ok + measured.fail) : undefined
  const test = priors.keys['run_command:test']
  const flipRate = test && (test.repeats ?? 0) >= 4 ? (test.flips ?? 0) / test.repeats! : undefined
  const noisy = (priors.notes.streak + priors.notes.repeat) / Math.max(1, modelled)
  return {
    flags: {
      slow: checkMs !== undefined && checkMs >= SLOW_CHECK_MS,
      flaky: flipRate !== undefined && flipRate >= FLAKY_RATE,
      cold: modelled < COLD_UNDER,
      unsteady: modelled >= COLD_UNDER && noisy >= UNSTEADY_RATE,
    },
    ...(checkMs === undefined ? {} : { checkMs }),
    ...(flipRate === undefined ? {} : { flipRate }),
    modelled,
  }
}

// --- The estimate -----------------------------------------------------------

/** Pseudo-observations each level of the hierarchy contributes to the one below. */
export const KAPPA_CLASS = 4
export const KAPPA_CELL = 4
/** One-sided 90%: the lower bound a choice is ranked by. */
const Z_BOUND = 1.28

export interface HarnessRef {
  id: string
  /** The ceiling this shape of search allows, which is also what a harness with no history is assumed to use half of. */
  maxAttempts: number
  /** A harness whose attempts include all of this one's, and which therefore verifies at least as often (harness.ts). */
  subsetOf?: string
}

export interface Estimate {
  harnessId: string
  /** Posterior mean of the chance this harness verifies, after pooling and the world flags. */
  pVerify: number
  lo: number
  hi: number
  /** Expected attempts per run. */
  attempts: number
  /** Expected tokens per run. */
  cost: number
  /** Tokens per verified fix at the estimated rate, for saying what a verified answer costs. */
  perFix: number
  /** Runs of this harness in this cell. */
  direct: number
  /** Runs it has in this cell and in its siblings in the class: what the estimate stands on. */
  related: number
  /** The independent-cell estimate the library alone would give, for scoring the pooling. */
  independent: number
  /** Flags that moved this estimate, with the log-odds shift each applied. */
  shifts: Array<{ flag: WorldFlag; logit: number }>
}

const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value))
const logit = (p: number) => Math.log(clamp(p, 1e-6, 1 - 1e-6) / (1 - clamp(p, 1e-6, 1 - 1e-6)))
const expit = (x: number) => 1 / (1 + Math.exp(-x))

/** `TaskClass` out of `repair/checked/single` or `stalled-repair/checked/single`. */
export function classOf(signature: string): string {
  return signature.replace(/^stalled-/, '').split('/')[0] ?? signature
}

interface Sums {
  runs: number
  verified: number
  attempts: number
  cost: number
}

function sum(records: readonly HarnessRecord[]): Sums {
  return records.reduce(
    (total, record) => ({ runs: total.runs + record.runs, verified: total.verified + record.verifiedRuns, attempts: total.attempts + record.totalAttempts, cost: total.cost + record.totalCost }),
    { runs: 0, verified: 0, attempts: 0, cost: 0 },
  )
}

/** A rate shrunk toward its parent by `kappa` pseudo-observations. */
const shrink = (successes: number, trials: number, parent: number, kappa: number) => (successes + kappa * parent) / (trials + kappa)

/** The world's flags, as the log-odds shift each has been seen to cause in this harness — only where the record is decisive. */
export function flagShifts(harnessId: string, library: Library, context: WorldContext | undefined): Array<{ flag: WorldFlag; logit: number }> {
  if (!context) return []
  const shifts: Array<{ flag: WorldFlag; logit: number }> = []
  for (const flag of WORLD_FLAGS) {
    const cell = library.flags?.[harnessId]?.[flag]
    if (!cell || cell.on.runs < 8 || cell.off.runs < 8) continue
    const rate = (side: { runs: number; verified: number }) => (side.verified + 0.5) / (side.runs + 1)
    const delta = logit(rate(cell.on)) - logit(rate(cell.off))
    const se = Math.sqrt(1 / (cell.on.verified + 0.5) + 1 / (cell.on.runs - cell.on.verified + 0.5) + 1 / (cell.off.verified + 0.5) + 1 / (cell.off.runs - cell.off.verified + 0.5))
    if (Math.abs(delta) < 2 * se) continue
    // The cell's own rate already averages over the contexts it was measured in, so
    // the shift is relative to how often the flag is true, not to the flag being off.
    const prevalence = cell.on.runs / (cell.on.runs + cell.off.runs)
    const shift = clamp(delta, -1.5, 1.5) * ((context.flags[flag] ? 1 : 0) - prevalence)
    if (Math.abs(shift) > 1e-9) shifts.push({ flag, logit: shift })
  }
  return shifts
}

export function estimate(input: { signature: string; harness: HarnessRef; library: Library; context?: WorldContext }): Estimate {
  const { signature, harness, library } = input
  const klass = classOf(signature)
  const mine = library.records.filter((record) => record.harnessId === harness.id)
  const cell = sum(mine.filter((record) => record.signature === signature))
  const siblings = sum(mine.filter((record) => record.signature !== signature && classOf(record.signature) === klass))
  const elsewhere = sum(mine.filter((record) => classOf(record.signature) !== klass))

  const pGlobal = (elsewhere.verified + 1) / (elsewhere.runs + 2)
  const pClass = shrink(siblings.verified, siblings.runs, pGlobal, KAPPA_CLASS)
  let pCell = shrink(cell.verified, cell.runs, pClass, KAPPA_CELL)
  const strength = cell.runs + KAPPA_CELL

  // What the world is like now, against what it was like when the record was made.
  const shifts = flagShifts(harness.id, library, input.context)
  const shift = shifts.reduce((total, entry) => total + entry.logit, 0)
  if (shift !== 0) pCell = expit(logit(pCell) + shift)

  const spread = Z_BOUND * Math.sqrt((pCell * (1 - pCell)) / (strength + 1))
  const lo = clamp(pCell - spread, 0, 1)
  const hi = clamp(pCell + spread, 0, 1)

  // Attempts per run, shrunk the same way from a prior of half the ceiling, and tokens per attempt from what any harness has spent.
  const priorAttempts = (1 + harness.maxAttempts) / 2
  const aGlobal = (elsewhere.attempts + 2 * priorAttempts) / (elsewhere.runs + 2)
  const aClass = (siblings.attempts + KAPPA_CLASS * aGlobal) / (siblings.runs + KAPPA_CLASS)
  const attempts = (cell.attempts + KAPPA_CELL * aClass) / (cell.runs + KAPPA_CELL)

  const all = sum(library.records)
  const priorCost = all.attempts > 0 ? all.cost / all.attempts : 1
  const cGlobal = (elsewhere.cost + 3 * priorCost) / (elsewhere.attempts + 3)
  const cClass = (siblings.cost + 3 * cGlobal) / (siblings.attempts + 3)
  const perAttempt = (cell.cost + 3 * cClass) / (cell.attempts + 3)
  const cost = attempts * perAttempt

  return {
    harnessId: harness.id,
    pVerify: pCell,
    lo,
    hi,
    attempts,
    cost,
    perFix: cost / Math.max(pCell, 0.02),
    direct: cell.runs,
    related: cell.runs + siblings.runs,
    independent: (cell.verified + 1) / (cell.runs + 2),
    shifts,
  }
}

// --- The budget -------------------------------------------------------------

/** A tail no bigger than this, at its upper confidence bound, is not worth paying for. */
export const TAIL_EPSILON = 0.06

/**
 * The attempt count past which this harness has not paid for itself, or
 * undefined when the record does not say so.
 *
 * `successAt` says which attempt each verified run passed on. Of the runs that
 * were still going after attempt k, some later passed and some never did; if the
 * upper bound of that fraction is small, everything after k was spent for
 * nothing. It takes a lot of runs to say that with confidence — zero of twenty-two
 * is only 15% at the upper bound — which is the point: it will not cut a budget
 * on a hunch, and it can only ever shorten one.
 */
export function attemptCap(input: { signature: string; harness: HarnessRef; library: Library }): number | undefined {
  const klass = classOf(input.signature)
  const records = input.library.records.filter((record) => record.harnessId === input.harness.id && classOf(record.signature) === klass)
  const runs = records.reduce((total, record) => total + record.runs, 0)
  const at: number[] = []
  for (const record of records) for (const [index, count] of (record.successAt ?? []).entries()) at[index] = (at[index] ?? 0) + count
  const verifiedSeen = at.reduce((total, count) => total + (count ?? 0), 0)
  // Records made before the attempt was recorded cannot say where their successes fell.
  const verified = records.reduce((total, record) => total + record.verifiedRuns, 0)
  if (runs === 0 || verifiedSeen < verified) return undefined

  for (let cap = 1; cap < input.harness.maxAttempts; cap += 1) {
    const withinCap = at.slice(0, cap).reduce((total, count) => total + (count ?? 0), 0)
    const stillGoing = runs - withinCap
    const later = at.slice(cap).reduce((total, count) => total + (count ?? 0), 0)
    if (stillGoing >= 20 && wilson(later, stillGoing).hi < TAIL_EPSILON) return cap
  }
  return undefined
}

// --- The plan ---------------------------------------------------------------

export interface Plan {
  harnessId: string | undefined
  reason: string
  exploring: boolean
  /** Fewer attempts than the harness allows, when the record supports it. */
  maxAttempts?: number
  /** What the plan committed to before the search, for scoring after it. */
  prediction?: { harnessId: string; pVerify: number; independent: number }
  /** Whether the old independent-cell library would have chosen something else. */
  differed?: boolean
  context: WorldContext | undefined
  estimates: Estimate[]
}

/** Points of lower-bound verification rate a harness may give up to a cheaper one before the cheaper one is not the same. */
export const DEFAULT_TOLERANCE = 0.05

/** `ELIA_META_TOLERANCE=0` is verification only: cost breaks exact ties and nothing else. Larger is thriftier. */
export function metaTolerance(env: Record<string, string | undefined> = process.env): number {
  const value = Number(env.ELIA_META_TOLERANCE)
  return env.ELIA_META_TOLERANCE !== undefined && env.ELIA_META_TOLERANCE.trim() !== '' && Number.isFinite(value) ? clamp(value, 0, 0.5) : DEFAULT_TOLERANCE
}

/** `ELIA_META_WORLD=off` restores the library's own choice, unchanged: the control arm for what the planner does. */
export function plannerEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.ELIA_META_WORLD ?? '').trim().toLowerCase() !== 'off'
}

const percent = (value: number) => `${Math.round(value * 100)}%`
const tokens = (value: number) => (value >= 1000 ? `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k` : `${Math.round(value)}`)

export function planHarness(input: { signature: string; candidates: readonly HarnessRef[]; library: Library; context?: WorldContext; enabled?: boolean; tolerance?: number; coldStart?: 'library' | 'undominated' }): Plan {
  const ids = input.candidates.map((candidate) => candidate.id)
  const baseline: Choice = chooseHarness(input.signature, ids, input.library)
  const unplanned = (): Plan => ({ harnessId: baseline.harnessId, reason: baseline.reason, exploring: baseline.exploring, context: input.context, estimates: [] })
  if (input.enabled === false || input.candidates.length === 0) return unplanned()

  const estimates = input.candidates.map((harness) => estimate({ signature: input.signature, harness, library: input.library, ...(input.context ? { context: input.context } : {}) }))
  // What is true of how the harnesses are built, not something to be learned: a
  // harness that is a subset of another cannot verify more often than it. So
  // evidence that the larger one is poor caps the smaller, and evidence that the
  // smaller one is good raises the larger's floor. It is what stops a search from
  // spending turns finding out whether one attempt is as good as three when three
  // has not yet been shown to be good.
  for (const candidate of input.candidates) {
    if (!candidate.subsetOf) continue
    const small = estimates.find((entry) => entry.harnessId === candidate.id)
    const large = estimates.find((entry) => entry.harnessId === candidate.subsetOf)
    if (!small || !large) continue
    small.hi = Math.min(small.hi, large.hi)
    small.pVerify = Math.min(small.pVerify, large.pVerify)
    small.lo = Math.min(small.lo, small.hi)
    large.lo = Math.max(large.lo, small.lo)
    large.pVerify = Math.max(large.pVerify, small.pVerify)
    large.hi = Math.max(large.hi, large.lo)
  }
  const seasoned = estimates.filter((entry) => entry.related >= MIN_OBSERVATIONS)
  // With nothing seasoned the library measures by rotating through the harnesses
  // in order, and the first is the narrowest: five runs of a search that fails
  // most of the time, on the person who asked. The objective is verification, and
  // a harness that is a subset of another cannot beat it, so the place to start is
  // the smallest harness nothing else contains. The narrow one is tried later, when
  // the wider one has shown it is good enough for the narrow one to be worth testing.
  const undominated = estimates.filter((entry) => !input.candidates.find((candidate) => candidate.id === entry.harnessId)?.subsetOf)
  const defaultStart = input.coldStart === 'library' ? undefined : undominated[0]
  if (seasoned.length === 0 && !defaultStart) {
    // Nothing has earned the right to override the default: the library's own
    // measuring pass, unchanged, and the plan says how sure it is about what it picked.
    const picked = estimates.find((entry) => entry.harnessId === baseline.harnessId)
    return { ...unplanned(), ...(picked ? { prediction: { harnessId: picked.harnessId, pVerify: picked.pVerify, independent: picked.independent } } : {}), estimates }
  }
  const pool = seasoned.length > 0 ? seasoned : [defaultStart!]

  // Verification first. Among the harnesses the record cannot tell from the best,
  // the one that spends least — a saving taken only where it costs nothing real.
  const tolerance = input.tolerance ?? metaTolerance()
  const bestLower = Math.max(...pool.map((entry) => entry.lo))
  const equivalent = pool.filter((entry) => entry.lo >= bestLower - tolerance)
  const leader = [...equivalent].sort((a, b) => a.cost - b.cost || b.lo - a.lo)[0]!
  const cellRuns = estimates.reduce((total, entry) => total + entry.direct, 0)
  // One slot in four to a challenger whose best case could still beat the leader's
  // floor and that has too few runs to rule out: the library's own schedule and
  // rule, so exploring costs what it always did.
  const challengers = estimates
    .filter((entry) => entry !== leader && entry.direct < EXPLORATION_CAP && entry.hi > leader.lo)
    .sort((a, b) => a.direct - b.direct)
  const explore = challengers.length > 0 && cellRuns % 4 === 3
  const chosen = explore ? challengers[0]! : leader
  const harness = input.candidates.find((candidate) => candidate.id === chosen.harnessId)!
  const cap = attemptCap({ signature: input.signature, harness, library: input.library })

  const moved = chosen.shifts.map((entry) => `${entry.flag} ${entry.logit >= 0 ? 'helps' : 'hurts'}`).join(', ')
  const measuring = seasoned.length === 0
  const reason = measuring && !explore
    ? `starting with ${chosen.harnessId} for ${input.signature}: nothing has ${MIN_OBSERVATIONS} related runs yet, and the smallest search no other contains is the safest place to measure from — a wider search cannot verify less often`
    : explore
    ? `trying ${chosen.harnessId} for ${input.signature}: ${chosen.direct} run(s) is too few to rule out beating ${leader.harnessId} (best case ${percent(chosen.hi)} against ${percent(leader.lo)})`
    : `${chosen.harnessId}: ${percent(chosen.pVerify)} verified for ${input.signature} (lower bound ${percent(chosen.lo)}), about ${chosen.attempts.toFixed(1)} attempts and ${tokens(chosen.cost)} tokens a run, ${tokens(chosen.perFix)} per verified fix — from ${chosen.related} related run(s)${equivalent.length > 1 ? `; the cheapest of ${equivalent.length} within ${Math.round(tolerance * 100)} points of the best` : ''}${moved ? `; ${moved} here` : ''}${cap !== undefined ? `; capped at ${cap} attempt(s), nothing after has paid` : ''}`
  return {
    harnessId: chosen.harnessId,
    reason,
    exploring: explore,
    ...(cap !== undefined ? { maxAttempts: cap } : {}),
    prediction: { harnessId: chosen.harnessId, pVerify: chosen.pVerify, independent: chosen.independent },
    differed: chosen.harnessId !== baseline.harnessId,
    context: input.context,
    estimates,
  }
}

// --- Scored on the runs it plans ---------------------------------------------

/** What the planner has said and how it fared, against the independent-cell estimate on the very same runs. */
export interface MetaScore {
  version: 1
  n: number
  /** Sum of squared errors of the planner's predicted verification rate. */
  planner: number
  /** Sum of squared errors of the independent-cell estimate on the same runs. */
  independent: number
  /** Runs where the old library would have chosen a different harness. */
  differed: number
}

export const emptyMeta = (): MetaScore => ({ version: 1, n: 0, planner: 0, independent: 0, differed: 0 })

export function metaPath(dir = join(paths.state, 'reason')): string {
  return join(dir, 'meta.json')
}

export function readMeta(path = metaPath()): MetaScore {
  try {
    if (!existsSync(path)) return emptyMeta()
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<MetaScore>
    return parsed.version === 1 ? { ...emptyMeta(), ...parsed } : emptyMeta()
  } catch {
    return emptyMeta()
  }
}

/** Adds one scored plan. Never throws: a lost score costs a data point, not a search. */
export function recordMeta(prediction: NonNullable<Plan['prediction']>, verified: boolean, differed: boolean, path = metaPath()): void {
  try {
    ensureSecureDirectory(join(path, '..'))
    withFileLock(`${path}.lock`, () => {
      const meta = readMeta(path)
      const actual = verified ? 1 : 0
      meta.n += 1
      meta.planner += (prediction.pVerify - actual) ** 2
      meta.independent += (prediction.independent - actual) ** 2
      meta.differed += differed ? 1 : 0
      writeSecureFile(path, `${JSON.stringify(meta)}\n`)
    })
  } catch {
    // See above.
  }
}

/** Plans scored before the comparison means anything. */
export const MIN_META = 10

/** How much better the planner's predictions are than the independent-cell estimate's: positive is better. Undefined until there is enough to say. */
export function metaSkill(meta: MetaScore): number | undefined {
  if (meta.n < MIN_META || meta.independent <= 0) return undefined
  return 1 - meta.planner / meta.independent
}

/** The project as the planner sees it, in words. */
export function renderContext(context: WorldContext): string {
  const parts = [
    context.checkMs === undefined ? 'checks not yet timed' : `checks take ${context.checkMs >= 10_000 ? `${Math.round(context.checkMs / 1000)}s` : `${(context.checkMs / 1000).toFixed(1)}s`}${context.flags.slow ? ' (slow)' : ''}`,
    context.flipRate === undefined ? 'flakiness not yet measured' : `tests answered differently on ${Math.round(context.flipRate * 100)}% of identical re-runs${context.flags.flaky ? ' (flaky)' : ''}`,
    context.flags.cold ? `new to the world model (${context.modelled} actions)` : `familiar (${context.modelled} actions)`,
    context.flags.unsteady ? 'the agent\'s picture of it has been unsteady' : 'steady',
  ]
  return `  this project, as the planner reads it: ${parts.join('; ')}`
}

export function renderMeta(meta: MetaScore): string {
  if (meta.n === 0) return '  reasoning plans: none scored yet — every search from now on commits to a verification rate first and is scored on whether it verified'
  const skill = metaSkill(meta)
  const lines = [`  reasoning plans: ${meta.n} scored; the plan chose a different harness than the independent-cell library would have on ${meta.differed}`]
  if (skill === undefined) lines.push(`    accuracy: not enough yet — needs ${MIN_META} scored plans, has ${meta.n}`)
  else {
    const pct = (value: number) => `${Math.round(Math.abs(value) * 100)}%`
    lines.push(`    accuracy: Brier ${(meta.planner / meta.n).toFixed(3)} against ${(meta.independent / meta.n).toFixed(3)} for the independent cells on the same runs — ${skill >= 0 ? `${pct(skill)} better` : `${pct(skill)} WORSE, so pooling is not helping here`}`)
  }
  return lines.join('\n')
}
