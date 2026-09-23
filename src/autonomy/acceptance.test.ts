import { expect, test } from 'bun:test'
import { acceptanceCriteriaFor, acceptanceVerdict, createAcceptanceTool, describeAcceptance, type CriterionVerdict } from './acceptance.ts'

const criteria = ['One user cannot read another user’s expenses', 'bun test passes', 'package.json lists only the dependencies actually used']

function met(criterion: string, evidence = 'covered by a passing test'): CriterionVerdict {
  return { criterion, met: true, evidence }
}

test('every criterion met approves, and the summary counts them', () => {
  const verdict = acceptanceVerdict(criteria, criteria.map((criterion) => met(criterion)))
  expect(verdict.verdict).toBe('approve')
  expect(verdict.summary).toBe('3 of 3 declared acceptance criteria are met.')
  expect(verdict.issues).toEqual([])
})

test('an unmet criterion blocks the run and carries the reason it is unmet', () => {
  const verdict = acceptanceVerdict(criteria, [
    met(criteria[0]!),
    { criterion: criteria[1]!, met: false, evidence: 'two isolation tests fail' },
    met(criteria[2]!),
  ])

  expect(verdict.verdict).toBe('revise')
  expect(verdict.issues).toHaveLength(1)
  expect(verdict.issues[0]!.severity).toBe('blocker')
  expect(verdict.issues[0]!.detail).toContain('two isolation tests fail')
})

test('a criterion nobody reported on counts as unmet, not as passed', () => {
  // Silence about a promise is not evidence it was kept.
  const verdict = acceptanceVerdict(criteria, [met(criteria[0]!), met(criteria[1]!)])

  expect(verdict.verdict).toBe('revise')
  expect(verdict.issues[0]!.detail).toContain('never reported on')
})

test('no report at all fails closed across every criterion', () => {
  const verdict = acceptanceVerdict(criteria, undefined)
  expect(verdict.verdict).toBe('revise')
  expect(verdict.issues[0]!.detail).toContain('3 declared acceptance criteria')
})

test('a plan that declared no criteria approves, rather than inventing a failure', () => {
  expect(acceptanceVerdict([], undefined).verdict).toBe('approve')
})

test('a criterion re-punctuated by the model still matches the one it was given', () => {
  // Models re-wrap and re-quote text they copy; matching on words keeps the
  // verdict attached to its criterion instead of counting it missing.
  const verdict = acceptanceVerdict(['One user cannot read another user’s expenses'], [
    met('One user cannot read another user\'s expenses.'),
  ])
  expect(verdict.verdict).toBe('approve')
})

test('the tool refuses a report that skips a criterion', async () => {
  const capture = createAcceptanceTool(criteria)

  await expect(capture.tool.execute({ results: [{ criterion: criteria[0], met: true, evidence: 'a test' }] })).rejects.toThrow('missing a verdict for 2')
  expect(capture.taken()).toBeUndefined()

  const complete = await capture.tool.execute({ results: criteria.map((criterion) => ({ criterion, met: true, evidence: 'a test' })) })
  expect(complete).toContain('3 criterion verdict(s)')
  expect(capture.taken()).toHaveLength(3)
})

test('the tool refuses an empty report', async () => {
  const capture = createAcceptanceTool(criteria)
  await expect(capture.tool.execute({ results: [] })).rejects.toThrow('one result per criterion')
})

test('the receipt rendering marks each criterion and its evidence', () => {
  const rendered = describeAcceptance([met('a', 'test x passes'), { criterion: 'b', met: false, evidence: 'not implemented' }])
  expect(rendered).toContain('✓ a — test x passes')
  expect(rendered).toContain('✗ b — not implemented')
})

// Three of four real runs on 2026-09-23 planned without acceptance criteria, and
// the acceptance reviewer approved each one without looking. One of them shipped
// a CSV tool that never printed the "3 most common values" the user asked for.
test('a plan with no acceptance criteria is held to the user’s own request, not waved through', () => {
  const ask = 'Create a Python command-line tool named csvstat that prints the 3 most common values for text columns, with an optional --json flag.'
  const criteria = acceptanceCriteriaFor([], ask)
  expect(criteria).toHaveLength(1)
  expect(criteria[0]).toContain(ask)
  // Unreported is unmet, exactly as for a criterion the plan wrote itself.
  expect(acceptanceVerdict(criteria, undefined).verdict).toBe('revise')
  expect(acceptanceVerdict(criteria, [{ criterion: criteria[0]!, met: false, evidence: 'the CLI prints only the mode' }]).verdict).toBe('revise')
  expect(acceptanceVerdict(criteria, [{ criterion: criteria[0]!, met: true, evidence: 'csvstat.cli prints top 3 per text column' }]).verdict).toBe('approve')
})

test('a plan’s own criteria are used as written, and a very long request is clamped', () => {
  expect(acceptanceCriteriaFor(['bun test passes'], 'anything')).toEqual(['bun test passes'])
  const long = acceptanceCriteriaFor(undefined, 'build a thing '.repeat(200))[0]!
  expect(long.length).toBeLessThan(800)
  expect(acceptanceCriteriaFor(undefined, '   ')).toEqual([])
})
