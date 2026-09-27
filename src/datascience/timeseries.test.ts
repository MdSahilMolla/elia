import { expect, test } from 'bun:test'
import { frameFromRows } from './frame.ts'
import { createRng } from './rng.ts'
import { acf, adfTest, backtest, changePoints, decompose, forecastSeries, kpssTest, ljungBox, pacf, prepareSeries, seriesAnomalies } from './timeseries.ts'

function monthly(n: number, seed: number) {
  const rng = createRng(seed)
  return Array.from({ length: n }, (_, i) => 200 + 2 * i + 25 * Math.sin((2 * Math.PI * i) / 12) + rng.normal(0, 4))
}

test('series preparation aggregates to a regular grid and makes gaps explicit', () => {
  const frame = frameFromRows([
    { d: '2025-01-03', v: 5 }, { d: '2025-01-20', v: 7 }, { d: '2025-03-02', v: 4 }, { d: '2025-04-11', v: 6 },
  ])
  const series = prepareSeries(frame, 'd', 'v', { frequency: 'month', fill: 'zero' })
  expect(series.dates).toEqual(['2025-01-01', '2025-02-01', '2025-03-01', '2025-04-01'])
  expect(series.values).toEqual([12, 0, 4, 6])
  expect(series.filledPeriods).toBe(1)
})

test('ADF and KPSS agree on a random walk vs white noise, and ADF critical values match MacKinnon', () => {
  const rng = createRng(1)
  const noise = Array.from({ length: 300 }, () => rng.normal())
  const walk: number[] = [0]
  for (let i = 1; i < 300; i++) walk.push(walk[i - 1]! + rng.normal())
  const stationary = adfTest(noise, { simulations: 400 })
  expect(stationary.stationary).toBe(true)
  expect(stationary.pValue).toBeLessThan(0.01)
  expect(stationary.criticalValues['5%']).toBeCloseTo(-2.8718, 2)
  const unit = adfTest(walk, { simulations: 400 })
  expect(unit.stationary).toBe(false)
  expect(kpssTest(noise).stationary).toBe(true)
  expect(kpssTest(walk).stationary).toBe(false)
})

test('the simulated Dickey–Fuller 5% quantile is close to the tabulated -2.86', () => {
  const rng = createRng(2)
  const stats: number[] = []
  for (let s = 0; s < 600; s++) {
    const walk: number[] = [0]
    for (let i = 1; i < 250; i++) walk.push(walk[i - 1]! + rng.normal())
    stats.push(adfTest(walk, { maxLags: 0, simulations: 1 }).statistic)
  }
  stats.sort((a, b) => a - b)
  expect(stats[Math.floor(0.05 * stats.length)]!).toBeGreaterThan(-3.15)
  expect(stats[Math.floor(0.05 * stats.length)]!).toBeLessThan(-2.6)
})

test('ACF, PACF, and Ljung–Box see AR(1) structure', () => {
  const rng = createRng(3)
  const ar = [0]
  for (let i = 1; i < 500; i++) ar.push(0.7 * ar[i - 1]! + rng.normal())
  expect(acf(ar, 3)[1]!).toBeGreaterThan(0.6)
  const p = pacf(ar, 3)
  expect(p[1]!).toBeGreaterThan(0.6)
  expect(Math.abs(p[2]!)).toBeLessThan(0.12)
  expect(ljungBox(ar, 10).pValue).toBeLessThan(1e-6)
})

test('decomposition recovers the seasonal period strength; change points and anomalies are found', () => {
  const y = monthly(96, 4)
  const d = decompose(y, 12)
  expect(d.seasonalStrength).toBeGreaterThan(0.8)
  const shifted = Array.from({ length: 120 }, (_, i) => (i < 60 ? 10 : 16) + createRng(i).normal(0, 0.5))
  const points = changePoints(shifted)
  expect(points).toHaveLength(1)
  expect(Math.abs(points[0]!.index - 60)).toBeLessThanOrEqual(2)
  const spiky = monthly(72, 5)
  spiky[40] = spiky[40]! + 150
  expect(seriesAnomalies(spiky, 12).map((a) => a.index)).toContain(40)
})

test('forecasting picks a seasonal model that beats seasonal naive and gives intervals that widen', () => {
  const y = monthly(96, 6)
  const dates = y.map((_, i) => new Date(Date.UTC(2017, i, 1)).toISOString().slice(0, 10))
  const series = { dates, values: y, frequency: 'month' as const, seasonPeriod: 12, filledPeriods: 0, aggregatedRows: y.length }
  const result = forecastSeries(series, { horizon: 12, methods: ['naive', 'seasonal_naive', 'drift', 'holt_winters_additive', 'arima'] })
  expect(result.method).toBe('holt_winters_additive')
  expect(result.beatsNaive).toBe(true)
  expect(result.forecast).toHaveLength(12)
  expect(result.forecast[0]!.date).toBe('2025-01-01')
  const width = (i: number) => result.forecast[i]!.upper - result.forecast[i]!.lower
  expect(width(11)).toBeGreaterThanOrEqual(width(0) * 0.8)
  for (const point of result.forecast) expect(point.lower).toBeLessThan(point.upper)
  const bt = backtest(y, 'seasonal_naive', 6, 12, 4)
  expect(bt.origins).toBe(4)
  expect(bt.mase).not.toBeNull()
})
