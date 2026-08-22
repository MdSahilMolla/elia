import { expect, test } from 'bun:test'
import { buildIntroFrames, FACE_NEUTRAL, FACE_BLINK, FACE_LEFT, FACE_RIGHT } from './character.ts'

test('the intro is a short one-shot, not a loop', () => {
  const frames = buildIntroFrames()
  expect(frames.length).toBeGreaterThanOrEqual(3)
  // The last frame has nothing to wait for — playIntro never sleeps after it.
  expect(frames.at(-1)!.durationMs).toBe(0)
})

test('every intro frame has the same shape, so in-place redraw never leaves stray characters', () => {
  const frames = buildIntroFrames()
  const lineCount = frames[0]!.lines.length
  expect(frames.every((frame) => frame.lines.length === lineCount)).toBe(true)

  for (let row = 0; row < lineCount; row++) {
    const width = frames[0]!.lines[row]!.length
    expect(frames.every((frame) => frame.lines[row]!.length === width)).toBe(true)
  }
})

test('the intro settles on the neutral face and keeps the wordmark visible throughout', () => {
  const frames = buildIntroFrames()
  expect(frames.at(-1)!.lines[0]).toContain(FACE_NEUTRAL)
  expect(frames.every((frame) => frame.lines[1]!.includes('e l i a'))).toBe(true)
})

test('the intro blinks at least once before settling', () => {
  const frames = buildIntroFrames()
  expect(frames.some((frame) => frame.lines[0]!.includes(FACE_BLINK))).toBe(true)
})

test('face glyphs are distinct kaomoji, each the same visible width', () => {
  const faces = [FACE_NEUTRAL, FACE_BLINK, FACE_LEFT, FACE_RIGHT]
  expect(new Set(faces).size).toBe(faces.length)
  expect(new Set(faces.map((face) => [...face].length)).size).toBe(1)
})
