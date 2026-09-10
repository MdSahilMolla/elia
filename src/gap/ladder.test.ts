import { expect, test } from 'bun:test'
import { CORPUS } from './corpus.ts'
import { runLadder } from './ladder.ts'
import { computeGapVector } from './scoreboard.ts'

const byId = (id: string) => CORPUS.find((d) => d.id === id)!

test('structural pre-flight catches an unbalanced brace, not the clean control', async () => {
  const result = await runLadder(byId('structural-unbalanced-brace'))
  // Structural may be skipped when the native lib isn't built in this env.
  if (result.skipped.includes('structural')) return
  expect(result.caughtBy).toContain('structural')
  expect(result.falsePositiveOnClean).toBe(false)
}, 30_000)

test('the test rung catches an off-by-one and passes the clean control', async () => {
  const result = await runLadder(byId('test-off-by-one'))
  expect(result.caughtBy).toContain('test')
  expect(result.falsePositiveOnClean).toBe(false)
}, 30_000)

test('the hygiene rung catches a hardcoded secret', async () => {
  const result = await runLadder(byId('hygiene-hardcoded-secret'))
  expect(result.caughtBy).toContain('hygiene')
}, 30_000)

test('a judgment-regime defect gets through the deterministic ladder', async () => {
  const result = await runLadder(byId('judgment-missing-authz'))
  expect(result.caught).toBe(false)
}, 30_000)

test('computeGapVector scores only the non-judgment defects and finds no false positives', async () => {
  const vector = await computeGapVector({ corpus: [byId('test-inverted-condition'), byId('judgment-intent-drift')] })
  expect(vector.defectsScored).toBe(1)
  expect(vector.mechanicalCatchRate).toBe(1)
  expect(vector.falsePositiveRate).toBe(0)
  expect(vector.escapees).toEqual([])
}, 45_000)
