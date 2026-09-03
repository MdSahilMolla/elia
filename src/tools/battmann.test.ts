import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withAgentIdentity } from '../autonomy/context.ts'
import { assessPosture, backtestForecasts, battmannTool, buildConsequenceChain, calculateEnsemble, calculateExposureAssessment, calculateForecast, calculateRiskAssessment, pairEffectors, rankAlternatives } from './battmann.ts'

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

test('risk_assessment scores factors, averages correlated ones, and reports a direction of travel', () => {
  const result = JSON.parse(calculateRiskAssessment({
    subject: 'Red Sea container routing for a European importer', asOf: '2026-09-01', priorRisk: 40,
    factors: [
      { id: 'a1', summary: 'Carrier reroutes around the Cape', sourceUrl: 'https://carrier.example/advisory', sourceDate: '2026-08-30', direction: 'aggravating', magnitude: 0.8, reliability: 0.9, independenceGroup: 'carrier-advisories', momentum: 'rising' },
      { id: 'a2', summary: 'Second carrier confirms the same reroute', sourceUrl: 'https://news.example/reroute', sourceDate: '2026-08-31', direction: 'aggravating', magnitude: 0.8, reliability: 0.5, independenceGroup: 'carrier-advisories', momentum: 'rising' },
      { id: 'm1', summary: 'Naval escort coalition expands', sourceUrl: 'https://defense.example/escort', sourceDate: '2026-08-29', direction: 'mitigating', magnitude: 0.5, reliability: 0.8, independenceGroup: 'security-posture', momentum: 'rising' },
    ],
  }))
  expect(result.independentFactorGroups).toBe(2)
  expect(result.riskScore).toBeGreaterThan(40)
  expect(result.riskScore).toBeLessThanOrEqual(100)
  expect(['low', 'moderate', 'high', 'severe']).toContain(result.band)
  expect(result.directionOfTravel.net).toBe('rising')
  expect(result.sensitivity).toHaveLength(2)
  expect(result.drivers[0].id).toBe('a1')
})

test('risk_assessment rejects future-dated factors and unknown directions', () => {
  expect(() => calculateRiskAssessment({ subject: 'x', asOf: '2026-09-01', factors: [{ id: 'f', summary: 's', sourceUrl: 'https://e.example', sourceDate: '2026-09-02', direction: 'aggravating', magnitude: 0.5, reliability: 0.5, independenceGroup: 'g', momentum: 'stable' }] })).toThrow('cannot be after asOf')
  expect(() => calculateRiskAssessment({ subject: 'x', asOf: '2026-09-01', factors: [{ id: 'f', summary: 's', sourceUrl: 'https://e.example', sourceDate: '2026-08-01', direction: 'sideways', magnitude: 0.5, reliability: 0.5, independenceGroup: 'g', momentum: 'stable' }] })).toThrow('must be aggravating or mitigating')
})

test('consequence_chain annotates order, path probability, and the weakest link', () => {
  const result = JSON.parse(buildConsequenceChain({
    trigger: 'A major strait closes to commercial traffic', asOf: '2026-09-01',
    nodes: [
      { id: 'd1', statement: 'Freight rates on the alternative route spike', mechanism: 'Capacity shifts to a longer route', conditionalProbability: 0.9, lagDays: 7, basis: 'Observed in the 2021 blockage' },
      { id: 's1', parentId: 'd1', statement: 'Importers pass costs to consumers', mechanism: 'Thin margins force price increases', conditionalProbability: 0.6, lagDays: 30, basis: 'Historical pass-through studies' },
      { id: 't1', parentId: 's1', statement: 'Headline inflation ticks up in the affected economies', mechanism: 'Shipping is a measurable CPI input', conditionalProbability: 0.3, lagDays: 45, basis: 'Central bank commentary' },
    ],
  }))
  expect(result.depth).toBe(3)
  expect(result.nodes.find((node: { id: string }) => node.id === 't1').order).toBe(3)
  expect(result.nodes.find((node: { id: string }) => node.id === 't1').pathProbability).toBeCloseTo(0.162, 3)
  expect(result.dominantPath.leafId).toBe('t1')
  expect(result.weakestLinks[0].id).toBe('t1')
})

test('consequence_chain rejects a parent that is not an earlier node', () => {
  expect(() => buildConsequenceChain({ trigger: 't', asOf: '2026-09-01', nodes: [{ id: 'a', parentId: 'ghost', statement: 's', mechanism: 'm', conditionalProbability: 0.5, lagDays: 1, basis: 'b' }] })).toThrow('not an earlier node')
})

test('exposure_assessment diversifies across independence groups and scores concentration', () => {
  const result = JSON.parse(calculateExposureAssessment({
    subject: 'EM manufacturer hard-currency book', asOf: '2026-09-01', baseValue: 1_000_000_000, currency: 'USD',
    exposures: [
      { id: 'fx1', channel: 'FX', factor: 'USD/BRL', sourceUrl: 'https://cb.example/fx', sourceDate: '2026-08-30', notional: 400_000_000, shockPct: 0.15, sensitivity: 1, reliability: 0.9, independenceGroup: 'em-fx' },
      { id: 'fx2', channel: 'FX', factor: 'USD/ZAR', sourceUrl: 'https://cb.example/fx2', sourceDate: '2026-08-30', notional: 200_000_000, shockPct: 0.15, sensitivity: 1, reliability: 0.8, independenceGroup: 'em-fx' },
      { id: 'rate1', channel: 'rates', factor: '10y UST', sourceUrl: 'https://treasury.example', sourceDate: '2026-08-29', notional: 300_000_000, shockPct: 0.05, sensitivity: 1.5, reliability: 0.85, independenceGroup: 'us-rates' },
    ],
  }))
  expect(result.undiversifiedLoss).toBeGreaterThan(result.diversifiedLoss)
  expect(result.diversificationBenefit).toBeGreaterThan(0)
  expect(result.concentrationHHI).toBeGreaterThan(0)
  expect(result.concentrationHHI).toBeLessThanOrEqual(1)
  expect(result.byChannel[0].channel).toBe('FX')
  expect(['low', 'moderate', 'high', 'severe']).toContain(result.band)
  expect(result.sensitivity).toHaveLength(2)
})

test('posture_assessment produces a per-category correlation-of-forces ratio and flags one-sided gaps', () => {
  const result = JSON.parse(assessPosture({
    theatre: 'Eastern approaches', asOf: '2026-09-01', sideA: 'Blue', sideB: 'Red',
    capabilities: [
      { id: 'a-air', category: 'air', side: 'A', metric: '4th-gen+ aircraft', count: 120, qualityFactor: 1.2, sourceUrl: 'https://mil.example/a', sourceDate: '2026-08-01', reliability: 0.8 },
      { id: 'b-air', category: 'air', side: 'B', metric: '4th-gen+ aircraft', count: 90, qualityFactor: 1, sourceUrl: 'https://mil.example/b', sourceDate: '2026-08-01', reliability: 0.7 },
      { id: 'a-isr', category: 'ISR', side: 'A', metric: 'wide-area sensors', count: 10, qualityFactor: 1, sourceUrl: 'https://mil.example/c', sourceDate: '2026-08-01', reliability: 0.6 },
    ],
  }))
  expect(result.overall.balance).toBe('Blue advantage')
  const air = result.categories.find((category: { category: string }) => category.category === 'air')
  expect(air.ratio).toBeCloseTo(1.6, 1)
  expect(result.gaps.some((gap: string) => gap.startsWith('ISR'))).toBe(true)
})

test('alternatives ranks candidates on weighted normalised criteria and checks stability', () => {
  const result = JSON.parse(rankAlternatives({
    subject: 'Advanced logic chip sourcing', asOf: '2026-09-01', incumbentId: 'tw',
    criteria: [
      { id: 'capacity', name: 'Fab capacity', weight: 0.4, direction: 'higher-better' },
      { id: 'cost', name: 'Unit cost', weight: 0.3, direction: 'lower-better' },
      { id: 'alignment', name: 'Political alignment', weight: 0.3, direction: 'higher-better' },
    ],
    candidates: [
      { id: 'tw', name: 'Taiwan', sourceUrl: 'https://trade.example/tw', sourceDate: '2026-08-20', reliability: 0.9, scores: { capacity: 95, cost: 40, alignment: 55 } },
      { id: 'kr', name: 'South Korea', sourceUrl: 'https://trade.example/kr', sourceDate: '2026-08-20', reliability: 0.85, scores: { capacity: 70, cost: 55, alignment: 75 } },
      { id: 'us', name: 'United States', sourceUrl: 'https://trade.example/us', sourceDate: '2026-08-20', reliability: 0.8, scores: { capacity: 45, cost: 80, alignment: 90 } },
    ],
  }))
  expect(result.ranked).toHaveLength(3)
  expect(result.ranked[0].rank).toBe(1)
  expect(result.recommended.id).toBe(result.ranked[0].id)
  expect(result.incumbentComparison.incumbentId).toBe('tw')
  expect(typeof result.stableTopChoice).toBe('boolean')
  expect(result.sensitivity).toHaveLength(3)
})

test('alternatives rejects an unknown criterion score and a lone candidate', () => {
  expect(() => rankAlternatives({ subject: 'x', asOf: '2026-09-01', criteria: [{ id: 'a', name: 'A', weight: 0.5, direction: 'higher-better' }, { id: 'b', name: 'B', weight: 0.5, direction: 'higher-better' }], candidates: [{ id: 'c1', name: 'C1', sourceUrl: 'https://e.example', sourceDate: '2026-08-01', reliability: 0.8, scores: { a: 1, b: 2, c: 3 } }, { id: 'c2', name: 'C2', sourceUrl: 'https://e.example', sourceDate: '2026-08-01', reliability: 0.8, scores: { a: 1, b: 2 } }] })).toThrow('not a declared criterion')
})

test('effector_pairing assigns by priority and reports saturation gaps', () => {
  const result = JSON.parse(pairEffectors({
    asOf: '2026-09-01',
    threats: [
      { id: 't1', name: 'Inbound salvo', priority: 90, requiredCapability: 'air-defence', sourceUrl: 'https://ops.example/t1', sourceDate: '2026-08-31' },
      { id: 't2', name: 'Secondary raid', priority: 70, requiredCapability: 'air-defence', sourceUrl: 'https://ops.example/t2', sourceDate: '2026-08-31' },
      { id: 't3', name: 'Cyber intrusion', priority: 60, requiredCapability: 'cyber', sourceUrl: 'https://ops.example/t3', sourceDate: '2026-08-31' },
    ],
    effectors: [
      { id: 'e1', name: 'SAM battery', capabilities: ['air-defence'], capacity: 1, readiness: 0.9 },
    ],
  }))
  expect(result.assignments).toHaveLength(1)
  expect(result.assignments[0].threatId).toBe('t1')
  expect(result.unassignedThreats.find((threat: { threatId: string }) => threat.threatId === 't2').reason).toContain('capacity')
  expect(result.unassignedThreats.find((threat: { threatId: string }) => threat.threatId === 't3').reason).toContain('required capability')
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

test('ontology traversal reads objects, finds multi-hop paths, and traces causal provenance', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'elia-battmann-ontology-'))
  const run = (input: Record<string, unknown>) => withAgentIdentity({ name: 'test', role: 'lead', cwd }, () => battmannTool.execute(input))
  await run({ action: 'register_evidence', evidenceId: 'e1', title: 'Ownership filing', url: 'https://registry.example/filing', sourceType: 'primary', publishedAt: '2026-01-01', retrievedAt: '2026-01-01', excerpt: 'Ownership and supply relationships of record.', independenceGroup: 'registry', reliability: 0.95 })
  for (const [id, type, name] of [['sanctioned-co', 'organization', 'Sanctioned Holding'], ['tier2', 'organization', 'Tier-2 Supplier'], ['tier1', 'organization', 'Tier-1 Supplier'], ['client', 'organization', 'Client OEM']]) {
    await run({ action: 'upsert_object', objectId: id, objectType: type, name, validFrom: '2026-01-01', confidence: 'high', evidenceIds: ['e1'] })
  }
  await run({ action: 'link_objects', linkId: 'l1', fromId: 'sanctioned-co', toId: 'tier2', linkType: 'owns', validFrom: '2026-01-01', confidence: 'high', evidenceIds: ['e1'] })
  await run({ action: 'link_objects', linkId: 'l2', fromId: 'tier2', toId: 'tier1', linkType: 'supplies', validFrom: '2026-01-01', confidence: 'medium', evidenceIds: ['e1'] })
  await run({ action: 'link_objects', linkId: 'l3', fromId: 'tier1', toId: 'client', linkType: 'supplies', validFrom: '2026-01-01', confidence: 'low', evidenceIds: ['e1'] })

  const list = JSON.parse(await run({ action: 'list_objects', objectType: 'organization' }))
  expect(list.objects).toHaveLength(4)

  const detail = JSON.parse(await run({ action: 'object_detail', objectId: 'tier2' }))
  expect(detail.incomingLinks[0].counterpart.name).toBe('Sanctioned Holding')
  expect(detail.outgoingLinks[0].counterpart.name).toBe('Tier-1 Supplier')

  const path = JSON.parse(await run({ action: 'find_path', fromId: 'client', toId: 'sanctioned-co', direction: 'any', maxDepth: 4 }))
  expect(path.pathCount).toBeGreaterThanOrEqual(1)
  expect(path.paths[0].hops).toBe(3)
  expect(path.paths[0].minConfidence).toBe('low')

  const trace = JSON.parse(await run({ action: 'explain_causality', targetObjectId: 'client', maxDepth: 3 }))
  expect(trace.target.name).toBe('Client OEM')
  expect(trace.drivers[0].sourceId).toBe('tier1')
  expect(trace.propagationPaths.some((row: { via: string[] }) => row.via.length === 3)).toBe(true)
  expect(trace.gaps.some((gap: string) => gap.includes('low-confidence'))).toBe(true)
})

test('find_path rejects identical endpoints and unknown objects', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'elia-battmann-path-guard-'))
  const run = (input: Record<string, unknown>) => withAgentIdentity({ name: 'test', role: 'lead', cwd }, () => battmannTool.execute(input))
  await run({ action: 'register_evidence', evidenceId: 'e1', title: 'Record', url: 'https://records.example/item', sourceType: 'primary', publishedAt: '2026-01-01', retrievedAt: '2026-01-01', excerpt: 'A record.', independenceGroup: 'records', reliability: 0.9 })
  await run({ action: 'upsert_object', objectId: 'only', objectType: 'organization', name: 'Only Node', validFrom: '2026-01-01', confidence: 'high', evidenceIds: ['e1'] })
  await expect(run({ action: 'find_path', fromId: 'only', toId: 'only' })).rejects.toThrow('must differ')
  await expect(run({ action: 'find_path', fromId: 'only', toId: 'ghost' })).rejects.toThrow('unknown ontology object')
})

test('Foundry: datasets keep a hash-chained lineage and the action engine gates a writeback', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'elia-battmann-foundry-'))
  const run = (input: Record<string, unknown>) => withAgentIdentity({ name: 'test', role: 'lead', cwd }, () => battmannTool.execute(input))
  await run({ action: 'register_dataset', datasetId: 'raw', name: 'UN Comtrade extract', sourceType: 'external-feed', uri: 'https://comtrade.example/2026', rowCount: 5000, contentHash: 'sha256:aaa', asOf: '2026-01-02' })
  await run({ action: 'register_dataset', datasetId: 'clean', name: 'Normalised trade flows', sourceType: 'derived', contentHash: 'sha256:bbb', parentDatasetId: 'raw', transform: 'dropped null reporters, converted to USD', asOf: '2026-01-03' })
  const lineage = JSON.parse(await run({ action: 'dataset_lineage', datasetId: 'clean' }))
  expect(lineage.depth).toBe(2)
  expect(lineage.rootDatasetId).toBe('raw')
  expect(lineage.provenance.map((entry: { id: string }) => entry.id)).toEqual(['raw', 'clean'])
  await expect(run({ action: 'register_dataset', datasetId: 'x', name: 'y', sourceType: 'derived', contentHash: 'c', parentDatasetId: 'raw', asOf: '2026-01-04' })).rejects.toThrow('transform')

  await run({ action: 'register_evidence', evidenceId: 'e1', title: 'Filing', url: 'https://reg.example/f', sourceType: 'primary', publishedAt: '2026-01-01', retrievedAt: '2026-01-01', excerpt: 'Entity of record.', independenceGroup: 'reg', reliability: 0.9 })
  await run({ action: 'upsert_object', objectId: 'port-a', objectType: 'facility', name: 'Port A', validFrom: '2026-01-01', confidence: 'high', evidenceIds: ['e1'] })
  await run({ action: 'define_action', actionTypeId: 'at1', actionTypeName: 'raise_watch_level', appliesTo: 'facility', parametersSchema: { level: { type: 'number', required: true } }, requiresClearance: 'confidential', description: 'Raise the monitoring level on a facility.' })
  const proposal = JSON.parse(await run({ action: 'propose_action', proposalId: 'p1', actionTypeName: 'raise_watch_level', targetObjectId: 'port-a', parameters: { level: 3 }, rationale: 'Congestion signals.', proposedBy: 'analyst' }))
  expect(proposal.status).toBe('pending')
  await expect(run({ action: 'propose_action', proposalId: 'p2', actionTypeName: 'raise_watch_level', targetObjectId: 'port-a', parameters: { level: 'high' }, rationale: 'x', proposedBy: 'a' })).rejects.toThrow('must be a number')
  const decided = JSON.parse(await run({ action: 'decide_action_proposal', proposalId: 'p1', decision: 'approved', decidedBy: 'ops-lead', decidedAt: '2026-01-05', decisionNotes: 'Concur.' }))
  expect(decided.status).toBe('approved')
  expect(decided.proposalHash).toBe(proposal.proposalHash)
  await expect(run({ action: 'decide_action_proposal', proposalId: 'p1', decision: 'rejected', decidedBy: 'x', decidedAt: '2026-01-06', decisionNotes: 'late' })).rejects.toThrow('already approved')
})

test('macro-indicator ledger records dated readings and reports trend, change, and a z-score', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'elia-battmann-indicator-'))
  const run = (input: Record<string, unknown>) => withAgentIdentity({ name: 'test', role: 'lead', cwd }, () => battmannTool.execute(input))
  await run({ action: 'define_indicator', indicatorId: 'pmi', name: 'Manufacturing PMI', unit: 'index', frequency: 'monthly', higherIs: 'risk-on', sourceName: 'National statistics office' })
  const readings = [['2026-05-01', 51.2], ['2026-06-01', 50.1], ['2026-07-01', 48.6], ['2026-08-01', 47.2]] as const
  for (const [observedAt, value] of readings) {
    await run({ action: 'record_indicator_reading', indicatorId: 'pmi', observedAt, value, sourceUrl: `https://stats.example/pmi/${observedAt}` })
  }
  await expect(run({ action: 'record_indicator_reading', indicatorId: 'pmi', observedAt: '2026-08-01', value: 47.2, sourceUrl: 'https://stats.example/dup' })).rejects.toThrow('already has a reading')
  const series = JSON.parse(await run({ action: 'indicator_series', indicatorId: 'pmi' }))
  expect(series.readings).toHaveLength(4)
  expect(series.statistics.trendDirection).toBe('falling')
  expect(series.statistics.changeFromPrevious.absolute).toBeCloseTo(-1.4, 5)
  expect(series.statistics.latestZScore).toBeLessThan(0)
  const list = JSON.parse(await run({ action: 'list_indicators' }))
  expect(list.indicators[0].readingCount).toBe(4)
})

test('Gotham: geo_query finds events by radius and situation_snapshot summarises the picture', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'elia-battmann-geo-'))
  const run = (input: Record<string, unknown>) => withAgentIdentity({ name: 'test', role: 'lead', cwd }, () => battmannTool.execute(input))
  await run({ action: 'register_evidence', evidenceId: 'e1', title: 'Report', url: 'https://osint.example/r', sourceType: 'primary', publishedAt: '2026-01-01', retrievedAt: '2026-01-01', excerpt: 'Incident report.', independenceGroup: 'osint', reliability: 0.8 })
  await run({ action: 'upsert_object', objectId: 'suez', objectType: 'chokepoint', name: 'Suez Canal', validFrom: '2026-01-01', confidence: 'high', latitude: 30.0, longitude: 32.55, evidenceIds: ['e1'] })
  await run({ action: 'register_geo_event', geoEventId: 'g1', title: 'Vessel grounding', category: 'maritime', latitude: 30.02, longitude: 32.58, occurredAt: '2026-01-02', severity: 80, affectedObjectIds: ['suez'], sourceUrl: 'https://osint.example/g1', evidenceIds: ['e1'] })
  await run({ action: 'register_geo_event', geoEventId: 'g2', title: 'Distant protest', category: 'civil', latitude: 48.85, longitude: 2.35, occurredAt: '2026-01-02', severity: 20, sourceUrl: 'https://osint.example/g2', evidenceIds: ['e1'] })
  const near = JSON.parse(await run({ action: 'geo_query', objectId: 'suez', radiusKm: 50 }))
  expect(near.events).toHaveLength(1)
  expect(near.events[0].id).toBe('g1')
  expect(near.events[0].distanceKm).toBeLessThan(10)
  const snap = JSON.parse(await run({ action: 'situation_snapshot', asOf: '2026-01-03' }))
  expect(snap.totalEvents).toBe(2)
  expect(snap.categories[0].category).toBe('maritime')
  expect(snap.objectsUnderPressure[0].objectId).toBe('suez')
})

test('dashboard renders HTML, JSON, and Markdown artifacts with a derived alert strip', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'elia-battmann-dashboard-'))
  const run = (input: Record<string, unknown>) => withAgentIdentity({ name: 'test', role: 'lead', cwd }, () => battmannTool.execute(input))
  const now = Date.now()
  const openedAt = new Date(now - 172_800_000).toISOString()
  const firstAsOf = new Date(now - 90_000_000).toISOString()
  const secondAsOf = new Date(now - 3_600_000).toISOString()
  const horizon = new Date(now + 604_800_000).toISOString()
  await run({ action: 'register_evidence', evidenceId: 'e1', title: 'Advisory', url: 'https://port.example/a', sourceType: 'primary', publishedAt: openedAt, retrievedAt: openedAt, excerpt: 'Congestion advisory.', independenceGroup: 'authority', reliability: 0.9 })
  await run({ action: 'create_question', questionId: 'q1', question: 'Will the strait stay closed?', domain: 'supply chain', openedAt, horizon, resolutionCriteria: 'Official notice of continued closure.' })
  await run({ action: 'submit_forecast', forecastId: 'f1', questionId: 'q1', probability: 0.45, asOf: firstAsOf, method: 'base rate', forecaster: 'Battmann', rationale: 'Initial read.', evidenceIds: ['e1'] })
  await run({ action: 'submit_forecast', forecastId: 'f2', questionId: 'q1', probability: 0.72, asOf: secondAsOf, method: 'evidence update', forecaster: 'Battmann', rationale: 'No reopening.', evidenceIds: ['e1'] })
  await run({ action: 'upsert_object', objectId: 'strait', objectType: 'chokepoint', name: 'Key Strait', validFrom: openedAt, confidence: 'high', latitude: 26.5, longitude: 56.25, evidenceIds: ['e1'] })
  await run({ action: 'register_geo_event', geoEventId: 'g1', title: 'Tanker seizure', category: 'maritime-security', latitude: 26.5, longitude: 56.3, occurredAt: secondAsOf, severity: 88, affectedObjectIds: ['strait'], sourceUrl: 'https://osint.example/g1', evidenceIds: ['e1'] })
  await run({ action: 'define_indicator', indicatorId: 'brent', name: 'Brent crude', unit: 'USD/bbl', frequency: 'daily', higherIs: 'risk-off', sourceName: 'Market data' })
  for (const [observedAt, value] of [[new Date(now - 300_000_000), 78], [new Date(now - 200_000_000), 84], [new Date(now - 100_000_000), 96]] as const) {
    await run({ action: 'record_indicator_reading', indicatorId: 'brent', observedAt: observedAt.toISOString(), value, sourceUrl: `https://market.example/${value}` })
  }
  const result = JSON.parse(await run({ action: 'dashboard', title: 'Strait Watch', outputPath: '.elia/artifacts/battmann-dashboard.html' }))
  expect(existsSync(result.dashboardPath)).toBe(true)
  expect(existsSync(result.jsonPath)).toBe(true)
  expect(existsSync(result.mdPath)).toBe(true)
  const htmlText = readFileSync(result.dashboardPath, 'utf8')
  expect(htmlText).toContain('<!doctype html>')
  expect(htmlText).toContain('Strait Watch')
  expect(htmlText).toContain('Tanker seizure')
  const snapshot = JSON.parse(readFileSync(result.jsonPath, 'utf8'))
  expect(snapshot.alerts.some((alert: { kind: string }) => alert.kind === 'forecast-rising')).toBe(true)
  expect(snapshot.alerts.some((alert: { kind: string }) => alert.kind === 'geo-event')).toBe(true)
  expect(snapshot.indicators[0].trend).toBe('rising')
})

test('Apollo: stage_deployment refuses an over-classified report and versions the manifest', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'elia-battmann-apollo-'))
  const run = (input: Record<string, unknown>) => withAgentIdentity({ name: 'test', role: 'lead', cwd }, () => battmannTool.execute(input))
  await run({ action: 'register_evidence', evidenceId: 'e1', title: 'Filing', url: 'https://reg.example/f', sourceType: 'primary', publishedAt: '2026-01-01', retrievedAt: '2026-01-01', excerpt: 'Of record.', independenceGroup: 'reg', reliability: 0.9 })
  await run({ action: 'register_claim', claimId: 'c1', statement: 'A fact.', classification: 'observed_fact', confidence: 'high', asOf: '2026-01-02', evidenceLinks: [{ evidenceId: 'e1', relation: 'supports', supportingExcerpt: 'Of record.' }] })
  await run({ action: 'review_claim', reviewId: 'r1', claimId: 'c1', verdict: 'supported', reviewer: 'rev', reviewedAt: '2026-01-03', notes: 'ok' })
  await run({ action: 'report_from_store', reportId: 'rep1', reportStatus: 'final', title: 'Brief', executiveSummary: 'Summary.', author: 'a', reviewer: 'rev', documentClassification: 'confidential', asOf: '2026-01-04', outputPath: 'reports/brief.md' })
  await run({ action: 'define_deployment_target', targetId: 't-open', name: 'Public Portal', kind: 'sovereign-cloud', maxClassification: 'internal', formats: ['md', 'json'] })
  await run({ action: 'define_deployment_target', targetId: 't-gov', name: 'Ministry Air Gap', kind: 'air-gap-export', maxClassification: 'restricted', formats: ['md', 'json', 'html'] })
  await expect(run({ action: 'stage_deployment', stageId: 's1', targetId: 't-open', reportPath: 'reports/brief.md', stagedBy: 'ops' })).rejects.toThrow('accepts at most internal')
  const staged = JSON.parse(await run({ action: 'stage_deployment', stageId: 's2', targetId: 't-gov', reportPath: 'reports/brief.md', stagedBy: 'ops' }))
  expect(staged.version).toBe(1)
  expect(existsSync(staged.manifestPath)).toBe(true)
  expect(staged.manifest.files).toHaveLength(3)
  const restaged = JSON.parse(await run({ action: 'stage_deployment', stageId: 's3', targetId: 't-gov', reportPath: 'reports/brief.md', stagedBy: 'ops' }))
  expect(restaged.version).toBe(2)
  expect(restaged.manifest.previousVersion).toBe(1)
  const status = JSON.parse(await run({ action: 'deployment_status' }))
  expect(status.targets.find((t: { id: string }) => t.id === 't-gov').latestVersion).toBe(2)
})

test('AIP: clearance withholds classified links from traversal and the audit chain verifies', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'elia-battmann-aip-'))
  const run = (input: Record<string, unknown>) => withAgentIdentity({ name: 'test', role: 'lead', cwd }, () => battmannTool.execute(input))
  await run({ action: 'register_evidence', evidenceId: 'e1', title: 'Filing', url: 'https://reg.example/f', sourceType: 'primary', publishedAt: '2026-01-01', retrievedAt: '2026-01-01', excerpt: 'Of record.', independenceGroup: 'reg', reliability: 0.9 })
  await run({ action: 'upsert_object', objectId: 'client', objectType: 'organization', name: 'Client', validFrom: '2026-01-01', confidence: 'high', evidenceIds: ['e1'] })
  await run({ action: 'upsert_object', objectId: 'supplier', objectType: 'organization', name: 'Supplier', validFrom: '2026-01-01', confidence: 'high', evidenceIds: ['e1'] })
  await run({ action: 'upsert_object', objectId: 'secret-co', objectType: 'organization', name: 'Restricted Entity', validFrom: '2026-01-01', confidence: 'high', securityClassification: 'restricted', evidenceIds: ['e1'] })
  await run({ action: 'link_objects', linkId: 'l1', fromId: 'supplier', toId: 'client', linkType: 'supplies', validFrom: '2026-01-01', confidence: 'high', evidenceIds: ['e1'] })
  await run({ action: 'link_objects', linkId: 'l2', fromId: 'secret-co', toId: 'supplier', linkType: 'owns', validFrom: '2026-01-01', confidence: 'high', securityClassification: 'restricted', evidenceIds: ['e1'] })
  const full = JSON.parse(await run({ action: 'find_path', fromId: 'client', toId: 'secret-co', direction: 'any' }))
  expect(full.pathCount).toBe(1)
  const cleared = JSON.parse(await run({ action: 'find_path', fromId: 'client', toId: 'secret-co', direction: 'any', clearance: 'confidential' }))
  expect(cleared.pathCount).toBe(0)
  const trace = JSON.parse(await run({ action: 'explain_causality', targetObjectId: 'client', clearance: 'confidential' }))
  expect(trace.drivers.every((d: { sourceId: string }) => d.sourceId !== 'secret-co')).toBe(true)
  const audit = JSON.parse(await run({ action: 'audit_trail' }))
  expect(audit.chainValid).toBe(true)
  expect(audit.totalEntries).toBeGreaterThanOrEqual(6)
  expect(audit.entries.some((entry: { action: string }) => entry.action === 'link_objects')).toBe(true)
})

test('persistent intelligence records reject impossible event ordering and duplicate terminal resolutions', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'elia-battmann-invariants-'))
  const run = (input: Record<string, unknown>) => withAgentIdentity({ name: 'test', role: 'lead', cwd }, () => battmannTool.execute(input))
  const future = new Date(Date.now() + 86_400_000).toISOString()
  await expect(run({ action: 'create_question', questionId: 'q-future', question: 'Can a future observation be logged now?', openedAt: future, horizon: new Date(Date.now() + 172_800_000).toISOString(), resolutionCriteria: 'The clock reaches the stated date.' })).rejects.toThrow('cannot be in the future')
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
