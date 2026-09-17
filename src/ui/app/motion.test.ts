import { expect, test } from 'bun:test'
import { easeToward, mixColor, parseHex, pulseLevel, shimmerRuns, sparkFrame, SPARK_FRAME_MS, stallLevel, STALL_AFTER_MS, STALL_FULL_MS } from './motion.ts'
import { sparkFrames } from './theme.ts'

test('the spark steps through its shapes on a fixed beat and breathes back', () => {
  expect(sparkFrame(0)).toBe('·')
  expect(sparkFrame(SPARK_FRAME_MS - 1)).toBe('·')
  expect(sparkFrame(SPARK_FRAME_MS)).toBe('✧')
  expect(sparkFrame(SPARK_FRAME_MS * 5)).toBe('✸')
  // Forward and back: the shape after the largest is the one before it.
  expect(sparkFrame(SPARK_FRAME_MS * 6)).toBe('✷')
  expect(sparkFrame(SPARK_FRAME_MS * sparkFrames.length)).toBe('·')
  // A clock read before the start never indexes out of range.
  expect(sparkFrame(-500)).toBe('·')
})

test('the spark frames are all one column wide, so the label never shifts', () => {
  for (const frame of sparkFrames) expect(Bun.stringWidth(frame)).toBe(1)
})

test('a running dot breathes from bright to dim and back', () => {
  expect(pulseLevel(0)).toBeCloseTo(1)
  expect(pulseLevel(600)).toBeCloseTo(0)
  expect(pulseLevel(1_200)).toBeCloseTo(1)
})

test('colours blend in hex and snap when they are named', () => {
  expect(parseHex('#ff8000')).toEqual([255, 128, 0])
  expect(parseHex('yellow')).toBeUndefined()
  expect(mixColor('#000000', '#ffffff', 0)).toBe('#000000')
  expect(mixColor('#000000', '#ffffff', 1)).toBe('#ffffff')
  expect(mixColor('#000000', '#ffffff', 0.5)).toBe('#808080')
  expect(mixColor('yellow', 'red', 0.2)).toBe('yellow')
  expect(mixColor('yellow', 'red', 0.8)).toBe('red')
  expect(mixColor(undefined, '#ffffff', 0.3)).toBeUndefined()
})

test('the shimmer is one plain run when there is nothing to blend', () => {
  expect(shimmerRuns('Reading app.ts…', 500, 'yellow', 'yellowBright')).toEqual([{ text: 'Reading app.ts…', color: 'yellow' }])
  expect(shimmerRuns('Reading app.ts…', 500, undefined, undefined)).toEqual([{ text: 'Reading app.ts…', color: undefined }])
  expect(shimmerRuns('Reading', 500, '#e8b452', '#ffe7b0', false)).toEqual([{ text: 'Reading', color: '#e8b452' }])
})

test('the shimmer keeps every character and moves its bright band along the text', () => {
  const text = 'Checking the request…'
  const brightAt = (elapsed: number): number => {
    const runs = shimmerRuns(text, elapsed, '#000000', '#ffffff')
    expect(runs.map((run) => run.text).join('')).toBe(text)
    let offset = 0
    let best = -1
    let brightest = -1
    for (const run of runs) {
      const level = parseHex(run.color)?.[0] ?? 0
      if (level > brightest) {
        brightest = level
        best = offset
      }
      offset += Array.from(run.text).length
    }
    return best
  }
  const early = brightAt(200)
  const later = brightAt(500)
  expect(later).toBeGreaterThan(early)
})

test('a spark only cools once the model has been silent for a while', () => {
  expect(stallLevel(0)).toBe(0)
  expect(stallLevel(STALL_AFTER_MS)).toBe(0)
  expect(stallLevel((STALL_AFTER_MS + STALL_FULL_MS) / 2)).toBeCloseTo(0.5)
  expect(stallLevel(STALL_FULL_MS)).toBe(1)
  expect(stallLevel(STALL_FULL_MS * 3)).toBe(1)
})

test('a counter rolls toward its target and never passes it', () => {
  expect(easeToward(0, 100, 60)).toBe(33)
  expect(easeToward(99, 100, 60)).toBe(100)
  expect(easeToward(100, 100)).toBe(100)
  expect(easeToward(120, 100)).toBe(100)
  // Always at least one step, even when no time seems to have passed.
  expect(easeToward(10, 100, 0)).toBe(11)
  let shown = 0
  for (let tick = 0; tick < 40; tick += 1) shown = easeToward(shown, 1_234, 60)
  expect(shown).toBe(1_234)
})

test('a slow frame rate never leaves the counter behind', () => {
  // One late frame covers the time that passed, not a fixed fraction.
  expect(easeToward(0, 5_000, 3_000)).toBe(5_000)
  expect(easeToward(0, 5_000, 300)).toBeGreaterThan(easeToward(0, 5_000, 60))
})
