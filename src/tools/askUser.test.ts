import { afterEach, expect, test } from 'bun:test'
import { askUserTool, setOperatorPrompt } from './askUser.ts'
import { setActiveMode } from '../autonomy/mode.ts'
import { spendCeilingUsd } from '../spendLimit.ts'

/**
 * `ask_user` is the only question a cyber run may ask, so what it must not be is
 * a question that changes nothing. These tests pin the side effect: an approved
 * ceiling has to reach `ELIA_MAX_SPEND_USD`, because `spendState` is re-read at
 * the top of every turn and an approval that does not move the limit is asked
 * again on the next one.
 */

const previous = process.env.ELIA_MAX_SPEND_USD

afterEach(() => {
  setOperatorPrompt(null)
  setActiveMode('dev')
  if (previous === undefined) delete process.env.ELIA_MAX_SPEND_USD
  else process.env.ELIA_MAX_SPEND_USD = previous
})

test('an approved ceiling reaches the environment, so the run can actually continue', async () => {
  setActiveMode('cyber')
  process.env.ELIA_MAX_SPEND_USD = '1'
  setOperatorPrompt(async () => '7.5')

  const result = await askUserTool.execute({ question: 'flag is decoded, need radare2 to confirm', usd: 7.5 })

  expect(spendCeilingUsd()).toBe(7.5)
  expect(String(result)).toContain('approved')
  expect(String(result)).toContain('$7.50')
})

test('a lower answer is still the operator\'s number, and it is applied', async () => {
  setActiveMode('cyber')
  process.env.ELIA_MAX_SPEND_USD = '1'
  setOperatorPrompt(async () => '3')

  const result = await askUserTool.execute({ question: 'need one more pass at the heap', usd: 12 })

  expect(spendCeilingUsd()).toBe(3)
  expect(String(result)).toContain('less than')
})

test('the floor is what has been spent, not what the model asked for', async () => {
  // Nothing has been spent in this session, so a small positive ceiling is
  // genuinely above the floor and must be applied. The refusal case
  // (a ceiling at or below spend) is covered in spendLimit.test.ts, which can
  // set spend directly; here the point is that a low number is not rejected just
  // for looking lower than the model's ask.
  setActiveMode('cyber')
  process.env.ELIA_MAX_SPEND_USD = '1'
  setOperatorPrompt(async () => '0.5')

  await askUserTool.execute({ question: 'tiny top-up', usd: 5 })

  expect(spendCeilingUsd()).toBe(0.5)
})

test('a zero answer is not a budget, however the operator types it', async () => {
  setActiveMode('cyber')
  process.env.ELIA_MAX_SPEND_USD = '1'
  setOperatorPrompt(async () => '0')

  const result = await askUserTool.execute({ question: 'top-up?', usd: 5 })

  expect(String(result)).toContain('not an amount')
  expect(spendCeilingUsd()).toBe(1)
})

test('a declined or non-numeric answer leaves the ceiling alone', async () => {
  setActiveMode('cyber')
  process.env.ELIA_MAX_SPEND_USD = '1'

  setOperatorPrompt(async () => undefined)
  expect(String(await askUserTool.execute({ question: 'more budget?', usd: 5 }))).toContain('declined')
  expect(spendCeilingUsd()).toBe(1)

  setOperatorPrompt(async () => 'lots')
  expect(String(await askUserTool.execute({ question: 'more budget?', usd: 5 }))).toContain('not an amount')
  expect(spendCeilingUsd()).toBe(1)
})

test('refuses outside cyber, and says so without prompting anyone', async () => {
  setActiveMode('dev')
  process.env.ELIA_MAX_SPEND_USD = '1'
  let prompted = false
  setOperatorPrompt(async () => {
    prompted = true
    return '9'
  })

  expect(String(await askUserTool.execute({ question: 'more budget?', usd: 9 }))).toContain('cyber')
  expect(prompted).toBe(false)
  expect(spendCeilingUsd()).toBe(1)
})

test('refuses with nobody at a terminal, rather than hanging', async () => {
  setActiveMode('cyber')
  setOperatorPrompt(null)
  expect(String(await askUserTool.execute({ question: 'more budget?', usd: 5 }))).toContain('nobody at a terminal')
})

test('rejects an empty question before it reaches a person', async () => {
  setActiveMode('cyber')
  let prompted = false
  setOperatorPrompt(async () => {
    prompted = true
    return '5'
  })
  expect(askUserTool.execute({ question: '   ', usd: 5 })).rejects.toThrow()
  expect(prompted).toBe(false)
})
