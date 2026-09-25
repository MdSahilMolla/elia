import { isCapacityError, isConnectionError, isTransientServerError } from '../providerErrors.ts'
import type { Provider } from '../providers/types.ts'
import { eValue } from '../compounding/stats.ts'
import { totalTokens } from '../usage.ts'
import { answerSearch, type AnswerProducer, type AnswerSearchResult, type AnswerStatus } from './answer.ts'

/**
 * Does answer search beat one attempt, and does its verdict mean anything?
 *
 * The same test AION's own brief set for its pipeline ("does the system beat
 * the bare LLM?"), applied to reason/answer.ts, on questions whose right answer
 * is known. Two numbers come out of it, and the second matters more.
 *
 * 1. Accuracy of the first attempt against accuracy of the search's pick. The
 *    first attempt IS the single-pass arm: it is the search's round-one
 *    `direct` attempt, with the same briefing a single pass would get. So the
 *    comparison is paired on the same sample, and it measures exactly what the
 *    extra attempts changed. A paired e-value decides it, as `bench --lift`
 *    does. A few points on thirty questions is noise, and is reported as noise.
 * 2. Accuracy by verdict. If answers the search calls `stable` are right far
 *    more often than ones it calls `split`, the verdict is a usable warning. If
 *    they are not, the labels are decoration and should be said to be.
 *
 * The questions are traps and multi-step arithmetic a model gets wrong often
 * enough to measure, each with an answer worked out by hand. They are not a
 * benchmark of anything public and must not be described as one.
 */

export interface BenchQuestion {
  id: string
  question: string
  /** A number is graded numerically; a word is graded as the answer's first word. */
  expected: number | string
}

export const QUESTIONS: BenchQuestion[] = [
  { id: 'bat-ball', question: 'A bat and a ball cost $1.10 in total. The bat costs $1.00 more than the ball. How much does the ball cost, in cents?', expected: 5 },
  { id: 'widgets', question: 'If it takes 5 machines 5 minutes to make 5 widgets, how many minutes would it take 100 machines to make 100 widgets?', expected: 5 },
  { id: 'lily-pads', question: 'A patch of lily pads doubles in size every day. It takes 48 days to cover the whole lake. How many days does it take to cover half the lake?', expected: 47 },
  { id: 'strawberry', question: "How many times does the letter r appear in the word 'strawberry'?", expected: 3 },
  { id: 'two-products', question: 'What is 17 × 23 + 19 × 21?', expected: 790 },
  { id: 'pencils', question: 'A shop sells pencils at 3 for $0.75. How much do 14 pencils cost, in dollars?', expected: 3.5 },
  { id: 'y2k-weekday', question: 'What day of the week was 1 January 2000?', expected: 'saturday' },
  { id: 'days-2024', question: 'How many days are there from 1 March 2024 to 1 March 2025, counting the end day but not the start day?', expected: 365 },
  { id: 'sally', question: 'Sally has 3 brothers. Each of her brothers has 2 sisters. How many sisters does Sally have?', expected: 1 },
  { id: 'sevens', question: 'What is the sum of all the integers from 1 to 200 that are divisible by 7?', expected: 2842 },
  { id: 'train', question: 'A train leaves at 9:45 and arrives at 13:20 the same day. How many minutes does the journey take?', expected: 215 },
  { id: 'nines', question: 'If you write out every whole number from 1 to 100, how many times do you write the digit 9?', expected: 20 },
  { id: 'mod-seven', question: 'What is the remainder when 2^100 is divided by 7?', expected: 2 },
  { id: 'rectangle', question: 'A rectangle has a perimeter of 30 cm and its length is twice its width. What is its area in square centimetres?', expected: 50 },
  { id: 'primes-50', question: 'How many prime numbers are there between 1 and 50?', expected: 15 },
  { id: 'clock', question: 'A clock shows 3:15. What is the smaller angle between the hour hand and the minute hand, in degrees?', expected: 7.5 },
  { id: 'percent', question: 'What is 15% of 240, plus 240 divided by 16?', expected: 51 },
  { id: 'speed', question: 'A car travels 150 km in 1 hour 40 minutes. What is its average speed in km/h?', expected: 90 },
  { id: 'lcm-10', question: 'What is the smallest positive integer divisible by every integer from 1 to 10?', expected: 2520 },
  { id: 'ages', question: 'A father is 4 times as old as his son. In 20 years he will be twice as old as his son. How old is the son now?', expected: 10 },
  { id: 'chess-squares', question: 'How many squares of any size are there on a standard 8×8 chessboard?', expected: 204 },
  { id: 'fibonacci', question: 'The sequence starts 1, 1, 2, 3, 5, ... with each term the sum of the two before it. What is the 10th term?', expected: 55 },
  { id: 'mississippi', question: "How many times does the letter s appear in the word 'Mississippi'?", expected: 4 },
  { id: 'weekday-100', question: 'If today is Wednesday, what day of the week will it be 100 days from today?', expected: 'friday' },
  { id: 'snail', question: 'A snail at the bottom of a 10-metre well climbs 3 metres each day and slips back 2 metres each night. On which day does it first reach the top?', expected: 8 },
  { id: 'hexagon', question: 'What is the sum of the interior angles of a hexagon, in degrees?', expected: 720 },
  { id: 'handshakes', question: 'At a party, each of 12 people shakes hands exactly once with every other person. How many handshakes are there?', expected: 66 },
  { id: 'socks', question: 'A drawer holds 10 red socks and 10 blue socks, mixed. In the dark, how many socks must you take out to be certain of having a matching pair?', expected: 3 },
  { id: 'overtake', question: 'In a race, you overtake the person in second place. What position are you in now? Answer with a number.', expected: 2 },
  { id: 'reverse-digits', question: 'What is 1234 × 4321?', expected: 5_332_114 },
]

/** The first number in an answer, with thousands separators and currency ignored. */
function firstNumber(answer: string): number | undefined {
  const match = /[-−]?\d[\d,]*(?:\.\d+)?/.exec(answer.replace(/[$€£₹]/g, ''))
  if (!match) return undefined
  return Number(match[0].replace(/,/g, '').replace('−', '-'))
}

/** The bench's ground truth. Independent of the vote key on purpose: grading must not share a bug with voting. */
export function grade(answer: string | undefined, expected: number | string): boolean {
  if (answer === undefined) return false
  if (typeof expected === 'number') {
    const value = firstNumber(answer)
    return value !== undefined && Math.abs(value - expected) <= 1e-6 * Math.max(1, Math.abs(expected))
  }
  const first = answer.toLowerCase().replace(/[^a-z\s]/g, ' ').trim().split(/\s+/)[0]
  return first === expected
}

export interface BenchRow {
  id: string
  expected: number | string
  /** The search's first, `direct` attempt: the single-pass arm. */
  firstAnswer?: string
  firstRight: boolean
  firstTokens: number
  status: AnswerStatus
  searchAnswer?: string
  searchRight: boolean
  searchTokens: number
  attempts: number
}

export interface BenchReport {
  rows: BenchRow[]
  firstRate: number
  searchRate: number
  /** Questions the search got right and the first attempt did not, and the reverse. */
  wins: number
  losses: number
  /** Anytime-valid evidence that the search is better; ≥ 20 rejects "no better" at 5%. */
  eValue: number
  byStatus: { status: AnswerStatus; n: number; right: number }[]
  firstTokens: number
  searchTokens: number
}

const RETRY_DELAYS_MS = [2_000, 8_000]

function retryable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return isTransientServerError(message) || isConnectionError(message) || isCapacityError(message)
}

/** One attempt as a single model call: no tools, no elia prompt, so the bench measures the search and nothing else. */
export function providerProducer(provider: Provider, question: string, cwd = process.cwd()): AnswerProducer {
  return async ({ briefing, signal }) => {
    for (let attempt = 0; ; attempt++) {
      try {
        let text = ''
        const turn = await provider.streamTurn({
          cwd,
          system: 'Answer the question you are given.',
          messages: [{ role: 'user', content: [{ type: 'text', text: `${briefing}\n\nQuestion: ${question}` }] }],
          tools: [],
          onText: (delta) => {
            text += delta
          },
          ...(signal ? { signal } : {}),
        })
        const final = turn.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')
        return { text: final || text, cost: totalTokens(turn.usage) }
      } catch (error) {
        if (attempt >= RETRY_DELAYS_MS.length || !retryable(error) || signal?.aborted) throw error
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]))
      }
    }
  }
}

export function rowFor(question: BenchQuestion, result: AnswerSearchResult): BenchRow {
  const first = result.attempts[0]
  return {
    id: question.id,
    expected: question.expected,
    firstAnswer: first?.answer,
    firstRight: grade(first?.answer, question.expected),
    firstTokens: first?.cost ?? 0,
    status: result.status,
    searchAnswer: result.best?.answer,
    searchRight: grade(result.best?.answer, question.expected),
    searchTokens: result.cost,
    attempts: result.attempts.length,
  }
}

export function summarizeBench(rows: BenchRow[]): BenchReport {
  const n = Math.max(1, rows.length)
  const byStatus = new Map<AnswerStatus, { status: AnswerStatus; n: number; right: number }>()
  for (const row of rows) {
    const entry = byStatus.get(row.status) ?? { status: row.status, n: 0, right: 0 }
    entry.n += 1
    entry.right += row.searchRight ? 1 : 0
    byStatus.set(row.status, entry)
  }
  return {
    rows,
    firstRate: rows.filter((row) => row.firstRight).length / n,
    searchRate: rows.filter((row) => row.searchRight).length / n,
    wins: rows.filter((row) => row.searchRight && !row.firstRight).length,
    losses: rows.filter((row) => !row.searchRight && row.firstRight).length,
    eValue: eValue(rows.map((row) => Number(row.searchRight) - Number(row.firstRight))),
    byStatus: [...byStatus.values()].sort((a, b) => b.n - a.n),
    firstTokens: rows.reduce((sum, row) => sum + row.firstTokens, 0),
    searchTokens: rows.reduce((sum, row) => sum + row.searchTokens, 0),
  }
}

export async function runAnswerBench(options: {
  producerFor: (question: BenchQuestion) => AnswerProducer
  questions?: BenchQuestion[]
  signal?: AbortSignal
  onRow?: (row: BenchRow) => void
}): Promise<BenchReport> {
  const rows: BenchRow[] = []
  for (const question of options.questions ?? QUESTIONS) {
    if (options.signal?.aborted) break
    const result = await answerSearch({ produce: options.producerFor(question), ...(options.signal ? { signal: options.signal } : {}) })
    if (result.status === 'aborted') break
    const row = rowFor(question, result)
    rows.push(row)
    options.onRow?.(row)
  }
  return summarizeBench(rows)
}

export function renderBench(report: BenchReport): string {
  const pct = (rate: number) => `${Math.round(rate * 100)}%`
  const verdict =
    report.eValue >= 20
      ? 'the search is better (e ≥ 20)'
      : report.losses > report.wins
        ? 'the search did worse on these questions'
        : 'no evidence either way yet: the difference is within noise'
  const lines = [
    `${report.rows.length} question(s)`,
    `  first attempt alone  ${pct(report.firstRate)}  (${report.firstTokens.toLocaleString('en-US')} tokens)`,
    `  answer search        ${pct(report.searchRate)}  (${report.searchTokens.toLocaleString('en-US')} tokens)`,
    `  search fixed ${report.wins}, broke ${report.losses} · e = ${report.eValue.toFixed(2)} · ${verdict}`,
    '',
    'how often each verdict was right:',
    ...report.byStatus.map((entry) => `  ${entry.status.padEnd(15)} ${entry.right}/${entry.n}`),
  ]
  return lines.join('\n')
}
