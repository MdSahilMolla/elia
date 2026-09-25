import { expect, test } from 'bun:test'
import type { FeedResult, FeedSeries } from './feeds.ts'
import { baselineForecast, evaluateRule, forecastCutoff, normalCdf, resolutionRequest, validateResolutionRule } from './resolution.ts'

const NOW = new Date('2026-09-25T12:00:00Z')

function fxResult(rates: Record<string, number>): FeedResult {
  return {
    feed: 'fx', request: { feed: 'fx', base: 'USD', quotes: ['INR'], start: '2026-10-01', end: '2026-10-30' }, publisher: 'ECB', title: 't', sourceUrls: ['https://api.frankfurter.dev/v1/x'],
    retrievedAt: NOW.toISOString(), sourceUpdatedAt: null, responseSha256: 'a'.repeat(64), reliability: 0.98, notes: [],
    series: [{ key: 'fx:USD:INR', name: 'USD/INR', unit: 'INR per USD', frequency: 'daily', higherIs: 'neutral', observations: Object.entries(rates).map(([period, value]) => ({ period, observedAt: `${period}T00:00:00.000Z`, value, status: 'actual' as const })) }],
  }
}

const fxRule = (period: string, threshold = 96.5) => validateResolutionRule({ source: { feed: 'fx', base: 'usd', quote: 'inr' }, observation: { period }, comparator: '>', threshold }, NOW)

test('rules are validated, normalised, and must be about a period not yet observable', () => {
  expect(fxRule('2026-10-30')).toEqual({ source: { feed: 'fx', base: 'USD', quote: 'INR' }, observation: { period: '2026-10-30' }, comparator: '>', threshold: 96.5 })
  expect(() => fxRule('2026-09-20')).toThrow('closed')
  expect(() => validateResolutionRule({ source: { feed: 'imf', country: 'IND', indicator: 'NGDP_RPCH' }, observation: { period: '2027' }, comparator: '>', threshold: 6 }, NOW)).toThrow('IMF WEO values are projections')
  expect(() => validateResolutionRule({ source: { feed: 'comtrade', reporter: 'IND', partner: 'ALL', hs: '8542', flow: 'import', frequency: 'annual' }, observation: { period: '2026' }, comparator: '>', threshold: 1 }, NOW)).toThrow('one partner')
  expect(() => validateResolutionRule({ source: { feed: 'fx', base: 'USD', quote: 'INR' }, observation: { period: '2026-10-30' }, comparator: '==', threshold: 1 }, NOW)).toThrow('comparator')
  // An annual total stays forecastable until the year ends; a daily value only until its day starts.
  const annual = validateResolutionRule({ source: { feed: 'comtrade', reporter: 'IND', partner: 'CHN', hs: '8542', flow: 'import', frequency: 'annual' }, observation: { period: '2026' }, comparator: '>', threshold: 1e10 }, NOW)
  expect(forecastCutoff(annual)).toBe('2027-01-01T00:00:00.000Z')
  expect(forecastCutoff(fxRule('2026-10-30'))).toBe('2026-10-30T00:00:00.000Z')
})

test('evaluation reads the exact published value, and never resolves early', () => {
  const rule = fxRule('2026-10-30')
  expect('pending' in resolutionRequest(rule, new Date('2026-10-30T12:00:00Z'))).toBe(true)
  expect(evaluateRule(rule, fxResult({ '2026-10-29': 97 }), new Date('2026-10-31T09:00:00Z'))).toEqual({ status: 'pending', reason: 'the source has not published a value for 2026-10-30 yet' })
  expect(evaluateRule(rule, fxResult({ '2026-10-29': 97, '2026-10-30': 96.4 }), new Date('2026-10-31T09:00:00Z'))).toMatchObject({ status: 'resolved', outcome: 0, observedValue: 96.4 })
})

test('a day with no ECB publication falls back to the latest earlier rate once it has settled', () => {
  const saturday = fxRule('2026-10-31')
  expect(evaluateRule(saturday, fxResult({ '2026-10-30': 96.6 }), new Date('2026-11-01T12:00:00Z')).status).toBe('pending')
  expect(evaluateRule(saturday, fxResult({ '2026-10-30': 96.6 }), new Date('2026-11-04T12:00:00Z'))).toMatchObject({ status: 'resolved', outcome: 1, observedPeriod: '2026-10-30' })
})

test('window rules aggregate the days inside the window', () => {
  const rule = validateResolutionRule({ source: { feed: 'fx', base: 'USD', quote: 'INR' }, observation: { start: '2026-10-05', end: '2026-10-09', aggregate: 'max' }, comparator: '>=', threshold: 97 }, NOW)
  expect(evaluateRule(rule, fxResult({ '2026-10-02': 99, '2026-10-05': 96, '2026-10-07': 97, '2026-10-12': 99 }), new Date('2026-10-20T00:00:00Z'))).toMatchObject({ status: 'resolved', outcome: 1, observedValue: 97 })
  expect(baselineForecast(rule, fxResult({}).series[0], NOW)).toBeNull()
})

test('the random-walk baseline is centred on the current value and falls off with distance', () => {
  const observations: FeedSeries['observations'] = []
  for (let i = 0; i < 260; i++) {
    const period = new Date(Date.UTC(2025, 8, 1) + i * 86_400_000).toISOString().slice(0, 10)
    observations.push({ period, observedAt: `${period}T00:00:00.000Z`, value: 95 * Math.exp(0.002 * Math.sin(i)), status: 'actual' })
  }
  const series: FeedSeries = { key: 'fx:USD:INR', name: 'USD/INR', unit: 'INR', frequency: 'daily', higherIs: 'neutral', observations }
  const last = observations.at(-1)!.value
  const atMoney = baselineForecast(fxRule('2026-10-30', last), series, NOW)!
  const farAbove = baselineForecast(fxRule('2026-10-30', last * 1.1), series, NOW)!
  expect(atMoney.probability).toBeCloseTo(0.5, 1)
  expect(farAbove.probability).toBe(0.01)
  expect(atMoney.method).toBe('baseline:random-walk')
  expect(normalCdf(0)).toBeCloseTo(0.5, 6)
  expect(normalCdf(1.96)).toBeCloseTo(0.975, 3)
})

test('the empirical-change baseline counts how often history would cross the threshold', () => {
  const values = [10, 11, 12, 13, 14, 15]
  const series: FeedSeries = { key: 'comtrade:IND:import:8542:WLD:annual', name: 'imports', unit: 'USD', frequency: 'annual', higherIs: 'neutral', observations: values.map((value, index) => ({ period: String(2020 + index), observedAt: `${2020 + index}-12-31T00:00:00.000Z`, value, status: 'actual' as const })) }
  const rule = validateResolutionRule({ source: { feed: 'comtrade', reporter: 'IND', partner: 'WLD', hs: '8542', flow: 'import', frequency: 'annual' }, observation: { period: '2026' }, comparator: '>', threshold: 15.5 }, NOW)
  // Every one of the five one-year changes was +1, so all would clear 15.5: (5 + 0.5) / 6.
  expect(baselineForecast(rule, series, NOW)!.probability).toBe(0.9167)
})
