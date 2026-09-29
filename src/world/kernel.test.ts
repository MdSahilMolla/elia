import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendReceipt, brokenAt, calibrate, closeReceipt, normalCdf, readReceipts, scored, winProbability, type ReceiptBody } from './kernel.ts'

let dir: string
let path: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'world-kernel-'))
  path = join(dir, 'receipts.jsonl')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const body = (generation: number, overrides: Partial<ReceiptBody> = {}): ReceiptBody => ({
  generation,
  at: generation,
  surface: 'prefix',
  raw: -0.1,
  predicted: { mean: -0.1, sd: 0.05 },
  decision: 'proceed',
  reason: 'test',
  ...overrides,
})

test('the normal CDF is right where it matters', () => {
  expect(normalCdf(0)).toBeCloseTo(0.5, 6)
  expect(normalCdf(1.959964)).toBeCloseTo(0.975, 4)
  expect(normalCdf(-1)).toBeCloseTo(0.158655, 5)
})

test('a win needs the saving to clear the margin and the run-to-run noise', () => {
  // A true 5% saving reads as a 5% saving half the time.
  expect(winProbability({ mean: Math.log(0.95), sd: 0 })).toBeCloseTo(0.5, 6)
  expect(winProbability({ mean: Math.log(0.8), sd: 0.03 })).toBeGreaterThan(0.99)
  // No expected saving, a 15% chance of reading one anyway: z = −0.0513 / hypot(0.03, 0.04).
  expect(winProbability({ mean: 0, sd: 0.03 })).toBeCloseTo(0.152, 2)
  // Being unsure of the mean can only make a certain win less certain, never more.
  expect(winProbability({ mean: Math.log(0.8), sd: 0.3 })).toBeLessThan(winProbability({ mean: Math.log(0.8), sd: 0.03 }))
})

test('receipts form a hash chain, so a rewritten prediction is found', () => {
  appendReceipt(body(1), path)
  appendReceipt(body(2), path)
  appendReceipt(body(3), path)
  expect(brokenAt(readReceipts(path))).toBeUndefined()

  const lines = readFileSync(path, 'utf8').trim().split('\n')
  // Rewrite the second prediction after the fact to look better.
  const forged = { ...JSON.parse(lines[1]!), predicted: { mean: -0.5, sd: 0.05 } }
  writeFileSync(path, [lines[0], JSON.stringify(forged), lines[2]].join('\n') + '\n')
  expect(brokenAt(readReceipts(path))).toBe(1)

  // Dropping a receipt from the middle is found too.
  writeFileSync(path, [lines[0], lines[2]].join('\n') + '\n')
  expect(brokenAt(readReceipts(path))).toBe(1)
})

test('a receipt is closed by appending, never by editing the prediction', () => {
  const open = appendReceipt(body(7), path)!
  const closed = closeReceipt(open, -0.06, path)!
  expect(closed.predicted).toEqual(open.predicted)
  expect(closed.actual).toBe(-0.06)
  expect(closed.z).toBeCloseTo((-0.06 - -0.1) / 0.05, 9)
  expect(readReceipts(path)).toHaveLength(2)
  expect(brokenAt(readReceipts(path))).toBeUndefined()
  // Only the closed one is a scored prediction, once, however often it was recorded.
  expect(scored(readReceipts(path)).map((r) => r.generation)).toEqual([7])
})

test('with too few scored predictions the ledger does not move the model', () => {
  const a = appendReceipt(body(1), path)!
  closeReceipt(a, -0.2, path)
  expect(calibrate(readReceipts(path))).toMatchObject({ n: 1, k: 1, sdScale: 1 })
  expect(calibrate([]).coverage).toBeUndefined()
})

test('the coefficient and the confidence are read back from measured residuals', () => {
  // The arithmetic keeps predicting twice the saving that shows up: k should halve, and the model was overconfident.
  for (let generation = 1; generation <= 5; generation++) {
    const open = appendReceipt(body(generation, { raw: -0.1, predicted: { mean: -0.1, sd: 0.02 } }), path)!
    closeReceipt(open, -0.05, path)
  }
  const calibration = calibrate(readReceipts(path))
  expect(calibration.n).toBe(5)
  expect(calibration.k).toBeCloseTo(0.5, 6)
  // z = (−0.05 − −0.1) / 0.02 = 2.5 on every one: too sure, and none inside its own 95% interval.
  expect(calibration.sdScale).toBeCloseTo(2.5, 6)
  expect(calibration.coverage).toBe(0)
})

test('one strange run cannot turn the coefficient off, and a quiet prediction says nothing about it', () => {
  for (let generation = 1; generation <= 4; generation++) {
    const open = appendReceipt(body(generation, { raw: -0.1 }), path)!
    closeReceipt(open, generation === 1 ? 5 : -0.1, path)
  }
  const tiny = appendReceipt(body(9, { raw: 0.001, predicted: { mean: 0.001, sd: 0.03 } }), path)!
  closeReceipt(tiny, 0.5, path)
  const calibration = calibrate(readReceipts(path))
  expect(calibration.k).toBeGreaterThanOrEqual(0.5)
  expect(calibration.k).toBeLessThanOrEqual(1.5)
  expect(calibration.k).toBeCloseTo(1, 6)
})

test('an unreadable or missing ledger is an empty one', () => {
  expect(readReceipts(join(dir, 'nope.jsonl'))).toEqual([])
  writeFileSync(path, 'not json\n{"generation":1}\n')
  expect(readReceipts(path)).toHaveLength(1)
})
