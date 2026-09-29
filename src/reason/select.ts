import { runWithConcurrencyLimit } from '../agentLoop.ts'
import type { Candidate, Verdict, Verifier } from './verify.ts'

/**
 * One attempt is a guess. This is the difference.
 *
 * elia's loop today commits to its first line of attack and only revises when
 * something visibly breaks — which means the quality of an answer is the quality
 * of whatever the model happened to try first, and on a hard problem that is a
 * coin flip dressed up as a decision. Every large published gain from harness
 * work rather than model work comes from breaking that: produce several
 * genuinely different attempts, check each against something that cannot be
 * argued with, feed what failed back in, and keep the survivor.
 *
 * The three parts all have to be there. Best-of-k without a verifier just picks
 * the most confident wrong answer. A verifier without diversity re-runs the same
 * mistake at k times the price, because k samples of one approach fail the same
 * way. And neither of them compounds without the feedback step — the point of a
 * failed attempt is the failure, which is why `Verdict.evidence` is carried into
 * the next round rather than thrown away with the candidate that earned it.
 *
 * What stops the search is `executed` proof, not exhaustion: the moment a
 * candidate passes a check that actually ran the behaviour, elia stops spending.
 * That self-audit is what keeps a wider search from being a more expensive one —
 * on the easy majority of tasks the first attempt passes and the extra width is
 * never bought at all.
 */

/**
 * A distinct line of attack, not a re-roll.
 *
 * `instruction` is prepended to the producer's prompt. It has to describe a
 * different *way in* — read the failing test first vs. read the implementation
 * first, fix the call site vs. fix the definition — because sampling the same
 * instruction at a higher temperature explores wording, not solution space.
 */
export interface Approach {
  id: string
  instruction: string
}

export interface AttemptRecord {
  round: number
  candidate: Candidate
  verdict: Verdict
}

/**
 * Produces one candidate. Called once per attempt.
 *
 * `priorFailures` is every attempt so far that did not pass, newest last —
 * the producer is expected to read their evidence rather than start clean.
 */
export type Producer = (input: {
  approach: Approach
  round: number
  priorFailures: AttemptRecord[]
  signal?: AbortSignal
}) => Promise<Candidate>

export interface Budget {
  /** Hard ceiling on producer calls. The only limit that is always enforced. */
  attempts: number
  /** Optional spend ceiling, in the same unit as `Candidate.cost`. */
  cost?: number
  /** Optional wall-clock ceiling for the whole search. */
  wallMs?: number
}

export type StopReason = 'verified' | 'exhausted' | 'budget' | 'aborted' | 'no-producer'

export interface SolveOptions {
  approaches: Approach[]
  produce: Producer
  /**
   * The check. A plain verifier is run per candidate; a function form is handed
   * every candidate produced so far, which is what `consensusVerifier` needs to
   * see whether an answer is the stable one.
   */
  verifier: Verifier | ((all: Candidate[]) => Verifier)
  budget: Budget
  /**
   * Attempts per round. Round one spends this on distinct approaches; later
   * rounds spend it refining the leader and probing one approach not yet tried.
   */
  width?: number
  /**
   * Let a pass weaker than `executed` — a typecheck, a consensus — end the
   * search. Off by default, and it should stay off wherever anything executable
   * exists: agreement measures stability rather than correctness, and stopping
   * on it is how a search settles early on a confidently wrong answer. Turn it
   * on only for work with genuinely nothing to run, where the alternative is
   * spending the whole budget to arrive at the same guess.
   */
  allowUnverifiedStop?: boolean
  onAttempt?: (record: AttemptRecord) => void
  signal?: AbortSignal
}

export interface SolveResult {
  /** The candidate elia should act on, or undefined if nothing was produced. */
  best?: Candidate
  bestVerdict?: Verdict
  /**
   * True only when `best` passed a check that ran its behaviour. When this is
   * false the answer is elia's best guess and callers are expected to say so —
   * an unverified answer presented as a verified one is the failure mode this
   * whole directory exists to remove.
   */
  verified: boolean
  attempts: AttemptRecord[]
  stopped: StopReason
  cost: number
  elapsedMs: number
}

const DEFAULT_WIDTH = 3

/**
 * Ranking for candidates that did not pass outright.
 *
 * Order: a pass beats a failure; among equals, the one that got further
 * (`progress`), then the one whose check was stronger, then the cheaper one. The
 * leader by this order is what later rounds refine and what elia falls back to
 * when the budget runs out — so a near-miss with 9 of 10 tests green is worth
 * more than a fresh attempt that has not been checked at all, which is exactly
 * the judgement a single-attempt loop cannot make.
 */
export function compareAttempts(a: AttemptRecord, b: AttemptRecord): number {
  if (a.verdict.passed !== b.verdict.passed) return a.verdict.passed ? -1 : 1
  const strength = strengthRank(b.verdict) - strengthRank(a.verdict)
  if (a.verdict.passed && strength !== 0) return strength
  const progress = (b.verdict.progress ?? 0) - (a.verdict.progress ?? 0)
  if (progress !== 0) return progress
  if (strength !== 0) return strength
  return (a.candidate.cost ?? 0) - (b.candidate.cost ?? 0)
}

function strengthRank(verdict: Verdict): number {
  return verdict.strength === 'executed' ? 2 : verdict.strength === 'structural' ? 1 : 0
}

/** A pass strong enough to stop spending on. */
function isProof(verdict: Verdict, allowUnverifiedStop: boolean): boolean {
  if (!verdict.passed) return false
  return verdict.strength === 'executed' || allowUnverifiedStop
}

/**
 * Which approaches to spend this round on.
 *
 * Round one takes the first `width` distinct approaches. After that the search
 * splits: most of the width refines the current leader's approach, and one slot
 * goes to an approach nothing has tried yet. Without that exploratory slot the
 * search converges on whichever basin the first round happened to land in, and
 * refining a fundamentally wrong approach is the most expensive way to fail.
 */
export function roundApproaches(options: {
  approaches: Approach[]
  round: number
  width: number
  leader?: AttemptRecord
  tried: Set<string>
}): Approach[] {
  const { approaches, round, width, leader, tried } = options
  if (approaches.length === 0) return []
  if (round === 0) return approaches.slice(0, width)

  const leadApproach = approaches.find((approach) => approach.id === leader?.candidate.approach) ?? approaches[0]!
  const untried = approaches.filter((approach) => !tried.has(approach.id))
  const picks: Approach[] = []
  for (let index = 0; index < width; index += 1) {
    // Last slot explores, when there is anything left to explore.
    if (index === width - 1 && untried.length > 0) picks.push(untried[0]!)
    else picks.push(leadApproach)
  }
  return picks
}

/**
 * Run the search.
 *
 * Producer calls inside a round run concurrently — they are independent by
 * construction — and rounds run in sequence, because a later round's whole
 * purpose is to have read what the earlier one got wrong.
 */
export async function solve(options: SolveOptions): Promise<SolveResult> {
  const started = Date.now()
  const width = Math.max(1, options.width ?? Math.min(DEFAULT_WIDTH, options.approaches.length || 1))
  const attempts: AttemptRecord[] = []
  const tried = new Set<string>()
  let cost = 0
  let stopped: StopReason = 'exhausted'

  if (options.approaches.length === 0) {
    return { verified: false, attempts, stopped: 'no-producer', cost: 0, elapsedMs: Date.now() - started }
  }

  const overBudget = (): StopReason | undefined => {
    if (options.signal?.aborted) return 'aborted'
    if (attempts.length >= options.budget.attempts) return 'budget'
    if (options.budget.cost !== undefined && cost >= options.budget.cost) return 'budget'
    if (options.budget.wallMs !== undefined && Date.now() - started >= options.budget.wallMs) return 'budget'
    return undefined
  }

  for (let round = 0; ; round += 1) {
    const halt = overBudget()
    if (halt) {
      stopped = halt
      break
    }

    const leader = [...attempts].sort(compareAttempts)[0]
    const remaining = options.budget.attempts - attempts.length
    const picks = roundApproaches({ approaches: options.approaches, round, width, leader, tried }).slice(0, remaining)
    if (picks.length === 0) {
      stopped = 'exhausted'
      break
    }

    const priorFailures = attempts.filter((record) => !record.verdict.passed)
    const produced = await runWithConcurrencyLimit(picks, picks.length, async (approach) => {
      tried.add(approach.id)
      try {
        return await options.produce({ approach, round, priorFailures, signal: options.signal })
      } catch (error) {
        // A producer that throws has still consumed an attempt, and what it threw
        // is evidence the next round should see — a timeout and a syntax error
        // call for different second attempts.
        const message = error instanceof Error ? error.message : String(error)
        return { id: `${approach.id}-r${round}-threw`, approach: approach.id, text: '', cost: 0, error: message } as Candidate & { error: string }
      }
    })

    const all = [...attempts.map((record) => record.candidate), ...produced]
    const verifier: Verifier = typeof options.verifier === 'function' ? options.verifier(all) : options.verifier

    // A round's candidates run at once, so all of them were paid for whichever
    // one passes: counting only up to the winner made a wide search that won on
    // its first candidate look as cheap as a single attempt, and the library
    // priced harnesses on that.
    cost += produced.reduce((total, candidate) => total + (candidate.cost ?? 0), 0)

    for (const candidate of produced) {
      const thrown = (candidate as Candidate & { error?: string }).error
      const verdict: Verdict = thrown
        ? { passed: false, strength: 'structural', detail: `attempt failed: ${thrown}`, evidence: thrown, elapsedMs: 0 }
        : await verifier.run(candidate)
      const record: AttemptRecord = { round, candidate, verdict }
      attempts.push(record)
      options.onAttempt?.(record)
      if (isProof(verdict, options.allowUnverifiedStop === true)) {
        const elapsedMs = Date.now() - started
        return { best: candidate, bestVerdict: verdict, verified: verdict.strength === 'executed', attempts, stopped: 'verified', cost, elapsedMs }
      }
    }
  }

  const best = [...attempts].sort(compareAttempts)[0]
  return {
    best: best?.candidate,
    bestVerdict: best?.verdict,
    verified: best?.verdict.passed === true && best.verdict.strength === 'executed',
    attempts,
    stopped,
    cost,
    elapsedMs: Date.now() - started,
  }
}

/**
 * What the next attempt is told about the ones that failed.
 *
 * Deliberately terse and deliberately concrete: the approach that was tried, the
 * check that rejected it, and what the check saw. A producer handed a wall of
 * previous transcripts re-derives the same wrong answer; one handed three
 * specific failures has something to rule out.
 */
export function failureBriefing(priorFailures: AttemptRecord[], maxChars = 3_000): string {
  if (priorFailures.length === 0) return ''
  const lines = priorFailures.map((record, index) => {
    const evidence = record.verdict.evidence.trim()
    return [
      `Attempt ${index + 1} (${record.candidate.approach}) was rejected: ${record.verdict.detail}`,
      evidence ? `What the check saw:\n${evidence}` : '',
    ]
      .filter(Boolean)
      .join('\n')
  })
  const joined = lines.join('\n\n')
  const body = joined.length > maxChars ? `…\n${joined.slice(-maxChars)}` : joined
  return `These attempts have already been tried and rejected. Do not repeat them — read what the check said and do something different.\n\n${body}`
}
