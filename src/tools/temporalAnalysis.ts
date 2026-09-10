import type { Tool } from './types.ts'
import { optionalString } from './args.ts'
import { runShell } from '../shell.ts'
import { resolveWorkspacePath } from '../autonomy/context.ts'

const SHELL_TIMEOUT_MS = 30_000
const MAX_HISTORY_DAYS = 90

interface TimeSeriesPoint {
  date: string
  value: number
  label?: string
}

interface TrendAnalysis {
  metric: string
  dataPoints: TimeSeriesPoint[]
  trend: 'increasing' | 'decreasing' | 'stable' | 'volatile'
  trendStrength: number
  forecast: TimeSeriesPoint[]
  alerts: string[]
}

interface TemporalReport {
  metrics: TrendAnalysis[]
  timeRange: string
  summary: string
  predictions: string[]
}

function linearRegression(points: Array<{ x: number; y: number }>): { slope: number; intercept: number; r2: number } {
  const n = points.length
  if (n < 2) return { slope: 0, intercept: points[0]?.y ?? 0, r2: 0 }

  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0
  for (const p of points) {
    sumX += p.x
    sumY += p.y
    sumXY += p.x * p.y
    sumX2 += p.x * p.x
    sumY2 += p.y * p.y
  }

  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX)
  const intercept = (sumY - slope * sumX) / n

  const ssRes = points.reduce((sum, p) => sum + (p.y - (slope * p.x + intercept)) ** 2, 0)
  const mean = sumY / n
  const ssTot = points.reduce((sum, p) => sum + (p.y - mean) ** 2, 0)
  const r2 = ssTot === 0 ? 0 : 1 - ssRes / ssTot

  return { slope, intercept, r2: Math.max(0, Math.min(1, r2)) }
}

function classifyTrend(slope: number, r2: number, values: number[]): TrendAnalysis['trend'] {
  const range = Math.max(...values) - Math.min(...values)
  const avg = values.reduce((s, v) => s + v, 0) / values.length
  const normalizedSlope = avg > 0 ? Math.abs(slope) / avg : 0

  if (range > avg * 2) return 'volatile'
  if (r2 < 0.3) return 'stable'
  if (normalizedSlope < 0.01) return 'stable'
  return slope > 0 ? 'increasing' : 'decreasing'
}

async function getFileSizeTrend(cwd: string, file: string, days: number): Promise<TrendAnalysis> {
  const points: TimeSeriesPoint[] = []
  const now = new Date()

  for (let i = days; i >= 0; i -= Math.max(1, Math.floor(days / 20))) {
    const date = new Date(now)
    date.setDate(date.getDate() - i)
    const dateStr = date.toISOString().split('T')[0]!
    const result = await runShell(
      `git log --before="${dateStr}" -1 --format="%H" -- "${file}" 2>/dev/null`,
      SHELL_TIMEOUT_MS,
      cwd,
    )
    const commit = result.stdout.trim()
    if (commit) {
      const sizeResult = await runShell(
        `git show ${commit}:"${file}" 2>/dev/null | wc -c`,
        SHELL_TIMEOUT_MS,
        cwd,
      )
      const size = parseInt(sizeResult.stdout.trim(), 10) || 0
      points.push({ date: dateStr, value: size })
    }
  }

  if (points.length < 2) {
    return { metric: `File size: ${file}`, dataPoints: points, trend: 'stable', trendStrength: 0, forecast: [], alerts: [] }
  }

  const regression = linearRegression(points.map((p, i) => ({ x: i, y: p.value })))
  const values = points.map((p) => p.value)
  const trend = classifyTrend(regression.slope, regression.r2, values)

  const forecast: TimeSeriesPoint[] = []
  for (let i = 1; i <= 5; i++) {
    const futureDate = new Date(now)
    futureDate.setDate(futureDate.getDate() + i * 7)
    forecast.push({
      date: futureDate.toISOString().split('T')[0]!,
      value: Math.max(0, Math.round(regression.slope * (points.length + i) + regression.intercept)),
      label: 'forecast',
    })
  }

  const alerts: string[] = []
  const lastValue = values[values.length - 1] ?? 0
  const firstValue = values[0] ?? 0
  if (firstValue > 0) {
    const growth = ((lastValue - firstValue) / firstValue) * 100
    if (growth > 100) alerts.push(`File size grew ${Math.round(growth)}% over the period`)
    if (growth < -50) alerts.push(`File size shrank ${Math.round(Math.abs(growth))}% — potential data loss`)
  }

  return {
    metric: `File size: ${file}`,
    dataPoints: points,
    trend,
    trendStrength: regression.r2,
    forecast,
    alerts,
  }
}

async function getCommitFrequencyTrend(cwd: string, days: number): Promise<TrendAnalysis> {
  const points: TimeSeriesPoint[] = []
  const now = new Date()
  const bucketSize = Math.max(1, Math.floor(days / 12))

  for (let i = days; i >= 0; i -= bucketSize) {
    const endDate = new Date(now)
    endDate.setDate(endDate.getDate() - i)
    const startDate = new Date(endDate)
    startDate.setDate(startDate.getDate() - bucketSize)

    const result = await runShell(
      `git log --after="${startDate.toISOString().split('T')[0]}" --before="${endDate.toISOString().split('T')[0]}" --oneline 2>/dev/null | wc -l`,
      SHELL_TIMEOUT_MS,
      cwd,
    )
    const count = parseInt(result.stdout.trim(), 10) || 0
    points.push({ date: endDate.toISOString().split('T')[0]!, value: count })
  }

  if (points.length < 2) {
    return { metric: 'Commit frequency', dataPoints: points, trend: 'stable', trendStrength: 0, forecast: [], alerts: [] }
  }

  const regression = linearRegression(points.map((p, i) => ({ x: i, y: p.value })))
  const values = points.map((p) => p.value)
  const trend = classifyTrend(regression.slope, regression.r2, values)

  const forecast: TimeSeriesPoint[] = []
  for (let i = 1; i <= 3; i++) {
    const futureDate = new Date(now)
    futureDate.setDate(futureDate.getDate() + i * bucketSize)
    forecast.push({
      date: futureDate.toISOString().split('T')[0]!,
      value: Math.max(0, Math.round(regression.slope * (points.length + i) + regression.intercept)),
      label: 'forecast',
    })
  }

  const alerts: string[] = []
  const avg = values.reduce((s, v) => s + v, 0) / values.length
  const last = values[values.length - 1] ?? 0
  if (last === 0 && avg > 2) alerts.push('Commit activity dropped to zero — possible stall')
  if (last > avg * 3) alerts.push('Unusual spike in commit activity')

  return {
    metric: 'Commit frequency',
    dataPoints: points,
    trend,
    trendStrength: regression.r2,
    forecast,
    alerts,
  }
}

async function getComplexityTrend(cwd: string, file: string, days: number): Promise<TrendAnalysis> {
  const points: TimeSeriesPoint[] = []
  const now = new Date()

  for (let i = days; i >= 0; i -= Math.max(1, Math.floor(days / 10))) {
    const date = new Date(now)
    date.setDate(date.getDate() - i)
    const dateStr = date.toISOString().split('T')[0]!
    const commitResult = await runShell(
      `git log --before="${dateStr}" -1 --format="%H" -- "${file}" 2>/dev/null`,
      SHELL_TIMEOUT_MS,
      cwd,
    )
    const commit = commitResult.stdout.trim()
    if (commit) {
      const codeResult = await runShell(
        `git show ${commit}:"${file}" 2>/dev/null | wc -l`,
        SHELL_TIMEOUT_MS,
        cwd,
      )
      const lines = parseInt(codeResult.stdout.trim(), 10) || 0
      points.push({ date: dateStr, value: lines })
    }
  }

  if (points.length < 2) {
    return { metric: `Complexity: ${file}`, dataPoints: points, trend: 'stable', trendStrength: 0, forecast: [], alerts: [] }
  }

  const regression = linearRegression(points.map((p, i) => ({ x: i, y: p.value })))
  const values = points.map((p) => p.value)
  const trend = classifyTrend(regression.slope, regression.r2, values)

  const forecast: TimeSeriesPoint[] = []
  for (let i = 1; i <= 3; i++) {
    const futureDate = new Date(now)
    futureDate.setDate(futureDate.getDate() + i * 30)
    forecast.push({
      date: futureDate.toISOString().split('T')[0]!,
      value: Math.max(0, Math.round(regression.slope * (points.length + i) + regression.intercept)),
      label: 'forecast',
    })
  }

  const alerts: string[] = []
  const last = values[values.length - 1] ?? 0
  if (last > 500) alerts.push(`File has ${last} lines — approaching complexity threshold`)
  if (trend === 'increasing' && regression.r2 > 0.7) alerts.push('Strong upward trend in file size — consider refactoring')

  return {
    metric: `Complexity: ${file}`,
    dataPoints: points,
    trend,
    trendStrength: regression.r2,
    forecast,
    alerts,
  }
}

export const temporalAnalysisTool: Tool = {
  name: 'temporal_analysis',
  description:
    'Analyze code metrics over time: file size trends, commit frequency, complexity growth, and resource usage patterns. Uses git history to reconstruct time series and provides linear regression forecasts. Detects anomalies and alerts on concerning trends.',
  input_schema: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'Specific file to analyze trends for' },
      metric: { type: 'string', description: 'Metric: file_size, commit_frequency, complexity, all (default: all)' },
      days: { type: 'number', description: `History depth in days (1-${MAX_HISTORY_DAYS}, default 30)` },
    },
  },
  async execute(input) {
    const cwd = resolveWorkspacePath('.')
    const file = optionalString(input.file, 'file')
    const metric = optionalString(input.metric, 'metric') ?? 'all'
    const days = Math.min(Math.max(typeof input.days === 'number' ? input.days : 30, 1), MAX_HISTORY_DAYS)

    const metrics: TrendAnalysis[] = []

    if (metric === 'all' || metric === 'commit_frequency') {
      metrics.push(await getCommitFrequencyTrend(cwd, days))
    }

    if (file) {
      if (metric === 'all' || metric === 'file_size') {
        metrics.push(await getFileSizeTrend(cwd, file, days))
      }
      if (metric === 'all' || metric === 'complexity') {
        metrics.push(await getComplexityTrend(cwd, file, days))
      }
    }

    if (metrics.length === 0) {
      return 'No metrics to analyze. Provide a file path for file-specific metrics, or use commit_frequency for repo-wide analysis.'
    }

    const allAlerts = metrics.flatMap((m) => m.alerts)
    const predictions: string[] = []
    for (const m of metrics) {
      if (m.forecast.length > 0) {
        const lastForecast = m.forecast[m.forecast.length - 1]!
        predictions.push(`${m.metric}: projected ${lastForecast.value} by ${lastForecast.date}`)
      }
    }

    const report: TemporalReport = {
      metrics,
      timeRange: `Last ${days} days`,
      summary: `Analyzed ${metrics.length} metric(s) over ${days} days. ${allAlerts.length} alert(s). ${predictions.length} prediction(s).`,
      predictions,
    }

    return formatReport(report)
  },
}

function formatReport(report: TemporalReport): string {
  const lines: string[] = []
  lines.push('=== Temporal Code Analysis Report ===')
  lines.push(`Time range: ${report.timeRange}`)
  lines.push('')
  lines.push(report.summary)

  for (const metric of report.metrics) {
    lines.push('')
    lines.push(`--- ${metric.metric} ---`)
    lines.push(`  Trend: ${metric.trend} (strength: ${Math.round(metric.trendStrength * 100)}%)`)
    lines.push(`  Data points: ${metric.dataPoints.length}`)
    if (metric.dataPoints.length > 0) {
      const first = metric.dataPoints[0]!
      const last = metric.dataPoints[metric.dataPoints.length - 1]!
      lines.push(`  Range: ${first.date} (${first.value}) → ${last.date} (${last.value})`)
    }
    if (metric.alerts.length > 0) {
      for (const alert of metric.alerts) lines.push(`  ⚠ ${alert}`)
    }
    if (metric.forecast.length > 0) {
      lines.push('  Forecast:')
      for (const f of metric.forecast) {
        lines.push(`    ${f.date}: ${f.value}`)
      }
    }
  }

  if (report.predictions.length > 0) {
    lines.push('')
    lines.push('--- Predictions ---')
    for (const pred of report.predictions) {
      lines.push(`  * ${pred}`)
    }
  }

  return lines.join('\n')
}
