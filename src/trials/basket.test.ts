import { expect, test } from 'bun:test'
import { DEFAULT_HORIZON_DAYS, SIGNAL_CRITERIA, basketDefinition, basketDigest, canonicalJson } from './basket.ts'
import { DEFAULT_ARM } from './cli.ts'

test('the digest does not depend on the order fields were written in', () => {
  expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe(canonicalJson({ a: [{ c: 3, d: 2 }], b: 1 }))
})

test('the digest is stable, and moves with anything the basket says', () => {
  expect(basketDigest()).toBe(basketDigest(basketDefinition(DEFAULT_HORIZON_DAYS)))
  expect(basketDigest()).toMatch(/^sha256:[0-9a-f]{64}$/)
  expect(basketDigest(basketDefinition(7))).not.toBe(basketDigest())
  expect(basketDigest({ ...basketDefinition(), criteria: { ...SIGNAL_CRITERIA, minMeasurable: 1 } })).not.toBe(basketDigest())
})

test('the default agent arm matches a coding agent trailer and nothing a person would write', () => {
  const arm = new RegExp(DEFAULT_ARM, 'im')
  expect(arm.test('feat: x\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>')).toBe(true)
  expect(arm.test('feat: x\n\nElia-Run: abc\nCo-Authored-By: Elia <a@b.c>')).toBe(true)
  expect(arm.test('feat: x\n\nCo-Authored-By: Sagnik Ray <a@b.c>')).toBe(false)
  expect(arm.test('fix: make claude retry\n\nthe word Claude in a body is not a trailer')).toBe(false)
})
