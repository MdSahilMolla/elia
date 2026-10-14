import { afterEach, beforeEach, expect, test } from 'bun:test'
import { requestSpendIncrease, parseSpendIncreaseAnswer, spendCeilingUsd, spendIncreasePrompt, spendIncreaseQuestion, type SpendState } from '../spendLimit.ts'
import { askUserTool, setOperatorPrompt } from '../tools/askUser.ts'
import { setActiveMode } from './mode.ts'

const state = (spentUsd: number, limitUsd = 1): SpendState => ({ limitUsd, spentUsd, exceeded: true })

let env: NodeJS.ProcessEnv

beforeEach(() => {
  env = {}
  setActiveMode('dev')
  setOperatorPrompt(null)
})

afterEach(() => {
  setOperatorPrompt(null)
  setActiveMode('dev')
})

test('an approved ceiling is applied and must clear what is already spent', () => {
  const result = requestSpendIncrease(state(0.9), 5, env)
  expect(result).toEqual({ ok: true, limitUsd: 5 })
  expect(env.ELIA_MAX_SPEND_USD).toBe('5')
})

test('a ceiling at or below the amount already spent is refused, not applied', () => {
  // Approving $1 when $0.90 is already spent leaves the very next spendState
  // reporting exceeded, so the operator would be asked the same question again
  // and the run would stop again on the next step. Refusing visibly beats an
  // approval that silently does nothing.
  for (const asked of [0.9, 0.5, 0]) {
    const result = requestSpendIncrease(state(0.9), asked, env)
    expect(result.ok).toBe(false)
    expect(env.ELIA_MAX_SPEND_USD).toBeUndefined()
  }
})

test('a non-positive or unparseable amount is refused with a reason', () => {
  expect(requestSpendIncrease(state(0.1), Number.NaN, env)).toEqual({ ok: false, reason: expect.stringContaining('not an amount') })
  expect(requestSpendIncrease(state(0.1), -3, env)).toEqual({ ok: false, reason: expect.stringContaining('not an amount') })
  expect(requestSpendIncrease(state(0.1), Number.POSITIVE_INFINITY, env).ok).toBe(false)
  expect(requestSpendIncrease(state(0.1), undefined, env).ok).toBe(false)
  expect(env.ELIA_MAX_SPEND_USD).toBeUndefined()
})

test('an unknown spend total is not treated as zero, so a ceiling cannot be set under it', () => {
  // spentUsd undefined means the model has no pricing entry. Claiming 0 spent
  // would let any amount through and the run would stop on the next check.
  const result = requestSpendIncrease({ limitUsd: 1, exceeded: true }, 5, env)
  expect(result).toEqual({ ok: true, limitUsd: 5 })
})

test('the answer parser treats enter as the suggestion and anything else as a decline', () => {
  const s = state(0.4)
  expect(parseSpendIncreaseAnswer('', s, undefined)).toBe(5)
  expect(parseSpendIncreaseAnswer('', s, 12)).toBe(12)
  expect(parseSpendIncreaseAnswer('  7.50 ', s)).toBe(7.5)
  expect(parseSpendIncreaseAnswer('$3', s)).toBe(3)
  expect(parseSpendIncreaseAnswer('no', s)).toBeUndefined()
  expect(parseSpendIncreaseAnswer('-2', s)).toBeUndefined()
  expect(parseSpendIncreaseAnswer('abc', s)).toBeUndefined()
})

test('the model is told it may ask once, and that a decline means summarise', () => {
  const prompt = spendIncreasePrompt(state(0.9), 5)
  expect(prompt).toContain('ask_user')
  expect(prompt).toContain('summarise')
  expect(spendIncreaseQuestion(state(0.9), 5)).toContain('$5.00')
})

test('ask_user refuses outside cyber mode, before anyone is prompted', async () => {
  let asked = false
  setOperatorPrompt(async () => {
    asked = true
    return '10'
  })
  setActiveMode('dev')
  const out = await askUserTool.execute({ question: 'need more to finish', usd: 10 })
  expect(out).toContain('only available in cyber mode')
  expect(asked).toBe(false)
})

test('ask_user refuses when nobody is at a terminal, rather than blocking', async () => {
  setActiveMode('cyber')
  const out = await askUserTool.execute({ question: 'need more to finish', usd: 10 })
  expect(out).toContain('nobody at a terminal')
  expect(out).toContain('Summarise')
})

test('ask_user reports a decline as a summary instruction, not an error', async () => {
  setActiveMode('cyber')
  setOperatorPrompt(async () => undefined)
  const out = await askUserTool.execute({ question: 'need more to finish', usd: 10 })
  expect(out).toContain('declined')
  expect(out).toContain('Summarise')
})

test('ask_user passes the question and the request through to the operator', async () => {
  setActiveMode('cyber')
  let seen = ''
  setOperatorPrompt(async (question) => {
    seen = question
    return '10'
  })
  const out = await askUserTool.execute({ question: 'one more wordlist run finishes the flag', usd: 10 })
  expect(seen).toContain('one more wordlist run finishes the flag')
  expect(out).toContain('approved a ceiling of $10')
})

test('an operator who grants less than asked has their number honoured', async () => {
  // Their money, their decision: a lower ceiling is an answer, not a failure.
  setActiveMode('cyber')
  setOperatorPrompt(async () => '2')
  const out = await askUserTool.execute({ question: 'need more', usd: 20 })
  expect(out).toContain('less than the $20.00 you asked for')
  expect(out).toContain('Continue within $2.00')
  // And it is applied, not just reported back to the model.
  expect(spendCeilingUsd()).toBe(2)
})

test('ask_user validates its own input', async () => {
  setActiveMode('cyber')
  setOperatorPrompt(async () => '10')
  expect(askUserTool.execute({ question: '   ', usd: 10 })).rejects.toThrow('question must be a non-empty string')
  expect(askUserTool.execute({ question: 'x'.repeat(4001), usd: 10 })).rejects.toThrow('exceeds 4000 characters')
})
