import { expect, test } from 'bun:test'

process.env.ANTHROPIC_API_KEY ??= 'test-key-for-reason-select-test'

const { compareAttempts, failureBriefing, roundApproaches, solve } = await import('./select.ts')
const { consensusVerifier, probeVerifier } = await import('./verify.ts')
import type { Approach, AttemptRecord, Producer } from './select.ts'
import type { Candidate, Verdict } from './verify.ts'

const approach = (id: string): Approach => ({ id, instruction: `try ${id}` })

const APPROACHES = [approach('a'), approach('b'), approach('c'), approach('d')]

/** A producer whose answer is decided by a lookup table, so a test can say exactly which attempt wins. */
function scriptedProducer(answers: Record<string, string>, onCall?: (input: Parameters<Producer>[0]) => void): Producer {
  let n = 0
  return async (input) => {
    onCall?.(input)
    n += 1
    return { id: `c${n}`, approach: input.approach.id, text: answers[input.approach.id] ?? '', cost: 1 }
  }
}

/** Passes only the candidates whose text is in `correct`. Executed strength: it stands for running the thing. */
const exactVerifier = (correct: string[]) =>
  probeVerifier({
    id: 'exact',
    async probe(candidate) {
      const passed = correct.includes(candidate.text)
      return { passed, detail: passed ? 'matched' : `got ${candidate.text || '(nothing)'}`, progress: passed ? 1 : 0 }
    },
  })

const verdictOf = (overrides: Partial<Verdict>): Verdict => ({ passed: false, strength: 'executed', detail: '', evidence: '', elapsedMs: 0, ...overrides })
const recordOf = (candidate: Partial<Candidate>, verdict: Partial<Verdict>): AttemptRecord => ({
  round: 0,
  candidate: { id: 'x', approach: 'a', text: '', ...candidate },
  verdict: verdictOf(verdict),
})

test('an executed pass ends the search immediately, leaving the rest of the budget unspent', async () => {
  let calls = 0
  const result = await solve({
    approaches: APPROACHES,
    produce: scriptedProducer({ a: 'right', b: 'wrong', c: 'wrong', d: 'wrong' }, () => {
      calls += 1
    }),
    verifier: exactVerifier(['right']),
    budget: { attempts: 12 },
    width: 1,
  })

  expect(result.stopped).toBe('verified')
  expect(result.verified).toBe(true)
  expect(result.best?.text).toBe('right')
  // Width 1 and the winner first: one producer call, not twelve.
  expect(calls).toBe(1)
})

test('a wider search finds the answer a single attempt misses', async () => {
  const single = await solve({
    approaches: APPROACHES,
    produce: scriptedProducer({ a: 'wrong', b: 'wrong', c: 'right', d: 'wrong' }),
    verifier: exactVerifier(['right']),
    budget: { attempts: 1 },
    width: 1,
  })
  expect(single.verified).toBe(false)

  const wide = await solve({
    approaches: APPROACHES,
    produce: scriptedProducer({ a: 'wrong', b: 'wrong', c: 'right', d: 'wrong' }),
    verifier: exactVerifier(['right']),
    budget: { attempts: 4 },
    width: 3,
  })
  expect(wide.verified).toBe(true)
  expect(wide.best?.approach).toBe('c')
})

test('consensus alone does not end the search — agreement is not proof', async () => {
  // Every attempt returns the same wrong answer, which is exactly the case where
  // agreement is most convincing and least informative.
  const result = await solve({
    approaches: APPROACHES,
    produce: scriptedProducer({ a: 'same', b: 'same', c: 'same', d: 'same' }),
    verifier: consensusVerifier(),
    budget: { attempts: 4 },
    width: 2,
  })

  expect(result.stopped).not.toBe('verified')
  expect(result.verified).toBe(false)
  // It still spent the budget looking for something better, rather than stopping at unanimity.
  expect(result.attempts.length).toBe(4)
})

test('a caller with nothing executable to run can opt into stopping on consensus, and the result is still not "verified"', async () => {
  const result = await solve({
    approaches: APPROACHES,
    produce: scriptedProducer({ a: 'same', b: 'same', c: 'same', d: 'same' }),
    verifier: consensusVerifier(),
    budget: { attempts: 4 },
    width: 2,
    allowUnverifiedStop: true,
  })

  expect(result.stopped).toBe('verified')
  expect(result.verified).toBe(false)
  expect(result.bestVerdict?.strength).toBe('consensus')
})

test('what the check saw is carried into the next round', async () => {
  const seen: string[] = []
  await solve({
    approaches: [approach('a'), approach('b')],
    produce: async (input) => {
      seen.push(failureBriefing(input.priorFailures))
      return { id: `r${input.round}`, approach: input.approach.id, text: 'wrong', cost: 1 }
    },
    verifier: probeVerifier({
      id: 'always-fails',
      async probe() {
        return { passed: false, detail: 'rejected', evidence: 'expected 2, got 3' }
      },
    }),
    budget: { attempts: 3 },
    width: 1,
  })

  expect(seen[0]).toBe('')
  expect(seen[1]).toContain('expected 2, got 3')
  expect(seen[1]).toContain('already been tried and rejected')
})

test('later rounds keep one slot for an approach nothing has tried', () => {
  const leader = recordOf({ approach: 'a' }, { progress: 0.5 })
  const picks = roundApproaches({ approaches: APPROACHES, round: 1, width: 3, leader, tried: new Set(['a', 'b']) })

  expect(picks.map((pick) => pick.id)).toEqual(['a', 'a', 'c'])
})

test('with everything tried, later rounds spend the whole round refining the leader', () => {
  const leader = recordOf({ approach: 'b' }, { progress: 0.9 })
  const tried = new Set(['a', 'b', 'c', 'd'])
  const picks = roundApproaches({ approaches: APPROACHES, round: 1, width: 2, leader, tried })

  expect(picks.map((pick) => pick.id)).toEqual(['b', 'b'])
})

test('when nothing passes, the near-miss is what comes back', async () => {
  const progressByApproach: Record<string, number> = { a: 0.1, b: 0.9, c: 0.4, d: 0.2 }
  const result = await solve({
    approaches: APPROACHES,
    produce: scriptedProducer({ a: 'a', b: 'b', c: 'c', d: 'd' }),
    verifier: probeVerifier({
      id: 'partial',
      async probe(candidate) {
        return { passed: false, detail: 'incomplete', evidence: 'some tests failed', progress: progressByApproach[candidate.approach] ?? 0 }
      },
    }),
    budget: { attempts: 4 },
    width: 4,
  })

  expect(result.stopped).toBe('budget')
  expect(result.verified).toBe(false)
  expect(result.best?.approach).toBe('b')
  expect(result.bestVerdict?.progress).toBe(0.9)
})

test('a producer that throws costs an attempt but does not end the search, and what it threw is evidence', async () => {
  const briefings: string[] = []
  const result = await solve({
    approaches: [approach('a'), approach('b')],
    produce: async (input) => {
      briefings.push(failureBriefing(input.priorFailures))
      if (input.approach.id === 'a') throw new Error('provider timed out')
      return { id: 'ok', approach: input.approach.id, text: 'right', cost: 1 }
    },
    verifier: exactVerifier(['right']),
    budget: { attempts: 4 },
    width: 1,
  })

  expect(result.verified).toBe(true)
  expect(result.best?.text).toBe('right')
  expect(briefings[1]).toContain('provider timed out')
})

test('the attempt budget is a hard ceiling', async () => {
  let calls = 0
  const result = await solve({
    approaches: APPROACHES,
    produce: scriptedProducer({ a: 'wrong', b: 'wrong', c: 'wrong', d: 'wrong' }, () => {
      calls += 1
    }),
    verifier: exactVerifier(['right']),
    budget: { attempts: 5 },
    width: 3,
  })

  expect(calls).toBe(5)
  expect(result.attempts.length).toBe(5)
  expect(result.stopped).toBe('budget')
})

test('an aborted search stops and says so', async () => {
  const controller = new AbortController()
  const result = await solve({
    approaches: APPROACHES,
    produce: async (input) => {
      controller.abort()
      return { id: 'c', approach: input.approach.id, text: 'wrong', cost: 1 }
    },
    verifier: exactVerifier(['right']),
    budget: { attempts: 6 },
    width: 1,
    signal: controller.signal,
  })

  expect(result.stopped).toBe('aborted')
  expect(result.attempts.length).toBe(1)
})

test('ranking prefers a pass, then the stronger proof behind it', () => {
  const executedPass = recordOf({ id: 'e' }, { passed: true, strength: 'executed' })
  const consensusPass = recordOf({ id: 'c' }, { passed: true, strength: 'consensus' })
  const nearMiss = recordOf({ id: 'n' }, { passed: false, progress: 0.99 })

  expect([nearMiss, consensusPass, executedPass].sort(compareAttempts).map((record) => record.candidate.id)).toEqual(['e', 'c', 'n'])
})

test('with no approaches there is nothing to run', async () => {
  const result = await solve({
    approaches: [],
    produce: scriptedProducer({}),
    verifier: exactVerifier(['right']),
    budget: { attempts: 4 },
  })

  expect(result.stopped).toBe('no-producer')
  expect(result.best).toBeUndefined()
})

test('every candidate in a round is paid for, however early in the round the winner comes', async () => {
  const approaches = [
    { id: 'a', instruction: 'a' },
    { id: 'b', instruction: 'b' },
    { id: 'c', instruction: 'c' },
  ]
  const result = await solve({
    approaches,
    produce: async (input) => ({ id: input.approach.id, approach: input.approach.id, text: input.approach.id === 'a' ? 'right' : 'wrong', cost: 10 }),
    verifier: { id: 'v', strength: 'executed', costHint: 'cheap', run: async (candidate) => ({ passed: candidate.text === 'right', strength: 'executed', detail: '', evidence: '', elapsedMs: 0 }) },
    budget: { attempts: 3 },
    width: 3,
  })
  expect(result.verified).toBe(true)
  // The first candidate passed, and the other two had already been produced.
  expect(result.attempts).toHaveLength(1)
  expect(result.cost).toBe(30)
})
