import type { ProjectChecks } from './reason.ts'
import { taskSignature, worthSearching } from './signature.ts'
import type { TaskSignature } from './signature.ts'

/**
 * Whether to answer this turn by searching, decided before the turn runs.
 *
 * This lives here rather than inside the REPL because it is the decision that
 * spends the user's money. Buried in a closure in index.ts it would be
 * unreachable from a test, and "it typechecks and the call site exists" is not
 * evidence that a thing works — this codebase has already shipped a set of
 * self-improvement gates that were all reachable, all green, and all vacuous.
 *
 * It calls no model. `detectChecks` has already looked at the project manifest;
 * everything else is regexes over the request.
 */

export interface SearchDecision {
  /** Present only when the turn should be searched. */
  plan?: { signature: TaskSignature; checks: ProjectChecks }
  /** Why, in the words the `/search` command prints. Always set. */
  why: string
}

/**
 * Splits the project's detected commands into the cheap structural one and the
 * one that actually runs the code.
 *
 * Order matters in the test match: a `typecheck` script mentioning "test" in its
 * name would otherwise be picked as the test command, and the search would then
 * believe it had executed proof when all it had was a compiler.
 */
export function splitChecks(detected: string[]): ProjectChecks {
  const build = detected.find((command) => /\b(?:tsc|typecheck|type-check|build|compile)\b/i.test(command))
  const test = detected.find((command) => command !== build && /\b(?:test|spec|jest|vitest|pytest)\b/i.test(command))
  return { build, test }
}

/**
 * A request for a standalone web artifact — a page, a game, a site — rather
 * than a change to the project elia is running in.
 *
 * `htm`/`html` counts on its own because the medium is the giveaway and the
 * nouns are the first thing a hurried request misspells ("a sticky man gamme in
 * htm"). Guarded by `namesTargets` at the call site, so a genuine repo task that
 * happens to mention HTML ("fix the html escaping in render.ts") is untouched.
 */
const STANDALONE_ARTIFACT =
  /\b(?:web\s?site|web\s?page|webpage|landing\s+page|portfolio|game|demo|static\s+site|single[-\s]file|htm|html)\b/i

/**
 * Whether the project's checks would exercise what this request produces.
 *
 * signature.ts already draws this line for `locate` and `plan` work — those
 * "change nothing the checks exercise, so they would pass for every attempt and
 * prove nothing" — but it draws it by task class, and an `implement` request is
 * always assumed to land in the checked project. It does not always. Asked to
 * build a stick-man game in the elia repo, the search planned to judge every
 * attempt by `bun run typecheck` and `bun run test`: a suite that exercises
 * elia's own source, says nothing whatever about a page in `workspace/`, and
 * passes identically for all k candidates. The winner is then chosen by nothing
 * at all, after ~200s per attempt — which is the exact failure signature.ts
 * calls "worse than no verifier, because it launders a guess into a verdict".
 *
 * Deliberately narrow: it takes a standalone-artifact word *and* the absence of
 * any named file or symbol to decline, so ordinary feature work in the project
 * keeps searching.
 */
export function checksCoverTheWork(request: string, signature: TaskSignature): boolean {
  if (signature.taskClass !== 'implement') return true
  if (signature.features.namesTargets) return true
  return !STANDALONE_ARTIFACT.test(request.trim().slice(0, 1_200))
}

export function decideSearch(request: string, detected: string[]): SearchDecision {
  const checks = splitChecks(detected)
  const hasExecutableCheck = Boolean(checks.test || checks.build)
  const signature = taskSignature(request, { hasExecutableCheck })

  if (!checksCoverTheWork(request, signature)) {
    return {
      why: 'this builds something standalone that the project\'s own checks do not exercise, so they would pass for every attempt and choose the winner by nothing',
    }
  }

  if (!worthSearching(signature)) {
    // Three different reasons to decline, and they are worth distinguishing:
    // the last one is the only one a project could fix by adding a test suite.
    const why =
      signature.taskClass === 'explain'
        ? 'this reads as a question, and a second attempt at an answer cannot be told apart from the first'
        : signature.taskClass === 'locate' || signature.taskClass === 'plan'
          ? `${signature.taskClass} work changes nothing the checks exercise, so they would pass for every attempt and prove nothing`
          : `${signature.taskClass} work with nothing executable to check — extra attempts would buy agreement, not correctness`
    return { why }
  }
  return {
    plan: { signature, checks },
    why: hasExecutableCheck
      ? `${signature.taskClass} work, checked by: ${[checks.build, checks.test].filter(Boolean).join(', ')}`
      : `${signature.taskClass} work — elia will write the check before attempting it`,
  }
}
