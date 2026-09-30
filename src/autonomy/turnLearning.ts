import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ChatMessage, ContentBlock, Provider, Usage } from '../providers/types.ts'
import { redactSecrets } from '../ui/redact.ts'
import { addUsage } from '../usage.ts'
import { appendLessons, loadLessons } from './lessons.ts'
import type { VerifyResult } from './outcomes.ts'
import { lessonHygieneProblem } from './lessonCertificates.ts'

/**
 * What elia brings into a turn from earlier sessions, and what it takes away.
 *
 * Both halves used to be invisible. Every turn silently carried the project's
 * lessons, recorded rationale, and weak-area warnings in a hidden system-prompt
 * block, and nothing on screen said so. And interactive work almost never
 * learned anything: `note_lesson` is voluntary, mercury-2.5 called it once in
 * 562 tool calls, and 8 of the 9 lessons this project held came from `elia auto`
 * runs. The fumbles most worth remembering — `ls` failing on Windows until `dir`
 * worked, a build failing until its config was fixed — happened in interactive
 * turns and were forgotten by the next session.
 */

// --- Going in: a one-line receipt of what the turn is drawing on ---------------

export interface RecalledMemory {
  /** Lessons injected into this turn's prompt. */
  lessons: number
  /** `renderRationale` output — one `- ` line per recorded decision. */
  rationale: string
  /** `renderCards` output — one `### path` block per file with past knowledge. */
  brainCards: string
  /** `weakDomainCaution` output, empty unless this turn is in a weak area. */
  weakCaution: string
  /** `regretNudge` output, empty unless the previous turn hit friction. */
  regretNudge: string
}

/**
 * "✦ memory · 9 lessons · weak area: config 29% clean", or undefined when the
 * turn is drawing on nothing. The ✦ prefix is what the terminal renders as a
 * learning line, in accent colour, durable in scrollback.
 */
export function memoryReceipt(memory: RecalledMemory): string | undefined {
  const bits: string[] = []
  if (memory.lessons > 0) bits.push(`${memory.lessons} lesson${memory.lessons === 1 ? '' : 's'} from earlier sessions`)
  const decisions = memory.rationale.split('\n').filter((line) => line.startsWith('- ')).length
  if (decisions > 0) bits.push(`${decisions} recorded design decision${decisions === 1 ? '' : 's'}`)
  const files = memory.brainCards.split('\n').filter((line) => line.startsWith('### ')).length
  if (files > 0) bits.push(`past knowledge of ${files} file${files === 1 ? '' : 's'}`)
  const weak = /landed (.+?) in the area/.exec(memory.weakCaution)?.[1]
  if (weak) bits.push(`weak area here (${weak}) — taking extra care`)
  const rough = /hit friction \((.+?)\)/.exec(memory.regretNudge)?.[1]
  if (rough) bits.push(`last turn hit friction (${rough})`)
  if (bits.length === 0) return undefined
  return `✦ memory · ${bits.join(' · ')}`
}

// --- Coming out: learning from a turn that went wrong and was put right --------

/** A tool call that failed and a later call of the same tool that worked. */
export interface ResolvedFailure {
  failed: string
  error: string
  fixedBy: string
}

/** A tool call that failed and was never made to work in this turn. */
export interface UnresolvedFailure {
  failed: string
  error: string
}

export interface TurnEvidence {
  failures: ResolvedFailure[]
  /** elia's "your checks fail" / "the page does not render" messages from a repair loop. */
  checkFailures: string[]
  /**
   * What broke and stayed broken. A turn that ends still failing is the single
   * richest signal there is — it is the case where elia demonstrably did not
   * know something — and it used to be discarded entirely: `worthLearningFrom`
   * returns false the moment verification failed, so the run that most needed
   * to teach the next one taught it nothing. These do not become "the fix is
   * X" lessons (nobody has verified a fix yet); they become constraints.
   */
  unresolved?: UnresolvedFailure[]
}

const MAX_FAILURES = 6

/**
 * Not something the project taught: an approval the operator withheld, a
 * policy block, or an edit that missed its target text (a slip in the model's
 * own copy of the file, not a fact about the project).
 */
export const NOT_A_PROJECT_FACT =
  /\b(?:denied|declined|rejected|not approved|blocked by|requires approval|old_string|not found in the file|appears \d+ times|not unique)\b/i

/** Tools whose failures say nothing durable about the project. */
export const SLIP_TOOLS = new Set(['edit_file', 'write_file', 'todo_write', 'note_lesson', 'task'])

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function describeCall(block: Extract<ContentBlock, { type: 'tool_use' }>): string {
  const target = ['command', 'path', 'program', 'url', 'query']
    .map((key) => block.input[key])
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
  return target ? `${block.name} ${clip(target, 160)}` : block.name
}

/**
 * The mechanical record of what broke and what fixed it, read straight from the
 * turn's own messages — real tool output, not the model's account of it.
 */
export function turnEvidence(messages: ChatMessage[], fromIndex: number): TurnEvidence {
  const calls = new Map<string, Extract<ContentBlock, { type: 'tool_use' }>>()
  const open: { tool: string; failed: string; error: string }[] = []
  const failures: ResolvedFailure[] = []
  const checkFailures: string[] = []
  for (const message of messages.slice(fromIndex)) {
    for (const block of message.content) {
      if (block.type === 'tool_use') {
        calls.set(block.id, block)
      } else if (block.type === 'tool_result') {
        const call = calls.get(block.tool_use_id)
        if (!call || SLIP_TOOLS.has(call.name)) continue
        if (block.is_error) {
          if (!NOT_A_PROJECT_FACT.test(block.content)) open.push({ tool: call.name, failed: describeCall(call), error: clip(block.content, 300) })
          continue
        }
        const index = open.findIndex((failure) => failure.tool === call.name)
        if (index >= 0) {
          const [failure] = open.splice(index, 1)
          failures.push({ failed: failure!.failed, error: failure!.error, fixedBy: describeCall(call) })
        }
      } else if (block.type === 'text' && message.role === 'user' && /^(?:The project's checks fail|The page you just built does not render)/.test(block.text)) {
        checkFailures.push(clip(block.text, 800))
      }
    }
  }
  // Whatever is still `open` never found a working call: these are the turn's
  // unresolved failures.
  return {
    failures: failures.slice(0, MAX_FAILURES),
    checkFailures: checkFailures.slice(-2),
    unresolved: open.slice(0, MAX_FAILURES).map(({ failed, error }) => ({ failed, error })),
  }
}

export interface TurnOutcomeSignal {
  verify: VerifyResult
  repairAttempts: number
}

/**
 * Whether this turn can teach an *instruction*: friction that was mechanically
 * put right, so the fix is known — a tool call that failed and then worked, or
 * checks that failed and then passed. That is the same line `elia auto` draws
 * (loop.ts captureLessons). A turn that ended still broken does not qualify
 * here, because nobody knows the fix yet; `learningMode` routes it to `blocker`
 * so it still teaches the constraint.
 */
export function worthLearningFrom(evidence: TurnEvidence, outcome: TurnOutcomeSignal): boolean {
  if (outcome.verify === 'fail') return false
  const repairedChecks = outcome.repairAttempts > 0 && outcome.verify === 'pass' && evidence.checkFailures.length > 0
  return evidence.failures.length > 0 || repairedChecks
}

/**
 * What, if anything, this turn can teach.
 *
 * `repair` — something broke and was mechanically put right, so the fix is
 * known and can be stated as an instruction.
 *
 * `blocker` — the turn ended still failing. No fix is known, so nothing may be
 * phrased as one; what *is* known is that a specific approach does not work
 * here, which is exactly what stops the next session repeating it. These carry
 * a lower confidence and their own source tag so lesson-efficacy retirement
 * prunes them first if they turn out not to help.
 */
export function learningMode(evidence: TurnEvidence, outcome: TurnOutcomeSignal): 'repair' | 'blocker' | undefined {
  if (worthLearningFrom(evidence, outcome)) return 'repair'
  const stuck = (evidence.unresolved?.length ?? 0) > 0 || evidence.checkFailures.length > 0
  return outcome.verify === 'fail' && stuck ? 'blocker' : undefined
}

export function reflectionPrompt(request: string, evidence: TurnEvidence, known: string[]): string {
  const lines = [
    `The user asked: ${clip(request, 400)}`,
    '',
    'During this turn something failed and was then made to work. This is the real tool output:',
  ]
  for (const failure of evidence.failures) {
    lines.push(`✗ ${failure.failed}`, `  → ${failure.error}`, `✓ then worked: ${failure.fixedBy}`)
  }
  for (const check of evidence.checkFailures) lines.push(`✗ project checks failed, then passed after a fix:`, `  ${check}`)
  if (known.length > 0) {
    lines.push('', 'Already known about this project (do not repeat or rephrase these):', ...known.map((lesson) => `- ${lesson}`))
  }
  lines.push(
    '',
    'Write at most 2 lessons that a future session in this same project should know before it starts, so it never hits this again. Only durable facts about this project or its environment: how a command has to be run here, where something lives, a constraint that is not obvious from the code. One sentence each, phrased as an instruction to a future run. Never describe what this turn did, and never give generic advice ("read files carefully", "test your changes"). A file, folder, or module that was not found is a fact to record, never something a future run should create to make the error go away. If these were simple slips with nothing durable to learn, return an empty list.',
    '',
    'Reply with JSON only: {"lessons": ["..."]}',
  )
  return lines.join('\n')
}

/**
 * The prompt for a turn that ended still broken. Deliberately does not ask for
 * a fix: no fix was verified, and a lesson that asserts an unverified one is
 * worse than no lesson — it sends the next session confidently down the same
 * dead end. It asks for the constraint instead.
 */
export function blockerPrompt(request: string, evidence: TurnEvidence, known: string[]): string {
  const lines = [
    `The user asked: ${clip(request, 400)}`,
    '',
    'This turn ended without getting it working. This is the real tool output for what failed and was never made to work:',
  ]
  for (const failure of evidence.unresolved ?? []) lines.push(`✗ ${failure.failed}`, `  → ${failure.error}`)
  for (const check of evidence.checkFailures) lines.push('✗ the project checks were still failing at the end:', `  ${check}`)
  if (known.length > 0) {
    lines.push('', 'Already known about this project (do not repeat or rephrase these):', ...known.map((lesson) => `- ${lesson}`))
  }
  lines.push(
    '',
    'Write at most 2 lessons recording what a future session in this same project should know *before* it tries this again. Nobody has found a working fix, so do NOT state one, do not guess a cause, and do not say "try X instead" unless the output above proves X works. Record only what the output establishes: which exact command, path, tool, or approach fails here, and the error it fails with. One sentence each, phrased as a warning to a future run. If the output shows nothing durable — a transient network blip, an approval the operator withheld, a one-off typo — return an empty list.',
    '',
    'Reply with JSON only: {"lessons": ["..."]}',
  )
  return lines.join('\n')
}

const STOPWORDS = new Set([
  'a', 'an', 'the', 'on', 'in', 'of', 'to', 'for', 'with', 'from', 'into', 'at', 'by', 'as', 'and', 'or', 'not', 'no',
  'use', 'using', 'instead', 'always', 'never', 'must', 'should', 'be', 'is', 'are', 'it', 'its', 'this', 'that', 'these',
  'run', 'when', 'before', 'after', 'here', 'project', 'you', 'your',
])

/** The content words of a lesson — command names like `ls` included, filler excluded. */
function words(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z0-9_./-]{2,}/g) ?? []).map((word) => word.replace(/[.,;:]+$/, '')).filter((word) => word && !STOPWORDS.has(word)))
}

/**
 * How far one lesson's content words are covered by the other's — "On Windows,
 * list directories with dir, not ls" and "On Windows use dir instead of ls to
 * list directories" are the same lesson in different words.
 */
export function similarity(a: string, b: string): number {
  const left = words(a)
  const right = words(b)
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const word of left) if (right.has(word)) shared += 1
  return shared / Math.min(left.size, right.size)
}

// --- Grounding: a lesson may only name what the turn or the repo shows exists ---

/**
 * What the turn's own tool calls establish: every input the model sent and every
 * result that came back, lower-cased with backslashes folded to `/` so a Windows
 * path in an error matches the same path in a lesson. Nothing anyone *said* is in
 * it — a name that has only ever appeared in a claim is exactly what a lesson
 * must not be built on.
 */
export function turnSupport(messages: ChatMessage[], fromIndex: number): string {
  const parts: string[] = []
  for (const message of messages.slice(fromIndex)) {
    for (const block of message.content) {
      if (block.type === 'tool_use') parts.push(...Object.values(block.input).map((value) => (typeof value === 'string' ? value : JSON.stringify(value))))
      else if (block.type === 'tool_result') parts.push(block.content)
    }
  }
  return parts.join('\n').toLowerCase().replace(/\\+/g, '/')
}

/** `NODE_ENV`, or the name in `CI=true` — not an acronym like `JSON`. */
const NAMED_ENV_VAR = /(?<![\w-])[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+(?![\w-])|(?<![\w-])[A-Z][A-Z0-9]+(?==[^\s=])/g
/** `--frozen-lockfile` or `-p`, with any `=value` left off. */
const NAMED_FLAG = /^(--[a-z][\w-]*|-[a-zA-Z])(?:=.*)?$/
/** A code span of several words, `bun test`, names the command `bun`; one word could as well be an identifier. */
const CODE_COMMAND = /`([a-z][a-z0-9.+-]*)\s+[^`]+`/g
/** Without `js` on a bare name: `Node.js` is a runtime, not a file. It counts once a directory comes before it. */
const FILE_EXTENSIONS = 'json|ya?ml|toml|ini|cfg|conf|lockb?|sql|sh|py|rs|go|mjs|cjs|jsx|tsx?|md|txt|xml|html|css'
const BARE_FILE = new RegExp(`^[\\w@-][\\w@.-]*\\.(?:${FILE_EXTENSIONS})$`, 'i')
const FILE_IN_DIRECTORY = new RegExp(`/[\\w@.-]+\\.(?:${FILE_EXTENSIONS}|js)$`, 'i')
/** A path that is unmistakably one without an extension: rooted or explicitly relative. `/b` is a switch, not a path. */
const ANCHORED_PATH = /^(?:\.{1,2}\/|~\/|\/[\w@.-]{2,})/

function namesPath(token: string): boolean {
  if (!/^[\w@./~-]+$/.test(token)) return false
  return token.includes('/') ? ANCHORED_PATH.test(token) || FILE_IN_DIRECTORY.test(token) : BARE_FILE.test(token)
}

/** Whether `word` appears in `support` as a word of its own; `joiners` are the characters that would make it part of a longer one. */
function seenAsWord(support: string, word: string, joiners: string): boolean {
  const escaped = word.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![\\w${joiners}])${escaped}(?![\\w${joiners}])`).test(support)
}

/**
 * The first file path, environment variable, flag or command a lesson names that
 * neither the turn's tool calls (`turnSupport`) nor the repo back up, or
 * `undefined` when it names nothing it cannot account for.
 *
 * Seen live: a one-shot run in a repo of four files learned "ensure
 * config/order_limits.yml is present at /app/config" and "set
 * ORDER_LIMIT_CHECK=true before running the tests". Neither existed anywhere;
 * the reflection model had filled in what a lesson about an order limit ought to
 * mention, and every later prompt would have carried both as fact. The check is
 * narrow on purpose: it looks only at names that are unmistakably one of those
 * things, and a lesson that names none of them passes.
 */
export function ungroundedReference(lesson: string, support: string, cwd: string): string | undefined {
  const text = lesson.replace(/\\+/g, '/')
  const tokens = text
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' ')
    .split(/[\s`'"(),;<>[\]{}]+/)
    .map((token) => token.replace(/[.:!?]+$/, ''))
  const seen = (name: string) => support.includes(name.toLowerCase())
  for (const name of text.match(NAMED_ENV_VAR) ?? []) if (!seen(name)) return name
  for (const token of tokens) {
    const path = token.replace(/^[A-Za-z]:(?=\/)/, '').replace(/:\d+(?::\d+)?$/, '')
    if (namesPath(path) && !seen(path.replace(/^\.\//, '')) && !existsSync(resolve(cwd, path))) return path
  }
  for (const token of tokens) {
    const flag = NAMED_FLAG.exec(token)?.[1]
    if (flag && !seenAsWord(support, flag, '-')) return flag
  }
  for (const [, command] of text.matchAll(CODE_COMMAND)) if (!seenAsWord(support, command!, '')) return command
  return undefined
}

/**
 * Lessons out of the model's reply, minus anything generic, malformed, or already
 * known, and anything `accept` refuses. `accept` runs before the cap, so a lesson
 * it refuses does not use up one of the two places.
 */
export function parseLessons(reply: string, known: string[], accept?: (lesson: string) => boolean): string[] {
  const start = reply.indexOf('{')
  const end = reply.lastIndexOf('}')
  if (start < 0 || end <= start) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(reply.slice(start, end + 1))
  } catch {
    return []
  }
  const raw = (parsed as { lessons?: unknown }).lessons
  if (!Array.isArray(raw)) return []
  const kept: string[] = []
  for (const entry of raw) {
    if (typeof entry !== 'string') continue
    const lesson = entry.replace(/\s+/g, ' ').trim()
    // The same hygiene check the certified library admits every lesson by —
    // generic advice, and instructions to fabricate what is missing, never land.
    if (lesson.length < 20 || lesson.length > 280 || lessonHygieneProblem(lesson)) continue
    if (accept && !accept(lesson)) continue
    if ([...known, ...kept].some((existing) => similarity(existing, lesson) >= 0.7)) continue
    kept.push(lesson)
    if (kept.length === 2) break
  }
  return kept
}

export interface LearnFromTurnOptions {
  provider: Provider
  /** The whole conversation; the turn being learned from starts at `fromIndex`. */
  messages: ChatMessage[]
  fromIndex: number
  request: string
  outcome: TurnOutcomeSignal
  cwd: string
  signal?: AbortSignal
  lessonsPath?: string
  timeoutMs?: number
  /** Called only when there is something worth reflecting on, just before the model call — for a status line. */
  onReflecting?: () => void
  /**
   * What to record as each lesson's origin. Defaults to the interactive turn's
   * tags. A caller elsewhere — a sub-agent, say — passes its own so that
   * lesson-efficacy retirement can prune one origin ahead of another rather
   * than treating every auto-written lesson as the same kind of evidence.
   */
  sources?: { repair: string; blocker: string }
  /**
   * What a person typed this turn — without pasted editor context or command
   * output — so a correction in it can set a standing rule. Absent for a
   * sub-agent, whose request is another model's prompt.
   */
  userWords?: string
}

export interface LearnedFromTurn {
  lessons: string[]
  usage?: Usage
}

// --- Learning from the user: a correction becomes a standing rule -------------

/**
 * Past this length a message is a task description, not a correction: a spec
 * that says "never use any" is about the code being written, not about elia.
 */
const MAX_CORRECTION_LENGTH = 1_500

/**
 * The phrasings of a correction meant to outlast the turn — "stop adding
 * comments", "we use bun here", "from now on ask before pushing", "too
 * verbose". Deterministic and deliberately wide: a message that matches costs
 * one fast-tier call, which returns nothing when the message only steered this
 * one task. A correction that is missed is repeated by the user in every
 * session from then on.
 */
const STANDING_CORRECTION = new RegExp(
  [
    /\b(?:from now on|going forward|in (?:the )?future|next time|every time|each time|whenever you)\b/,
    /\b(?:i|we)(?:'ve| have)? (?:already )?(?:told|asked) you\b|\bhow many times\b|\bnever again\b|\b(?:don'?t|do not) ever\b/,
    /\b(?:remember|keep in mind) (?:that|this|to)\b/,
    /\b(?:i|we) (?:prefer|would rather|'d rather|hate (?:it )?when|don'?t like (?:it )?when|want you to (?:always|never))\b/,
    /\b(?:always|never) (?:use|run|call|write|add|put|commit|push|ask|reply|answer|explain|format|include|touch|edit|delete|remove|install|create|open|mock|skip)\b/,
    /\b(?:stop|quit) (?:using|running|adding|writing|creating|putting|explaining|summari[sz]ing|formatting|asking|touching|committing|pushing|installing|apologi[sz]ing|repeating|guessing|mocking|skipping|ignoring|changing|editing|deleting|removing)\b/,
    /\b(?:please )?(?:don'?t|do not) (?:use|add|commit|push|install|mock|reformat)\b/,
    /\b(?:we|i|this (?:repo|repository|project|codebase|team)) (?:use|uses|only use|don'?t use|doesn'?t use|never use)\b/,
    /\buse\b[^.?!\n]{1,40}\binstead\b|\binstead of\b[^.?!\n]{1,40}\buse\b/,
    /\btoo (?:verbose|long|wordy|chatty)\b|\b(?:be|keep it) (?:brief|short|concise|terse)\b/,
  ]
    .map((pattern) => pattern.source)
    .join('|'),
  'i',
)

/** Whether a user's message reads as a correction meant to hold beyond this turn. */
export function isStandingCorrection(message: string): boolean {
  const text = message.trim()
  return text.length > 0 && text.length <= MAX_CORRECTION_LENGTH && STANDING_CORRECTION.test(text)
}

/** What elia said just before the turn that starts at `fromIndex` — what a correction is usually about. */
function previousReply(messages: ChatMessage[], fromIndex: number): string | undefined {
  for (let index = fromIndex - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'assistant') continue
    const text = message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join(' ')
    if (text.trim()) return clip(redactSecrets(text), 600)
  }
  return undefined
}

/**
 * Asks for the rule a correction sets, not an account of it. The user's words
 * are the evidence, so this is the one lesson prompt that needs no tool output
 * — and the one where saying nothing is the right answer most often: most
 * matching messages only steer the task in hand.
 */
export function correctionPrompt(request: string, previous: string | undefined, known: string[]): string {
  const lines = ['The user just said this to elia, the coding agent working in this project:', `> ${clip(redactSecrets(request), 800)}`]
  if (previous) lines.push('', 'It was in reply to this from elia:', `> ${previous}`)
  if (known.length > 0) {
    lines.push('', 'Already known about this project (do not repeat or rephrase these):', ...known.map((lesson) => `- ${lesson}`))
  }
  lines.push(
    '',
    "If the user is setting a rule for how elia should work from now on — a tool or command to use or avoid, a convention to follow, how to format a reply or how long to make it, something to always ask before doing — write it as at most 2 rules a future session must follow, so the user never has to say it again. One imperative sentence each, with the user's reason as a short clause only if they gave one. State the rule itself: no quotes, no \"the user said\", no account of this conversation, and nothing the user did not ask for.",
    'Return an empty list when the message only steers this one task ("not that file, the other one", "try again"), disputes a fact rather than setting a rule, or leaves unclear what the rule would be. A wrong rule is followed on every future turn; a missing one costs the user one sentence.',
    '',
    'Reply with JSON only: {"lessons": ["..."]}',
  )
  return lines.join('\n')
}

const REFLECTION_SYSTEM = "You are elia's long-term memory for one software project. You distil hard-won, durable facts from real tool output. Reply with JSON only."
const CORRECTION_SYSTEM = "You are elia's long-term memory for one software project. You turn a user's correction into a standing rule elia follows in every later session. Reply with JSON only."

/** One lesson-writing call. Never throws: a failed call learns nothing. */
async function distil(options: LearnFromTurnOptions, system: string, prompt: string, known: string[], signal: AbortSignal, accept?: (lesson: string) => boolean): Promise<LearnedFromTurn> {
  try {
    const result = await options.provider.streamTurn({
      cwd: options.cwd,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      tools: [],
      onText: () => {},
      signal,
      reasoningEffort: 'low',
    })
    const reply = result.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')
    return { lessons: parseLessons(reply, known, accept), usage: result.usage }
  } catch {
    return { lessons: [] }
  }
}

/**
 * Turns what a finished turn can teach into at most a few durable lessons,
 * written to `.elia/lessons.md` where every later turn's prompt picks them up.
 *
 * Two sources. A mechanically resolved failure (source `interactive-auto`, or
 * `interactive-blocker` for one never resolved), which lesson-efficacy tracking
 * can retire if it does not help. And a correction in what the person typed
 * (`userWords`) that sets a standing rule (source
 * `user-correction`), which is injected on every turn and never retired — see
 * `isUserStated`. Never throws; learning is a bonus on a finished turn.
 */
export async function learnFromTurn(options: LearnFromTurnOptions): Promise<LearnedFromTurn> {
  const evidence = turnEvidence(options.messages, options.fromIndex)
  const mode = learningMode(evidence, options.outcome)
  const userWords = options.userWords ?? ''
  const correction = isStandingCorrection(userWords)
  if (!mode && !correction) return { lessons: [] }
  const known = loadLessons(options.lessonsPath).map((lesson) => lesson.text)
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 20_000)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  options.onReflecting?.()

  const learned: string[] = []
  let usage: Usage | undefined
  const tally = (spent: Usage | undefined) => {
    if (spent) usage = usage ? addUsage(usage, spent) : spent
  }

  // The user's rule first: it is the stronger evidence, and a failure lesson
  // that restates it is then deduplicated against it rather than the reverse.
  if (correction) {
    const rules = await distil(options, CORRECTION_SYSTEM, correctionPrompt(userWords, previousReply(options.messages, options.fromIndex), known), known, signal)
    tally(rules.usage)
    // A rule is injected into every later prompt, so one that carries a
    // credential ("remember the staging password is …") is never kept.
    const kept = rules.lessons.filter((rule) => redactSecrets(rule) === rule)
    if (kept.length > 0) appendLessons(kept.map((text) => ({ text, source: 'user-correction', confidence: 0.9 })), options.lessonsPath)
    learned.push(...kept)
  }

  if (mode) {
    const already = [...known, ...learned]
    const prompt = mode === 'repair' ? reflectionPrompt(options.request, evidence, already) : blockerPrompt(options.request, evidence, already)
    // Every later prompt carries a lesson as fact, so one that names a file,
    // variable, command or flag nothing in this turn touched — the model filled
    // it in — is dropped here, before it is stored or shown. A user's rule is
    // judged by their own words, not by tool output, so it is not held to this.
    const support = turnSupport(options.messages, options.fromIndex)
    const facts = await distil(options, REFLECTION_SYSTEM, prompt, already, signal, (lesson) => ungroundedReference(lesson, support, options.cwd) === undefined)
    tally(facts.usage)
    if (facts.lessons.length > 0) {
      // A blocker lesson records an unverified constraint, not a proven fix, so
      // it enters with lower confidence and its own source — lesson-efficacy
      // retirement can then drop it ahead of lessons that were earned by a
      // failure actually being put right.
      const tags = options.sources ?? { repair: 'interactive-auto', blocker: 'interactive-blocker' }
      const source = mode === 'repair' ? tags.repair : tags.blocker
      const confidence = mode === 'repair' ? 0.7 : 0.4
      appendLessons(facts.lessons.map((text) => ({ text, source, confidence })), options.lessonsPath)
    }
    learned.push(...facts.lessons)
  }
  return { lessons: learned, usage }
}
