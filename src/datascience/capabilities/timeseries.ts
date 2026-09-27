import { compileExpression } from '../expr.ts'
import { registerCapability, type ActionContext } from '../engine.ts'
import { assertColumns, frameFromRows } from '../frame.ts'
import { acf, advance, adfTest, changePoints, decompose, FORECAST_METHODS, forecastSeries, kpssTest, ljungBox, pacf, prepareSeries, seriesAnomalies, type ForecastMethod, type Frequency } from '../timeseries.ts'
import { lineChart } from '../viz.ts'
import { refOf } from '../workspace.ts'
import { toDateMs } from '../values.ts'
import { DATASET, outputName, saveChart, SEED, str, WHERE } from './common.ts'

const SERIES_PARAMS = {
  dataset: DATASET,
  time: { type: 'string', required: true, description: 'date/timestamp column' },
  value: { type: 'string', required: true, description: 'numeric column (ignored when aggregate is "count")' },
  frequency: { type: 'string', enum: ['hour', 'day', 'week', 'month', 'quarter', 'year'], description: 'regular grid to aggregate to (default inferred)' },
  aggregate: { type: 'string', enum: ['sum', 'mean', 'last', 'count'], description: 'how rows in the same period combine (default sum)' },
  fill: { type: 'string', enum: ['zero', 'interpolate', 'none'], description: 'periods with no rows: zero (true absence), interpolate (default), or none' },
  where: WHERE,
} as const

function series(ctx: ActionContext) {
  const { entry, frame } = ctx.dataset(str(ctx, 'dataset'), { where: '' })
  const time = str(ctx, 'time')
  const value = str(ctx, 'value')
  assertColumns(frame, [time, ...(ctx.params.aggregate === 'count' ? [] : [value])], 'series')
  const where = typeof ctx.params.where === 'string' ? compileExpression(ctx.params.where, frame.columns) : undefined
  if (where) ctx.record.code('expression', `where ${where.source}`)
  const s = prepareSeries(frame, time, value, { ...(ctx.params.frequency ? { frequency: ctx.params.frequency as Frequency } : {}), ...(ctx.params.aggregate ? { aggregate: ctx.params.aggregate as 'sum' } : {}), ...(ctx.params.fill ? { fill: ctx.params.fill as 'zero' } : {}), ...(where ? { where: (row) => where.test(row as never) } : {}) })
  ctx.record.check('regular series', s.filledPeriods / s.dates.length > 0.2 ? 'warn' : 'pass', `${s.dates.length} ${s.frequency} periods from ${s.dates[0]} to ${s.dates.at(-1)}; ${s.filledPeriods} periods had no rows (${ctx.params.fill ?? 'interpolate'}d)`)
  const last = s.dates.at(-1)!
  // A period that has not ended yet is partial by construction; reading its dip as a decline is a classic error.
  if (advance(toDateMs(last)!, s.frequency) > Date.now()) ctx.record.check('latest period is still in progress', 'warn', `the last period (${last}) has not ended yet, so its total is partial — exclude it or compare like-for-like days`)
  return { entry, series: s }
}

registerCapability({
  tool: 'ds_timeseries',
  action: 'analyze',
  summary: 'time-series diagnostics: regular grid, trend/seasonal strength (decomposition), stationarity (ADF + KPSS), ACF/PACF, Ljung–Box, change points, and anomalies, with a chart',
  effect: 'compute',
  params: { ...SERIES_PARAMS, period: { type: 'integer', description: 'seasonal period (default by frequency: 7 daily, 12 monthly, 4 quarterly, 52 weekly)' }, lags: { type: 'integer', description: 'ACF/PACF lags (default 2 seasons, max 48)' }, seed: SEED },
  run(ctx) {
    const { entry, series: s } = series(ctx)
    const y = s.values.map((v) => v ?? 0)
    const period = typeof ctx.params.period === 'number' ? ctx.params.period : s.seasonPeriod
    const lags = Math.min(48, typeof ctx.params.lags === 'number' ? ctx.params.lags : Math.max(10, 2 * period), Math.floor(y.length / 2))
    const result: Record<string, unknown> = { dataset: refOf(entry), frequency: s.frequency, periods: y.length, from: s.dates[0], to: s.dates.at(-1), filledPeriods: s.filledPeriods }
    if (period >= 2 && y.length >= 2 * period) {
      const d = decompose(y, period, y.every((v) => v > 0) ? 'multiplicative' : 'additive')
      result.decomposition = { model: d.model, period, seasonalStrength: d.seasonalStrength, trendStrength: d.trendStrength, seasonalProfile: d.seasonal.slice(0, period) }
    } else result.decomposition = `needs at least two full seasons (${2 * period} periods) for period ${period}`
    if (y.length >= 20) {
      const seed = typeof ctx.params.seed === 'number' ? ctx.params.seed : 42
      ctx.record.seed(seed)
      const adf = adfTest(y, { seed, simulations: 500 })
      const kpss = kpssTest(y)
      result.stationarity = { adf, kpss, verdict: adf.stationary && kpss.stationary ? 'stationary' : !adf.stationary && !kpss.stationary ? 'non-stationary (difference or detrend before ARIMA-type modelling)' : 'inconclusive (the tests disagree; often trend-stationary or a structural break)' }
      ctx.record.check('stationarity tests', 'pass', `ADF p = ${adf.pValue.toFixed(3)}, KPSS p ${kpss.pValueBound.includes('limit') ? kpss.pValueBound : `= ${kpss.pValue.toFixed(3)}`}`)
    }
    result.acf = acf(y, lags).map((v, i) => ({ lag: i, value: v })).slice(1)
    result.pacf = pacf(y, lags).map((v, i) => ({ lag: i, value: v })).slice(1)
    result.confidenceBand = 1.96 / Math.sqrt(y.length)
    result.ljungBox = ljungBox(y, Math.min(lags, 20))
    const points = changePoints(y)
    result.changePoints = points.map((p) => ({ date: s.dates[p.index], before: p.before, after: p.after, shift: p.shift }))
    const anomalies = seriesAnomalies(y, period)
    result.anomalies = anomalies.map((a) => ({ date: s.dates[a.index], value: a.value, expected: a.expected, robustZ: a.robustZ }))
    result.chart = saveChart(ctx, lineChart({ title: `${str(ctx, 'value')} (${s.frequency})`, subtitle: `${entry.name}; ${points.length} change point(s), ${anomalies.length} anomal${anomalies.length === 1 ? 'y' : 'ies'}`, x: s.dates, series: [{ name: str(ctx, 'value'), values: y }], markers: y.length <= 60 }))
    ctx.record.check('diagnostics computed', 'pass', `${y.length} periods`)
    return result
  },
})

registerCapability({
  tool: 'ds_timeseries',
  action: 'forecast',
  summary: `forecast with model comparison by rolling-origin backtest (MASE/MAE/RMSE/sMAPE) and empirical prediction intervals. Methods: ${FORECAST_METHODS.join(', ')}`,
  effect: 'local-write',
  params: { ...SERIES_PARAMS, horizon: { type: 'integer', required: true, description: 'periods ahead' }, methods: { type: 'array', description: 'candidate methods (default: naive, seasonal_naive, drift, ses, holt_damped, holt_winters_additive/multiplicative, arima, gbm_lags)' }, level: { type: 'number', description: 'prediction-interval level (default 0.9)' }, origins: { type: 'integer', description: 'backtest origins (default up to 12)' }, nonNegative: { type: 'boolean', description: 'clip forecasts and intervals at zero (counts, revenue)' }, output: { type: 'string', description: 'dataset for the forecast table' }, seed: SEED },
  example: { action: 'forecast', dataset: 'orders', time: 'order_date', value: 'amount', frequency: 'month', horizon: 12, nonNegative: true },
  run(ctx) {
    const { entry, series: s } = series(ctx)
    const seed = typeof ctx.params.seed === 'number' ? ctx.params.seed : 42
    ctx.record.seed(seed)
    const horizon = Number(ctx.params.horizon)
    const result = forecastSeries(s, { horizon, seed, ...(Array.isArray(ctx.params.methods) ? { methods: ctx.params.methods as ForecastMethod[] } : {}), ...(typeof ctx.params.level === 'number' ? { level: ctx.params.level } : {}), ...(typeof ctx.params.origins === 'number' ? { origins: ctx.params.origins } : {}), ...(ctx.params.nonNegative === true ? { nonNegative: true } : {}) })
    const best = result.leaderboard.find((row) => row.method === result.method)!
    ctx.record.check('backtest origins', best.origins >= 3 ? 'pass' : 'warn', `${best.origins} rolling origins${best.origins < 3 ? ' — too few to trust the comparison' : ''}`)
    ctx.record.check('beats naive baseline', result.beatsNaive === false ? 'warn' : 'pass', result.beatsNaive === false ? 'no method beat the naive baseline in backtesting; the series may be close to a random walk — report the naive forecast and wide intervals' : result.selectionReason)
    if ((best.backtestHorizon ?? horizon) < horizon) ctx.record.check('backtested horizon', 'warn', `history allowed backtesting only ${best.backtestHorizon} step(s) ahead; intervals beyond that are extrapolated with √h scaling`)
    if (horizon > s.dates.length / 2) ctx.record.check('horizon length', 'warn', `forecasting ${horizon} periods from ${s.dates.length} of history; uncertainty grows quickly beyond the backtested horizon`)
    for (const failed of result.leaderboard.filter((row) => row.failed)) ctx.record.warn(`${failed.method} not evaluated: ${failed.failed}`)
    ctx.record.metric('mase', best.mase)
    const output = ctx.saveDataset(outputName(ctx, `${entry.name}_forecast`), frameFromRows(result.forecast.map((f) => ({ date: f.date, forecast: f.forecast, lower: f.lower, upper: f.upper }))), 'forecast', [refOf(entry)], [{ method: result.method, horizon, level: result.level, seed }])
    const historyShown = Math.min(s.dates.length, Math.max(3 * horizon, 36))
    const hist = result.history.values.slice(-historyShown)
    const dates = [...result.history.dates.slice(-historyShown), ...result.forecast.map((f) => f.date)]
    const chart = saveChart(ctx, lineChart({ title: `${str(ctx, 'value')} forecast (${result.method})`, subtitle: `${Math.round(result.level * 100)}% interval: ${result.intervalMethod}`, x: dates, series: [{ name: 'actual', values: [...hist, ...new Array(horizon).fill(null)] }, { name: 'forecast', values: [...new Array(historyShown - 1).fill(null), hist.at(-1)!, ...result.forecast.map((f) => f.forecast)] }], band: { lower: [...new Array(historyShown).fill(null), ...result.forecast.map((f) => f.lower)], upper: [...new Array(historyShown).fill(null), ...result.forecast.map((f) => f.upper)], label: `${Math.round(result.level * 100)}% prediction interval` }, highlightFrom: historyShown, markers: false }))
    return { dataset: refOf(entry), output: refOf(output), ...result, history: { periods: result.history.dates.length, last: result.history.dates.at(-1) }, chart, caution: 'A forecast is a projection of past patterns with the stated uncertainty; it cannot anticipate shocks the history does not contain.' }
  },
})
