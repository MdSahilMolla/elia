import type { Tool } from '../tools/types.ts'
import { calibrate, readReceipts } from '../world/kernel.ts'
import { assess, readChangedFiles, surfaceLine, type Screen } from '../world/twin.ts'
import { renderFindings, reviewDiff } from './quality.ts'
import type { TaskOutcome } from './fitness.ts'

/**
 * The twin, handed to the builder as a tool.
 *
 * What the twin knows is arithmetic on the candidate's own text, so it can
 * answer while the builder is still working: no model call, about a second. A
 * builder that learns after the fact that its edit was a 1% saving has spent a
 * whole measurement to find out; one that can ask as it goes shortens the
 * description again until the answer is "worth measuring" — and only then is
 * anything paid for. It is the same model that screens the candidate afterwards
 * (world/twin.ts), asked earlier, so the builder is never surprised by it.
 *
 * Immutable to the loop (sandbox.ts).
 */

export interface WorldToolOptions {
  liveRoot: string
  candidateRoot: string
  baseline: readonly TaskOutcome[]
  /** The failing tasks the hypothesis says it is meant to fix; empty for a cost-only change. */
  failingTargets: () => boolean
  /** Repo-relative files the builder has changed so far. */
  changed: () => string[]
  signal?: AbortSignal
}

export function describeScreen(screen: Screen): string {
  return [
    `edit: ${surfaceLine(screen.effect, screen.winProbability)}`,
    screen.proceed ? 'verdict: this would be measured' : `verdict: this would be stopped before any benchmark task runs — ${screen.reason}`,
  ].join('\n')
}

export function createWorldPredictTool(options: WorldToolOptions): Tool {
  return {
    name: 'world_predict',
    description:
      'Ask the world model what your changes so far would do, before anything is measured. Free and takes about a second: it reports the change in what every model call sends, the predicted token saving, whether a benchmark run would be paid for or the change stopped first, and what a code review would say. Call it after your edits and shorten or fix until it says the change would be measured.',
    input_schema: { type: 'object', properties: {} },
    async execute() {
      const changed = options.changed()
      if (changed.length === 0) return 'You have not changed anything yet.'
      const files = readChangedFiles(options.liveRoot, options.candidateRoot, changed)
      const screen = await assess({
        liveRoot: options.liveRoot,
        candidateRoot: options.candidateRoot,
        changed,
        baseline: options.baseline,
        calibration: calibrate(readReceipts()),
        failingReachable: options.failingTargets(),
        ...(options.signal ? { signal: options.signal } : {}),
      })
      const review = reviewDiff(files)
      return [describeScreen(screen), review.ok ? 'code review: clean' : `code review would reject this:\n${renderFindings(review.findings)}`].join('\n')
    },
  }
}
