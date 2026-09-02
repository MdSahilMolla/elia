import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withAgentIdentity } from '../autonomy/context.ts'
import { backtestForecasts, battmannTool, calculateEnsemble, calculateForecast } from './battmann.ts'

test('forecast uses dependence groups instead of double-counting repeated coverage', () => {
  const result = JSON.parse(calculateForecast({
    question: 'Will the port remain closed through September?', asOf: '2026-09-01', horizon: '2026-10-01', resolutionCriteria: 'Official port authority reports no commercial opening before October.', priorProbability: 0.4,
    signals: [
      { id: 'a', summary: 'Authority notice', sourceUrl: 'https://port.example/notice', sourceDate: '2026-08-31', likelihoodRatio: 2, reliability: 0.9, independenceGroup: 'authority' },
      { id: 'b', summary: 'Syndicated report of the same notice', sourceUrl: 'https://news.example/story', sourceDate: '2026-08-31', likelihoodRatio: 2, reliability: 0.5, independenceGroup: 'authority' },
      { id: 'c', summary: 'Carrier schedule', sourceUrl: 'https://carrier.example/schedule', sourceDate: '2026-08-30', likelihoodRatio: 1.5, reliability: 0.8, independenceGroup: 'carrier' },
    ],
  }))
  expect(result.independentEvidenceGroups).toBe(2)
  expect(result.probability).toBeGreaterThan(0.4)
  expect(result.sensitivity).toHaveLength(2)
})

test('forecast rejects future-dated evidence', () => {
  expect(() => calculateForecast({ question: 'Q?', asOf: '2026-09-01', horizon: '2026-10-01', resolutionCriteria: 'Binary official outcome', priorProbability: 0.5, signals: [{ id: 'x', summary: 'Future item', sourceUrl: 'https://example.com', sourceDate: '2026-09-02', likelihoodRatio: 2, reliability: 0.8, independenceGroup: 'x' }] })).toThrow('cannot be after asOf')
})

test('backtest reports proper scores and baseline skill', () => {
  const result = JSON.parse(backtestForecasts({ forecasts: [{ probability: 0.8, outcome: 1 }, { probability: 0.2, outcome: 0 }, { probability: 0.7, outcome: 1 }, { probability: 0.3, outcome: 0 }] }))
  expect(result.brierScore).toBeLessThan(result.baselineBrierScore)
  expect(result.brierSkillScore).toBeGreaterThan(0)
  expect(result.calibrationBins.length).toBeGreaterThan(0)
})

test('ensemble prevents correlated variants from gaining influence by duplication', () => {
  const result = JSON.parse(calculateEnsemble({
    question: 'Will the restriction remain?', asOf: '2026-09-01', horizon: '2026-10-01', resolutionCriteria: 'The official restriction remains active.',
    components: [
      { id: 'model-a-1', probability: 0.9, weight: 1, independenceGroup: 'same-model-and-evidence', method: 'model A prompt 1' },
      { id: 'model-a-2', probability: 0.9, weight: 1, independenceGroup: 'same-model-and-evidence', method: 'model A prompt 2' },
      { id: 'base-rate', probability: 0.3, weight: 1, independenceGroup: 'historical-base-rate', method: 'historical reference class' },
    ],
  }))
  expect(result.independentGroups).toBe(2)
  expect(result.probability).toBe(0.6)
  expect(result.sensitivity).toHaveLength(2)
})

test('report writes validated industry Markdown and JSON sidecar', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'elia-battmann-'))
  const result = JSON.parse(await withAgentIdentity({ name: 'test', role: 'lead', cwd }, () => battmannTool.execute({
    action: 'report', title: 'Supply Chain Risk Brief', asOf: '2026-09-01', executiveSummary: 'A sourced decision brief.', outputPath: 'reports/brief.md',
    keyJudgments: [{ statement: 'Port disruption remains material.', classification: 'judgement', confidence: 'medium', evidenceIds: ['s1'] }],
    forecasts: [{ question: 'Will disruption persist?', probability: 0.65, horizon: '2026-10-01', resolutionCriteria: 'Official port closure remains in force.', confidence: 'medium', evidenceIds: ['s1'] }],
    indicators: ['Official reopening notice'], limitations: ['No proprietary shipment feed was available.'],
    sources: [{ id: 's1', title: 'Port notice', url: 'https://port.example/notice', publishedAt: '2026-08-31', retrievedAt: '2026-09-01' }],
  })))
  expect(existsSync(result.reportPath)).toBe(true)
  expect(existsSync(result.sidecarPath)).toBe(true)
  expect(readFileSync(result.reportPath, 'utf8')).toContain('## Evidence ledger')
})

test('report rejects unknown evidence references', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'elia-battmann-'))
  await expect(withAgentIdentity({ name: 'test', role: 'lead', cwd }, () => battmannTool.execute({ action: 'report', title: 'Brief', asOf: '2026-09-01', executiveSummary: 'Summary', outputPath: 'brief.md', keyJudgments: [{ statement: 'Claim', classification: 'observed_fact', confidence: 'high', evidenceIds: ['missing'] }], sources: [{ id: 's1', title: 'Source', url: 'https://example.com', publishedAt: '2026-08-31', retrievedAt: '2026-09-01' }] }))).rejects.toThrow('known evidenceIds')
})

test('persistent forecast ledger preserves revisions and scores an accepted resolution', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'elia-battmann-store-'))
  const run = (input: Record<string, unknown>) => withAgentIdentity({ name: 'test', role: 'lead', cwd }, () => battmannTool.execute(input))
  const now = Date.now()
  const openedAt = new Date(now - 172_800_000).toISOString()
  const firstAsOf = new Date(now - 86_400_000).toISOString()
  const secondAsOf = new Date(now - 3_600_000).toISOString()
  const horizon = new Date(now + 86_400_000).toISOString()
  await run({ action: 'register_evidence', evidenceId: 'e1', title: 'Authority notice', url: 'https://authority.example/notice', sourceType: 'primary', publishedAt: openedAt, retrievedAt: openedAt, excerpt: 'The authority expects the restriction to remain in force.', independenceGroup: 'authority', reliability: 0.9 })
  await run({ action: 'create_question', questionId: 'q1', question: 'Will the restriction remain in force?', domain: 'trade', openedAt, horizon, resolutionCriteria: 'The authority notice remains active at the stated horizon.' })
  const first = JSON.parse(await run({ action: 'submit_forecast', forecastId: 'f1', questionId: 'q1', probability: 0.6, priorProbability: 0.5, asOf: firstAsOf, method: 'base-rate plus evidence', forecaster: 'Battmann', rationale: 'The primary notice increases the probability.', evidenceIds: ['e1'] }))
  const second = JSON.parse(await run({ action: 'submit_forecast', forecastId: 'f2', questionId: 'q1', probability: 0.8, priorProbability: 0.5, asOf: secondAsOf, method: 'base-rate plus evidence', forecaster: 'Battmann', rationale: 'No reopening notice appeared.', evidenceIds: ['e1'] }))
  expect(first.revision).toBe(1)
  expect(second.revision).toBe(2)
  expect(second.parentRevisionId).toBe('f1')
  await run({ action: 'resolve_question', resolutionId: 'r1', questionId: 'q1', outcome: 1, resolvedAt: new Date().toISOString(), resolutionSourceUrl: 'https://authority.example/resolution', resolver: 'analyst@example', rationale: 'The official restriction remained active.' })
  const detail = JSON.parse(await run({ action: 'question_detail', questionId: 'q1' }))
  expect(detail.forecasts).toHaveLength(2)
  expect(detail.question.status).toBe('resolved')
  const score = JSON.parse(await run({ action: 'scorecard' }))
  expect(score.sampleSize).toBe(1)
  expect(score.brierScore).toBe(0.04)
})

test('persistent forecast ledger rejects evidence unavailable at forecast time', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'elia-battmann-leakage-'))
  const run = (input: Record<string, unknown>) => withAgentIdentity({ name: 'test', role: 'lead', cwd }, () => battmannTool.execute(input))
  await run({ action: 'register_evidence', evidenceId: 'late', title: 'Later notice', url: 'https://authority.example/later', sourceType: 'primary', publishedAt: '2020-09-10', retrievedAt: '2020-09-10', excerpt: 'A later event occurred.', independenceGroup: 'authority', reliability: 0.9 })
  await run({ action: 'create_question', questionId: 'q1', question: 'Will the event occur?', openedAt: '2020-09-01', horizon: '2020-10-01', resolutionCriteria: 'The authority confirms the event.' })
  await expect(run({ action: 'submit_forecast', questionId: 'q1', probability: 0.7, asOf: '2020-09-05', method: 'evidence update', forecaster: 'Battmann', rationale: 'Attempted future leakage.', evidenceIds: ['late'] })).rejects.toThrow('was not available')
})

test('live scorecard falls back to the latest revision physically recorded before resolution', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'elia-battmann-live-cutoff-'))
  const run = (input: Record<string, unknown>) => withAgentIdentity({ name: 'test', role: 'lead', cwd }, () => battmannTool.execute(input))
  await run({ action: 'register_evidence', evidenceId: 'e1', title: 'Authority record', url: 'https://authority.example/item', sourceType: 'primary', publishedAt: '2020-01-01', retrievedAt: '2020-01-01', excerpt: 'The authority published a record.', independenceGroup: 'authority', reliability: 0.9 })
  await run({ action: 'create_question', questionId: 'q1', question: 'Will the event occur?', openedAt: '2020-01-01', horizon: new Date(Date.now() + 86_400_000).toISOString(), resolutionCriteria: 'The authority confirms the event.' })
  await run({ action: 'submit_forecast', forecastId: 'eligible', questionId: 'q1', probability: 0.6, asOf: '2020-01-02', method: 'first estimate', forecaster: 'Battmann', rationale: 'Recorded before the outcome cutoff.', evidenceIds: ['e1'] })
  const resolutionCutoff = new Date().toISOString()
  await Bun.sleep(5)
  await run({ action: 'submit_forecast', forecastId: 'late-entry', questionId: 'q1', probability: 0.9, asOf: '2020-01-03', method: 'late estimate', forecaster: 'Battmann', rationale: 'Physically entered after the outcome cutoff.', evidenceIds: ['e1'] })
  await run({ action: 'resolve_question', resolutionId: 'r1', questionId: 'q1', outcome: 1, resolvedAt: resolutionCutoff, resolutionSourceUrl: 'https://authority.example/resolution', resolver: 'resolver', rationale: 'The official outcome record.' })
  const score = JSON.parse(await run({ action: 'scorecard' }))
  expect(score.sampleSize).toBe(1)
  expect(score.brierScore).toBe(0.16)
})

test('evidence graph, ontology, scenario, decision, and outcome remain auditable', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'elia-battmann-graph-'))
  const run = (input: Record<string, unknown>) => withAgentIdentity({ name: 'test', role: 'lead', cwd }, () => battmannTool.execute(input))
  await run({ action: 'register_evidence', evidenceId: 'e1', title: 'Registry filing', url: 'https://registry.example/filing', publisher: 'Registry', sourceType: 'primary', publishedAt: '2020-08-30', retrievedAt: '2020-09-01', excerpt: 'Northwind owns the terminal.', independenceGroup: 'registry', reliability: 0.95 })
  await run({ action: 'register_claim', claimId: 'c1', statement: 'Northwind owns the terminal.', classification: 'observed_fact', confidence: 'high', asOf: '2020-09-01', evidenceLinks: [{ evidenceId: 'e1', relation: 'supports', supportingExcerpt: 'Northwind owns the terminal.' }] })
  await run({ action: 'review_claim', reviewId: 'cr1', claimId: 'c1', verdict: 'supported', reviewer: 'independent-reviewer', reviewedAt: '2020-09-02', notes: 'The filing directly supports the ownership claim.' })
  await run({ action: 'upsert_object', objectId: 'northwind', objectType: 'organization', name: 'Northwind', validFrom: '2020-09-01', confidence: 'high', properties: { sector: 'logistics' }, evidenceIds: ['e1'] })
  await run({ action: 'upsert_object', objectId: 'terminal', objectType: 'facility', name: 'Northwind Terminal', validFrom: '2020-09-01', confidence: 'high', properties: { kind: 'port-terminal' }, evidenceIds: ['e1'] })
  await run({ action: 'link_objects', linkId: 'owns-1', fromId: 'northwind', toId: 'terminal', linkType: 'owns', validFrom: '2020-09-01', confidence: 'high', evidenceIds: ['e1'] })
  await run({ action: 'create_question', questionId: 'q1', question: 'Will terminal throughput fall?', openedAt: '2020-09-01', horizon: '2020-12-01', resolutionCriteria: 'Published monthly throughput is below the stated threshold.' })
  await run({ action: 'create_scenario', scenarioId: 's1', title: 'Terminal disruption', baseAsOf: '2020-09-02', horizon: '2020-12-01', probability: 0.4, assumptions: ['Restrictions persist'], questionIds: ['q1'], evidenceIds: ['e1'], indicators: ['Weekly vessel calls'], status: 'active' })
  await run({ action: 'record_decision', decisionId: 'd1', scenarioId: 's1', title: 'Diversify terminal capacity', options: [{ id: 'wait', label: 'Wait' }, { id: 'diversify', label: 'Diversify' }], chosenOption: 'diversify', rationale: 'Reduce concentration risk.', status: 'approved', approvedBy: 'operations-lead', decidedAt: '2020-09-03' })
  await run({ action: 'record_outcome', outcomeId: 'o1', decisionId: 'd1', observedAt: '2020-09-20', summary: 'Alternative capacity was secured.', metrics: { capacityAdded: 20 }, evidenceIds: ['e1'] })
  const snapshot = JSON.parse(await run({ action: 'workspace_snapshot' }))
  expect(snapshot.counts.claims).toBe(1)
  expect(snapshot.counts.claim_reviews).toBe(1)
  expect(snapshot.counts.ontology_objects).toBe(2)
  expect(snapshot.counts.ontology_links).toBe(1)
  expect(snapshot.counts.scenarios).toBe(1)
  expect(snapshot.counts.decisions).toBe(1)
  expect(snapshot.counts.outcomes).toBe(1)
  expect(snapshot.recentClaims[0].latest_review).toBe('supported')
  const bundle = JSON.parse(await run({ action: 'report_from_store', reportId: 'report-1', reportVersion: '1.0', reportStatus: 'final', title: 'Terminal Risk Decision Brief', executiveSummary: 'The evidence and decision record support a bounded mitigation.', author: 'Battmann', reviewer: 'independent-reviewer', documentClassification: 'internal', distribution: ['Operations leadership'], asOf: '2020-09-20', questionIds: ['q1'], outputPath: 'reports/terminal-risk.md' }))
  expect(bundle.reportStatus).toBe('final')
  expect(existsSync(bundle.reportPath)).toBe(true)
  expect(existsSync(bundle.sidecarPath)).toBe(true)
  expect(existsSync(bundle.htmlPath)).toBe(true)
  expect(readFileSync(bundle.reportPath, 'utf8')).toContain('## Document control')
  expect(readFileSync(bundle.reportPath, 'utf8')).toContain('## Forecast track record')
  expect(readFileSync(bundle.reportPath, 'utf8')).toContain('### Recorded outcomes')
  const printable = readFileSync(bundle.htmlPath, 'utf8')
  expect(printable).toContain('<!doctype html>')
  expect(printable).toContain('Scenarios and signposts')
  expect(printable).toContain('Recorded outcomes')
  expect(JSON.parse(readFileSync(bundle.sidecarPath, 'utf8')).outcomes).toHaveLength(1)
})

test('final store report fails closed when claim review is unresolved', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'elia-battmann-report-review-'))
  const run = (input: Record<string, unknown>) => withAgentIdentity({ name: 'test', role: 'lead', cwd }, () => battmannTool.execute(input))
  await run({ action: 'register_evidence', evidenceId: 'e1', title: 'Source', url: 'https://source.example/item', sourceType: 'primary', publishedAt: '2026-01-01', retrievedAt: '2026-01-01', excerpt: 'The event was recorded.', independenceGroup: 'source', reliability: 0.9 })
  await run({ action: 'register_claim', claimId: 'c1', statement: 'The event occurred.', classification: 'observed_fact', confidence: 'medium', asOf: '2026-01-02', evidenceLinks: [{ evidenceId: 'e1', relation: 'supports', supportingExcerpt: 'The event was recorded.' }] })
  await expect(run({ action: 'report_from_store', reportStatus: 'final', title: 'Final brief', executiveSummary: 'Summary.', author: 'Battmann', reviewer: 'reviewer', asOf: '2026-01-03', outputPath: 'reports/final.md' })).rejects.toThrow('supported claim reviews')
  const draft = JSON.parse(await run({ action: 'report_from_store', reportStatus: 'draft', title: 'Draft brief', executiveSummary: 'Summary.', author: 'Battmann', asOf: '2026-01-03', outputPath: 'reports/draft.md' }))
  expect(draft.unresolvedReviewCount).toBe(1)
})

test('chronological benchmark records a leakage-safe held-out baseline', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'elia-battmann-benchmark-'))
  const run = (input: Record<string, unknown>) => withAgentIdentity({ name: 'test', role: 'lead', cwd }, () => battmannTool.execute(input))
  await run({ action: 'register_evidence', evidenceId: 'e1', title: 'Contemporaneous record', url: 'https://records.example/item', sourceType: 'primary', publishedAt: '2026-01-01', retrievedAt: '2026-01-01', excerpt: 'A contemporaneous source.', independenceGroup: 'records', reliability: 0.9 })
  const cases = [
    { id: 'q1', openedAt: '2026-01-01', asOf: '2026-01-02', horizon: '2026-01-10', resolvedAt: '2026-01-05', probability: 0.8, outcome: 1 },
    { id: 'q2', openedAt: '2026-01-06', asOf: '2026-01-07', horizon: '2026-01-20', resolvedAt: '2026-01-12', probability: 0.2, outcome: 0 },
    { id: 'q3', openedAt: '2026-01-13', asOf: '2026-01-14', horizon: '2026-01-30', resolvedAt: '2026-01-20', probability: 0.7, outcome: 1 },
  ]
  for (const item of cases) {
    await run({ action: 'create_question', questionId: item.id, question: `Will ${item.id} occur?`, domain: 'trade', openedAt: item.openedAt, horizon: item.horizon, resolutionCriteria: `Official record resolves ${item.id}.` })
    await run({ action: 'submit_forecast', forecastId: `f-${item.id}`, forecastClass: 'backtest', questionId: item.id, probability: item.probability, asOf: item.asOf, method: 'test model', forecaster: 'Battmann', rationale: 'Historical replay forecast.', evidenceIds: ['e1'] })
    await run({ action: 'resolve_question', resolutionId: `r-${item.id}`, questionId: item.id, outcome: item.outcome, resolvedAt: item.resolvedAt, resolutionSourceUrl: `https://records.example/${item.id}`, resolver: 'resolver', rationale: 'Official record.' })
  }
  const benchmark = JSON.parse(await run({ action: 'run_benchmark', benchmarkId: 'b1', forecastClass: 'backtest', evaluationStart: '2026-01-01', evaluationEnd: '2026-01-31', minimumTraining: 1 }))
  expect(benchmark.sampleSize).toBe(3)
  expect(benchmark.leakageAudit.violations).toBe(0)
  expect(benchmark.cases[0].baselineScope).toBe('uninformed-0.5')
  expect(benchmark.cases[1].trainingSampleSize).toBe(1)
  expect(benchmark.statisticalGatePassed).toBe(false)
  expect(benchmark.warning).toContain('cannot establish live')
  const liveScore = JSON.parse(await run({ action: 'scorecard' }))
  expect(liveScore.sampleSize).toBe(0)
  const snapshot = JSON.parse(await run({ action: 'workspace_snapshot' }))
  expect(snapshot.counts.benchmark_runs).toBe(1)
})

test('persistent intelligence records reject impossible event ordering and duplicate terminal resolutions', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'elia-battmann-invariants-'))
  const run = (input: Record<string, unknown>) => withAgentIdentity({ name: 'test', role: 'lead', cwd }, () => battmannTool.execute(input))
  const future = new Date(Date.now() + 86_400_000).toISOString()
  await expect(run({ action: 'create_question', questionId: 'q-future', question: 'Can a future observation be logged now?', openedAt: future, horizon: new Date(Date.now() + 172_800_000).toISOString(), resolutionCriteria: 'The clock reaches the stated date.' })).rejects.toThrow('openedAt cannot be in the future')
  await run({ action: 'register_evidence', evidenceId: 'e1', title: 'Contemporaneous record', url: 'https://records.example/item', sourceType: 'primary', publishedAt: '2026-01-01', retrievedAt: '2026-01-01', excerpt: 'A contemporaneous source.', independenceGroup: 'records', reliability: 0.9 })
  await run({ action: 'register_claim', claimId: 'c1', statement: 'The event occurred.', classification: 'observed_fact', confidence: 'high', asOf: '2026-01-03', evidenceLinks: [{ evidenceId: 'e1', relation: 'supports', supportingExcerpt: 'A contemporaneous source.' }] })
  await expect(run({ action: 'review_claim', reviewId: 'cr-early', claimId: 'c1', verdict: 'supported', reviewer: 'reviewer', reviewedAt: '2026-01-02', notes: 'Impossible review date.' })).rejects.toThrow('before claim asOf')

  await run({ action: 'create_question', questionId: 'q1', question: 'Will the event occur?', openedAt: '2026-01-05', horizon: '2026-02-01', resolutionCriteria: 'The official record confirms the event.' })
  await expect(run({ action: 'create_scenario', scenarioId: 's-early', title: 'Premature scenario', baseAsOf: '2026-01-04', horizon: '2026-02-01', probability: 0.5, assumptions: [], questionIds: ['q1'], evidenceIds: ['e1'], indicators: [] })).rejects.toThrow('was not open at scenario baseAsOf')
  await run({ action: 'create_scenario', scenarioId: 's1', title: 'Valid scenario', baseAsOf: '2026-01-06', horizon: '2026-02-01', probability: 0.5, assumptions: [], questionIds: ['q1'], evidenceIds: ['e1'], indicators: [] })
  await expect(run({ action: 'record_decision', decisionId: 'd-early', scenarioId: 's1', title: 'Premature decision', options: [], rationale: 'Impossible decision date.', decidedAt: '2026-01-05' })).rejects.toThrow('before scenario baseAsOf')
  await run({ action: 'record_decision', decisionId: 'd1', scenarioId: 's1', title: 'Valid decision', options: [], rationale: 'Decision follows scenario.', decidedAt: '2026-01-07' })
  await expect(run({ action: 'record_outcome', outcomeId: 'o-early', decisionId: 'd1', observedAt: '2026-01-06', summary: 'Impossible outcome date.', metrics: {}, evidenceIds: ['e1'] })).rejects.toThrow('before decision decidedAt')

  await run({ action: 'resolve_question', resolutionId: 'r1', questionId: 'q1', outcome: 1, resolvedAt: '2026-02-02', resolutionSourceUrl: 'https://records.example/resolution', resolver: 'resolver', rationale: 'Official record.' })
  await expect(run({ action: 'resolve_question', resolutionId: 'r2', questionId: 'q1', outcome: 0, resolvedAt: '2026-02-03', resolutionSourceUrl: 'https://records.example/correction', resolver: 'resolver', rationale: 'Attempted overwrite.' })).rejects.toThrow('already has a terminal resolution')
  const detail = JSON.parse(await run({ action: 'question_detail', questionId: 'q1' }))
  expect(detail.question.outcome).toBe(1)
  expect(detail.resolutions).toHaveLength(1)
})
