import { runWithConcurrencyLimit } from '../agentLoop.ts'
import { checkArithmetic, describeCalculations } from './arithmetic.ts'
import { checkGrounding, describeGrounding, extractCitations } from './grounding.ts'

/**
 * Searching over answers to a question, which the rest of this directory
 * declines to do.
 *
 * `decide.ts` turns a question away from the search with good reason: an answer
 * has no tree to run tests in, so k attempts cannot be judged by proof. AION's
 * deep mode is the answer to "then what?": ask several experts, drop the
 * proposals whose claims fail a check, vote among the survivors, and escalate
 * only when the first pass is unsettled. This is that loop, with three changes
 * that keep it honest.
 *
 * 1. Attempts differ by approach, not by temperature. AION's experts were one
 *    prompt sampled on a temperature ladder, which explores wording. Here each
 *    attempt is told a different way in, as `harness.ts` does for code.
 * 2. Escalation is triggered by disagreement between answers. AION escalated on
 *    the spread of the model's own confidence scores, which is self-report. Two
 *    attempts that commit to different answers are a fact about the answers.
 * 3. Agreement is reported as agreement. A settled vote is `stable`, never
 *    `verified`: models fail in correlated ways, so k identical wrong answers
 *    are as likely as k right ones on the questions that are actually hard. What
 *    agreement buys is a warning when the answer is *not* stable, which is the
 *    case where the user most needs one. The checks can reject an attempt (a sum
 *    that does not hold, a file that does not exist) and can never pass one.
 *
 * Votes stay independent. A later round is told that earlier attempts
 * disagreed, and is shown what a check rejected, but it is never shown the
 * competing answers: an attempt that picks between them is a tie-breaker, not
 * an independent vote, and counting it as one would manufacture a majority.
 *
 * Every question gets this by default: the ordinary turn is the first attempt
 * (`first`), and a challenger is paid for only when that turn committed to a
 * short answer (`checkableAnswer`). `elia bench --answers` measures the whole
 * search on questions with known answers.
 */

export interface AnswerApproach {
  id: string
  instruction: string
}

/** Genuinely different ways into a question, in the order they are spent. */
export const ANSWER_APPROACHES: AnswerApproach[] = [
  {
    id: 'direct',
    instruction: 'Work the question through step by step from what it actually says, then commit to an answer.',
  },
  {
    id: 'other-route',
    instruction:
      'Reach the answer by a different route from the obvious one: work backwards from what the answer must satisfy, or estimate first and then compute. Then check the result by substituting it back or against a sanity bound.',
  },
  {
    id: 'find-the-trap',
    instruction:
      'Assume the answer that comes to mind first is wrong. Look for the trap: an unstated assumption, an off-by-one, a unit, a misread word, an edge case. Resolve it, then answer.',
  },
  {
    id: 'decompose',
    instruction: 'Break the question into the smallest sub-questions whose answers are each easy to check. Answer each one, then compose them.',
  },
]

/**
 * Asked of an ordinary question turn, for that turn only. The reply stays the
 * reply; the last line is what the default check compares.
 */
export const ANSWER_GUIDANCE =
  'If the question has a short, definite answer (a number, a name, yes or no, a file or symbol), end your reply with a final line of the form `Answer: <answer>`. elia checks that line against an independent attempt. Leave the line out when the answer is an explanation rather than a fact.'

/** Every attempt ends the same way, so the answers can be compared at all. */
export const ANSWER_FORMAT =
  'Show your working. Finish with a final line of the form `Answer: <answer>`: the answer alone, as short as it can be while still complete (a number with its unit, a name, yes or no, a path).'

export interface AnswerCheckResult {
  passed: boolean
  detail: string
  /** What the next round is told about why this attempt was rejected. */
  evidence: string
}

/** A check that can reject an attempt. None of them can make an answer right. */
export interface AnswerCheck {
  id: string
  run(text: string): AnswerCheckResult
}

export function arithmeticCheck(): AnswerCheck {
  return {
    id: 'arithmetic',
    run(text) {
      const result = checkArithmetic(text)
      return { passed: result.wrong.length === 0, detail: describeCalculations(result), evidence: result.wrong.length === 0 ? '' : describeCalculations(result) }
    },
  }
}

export function citationCheck(cwd: string): AnswerCheck {
  return {
    id: 'citations',
    run(text) {
      const result = checkGrounding(extractCitations(text), cwd)
      const passed = result.ungrounded.length === 0
      return { passed, detail: passed ? `${result.checked} citation(s) exist` : describeGrounding(result), evidence: passed ? '' : describeGrounding(result) }
    },
  }
}

/** Produces one attempt. `briefing` carries the approach and the format; the question is the caller's. */
export type AnswerProducer = (input: { approach: AnswerApproach; round: number; briefing: string; signal?: AbortSignal }) => Promise<{ text: string; cost?: number }>

export interface AnswerAttempt {
  round: number
  approach: string
  text: string
  cost: number
  /** The committed answer as written, when the attempt gave one. */
  answer?: string
  /** What the vote compares. Undefined when there is no answer line. */
  key?: string
  /** One line per failed check (or a missing answer); empty when the attempt is clean. */
  rejected: string[]
  evidence: string
}

export type AnswerStatus =
  /** Two or more clean attempts, and every clean attempt gave the same answer. */
  | 'stable'
  /** One answer has the most clean attempts behind it, and at least two, but not all of them. */
  | 'majority'
  /** Clean attempts disagree and no answer leads. */
  | 'split'
  /** Exactly one attempt survived its checks, so there is nothing to compare it with. */
  | 'unconfirmed'
  /** The answers are prose, too long to compare by their text. */
  | 'not-comparable'
  /** No attempt survived its checks with an answer. */
  | 'no-answer'
  | 'aborted'

export interface AnswerCluster {
  key: string
  answer: string
  count: number
}

export interface AnswerSearchResult {
  status: AnswerStatus
  best?: AnswerAttempt
  attempts: AnswerAttempt[]
  clusters: AnswerCluster[]
  cost: number
  elapsedMs: number
  /** One line for the person, saying plainly how settled the answer is. */
  receipt: string
}

/** Longer than this, two correct answers rarely match word for word, so a vote means nothing. */
export const MAX_COMPARABLE = 120
/** Attempts per round: a first pass of two, then the escalation. */
const ROUNDS = [2, 2, 1]
export const DEFAULT_MAX_ATTEMPTS = ROUNDS.reduce((sum, width) => sum + width, 0)

/** The attempt's committed answer: its last `Answer:` line, or failing that its last `\boxed{}`. */
export function finalAnswer(text: string): string | undefined {
  let found: string | undefined
  for (const line of text.split('\n')) {
    // Emphasis markers go; an underscore inside a word (MIN_OBSERVATIONS) stays.
    const plain = line.replace(/\*+/g, '').replace(/(^|[\s:])_+|_+(?=[\s:]|$)/g, '$1')
    const match = /^\s*[>#-]*\s*(?:final\s+)?answer\s*[:：]\s*(.+?)\s*$/i.exec(plain)
    if (match && match[1]) found = match[1]
  }
  if (found !== undefined) return found
  const boxed = [...text.matchAll(/\\boxed\{([^{}]+)\}/g)].pop()
  return boxed?.[1]?.trim()
}

/** A path with an extension, with any `:line` after it (which is where, not what). */
const FILE =
  /((?:[\w@.-]+\/)*[\w@-][\w@.-]*\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|json|md|py|go|rs|java|kt|rb|php|c|h|cc|cpp|hpp|cs|swift|sh|yml|yaml|toml|sql|css|html|vue|svelte))(?::\d+(?:[:-]\d+)?)?(?![\w/])/g
const FILE_KEY = 'files: '

/**
 * What two answers have to share to count as the same answer.
 *
 * Deliberately modest. "1,200", "$1200" and "1200.0" are the same number, and
 * "Yes." and "yes, because" are the same verdict, so those are folded together.
 * A number followed only by words or symbols is keyed by the number: the first
 * live run split a unanimous "50 square centimetres" / "50 cm²" into two
 * answers. The cost is that "5 cents" and "$5" would count as agreeing; the
 * question almost always fixes the unit, and a model that changes unit
 * usually changes the number with it.
 *
 * An answer that names files is keyed by the set of files and the set of
 * numbers it states, not by its wording. A live check on this repository got
 * five phrasings of two answers ("library.ts (5) and resourceGovernor.ts (3)"
 * three ways, "library.ts: 5" two ways) and reported five-way disagreement;
 * keyed by what they claim, it is three attempts against two.
 *
 * Beyond that, two answers that read differently are counted as different.
 * Too strict makes a split look worse than it is; folding answers together on
 * a model's say-so would hide real disagreement.
 */
export function answerKey(answer: string): string {
  let text = answer
    .toLowerCase()
    .replace(/[`"“”‘’]/g, '')
    .replace(/\\boxed\{([^{}]+)\}/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.。!]+$/, '')
    .trim()
  text = text.replace(/^(?:approximately|about|roughly|≈|~)\s*/, '')
  const verdict = /^(yes|no|true|false)\b/.exec(text)
  if (verdict) return verdict[1]!
  const number = /^([-−]?)\s*[$€£₹]?\s*(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?![\d.,])([^\d]*)$/.exec(text)
  if (number) return String(Number(`${number[1] ? '-' : ''}${number[2]!.replace(/,/g, '')}`))
  const files = [...text.matchAll(FILE)].map((match) => match[1]!)
  if (files.length > 0) {
    const numbers = [...text.replace(FILE, ' ').matchAll(/(?<![\w.])\d+(?:\.\d+)?(?![\w.])/g)].map((match) => String(Number(match[0])))
    const unique = (values: string[]) => [...new Set(values)].sort()
    return `${FILE_KEY}${unique(files).join(', ')}${numbers.length > 0 ? ` | ${unique(numbers).join(', ')}` : ''}`
  }
  return text
}

/** Whether a key is something a vote can compare. Prose is not; a set of files is, however many. */
function comparable(key: string): boolean {
  return key.startsWith(FILE_KEY) || key.length <= MAX_COMPARABLE
}

/**
 * The answer a reply commits to, when it is one a vote can compare — the gate
 * that decides whether the default answer check spends anything at all. A reply
 * with no `Answer:` line, or one whose answer is prose, is left alone.
 */
export function checkableAnswer(text: string): string | undefined {
  const answer = finalAnswer(text)
  if (answer === undefined) return undefined
  return comparable(answerKey(answer)) ? answer : undefined
}

function claims(key: string): { files: string[]; numbers: string[] } | undefined {
  if (!key.startsWith(FILE_KEY)) return undefined
  const [files = '', numbers = ''] = key.slice(FILE_KEY.length).split(' | ')
  const list = (text: string) => text.split(', ').filter(Boolean)
  return { files: list(files), numbers: list(numbers) }
}

/**
 * Whether answer `a` claims everything answer `b` does: every file and every
 * number in `b` is also in `a`. Only answers that name files are compared this
 * way; for anything else, covering means being the same answer.
 */
export function covers(a: string, b: string): boolean {
  if (a === b) return true
  const left = claims(a)
  const right = claims(b)
  if (!left || !right) return false
  return right.files.every((file) => left.files.includes(file)) && right.numbers.every((number) => left.numbers.includes(number))
}

function isClean(attempt: AnswerAttempt): boolean {
  return attempt.rejected.length === 0 && attempt.key !== undefined
}

function clustersOf(attempts: AnswerAttempt[]): AnswerCluster[] {
  const byKey = new Map<string, AnswerCluster>()
  for (const attempt of attempts) {
    if (!isClean(attempt)) continue
    const cluster = byKey.get(attempt.key!)
    if (cluster) cluster.count += 1
    else byKey.set(attempt.key!, { key: attempt.key!, answer: attempt.answer ?? attempt.key!, count: 1 })
  }
  // Stable order: most votes first, then whichever answer arrived first.
  return [...byKey.values()].sort((a, b) => b.count - a.count)
}

/** Whether the vote is settled enough that another round would not change what elia reports. */
function settled(clusters: AnswerCluster[]): boolean {
  const [leader, second] = clusters
  if (!leader || leader.count < 2) return false
  if (!second) return true
  return leader.count - second.count >= 2
}

function statusOf(attempts: AnswerAttempt[], clusters: AnswerCluster[]): AnswerStatus {
  const clean = attempts.filter(isClean)
  if (clean.length === 0) return 'no-answer'
  if (clean.every((attempt) => !comparable(attempt.key!))) return 'not-comparable'
  if (clean.length === 1) return 'unconfirmed'
  const [leader, second] = clusters
  if (clusters.length === 1) return 'stable'
  if (leader && leader.count >= 2 && leader.count > (second?.count ?? 0)) return 'majority'
  return 'split'
}

function briefingFor(approach: AnswerApproach, round: number, earlier: AnswerAttempt[]): string {
  const parts = [approach.instruction, ANSWER_FORMAT]
  if (round > 0) {
    if (clustersOf(earlier).length > 1) {
      parts.push('Earlier independent attempts at this question reached different answers, so the obvious reading is probably not safe. Work it out yourself from the question alone.')
    }
    const rejected = earlier.filter((attempt) => attempt.rejected.length > 0)
    if (rejected.length > 0) {
      parts.push(
        ['Checks rejected earlier attempts for these reasons. Do not repeat them:', ...rejected.map((attempt) => `- ${attempt.approach}: ${attempt.rejected.join('; ')}`)].join('\n'),
      )
    }
  }
  return parts.join('\n\n')
}

function assess(text: string, checks: AnswerCheck[]): Pick<AnswerAttempt, 'answer' | 'key' | 'rejected' | 'evidence'> {
  const answer = finalAnswer(text)
  const rejected: string[] = []
  const evidence: string[] = []
  if (answer === undefined) rejected.push('did not commit to a final `Answer:` line')
  for (const check of checks) {
    const result = check.run(text)
    if (!result.passed) {
      rejected.push(`${check.id}: ${result.detail}`)
      if (result.evidence) evidence.push(result.evidence)
    }
  }
  return { answer, key: answer === undefined ? undefined : answerKey(answer), rejected, evidence: evidence.join('\n') }
}

function receiptFor(status: AnswerStatus, attempts: AnswerAttempt[], clusters: AnswerCluster[]): string {
  const n = attempts.length
  const rejected = attempts.filter((attempt) => attempt.rejected.length > 0).length
  const dropped = rejected > 0 ? `; ${rejected} rejected by a check` : ''
  const others = (skip: number) =>
    clusters
      .slice(skip)
      .map((cluster) => `"${cluster.answer}" ×${cluster.count}`)
      .join(', ')
  switch (status) {
    case 'stable':
      return `stable: ${clusters[0]!.count} independent attempts reached the same answer${dropped}. Agreement is not proof; it means the answer did not move when the approach did.`
    case 'majority':
      return `majority: ${clusters[0]!.count} of ${n} attempts reached this answer, others reached ${others(1)}${dropped}. Treat it as likely, not settled.`
    case 'split':
      return `split: the attempts disagreed (${others(0)})${dropped}. Showing the first; it needs your judgement.`
    case 'unconfirmed':
      return `unconfirmed: only one of ${n} attempts survived its checks, so there was nothing to compare it with.`
    case 'not-comparable':
      return 'not compared: the answers are prose, too long to compare by their text. Showing the first attempt that passed its checks.'
    case 'no-answer':
      return `no answer: none of ${n} attempts survived its checks with a final answer. Showing the closest; it needs review.`
    case 'aborted':
      return `stopped after ${n} attempt(s).`
  }
}

export interface AnswerSearchOptions {
  produce: AnswerProducer
  /**
   * An answer already given, counted as the round-one `direct` attempt instead
   * of producing one. The default answer check uses it: the ordinary turn is
   * the first attempt, and only a challenger is paid for.
   */
  first?: { text: string; cost?: number }
  /** Default: the arithmetic check. Add `citationCheck(cwd)` when the question is about a checkout. */
  checks?: AnswerCheck[]
  approaches?: AnswerApproach[]
  maxAttempts?: number
  onAttempt?: (attempt: AnswerAttempt) => void
  signal?: AbortSignal
}

export async function answerSearch(options: AnswerSearchOptions): Promise<AnswerSearchResult> {
  const started = Date.now()
  const approaches = options.approaches ?? ANSWER_APPROACHES
  const checks = options.checks ?? [arithmeticCheck()]
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)
  const attempts: AnswerAttempt[] = []
  let aborted = false
  if (options.first) {
    const seeded: AnswerAttempt = { round: 0, approach: approaches[0]?.id ?? 'direct', text: options.first.text, cost: options.first.cost ?? 0, ...assess(options.first.text, checks) }
    attempts.push(seeded)
    options.onAttempt?.(seeded)
  }

  for (let round = 0; attempts.length < maxAttempts && approaches.length > 0; round += 1) {
    if (options.signal?.aborted) {
      aborted = true
      break
    }
    // A seeded first answer is part of round one's width, not extra to it.
    const width = Math.min((ROUNDS[round] ?? 1) - (round === 0 && options.first ? 1 : 0), maxAttempts - attempts.length)
    if (width <= 0) continue
    const picks = Array.from({ length: width }, (_, index) => approaches[(attempts.length + index) % approaches.length]!)
    const earlier = [...attempts]
    const produced = await runWithConcurrencyLimit(picks, picks.length, async (approach): Promise<AnswerAttempt> => {
      try {
        const { text, cost } = await options.produce({ approach, round, briefing: briefingFor(approach, round, earlier), signal: options.signal })
        return { round, approach: approach.id, text, cost: cost ?? 0, ...assess(text, checks) }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { round, approach: approach.id, text: '', cost: 0, rejected: [`attempt failed: ${message}`], evidence: message }
      }
    })
    for (const attempt of produced) {
      attempts.push(attempt)
      options.onAttempt?.(attempt)
    }
    if (options.signal?.aborted) {
      aborted = true
      break
    }
    const clusters = clustersOf(attempts)
    const clean = attempts.filter(isClean)
    // Prose cannot be voted on, so a second round would buy nothing.
    if (clean.length > 0 && clean.every((attempt) => !comparable(attempt.key!))) break
    if (settled(clusters)) break
    // Checking an answer already given: when every challenger found only part
    // of it, nothing contradicts it, and another round would buy nothing.
    const given = options.first ? attempts[0] : undefined
    const challengers = clean.filter((attempt) => attempt !== given)
    if (given && isClean(given) && challengers.length > 0 && challengers.every((attempt) => covers(given.key!, attempt.key!))) break
  }

  const clusters = clustersOf(attempts)
  const status: AnswerStatus = aborted ? 'aborted' : statusOf(attempts, clusters)
  const leader = clusters[0]
  const clean = attempts.filter(isClean)
  const best = (leader ? clean.find((attempt) => attempt.key === leader.key) : undefined) ?? clean[0] ?? attempts.find((attempt) => attempt.text.length > 0)
  return {
    status,
    best,
    attempts,
    clusters,
    cost: attempts.reduce((sum, attempt) => sum + attempt.cost, 0),
    elapsedMs: Date.now() - started,
    receipt: receiptFor(status, attempts, clusters),
  }
}

/**
 * Whether the independent attempts outvote the answer already given: they
 * agree among themselves (stable or a clear majority) on something other than
 * what the first attempt said.
 */
export function overturned(result: AnswerSearchResult): boolean {
  const leader = result.clusters[0]
  const first = result.attempts[0]
  if (!leader || !first) return false
  if (result.status !== 'stable' && result.status !== 'majority') return false
  if (leader.key === first.key) return false
  // Found live: the answer named both files that define a constant, with
  // citations the check confirmed; three cheaper attempts each found one of
  // them and outvoted it. Finding part of an answer does not contradict it.
  return first.key === undefined || !covers(first.key, leader.key)
}

type ContextMessage = { role: string; content: string | ReadonlyArray<{ type: string; text?: string }> }

/**
 * The conversation before a question, for a challenger that cannot see it.
 *
 * Newest last, text only (tool calls and results are left out), and capped so
 * a long session does not turn a cheap check into an expensive one. It never
 * includes the answer being checked: the caller passes what came before it.
 */
export function conversationContext(messages: readonly ContextMessage[], maxChars = 3_000): string {
  const lines: string[] = []
  let used = 0
  for (let index = messages.length - 1; index >= 0 && used < maxChars; index -= 1) {
    const message = messages[index]!
    if (message.role !== 'user' && message.role !== 'assistant') continue
    const text = (typeof message.content === 'string' ? message.content : message.content.flatMap((block) => (block.type === 'text' && block.text ? [block.text] : [])).join('\n')).trim()
    if (!text) continue
    const room = Math.min(maxChars - used, 800)
    const clipped = text.length > room ? `${text.slice(0, room)}…` : text
    lines.unshift(`${message.role === 'user' ? 'User' : 'elia'}: ${clipped}`)
    used += clipped.length
  }
  if (lines.length === 0) return ''
  return ['The conversation before this question, for context only:', ...lines].join('\n')
}
