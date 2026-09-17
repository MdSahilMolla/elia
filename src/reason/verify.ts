import { runShell } from '../shell.ts'

/**
 * What elia is allowed to call "correct".
 *
 * Every reasoning gain in this directory is a claim that one candidate answer is
 * better than another, and a claim like that is worth exactly as much as the
 * thing that settles it. elia already learned this the expensive way: `elia
 * evolve` ran two generations in its entire history and rejected both, the
 * benchmark it judges against sits at 100%, and of 76 recorded lessons none has
 * ever been shown to help. Not because the machinery was missing — it was all
 * there — but because nothing in the loop could tell a real improvement from a
 * confident one.
 *
 * So the ladder below is deliberately narrow at the top. A verdict only counts
 * as `executed` when the candidate's behaviour was actually run and observed.
 * Everything else — a typecheck, a lint pass, three independent attempts
 * agreeing with each other — is real information and is kept, but it is a
 * different kind of information and is never allowed to masquerade as proof.
 * `selectBest` in select.ts leans on that distinction: only an `executed` pass
 * may end a search early, because only an executed pass has earned the right to
 * stop elia from looking further.
 */

/**
 * How much a verdict is worth, strongest first.
 *
 * - `executed`   the candidate ran and its behaviour was observed (tests, a probe, an exit code).
 * - `structural` the candidate was inspected without running it (typecheck, a required symbol is present).
 * - `consensus`  independent attempts agreed. Evidence of stability, not of truth.
 */
export type VerdictStrength = 'executed' | 'structural' | 'consensus'

const STRENGTH_ORDER: Record<VerdictStrength, number> = { consensus: 0, structural: 1, executed: 2 }

export function strongerThan(a: VerdictStrength, b: VerdictStrength): boolean {
  return STRENGTH_ORDER[a] > STRENGTH_ORDER[b]
}

export interface Verdict {
  passed: boolean
  strength: VerdictStrength
  /** One line a human can read: what was checked and how it came out. */
  detail: string
  /**
   * What the check actually saw — the failing assertion, the compiler error, the
   * disagreement between two attempts. This is the half that matters: a failed
   * attempt is only useful to the next attempt if it says *why* it failed, and
   * `select.ts` feeds this straight back into the next producer call.
   */
  evidence: string
  /**
   * How close a failing candidate came, 0–1, when the check can tell — the
   * fraction of tests that passed, say. Without it every failure looks
   * identical, and `selectBest` has nothing to rank by when no candidate
   * passes outright; with it, the near-miss is what the next round refines and
   * what elia hands back when the budget runs out. Left undefined by checks
   * that only know yes or no.
   */
  progress?: number
  /** Wall-clock cost of running the check, so a slow verifier can be priced in. */
  elapsedMs: number
}

/** The thing under judgement. `text` is the answer; `cwd` is the tree the attempt left behind. */
export interface Candidate {
  id: string
  /** How this attempt was told to approach the problem — recorded so a win can be attributed. */
  approach: string
  text: string
  /** Working tree the attempt mutated, when the attempt was allowed to touch files. */
  cwd?: string
  /** Model spend for this attempt, in whatever unit the caller is budgeting in. */
  cost?: number
}

export interface Verifier {
  id: string
  strength: VerdictStrength
  /** Rough price of running this, used to order checks so the cheap one rejects first. */
  costHint: 'cheap' | 'dear'
  run(candidate: Candidate): Promise<Verdict>
}

const DEFAULT_TIMEOUT_MS = 120_000
/** Enough of a failure to reason from; more than this is usually the same error repeated. */
const MAX_EVIDENCE_CHARS = 4_000

function clipEvidence(result: { stdout: string; stderr: string }): string {
  const combined = `${result.stdout}\n${result.stderr}`.trim()
  if (combined.length <= MAX_EVIDENCE_CHARS) return combined
  // The head carries the first real error and the tail carries the summary line;
  // the middle of a long test run is the part nobody needs.
  const head = combined.slice(0, Math.floor(MAX_EVIDENCE_CHARS * 0.6))
  const tail = combined.slice(-Math.floor(MAX_EVIDENCE_CHARS * 0.4))
  return `${head}\n…\n${tail}`
}

/**
 * The strongest verifier elia has, and the one to reach for by default: run the
 * project's own checks in the tree the attempt produced.
 *
 * Exit code is the whole verdict. No model reads the output to decide whether it
 * "looks right" — that path is how a self-improvement loop talks itself into a
 * regression, and elia has already shipped one vacuous gate per quarter for
 * exactly that reason.
 */
export function commandVerifier(options: {
  id?: string
  command: string
  timeoutMs?: number
  strength?: VerdictStrength
  costHint?: 'cheap' | 'dear'
  /**
   * The turn's cancellation signal.
   *
   * Without it the check is the one part of a search Esc cannot reach: `solve`
   * receives the signal and stops scheduling attempts, but the command already
   * running keeps running to completion. On a project whose test command takes
   * minutes that is the whole turn, and the REPL can only offer "a running
   * command may not be interruptible. Press Ctrl+C twice to force-quit".
   */
  signal?: AbortSignal
}): Verifier {
  const strength = options.strength ?? 'executed'
  return {
    id: options.id ?? options.command,
    strength,
    costHint: options.costHint ?? 'dear',
    async run(candidate) {
      if (!candidate.cwd) {
        return { passed: false, strength, detail: 'no working tree to check', evidence: '', elapsedMs: 0 }
      }
      const result = await runShell(options.command, options.timeoutMs ?? DEFAULT_TIMEOUT_MS, candidate.cwd, options.signal)
      const passed = result.exitCode === 0 && !result.timedOut
      const detail = result.timedOut
        ? `\`${options.command}\` timed out after ${result.elapsedMs}ms`
        : `\`${options.command}\` exited ${result.exitCode}`
      return { passed, strength, detail, evidence: passed ? '' : clipEvidence(result), elapsedMs: result.elapsedMs }
    },
  }
}

/**
 * A check written as code rather than as a shell line: given the tree the
 * attempt produced, decide.
 *
 * This is the seam the benchmark suites already use (`BenchTask.check`), and it
 * is how a *synthesized* verifier arrives — when a task has no tests of its own,
 * elia writes the check first and the check becomes this.
 */
export function probeVerifier(options: {
  id: string
  strength?: VerdictStrength
  probe(candidate: Candidate): Promise<{ passed: boolean; detail: string; evidence?: string; progress?: number }>
}): Verifier {
  const strength = options.strength ?? 'executed'
  return {
    id: options.id,
    strength,
    costHint: 'cheap',
    async run(candidate) {
      const started = Date.now()
      try {
        const outcome = await options.probe(candidate)
        return {
          passed: outcome.passed,
          strength,
          detail: outcome.detail,
          evidence: outcome.passed ? '' : (outcome.evidence ?? outcome.detail),
          progress: outcome.progress,
          elapsedMs: Date.now() - started,
        }
      } catch (error) {
        // A probe that throws is a failed candidate, not a failed run: the usual
        // cause is the attempt leaving the tree in a state the probe cannot load.
        const message = error instanceof Error ? error.message : String(error)
        return { passed: false, strength, detail: `probe threw: ${message}`, evidence: message, elapsedMs: Date.now() - started }
      }
    },
  }
}

/**
 * Every verifier in order, stopping at the first failure.
 *
 * Ordered cheap-first on purpose: a candidate that does not typecheck should
 * never cost a full test run, and across k attempts that is most of the bill.
 * The strength reported on a pass is the *weakest* link, so a green typecheck
 * can never dress itself up as an executed result.
 */
export function allOf(id: string, verifiers: Verifier[]): Verifier {
  const ordered = [...verifiers].sort((a, b) => (a.costHint === b.costHint ? 0 : a.costHint === 'cheap' ? -1 : 1))
  const weakest = ordered.reduce<VerdictStrength>(
    (low, verifier) => (strongerThan(verifier.strength, low) ? low : verifier.strength),
    'executed',
  )
  return {
    id,
    strength: ordered.length === 0 ? 'structural' : weakest,
    costHint: ordered.some((verifier) => verifier.costHint === 'dear') ? 'dear' : 'cheap',
    async run(candidate) {
      let elapsedMs = 0
      for (const verifier of ordered) {
        const verdict = await verifier.run(candidate)
        elapsedMs += verdict.elapsedMs
        if (!verdict.passed) return { ...verdict, detail: `${verifier.id}: ${verdict.detail}`, elapsedMs }
      }
      return { passed: true, strength: weakest, detail: `${ordered.length} check(s) passed`, evidence: '', elapsedMs }
    },
  }
}

/**
 * The fallback for work with nothing executable to check: do independent
 * attempts agree?
 *
 * Agreement is not correctness, and this is the one place in the directory where
 * that has to be said out loud rather than merely encoded. Models fail in
 * correlated ways — that is the whole finding behind Poetiq's Augur numbers,
 * where the largest single cause of divergence was composition failure on facts
 * the model already held — so on the questions that are actually hard, k
 * identical wrong answers are no less likely than k identical right ones. What
 * agreement *does* measure is stability, and an unstable answer is worth
 * flagging to the user even when elia cannot tell which version is true.
 *
 * Hence `strength: 'consensus'`: this can rank candidates and it can warn, but
 * `selectBest` will not let it end a search unless the caller has explicitly
 * said there is nothing better available.
 */
export function consensusVerifier(options: {
  id?: string
  /** Reduces an answer to the part that has to match — a number, a path, a normalised sentence. */
  normalise?: (text: string) => string
  /** How many of the attempts must agree. Default: more than half. */
  quorum?: (total: number) => number
} = {}): (all: Candidate[]) => Verifier {
  const normalise = options.normalise ?? ((text: string) => text.trim().toLowerCase().replace(/\s+/g, ' '))
  const quorum = options.quorum ?? ((total: number) => Math.floor(total / 2) + 1)
  return (all: Candidate[]) => ({
    id: options.id ?? 'consensus',
    strength: 'consensus',
    costHint: 'cheap',
    async run(candidate) {
      const started = Date.now()
      const key = normalise(candidate.text)
      const agreeing = all.filter((other) => normalise(other.text) === key)
      const needed = quorum(all.length)
      const passed = agreeing.length >= needed
      const dissent = all
        .filter((other) => normalise(other.text) !== key)
        .map((other) => `- ${other.approach}: ${other.text.slice(0, 300)}`)
        .join('\n')
      return {
        passed,
        strength: 'consensus',
        detail: `${agreeing.length}/${all.length} attempts agreed (needed ${needed})`,
        evidence: passed ? '' : `attempts did not converge.\n${dissent}`,
        progress: all.length === 0 ? 0 : agreeing.length / all.length,
        elapsedMs: Date.now() - started,
      }
    },
  })
}
