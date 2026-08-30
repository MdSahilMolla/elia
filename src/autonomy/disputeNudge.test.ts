import { expect, test } from 'bun:test'
import { disputeNudge, isDispute } from './disputeNudge.ts'

test('detects the ways a user says the last answer was wrong', () => {
  for (const message of [
    'you are hallucinating',
    "you're hallucinating",
    'you are wrong',
    "that's not right",
    'no you did not create it',
    "no you didn't",
    'stop lying',
    "it's not there",
    'there is no such folder',
    "that doesn't exist",
    'the preview didn\'t work',
  ]) {
    expect(isDispute(message)).toBe(true)
  }
})

test('does not fire on ordinary requests', () => {
  for (const message of [
    'create a folder named cargame',
    'run the game',
    'make it a web based game',
    'what are the past sessions',
    'is this the right approach?',
  ]) {
    expect(isDispute(message)).toBe(false)
  }
})

test('the nudge tells the model to re-verify from scratch and concede if wrong', () => {
  const nudge = disputeNudge('you are hallucinating')
  expect(nudge).toContain('disputing')
  expect(nudge).toContain('absolute path')
  expect(nudge).toMatch(/say so plainly|were wrong/)
  expect(disputeNudge('please add a test')).toBe('')
})
