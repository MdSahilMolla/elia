import { extname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { resolveWorkspacePath } from '../autonomy/context.ts'
import { captureBeforeWrite } from '../checkpoint.ts'
import { BATTMANN_STORE_ACTIONS, executeBattmannStoreAction, loadBattmannDashboardData, loadBattmannReportData } from '../battmann/store.ts'
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

type RiskDirection = 'aggravating' | 'mitigating'
type Momentum = 'rising' | 'stable' | 'falling'
interface RiskFactor { id: string; summary: string; sourceUrl: string; sourceDate: string; direction: RiskDirection; magnitude: number; reliability: number; independenceGroup: string; momentum: Momentum }

export function calculateRiskAssessment(input: Record<string, unknown>): string {
  const subject = text(input.subject, 'subject')
  const asOf = date(input.asOf, 'asOf')
  const priorRisk = input.priorRisk === undefined ? 50 : number(input.priorRisk, 'priorRisk', 1, 99)
  const factors: RiskFactor[] = list(input.factors, 'factors').map((item, index) => {
    const sourceDate = date(item.sourceDate, `factors[${index}].sourceDate`)
    if (sourceDate > asOf) throw new Error(`factors[${index}].sourceDate cannot be after asOf`)
    const direction = text(item.direction, `factors[${index}].direction`, 20)
    if (direction !== 'aggravating' && direction !== 'mitigating') throw new Error(`factors[${index}].direction must be aggravating or mitigating`)
    const momentum = item.momentum === undefined ? 'stable' : text(item.momentum, `factors[${index}].momentum`, 20)
    if (!['rising', 'stable', 'falling'].includes(momentum)) throw new Error(`factors[${index}].momentum must be rising, stable, or falling`)
    return {
      id: text(item.id, `factors[${index}].id`, 100), summary: text(item.summary, `factors[${index}].summary`), sourceUrl: url(item.sourceUrl, `factors[${index}].sourceUrl`), sourceDate,
      direction: direction as RiskDirection, magnitude: number(item.magnitude, `factors[${index}].magnitude`, 0.001, 1), reliability: number(item.reliability, `factors[${index}].reliability`, 0, 1),
      independenceGroup: text(item.independenceGroup, `factors[${index}].independenceGroup`, 100), momentum: momentum as Momentum,
    }
  })
  if (!factors.length) throw new Error('factors must contain at least one sourced factor')
  if (new Set(factors.map((factor) => factor.id)).size !== factors.length) throw new Error('factor ids must be unique')
  const SCALE = 1.5
  const signed = (factor: RiskFactor) => SCALE * factor.magnitude * factor.reliability * (factor.direction === 'aggravating' ? 1 : -1)
  const momentumValue = (momentum: Momentum) => (momentum === 'rising' ? 1 : momentum === 'falling' ? -1 : 0)
  const groups = new Map<string, RiskFactor[]>()
  for (const factor of factors) groups.set(factor.independenceGroup, [...(groups.get(factor.independenceGroup) ?? []), factor])
  // Correlated factors share one group and contribute their mean, so repeated coverage of one driver does not compound the score.
  const groupContributions = [...groups.entries()].map(([group, members]) => ({ group, logOddsContribution: members.reduce((sum, factor) => sum + signed(factor), 0) / members.length, factorCount: members.length }))
  const totalContribution = groupContributions.reduce((sum, item) => sum + item.logOddsContribution, 0)
  const riskScore = round(100 * logistic(logit(priorRisk / 100) + totalContribution), 1)
  const meanReliability = factors.reduce((sum, factor) => sum + factor.reliability, 0) / factors.length
  const confidence: Confidence = groups.size >= 4 && meanReliability >= 0.75 ? 'high' : groups.size >= 2 && meanReliability >= 0.5 ? 'medium' : 'low'
  const momentumWeight = factors.reduce((sum, factor) => sum + Math.abs(signed(factor)), 0)
  // A rising aggravating factor pushes risk up; a rising mitigating factor pushes it down. Weight each by the size of its contribution.
  const travel = momentumWeight ? factors.reduce((sum, factor) => sum + Math.abs(signed(factor)) * momentumValue(factor.momentum) * (factor.direction === 'aggravating' ? 1 : -1), 0) / momentumWeight : 0
  const netTravel: Momentum = travel > 0.15 ? 'rising' : travel < -0.15 ? 'falling' : 'stable'
  const drivers = [...factors].sort((a, b) => Math.abs(signed(b)) - Math.abs(signed(a))).slice(0, 5).map((factor) => ({ id: factor.id, summary: factor.summary, direction: factor.direction, contribution: round(signed(factor)), share: momentumWeight ? round(Math.abs(signed(factor)) / momentumWeight) : null }))
  const sensitivity = groupContributions.map((removed) => ({ removedGroup: removed.group, riskScore: round(100 * logistic(logit(priorRisk / 100) + groupContributions.filter((item) => item !== removed).reduce((sum, item) => sum + item.logOddsContribution, 0)), 1) }))
  const band = riskScore < 25 ? 'low' : riskScore < 50 ? 'moderate' : riskScore < 75 ? 'high' : 'severe'
  return JSON.stringify({
    action: 'risk_assessment', subject, asOf, priorRisk, riskScore, band, confidence,
    directionOfTravel: { net: netTravel, magnitude: round(travel, 3), basis: 'supplied factor momentum weighted by each factor\u2019s contribution to the score', horizonNote: 'A 7- versus 30-day split requires dated factor histories; log them as forecast revisions on a resolvable question to obtain a measured trend.' },
    independentFactorGroups: groups.size, meanFactorReliability: round(meanReliability),
    factors: factors.map((factor) => ({ ...factor, contribution: round(signed(factor)) })),
    groupContributions: groupContributions.map((item) => ({ ...item, logOddsContribution: round(item.logOddsContribution) })),
    drivers, sensitivity,
    methodology: 'Prior risk is taken to log-odds and shifted by reliability-weighted factor magnitudes: aggravating factors raise the score, mitigating factors lower it. Factors in one independence group are averaged before they are summed.',
    limitations: ['The score is a reproducible model estimate, not a measured probability of loss.', 'Magnitude, reliability, and momentum are analyst inputs unless fitted from resolved history.', 'Direction of travel reflects the supplied factor momentum, not an observed time series.'],
  }, null, 2)
}

interface ConsequenceNode { id: string; parentId: string | null; statement: string; mechanism: string; conditionalProbability: number; lagDays: number; basis: string; sourceUrl: string | null }

export function buildConsequenceChain(input: Record<string, unknown>): string {
  const trigger = text(input.trigger, 'trigger')
  const asOf = date(input.asOf, 'asOf')
  const raw = list(input.nodes, 'nodes')
  if (!raw.length) throw new Error('nodes must contain at least one consequence')
  const nodes: ConsequenceNode[] = raw.map((item, index) => ({
    id: text(item.id, `nodes[${index}].id`, 100),
    parentId: item.parentId === undefined || item.parentId === null || item.parentId === '' ? null : text(item.parentId, `nodes[${index}].parentId`, 100),
    statement: text(item.statement, `nodes[${index}].statement`),
    mechanism: text(item.mechanism, `nodes[${index}].mechanism`, 2_000),
    conditionalProbability: number(item.conditionalProbability, `nodes[${index}].conditionalProbability`, 0.001, 0.999),
    lagDays: number(item.lagDays, `nodes[${index}].lagDays`, 0, 3_650),
    basis: text(item.basis, `nodes[${index}].basis`, 2_000),
    sourceUrl: item.sourceUrl === undefined || item.sourceUrl === '' ? null : url(item.sourceUrl, `nodes[${index}].sourceUrl`),
  }))
  if (new Set(nodes.map((node) => node.id)).size !== nodes.length) throw new Error('node ids must be unique')
  const byId = new Map(nodes.map((node) => [node.id, node]))
  // Every non-root parent must be defined earlier, which makes the graph an acyclic tree of consequences.
  const defined = new Set<string>()
  for (const node of nodes) {
    if (node.parentId !== null && !defined.has(node.parentId)) throw new Error(`node ${node.id} names parentId ${node.parentId}, which is not an earlier node`)
    defined.add(node.id)
  }
  const chainTo = (node: ConsequenceNode): ConsequenceNode[] => (node.parentId === null ? [node] : [...chainTo(byId.get(node.parentId)!), node])
  const annotated = nodes.map((node) => {
    const chain = chainTo(node)
    return { ...node, order: chain.length, path: chain.map((item) => item.id), pathProbability: round(chain.reduce((product, item) => product * item.conditionalProbability, 1)), cumulativeLagDays: chain.reduce((sum, item) => sum + item.lagDays, 0) }
  })
  const leaves = annotated.filter((node) => !nodes.some((candidate) => candidate.parentId === node.id))
  const dominant = [...leaves].sort((a, b) => b.pathProbability - a.pathProbability)[0] ?? null
  const maxOrder = annotated.reduce((max, node) => Math.max(max, node.order), 0)
  return JSON.stringify({
    action: 'consequence_chain', trigger, asOf, depth: maxOrder,
    countByOrder: Array.from({ length: maxOrder }, (_, index) => ({ order: index + 1, count: annotated.filter((node) => node.order === index + 1).length })),
    nodes: annotated,
    dominantPath: dominant ? { leafId: dominant.id, path: dominant.path, pathProbability: dominant.pathProbability, cumulativeLagDays: dominant.cumulativeLagDays } : null,
    leaves: leaves.map((node) => ({ id: node.id, statement: node.statement, order: node.order, pathProbability: node.pathProbability, cumulativeLagDays: node.cumulativeLagDays })),
    weakestLinks: [...annotated].sort((a, b) => a.conditionalProbability - b.conditionalProbability).slice(0, 3).map((node) => ({ id: node.id, statement: node.statement, order: node.order, conditionalProbability: node.conditionalProbability })),
    tailRisks: annotated.filter((node) => node.order >= 3 && node.pathProbability < 0.1).map((node) => ({ id: node.id, statement: node.statement, order: node.order, pathProbability: node.pathProbability })),
    methodology: 'Each edge carries P(effect | cause). Path probability is the product of the conditional probabilities from the trigger to the node, assuming edges along a path are conditionally independent given their parents. Lag days sum along the path.',
    limitations: ['Conditional probabilities are analyst estimates unless each is fitted from a reference class of similar chains.', 'The along-path independence assumption understates probability when consequences reinforce one another and overstates it when they compete.', 'A branch that was not drawn is not a branch that cannot happen.'],
  }, null, 2)
}

interface Exposure { id: string; channel: string; factor: string; sourceUrl: string; sourceDate: string; notional: number; shockPct: number; sensitivity: number; reliability: number; independenceGroup: string }

export function calculateExposureAssessment(input: Record<string, unknown>): string {
  const subject = text(input.subject, 'subject')
  const asOf = date(input.asOf, 'asOf')
  const baseValue = number(input.baseValue, 'baseValue', 0.01, 1e15)
  const currency = input.currency === undefined ? 'unspecified units' : text(input.currency, 'currency', 50)
  const exposures: Exposure[] = list(input.exposures, 'exposures').map((item, index) => {
    const sourceDate = date(item.sourceDate, `exposures[${index}].sourceDate`)
    if (sourceDate > asOf) throw new Error(`exposures[${index}].sourceDate cannot be after asOf`)
    return {
      id: text(item.id, `exposures[${index}].id`, 100), channel: text(item.channel, `exposures[${index}].channel`, 60), factor: text(item.factor, `exposures[${index}].factor`, 200),
      sourceUrl: url(item.sourceUrl, `exposures[${index}].sourceUrl`), sourceDate,
      notional: number(item.notional, `exposures[${index}].notional`, 0, 1e15),
      shockPct: number(item.shockPct, `exposures[${index}].shockPct`, 0.0001, 1),
      sensitivity: item.sensitivity === undefined ? 1 : number(item.sensitivity, `exposures[${index}].sensitivity`, 0, 5),
      reliability: number(item.reliability, `exposures[${index}].reliability`, 0, 1),
      independenceGroup: text(item.independenceGroup, `exposures[${index}].independenceGroup`, 100),
    }
  })
  if (!exposures.length) throw new Error('exposures must contain at least one sourced exposure')
  if (new Set(exposures.map((exposure) => exposure.id)).size !== exposures.length) throw new Error('exposure ids must be unique')
  const grossLoss = (exposure: Exposure) => exposure.notional * exposure.shockPct * exposure.sensitivity
  const groups = new Map<string, Exposure[]>()
  for (const exposure of exposures) groups.set(exposure.independenceGroup, [...(groups.get(exposure.independenceGroup) ?? []), exposure])
  // Exposures in one group are treated as perfectly correlated (they add); groups are treated as independent (root-sum-of-squares).
  const groupLosses = [...groups.entries()].map(([group, members]) => ({ group, loss: members.reduce((sum, exposure) => sum + grossLoss(exposure), 0), factorCount: members.length }))
  const undiversifiedLoss = groupLosses.reduce((sum, item) => sum + item.loss, 0)
  const diversifiedLoss = Math.sqrt(groupLosses.reduce((sum, item) => sum + item.loss ** 2, 0))
  const concentrationHHI = undiversifiedLoss > 0 ? groupLosses.reduce((sum, item) => sum + (item.loss / undiversifiedLoss) ** 2, 0) : 0
  const lossRatio = diversifiedLoss / baseValue
  const meanReliability = exposures.reduce((sum, exposure) => sum + exposure.reliability, 0) / exposures.length
  const confidence: Confidence = groups.size >= 4 && meanReliability >= 0.75 ? 'high' : groups.size >= 2 && meanReliability >= 0.5 ? 'medium' : 'low'
  const channels = [...new Set(exposures.map((exposure) => exposure.channel))].map((channel) => {
    const loss = exposures.filter((exposure) => exposure.channel === channel).reduce((sum, exposure) => sum + grossLoss(exposure), 0)
    return { channel, loss: round(loss, 2), share: undiversifiedLoss > 0 ? round(loss / undiversifiedLoss) : null }
  }).sort((a, b) => b.loss - a.loss)
  const sensitivity = groupLosses.map((removed) => ({ removedGroup: removed.group, diversifiedLoss: round(Math.sqrt(groupLosses.filter((item) => item !== removed).reduce((sum, item) => sum + item.loss ** 2, 0)), 2) }))
  const band = lossRatio < 0.05 ? 'low' : lossRatio < 0.15 ? 'moderate' : lossRatio < 0.3 ? 'high' : 'severe'
  return JSON.stringify({
    action: 'exposure_assessment', subject, asOf, currency, baseValue,
    undiversifiedLoss: round(undiversifiedLoss, 2), diversifiedLoss: round(diversifiedLoss, 2), diversificationBenefit: round(undiversifiedLoss - diversifiedLoss, 2),
    lossRatio: round(lossRatio), band, confidence, concentrationHHI: round(concentrationHHI), independentGroups: groups.size, meanReliability: round(meanReliability),
    exposures: exposures.map((exposure) => ({ ...exposure, grossLoss: round(grossLoss(exposure), 2) })),
    groupLosses: groupLosses.map((item) => ({ ...item, loss: round(item.loss, 2) })),
    byChannel: channels,
    drivers: [...exposures].sort((a, b) => grossLoss(b) - grossLoss(a)).slice(0, 5).map((exposure) => ({ id: exposure.id, channel: exposure.channel, factor: exposure.factor, grossLoss: round(grossLoss(exposure), 2) })),
    sensitivity,
    methodology: 'Per-exposure loss = notional x adverse shock x sensitivity. Exposures sharing an independence group add (assumed fully correlated); groups combine by root-sum-of-squares (assumed independent). HHI is computed on the undiversified group losses.',
    limitations: ['This is a deterministic scenario loss, not a value-at-risk: there is no return distribution, confidence level, or holding period.', 'The correlation structure is entirely the independence-group assumption; real cross-asset correlation moves toward 1 in a crisis, which this understates.', 'Shocks and sensitivities are analyst inputs unless calibrated from historical factor moves.'],
  }, null, 2)
}

interface Capability { id: string; category: string; side: 'A' | 'B'; metric: string; count: number; qualityFactor: number; sourceUrl: string; sourceDate: string; reliability: number }

export function assessPosture(input: Record<string, unknown>): string {
  const theatre = text(input.theatre, 'theatre')
  const asOf = date(input.asOf, 'asOf')
  const sideA = text(input.sideA, 'sideA', 200)
  const sideB = text(input.sideB, 'sideB', 200)
  if (sideA === sideB) throw new Error('sideA and sideB must differ')
  const capabilities: Capability[] = list(input.capabilities, 'capabilities').map((item, index) => {
    const sourceDate = date(item.sourceDate, `capabilities[${index}].sourceDate`)
    if (sourceDate > asOf) throw new Error(`capabilities[${index}].sourceDate cannot be after asOf`)
    const side = text(item.side, `capabilities[${index}].side`, 1)
    if (side !== 'A' && side !== 'B') throw new Error(`capabilities[${index}].side must be A or B`)
    return {
      id: text(item.id, `capabilities[${index}].id`, 100), category: text(item.category, `capabilities[${index}].category`, 60), side: side as 'A' | 'B',
      metric: text(item.metric, `capabilities[${index}].metric`, 200), count: number(item.count, `capabilities[${index}].count`, 0, 1e9),
      qualityFactor: item.qualityFactor === undefined ? 1 : number(item.qualityFactor, `capabilities[${index}].qualityFactor`, 0.1, 3),
      sourceUrl: url(item.sourceUrl, `capabilities[${index}].sourceUrl`), sourceDate, reliability: number(item.reliability, `capabilities[${index}].reliability`, 0, 1),
    }
  })
  if (!capabilities.length) throw new Error('capabilities must contain at least one sourced line item')
  if (new Set(capabilities.map((capability) => capability.id)).size !== capabilities.length) throw new Error('capability ids must be unique')
  const effective = (capability: Capability) => capability.count * capability.qualityFactor
  const label = (ratio: number | null) => ratio === null ? 'undetermined' : ratio > 1.5 ? `${sideA} advantage` : ratio < 0.667 ? `${sideB} advantage` : 'rough parity'
  const categories = [...new Set(capabilities.map((capability) => capability.category))].map((category) => {
    const inCategory = capabilities.filter((capability) => capability.category === category)
    const a = inCategory.filter((capability) => capability.side === 'A').reduce((sum, capability) => sum + effective(capability), 0)
    const b = inCategory.filter((capability) => capability.side === 'B').reduce((sum, capability) => sum + effective(capability), 0)
    const ratio = a > 0 && b > 0 ? a / b : null
    return { category, effectiveA: round(a, 2), effectiveB: round(b, 2), ratio: ratio === null ? null : round(ratio), balance: label(ratio), oneSided: a === 0 || b === 0 }
  })
  const totalA = capabilities.filter((capability) => capability.side === 'A').reduce((sum, capability) => sum + effective(capability), 0)
  const totalB = capabilities.filter((capability) => capability.side === 'B').reduce((sum, capability) => sum + effective(capability), 0)
  const overallRatio = totalA > 0 && totalB > 0 ? totalA / totalB : null
  const meanReliability = capabilities.reduce((sum, capability) => sum + capability.reliability, 0) / capabilities.length
  const distinctCategories = new Set(capabilities.map((capability) => capability.category)).size
  const confidence: Confidence = distinctCategories >= 4 && meanReliability >= 0.75 ? 'high' : distinctCategories >= 2 && meanReliability >= 0.5 ? 'medium' : 'low'
  return JSON.stringify({
    action: 'posture_assessment', theatre, asOf, sideA, sideB,
    overall: { effectiveA: round(totalA, 2), effectiveB: round(totalB, 2), ratio: overallRatio === null ? null : round(overallRatio), balance: label(overallRatio) },
    categories, confidence, meanReliability: round(meanReliability),
    gaps: categories.filter((category) => category.oneSided).map((category) => `${category.category}: only one side has sourced data`),
    capabilities,
    methodology: 'Effective strength per line item = count x qualityFactor. Category and overall ratios divide side A effective strength by side B. Balance bands: >1.5 A advantage, 0.67-1.5 parity, <0.67 B advantage.',
    limitations: ['A weighted bean-count is not an operational outcome: it ignores doctrine, terrain, logistics, alliances, morale, and initiative.', 'qualityFactor is a coarse analyst multiplier, not a validated capability index.', 'One-sided categories are reported as gaps, not as zeroes.'],
  }, null, 2)
}

interface Criterion { id: string; name: string; weight: number; direction: 'higher-better' | 'lower-better' }
interface Candidate { id: string; name: string; sourceUrl: string; sourceDate: string; reliability: number; note: string | null; scores: Record<string, number> }

export function rankAlternatives(input: Record<string, unknown>): string {
  const subject = text(input.subject, 'subject')
  const asOf = date(input.asOf, 'asOf')
  const incumbentId = input.incumbentId === undefined || input.incumbentId === '' ? null : text(input.incumbentId, 'incumbentId', 100)
  const criteria: Criterion[] = list(input.criteria, 'criteria').map((item, index) => {
    const direction = text(item.direction, `criteria[${index}].direction`, 20)
    if (direction !== 'higher-better' && direction !== 'lower-better') throw new Error(`criteria[${index}].direction must be higher-better or lower-better`)
    return { id: text(item.id, `criteria[${index}].id`, 100), name: text(item.name, `criteria[${index}].name`, 200), weight: number(item.weight, `criteria[${index}].weight`, 0.001, 1), direction: direction as Criterion['direction'] }
  })
  if (criteria.length < 2) throw new Error('criteria must contain at least two entries')
  if (new Set(criteria.map((criterion) => criterion.id)).size !== criteria.length) throw new Error('criterion ids must be unique')
  const criterionIds = new Set(criteria.map((criterion) => criterion.id))
  const candidates: Candidate[] = list(input.candidates, 'candidates').map((item, index) => {
    const sourceDate = date(item.sourceDate, `candidates[${index}].sourceDate`)
    if (sourceDate > asOf) throw new Error(`candidates[${index}].sourceDate cannot be after asOf`)
    const rawScores = item.scores
    if (!rawScores || typeof rawScores !== 'object' || Array.isArray(rawScores)) throw new Error(`candidates[${index}].scores must be an object keyed by criterion id`)
    const scores: Record<string, number> = {}
    for (const criterion of criteria) scores[criterion.id] = number((rawScores as Record<string, unknown>)[criterion.id], `candidates[${index}].scores.${criterion.id}`, 0, 100)
    for (const key of Object.keys(rawScores as Record<string, unknown>)) if (!criterionIds.has(key)) throw new Error(`candidates[${index}].scores.${key} is not a declared criterion`)
    return {
      id: text(item.id, `candidates[${index}].id`, 100), name: text(item.name, `candidates[${index}].name`, 200),
      sourceUrl: url(item.sourceUrl, `candidates[${index}].sourceUrl`), sourceDate, reliability: number(item.reliability, `candidates[${index}].reliability`, 0, 1),
      note: item.note === undefined || item.note === '' ? null : text(item.note, `candidates[${index}].note`, 1_000), scores,
    }
  })
  if (candidates.length < 2) throw new Error('candidates must contain at least two options')
  if (new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length) throw new Error('candidate ids must be unique')
  if (incumbentId && !candidates.some((candidate) => candidate.id === incumbentId)) throw new Error('incumbentId must match one of the candidates')
  const totalWeight = criteria.reduce((sum, criterion) => sum + criterion.weight, 0)
  // Min-max normalise each criterion across the candidates, flip lower-better, then take the weighted mean.
  const normalized = (criterion: Criterion, candidate: Candidate): number => {
    const values = candidates.map((entry) => entry.scores[criterion.id]!)
    const min = Math.min(...values)
    const max = Math.max(...values)
    const unit = max === min ? 0.5 : (candidate.scores[criterion.id]! - min) / (max - min)
    return criterion.direction === 'higher-better' ? unit : 1 - unit
  }
  const composite = (candidate: Candidate, activeCriteria: Criterion[]): number => {
    const weight = activeCriteria.reduce((sum, criterion) => sum + criterion.weight, 0)
    return weight === 0 ? 0 : activeCriteria.reduce((sum, criterion) => sum + normalized(criterion, candidate) * criterion.weight, 0) / weight
  }
  const ranked = [...candidates]
    .map((candidate) => ({
      id: candidate.id, name: candidate.name, reliability: candidate.reliability, note: candidate.note,
      compositeScore: round(composite(candidate, criteria)),
      byCriterion: criteria.map((criterion) => ({ criterionId: criterion.id, name: criterion.name, normalized: round(normalized(criterion, candidate)), weightedContribution: round((normalized(criterion, candidate) * criterion.weight) / totalWeight) })),
    }))
    .sort((a, b) => b.compositeScore - a.compositeScore || a.id.localeCompare(b.id))
    .map((entry, index) => ({ rank: index + 1, ...entry }))
  const incumbent = incumbentId ? ranked.find((entry) => entry.id === incumbentId)! : null
  const sensitivity = criteria.map((dropped) => {
    const active = criteria.filter((criterion) => criterion !== dropped)
    const order = [...candidates].map((candidate) => ({ id: candidate.id, score: composite(candidate, active) })).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    return { droppedCriterion: dropped.id, topCandidate: order[0]!.id, orderChanged: order[0]!.id !== ranked[0]!.id }
  })
  const meanReliability = candidates.reduce((sum, candidate) => sum + candidate.reliability, 0) / candidates.length
  return JSON.stringify({
    action: 'alternatives', subject, asOf, incumbentId,
    recommended: ranked[0] ? { id: ranked[0].id, name: ranked[0].name, compositeScore: ranked[0].compositeScore } : null,
    ranked,
    incumbentComparison: incumbent ? { incumbentId, incumbentRank: incumbent.rank, topScore: ranked[0]!.compositeScore, incumbentScore: incumbent.compositeScore, advantageOfSwitching: round(ranked[0]!.compositeScore - incumbent.compositeScore) } : null,
    sensitivity, stableTopChoice: sensitivity.every((entry) => !entry.orderChanged),
    confidence: (criteria.length >= 4 && meanReliability >= 0.75 ? 'high' : criteria.length >= 2 && meanReliability >= 0.5 ? 'medium' : 'low') as Confidence,
    meanReliability: round(meanReliability),
    methodology: 'Each criterion is min-max normalised across the candidates (lower-better criteria are inverted), then combined as a weighted mean. Scores are 0-100 analyst inputs; weights are analyst inputs.',
    limitations: ['A multi-criteria score compresses incommensurable factors into one number; read the per-criterion breakdown, not just the rank.', 'Min-max normalisation is sensitive to the candidate set: adding or removing an option rescales every score.', 'This ranks known candidates on supplied criteria; it does not discover options or price switching costs.'],
  }, null, 2)
}

interface Threat { id: string; name: string; priority: number; requiredCapability: string; sourceUrl: string; sourceDate: string }
interface Effector { id: string; name: string; capabilities: string[]; capacity: number; readiness: number }

export function pairEffectors(input: Record<string, unknown>): string {
  const asOf = date(input.asOf, 'asOf')
  const threats: Threat[] = list(input.threats, 'threats').map((item, index) => {
    const sourceDate = date(item.sourceDate, `threats[${index}].sourceDate`)
    if (sourceDate > asOf) throw new Error(`threats[${index}].sourceDate cannot be after asOf`)
    return { id: text(item.id, `threats[${index}].id`, 100), name: text(item.name, `threats[${index}].name`, 200), priority: number(item.priority, `threats[${index}].priority`, 1, 100), requiredCapability: text(item.requiredCapability, `threats[${index}].requiredCapability`, 100), sourceUrl: url(item.sourceUrl, `threats[${index}].sourceUrl`), sourceDate }
  })
  const effectors: Effector[] = list(input.effectors, 'effectors').map((item, index) => ({
    id: text(item.id, `effectors[${index}].id`, 100), name: text(item.name, `effectors[${index}].name`, 200),
    capabilities: (Array.isArray(item.capabilities) ? item.capabilities : []).map((value, valueIndex) => text(value, `effectors[${index}].capabilities[${valueIndex}]`, 100)),
    capacity: number(item.capacity, `effectors[${index}].capacity`, 1, 10_000), readiness: item.readiness === undefined ? 1 : number(item.readiness, `effectors[${index}].readiness`, 0, 1),
  }))
  if (!threats.length || !effectors.length) throw new Error('threats and effectors must both be non-empty')
  if (new Set(threats.map((threat) => threat.id)).size !== threats.length) throw new Error('threat ids must be unique')
  if (new Set(effectors.map((effector) => effector.id)).size !== effectors.length) throw new Error('effector ids must be unique')
  if (!effectors.every((effector) => Number.isInteger(effector.capacity))) throw new Error('effector capacity must be an integer')
  const remaining = new Map(effectors.map((effector) => [effector.id, effector.capacity]))
  const assignments: { threatId: string; threatName: string; priority: number; effectorId: string; effectorName: string; readiness: number }[] = []
  const unassigned: { threatId: string; threatName: string; priority: number; reason: string }[] = []
  for (const threat of [...threats].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))) {
    const capable = effectors.filter((effector) => effector.capabilities.includes(threat.requiredCapability))
    if (!capable.length) { unassigned.push({ threatId: threat.id, threatName: threat.name, priority: threat.priority, reason: 'no effector carries the required capability' }); continue }
    const available = capable.filter((effector) => (remaining.get(effector.id) ?? 0) > 0).sort((a, b) => b.readiness - a.readiness || a.id.localeCompare(b.id))
    if (!available.length) { unassigned.push({ threatId: threat.id, threatName: threat.name, priority: threat.priority, reason: 'every capable effector is at capacity' }); continue }
    const chosen = available[0]!
    remaining.set(chosen.id, (remaining.get(chosen.id) ?? 0) - 1)
    assignments.push({ threatId: threat.id, threatName: threat.name, priority: threat.priority, effectorId: chosen.id, effectorName: chosen.name, readiness: chosen.readiness })
  }
  const coveredPriority = assignments.reduce((sum, item) => sum + item.priority, 0)
  const totalPriority = threats.reduce((sum, threat) => sum + threat.priority, 0)
  return JSON.stringify({
    action: 'effector_pairing', asOf, threatCount: threats.length, effectorCount: effectors.length,
    assignments, unassignedThreats: unassigned,
    priorityCoverage: totalPriority > 0 ? round(coveredPriority / totalPriority) : null,
    effectorUtilization: effectors.map((effector) => ({ effectorId: effector.id, name: effector.name, used: effector.capacity - (remaining.get(effector.id) ?? 0), capacity: effector.capacity })),
    methodology: 'Threats are serviced in priority order; each takes the highest-readiness capable effector with remaining capacity (ties broken by id). This is a deterministic greedy assignment, not a global optimum.',
    limitations: ['Greedy priority order can strand a high-value pairing that a global optimiser would keep; it is a planning aid, not a fire-control solution.', 'Capability matching is exact-tag: it models neither partial suitability nor engagement geometry, timing, or probability of kill.'],
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

interface DashboardData {
  storePath: string; asOf: string; clearance: string | null
  counts: Record<string, number>
  questions: Array<{ id: string; question: string; domain: string; horizon: string; probability: number | null; previousProbability: number | null; delta: number | null; latestForecastAsOf: string | null }>
  scenarios: Array<{ id: string; title: string; probability: number; horizon: string; status: string }>
  geo: { categories: Array<{ category: string; count: number; maxSeverity: number; mostRecent: string | null }>; topEvents: Array<{ id: string; title: string; category: string; severity: number; occurredAt: string }>; objectsUnderPressure: Array<{ objectId: string; name: string; events: number; maxSeverity: number }> }
  indicators: Array<{ id: string; name: string; unit: string; higherIs: string; latest: number | null; zScore: number | null; trend: string }>
  pendingProposals: Array<{ id: string; actionType: string; proposedBy: string; rationale: string }>
  scorecard: { sampleSize?: number; brierScore?: number | null; brierSkillScore?: number | null; warning?: string }
  unreviewedClaims: number
  alerts: Array<{ severity: 'high' | 'medium'; kind: string; detail: string }>
}

const trendGlyph = (trend: string) => (trend === 'rising' ? '&#9650;' : trend === 'falling' ? '&#9660;' : '&#8213;')
const pct = (value: number | null) => (value === null ? '&mdash;' : `${(value * 100).toFixed(0)}%`)

async function createDashboard(input: Record<string, unknown>): Promise<string> {
  const title = input.title === undefined ? 'Battmann Intelligence Dashboard' : text(input.title, 'title', 300)
  const outputPath = text(input.outputPath, 'outputPath', 1_000)
  if (extname(outputPath).toLowerCase() !== '.html') throw new Error('outputPath must end in .html')
  const data = loadBattmannDashboardData(input) as unknown as DashboardData
  const generatedAt = new Date().toISOString()
  const htmlPath = resolveWorkspacePath(outputPath)
  const jsonPath = htmlPath.slice(0, -5) + '.json'
  const mdPath = htmlPath.slice(0, -5) + '.md'

  const alertRows = data.alerts.length
    ? data.alerts.map((alert) => `<li class="alert ${alert.severity}"><span class="tag">${alert.severity}</span><span class="kind">${html(alert.kind)}</span> ${html(alert.detail)}</li>`).join('')
    : '<li class="alert none">No active alerts at this cutoff.</li>'
  const questionRows = data.questions.length
    ? data.questions.map((question) => `<tr><td>${html(question.question)}</td><td>${html(question.domain)}</td><td class="num"><span class="prob" style="--p:${Math.round((question.probability ?? 0) * 100)}%">${pct(question.probability)}</span></td><td class="num ${question.delta !== null && question.delta > 0 ? 'up' : question.delta !== null && question.delta < 0 ? 'down' : ''}">${question.delta === null ? '&mdash;' : `${question.delta > 0 ? '+' : ''}${(question.delta * 100).toFixed(0)} pt`}</td><td>${html(question.horizon)}</td></tr>`).join('')
    : '<tr><td colspan="5">No open questions.</td></tr>'
  const scenarioRows = data.scenarios.length
    ? data.scenarios.map((scenario) => `<tr><td>${html(scenario.title)}</td><td class="num">${(scenario.probability * 100).toFixed(0)}%</td><td>${html(scenario.status)}</td><td>${html(scenario.horizon)}</td></tr>`).join('')
    : '<tr><td colspan="4">No scenarios.</td></tr>'
  const indicatorRows = data.indicators.length
    ? data.indicators.map((indicator) => `<tr><td>${html(indicator.name)}</td><td class="num">${indicator.latest === null ? '&mdash;' : `${indicator.latest} ${html(indicator.unit)}`}</td><td class="num">${indicator.zScore === null ? '&mdash;' : indicator.zScore}</td><td class="trend">${trendGlyph(indicator.trend)} ${html(indicator.trend)}</td></tr>`).join('')
    : '<tr><td colspan="4">No indicators.</td></tr>'
  const geoCatRows = data.geo.categories.length
    ? data.geo.categories.map((category) => `<tr><td>${html(category.category)}</td><td class="num">${category.count}</td><td class="num">${category.maxSeverity}</td><td>${html(String(category.mostRecent ?? '&mdash;'))}</td></tr>`).join('')
    : '<tr><td colspan="4">No geolocated events.</td></tr>'
  const pressureRows = data.geo.objectsUnderPressure.length
    ? data.geo.objectsUnderPressure.map((object) => `<li>${html(object.name)} &mdash; ${object.events} event(s), peak severity ${object.maxSeverity}</li>`).join('')
    : '<li>No entities under geo-pressure.</li>'
  const proposalRows = data.pendingProposals.length
    ? data.pendingProposals.map((proposal) => `<li><b>${html(proposal.actionType)}</b> by ${html(proposal.proposedBy)} &mdash; ${html(proposal.rationale)}</li>`).join('')
    : '<li>No pending action proposals.</li>'
  const score = data.scorecard
  const dashboardHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${html(title)}</title><style>
:root{color-scheme:light}body{font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;margin:0;background:#eef1f6;color:#16202e}
header{background:#0f1b2d;color:#fff;padding:18px 24px}header h1{margin:0;font-size:20px}header .meta{opacity:.75;font-size:12px;margin-top:4px}
main{padding:20px;max-width:1200px;margin:0 auto;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
.card{background:#fff;border:1px solid #d5dbe6;border-radius:10px;padding:16px;overflow:auto}.card.wide{grid-column:1/-1}
h2{margin:0 0 10px;font-size:14px;text-transform:uppercase;letter-spacing:.05em;color:#5a6675}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #e7ebf1;vertical-align:top}th{font-size:11px;color:#5a6675;text-transform:uppercase}
td.num{text-align:right;font-variant-numeric:tabular-nums}td.up{color:#b3261e}td.down{color:#0a7c3f}
.prob{display:inline-block;min-width:48px;padding:2px 6px;border-radius:4px;background:linear-gradient(90deg,#f2b8b5 var(--p),#e9edf4 var(--p))}
.kpis{display:flex;flex-wrap:wrap;gap:14px}.kpi{background:#f6f8fb;border-radius:8px;padding:10px 14px;min-width:110px}.kpi b{display:block;font-size:20px}
ul.alerts{list-style:none;margin:0;padding:0}ul.alerts li{padding:8px 10px;border-radius:6px;margin-bottom:6px;background:#f6f8fb}
.alert.high{background:#fdecea;border-left:4px solid #b3261e}.alert.medium{background:#fff6e5;border-left:4px solid #b26a00}.alert.none,.alert{border-left:4px solid #c7ced9}
.alert .tag{display:inline-block;font-size:10px;text-transform:uppercase;background:#16202e;color:#fff;border-radius:3px;padding:1px 5px;margin-right:6px}.alert .kind{font-weight:600;margin-right:6px}
ul.plain{margin:0;padding-left:18px}.trend{white-space:nowrap}.warn{color:#b26a00;margin-top:8px}
@media(max-width:820px){main{grid-template-columns:1fr}}
</style></head><body>
<header><h1>${html(title)}</h1><div class="meta">As of ${html(data.asOf)} &middot; generated ${html(generatedAt)} &middot; store ${html(data.storePath)}${data.clearance ? ` &middot; clearance ${html(data.clearance)}` : ''}</div></header>
<main>
<section class="card wide"><h2>Alerts &mdash; what needs attention</h2><ul class="alerts">${alertRows}</ul></section>
<section class="card wide"><h2>Coverage</h2><div class="kpis">${Object.entries(data.counts).map(([table, count]) => `<div class="kpi"><b>${count}</b>${html(table.replace(/_/g, ' '))}</div>`).join('')}<div class="kpi"><b>${score.sampleSize ?? 0}</b>resolved forecasts</div><div class="kpi"><b>${score.brierScore ?? '&mdash;'}</b>Brier score</div><div class="kpi"><b>${score.brierSkillScore ?? '&mdash;'}</b>Brier skill</div></div>${score.warning ? `<div class="warn">${html(score.warning)}</div>` : ''}</section>
<section class="card"><h2>Open questions &amp; live probability</h2><table><thead><tr><th>Question</th><th>Domain</th><th>Prob.</th><th>7-rev &Delta;</th><th>Horizon</th></tr></thead><tbody>${questionRows}</tbody></table></section>
<section class="card"><h2>Scenarios</h2><table><thead><tr><th>Scenario</th><th>Prob.</th><th>Status</th><th>Horizon</th></tr></thead><tbody>${scenarioRows}</tbody></table></section>
<section class="card"><h2>Macro indicators</h2><table><thead><tr><th>Indicator</th><th>Latest</th><th>z</th><th>Trend</th></tr></thead><tbody>${indicatorRows}</tbody></table></section>
<section class="card"><h2>Geospatial picture</h2><table><thead><tr><th>Category</th><th>Events</th><th>Max sev.</th><th>Most recent</th></tr></thead><tbody>${geoCatRows}</tbody></table><h2 style="margin-top:14px">Entities under pressure</h2><ul class="plain">${pressureRows}</ul></section>
<section class="card wide"><h2>Pending action proposals (human decision required)</h2><ul class="plain">${proposalRows}</ul></section>
</main>
<footer style="max-width:1200px;margin:0 auto;padding:0 20px 24px;color:#5a6675;font-size:12px">Battmann surfaces intelligence; humans decide. Every figure here is a stored, dated, sourced record or a deterministic calculation over one &mdash; not a live feed. Classification labels and clearance are workspace metadata, not access control.</footer>
</body></html>`

  const markdown = [
    `# ${title}`, '', `**As of:** ${data.asOf}  `, `**Generated:** ${generatedAt}  `, `**Store:** ${data.storePath}${data.clearance ? `  \n**Clearance:** ${data.clearance}` : ''}`, '',
    '## Alerts', '', ...(data.alerts.length ? data.alerts.map((alert) => `- **[${alert.severity}] ${alert.kind}** &mdash; ${alert.detail}`) : ['- No active alerts at this cutoff.']), '',
    '## Open questions', '', '| Question | Domain | Probability | Latest revision change | Horizon |', '|---|---|---:|---:|---|',
    ...(data.questions.length ? data.questions.map((question) => `| ${md(question.question)} | ${md(question.domain)} | ${pct(question.probability).replace('&mdash;', '—')} | ${question.delta === null ? '—' : `${question.delta > 0 ? '+' : ''}${(question.delta * 100).toFixed(0)} pt`} | ${question.horizon} |`) : ['| — | — | — | — | — |']), '',
    '## Scenarios', '', '| Scenario | Probability | Status | Horizon |', '|---|---:|---|---|',
    ...(data.scenarios.length ? data.scenarios.map((scenario) => `| ${md(scenario.title)} | ${(scenario.probability * 100).toFixed(0)}% | ${scenario.status} | ${scenario.horizon} |`) : ['| — | — | — | — |']), '',
    '## Macro indicators', '', '| Indicator | Latest | z-score | Trend |', '|---|---:|---:|---|',
    ...(data.indicators.length ? data.indicators.map((indicator) => `| ${md(indicator.name)} | ${indicator.latest === null ? '—' : `${indicator.latest} ${indicator.unit}`} | ${indicator.zScore ?? '—'} | ${indicator.trend} |`) : ['| — | — | — | — |']), '',
    '## Geospatial picture', '', ...(data.geo.categories.length ? data.geo.categories.map((category) => `- **${md(category.category)}** — ${category.count} event(s), peak severity ${category.maxSeverity}`) : ['- No geolocated events.']), '',
    '### Entities under pressure', '', ...(data.geo.objectsUnderPressure.length ? data.geo.objectsUnderPressure.map((object) => `- ${md(object.name)} — ${object.events} event(s), peak severity ${object.maxSeverity}`) : ['- None.']), '',
    '## Pending action proposals', '', ...(data.pendingProposals.length ? data.pendingProposals.map((proposal) => `- **${md(proposal.actionType)}** by ${md(proposal.proposedBy)} — ${md(proposal.rationale)}`) : ['- None.']), '',
    '## Forecast track record', '', `- Resolved sample: ${score.sampleSize ?? 0}`, `- Brier score: ${score.brierScore ?? 'not available'}`, `- Brier skill: ${score.brierSkillScore ?? 'not available'}`, ...(score.warning ? [`- ${score.warning}`] : []), '',
    '_Battmann surfaces intelligence; humans decide. Every figure is a stored, dated, sourced record or a deterministic calculation over one._', '',
  ].join('\n')

  await captureBeforeWrite(htmlPath); await captureBeforeWrite(jsonPath); await captureBeforeWrite(mdPath)
  await atomicWrite(htmlPath, dashboardHtml); await atomicWrite(jsonPath, JSON.stringify({ dashboardSchemaVersion: 1, title, generatedAt, ...data }, null, 2)); await atomicWrite(mdPath, markdown)
  return JSON.stringify({ status: 'created', dashboardPath: htmlPath, jsonPath, mdPath, asOf: data.asOf, alerts: data.alerts.length, openQuestions: data.questions.length, indicators: data.indicators.length }, null, 2)
}

export const battmannTool: Tool = {
  name: 'battmann',
  description: 'Battmann strategic-intelligence system of record. forecast provides transparent evidence updating, ensemble combines independent forecasts without rewarding correlated duplicates, and backtest scores supplied rows. risk_assessment turns dated, sourced, weighted factors into a 0-100 score with per-factor contribution and a direction of travel; consequence_chain annotates a tree of first-, second-, and third-order consequences with path probability and the weakest link. exposure_assessment aggregates sourced financial exposures into a diversified scenario loss with an HHI concentration score; posture_assessment computes a sourced correlation-of-forces balance between two actors; effector_pairing runs a deterministic threat-to-effector assignment. define_indicator/record_indicator_reading/indicator_series keep a dated macro-indicator ledger with trend and z-score. alternatives ranks sourced substitutes across weighted criteria. dashboard renders the whole store — alerts, live probabilities, scenarios, indicators, the geospatial picture, pending proposals, and the track record — as HTML, JSON, and Markdown artifacts for the workspace panel. The versioned ledger actions enforce temporal evidence availability; scorecard and run_benchmark measure calibration and held-out chronological skill. Ontology, scenario, decision, and outcome actions build an evidence-linked decision graph; object_detail, list_objects, find_path, and explain_causality read and trace it. register_dataset/dataset_lineage keep a hash-chained provenance graph; define_action/propose_action/decide_action_proposal are the governed writeback engine (a proposal executes nothing). register_geo_event/geo_query/situation_snapshot give a geolocated common operating picture. define_deployment_target/stage_deployment produce constraint-checked, versioned deployment manifests. Every write appends to a tamper-evident audit_trail, and records carry a securityClassification that reads filter by clearance. report_from_store creates governed Markdown, JSON, and printable HTML from a cutoff-safe stored evidence base.',
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['forecast', 'ensemble', 'backtest', 'risk_assessment', 'consequence_chain', 'exposure_assessment', 'posture_assessment', 'effector_pairing', 'alternatives', 'report', 'report_from_store', 'dashboard', ...BATTMANN_STORE_ACTIONS] },
      storePath: { type: 'string', description: 'Optional workspace-relative SQLite path; defaults to .elia/battmann.sqlite.' },
      questionId: { type: 'string' }, question: { type: 'string' }, domain: { type: 'string' }, openedAt: { type: 'string' }, asOf: { type: 'string' }, horizon: { type: 'string' }, resolutionCriteria: { type: 'string' }, tags: { type: 'array' },
      priorProbability: { type: 'number' }, probability: { type: 'number' }, signals: { type: 'array' }, components: { type: 'array' },
      subject: { type: 'string' }, priorRisk: { type: 'number', description: 'Neutral/base risk on a 0-100 scale before factors are applied; defaults to 50.' }, factors: { type: 'array' }, trigger: { type: 'string' }, nodes: { type: 'array' },
      baseValue: { type: 'number', description: 'exposure_assessment: the value at risk that losses are measured against.' }, currency: { type: 'string' }, exposures: { type: 'array' },
      theatre: { type: 'string' }, sideA: { type: 'string' }, sideB: { type: 'string' }, capabilities: { type: 'array' }, threats: { type: 'array' }, effectors: { type: 'array' },
      criteria: { type: 'array', description: 'alternatives: [{ id, name, weight, direction: higher-better|lower-better }].' }, candidates: { type: 'array', description: 'alternatives: [{ id, name, sourceUrl, sourceDate, reliability, scores: { <criterionId>: 0-100 } }].' }, incumbentId: { type: 'string' },
      indicatorId: { type: 'string' }, unit: { type: 'string' }, frequency: { type: 'string', description: 'indicator cadence: daily, weekly, monthly, quarterly, annual, or irregular.' }, higherIs: { type: 'string', description: 'define_indicator: whether a higher reading is risk-on, risk-off, or neutral.' }, sourceName: { type: 'string' }, value: { type: 'number' }, forecasts: { type: 'array' }, forecastId: { type: 'string' }, forecastClass: { type: 'string', description: 'live for predictions physically logged before resolution; backtest for historical replay that cannot support a live superiority claim.' }, evidenceIds: { type: 'array' }, method: { type: 'string' }, model: { type: 'string' }, forecaster: { type: 'string' }, rationale: { type: 'string' },
      evidenceId: { type: 'string' }, title: { type: 'string' }, url: { type: 'string' }, publisher: { type: 'string' }, sourceType: { type: 'string' }, publishedAt: { type: 'string' }, retrievedAt: { type: 'string' }, excerpt: { type: 'string' }, independenceGroup: { type: 'string' }, reliability: { type: 'number' },
      claimId: { type: 'string' }, statement: { type: 'string' }, classification: { type: 'string' }, confidence: { type: 'string' }, evidenceLinks: { type: 'array' }, reviewId: { type: 'string' }, verdict: { type: 'string' }, reviewer: { type: 'string' }, reviewedAt: { type: 'string' }, notes: { type: 'string' },
      resolutionId: { type: 'string' }, resolutionStatus: { type: 'string' }, outcome: { type: 'number' }, resolvedAt: { type: 'string' }, resolutionSourceUrl: { type: 'string' }, resolver: { type: 'string' }, status: { type: 'string' },
      benchmarkId: { type: 'string' }, evaluationStart: { type: 'string' }, evaluationEnd: { type: 'string' }, minimumTraining: { type: 'number' },
      objectId: { type: 'string' }, objectType: { type: 'string' }, name: { type: 'string' }, validFrom: { type: 'string' }, validTo: { type: 'string' }, properties: { type: 'object' }, linkId: { type: 'string' }, fromId: { type: 'string' }, toId: { type: 'string' }, linkType: { type: 'string' },
      targetObjectId: { type: 'string' }, maxDepth: { type: 'number' }, direction: { type: 'string', description: 'find_path traversal: out (follow links from source), in (follow links into source), or any (default).' },
      scenarioId: { type: 'string' }, baseAsOf: { type: 'string' }, assumptions: { type: 'array' }, questionIds: { type: 'array' }, indicators: { type: 'array' }, decisionId: { type: 'string' }, options: { type: 'array' }, chosenOption: { type: 'string' }, approvedBy: { type: 'string' }, decidedAt: { type: 'string' }, outcomeId: { type: 'string' }, observedAt: { type: 'string' }, summary: { type: 'string' }, metrics: { type: 'object' },
      executiveSummary: { type: 'string' }, keyJudgments: { type: 'array' }, sources: { type: 'array' }, limitations: { type: 'array' }, outputPath: { type: 'string' }, reportId: { type: 'string' }, reportVersion: { type: 'string' }, reportStatus: { type: 'string' }, author: { type: 'string' }, documentClassification: { type: 'string' }, distribution: { type: 'array' },
      securityClassification: { type: 'string', description: 'Cell-level label on a record: public, internal (default), confidential, or restricted. Reads that pass a lower clearance withhold it.' },
      clearance: { type: 'string', description: 'Read-side clearance: public, internal, confidential, or restricted. Records classified above it are withheld from the result; omit to see everything.' },
      datasetId: { type: 'string' }, parentDatasetId: { type: 'string' }, transform: { type: 'string', description: 'Required when parentDatasetId is set: how this dataset was derived from its parent.' }, uri: { type: 'string' }, rowCount: { type: 'number' }, contentHash: { type: 'string', description: 'Analyst-computed hash of the dataset contents, for the lineage chain.' },
      actionTypeId: { type: 'string' }, actionTypeName: { type: 'string' }, appliesTo: { type: 'string' }, parametersSchema: { type: 'object', description: 'define_action: { paramName: { type: string|number|boolean|object|array, required?: boolean } }.' }, requiresClearance: { type: 'string' }, proposalId: { type: 'string' }, proposedBy: { type: 'string' }, parameters: { type: 'object' }, decision: { type: 'string', description: 'decide_action_proposal: approved, rejected, or withdrawn.' }, decidedBy: { type: 'string' }, decisionNotes: { type: 'string' },
      geoEventId: { type: 'string' }, latitude: { type: 'number' }, longitude: { type: 'number' }, occurredAt: { type: 'string' }, severity: { type: 'number', description: 'geo event severity, 0-100.' }, category: { type: 'string' }, affectedObjectIds: { type: 'array' }, sourceUrl: { type: 'string' }, radiusKm: { type: 'number' }, since: { type: 'string' }, bbox: { type: 'object', description: 'situation_snapshot bounding box: { minLat, maxLat, minLon, maxLon }.' },
      targetId: { type: 'string' }, stageId: { type: 'string' }, kind: { type: 'string', description: 'deployment target: air-gap-export, sovereign-cloud, or edge-node.' }, maxClassification: { type: 'string' }, formats: { type: 'array', description: 'subset of md, json, html the target requires.' }, stagedBy: { type: 'string' }, reportPath: { type: 'string' }, limit: { type: 'number' },
    },
    required: ['action'],
  },
  async execute(input) {
    if (input.action === 'forecast') return calculateForecast(input)
    if (input.action === 'ensemble') return calculateEnsemble(input)
    if (input.action === 'backtest') return backtestForecasts(input)
    if (input.action === 'risk_assessment') return calculateRiskAssessment(input)
    if (input.action === 'consequence_chain') return buildConsequenceChain(input)
    if (input.action === 'exposure_assessment') return calculateExposureAssessment(input)
    if (input.action === 'posture_assessment') return assessPosture(input)
    if (input.action === 'effector_pairing') return pairEffectors(input)
    if (input.action === 'alternatives') return rankAlternatives(input)
    if (input.action === 'dashboard') return createDashboard(input)
    if (input.action === 'report') return createReport(input)
    if (input.action === 'report_from_store') return createStoreReport(input)
    if (typeof input.action === 'string' && (BATTMANN_STORE_ACTIONS as readonly string[]).includes(input.action)) return executeBattmannStoreAction(input)
    throw new Error(`action must be forecast, ensemble, backtest, risk_assessment, consequence_chain, exposure_assessment, posture_assessment, effector_pairing, alternatives, report, report_from_store, dashboard, or one of: ${BATTMANN_STORE_ACTIONS.join(', ')}`)
  },
}
