import { expect, test } from 'bun:test'
import { hasBlockingIssues, requireCriticVerdict } from './verify.ts'

test('a missing critic verdict fails closed with a blocking issue', () => {
  const verdict = requireCriticVerdict(undefined)

  expect(verdict.verdict).toBe('revise')
  expect(verdict.issues[0]?.severity).toBe('blocker')
  expect(hasBlockingIssues(verdict)).toBe(true)
})

test('a submitted critic verdict is preserved', () => {
  const submitted = { verdict: 'approve' as const, summary: 'sound', issues: [] }
  expect(requireCriticVerdict(submitted)).toBe(submitted)
})
