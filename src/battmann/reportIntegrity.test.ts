import { expect, test } from 'bun:test'
import { assessReportIntegrity, type ReportFacts } from './reportIntegrity.ts'

const complete: ReportFacts = {
  claims: 4, forecasts: 2, scenarios: 1, decisions: 1, outcomes: 1, resolvedQuestions: 3, ontologyObjects: 5,
  citedSources: 6, uncitedSources: 0, summaryUnverifiedFigures: [], claimsWithUnverifiedFigures: 0, forecastsWithUnverifiedFigures: 0, claimsWithoutVerifiedSources: 0,
}

// The report from the reported session: one question and one forecast, nothing else, and a summary quoting figures no evidence holds.
const hollow: ReportFacts = {
  claims: 0, forecasts: 1, scenarios: 0, decisions: 0, outcomes: 0, resolvedQuestions: 0, ontologyObjects: 0,
  citedSources: 1, uncitedSources: 6, summaryUnverifiedFigures: ['$8,000', '4.3M', '56%', '1.5%', '60%', '38%', '12%'], claimsWithUnverifiedFigures: 0, forecastsWithUnverifiedFigures: 1, claimsWithoutVerifiedSources: 0,
}

test('a fully recorded, fully grounded report has no problems and no notes', () => {
  expect(assessReportIntegrity(complete)).toEqual({ problems: [], notes: [], blocksFinal: [] })
})

test('a report with no key judgments cannot be final, and the problem names the fixing action', () => {
  const result = assessReportIntegrity({ ...complete, claims: 0 })
  expect(result.blocksFinal).toHaveLength(1)
  expect(result.blocksFinal[0]).toContain('register_claim')
  expect(result.problems).toContain(result.blocksFinal[0]!)
})

test('a missing forecast is a problem that names its actions but does not block final', () => {
  const result = assessReportIntegrity({ ...complete, forecasts: 0 })
  expect(result.problems.join(' ')).toContain('submit_forecast')
  expect(result.blocksFinal).toEqual([])
})

test('missing scenarios are a problem that names create_scenario but do not block final', () => {
  const result = assessReportIntegrity({ ...complete, scenarios: 0 })
  expect(result.problems.join(' ')).toContain('create_scenario')
  expect(result.problems.join(' ')).toContain('save nothing')
  expect(result.blocksFinal).toEqual([])
})

test('empties nobody can fix yet are notes, not problems', () => {
  const result = assessReportIntegrity({ ...complete, decisions: 0, outcomes: 0, resolvedQuestions: 0, ontologyObjects: 0 })
  expect(result.problems).toEqual([])
  expect(result.notes.map((note) => note.split(':')[0])).toEqual(['Decisions', 'Outcomes', 'Track record', 'Relationship map'])
})

test('the reported hollow report is called out for what it is', () => {
  const result = assessReportIntegrity(hollow)
  const text = result.problems.join('\n')
  expect(text).toContain('Key judgments: none recorded')
  expect(text).toContain('Scenarios and signposts: none recorded')
  expect(text).toContain('$8,000, 4.3M, 56%, 1.5%, 60%, 38% and 1 more')
  expect(text).toContain('1 forecast rationale(s)')
  expect(result.blocksFinal).toHaveLength(1)
  expect(result.notes.join('\n')).toContain('6 other evidence record(s)')
})

test('a report that cites nothing says so, and claims on unverified sources are counted', () => {
  expect(assessReportIntegrity({ ...complete, citedSources: 0 }).problems.join(' ')).toContain('cites no evidence at all')
  expect(assessReportIntegrity({ ...complete, claimsWithoutVerifiedSources: 2 }).problems.join(' ')).toContain('2 key judgment(s) rest only on unverified sources')
})
