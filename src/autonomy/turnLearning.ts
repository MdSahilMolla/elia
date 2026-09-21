import type { ChatMessage, ContentBlock, Provider, Usage } from '../providers/types.ts'
import { appendLessons, loadLessons } from './lessons.ts'
import type { VerifyResult } from './outcomes.ts'
import { lessonHygieneProblem } from '../vde/lessonCertificates.ts'

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
const NOT_A_PROJECT_FACT =
  /\b(?:denied|declined|rejected|not approved|blocked by|requires approval|old_string|not found in the file|appears \d+ times|not unique)\b/i

/** Tools whose failures say nothing durable about the project. */
const SLIP_TOOLS = new Set(['edit_file', 'write_file', 'todo_write', 'note_lesson', 'task'])

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

/** Lessons out of the model's reply, minus anything generic, malformed, or already known. */
export function parseLessons(reply: string, known: string[]): string[] {
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
}

export interface LearnedFromTurn {
  lessons: string[]
  usage?: Usage
}

/**
 * Turns a mechanically resolved failure into at most two durable lessons,
 * written to `.elia/lessons.md` (source `interactive-auto`) where every later
 * turn's prompt picks them up — and where lesson-efficacy tracking can retire
 * them if they do not help. Never throws; learning is a bonus on a finished turn.
 */
export async function learnFromTurn(options: LearnFromTurnOptions): Promise<LearnedFromTurn> {
  const evidence = turnEvidence(options.messages, options.fromIndex)
  const mode = learningMode(evidence, options.outcome)
  if (!mode) return { lessons: [] }
  const known = loadLessons(options.lessonsPath).map((lesson) => lesson.text)
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 20_000)
  options.onReflecting?.()
  try {
    const prompt = mode === 'repair' ? reflectionPrompt(options.request, evidence, known) : blockerPrompt(options.request, evidence, known)
    const result = await options.provider.streamTurn({
      cwd: options.cwd,
      system: "You are elia's long-term memory for one software project. You distil hard-won, durable facts from real tool output. Reply with JSON only.",
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      tools: [],
      onText: () => {},
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
      reasoningEffort: 'low',
    })
    const reply = result.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')
    const lessons = parseLessons(reply, known)
    if (lessons.length > 0) {
      // A blocker lesson records an unverified constraint, not a proven fix, so
      // it enters with lower confidence and its own source — lesson-efficacy
      // retirement can then drop it ahead of lessons that were earned by a
      // failure actually being put right.
      const tags = options.sources ?? { repair: 'interactive-auto', blocker: 'interactive-blocker' }
      const source = mode === 'repair' ? tags.repair : tags.blocker
      const confidence = mode === 'repair' ? 0.7 : 0.4
      appendLessons(lessons.map((text) => ({ text, source, confidence })), options.lessonsPath)
    }
    return { lessons, usage: result.usage }
  } catch {
    return { lessons: [] }
  }
}
