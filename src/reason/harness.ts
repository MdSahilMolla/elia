import type { Approach } from './select.ts'
import type { TaskClass, TaskSignature } from './signature.ts'

/**
 * The shapes a search can take, and which shape to try for which kind of work.
 *
 * A harness is the whole reasoning plan for a task: how many lines of attack to
 * open, what those lines actually are, how much budget to spend, and what gets
 * to say the answer is right. It is the object the library measures, so there
 * has to be more than one of them per kind of work — a library with a single
 * candidate per signature has nothing to compare and learns nothing. Hence
 * `single` sitting alongside the wider harnesses: the honest null hypothesis is
 * that searching is not worth it here, and elia should be able to discover that
 * for a signature rather than assume it either way.
 *
 * The approaches are the part that matters most and the part that is easiest to
 * get wrong. They have to name genuinely different *ways in*, because k samples
 * of one instruction explore phrasing rather than solution space and cost k
 * times as much to learn nothing. "Start from the failing assertion" and "start
 * from the implementation and work out what it does wrong" land in different
 * places; "fix the bug" and "please fix the bug" do not.
 */

/** What will pass judgement. Resolved into a real `Verifier` by the caller, which knows the project. */
export type VerifierKind =
  /** The project's own test command. */
  | 'project-tests'
  /** Typecheck or build only — cheap, structural, cannot confirm behaviour. */
  | 'project-build'
  /** A check elia writes for this task before attempting it. */
  | 'synthesized-probe'
  /** Independent attempts agreeing. The last resort, and never proof. */
  | 'consensus'

export interface Harness {
  id: string
  /** Attempts opened per round. */
  width: number
  /** Hard ceiling on producer calls for the whole search. */
  maxAttempts: number
  approaches: Approach[]
  verifier: VerifierKind
  /** Whether a pass weaker than `executed` may end the search. Only ever true where nothing runs. */
  allowUnverifiedStop: boolean
  /** Per-attempt deliberation, for providers with an effort knob. */
  effort: 'instant' | 'low' | 'medium' | 'high'
}

/**
 * Reasoning from first principles, as a line of attack rather than a slogan:
 * throw out what is usually done, state what must be true, check each piece of
 * that directly, and build back up from what survived. It is what an engineer
 * does when the obvious move has already failed, which is why it sits second in
 * the repair pool — the pipeline hands repair passes out in pool order
 * (autonomy/repairSearch.ts), so the pass after a failed direct fix starts here.
 * In the implement pool it stands opposite `follow-the-grain`: one derives the
 * design from the requirement, the other copies the nearest precedent, and a
 * search that opens both finds out which one this codebase rewards.
 */
const REPAIR_APPROACHES: Approach[] = [
  {
    id: 'from-the-failure',
    instruction:
      'Start from the failure itself. Read the exact error or failing assertion, find the precise line it names, and work outward from there. Do not guess at a cause before you have read what the check actually said.',
  },
  {
    id: 'first-principles',
    instruction:
      'Distrust every assumption, the last attempt\'s included. Write down what must be true for the check to pass — the inputs, the environment, what each function on the path actually returns — then confirm each one directly by running or reading it, never by recalling it. Fix the first one that turns out false, at the place where it becomes false.',
  },
  {
    id: 'from-the-code',
    instruction:
      'Start from the implementation, not the error. Read the function under suspicion and work out what it actually does for the input in question, independently of what the failure says. Then compare that against what it was supposed to do.',
  },
  {
    id: 'from-the-change',
    instruction:
      'Treat this as a regression. Find what changed most recently around the failing behaviour — recent commits, recently edited files — and work out which change could produce this symptom.',
  },
  {
    id: 'smallest-edit',
    instruction:
      'Find the smallest edit that makes the check pass, and make only that. Do not restructure, do not rename, do not improve anything you were not asked about. Then confirm nothing else went red.',
  },
]

const IMPLEMENT_APPROACHES: Approach[] = [
  {
    id: 'check-first',
    instruction:
      'Write the check before the code. Decide concretely how you would know this works, write that as a test, watch it fail for the right reason, and only then implement until it passes.',
  },
  {
    id: 'first-principles',
    instruction:
      'Derive the design from the requirement, not from habit. State what this must do as hard constraints — inputs, outputs, invariants, how it fails — and build the simplest thing that satisfies exactly those; every part must be there for a constraint. Only then fit it to the codebase\'s conventions, and say where you departed from them and why.',
  },
  {
    id: 'follow-the-grain',
    instruction:
      'Find the closest existing thing in this codebase that already does something similar, read how it is built and wired, and build this the same way. Match the surrounding conventions rather than inventing a new shape.',
  },
  {
    id: 'smallest-slice',
    instruction:
      'Build the narrowest version that genuinely works end to end — one path, no options, no generality — and get that running. Extend only once it does.',
  },
]

const REFACTOR_APPROACHES: Approach[] = [
  {
    id: 'mechanical',
    instruction:
      'Make the transformation mechanically and completely, changing shape without changing behaviour anywhere. The existing tests are the specification and they must stay green — if one needs editing to pass, you have changed behaviour and gone wrong.',
  },
  {
    id: 'callsites-first',
    instruction:
      'Enumerate every call site first and write them down before editing anything. Then change the definition, then work through the list. A refactor that misses a call site is the usual failure here.',
  },
]

const LOCATE_APPROACHES: Approach[] = [
  {
    id: 'by-symbol',
    instruction:
      'Search by name. Grep for the identifiers, file names, and strings involved, and follow the imports and call sites outward from the best hit.',
  },
  {
    id: 'by-behaviour',
    instruction:
      'Search by what the code must do rather than what it is called. Find where the behaviour is triggered — the error string, the route, the tool name, the config key — and trace inward from there.',
  },
]

const PLAN_APPROACHES: Approach[] = [
  {
    id: 'first-principles',
    instruction:
      'Start from the outcome, not the usual shape of the work. State what must be true when it is done and which constraints are real rather than assumed — check the doubtful ones — then plan only the steps those require, in the order they require them.',
  },
  {
    id: 'spine-first',
    instruction:
      'Find the thinnest path through the whole job that produces something real end to end, do that first, and only then thicken each part. Never build a layer whose consumer does not exist yet.',
  },
  {
    id: 'decompose-first',
    instruction:
      'Break the work into independently checkable pieces before touching anything, and say for each piece how you will know it is done. Then do them in dependency order.',
  },
]

export const APPROACHES_BY_CLASS: Record<TaskClass, Approach[]> = {
  repair: REPAIR_APPROACHES,
  implement: IMPLEMENT_APPROACHES,
  refactor: REFACTOR_APPROACHES,
  locate: LOCATE_APPROACHES,
  plan: PLAN_APPROACHES,
  explain: [],
}

/**
 * Classes where elia can write the check itself when the project has none.
 *
 * A repair has a reproduction — the failure is the check, and elia can turn it
 * into one before attempting a fix. New behaviour has a specification, which is
 * a test waiting to be written. A refactor has the behaviour that must not
 * change, which is a characterization test. What is missing from the list is
 * `locate` and `plan`: finding a thing and sequencing work have no artifact to
 * run, so for those, agreement really is all there is and pretending otherwise
 * would be the dishonest option.
 */
const CAN_WRITE_ITS_OWN_CHECK = new Set<TaskClass>(['repair', 'implement', 'refactor'])

/**
 * Builds the candidate harnesses for a signature.
 *
 * All of them share the same approach pool and differ only in how much of it
 * they buy, which is what makes the library's comparison meaningful — a
 * difference in outcome between `single` and `wide` is a difference in search
 * width, not in two unrelated prompts.
 */
export function harnessesFor(signature: TaskSignature): Harness[] {
  const approaches = APPROACHES_BY_CLASS[signature.taskClass]
  if (approaches.length === 0) return []

  const verifier: VerifierKind = signature.features.hasExecutableCheck
    ? 'project-tests'
    : CAN_WRITE_ITS_OWN_CHECK.has(signature.taskClass)
      ? 'synthesized-probe'
      : 'consensus'
  const allowUnverifiedStop = verifier === 'consensus'

  // Multi-file work spends most of a single attempt just orienting, so the wide
  // harnesses get a larger ceiling there — a budget set for a one-file fix
  // measures the budget rather than the reasoning.
  const depth = signature.features.multiFile ? 2 : 1

  const single: Harness = {
    id: 'single',
    width: 1,
    maxAttempts: 1,
    approaches: approaches.slice(0, 1),
    verifier,
    allowUnverifiedStop,
    effort: 'medium',
  }
  const wide: Harness = {
    id: 'wide',
    width: Math.min(3, approaches.length),
    maxAttempts: Math.min(3, approaches.length) + depth,
    approaches,
    verifier,
    allowUnverifiedStop,
    effort: 'medium',
  }
  const deep: Harness = {
    id: 'deep',
    width: Math.min(2, approaches.length),
    maxAttempts: Math.min(2, approaches.length) * (2 + depth),
    approaches,
    verifier,
    allowUnverifiedStop,
    effort: 'high',
  }

  return [single, wide, deep]
}

export function harnessById(signature: TaskSignature, id: string | undefined): Harness | undefined {
  const all = harnessesFor(signature)
  return all.find((harness) => harness.id === id) ?? all[0]
}
