import { gdeltSeriesKey, normalizeFeedRequest, periodEnd, type FeedRequest, type FeedResult, type FeedSeries } from './feeds.ts'

/**
 * Machine-checkable resolution rules. A question that carries one is resolved by code from a feed — never by a
 * model's say-so — which is what makes its forecasts count toward the certified track record.
 *
 * A rule names a series, the period (or window) whose value decides the question, a comparator and a
 * threshold. The rule also fixes the forecasting cutoff: the instant after which the outcome could be partly
 * observed, so no forecast may be logged after it.
 */

export type Comparator = '>' | '>=' | '<' | '<='
export type Aggregate = 'max' | 'min' | 'mean'

export interface ResolutionRule {
  source: RuleSource
  observation: { period: string } | { start: string; end: string; aggregate: Aggregate }
  comparator: Comparator
  threshold: number
}

/** The feed request minus its window; the window comes from the observation at resolution time. */
export type RuleSource =
  | { feed: 'fx'; base: string; quote: string }
  | { feed: 'worldbank'; country: string; indicator: string }
  | { feed: 'comtrade'; reporter: string; partner: string; hs: string; flow: 'import' | 'export'; frequency: 'annual' | 'monthly' }
  | { feed: 'gdelt'; query: string; measure: 'count' | 'share' }
  | { feed: 'commodity'; commodity: string; unit: 'USD' | 'IX' }

type Raw = Record<string, unknown>
const DAY_MS = 86_400_000
const COMPARATORS: Comparator[] = ['>', '>=', '<', '<=']

/** How long after a daily observation date an absent value is treated as "no publication that day". */
const FX_SETTLE_DAYS = 3

export function validateResolutionRule(raw: unknown, now: Date = new Date()): ResolutionRule {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('resolutionRule must be an object')
  const rule = raw as Raw
  const sourceRaw = (rule.source && typeof rule.source === 'object' ? rule.source : rule) as Raw
  const comparator = rule.comparator as Comparator
  if (!COMPARATORS.includes(comparator)) throw new Error(`resolutionRule.comparator must be one of ${COMPARATORS.join(' ')}`)
  if (typeof rule.threshold !== 'number' || !Number.isFinite(rule.threshold)) throw new Error('resolutionRule.threshold must be a finite number')
  const observationRaw = rule.observation && typeof rule.observation === 'object' ? rule.observation as Raw : rule
  let source: RuleSource
  let observation: ResolutionRule['observation']
  if (sourceRaw.feed === 'fx') {
    const probe = normalizeFeedRequest({ feed: 'fx', base: sourceRaw.base, quote: sourceRaw.quote, start: '2000-01-01', end: '2000-01-02' }, now) as Extract<FeedRequest, { feed: 'fx' }>
    source = { feed: 'fx', base: probe.base, quote: probe.quotes[0]! }
    observation = dailyObservation(observationRaw)
  } else if (sourceRaw.feed === 'worldbank') {
    const probe = normalizeFeedRequest({ feed: 'worldbank', country: sourceRaw.country, indicator: sourceRaw.indicator, startYear: 2000, endYear: 2000 }, now) as Extract<FeedRequest, { feed: 'worldbank' }>
    source = { feed: 'worldbank', country: probe.country, indicator: probe.indicator }
    const period = String(observationRaw.period ?? '')
    if (!/^\d{4}$/.test(period)) throw new Error('a worldbank rule observes one year: observation.period like "2026"')
    observation = { period }
  } else if (sourceRaw.feed === 'comtrade') {
    const frequency = sourceRaw.frequency === 'monthly' ? 'monthly' : 'annual'
    const period = String(observationRaw.period ?? '')
    const probe = normalizeFeedRequest({ feed: 'comtrade', reporter: sourceRaw.reporter, partner: sourceRaw.partner ?? 'WLD', hs: sourceRaw.hs, flow: sourceRaw.flow, frequency, periods: [period] }, now) as Extract<FeedRequest, { feed: 'comtrade' }>
    if (probe.partner === 'ALL') throw new Error('a comtrade rule needs one partner (an ISO code, or WLD for the world total), not ALL')
    source = { feed: 'comtrade', reporter: probe.reporter, partner: probe.partner, hs: probe.hs, flow: probe.flow, frequency }
    observation = { period: probe.periods[0]! }
  } else if (sourceRaw.feed === 'gdelt') {
    const query = typeof sourceRaw.query === 'string' ? sourceRaw.query.trim() : ''
    if (query.length < 2 || query.length > 300) throw new Error('a gdelt rule needs a query of 2-300 characters')
    const measure = sourceRaw.measure === 'share' ? 'share' : 'count'
    source = { feed: 'gdelt', query, measure }
    const window = dailyObservation(observationRaw)
    if (!('start' in window)) throw new Error('a gdelt rule observes a window: observation { start, end, aggregate }')
    if (Date.parse(window.end) - Date.parse(window.start) > 60 * DAY_MS) throw new Error('a gdelt window may span at most 60 days, so it can be read back within GDELT\'s 90-day range')
    observation = window
  } else if (sourceRaw.feed === 'commodity') {
    const probe = normalizeFeedRequest({ feed: 'commodity', commodity: sourceRaw.commodity, unit: sourceRaw.unit }, now) as Extract<FeedRequest, { feed: 'commodity' }>
    source = { feed: 'commodity', commodity: probe.commodities[0]!, unit: probe.unit }
    const period = String(observationRaw.period ?? '')
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new Error('a commodity rule observes one month\'s average: observation.period like "2026-11"')
    observation = { period }
  } else {
    throw new Error('resolutionRule.source.feed must be fx, worldbank, comtrade, commodity, or gdelt (IMF WEO values are projections and cannot resolve a question)')
  }
  const result: ResolutionRule = { source, observation, comparator, threshold: rule.threshold }
  if (Date.parse(forecastCutoff(result)) <= now.getTime()) throw new Error(`forecasting on this outcome closed at ${forecastCutoff(result)}; a resolution rule must be about a period that is not yet observable`)
  return result
}

function dailyObservation(raw: Raw): ResolutionRule['observation'] {
  const day = (value: unknown, name: string) => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`))) throw new Error(`${name} must be a date like 2026-10-30`)
    return value
  }
  if (raw.start !== undefined || raw.end !== undefined) {
    const start = day(raw.start, 'observation.start')
    const end = day(raw.end, 'observation.end')
    if (start > end) throw new Error('observation.start must not be after observation.end')
    const aggregate = raw.aggregate as Aggregate
    if (!['max', 'min', 'mean'].includes(aggregate)) throw new Error('observation.aggregate must be max, min, or mean')
    return { start, end, aggregate }
  }
  return { period: day(raw.period ?? raw.date, 'observation.period') }
}

/** The last instant the observation covers. */
export function observationEnd(rule: ResolutionRule): string {
  if ('start' in rule.observation) return `${rule.observation.end}T23:59:59.999Z`
  const { period } = rule.observation
  if (/^\d{4}-\d{2}-\d{2}$/.test(period)) return `${period}T23:59:59.999Z`
  return new Date(Date.parse(periodEnd(period)) + DAY_MS - 1).toISOString()
}

/**
 * The latest instant a forecast may be logged: before any part of the outcome can be observed. A daily value
 * or a window is partly observable from its first day; an annual or monthly total is not known until it is
 * published, so forecasting stays open until the period ends.
 */
export function forecastCutoff(rule: ResolutionRule): string {
  if ('start' in rule.observation) return `${rule.observation.start}T00:00:00.000Z`
  const { period } = rule.observation
  if (/^\d{4}-\d{2}-\d{2}$/.test(period)) return `${period}T00:00:00.000Z`
  // A monthly average of daily market prices is partly observable from its first trading day.
  if (rule.source.feed === 'commodity') return `${period}-01T00:00:00.000Z`
  return new Date(Date.parse(periodEnd(period)) + DAY_MS).toISOString()
}

export function describeRule(rule: ResolutionRule): string {
  const target = 'start' in rule.observation ? `the ${rule.observation.aggregate} daily value between ${rule.observation.start} and ${rule.observation.end}` : `the value for ${rule.observation.period}`
  const source = rule.source.feed === 'fx' ? `the ECB ${rule.source.base}/${rule.source.quote} reference rate`
    : rule.source.feed === 'worldbank' ? `World Bank indicator ${rule.source.indicator} for ${rule.source.country}`
      : rule.source.feed === 'comtrade' ? `UN Comtrade ${rule.source.reporter} ${rule.source.flow}s of HS ${rule.source.hs} ${rule.source.flow === 'import' ? 'from' : 'to'} ${rule.source.partner} (${rule.source.frequency}, USD)`
        : rule.source.feed === 'commodity' ? `the IMF monthly average for commodity ${rule.source.commodity} (${rule.source.unit})`
          : `GDELT daily ${rule.source.measure === 'share' ? 'coverage share' : 'article count'} for "${rule.source.query}"`
  return `Resolves YES if ${target} of ${source} is ${rule.comparator} ${rule.threshold}, as fetched by code from the source; otherwise NO.`
}

/** The feed request that reads the observation back, or a pending reason when it cannot be read yet. */
export function resolutionRequest(rule: ResolutionRule, now: Date): { request: FeedRequest } | { pending: string } {
  const end = Date.parse(observationEnd(rule))
  if (now.getTime() <= end) return { pending: `the observation period has not ended (ends ${new Date(end).toISOString()})` }
  const s = rule.source
  if (s.feed === 'fx') {
    const { start, end: last } = 'start' in rule.observation ? rule.observation : { start: shiftDay(rule.observation.period, -7), end: rule.observation.period }
    return { request: normalizeFeedRequest({ feed: 'fx', base: s.base, quote: s.quote, start, end: last }, now) }
  }
  if (s.feed === 'worldbank') {
    const period = Number((rule.observation as { period: string }).period)
    return { request: normalizeFeedRequest({ feed: 'worldbank', country: s.country, indicator: s.indicator, startYear: period, endYear: period }, now) }
  }
  if (s.feed === 'commodity') {
    const period = (rule.observation as { period: string }).period
    return { request: normalizeFeedRequest({ feed: 'commodity', commodity: s.commodity, unit: s.unit, start: period }, now) }
  }
  if (s.feed === 'comtrade') return { request: normalizeFeedRequest({ feed: 'comtrade', reporter: s.reporter, partner: s.partner, hs: s.hs, flow: s.flow, frequency: s.frequency, periods: [(rule.observation as { period: string }).period] }, now) }
  const window = rule.observation as { start: string; end: string }
  return { request: normalizeFeedRequest({ feed: 'gdelt', query: s.query, start: window.start, end: window.end }, now) }
}

export type Evaluation =
  | { status: 'resolved'; outcome: 0 | 1; observedValue: number; observedPeriod: string; detail: string }
  | { status: 'pending'; reason: string }

/** The indicator id the rule's series is recorded under in the store. */
export function ruleSeriesKey(rule: ResolutionRule): string {
  const s = rule.source
  if (s.feed === 'fx') return `fx:${s.base}:${s.quote}`
  if (s.feed === 'worldbank') return `wb:${s.country}:${s.indicator}`
  if (s.feed === 'comtrade') return `comtrade:${s.reporter}:${s.flow}:${s.hs}:${s.partner}:${s.frequency}`
  if (s.feed === 'commodity') return `commodity:${s.commodity}:${s.unit}`
  return gdeltSeriesKey(s.query, s.measure)
}

export function ruleSeries(rule: ResolutionRule, result: FeedResult): FeedSeries | undefined {
  return result.series.find((series) => series.key === ruleSeriesKey(rule))
}

/** Decides a rule from a feed result. Never guesses: anything short of the observed value is pending. */
export function evaluateRule(rule: ResolutionRule, result: FeedResult, now: Date): Evaluation {
  const series = ruleSeries(rule, result)
  const actual = (series?.observations ?? []).filter((item) => item.status === 'actual')
  const decide = (value: number, period: string, detail: string): Evaluation => ({ status: 'resolved', outcome: compare(value, rule.comparator, rule.threshold) ? 1 : 0, observedValue: value, observedPeriod: period, detail })
  if ('start' in rule.observation) {
    const { start, end, aggregate } = rule.observation
    const values = actual.filter((item) => item.period >= start && item.period <= end)
    if (!values.length) return { status: 'pending', reason: `the source returned no values between ${start} and ${end}` }
    const numbers = values.map((item) => item.value)
    const value = aggregate === 'max' ? Math.max(...numbers) : aggregate === 'min' ? Math.min(...numbers) : numbers.reduce((sum, item) => sum + item, 0) / numbers.length
    return decide(Number(value.toFixed(6)), `${start}..${end}`, `${aggregate} of ${values.length} daily value(s) between ${start} and ${end}`)
  }
  const { period } = rule.observation
  const exact = actual.find((item) => item.period === period)
  if (exact) return decide(exact.value, period, `value published for ${period}`)
  if (rule.source.feed === 'fx' && now.getTime() >= Date.parse(`${period}T00:00:00Z`) + FX_SETTLE_DAYS * DAY_MS) {
    const earlier = actual.filter((item) => item.period < period).at(-1)
    if (earlier) return decide(earlier.value, earlier.period, `the ECB published no rate on ${period}; the latest earlier reference rate (${earlier.period}) applies`)
  }
  return { status: 'pending', reason: `the source has not published a value for ${period} yet` }
}

function compare(value: number, comparator: Comparator, threshold: number): boolean {
  if (comparator === '>') return value > threshold
  if (comparator === '>=') return value >= threshold
  if (comparator === '<') return value < threshold
  return value <= threshold
}

function shiftDay(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------
// The no-skill baseline
// ---------------------------------------------------------------------------

export interface Baseline { probability: number; method: string; rationale: string }

/**
 * A deterministic statistical baseline for a rule question, computed from the series' own history. A system
 * forecast only shows skill if it beats this on the same questions.
 *
 * - A daily point value (FX) uses a driftless random walk in log space with volatility from up to 250 recent
 *   daily log returns.
 * - An annual or monthly value uses the empirical distribution of the series' own h-step changes, applied to
 *   the latest value (h = periods between the latest value and the target), with add-half smoothing.
 * - Windows (max/min/mean over days) get no baseline; the result is null rather than a made-up number.
 */
export function baselineForecast(rule: ResolutionRule, series: FeedSeries | undefined, now: Date): Baseline | null {
  if (!series || 'start' in rule.observation) return null
  const actual = series.observations.filter((item) => item.status === 'actual' && Date.parse(item.observedAt) <= now.getTime())
  if (actual.length < 4) return null
  const last = actual[actual.length - 1]!
  const target = rule.observation.period
  if (series.frequency === 'daily') {
    if (!(last.value > 0) || !(rule.threshold > 0)) return null
    const returns = actual.slice(-251).map((item) => Math.log(item.value)).flatMap((value, index, logs) => (index ? [value - logs[index - 1]!] : []))
    if (returns.length < 20) return null
    const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length
    const sigma = Math.sqrt(returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1))
    const calendarDays = Math.max(1, (Date.parse(`${target}T00:00:00Z`) - Date.parse(`${last.period}T00:00:00Z`)) / DAY_MS)
    const steps = Math.max(1, Math.round(calendarDays * 5 / 7))
    const z = (Math.log(rule.threshold) - Math.log(last.value)) / (sigma * Math.sqrt(steps))
    const above = 1 - normalCdf(z)
    const probability = clamp(rule.comparator === '>' || rule.comparator === '>=' ? above : 1 - above)
    return {
      probability,
      method: 'baseline:random-walk',
      rationale: `Driftless random walk in log space from ${last.value} on ${last.period}; daily log-return sd ${sigma.toFixed(5)} over ${returns.length} returns; ${steps} business day(s) to ${target}; P(${rule.comparator} ${rule.threshold}) = ${probability}.`,
    }
  }
  const steps = periodsBetween(last.period, target, series.frequency)
  if (steps < 1) return null
  const changes: number[] = []
  for (let index = steps; index < actual.length; index++) changes.push(actual[index]!.value - actual[index - steps]!.value)
  if (changes.length < 3) return null
  const hits = changes.filter((change) => compare(last.value + change, rule.comparator, rule.threshold)).length
  const probability = clamp((hits + 0.5) / (changes.length + 1))
  return {
    probability,
    method: 'baseline:empirical-change',
    rationale: `Latest ${series.name} is ${last.value} for ${last.period}; ${hits} of ${changes.length} historical ${steps}-period changes would put it ${rule.comparator} ${rule.threshold} by ${target}; add-half smoothing gives ${probability}.`,
  }
}

function periodsBetween(from: string, to: string, frequency: FeedSeries['frequency']): number {
  const index = (period: string) => {
    const annual = /^(\d{4})$/.exec(period)
    if (annual) return frequency === 'annual' ? Number(annual[1]) : Number(annual[1]) * 12 + 11
    const month = /^(\d{4})-?M?(\d{2})$/.exec(period)
    if (month) return frequency === 'annual' ? Number(month[1]) : Number(month[1]) * 12 + Number(month[2]) - 1
    return Number.NaN
  }
  const steps = index(to) - index(from)
  return Number.isFinite(steps) ? steps : 0
}

function clamp(probability: number): number {
  return Number(Math.min(0.99, Math.max(0.01, probability)).toFixed(4))
}

/** Standard normal CDF via the Abramowitz-Stegun 7.1.26 erf approximation (error under 1.5e-7). */
export function normalCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2
  const t = 1 / (1 + 0.3275911 * x)
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x)
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2
}
