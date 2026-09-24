import { feedNow, fetchFeed, normalizeFeedRequest, type FeedFrequency, type FeedRequest, type FeedResult, type FeedSeries } from './feeds.ts'
import { baselineForecast, evaluateRule, resolutionRequest, ruleSeriesKey, type ResolutionRule } from './resolution.ts'
import {
  executeBattmannStoreAction, listFeedSubscriptions, openRuleQuestions, readIndicatorReadings, recordBaselineForecast,
  recordFeedFailure, recordFeedResolution, recordFeedResult,
} from './store.ts'

/**
 * The deterministic monitoring loop: no model is involved. It re-pulls every subscribed feed (rolled forward
 * to today), resolves rule questions whose outcome is now published, and refreshes the statistical baseline
 * on open questions. `elia battmann refresh` runs it once; `elia battmann watch` runs it on an interval, for
 * as long as that process stays up.
 */

type Row = Record<string, unknown>
const DAY_MS = 86_400_000
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))
const dayOf = (date: Date) => date.toISOString().slice(0, 10)

/** Moves a subscription's window so it ends now, keeping its length. */
export function rollForward(request: FeedRequest, now: Date = feedNow()): FeedRequest {
  const today = dayOf(now)
  const shiftDays = (from: string, days: number) => dayOf(new Date(Date.parse(`${from}T00:00:00Z`) + days * DAY_MS))
  const spanDays = (start: string, end: string) => Math.round((Date.parse(end) - Date.parse(start)) / DAY_MS)
  switch (request.feed) {
    case 'fx': return { ...request, start: shiftDays(today, -spanDays(request.start, request.end)), end: today }
    case 'gdelt': return { ...request, start: shiftDays(today, -Math.min(89, spanDays(request.start, request.end))), end: today }
    case 'worldbank': {
      const endYear = now.getUTCFullYear()
      return { ...request, startYear: endYear - (request.endYear - request.startYear), endYear }
    }
    case 'imf': return request
    case 'comtrade': {
      const count = request.periods.length
      if (request.frequency === 'annual') {
        const latest = now.getUTCFullYear() - 1
        return { ...request, periods: Array.from({ length: count }, (_, index) => String(latest - count + 1 + index)) }
      }
      const months = Array.from({ length: count }, (_, index) => {
        const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - count + index, 1))
        return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}`
      })
      return { ...request, periods: months }
    }
    case 'commodity': {
      // Monthly series are small, so the window may grow, up to five years back.
      const floor = dayOf(new Date(Date.UTC(now.getUTCFullYear() - 5, now.getUTCMonth(), 1))).slice(0, 7)
      return { ...request, start: request.start < floor ? floor : request.start }
    }
    case 'tariff': {
      const latest = now.getUTCFullYear() - 2
      return { ...request, years: Array.from({ length: request.years.length }, (_, index) => latest - request.years.length + 1 + index) }
    }
  }
}

export async function refreshFeeds(input: Row): Promise<Row> {
  const refreshed: Row[] = []
  const failed: Row[] = []
  for (const subscription of listFeedSubscriptions(input).subscriptions as { id: string; request: FeedRequest }[]) {
    let request: FeedRequest
    try {
      request = normalizeFeedRequest(rollForward(subscription.request) as unknown as Row, feedNow())
    } catch (error) {
      failed.push({ subscriptionId: subscription.id, feed: subscription.request.feed, error: errorText(error) })
      continue
    }
    try {
      const result = await fetchFeed(request)
      const summary = recordFeedResult(input, result, { subscribe: true }) as { series: { newReadings: number; upstreamRevisionCount: number }[] }
      refreshed.push({ subscriptionId: subscription.id, feed: request.feed, title: result.title, newReadings: summary.series.reduce((sum, item) => sum + item.newReadings, 0), upstreamRevisions: summary.series.reduce((sum, item) => sum + item.upstreamRevisionCount, 0) })
    } catch (error) {
      recordFeedFailure(input, request, errorText(error))
      failed.push({ subscriptionId: subscription.id, feed: request.feed, error: errorText(error) })
    }
  }
  return { refreshed, failed }
}

/** Resolves every open rule question whose outcome the source has now published. Never guesses. */
export async function resolveDue(input: Row): Promise<Row> {
  const now = feedNow()
  const cache = new Map<string, Promise<FeedResult>>()
  const resolved: Row[] = []
  const pending: Row[] = []
  const errors: Row[] = []
  for (const question of openRuleQuestions(input)) {
    const plan = resolutionRequest(question.rule, now)
    if ('pending' in plan) {
      pending.push({ questionId: question.id, reason: plan.pending })
      continue
    }
    const cacheKey = JSON.stringify(plan.request)
    if (!cache.has(cacheKey)) cache.set(cacheKey, fetchFeed(plan.request))
    try {
      const result = await cache.get(cacheKey)!
      const evaluation = evaluateRule(question.rule, result, now)
      if (evaluation.status === 'pending') {
        pending.push({ questionId: question.id, reason: evaluation.reason })
        continue
      }
      const recorded = recordFeedResolution(input, question.id, evaluation, result)
      resolved.push({ questionId: question.id, question: question.question, outcome: evaluation.outcome, observedValue: evaluation.observedValue, observedPeriod: evaluation.observedPeriod, detail: evaluation.detail, resolutionId: recorded.resolutionId })
    } catch (error) {
      errors.push({ questionId: question.id, error: errorText(error) })
    }
  }
  return { resolved, pending, errors }
}

interface HistorySpec { key: string; frequency: FeedFrequency; request: FeedRequest | null; minimum: number }

/** Which stored series a rule's baseline reads, and the request that fills it when the store lacks history. */
function historySpec(rule: ResolutionRule, now: Date): HistorySpec | null {
  if ('start' in rule.observation) return null
  const s = rule.source
  const key = ruleSeriesKey(rule)
  const today = dayOf(now)
  if (s.feed === 'fx') return { key, frequency: 'daily', minimum: 60, request: normalizeFeedRequest({ feed: 'fx', base: s.base, quote: s.quote, start: dayOf(new Date(now.getTime() - 400 * DAY_MS)), end: today }, now) }
  if (s.feed === 'worldbank') return { key, frequency: 'annual', minimum: 5, request: normalizeFeedRequest({ feed: 'worldbank', country: s.country, indicator: s.indicator, startYear: now.getUTCFullYear() - 30, endYear: now.getUTCFullYear() }, now) }
  if (s.feed === 'commodity') return { key, frequency: 'monthly', minimum: 12, request: normalizeFeedRequest({ feed: 'commodity', commodities: [s.commodity], unit: s.unit, start: dayOf(new Date(now.getTime() - 36 * 31 * DAY_MS)).slice(0, 7) }, now) }
  if (s.feed === 'comtrade') {
    if (s.frequency === 'monthly') return { key, frequency: 'monthly', minimum: 8, request: null }
    const latest = now.getUTCFullYear() - 1
    return { key, frequency: 'annual', minimum: 5, request: normalizeFeedRequest({ feed: 'comtrade', reporter: s.reporter, partner: s.partner, hs: s.hs, flow: s.flow, frequency: 'annual', periods: Array.from({ length: 6 }, (_, index) => String(latest - 5 + index)) }, now) }
  }
  return null
}

function periodLabel(observedAt: string, frequency: FeedFrequency, key: string): string {
  if (frequency === 'daily') return observedAt.slice(0, 10)
  if (frequency === 'annual') return observedAt.slice(0, 4)
  // Commodity months are labelled 2026-08, Comtrade months 202608, matching each rule's own period format.
  return key.startsWith('commodity:') ? observedAt.slice(0, 7) : `${observedAt.slice(0, 4)}${observedAt.slice(5, 7)}`
}

function storedSeries(input: Row, spec: HistorySpec): { series: FeedSeries; latestEvidenceId: string | null } {
  const readings = readIndicatorReadings(input, spec.key)
  return {
    series: { key: spec.key, name: spec.key, unit: '', frequency: spec.frequency, higherIs: 'neutral', observations: readings.map((reading) => ({ period: periodLabel(reading.observedAt, spec.frequency, spec.key), observedAt: reading.observedAt, value: reading.value, status: 'actual' as const })) },
    latestEvidenceId: readings.at(-1)?.evidenceId ?? null,
  }
}

/** Computes and logs the baseline for one open rule question, pulling history into the store if it is short. */
export async function refreshBaseline(input: Row, questionId: string, rule: ResolutionRule): Promise<Row> {
  const now = feedNow()
  const spec = historySpec(rule, now)
  if (!spec) return { questionId, recorded: false, reason: 'no statistical baseline for window questions (max/min/mean over days)' }
  let stored = storedSeries(input, spec)
  if (stored.series.observations.length < spec.minimum && spec.request) {
    const result = await fetchFeed(spec.request)
    recordFeedResult(input, result, { subscribe: true })
    stored = storedSeries(input, spec)
  }
  const baseline = baselineForecast(rule, stored.series, now)
  if (!baseline || !stored.latestEvidenceId) return { questionId, recorded: false, reason: `not enough stored history in ${spec.key} for a baseline (${stored.series.observations.length} reading(s))` }
  return recordBaselineForecast(input, questionId, baseline, stored.latestEvidenceId)
}

export async function refreshBaselines(input: Row): Promise<Row[]> {
  const results: Row[] = []
  for (const question of openRuleQuestions(input)) {
    try {
      results.push(await refreshBaseline(input, question.id, question.rule))
    } catch (error) {
      results.push({ questionId: question.id, recorded: false, reason: errorText(error) })
    }
  }
  return results
}

/** Creates a rule-backed question and logs its baseline straight away, so the comparison starts at opening. */
export async function openRuleQuestion(input: Row): Promise<Row> {
  const created = JSON.parse(executeBattmannStoreAction({ ...input, action: 'create_question' })) as Row
  const rule = created.resolutionRule as ResolutionRule | undefined
  if (!rule) return created
  let baseline: Row
  try {
    baseline = await refreshBaseline(input, String(created.questionId), rule)
  } catch (error) {
    baseline = { recorded: false, reason: errorText(error) }
  }
  return { ...created, baseline }
}

/** One full monitoring pass: feeds, then resolutions, then baselines. */
export async function runMonitorPass(input: Row): Promise<Row> {
  const startedAt = new Date().toISOString()
  const feeds = await refreshFeeds(input)
  const resolutions = await resolveDue(input)
  const baselines = await refreshBaselines(input)
  return { startedAt, finishedAt: new Date().toISOString(), feeds, resolutions, baselines }
}
