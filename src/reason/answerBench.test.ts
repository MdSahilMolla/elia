import { expect, test } from 'bun:test'
import type { AnswerProducer } from './answer.ts'
import { grade, QUESTIONS, renderBench, runAnswerBench, type BenchQuestion } from './answerBench.ts'

test('numbers are graded numerically, words by the first word', () => {
  expect(grade('5 cents', 5)).toBe(true)
  expect(grade('$3.50', 3.5)).toBe(true)
  expect(grade('5,332,114', 5_332_114)).toBe(true)
  expect(grade('10', 5)).toBe(false)
  expect(grade('Saturday.', 'saturday')).toBe(true)
  expect(grade('It was a Friday', 'friday')).toBe(false)
  expect(grade(undefined, 5)).toBe(false)
})

test('every question has a unique id and an answer', () => {
  expect(new Set(QUESTIONS.map((question) => question.id)).size).toBe(QUESTIONS.length)
  for (const question of QUESTIONS) expect(question.question.length).toBeGreaterThan(10)
})

/** Answers each question from a per-question script of replies. */
function scriptedBench(scripts: Record<string, string[]>): (question: BenchQuestion) => AnswerProducer {
  return (question) => {
    const replies = [...(scripts[question.id] ?? [])]
    return async () => ({ text: replies.shift() ?? 'no answer', cost: 100 })
  }
}

const questions: BenchQuestion[] = [
  { id: 'a', question: 'q a', expected: 5 },
  { id: 'b', question: 'q b', expected: 47 },
  { id: 'c', question: 'q c', expected: 'saturday' },
]

test('the first attempt is the single-pass arm, and a fix by the search is counted as one', async () => {
  const report = await runAnswerBench({
    questions,
    producerFor: scriptedBench({
      // Stable and right from the start.
      a: ['Answer: 5', 'Answer: 5'],
      // First attempt falls for the trap; the escalation outvotes it.
      b: ['Answer: 24', 'Answer: 47', 'Answer: 47', 'Answer: 47'],
      // Split and wrong either way.
      c: ['Answer: Friday', 'Answer: Sunday', 'Answer: Monday', 'Answer: Tuesday', 'Answer: Thursday'],
    }),
  })
  expect(report.rows.map((row) => [row.id, row.firstRight, row.searchRight, row.status])).toEqual([
    ['a', true, true, 'stable'],
    ['b', false, true, 'majority'],
    ['c', false, false, 'split'],
  ])
  expect(report.wins).toBe(1)
  expect(report.losses).toBe(0)
  expect(report.firstTokens).toBe(300)
  expect(report.searchTokens).toBe(1_100)
  expect(report.byStatus).toEqual([
    { status: 'stable', n: 1, right: 1 },
    { status: 'majority', n: 1, right: 1 },
    { status: 'split', n: 1, right: 0 },
  ])
  const text = renderBench(report)
  expect(text).toContain('search fixed 1, broke 0')
  expect(text).toContain('within noise')
  expect(text).toContain('split           0/1')
})
