// When someone types "build me an end-to-end attendance system" into the plain
// REPL, the ordinary agent loop tries to wing a twenty-file project in a handful
// of turns — no decomposition, no parallel workers, no adversarial review, no
// resumable goal graph. That is the gap between elia's default experience and
// `elia auto`, and it is exactly what produced the broken scaffold runs.
//
// This classifier decides, from the first line of a request, whether the task is
// large enough to route through the autonomous pipeline instead. It is
// deliberately conservative: a false positive drags a small edit through a
// plan-and-approve cycle, so anything that reads like "change this one thing"
// stays on the fast path.

export interface EscalationDecision {
  escalate: boolean
  /** Shown to the user on the one-line "planning this properly" notice. */
  reason: string
}

const BUILD_VERB =
  /\b(build|create|implement|scaffold|develop|set[-\s]?up|stand[-\s]?up|make\s+(?:me\s+)?a|write\s+(?:me\s+)?a|generate\s+a|bootstrap|design\s+and\s+build|i\s+(?:want|need|would\s+like|'d\s+like)\s+(?:a|an|to\s+build|to\s+create)|need\s+(?:a|an)\b)\b/i

const PROJECT_NOUN =
  /\b(app|application|system|platform|dashboard|web[-\s]?site|web[-\s]?app|service|micro[-\s]?service|back[-\s]?end|front[-\s]?end|full[-\s]?stack|clone|mvp|prototype|portal|saas|pipeline|crud|game|bot|cli|library|sdk|api|rest\s+api|graphql\s+api|marketplace|e-?commerce|blog\s+engine|chat\s+app)\b/i

/** Phrases that signal "a whole project", verb or not. */
const WHOLE_PROJECT = /\b(end[-\s]?to[-\s]?end|from\s+scratch|full[-\s]?stack|greenfield|ground\s?up|production[-\s]?ready\s+(?:app|system|service))\b/i

/** Openers that mean "modify what exists" — never a fresh build. */
const SMALL_TASK_OPENER =
  /^\s*(?:please\s+)?(?:fix|add\s+(?:a|an|the)\b|update|tweak|adjust|rename|remove|delete|refactor|revert|bump|patch|why|what|what's|whats|how|where|when|explain|describe|show|list|find|search|look|check|investigate|debug|diagnose|review|audit|summar|document|comment|test\s+the|run\s+the|make\s+the\s+\S+\s+(?:pass|green))\b/i

/** A question, not a work order. */
const QUESTION = /^\s*(?:can|could|does|do|is|are|should|would|will|has|have|which|who)\b.*\?\s*$/i

/** Named an existing file/path — a targeted change, not a new project. */
const FILE_REFERENCE = /(?:^|\s)[\w./-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|c|cc|cpp|h|hpp|rb|php|css|scss|html|json|ya?ml|toml|md|sql)(?:\b|$)/i

/** "with X, Y, and Z" — a feature list attached to a build ask. */
const FEATURE_LIST = /\b(with|including|plus|and)\b[^.]*\b(auth|authentication|login|database|db|payments?|stripe|dashboard|admin|api|crud|search|notifications?|roles?|rbac|uploads?|charts?|reports?)\b/i

export function classifyEscalation(rawText: string): EscalationDecision {
  const text = rawText.trim()
  const firstLine = text.split(/\r?\n/, 1)[0] ?? text
  const no = (reason: string): EscalationDecision => ({ escalate: false, reason })
  const yes = (reason: string): EscalationDecision => ({ escalate: true, reason })

  if (text.length < 25) return no('too short to be a project')
  if (QUESTION.test(firstLine)) return no('a question, not a build task')
  if (SMALL_TASK_OPENER.test(firstLine)) return no('reads as a targeted change')
  // A concrete file target usually means "change this file", unless the request
  // is unmistakably a whole project that happens to mention a config file.
  if (FILE_REFERENCE.test(text) && !WHOLE_PROJECT.test(text)) return no('targets a specific file')

  if (WHOLE_PROJECT.test(text)) return yes('a full project build')
  if (BUILD_VERB.test(text) && PROJECT_NOUN.test(text)) return yes('building a new project')
  if (BUILD_VERB.test(firstLine) && FEATURE_LIST.test(text)) return yes('a multi-feature build')

  return no('no strong new-project signal')
}
