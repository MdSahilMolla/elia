/**
 * The key a reasoning harness is filed under.
 *
 * `solve()` makes one task come out better. It only makes elia better if the
 * effort spent working out *how* to attack this task is still there the next
 * time a task like it arrives — and "a task like it" has to be a string you can
 * look up, or nothing accumulates. That string is what this file produces.
 *
 * The classes below are deliberately coarse. A signature that is too specific
 * never gets a second observation, so every measured harness stays at n=1 and
 * the library can never tell a real winner from a lucky one — which is the exact
 * failure that left 76 recorded lessons with none measurably helping. Six
 * classes crossed with four booleans is small enough that a working day of real
 * use puts several observations behind every cell that matters.
 *
 * Nothing here calls a model. Classification runs on every turn, including the
 * ones that turn out not to need a search at all, so it has to be free.
 */

/**
 * What kind of work this is, chosen for what it implies about *verification*
 * rather than what it implies about subject matter — because the verifier is the
 * only part of a harness that changes what elia can prove.
 */
export type TaskClass =
  /** Something is broken and a check already says so. The check is the verifier. */
  | 'repair'
  /** New behaviour to a spec. Nothing checks it yet, so the harness has to write the check first. */
  | 'implement'
  /** Change the shape, keep the behaviour. The existing suite is the verifier, and it must stay green. */
  | 'refactor'
  /** Find a thing — a symbol, a cause, a file. Verifiable only by going and looking. */
  | 'locate'
  /** Answer a question. No artifact, and usually nothing executable to run. */
  | 'explain'
  /** Many steps held together over time. Verified stepwise or not at all. */
  | 'plan'

export interface TaskFeatures {
  /** A test, build, or typecheck command exists that will pass judgement without a model. */
  hasExecutableCheck: boolean
  /** The request names concrete files or symbols — the search has somewhere to start. */
  namesTargets: boolean
  /** The change plainly spans more than one file. */
  multiFile: boolean
  /** The user stated what "done" means concretely enough to check against. */
  statesAcceptance: boolean
}

export interface TaskSignature {
  taskClass: TaskClass
  features: TaskFeatures
  /** The library key. Stable, coarse, and safe to put in a filename. */
  key: string
}

const REPAIR = /\b(?:fix|repair|broke(?:n)?|break(?:s|ing)|failing|fails?|crash(?:es|ing)?|error|bug|regress(?:ion|ed)|does\s?n[o']t\s+work|stopped\s+working|red\b|exception|stack\s?trace)\b/i
const REFACTOR = /\b(?:refactor|rename|extract|inline|restructure|reorganis|reorganiz|clean\s?up|tidy|simplify|deduplicate|move\s+(?:this|it|the)\b|split\s+(?:this|it|the)\b)\b/i
const IMPLEMENT = /\b(?:add|build|create|implement|write|generate|scaffold|introduce|support|make\s+(?:it|a|an|the)\b|set\s?up|wire\s?up|integrate|port|migrate)\b/i
const LOCATE = /\b(?:where|which\s+file|find|locate|search\s+for|look\s+for|grep|trace|track\s+down|figure\s+out\s+why|why\s+(?:is|does|did|are))\b/i
const EXPLAIN = /^\s*(?:what|what's|whats|why|how|when|who|explain|describe|summar(?:ise|ize)|tell\s+me|does|do|is|are|can|should|would)\b/i
const PLAN = /\b(?:plan|roadmap|end[-\s]?to[-\s]?end|whole|entire|across\s+the\s+(?:repo|codebase|project)|every\s+(?:file|module|call\s?site)|migrate\s+(?:the|all)|rewrite\s+the)\b/i

const NAMES_TARGETS = /(?:[\w./\\-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|py|rs|go|java|c|h|cc|cpp|hpp|css|html|yml|yaml|toml|sql|sh)\b)|(?:\b\w+\(\))|(?:`[^`]+`)/i
const MULTI_FILE = /\b(?:every|all|across|throughout|each)\b|\bcall\s?sites?\b|\bfiles\b|\bmodules\b|\bthe\s+(?:whole|entire)\b/i
const ACCEPTANCE = /\b(?:so\s+that|until|should\s+(?:return|be|pass|equal|match|produce)|must\s+(?:return|be|pass|equal|match|produce)|expects?\b|test(?:s)?\s+pass|make\s+(?:the\s+)?tests?\s+pass|green\b|exit\s+0)\b/i

/**
 * Which class the request falls into.
 *
 * Order matters and is not alphabetical. An opening question word decides first,
 * because it is the one signal that is never ambiguous about intent: "why does
 * the build fail?" asks for a cause and must not become a licence to start
 * editing, however much the sentence looks like a repair. A question that is
 * also about a failure is `locate` — go and find out — rather than `explain`.
 *
 * After that a failing check wins over the verb, since it is the one case where
 * a verifier already exists, so "fix the build so the rename lands" is `repair`
 * rather than `refactor`. What is left is sorted by how much of a verifier the
 * class implies.
 */
export function classify(request: string): TaskClass {
  const head = request.trim().slice(0, 600)
  if (EXPLAIN.test(head)) return LOCATE.test(head) || REPAIR.test(head) ? 'locate' : 'explain'
  if (REPAIR.test(head)) return 'repair'
  if (PLAN.test(head) && IMPLEMENT.test(head)) return 'plan'
  if (REFACTOR.test(head)) return 'refactor'
  if (IMPLEMENT.test(head)) return 'implement'
  if (LOCATE.test(head)) return 'locate'
  return 'explain'
}

export function extractFeatures(request: string, context: { hasExecutableCheck: boolean }): TaskFeatures {
  const head = request.trim().slice(0, 1_200)
  return {
    hasExecutableCheck: context.hasExecutableCheck,
    namesTargets: NAMES_TARGETS.test(head),
    multiFile: MULTI_FILE.test(head),
    statesAcceptance: ACCEPTANCE.test(head),
  }
}

/**
 * The library key.
 *
 * Only the two features that change which *harness* is right are in the key.
 * Whether a check exists decides whether the search can be ended by proof at
 * all, and whether the work spans files decides how much budget a single attempt
 * needs — those two earn their place. `namesTargets` and `statesAcceptance` are
 * kept on the signature because a producer should see them, but folding them in
 * too would quadruple the number of cells and starve every one of them.
 */
export function signatureKey(taskClass: TaskClass, features: TaskFeatures): string {
  return [taskClass, features.hasExecutableCheck ? 'checked' : 'unchecked', features.multiFile ? 'multi' : 'single'].join('/')
}

export function taskSignature(request: string, context: { hasExecutableCheck: boolean }): TaskSignature {
  const taskClass = classify(request)
  const features = extractFeatures(request, context)
  return { taskClass, features, key: signatureKey(taskClass, features) }
}

/**
 * Whether a task of this shape is worth more than one attempt.
 *
 * A search costs k times a single answer, so it has to be reserved for the work
 * where k attempts can actually be told apart. Two things rule it out: nothing
 * executable to check against (where extra attempts buy agreement, not
 * correctness), and a question that produces no artifact at all. Everything else
 * is eligible — the harness still decides how wide to go, and on an easy task
 * the first attempt passes and the rest is never bought.
 */
export function worthSearching(signature: TaskSignature): boolean {
  if (signature.taskClass === 'explain') return false
  if (!signature.features.hasExecutableCheck && signature.taskClass !== 'repair') return false
  return true
}
