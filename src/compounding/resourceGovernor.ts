import type { FrontierReport } from './frontier.ts'
import type { LibraryHealth } from '../autonomy/certifiedLibrary.ts'
import type { GrowthReport } from './growth.ts'
import type { CompressionQueue } from '../skills/closure.ts'

/**
 * The resource governor of §10: spend the next unit of compute where it moves
 * the verification frontier furthest per unit cost.
 *
 *   a* = argmax_a  E[ΔΦ_a] / cost_a
 *
 * over the activities the paper names — solving, building tools, synthesising
 * verifiers, auditing, compressing, improving the scaffold — plus growing the
 * benchmark, which its rule R4 implies whenever the held-out set is too small
 * to certify the gains being hunted.
 *
 * The expected gains are not known in advance, so the governor starts from the
 * paper's four rules, which say which activity dominates in which state, and
 * lets recorded outcomes take over as they accumulate (a UCB bandit over ΔΦ per
 * unit cost). Every recommendation carries the rule or evidence behind it; a
 * plan with no reason attached is exactly what this directory exists to stop
 * producing.
 */

export type Activity = 'verify' | 'audit' | 'compress' | 'meta' | 'harvest' | 'solve'

export const ACTIVITY_LABEL: Record<Activity, string> = {
  verify: 'synthesise verifiers / raise verification coverage',
  audit: 'audit the library (re-check, purge, retire)',
  compress: 'compress habits into certified tools',
  meta: 'improve the scaffold (one evolve generation)',
  harvest: 'grow the benchmark so the gate can see real gains',
  solve: 'solve frontier tasks (practice)',
}

/** Rough relative cost of one unit of each activity, in model spend. Audit is deterministic and free. */
export const ACTIVITY_COST: Record<Activity, number> = {
  audit: 0.05,
  verify: 1,
  compress: 1,
  harvest: 2,
  solve: 2,
  meta: 5,
}

export interface BenchPower {
  tasks: number
  passRate: number
  /** Smallest mean gain the sealed gate can certify on this many tasks. */
  minimumDetectable: number
  /** Which gate decides promotions (`ELIA_EVOLVE_GATE`); R4 only binds the sealed one. */
  gate?: 'legacy' | 'sealed' | 'both'
  /** Of `tasks`, how many were added (harvested, or new to the suite) after the last full run and have no score yet. */
  unbenched?: number
}

export interface GovernorState {
  frontier: FrontierReport
  library: LibraryHealth
  growth: GrowthReport
  queue: CompressionQueue
  bench?: BenchPower
}

export interface ActivityObservation {
  activity: Activity
  /** Change in frontier mass Φ the activity produced. */
  deltaPhi: number
  cost: number
  /** When it ran. Absent only in hand-built histories. */
  at?: number
}

export interface Recommendation {
  activity: Activity
  /** Rule prior plus measured value; higher first. */
  score: number
  /** Which rule or evidence put it here. */
  rule: string
  why: string
  /** False when the state says this activity cannot pay off right now. */
  viable: boolean
}

const PRIOR_WEIGHT = 1
const UCB_C = 0.5
/** Observations of an activity before its measured value is trusted over the rules. */
const MIN_OBSERVATIONS = 3

export function recommend(state: GovernorState, history: readonly ActivityObservation[] = []): Recommendation[] {
  const recs = new Map<Activity, Recommendation>()
  const set = (activity: Activity, priority: number, rule: string, why: string, viable = true) => {
    const existing = recs.get(activity)
    if (!existing || priority > existing.score) recs.set(activity, { activity, score: priority, rule, why, viable })
  }

  // R1 — a valuable family outside the frontier (α > p) is a verifier problem,
  // not a solving problem: Proposition 1 says solving cannot raise precision.
  const outside = state.frontier.families.filter((family) => family.status === 'outside' && family.turns > 0)
  // Judged on recent work a check could have read: prose has no fast verifier
  // (§13), and an all-time share would still be blaming the gate for turns it
  // has since learned to check.
  const unverified = state.frontier.checkableUnverified
  if (outside.length > 0) {
    set('verify', 0.9, 'R1', `${outside.map((family) => family.family).join(', ')} sit outside the frontier — only a better verifier moves them`)
  }
  if (unverified.mean !== undefined && unverified.mean > 0.25) {
    set('verify', 0.85, 'R1', `${Math.round(unverified.mean * 100)}% of recent checkable file-changing turns ran no check at all — for them α is effectively 1`)
  }
  const unmeasured = state.frontier.families.filter((family) => family.status === 'unmeasured' && family.turns > 0)
  if (state.frontier.mass === undefined || unmeasured.length > 0) {
    set('verify', 0.7, 'Phase 0', `${unmeasured.length} active famil${unmeasured.length === 1 ? 'y has' : 'ies have'} no measured false-accept rate — run \`elia gap\` so the frontier can be placed`)
  }

  // R2 — near the error threshold, or with no reuse advantage, audit first.
  if (state.library.auditFirst) {
    set('audit', 0.95, 'R2', state.library.notes[0] ?? 'the library is near its error threshold')
  } else if (state.library.total === 0) {
    // Nothing certified yet: the audit is what gives the existing store its
    // certificates, so without this the library could never start.
    set('audit', 0.6, 'R2', 'the library holds no certificates yet — the audit certifies what is already stored')
  } else {
    set('audit', 0.3, 'R2', 'routine audit — cheap and keeps the slip-rate estimate current')
  }

  // R3 — library elasticity at or below zero: grow by compressing, not adding.
  const gamma = state.growth.lessons.gamma
  const flat = gamma !== undefined && state.growth.lessons.se !== undefined && gamma < 1.96 * state.growth.lessons.se
  if (flat) {
    const top = state.queue.queued[0]
    if (top) set('compress', 0.8, 'R3', `text lessons show no measurable lift (γ ${gamma!.toFixed(2)} ± ${state.growth.lessons.se!.toFixed(2)}); the most valuable safe habit is \`${top.candidate.pattern}\` (${top.candidate.count}×)`)
    else set('compress', 0.2, 'R3', 'γ is flat, but no habit is safe to encode automatically yet', false)
  } else if (state.queue.queued[0]) {
    set('compress', 0.4, 'R3', `\`${state.queue.queued[0].candidate.pattern}\` repeats ${state.queue.queued[0].candidate.count}× — a tool would save round-trips`)
  }

  // R4 — the meta-loop is only as good as the held-out set can certify.
  if (state.bench) {
    const headroom = 1 - state.bench.passRate
    if (state.bench.minimumDetectable > headroom) {
      set('harvest', 0.85, 'R4', `the gate can certify gains of ~${Math.round(state.bench.minimumDetectable * 100)} pts but the benchmark has ${Math.round(headroom * 100)} pts of headroom — grow it before proposing`)
      if ((state.bench.gate ?? 'legacy') === 'legacy') {
        // The legacy rule still decides, and it can promote here — but nothing
        // bounds how often what it promotes is noise, which is what R4 is about.
        set('meta', 0.25, 'R4', 'the legacy gate can still promote on this benchmark, but no gain it holds is certifiable — a promotion here has no stated error rate')
      } else {
        set('meta', 0.1, 'R4', 'blocked: the sealed gate decides, and no gain this benchmark can hold is certifiable', false)
      }
    } else {
      set('meta', 0.6, 'R4', `the gate can certify ~${Math.round(state.bench.minimumDetectable * 100)}-pt gains within ${Math.round(headroom * 100)} pts of headroom`)
    }
  } else {
    set('harvest', 0.5, 'R4', 'no full benchmark run recorded — the gate\'s power is unknown')
  }

  // Solving is what the frontier is for; it earns its place once the families are inside.
  const inside = state.frontier.families.filter((family) => family.status === 'inside')
  set('solve', inside.length > 0 ? 0.5 : 0.15, 'frontier', inside.length > 0 ? `${inside.map((family) => family.family).join(', ')} are inside the frontier — practice there pays` : 'no family is certainly inside the frontier yet')

  // Measured value: once an activity has a record, ΔΦ per cost (with an
  // exploration bonus) is added to its rule prior.
  const total = history.length
  for (const rec of recs.values()) {
    const mine = history.filter((observation) => observation.activity === rec.activity)
    if (mine.length < MIN_OBSERVATIONS) continue
    const mean = mine.reduce((sum, observation) => sum + observation.deltaPhi / Math.max(1e-6, observation.cost), 0) / mine.length
    const bonus = UCB_C * Math.sqrt(Math.log(Math.max(2, total)) / mine.length)
    rec.score = PRIOR_WEIGHT * rec.score + mean + bonus
    rec.why += ` · measured ΔΦ/cost ${mean.toFixed(3)} over ${mine.length} run(s)`
  }

  // Cost nudges rather than dominates: dividing by it would let a routine,
  // near-free audit outrank a rule that says the frontier is blocked, when the
  // audit's expected ΔΦ is itself small. A tenth of an order of magnitude per
  // decade of cost breaks ties toward the cheap activity and no more.
  const adjusted = (rec: Recommendation) => rec.score - 0.1 * Math.log10(ACTIVITY_COST[rec.activity])
  return [...recs.values()].sort((a, b) => Number(b.viable) - Number(a.viable) || adjusted(b) - adjusted(a))
}

export function renderPlan(recs: readonly Recommendation[]): string {
  const lines = ['RESOURCE GOVERNOR · next compute, in order']
  recs.forEach((rec, index) => {
    lines.push(`  ${index + 1}. ${rec.viable ? '' : '(blocked) '}${ACTIVITY_LABEL[rec.activity]} [${rec.rule}]`)
    lines.push(`     ${rec.why}`)
  })
  return lines.join('\n')
}
