import { expect, test } from 'bun:test'
import { friendlyPhase, isInternalNudge } from './phases.ts'

// The exact texts a real run put on the status row (2026-09-15).
test('pipeline phases read as what is happening, without the ◆ or the run id', () => {
  expect(friendlyPhase('◆ Orienting — run 2026-09-15-jcyc-l2bb')).toBe('Researching the request')
  expect(friendlyPhase('◆ Scaffolding — checking 3 assumption(s) the plan rests on')).toBe('Checking the 3 assumptions the plan rests on')
  expect(friendlyPhase('◆ Scaffolding — checking 1 assumption(s) the plan rests on')).toBe('Checking the 1 assumption the plan rests on')
  expect(friendlyPhase('◆ Scaffolding — repository, ignore rules, and project documents')).toBe('Setting up the project')
  expect(friendlyPhase('◆ Working — 4 steps in 2 waves')).toBe('Building — 4 steps in 2 waves')
  expect(friendlyPhase('◆ Repairing — verify attempt 1 of 2')).toBe('Fixing what the verify check found — try 1 of 2')
  expect(friendlyPhase('◆ Learning')).toBe('Saving what this run learned')
  expect(friendlyPhase('◆ polish — 1 bounded final quality pass')).toBe('Polishing')
})

test('an unknown phase passes through, minus the marker', () => {
  expect(friendlyPhase('◆ Something new — detail')).toBe('Something new — detail')
})

test("elia's notes to itself are recognised so they stay off the status row", () => {
  expect(isInternalNudge('elia: run directive applied')).toBe(true)
  expect(isInternalNudge('elia: told the model to stop re-reading files')).toBe(true)
  expect(isInternalNudge('Researching the request')).toBe(false)
})
