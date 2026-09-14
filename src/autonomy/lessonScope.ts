import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Which lessons belong to this project, and which belong to this machine.
 *
 * Lessons live in each project's own `.elia/lessons.md`, so a fact about the
 * *environment* — that `ls` is not a command here, that this toolchain needs a
 * particular target, that a runtime is pinned — is learned painfully in one
 * repo and unavailable in the next one, where it is learned painfully again.
 * Those facts are true of the machine, not the repository, and they are the
 * ones most worth carrying across.
 *
 * The split is deliberately conservative. A project fact wrongly promoted to
 * the global store is worse than an environment fact left behind: it follows
 * the operator into unrelated repositories and asserts something false about
 * them. So a lesson is only global when it names a machine-level signal *and*
 * carries nothing that ties it to one codebase.
 */

/** `~/.elia/lessons.md`, or an explicit override — the same shape allowStore uses for its global file. */
export function globalLessonsPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return env.ELIA_GLOBAL_LESSONS_PATH || join(home, '.elia', 'lessons.md')
}

/**
 * Machine-level signals: an operating system, a shell, a toolchain, or an
 * explicit statement about "this machine".
 */
const ENVIRONMENT_SIGNAL =
  /\b(?:on\s+)?(?:windows|win32|macos|mac\s?os|darwin|linux|wsl|ubuntu)\b|\b(?:powershell|cmd\.exe|command prompt|bash|zsh|git\s?bash)\b|\b(?:this|the)\s+machine\b|\bPATH\b|\benvironment variable\b|\b(?:msvc|mingw|gnullvm|xcode|visual studio|clang|gcc)\b/i

/**
 * Signals that a lesson is about one codebase: a path, a file, a script, or a
 * word that only means something inside a repository. Any of these outweigh an
 * environment signal — "on Windows, run this repo's build.ps1 first" is a
 * project fact that happens to mention Windows.
 */
const PROJECT_SIGNAL =
  /[\w-]+\.(?:ts|tsx|js|jsx|json|md|ya?ml|toml|lock|rs|py|go|java|cpp|h|sh|ps1|sql)\b|[\w-]+\/[\w-]+|\b(?:this (?:repo|repository|project|codebase)|src\/|package\.json|tsconfig|Cargo\.toml|Makefile|docker-compose)\b|\bthe\s+\w+\s+(?:module|package|component|endpoint|migration|fixture)\b/i

export type LessonScope = 'project' | 'environment'

/**
 * Where a lesson belongs.
 *
 * A heuristic over the text, not a classification the model is asked for: a
 * weaker model asked to tag its own output tags it inconsistently, and an
 * inconsistent tag here silently writes project facts into every future repo.
 * Deterministic and testable is worth more than clever.
 */
export function lessonScope(text: string): LessonScope {
  if (PROJECT_SIGNAL.test(text)) return 'project'
  return ENVIRONMENT_SIGNAL.test(text) ? 'environment' : 'project'
}

/** Split a batch by where each lesson should be written. */
export function partitionByScope<T extends { text: string }>(lessons: T[]): { project: T[]; environment: T[] } {
  const project: T[] = []
  const environment: T[] = []
  for (const lesson of lessons) {
    if (lessonScope(lesson.text) === 'environment') environment.push(lesson)
    else project.push(lesson)
  }
  return { project, environment }
}
