import { expect, test } from 'bun:test'

process.env.ANTHROPIC_API_KEY ??= 'test-key-for-hypothesis-tool-test'

const { createHypothesisTool } = await import('./engine.ts')
import type { GenerationRecord } from './ledger.ts'

const judged = [
  {
    generation: 13,
    at: 0,
    hypothesis: 'Add explicit file path verification guidance to system prompt and trim redundant verbosity',
    rationale: '',
    targetFiles: ['src/config.ts'],
    changedFiles: ['src/config.ts'],
    verdict: 'rejected',
    reason: 'no measurable improvement (pass rate unchanged at 98%, tokens +1%, time +79%) on held-task-7',
    model: 'mercury-2.5',
  },
] as GenerationRecord[]

const repeat = { title: 'Add file path verification guidance to the system prompt', rationale: 'models cite paths that do not exist', plan: 'add a paragraph', targetFiles: ['src/config.ts'] }

test('a repeat of a judged idea is sent back once, redacted, then accepted with the echo recorded', async () => {
  const capture = createHypothesisTool({ records: judged, heldOutIds: ['held-task-7'] })
  const first = capture.tool.execute(repeat)
  await expect(first).rejects.toThrow('the same idea as generation 13')
  await expect(capture.tool.execute(repeat)).resolves.toContain('Hypothesis recorded')
  expect(capture.taken()?.title).toBe(repeat.title)
  expect(capture.echo()).toMatchObject({ generation: 13, judgement: 'rejected' })
})

test('the bounce names no held-out task', async () => {
  const capture = createHypothesisTool({ records: judged, heldOutIds: ['held-task-7'] })
  const error = await Promise.resolve(capture.tool.execute(repeat)).catch((thrown: Error) => thrown.message)
  expect(error).toContain('a held-out task')
  expect(error).not.toContain('held-task-7')
})

test('a new idea goes straight through, and without a ledger nothing is checked', async () => {
  const capture = createHypothesisTool({ records: judged, heldOutIds: [] })
  await expect(capture.tool.execute({ ...repeat, title: 'Let find_symbol search re-exports' })).resolves.toContain('Hypothesis recorded')
  expect(capture.echo()).toBeUndefined()
  const unchecked = createHypothesisTool()
  await expect(unchecked.tool.execute(repeat)).resolves.toContain('Hypothesis recorded')
})

test('the failing tasks a change is meant to fix are kept, and blanks and non-strings are dropped', async () => {
  const capture = createHypothesisTool()
  await capture.tool.execute({ title: 't', rationale: 'r', plan: 'p', targetTasks: ['implement-to-spec', '  ', 7, 'hist-abc'] })
  expect(capture.taken()?.targetTasks).toEqual(['implement-to-spec', 'hist-abc'])
  // A cost-only change names none, and carries no field at all.
  await capture.tool.execute({ title: 't2', rationale: 'r', plan: 'p' })
  expect(capture.taken()).not.toHaveProperty('targetTasks')
})
