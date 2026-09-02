import { extname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { resolveWorkspacePath } from '../autonomy/context.ts'
import { captureBeforeWrite } from '../checkpoint.ts'
import { BATTMANN_STORE_ACTIONS, executeBattmannStoreAction, loadBattmannReportData } from '../battmann/store.ts'
import { atomicWrite } from './atomicWrite.ts'
import type { Tool } from './types.ts'

type Confidence = 'low' | 'medium' | 'high'
type Classification = 'observed_fact' | 'reproducible_calculation' | 'model_estimate' | 'judgement'
interface Signal { id: string; summary: string; sourceUrl: string; sourceDate: string; likelihoodRatio: number; reliability: number; independenceGroup: string }

function text(input: unknown, name: string, max = 10_000): string {
  if (typeof input !== 'string' || !input.trim() || input.length > max) throw new Error(`${name} must be a non-empty string of at most ${max} characters`)
  return input.trim()
}
function number(input: unknown, name: string, min: number, max: number): number {
  if (typeof input !== 'number' || !Number.isFinite(input) || input < min || input > max) throw new Error(`${name} must be between ${min} and ${max}`)
  return input
}
function date(input: unknown, name: string): string {
  const value = text(input, name, 100)
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${name} must be an ISO date or timestamp`)
  return new Date(value).toISOString()
}
function url(input: unknown, name: string): string {
  const value = text(input, name, 2_000)
  const parsed = new URL(value)
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error(`${name} must be an http(s) URL`)
  return value
}
function list(input: unknown, name: string): Record<string, unknown>[] {
  if (!Array.isArray(input)) throw new Error(`${name} must be an array`)
  return input.map((item) => { if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`${name} entries must be objects`); return item as Record<string, unknown> })
}
const round = (value: number, places = 6) => Number(value.toFixed(places))
const logit = (p: number) => Math.log(p / (1 - p))
const logistic = (x: number) => 1 / (1 + Math.exp(-x))

export function calculateForecast(input: Record<string, unknown>): string {
  const question = text(input.question, 'question')
  const asOf = date(input.asOf, 'asOf')
  const horizon = date(input.horizon, 'horizon')
  if (horizon <= asOf) throw new Error('horizon must be after asOf')
  const resolutionCriteria = text(input.resolutionCriteria, 'resolutionCriteria')
  const prior = number(input.priorProbability, 'priorProbability', 0.001, 0.999)
  const signals: Signal[] = list(input.signals, 'signals').map((item, index) => {
    const sourceDate = date(item.sourceDate, `signals[${index}].sourceDate`)
    if (sourceDate > asOf) throw new Error(`signals[${index}].sourceDate cannot be after asOf`)
    return { id: text(item.id, `signals[${index}].id`, 100), summary: text(item.summary, `signals[${index}].summary`), sourceUrl: url(item.sourceUrl, `signals[${index}].sourceUrl`), sourceDate, likelihoodRatio: number(item.likelihoodRatio, `signals[${index}].likelihoodRatio`, 0.1, 10), reliability: number(item.reliability, `signals[${index}].reliability`, 0, 1), independenceGroup: text(item.independenceGroup, `signals[${index}].independenceGroup`, 100) }
  })
  if (!signals.length) throw new Error('signals must contain at least one sourced signal')
  if (new Set(signals.map((signal) => signal.id)).size !== signals.length) throw new Error('signal ids must be unique')
  const groups = new Map<string, number[]>()
  for (const signal of signals) {
    const contribution = Math.log(signal.likelihoodRatio) * signal.reliability
    groups.set(signal.independenceGroup, [...(groups.get(signal.independenceGroup) ?? []), contribution])
  }
  // Correlated signals share one group and contribute their mean, preventing repeated coverage from multiplying certainty.
  const contributions = [...groups.entries()].map(([group, values]) => ({ group, logOddsContribution: values.reduce((a, b) => a + b, 0) / values.length, signalCount: values.length }))
  const posterior = logistic(logit(prior) + contributions.reduce((sum, item) => sum + item.logOddsContribution, 0))
  const meanReliability = signals.reduce((sum, signal) => sum + signal.reliability, 0) / signals.length
  const confidence: Confidence = groups.size >= 4 && meanReliability >= 0.75 ? 'high' : groups.size >= 2 && meanReliability >= 0.5 ? 'medium' : 'low'
  const leaveOneGroupOut = contributions.map((removed) => ({ removedGroup: removed.group, probability: round(logistic(logit(prior) + contributions.filter((item) => item !== removed).reduce((sum, item) => sum + item.logOddsContribution, 0))) }))
  return JSON.stringify({ action: 'forecast', question, asOf, horizon, resolutionCriteria, priorProbability: prior, probability: round(posterior), confidence, independentEvidenceGroups: groups.size, meanSignalReliability: round(meanReliability), signals, contributions: contributions.map((item) => ({ ...item, logOddsContribution: round(item.logOddsContribution) })), sensitivity: leaveOneGroupOut, methodology: 'Prior odds updated by reliability-weighted likelihood ratios. Contributions within the same independence group are averaged to reduce double counting.', limitations: ['The result is a reproducible model estimate, not an observed probability.', 'Likelihood ratios and reliability values remain assumptions unless fitted from held-out historical data.', 'Forecast quality must be tracked after resolution with calibration and proper scoring rules.'] }, null, 2)
}

export function backtestForecasts(input: Record<string, unknown>): string {
  const rows = list(input.forecasts, 'forecasts').map((item, index) => ({ probability: number(item.probability, `forecasts[${index}].probability`, 0.001, 0.999), outcome: number(item.outcome, `forecasts[${index}].outcome`, 0, 1) }))
  if (rows.length < 2) throw new Error('backtest requires at least two resolved forecasts')
  const brier = rows.reduce((sum, row) => sum + (row.probability - row.outcome) ** 2, 0) / rows.length
  const logLoss = -rows.reduce((sum, row) => sum + row.outcome * Math.log(row.probability) + (1 - row.outcome) * Math.log(1 - row.probability), 0) / rows.length
  const baseRate = rows.reduce((sum, row) => sum + row.outcome, 0) / rows.length
  const baselineBrier = rows.reduce((sum, row) => sum + (baseRate - row.outcome) ** 2, 0) / rows.length
  const bins = Array.from({ length: 10 }, (_, index) => {
    const selected = rows.filter((row) => Math.min(9, Math.floor(row.probability * 10)) === index)
    return selected.length ? { range: `${index * 10}-${(index + 1) * 10}%`, count: selected.length, meanForecast: round(selected.reduce((sum, row) => sum + row.probability, 0) / selected.length), observedRate: round(selected.reduce((sum, row) => sum + row.outcome, 0) / selected.length) } : undefined
  }).filter(Boolean)
  return JSON.stringify({ action: 'backtest', sampleSize: rows.length, brierScore: round(brier), logLoss: round(logLoss), baseRate: round(baseRate), baselineBrierScore: round(baselineBrier), brierSkillScore: baselineBrier > 0 ? round(1 - brier / baselineBrier) : null, calibrationBins: bins, interpretation: ['Lower Brier score and log loss are better.', 'Positive Brier skill means the forecasts beat the sample base-rate forecast.', 'Small samples and sparse bins are not production calibration evidence.'] }, null, 2)
}

export function calculateEnsemble(input: Record<string, unknown>): string {
  const question = text(input.question, 'question')
  const asOf = date(input.asOf, 'asOf')
  const horizon = date(input.horizon, 'horizon')
  if (horizon <= asOf) throw new Error('horizon must be after asOf')
  const resolutionCriteria = text(input.resolutionCriteria, 'resolutionCriteria')
  const components = list(input.components, 'components').map((item, index) => ({
    id: text(item.id, `components[${index}].id`, 100),
    probability: number(item.probability, `components[${index}].probability`, 0.001, 0.999),
    weight: item.weight === undefined ? 1 : number(item.weight, `components[${index}].weight`, 0.001, 1_000),
    independenceGroup: text(item.independenceGroup, `components[${index}].independenceGroup`, 100),
    method: text(item.method, `components[${index}].method`, 500),
  }))
  if (components.length < 2) throw new Error('components must contain at least two forecasts')
  if (new Set(components.map((component) => component.id)).size !== components.length) throw new Error('component ids must be unique')
  const grouped = new Map<string, typeof components>()
  for (const component of components) grouped.set(component.independenceGroup, [...(grouped.get(component.independenceGroup) ?? []), component])
  const groups = [...grouped].map(([group, values]) => {
    const totalWeight = values.reduce((sum, value) => sum + value.weight, 0)
    return {
      group,
      probability: values.reduce((sum, value) => sum + value.probability * value.weight, 0) / totalWeight,
      // Repeated variants from one information family do not earn more influence merely by being numerous.
      weight: Math.max(...values.map((value) => value.weight)),
      componentIds: values.map((value) => value.id),
    }
  })
  const groupWeight = groups.reduce((sum, group) => sum + group.weight, 0)
  const ensemble = groups.reduce((sum, group) => sum + group.probability * group.weight, 0) / groupWeight
  const componentMean = components.reduce((sum, component) => sum + component.probability, 0) / components.length
  const disagreement = Math.sqrt(components.reduce((sum, component) => sum + (component.probability - componentMean) ** 2, 0) / components.length)
  const sensitivity = groups.map((removed) => {
    const remaining = groups.filter((group) => group !== removed)
    const weight = remaining.reduce((sum, group) => sum + group.weight, 0)
    return { removedGroup: removed.group, probability: weight ? round(remaining.reduce((sum, group) => sum + group.probability * group.weight, 0) / weight) : null }
  })
  return JSON.stringify({
    action: 'ensemble', question, asOf, horizon, resolutionCriteria, probability: round(ensemble),
    confidence: groups.length >= 4 && disagreement <= 0.15 ? 'high' : groups.length >= 2 && disagreement <= 0.25 ? 'medium' : 'low',
    independentGroups: groups.length, componentCount: components.length, disagreement: round(disagreement), components,
    groups: groups.map((group) => ({ ...group, probability: round(group.probability), weight: round(group.weight) })), sensitivity,
    methodology: 'Weighted linear opinion pool after averaging correlated components within independence groups. A group receives at most its largest component weight.',
    limitations: ['Weights must be learned from temporally held-out performance before they are treated as skill estimates.', 'An ensemble cannot correct a biased prior or shared evidence failure shared by every component.'],
  }, null, 2)
}

function md(value: unknown): string { return String(value ?? '').replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ').trim() }
function html(value: unknown): string { return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;') }

async function createReport(input: Record<string, unknown>): Promise<string> {
  const generatedAt = new Date().toISOString()
  const title = text(input.title, 'title', 300); const asOf = date(input.asOf, 'asOf'); const executiveSummary = text(input.executiveSummary, 'executiveSummary', 20_000)
  const sources = list(input.sources, 'sources').map((item, index) => ({ id: text(item.id, `sources[${index}].id`, 100), title: text(item.title, `sources[${index}].title`, 500), url: url(item.url, `sources[${index}].url`), publishedAt: date(item.publishedAt, `sources[${index}].publishedAt`), retrievedAt: date(item.retrievedAt, `sources[${index}].retrievedAt`) }))
  if (sources.some((source) => source.publishedAt > asOf)) throw new Error('source publishedAt cannot be after the report asOf time')
  if (!sources.length) throw new Error('an industry report requires at least one source')
  const sourceIds = new Set(sources.map((source) => source.id)); if (sourceIds.size !== sources.length) throw new Error('source ids must be unique')
  const judgments = list(input.keyJudgments, 'keyJudgments').map((item, index) => {
    const classification = text(item.classification, `keyJudgments[${index}].classification`, 50) as Classification
    if (!['observed_fact', 'reproducible_calculation', 'model_estimate', 'judgement'].includes(classification)) throw new Error(`keyJudgments[${index}].classification is invalid`)
    const evidenceIds = Array.isArray(item.evidenceIds) ? item.evidenceIds.map((id) => text(id, `keyJudgments[${index}].evidenceIds`, 100)) : []
    if (!evidenceIds.length || evidenceIds.some((id) => !sourceIds.has(id))) throw new Error(`keyJudgments[${index}] must reference known evidenceIds`)
    const confidence = text(item.confidence, `keyJudgments[${index}].confidence`, 20) as Confidence
    if (!['low', 'medium', 'high'].includes(confidence)) throw new Error(`keyJudgments[${index}].confidence must be low, medium, or high`)
    return { statement: text(item.statement, `keyJudgments[${index}].statement`), classification, confidence, evidenceIds }
  })
  if (!judgments.length) throw new Error('keyJudgments must contain at least one evidence-backed judgement')
  const forecasts = list(input.forecasts ?? [], 'forecasts').map((item, index) => {
    const horizon = date(item.horizon, `forecasts[${index}].horizon`); if (horizon <= asOf) throw new Error(`forecasts[${index}].horizon must be after asOf`)
    const evidenceIds = Array.isArray(item.evidenceIds) ? item.evidenceIds.map((id) => text(id, `forecasts[${index}].evidenceIds`, 100)) : []
    if (!evidenceIds.length || evidenceIds.some((id) => !sourceIds.has(id))) throw new Error(`forecasts[${index}] must reference known evidenceIds`)
    const confidence = text(item.confidence, `forecasts[${index}].confidence`, 20) as Confidence; if (!['low', 'medium', 'high'].includes(confidence)) throw new Error(`forecasts[${index}].confidence must be low, medium, or high`)
    return { question: text(item.question, `forecasts[${index}].question`), probability: number(item.probability, `forecasts[${index}].probability`, 0.001, 0.999), horizon, resolutionCriteria: text(item.resolutionCriteria, `forecasts[${index}].resolutionCriteria`), confidence, evidenceIds }
  })
  const indicators = Array.isArray(input.indicators) ? input.indicators.map((value) => text(value, 'indicators[]')) : []
  const limitations = Array.isArray(input.limitations) ? input.limitations.map((value) => text(value, 'limitations[]')) : []
  const outputPath = text(input.outputPath, 'outputPath', 1_000); if (extname(outputPath).toLowerCase() !== '.md') throw new Error('outputPath must end in .md')
  const path = resolveWorkspacePath(outputPath); const sidecarPath = path.slice(0, -3) + '.json'
  const report = { schemaVersion: 1, generatedAt, title, asOf, executiveSummary, keyJudgments: judgments, forecasts, indicators, sources, limitations }
  const markdown = [`# ${title}`, '', `**As of:** ${asOf}`, `**Generated:** ${generatedAt}`, '**Status:** Decision-support intelligence; not personalized financial, legal, or security advice.', '', '## Executive summary', '', executiveSummary, '', '## Key judgments', '', '| Judgment | Classification | Confidence | Evidence |', '|---|---|---|---|', ...judgments.map((item) => `| ${md(item.statement)} | ${item.classification} | ${md(item.confidence)} | ${item.evidenceIds.map((id) => `[${id}]`).join(', ')} |`), '', '## Forecasts', '', ...(forecasts.length ? ['| Forecast | Probability | Horizon | Confidence | Resolution criteria | Evidence |', '|---|---:|---|---|---|---|', ...forecasts.map((item) => `| ${md(item.question)} | ${(item.probability * 100).toFixed(1)}% | ${item.horizon} | ${md(item.confidence)} | ${md(item.resolutionCriteria)} | ${item.evidenceIds.map((id) => `[${id}]`).join(', ')} |`)] : ['No quantified forecast was supportable from the available evidence.']), '', '## Indicators and watchpoints', '', ...(indicators.length ? indicators.map((item) => `- ${item}`) : ['- No watchpoints supplied.']), '', '## Evidence ledger', '', ...sources.map((source) => `- **[${source.id}] ${source.title}** — published ${source.publishedAt}; retrieved ${source.retrievedAt}; ${source.url}`), '', '## Methodology and limitations', '', '- Quantities are explicitly classified; model estimates are not measurements.', '- Citation IDs are structurally validated; a qualified reviewer must still confirm that each source supports the associated claim.', '- Forecasts require explicit resolution criteria and must be scored after resolution.', ...limitations.map((item) => `- ${item}`), ''].join('\n')
  await captureBeforeWrite(path); await captureBeforeWrite(sidecarPath); await atomicWrite(path, markdown); await atomicWrite(sidecarPath, JSON.stringify(report, null, 2))
  return JSON.stringify({ status: 'created', reportPath: path, sidecarPath, judgments: judgments.length, forecasts: forecasts.length, sources: sources.length }, null, 2)
}

interface StoredReportData {
  schemaVersion: number
  asOf: string
  ontology: { activeObjects: number; activeLinks: number }
  scorecard: Record<string, unknown>
  questions: Array<{ id: string; question: string; horizon: string; resolutionCriteria: string; status: string; outcome: number | null; latestForecast: null | { probability: number; asOf: string; method: string; evidenceIds: string[] } }>
  claims: Array<{ id: string; statement: string; classification: Classification; confidence: Confidence; evidence: Array<{ evidenceId: string; relation: string; supportingExcerpt: string }>; review: { verdict: string; reviewer?: string; reviewedAt?: string; notes?: string } }>
  evidence: Array<{ id: string; title: string; url: string; publisher?: string; sourceType: string; publishedAt: string; retrievedAt: string; excerpt: string; contentHash: string; independenceGroup: string; reliability: number }>
  scenarios: Array<{ id: string; title: string; probability: number; horizon: string; status: string; assumptions: string[]; indicators: string[] }>
  decisions: Array<{ id: string; title: string; chosenOption?: string; rationale: string; status: string; approvedBy?: string; decidedAt: string }>
  outcomes: Array<{ id: string; decisionId: string; observedAt: string; summary: string; metrics: Record<string, unknown>; evidenceIds: string[] }>
}

async function createStoreReport(input: Record<string, unknown>): Promise<string> {
  const title = text(input.title, 'title', 300)
  const executiveSummary = text(input.executiveSummary, 'executiveSummary', 20_000)
  const author = text(input.author, 'author', 300)
  const reportStatus = input.reportStatus === undefined ? 'draft' : text(input.reportStatus, 'reportStatus', 20)
  if (!['draft', 'final'].includes(reportStatus)) throw new Error('reportStatus must be draft or final')
  const reviewer = typeof input.reviewer === 'string' && input.reviewer.trim() ? text(input.reviewer, 'reviewer', 300) : undefined
  const documentClassification = input.documentClassification === undefined ? 'internal' : text(input.documentClassification, 'documentClassification', 50)
  if (!['public', 'internal', 'confidential', 'restricted'].includes(documentClassification)) throw new Error('documentClassification must be public, internal, confidential, or restricted')
  const distribution = Array.isArray(input.distribution) ? input.distribution.map((item) => text(item, 'distribution[]', 300)) : []
  const outputPath = text(input.outputPath, 'outputPath', 1_000)
  if (extname(outputPath).toLowerCase() !== '.md') throw new Error('outputPath must end in .md')
  const data = loadBattmannReportData(input) as unknown as StoredReportData
  const unresolvedReviews = data.claims.filter((claim) => claim.review.verdict !== 'supported')
  if (reportStatus === 'final' && !reviewer) throw new Error('final reports require reviewer')
  if (reportStatus === 'final' && unresolvedReviews.length) throw new Error(`final reports require supported claim reviews; unresolved claims: ${unresolvedReviews.map((claim) => claim.id).join(', ')}`)
  const generatedAt = new Date().toISOString()
  const reportId = input.reportId === undefined ? randomUUID() : text(input.reportId, 'reportId', 100)
  const reportVersion = input.reportVersion === undefined ? '1.0' : text(input.reportVersion, 'reportVersion', 50)
  const path = resolveWorkspacePath(outputPath)
  const sidecarPath = path.slice(0, -3) + '.json'
  const htmlPath = path.slice(0, -3) + '.html'
  const forecastRows = data.questions.filter((question) => question.latestForecast)
  const score = data.scorecard as { sampleSize?: number; brierScore?: number | null; logLoss?: number | null; brierSkillScore?: number | null; expectedCalibrationError?: number | null; warning?: string }
  const markdown = [
    `# ${title}`, '',
    '## Document control', '',
    '| Field | Value |', '|---|---|',
    `| Report ID | ${md(reportId)} |`, `| Version | ${md(reportVersion)} |`, `| Status | ${reportStatus} |`, `| Classification | ${documentClassification} |`,
    `| As of | ${data.asOf} |`, `| Generated | ${generatedAt} |`, `| Author | ${md(author)} |`, `| Reviewer | ${md(reviewer ?? 'Not yet reviewed')} |`,
    `| Distribution | ${md(distribution.join(', ') || 'Not specified')} |`, '',
    '> Classification and distribution labels are document metadata; they do not enforce access control.', '',
    '## Executive summary', '', executiveSummary, '',
    '## Key judgments', '',
    '| ID | Judgment | Classification | Confidence | Review | Evidence |', '|---|---|---|---|---|---|',
    ...data.claims.map((claim) => `| ${md(claim.id)} | ${md(claim.statement)} | ${claim.classification} | ${claim.confidence} | ${md(claim.review.verdict)} | ${claim.evidence.map((item) => `[${item.evidenceId}]`).join(', ')} |`),
    ...(data.claims.length ? [] : ['| — | No stored judgments were available as of the report cutoff. | — | — | — | — |']), '',
    '## Forecast register', '',
    '| Question | Probability | Forecast as of | Horizon | Status | Method | Evidence |', '|---|---:|---|---|---|---|---|',
    ...forecastRows.map((question) => `| ${md(question.question)} | ${((question.latestForecast?.probability ?? 0) * 100).toFixed(1)}% | ${question.latestForecast?.asOf} | ${question.horizon} | ${question.status} | ${md(question.latestForecast?.method)} | ${(question.latestForecast?.evidenceIds ?? []).map((id) => `[${id}]`).join(', ')} |`),
    ...(forecastRows.length ? [] : ['| No eligible stored forecasts were available. | — | — | — | — | — | — |']), '',
    '## Scenarios and signposts', '',
    ...data.scenarios.flatMap((scenario) => [`### ${scenario.title} — ${(scenario.probability * 100).toFixed(1)}%`, '', `Status: ${scenario.status}; horizon: ${scenario.horizon}.`, '', `Assumptions: ${scenario.assumptions.join('; ') || 'None supplied.'}`, '', `Indicators: ${scenario.indicators.join('; ') || 'None supplied.'}`, '']),
    ...(data.scenarios.length ? [] : ['No active scenario records were available.', '']),
    '## Decisions and outcomes', '',
    '| Decision | Chosen option | Status | Approved by | Date | Rationale |', '|---|---|---|---|---|---|',
    ...data.decisions.map((decision) => `| ${md(decision.title)} | ${md(decision.chosenOption ?? 'Not chosen')} | ${decision.status} | ${md(decision.approvedBy ?? 'Not approved')} | ${decision.decidedAt} | ${md(decision.rationale)} |`),
    ...(data.decisions.length ? [] : ['| No decisions recorded. | — | — | — | — | — |']), '',
    '### Recorded outcomes', '',
    '| Outcome | Decision ID | Observed | Metrics | Evidence |', '|---|---|---|---|---|',
    ...data.outcomes.map((outcome) => `| ${md(outcome.summary)} | ${md(outcome.decisionId)} | ${outcome.observedAt} | ${md(JSON.stringify(outcome.metrics))} | ${outcome.evidenceIds.map((id) => `[${id}]`).join(', ')} |`),
    ...(data.outcomes.length ? [] : ['| No outcomes recorded. | — | — | — | — |']), '',
    '## Forecast track record', '',
    `- Resolved sample: ${score.sampleSize ?? 0}`, `- Brier score: ${score.brierScore ?? 'not available'}`, `- Log loss: ${score.logLoss ?? 'not available'}`, `- Brier skill: ${score.brierSkillScore ?? 'not available'}`, `- Expected calibration error: ${score.expectedCalibrationError ?? 'not available'}`,
    ...(score.warning ? [`- Warning: ${score.warning}`] : []), '',
    '## Ontology coverage', '', `- Active objects: ${data.ontology.activeObjects}`, `- Active links: ${data.ontology.activeLinks}`, '',
    '## Evidence ledger', '',
    ...data.evidence.flatMap((source) => [`### [${source.id}] ${source.title}`, '', `- URL: ${source.url}`, `- Publisher/type: ${source.publisher ?? 'Unspecified'} / ${source.sourceType}`, `- Published/retrieved: ${source.publishedAt} / ${source.retrievedAt}`, `- Independence group/reliability: ${source.independenceGroup} / ${source.reliability}`, `- SHA-256: ${source.contentHash}`, `- Preserved excerpt: ${md(source.excerpt)}`, '']),
    '## Methodology, review and limitations', '',
    '- All data is cut off at the report as-of timestamp; later evidence, forecasts, reviews, resolutions, scenarios, and decisions are excluded.',
    '- Forecast revisions remain immutable and accepted resolutions are scored with proper scoring rules.',
    '- Source hashes establish excerpt integrity, not truth or complete-document authenticity.',
    '- A supported review records reviewer judgment; it is not cryptographic proof that a claim is true.',
    `- ${unresolvedReviews.length} claim(s) remain unreviewed, contradicted, or unclear.`,
    '',
  ].join('\n')
  const reportBundle = { reportSchemaVersion: 2, reportId, reportVersion, reportStatus, documentClassification, distribution, generatedAt, title, author, reviewer, executiveSummary, unresolvedReviewCount: unresolvedReviews.length, ...data }
  const rowsHtml = data.claims.map((claim) => `<tr><td>${html(claim.id)}</td><td>${html(claim.statement)}</td><td>${html(claim.confidence)}</td><td>${html(claim.review.verdict)}</td></tr>`).join('') || '<tr><td colspan="4">No stored judgments.</td></tr>'
  const forecastsHtml = forecastRows.map((question) => `<tr><td>${html(question.question)}</td><td><span class="prob" style="--p:${Math.round((question.latestForecast?.probability ?? 0) * 100)}%">${((question.latestForecast?.probability ?? 0) * 100).toFixed(1)}%</span></td><td>${html(question.horizon)}</td><td>${html(question.status)}</td></tr>`).join('') || '<tr><td colspan="4">No eligible forecasts.</td></tr>'
  const scenariosHtml = data.scenarios.map((scenario) => `<article><h3>${html(scenario.title)} — ${(scenario.probability * 100).toFixed(1)}%</h3><p>Status: ${html(scenario.status)} · horizon: ${html(scenario.horizon)}</p><p><b>Assumptions:</b> ${html(scenario.assumptions.join('; ') || 'None supplied.')}<br><b>Indicators:</b> ${html(scenario.indicators.join('; ') || 'None supplied.')}</p></article>`).join('') || '<p>No scenarios recorded.</p>'
  const decisionsHtml = data.decisions.map((decision) => `<tr><td>${html(decision.title)}</td><td>${html(decision.chosenOption ?? 'Not chosen')}</td><td>${html(decision.status)}</td><td>${html(decision.approvedBy ?? 'Not approved')}</td><td>${html(decision.decidedAt)}</td></tr>`).join('') || '<tr><td colspan="5">No decisions recorded.</td></tr>'
  const outcomesHtml = data.outcomes.map((outcome) => `<tr><td>${html(outcome.summary)}</td><td>${html(outcome.decisionId)}</td><td>${html(outcome.observedAt)}</td><td>${html(JSON.stringify(outcome.metrics))}</td></tr>`).join('') || '<tr><td colspan="4">No outcomes recorded.</td></tr>'
  const printable = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${html(title)}</title><style>@page{size:A4;margin:18mm}body{font:14px/1.5 system-ui,sans-serif;color:#172033;max-width:1100px;margin:32px auto;padding:0 24px}h1{font-size:32px}h2{margin-top:32px;border-bottom:2px solid #172033;padding-bottom:6px}table{width:100%;border-collapse:collapse;margin:12px 0}th,td{border:1px solid #cbd2df;padding:8px;text-align:left;vertical-align:top}th{background:#eef2f7}.control{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 24px;background:#f6f8fb;padding:16px}.prob{display:inline-block;min-width:72px;padding:3px 8px;background:linear-gradient(90deg,#8cb4ff var(--p),#e9edf4 var(--p));border-radius:4px}.warning{border-left:4px solid #c47b00;padding:8px 12px;background:#fff6df}@media print{body{margin:0;padding:0}.page-break{break-before:page}}</style></head><body><h1>${html(title)}</h1><section class="control"><div><b>Report ID</b><br>${html(reportId)}</div><div><b>Version/status</b><br>${html(reportVersion)} / ${html(reportStatus)}</div><div><b>As of</b><br>${html(data.asOf)}</div><div><b>Classification</b><br>${html(documentClassification)}</div><div><b>Author</b><br>${html(author)}</div><div><b>Reviewer</b><br>${html(reviewer ?? 'Not yet reviewed')}</div><div><b>Distribution</b><br>${html(distribution.join(', ') || 'Not specified')}</div></section><h2>Executive summary</h2><p>${html(executiveSummary)}</p><h2>Key judgments</h2><table><thead><tr><th>ID</th><th>Judgment</th><th>Confidence</th><th>Review</th></tr></thead><tbody>${rowsHtml}</tbody></table><h2>Forecast register</h2><table><thead><tr><th>Question</th><th>Probability</th><th>Horizon</th><th>Status</th></tr></thead><tbody>${forecastsHtml}</tbody></table><h2>Scenarios and signposts</h2>${scenariosHtml}<h2>Decisions</h2><table><thead><tr><th>Decision</th><th>Chosen option</th><th>Status</th><th>Approved by</th><th>Date</th></tr></thead><tbody>${decisionsHtml}</tbody></table><h2>Recorded outcomes</h2><table><thead><tr><th>Outcome</th><th>Decision ID</th><th>Observed</th><th>Metrics</th></tr></thead><tbody>${outcomesHtml}</tbody></table><h2>Track record</h2><p>Resolved sample: ${html(score.sampleSize ?? 0)} · Brier: ${html(score.brierScore ?? 'n/a')} · Log loss: ${html(score.logLoss ?? 'n/a')} · Skill: ${html(score.brierSkillScore ?? 'n/a')}</p>${score.warning ? `<p class="warning">${html(score.warning)}</p>` : ''}<h2>Ontology coverage</h2><p>${data.ontology.activeObjects} active objects and ${data.ontology.activeLinks} active links.</p><h2>Evidence ledger</h2>${data.evidence.map((source) => `<article><h3>[${html(source.id)}] ${html(source.title)}</h3><p><a href="${html(source.url)}">${html(source.url)}</a><br>Published ${html(source.publishedAt)} · retrieved ${html(source.retrievedAt)} · SHA-256 ${html(source.contentHash)}</p><p>${html(source.excerpt)}</p></article>`).join('')}<h2>Limitations</h2><p>As-of cutoff enforced. Hashes establish excerpt integrity, not truth. Review verdicts remain accountable judgments. Document labels do not enforce access.</p></body></html>`
  await captureBeforeWrite(path); await captureBeforeWrite(sidecarPath); await captureBeforeWrite(htmlPath)
  await atomicWrite(path, markdown); await atomicWrite(sidecarPath, JSON.stringify(reportBundle, null, 2)); await atomicWrite(htmlPath, printable)
  return JSON.stringify({ status: 'created', reportId, reportStatus, reportPath: path, sidecarPath, htmlPath, claims: data.claims.length, forecasts: forecastRows.length, sources: data.evidence.length, unresolvedReviewCount: unresolvedReviews.length }, null, 2)
}

export const battmannTool: Tool = {
  name: 'battmann',
  description: 'Battmann strategic-intelligence system of record. forecast provides transparent evidence updating, ensemble combines independent forecasts without rewarding correlated duplicates, and backtest scores supplied rows. The versioned ledger actions enforce temporal evidence availability; scorecard and run_benchmark measure calibration and held-out chronological skill. Ontology, scenario, decision, and outcome actions build an evidence-linked decision graph. report_from_store creates governed Markdown, JSON, and printable HTML from a cutoff-safe stored evidence base.',
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['forecast', 'ensemble', 'backtest', 'report', 'report_from_store', ...BATTMANN_STORE_ACTIONS] },
      storePath: { type: 'string', description: 'Optional workspace-relative SQLite path; defaults to .elia/battmann.sqlite.' },
      questionId: { type: 'string' }, question: { type: 'string' }, domain: { type: 'string' }, openedAt: { type: 'string' }, asOf: { type: 'string' }, horizon: { type: 'string' }, resolutionCriteria: { type: 'string' }, tags: { type: 'array' },
      priorProbability: { type: 'number' }, probability: { type: 'number' }, signals: { type: 'array' }, components: { type: 'array' }, forecasts: { type: 'array' }, forecastId: { type: 'string' }, forecastClass: { type: 'string', description: 'live for predictions physically logged before resolution; backtest for historical replay that cannot support a live superiority claim.' }, evidenceIds: { type: 'array' }, method: { type: 'string' }, model: { type: 'string' }, forecaster: { type: 'string' }, rationale: { type: 'string' },
      evidenceId: { type: 'string' }, title: { type: 'string' }, url: { type: 'string' }, publisher: { type: 'string' }, sourceType: { type: 'string' }, publishedAt: { type: 'string' }, retrievedAt: { type: 'string' }, excerpt: { type: 'string' }, independenceGroup: { type: 'string' }, reliability: { type: 'number' },
      claimId: { type: 'string' }, statement: { type: 'string' }, classification: { type: 'string' }, confidence: { type: 'string' }, evidenceLinks: { type: 'array' }, reviewId: { type: 'string' }, verdict: { type: 'string' }, reviewer: { type: 'string' }, reviewedAt: { type: 'string' }, notes: { type: 'string' },
      resolutionId: { type: 'string' }, resolutionStatus: { type: 'string' }, outcome: { type: 'number' }, resolvedAt: { type: 'string' }, resolutionSourceUrl: { type: 'string' }, resolver: { type: 'string' }, status: { type: 'string' },
      benchmarkId: { type: 'string' }, evaluationStart: { type: 'string' }, evaluationEnd: { type: 'string' }, minimumTraining: { type: 'number' },
      objectId: { type: 'string' }, objectType: { type: 'string' }, name: { type: 'string' }, validFrom: { type: 'string' }, validTo: { type: 'string' }, properties: { type: 'object' }, linkId: { type: 'string' }, fromId: { type: 'string' }, toId: { type: 'string' }, linkType: { type: 'string' },
      scenarioId: { type: 'string' }, baseAsOf: { type: 'string' }, assumptions: { type: 'array' }, questionIds: { type: 'array' }, indicators: { type: 'array' }, decisionId: { type: 'string' }, options: { type: 'array' }, chosenOption: { type: 'string' }, approvedBy: { type: 'string' }, decidedAt: { type: 'string' }, outcomeId: { type: 'string' }, observedAt: { type: 'string' }, summary: { type: 'string' }, metrics: { type: 'object' },
      executiveSummary: { type: 'string' }, keyJudgments: { type: 'array' }, sources: { type: 'array' }, limitations: { type: 'array' }, outputPath: { type: 'string' }, reportId: { type: 'string' }, reportVersion: { type: 'string' }, reportStatus: { type: 'string' }, author: { type: 'string' }, documentClassification: { type: 'string' }, distribution: { type: 'array' },
    },
    required: ['action'],
  },
  async execute(input) {
    if (input.action === 'forecast') return calculateForecast(input)
    if (input.action === 'ensemble') return calculateEnsemble(input)
    if (input.action === 'backtest') return backtestForecasts(input)
    if (input.action === 'report') return createReport(input)
    if (input.action === 'report_from_store') return createStoreReport(input)
    if (typeof input.action === 'string' && (BATTMANN_STORE_ACTIONS as readonly string[]).includes(input.action)) return executeBattmannStoreAction(input)
    throw new Error(`action must be forecast, ensemble, backtest, report, report_from_store, or one of: ${BATTMANN_STORE_ACTIONS.join(', ')}`)
  },
}
