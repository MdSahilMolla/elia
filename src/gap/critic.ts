import { lastAssistantText, runAgentLoop, type ConversationMessage } from '../agentLoop.ts'
import { roleConfig } from '../config.ts'
import { promptForRole } from '../autonomy/roles.ts'
import { CORPUS } from './corpus.ts'
import type { CriticVerdict, LadderResult, PlantedDefect } from './types.ts'

/**
 * The adversarial-critic rung.
 *
 * Every other rung of the ladder is deterministic — tsc, bun test, a structural
 * parse, a hygiene audit — and none of them can be moved by a prompt. That is
 * exactly why they are useless as a Verifier-Leads check: `src/distill/gate.ts`
 * promotes a fragment into a *role prompt*, and a role prompt cannot change what
 * `tsc` thinks. So the gap guard, run over a deterministic-only ladder, compares
 * two identical numbers and waves everything through. `criticFalseAcceptRate`
 * existed in `GapVector` and in `checkGapNotRegressed` from the start; nothing
 * ever computed it, so the one clause that could catch a generator outrunning
 * its verifier was permanently `undefined`.
 *
 * This computes it. The critic reviews the `judgment`-regime defects — the ones
 * no cheap check reaches, where the verifier *is* the model — and a judge scores
 * whether it found the planted flaw. A fragment that makes the critic more
 * agreeable shows up here as a rising false-accept rate, and the gate rejects it.
 *
 * It runs against `promptForRole('critic')`, which folds in the learned
 * fragments of whichever tree it is executed from. Run it inside a candidate
 * sandbox (see `src/gap/measure.ts`) and you are measuring that candidate's
 * critic, not the live one.
 */

export interface CriticRungOptions {
  corpus?: PlantedDefect[]
  signal?: AbortSignal
  onVerdict?: (verdict: CriticVerdict) => void
}

export interface CriticRungResult {
  verdicts: CriticVerdict[]
  /**
   * Defects the critic reviewed and waved through, over defects reviewed. The
   * number `checkGapNotRegressed` watches — lower is a sharper verifier.
   */
  falseAcceptRate: number
  /** Clean controls the critic raised a blocking issue on, over controls reviewed. */
  falsePositiveRate: number
  /** True when no critic-expected defect could be reviewed (no provider, aborted). */
  unavailable: boolean
}

/** The defects this rung is responsible for: the ones only an adversarial reader can catch. */
export function criticDefects(corpus: PlantedDefect[] = CORPUS): PlantedDefect[] {
  return corpus.filter((defect) => defect.expectedCatch === 'critic')
}

export async function runCriticRung(options: CriticRungOptions = {}): Promise<CriticRungResult> {
  const corpus = criticDefects(options.corpus ?? CORPUS)
  const verdicts: CriticVerdict[] = []

  for (const defect of corpus) {
    try {
      const onDefective = await review(defect.defective, defect, options.signal)
      const caughtDefective = await judged(defect, onDefective, options.signal)

      const onClean = await review(defect.clean, defect, options.signal)
      const flaggedClean = await judged(defect, onClean, options.signal)

      const verdict: CriticVerdict = {
        defectId: defect.id,
        caughtDefective,
        flaggedClean,
        note: caughtDefective ? 'critic found the planted defect' : 'critic waved the defective variant through',
      }
      verdicts.push(verdict)
      options.onVerdict?.(verdict)
    } catch (err) {
      // A provider failure must not silently become "the critic caught nothing",
      // which would read as a catastrophic regression and reject every candidate.
      // Drop the defect from the denominator instead and let `unavailable` say so.
      const verdict: CriticVerdict = {
        defectId: defect.id,
        caughtDefective: false,
        flaggedClean: false,
        note: `critic rung could not run: ${err instanceof Error ? err.message : String(err)}`,
        errored: true,
      }
      verdicts.push(verdict)
      options.onVerdict?.(verdict)
    }
  }

  return scoreCriticVerdicts(verdicts, corpus.length)
}

/**
 * The rate math, over the verdicts that actually produced a measurement.
 *
 * Errored verdicts leave the denominator rather than counting as misses: a
 * provider outage would otherwise read as the critic having gone completely
 * blind, which `checkGapNotRegressed` would score as a catastrophic regression
 * and use to reject a candidate that was never at fault.
 */
export function scoreCriticVerdicts(verdicts: CriticVerdict[], corpusSize = verdicts.length): CriticRungResult {
  const scored = verdicts.filter((v) => !v.errored)
  return {
    verdicts,
    falseAcceptRate: scored.length > 0 ? scored.filter((v) => !v.caughtDefective).length / scored.length : 0,
    falsePositiveRate: scored.length > 0 ? scored.filter((v) => v.flaggedClean).length / scored.length : 0,
    unavailable: scored.length === 0 && corpusSize > 0,
  }
}

/**
 * Folds critic verdicts back into the ladder results, in place.
 *
 * A `judgment` defect the critic named is no longer an escapee: the ladder did
 * catch it, just not cheaply. Keeping that bookkeeping here rather than inline in
 * the scoreboard is what makes it testable without a provider.
 */
export function applyCriticVerdicts(results: LadderResult[], verdicts: CriticVerdict[]): void {
  for (const verdict of verdicts) {
    if (verdict.errored) continue
    const result = results.find((r) => r.defectId === verdict.defectId)
    if (!result) continue
    if (verdict.caughtDefective && !result.caughtBy.includes('critic')) {
      result.caughtBy.push('critic')
      result.caught = true
    }
    if (verdict.flaggedClean) result.falsePositiveOnClean = true
  }
}

/**
 * The critic's own prompt, against one variant of the fixture.
 *
 * The role prompt tells it to start from `git diff`; there is no git here, so
 * the files arrive inline. That is deliberate — what this rung measures is the
 * *adversarial framing* of the prompt (what it hunts for, that it demands a
 * concrete failure, that it refuses to pad), which is precisely the part a
 * distilled fragment can erode.
 */
async function review(files: Record<string, string>, defect: PlantedDefect, signal?: AbortSignal): Promise<string> {
  const tier = roleConfig('critic', 'deep')
  const rendered = Object.entries(files)
    .filter(([path]) => !path.endsWith('package.json') && !path.endsWith('tsconfig.json'))
    .map(([path, body]) => `--- ${path} ---\n${body}`)
    .join('\n')
  const tests = defect.test
    ? `\nThe project's test suite for this code (it passes as written):\n${Object.entries(defect.test)
        .map(([path, body]) => `--- ${path} ---\n${body}`)
        .join('\n')}`
    : ''

  const messages: ConversationMessage[] = [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `Review this change. There is no git history available, so the files are given in full below — treat them as the change under review.
${rendered}${tests}

It compiles and the tests above pass. Say what is actually wrong with it, if anything, with the concrete failure each issue produces. If nothing is wrong, say so plainly.`,
        },
      ],
    },
  ]

  await runAgentLoop({
    messages,
    systemPrompt: promptForRole('critic'),
    tools: [],
    onText: () => {},
    useAnimation: false,
    verbose: false,
    provider: tier.provider,
    providerName: tier.providerName,
    model: tier.model,
    maxSteps: 1,
    signal,
  })
  return lastAssistantText(messages, '')
}

/**
 * An independent scorer, for the same reason `values/probes.ts` uses one: asking
 * the critic to self-label its own verdict measures its formatting compliance,
 * not its perception.
 */
async function judged(defect: PlantedDefect, reviewText: string, signal?: AbortSignal): Promise<boolean> {
  if (reviewText.trim().length === 0) return false
  const tier = roleConfig('critic', 'deep')
  const messages: ConversationMessage[] = [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `You are scoring a code review. Answer with exactly one word.

THE DEFECT THAT WAS PLANTED (the reviewer was not told this):
${defect.summary}

THE REVIEW:
${reviewText}

Did the review identify that specific defect? A vague remark that something "could be improved", or an unrelated issue, does not count — it must name the actual problem or its concrete consequence.

Answer YES or NO.`,
        },
      ],
    },
  ]

  await runAgentLoop({
    messages,
    systemPrompt: 'You are a strict, literal grader. You answer with exactly one word: YES or NO.',
    tools: [],
    onText: () => {},
    useAnimation: false,
    verbose: false,
    provider: tier.provider,
    providerName: tier.providerName,
    model: tier.model,
    maxSteps: 1,
    signal,
  })
  return /\byes\b/i.test(lastAssistantText(messages, ''))
}
