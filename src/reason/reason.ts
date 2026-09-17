import { harnessById, harnessesFor } from './harness.ts'
import type { Harness, VerifierKind } from './harness.ts'
import { chooseHarness, libraryPath, readLibrary, recordOutcome } from './library.ts'
import { solve } from './select.ts'
import type { AttemptRecord, Producer, SolveResult } from './select.ts'
import { taskSignature, worthSearching } from './signature.ts'
import type { TaskSignature } from './signature.ts'
import { allOf, commandVerifier, consensusVerifier } from './verify.ts'
import type { Candidate, Verifier } from './verify.ts'

/**
 * The whole reasoning layer, as one call.
 *
 * Given a request and a way to attempt it, this decides whether the task is
 * worth more than one attempt, picks the search shape the library has measured
 * as best for work of this shape, runs it against a check that cannot be argued
 * with, and folds the result back into the library so the next task of the same
 * shape starts from what this one cost to learn.
 *
 * It is deliberately a thin coordinator. Every judgement it makes lives in a
 * module that can be tested without a model attached: what kind of task this is
 * (signature.ts), which shapes of search exist (harness.ts), which one has
 * earned its place (library.ts), how a search is actually run (select.ts), and
 * what counts as proof (verify.ts). The one thing that needs a model — producing
 * an attempt — is injected, which is why the whole layer can be exercised at
 * zero spend and why the parts of it that decide things are checkable at all.
 */

export interface ProjectChecks {
  /** The command that runs the project's own tests. The strongest check available. */
  test?: string
  /** A typecheck or build command. Cheap and structural — catches broken candidates fast. */
  build?: string
  /** How long a single check may run. */
  timeoutMs?: number
}

export interface ReasonOptions {
  request: string
  /** What elia can run to find out whether an attempt worked. */
  checks: ProjectChecks
  /** Runs one attempt. Injected, because this is the only part that needs a model. */
  produce: Producer
  /**
   * Builds a check for a task that has none — elia writing the test before it
   * writes the code. When a harness asks for one and this is absent, the search
   * degrades to agreement between attempts and says so in the receipt rather
   * than quietly calling an unverified answer verified.
   */
  synthesizeProbe?: (signature: TaskSignature) => Promise<Verifier | undefined>
  /** Overrides the library's pick. For `/reason wide`, and for tests. */
  forceHarnessId?: string
  libraryFile?: string
  onAttempt?: (record: AttemptRecord) => void
  signal?: AbortSignal
}

export interface ReasonResult {
  /** False when the task did not warrant a search; the caller should run its normal single pass. */
  searched: boolean
  signature: TaskSignature
  harness?: Harness
  /** Why this harness — the library's own words, so its state is legible. */
  choice?: string
  result?: SolveResult
  /**
   * One line for the user. Says plainly whether the answer was proved or merely
   * chosen, because an unverified answer presented as a verified one is the
   * failure this layer exists to remove.
   */
  receipt: string
}

/**
 * Turns the harness's declared check into a real one.
 *
 * Ordered so the cheap structural check runs first and rejects a candidate that
 * does not even compile before anything pays for a test run — across a wide
 * search that ordering is most of the bill.
 */
export async function resolveVerifier(options: {
  kind: VerifierKind
  checks: ProjectChecks
  signature: TaskSignature
  synthesizeProbe?: ReasonOptions['synthesizeProbe']
  /** Threaded to the check commands so Esc can interrupt the part of a search that actually takes the time. */
  signal?: AbortSignal
}): Promise<{ verifier: Verifier | ((all: Candidate[]) => Verifier); degraded: boolean }> {
  const { kind, checks, signature, synthesizeProbe, signal } = options
  const build = checks.build ? commandVerifier({ id: 'build', command: checks.build, timeoutMs: checks.timeoutMs, strength: 'structural', costHint: 'cheap', signal }) : undefined
  const test = checks.test ? commandVerifier({ id: 'tests', command: checks.test, timeoutMs: checks.timeoutMs, signal }) : undefined

  if (kind === 'project-tests' && test) {
    return { verifier: build ? allOf('project checks', [build, test]) : test, degraded: false }
  }
  if (kind === 'project-build' && build) return { verifier: build, degraded: false }

  if (kind === 'synthesized-probe') {
    const probe = await synthesizeProbe?.(signature)
    if (probe) return { verifier: build ? allOf('synthesized checks', [build, probe]) : probe, degraded: false }
  }

  // Nothing executable is available. Agreement is what is left, and the caller
  // is told the answer is unproven rather than allowed to assume otherwise.
  return { verifier: consensusVerifier(), degraded: kind !== 'consensus' }
}

function receiptFor(options: { harness: Harness; result: SolveResult; degraded: boolean }): string {
  const { harness, result, degraded } = options
  const attempts = `${result.attempts.length} attempt${result.attempts.length === 1 ? '' : 's'}`
  if (result.verified) {
    return `verified — ${result.bestVerdict?.detail ?? 'a check that ran the behaviour passed'} (${harness.id}, ${attempts})`
  }
  if (result.best && result.bestVerdict?.passed) {
    const caveat = degraded ? ', and no executable check was available' : ''
    return `unproven — best of ${attempts} by ${result.bestVerdict.detail}${caveat}. Treat this as elia's best answer, not a checked one.`
  }
  const near = result.bestVerdict?.progress !== undefined ? ` (closest got ${(result.bestVerdict.progress * 100).toFixed(0)}% of the way)` : ''
  return `no attempt passed after ${attempts}${near}. Returning the closest one — it needs review.`
}

export async function reason(options: ReasonOptions): Promise<ReasonResult> {
  const signature = taskSignature(options.request, { hasExecutableCheck: Boolean(options.checks.test || options.checks.build) })

  const candidates = harnessesFor(signature)
  if (!worthSearching(signature) || candidates.length === 0) {
    return { searched: false, signature, receipt: `no search — ${signature.taskClass} work with nothing a second attempt could be told apart by` }
  }

  const file = options.libraryFile ?? libraryPath()
  const library = readLibrary(file)
  const choice = options.forceHarnessId
    ? { harnessId: options.forceHarnessId, reason: `harness pinned to ${options.forceHarnessId}`, exploring: false }
    : chooseHarness(signature.key, candidates.map((harness) => harness.id), library)
  const harness = harnessById(signature, choice.harnessId)!

  const { verifier, degraded } = await resolveVerifier({
    kind: harness.verifier,
    checks: options.checks,
    signature,
    synthesizeProbe: options.synthesizeProbe,
    signal: options.signal,
  })

  const result = await solve({
    approaches: harness.approaches,
    produce: options.produce,
    verifier,
    budget: { attempts: harness.maxAttempts },
    width: harness.width,
    // A harness that wanted a real check and did not get one must still not be
    // allowed to call agreement proof — but it may stop on it, since spending
    // the rest of the budget would only buy the same guess again.
    allowUnverifiedStop: harness.allowUnverifiedStop || degraded,
    onAttempt: options.onAttempt,
    signal: options.signal,
  })

  // An aborted search is the user changing their mind, not evidence about the
  // harness, and recording it would poison the library with runs nobody ran.
  if (result.stopped !== 'aborted') {
    recordOutcome(
      {
        signature: signature.key,
        harnessId: harness.id,
        verified: result.verified,
        attemptsUsed: result.attempts.length,
        cost: result.cost,
        elapsedMs: result.elapsedMs,
        at: Date.now(),
      },
      file,
    )
  }

  return { searched: true, signature, harness, choice: choice.reason, result, receipt: receiptFor({ harness, result, degraded }) }
}
