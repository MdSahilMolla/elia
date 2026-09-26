import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  answerKey,
  answerSearch,
  arithmeticCheck,
  checkableAnswer,
  citationCheck,
  conversationContext,
  covers,
  finalAnswer,
  overturned,
  type AnswerProducer,
} from './answer.ts'

/** A producer that answers from a script, one entry per call, and records what it was told. */
function scripted(replies: (string | Error)[]) {
  const briefings: string[] = []
  const approaches: string[] = []
  let call = 0
  const produce: AnswerProducer = async ({ approach, briefing }) => {
    briefings.push(briefing)
    approaches.push(approach.id)
    const reply = replies[call++] ?? 'Answer: out of script'
    if (reply instanceof Error) throw reply
    return { text: reply, cost: 10 }
  }
  return { produce, briefings, approaches, calls: () => call }
}

test('the final answer is the last Answer line, bold or not, with \\boxed as a fallback', () => {
  expect(finalAnswer('working...\nAnswer: 12\nthen\nAnswer: 14')).toBe('14')
  expect(finalAnswer('**Answer:** 42')).toBe('42')
  expect(finalAnswer('> Final answer: seven')).toBe('seven')
  expect(finalAnswer('so the result is \\boxed{391}')).toBe('391')
  expect(finalAnswer('I think it is probably 12.')).toBeUndefined()
})

test('an identifier in the answer line keeps its underscores', () => {
  expect(finalAnswer('**Answer:** src/reason/library.ts defines MIN_OBSERVATIONS as 5')).toBe('src/reason/library.ts defines MIN_OBSERVATIONS as 5')
  expect(finalAnswer('_Answer:_ 42')).toBe('42')
})

test('the same number, verdict or phrase written differently is the same answer', () => {
  expect(answerKey('1,200')).toBe(answerKey('$1200'))
  expect(answerKey('1200.0')).toBe('1200')
  expect(answerKey('Yes.')).toBe(answerKey('yes, because the loop exits'))
  expect(answerKey('42 km')).toBe(answerKey('42km'))
  // Seen live: the same area, spelled two ways, was counted as a split.
  expect(answerKey('50 square centimetres')).toBe(answerKey('50 cm²'))
  expect(answerKey('7.5 degrees')).toBe('7.5')
  expect(answerKey('3 to 5')).not.toBe(answerKey('3'))
  expect(answerKey('5 cents ($0.05)')).not.toBe(answerKey('5'))
  expect(answerKey('`src/a.ts`')).toBe(answerKey('src/a.ts'))
  expect(answerKey('approximately 3.5')).toBe('3.5')
  expect(answerKey('Paris')).not.toBe(answerKey('Lyon'))
})

// The five answers a live check gave to "which file defines MIN_OBSERVATIONS,
// and what is it set to?" in this repository.
const LIVE = [
  'src/reason/library.ts (5) and src/compounding/resourceGovernor.ts (3)',
  'src/reason/library.ts (5)',
  'src/reason/library.ts: 5',
  'src/reason/library.ts defines MIN_OBSERVATIONS as 5; src/compounding/resourceGovernor.ts defines MIN_OBSERVATIONS as 3',
  'src/compounding/resourceGovernor.ts: 3, src/reason/library.ts: 5',
]

test('answers that name files are compared by the files and numbers they claim, not their wording', () => {
  const keys = LIVE.map(answerKey)
  expect(new Set(keys).size).toBe(2)
  expect(keys[0]).toBe(keys[3])
  expect(keys[0]).toBe(keys[4])
  expect(keys[1]).toBe(keys[2])
  // A line number says where, not what, so it does not split a vote.
  expect(answerKey('src/reason/library.ts:65')).toBe(answerKey('src/reason/library.ts'))
  expect(answerKey('src/a.ts (5)')).not.toBe(answerKey('src/a.ts (6)'))
})

test('the live repository question is a 3–2 majority, not a five-way split', async () => {
  const result = await answerSearch({ produce: scripted(LIVE.map((answer) => `Answer: ${answer}`)).produce })
  expect(result.status).toBe('majority')
  expect(result.clusters.map((cluster) => cluster.count)).toEqual([3, 2])
  expect(result.best?.answer).toBe(LIVE[0])
})

test('two attempts that agree settle it: stable, and no escalation is bought', async () => {
  const stub = scripted(['17 × 23 = 391\nAnswer: 391', 'estimate 400, exactly 391\nAnswer: 391'])
  const result = await answerSearch({ produce: stub.produce })
  expect(result.status).toBe('stable')
  expect(result.attempts).toHaveLength(2)
  expect(stub.approaches).toEqual(['direct', 'other-route'])
  expect(result.best?.answer).toBe('391')
  expect(result.cost).toBe(20)
  expect(result.receipt).toContain('Agreement is not proof')
})

test('disagreement escalates, and a clear lead ends the search as a majority', async () => {
  const stub = scripted(['Answer: 12', 'Answer: 14', 'Answer: 12', 'Answer: 12'])
  const result = await answerSearch({ produce: stub.produce })
  expect(result.status).toBe('majority')
  expect(result.attempts).toHaveLength(4)
  expect(result.clusters.map((cluster) => [cluster.key, cluster.count])).toEqual([['12', 3], ['14', 1]])
  expect(result.best?.answer).toBe('12')
  expect(result.receipt).toContain('3 of 4 attempts')
  expect(result.receipt).toContain('"14" ×1')
})

test('the escalation round is told the attempts disagreed, but never what they answered', async () => {
  const stub = scripted(['Answer: 12', 'Answer: 14', 'Answer: 12', 'Answer: 12'])
  await answerSearch({ produce: stub.produce })
  const escalation = stub.briefings.slice(2)
  expect(escalation.every((briefing) => briefing.includes('reached different answers'))).toBe(true)
  for (const briefing of escalation) {
    expect(briefing).not.toContain('12')
    expect(briefing).not.toContain('14')
  }
  expect(stub.briefings.slice(0, 2).some((briefing) => briefing.includes('different answers'))).toBe(false)
})

test('an attempt whose arithmetic does not hold is rejected, and the next round hears why', async () => {
  const stub = scripted(['12 × 4 = 50, so\nAnswer: 50', '12 × 4 = 48\nAnswer: 48', '48\nAnswer: 48'])
  const result = await answerSearch({ produce: stub.produce, maxAttempts: 3 })
  expect(result.attempts[0]!.rejected[0]).toContain('arithmetic: 1 of 1 calculation(s) do not hold: 12 × 4 = 50 — it is 48')
  expect(stub.briefings[2]).toContain('12 × 4 = 50 — it is 48')
  expect(result.clusters).toEqual([{ key: '48', answer: '48', count: 2 }])
  expect(result.status).toBe('stable')
  expect(result.receipt).toContain('1 rejected by a check')
})

test('answers that never converge are reported as a split, after the whole budget', async () => {
  const stub = scripted(['Answer: 1', 'Answer: 2', 'Answer: 3', 'Answer: 4', 'Answer: 5'])
  const result = await answerSearch({ produce: stub.produce })
  expect(result.attempts).toHaveLength(5)
  expect(result.status).toBe('split')
  expect(result.best?.answer).toBe('1')
  expect(result.receipt).toContain('it needs your judgement')
})

test('a tie at the top after the whole budget is a split, not a majority', async () => {
  const stub = scripted(['Answer: 1', 'Answer: 2', 'Answer: 1', 'Answer: 2', 'Answer: 3'])
  const result = await answerSearch({ produce: stub.produce })
  expect(result.status).toBe('split')
})

test('an attempt with no Answer line does not vote', async () => {
  const stub = scripted(['I believe it is 7.', 'Answer: 7', 'Answer: 7'])
  const result = await answerSearch({ produce: stub.produce, maxAttempts: 3 })
  expect(result.attempts[0]!.rejected).toEqual(['did not commit to a final `Answer:` line'])
  expect(result.status).toBe('stable')
  expect(result.clusters[0]!.count).toBe(2)
})

test('one surviving attempt is unconfirmed, and none is no answer', async () => {
  const one = await answerSearch({ produce: scripted(['Answer: 5', '2 + 2 = 5\nAnswer: 5', 'no idea']).produce, maxAttempts: 3 })
  expect(one.status).toBe('unconfirmed')
  const none = await answerSearch({ produce: scripted(['no idea', 'still no idea']).produce, maxAttempts: 2 })
  expect(none.status).toBe('no-answer')
  expect(none.best?.text).toBe('no idea')
})

test('prose answers are not voted on, and do not buy an escalation', async () => {
  const essay = `Answer: ${'the scheduler retries each job with exponential backoff and a cap, '.repeat(3)}`
  const stub = scripted([essay, `${essay} differently worded`])
  const result = await answerSearch({ produce: stub.produce })
  expect(result.status).toBe('not-comparable')
  expect(result.attempts).toHaveLength(2)
})

test('a producer that throws costs an attempt and is reported, and the search goes on', async () => {
  const stub = scripted([new Error('provider timed out'), 'Answer: 9', 'Answer: 9', 'Answer: 9'])
  const result = await answerSearch({ produce: stub.produce })
  expect(result.attempts[0]!.rejected).toEqual(['attempt failed: provider timed out'])
  expect(result.status).toBe('stable')
})

test('an aborted search says so', async () => {
  const controller = new AbortController()
  const produce: AnswerProducer = async () => {
    controller.abort()
    return { text: 'Answer: 1' }
  }
  const result = await answerSearch({ produce, signal: controller.signal })
  expect(result.status).toBe('aborted')
  expect(result.attempts).toHaveLength(2)
})

test('an answer already given is the first attempt, so agreement costs one challenger', async () => {
  const stub = scripted(['12 × 4 = 48\nAnswer: 48'])
  const result = await answerSearch({ first: { text: 'So it is 48.\nAnswer: 48', cost: 0 }, produce: stub.produce })
  expect(stub.calls()).toBe(1)
  expect(stub.approaches).toEqual(['other-route'])
  expect(result.status).toBe('stable')
  expect(overturned(result)).toBe(false)
})

test('challengers that agree with each other and not with the answer given overturn it', async () => {
  const stub = scripted(['Answer: 5332114', 'Answer: 5332114', 'Answer: 5332114'])
  const result = await answerSearch({ first: { text: 'Answer: 5331114' }, produce: stub.produce })
  expect(result.status).toBe('majority')
  expect(overturned(result)).toBe(true)
  expect(result.best?.answer).toBe('5332114')
})

test('a split is not an overturn: the answer given stands, flagged', async () => {
  const stub = scripted(['Answer: 2', 'Answer: 3', 'Answer: 4', 'Answer: 5'])
  const result = await answerSearch({ first: { text: 'Answer: 1' }, produce: stub.produce })
  expect(result.status).toBe('split')
  expect(overturned(result)).toBe(false)
})

test('finding part of an answer does not overturn it (seen live on MIN_OBSERVATIONS)', async () => {
  // The turn found both definitions; the scouts each found one.
  const stub = scripted(['Answer: src/reason/library.ts (5)', 'Answer: src/reason/library.ts: 5', 'Answer: src/reason/library.ts defines MIN_OBSERVATIONS as 5'])
  const result = await answerSearch({ first: { text: `Answer: ${LIVE[0]}` }, produce: stub.produce })
  // One challenger, and no escalation: it found part of the answer and contradicted none of it.
  expect(stub.calls()).toBe(1)
  expect(overturned(result)).toBe(false)
  expect(covers(answerKey(LIVE[0]!), answerKey(LIVE[1]!))).toBe(true)
  expect(covers(answerKey(LIVE[1]!), answerKey(LIVE[0]!))).toBe(false)
  // A different file, or the same file with a different value, is a contradiction.
  expect(covers(answerKey('src/a.ts (5)'), answerKey('src/b.ts (5)'))).toBe(false)
  expect(covers(answerKey('src/a.ts (5)'), answerKey('src/a.ts (6)'))).toBe(false)
  expect(covers('42', '41')).toBe(false)
})

test('only a reply that commits to a short answer is worth a challenger', () => {
  expect(checkableAnswer('It is in library.ts.\nAnswer: src/reason/library.ts')).toBe('src/reason/library.ts')
  expect(checkableAnswer('Answer: 42')).toBe('42')
  expect(checkableAnswer('The scheduler retries with backoff.')).toBeUndefined()
  expect(checkableAnswer(`Answer: ${'it retries each job with a capped exponential backoff and then '.repeat(3)}`)).toBeUndefined()
})

test('a challenger gets the conversation before the question, text only and capped, newest last', () => {
  const context = conversationContext([
    { role: 'user', content: [{ type: 'text', text: 'look at the retry helper' }] },
    { role: 'assistant', content: [{ type: 'tool_use' }, { type: 'text', text: 'It is in src/net/retry.ts.' }] },
    { role: 'user', content: [{ type: 'tool_result' }] },
  ])
  expect(context).toBe('The conversation before this question, for context only:\nUser: look at the retry helper\nelia: It is in src/net/retry.ts.')
  expect(conversationContext([])).toBe('')
  const long = conversationContext(Array.from({ length: 50 }, (_, index) => ({ role: 'user', content: `message ${index} ${'x'.repeat(500)}` })), 1_000)
  expect(long.length).toBeLessThan(1_200)
  expect(long).toContain('message 49')
  expect(long).not.toContain('message 0 ')
})

const repo = mkdtempSync(join(tmpdir(), 'elia-answer-'))
mkdirSync(join(repo, 'src'), { recursive: true })
writeFileSync(join(repo, 'src', 'retry.ts'), 'a\nb\n')
afterAll(() => rmSync(repo, { recursive: true, force: true }))

test('the citation check rejects an answer that cites a file that is not there', () => {
  const check = citationCheck(repo)
  expect(check.run('It is in src/retry.ts:2\nAnswer: src/retry.ts').passed).toBe(true)
  const missing = check.run('It is in src/backoff.ts:9\nAnswer: src/backoff.ts')
  expect(missing.passed).toBe(false)
  expect(missing.detail).toContain('src/backoff.ts')
  expect(arithmeticCheck().run('2 + 2 = 4').passed).toBe(true)
})
