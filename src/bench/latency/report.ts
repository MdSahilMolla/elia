import { dim, green, red, bold, gold } from '../../ui/theme.ts'
import { table } from '../../ui/layout.ts'
import type { LatencyReport, ScenarioResult } from './harness.ts'

/**
 * How the latency numbers turn into a pass/fail.
 *
 * Structural metrics (round-trips, speculative hits) are deterministic, so any
 * move in the wrong direction is a hard regression. Wall-clock has run-to-run
 * noise even with a scripted model, so it only warns unless `strict` is set —
 * and only when it moves by both a relative and an absolute margin, so a scenario
 * that takes 3ms doesn't fail CI for drifting to 5ms.
 */
const WALL_REGRESSION_RATIO = 1.5
const WALL_REGRESSION_FLOOR_MS = 15
const COLD_START_REGRESSION_RATIO = 1.5
const COLD_START_REGRESSION_FLOOR_MS = 80
const WALL_IMPROVEMENT_RATIO = 0.8

export interface LatencyComparison {
  ok: boolean
  regressions: string[]
  warnings: string[]
  improvements: string[]
}

function byId(report: LatencyReport): Map<string, ScenarioResult> {
  return new Map(report.scenarios.map((scenario) => [scenario.id, scenario]))
}

export function compareLatency(
  baseline: LatencyReport,
  current: LatencyReport,
  options: { strict?: boolean } = {},
): LatencyComparison {
  const regressions: string[] = []
  const warnings: string[] = []
  const improvements: string[] = []
  const base = byId(baseline)

  // Wall-clock is only comparable when the two runs simulated the same model.
  // Structural metrics (round-trips, speculative hits) are pacing-independent and
  // always compared.
  const samePacing =
    baseline.modelPacing.ttftMs === current.modelPacing.ttftMs &&
    baseline.modelPacing.tokenMs === current.modelPacing.tokenMs

  for (const scenario of current.scenarios) {
    if (!scenario.structuralOk) {
      regressions.push(`${scenario.id}: ${scenario.notes.join('; ') || 'structural expectations not met'}`)
      continue
    }

    const prior = base.get(scenario.id)
    if (!prior) {
      warnings.push(`${scenario.id}: no baseline entry — recording as new`)
      continue
    }

    if (scenario.roundTrips > prior.roundTrips) {
      regressions.push(`${scenario.id}: round-trips ${prior.roundTrips} → ${scenario.roundTrips}`)
    } else if (scenario.roundTrips < prior.roundTrips) {
      improvements.push(`${scenario.id}: round-trips ${prior.roundTrips} → ${scenario.roundTrips}`)
    }

    if (scenario.cachedToolCalls < prior.cachedToolCalls) {
      regressions.push(
        `${scenario.id}: speculative tool hits ${prior.cachedToolCalls} → ${scenario.cachedToolCalls} (reads that used to be pre-run now block)`,
      )
    } else if (scenario.cachedToolCalls > prior.cachedToolCalls) {
      improvements.push(`${scenario.id}: speculative tool hits ${prior.cachedToolCalls} → ${scenario.cachedToolCalls}`)
    }

    if (!samePacing) continue

    const wallDelta = scenario.wallMsMedian - prior.wallMsMedian
    if (
      scenario.wallMsMedian > prior.wallMsMedian * WALL_REGRESSION_RATIO &&
      wallDelta > WALL_REGRESSION_FLOOR_MS
    ) {
      const line = `${scenario.id}: wall ${prior.wallMsMedian}ms → ${scenario.wallMsMedian}ms (+${round(wallDelta)}ms)`
      if (options.strict) regressions.push(line)
      else warnings.push(line)
    } else if (scenario.wallMsMedian < prior.wallMsMedian * WALL_IMPROVEMENT_RATIO && prior.wallMsMedian - scenario.wallMsMedian > WALL_REGRESSION_FLOOR_MS) {
      improvements.push(`${scenario.id}: wall ${prior.wallMsMedian}ms → ${scenario.wallMsMedian}ms`)
    }
  }

  if (
    samePacing &&
    baseline.coldStartMsMedian > 0 &&
    current.coldStartMsMedian > 0 &&
    current.coldStartMsMedian > baseline.coldStartMsMedian * COLD_START_REGRESSION_RATIO &&
    current.coldStartMsMedian - baseline.coldStartMsMedian > COLD_START_REGRESSION_FLOOR_MS
  ) {
    const line = `cold start ${baseline.coldStartMsMedian}ms → ${current.coldStartMsMedian}ms`
    if (options.strict) regressions.push(line)
    else warnings.push(line)
  }

  return { ok: regressions.length === 0, regressions, warnings, improvements }
}

export function renderLatencyReport(report: LatencyReport, baseline?: LatencyReport): string {
  const samePacing =
    baseline !== undefined &&
    baseline.modelPacing.ttftMs === report.modelPacing.ttftMs &&
    baseline.modelPacing.tokenMs === report.modelPacing.tokenMs
  const base = samePacing ? byId(baseline!) : undefined
  const lines: string[] = ['', bold('Latency benchmark'), '']

  const pacingNote = report.live
    ? `live — ${report.model}, real API calls, ${report.scenarios[0]?.runs ?? 1} run(s) per scenario`
    : report.modelPacing.ttftMs === 0 && report.modelPacing.tokenMs === 0
      ? 'scripted model, zero pacing — every millisecond here is elia'
      : `scripted model, ${report.modelPacing.ttftMs}ms TTFT + ${report.modelPacing.tokenMs}ms/token`
  lines.push(`  ${dim(pacingNote)}`)
  if (report.coldStartMsMedian > 0) {
    const baseCold = baseline?.coldStartMsMedian
    const delta = baseCold ? ` ${deltaTag(baseCold, report.coldStartMsMedian)}` : ''
    lines.push(`  ${dim(`cold start (process load + exit): ${report.coldStartMsMedian}ms${delta}`)}`)
  }
  lines.push('')

  const columns = report.live
    ? [{ header: '' }, { header: 'scenario' }, { header: 'trips', align: 'right' as const }, { header: 'tools', align: 'right' as const }, { header: '⚡ spec', align: 'right' as const }, { header: 'ttft', align: 'right' as const }, { header: 'out tok', align: 'right' as const }, { header: 'tok/s', align: 'right' as const }, { header: 'wall', align: 'right' as const }]
    : [{ header: '' }, { header: 'scenario' }, { header: 'trips', align: 'right' as const }, { header: 'tools', align: 'right' as const }, { header: '⚡ spec', align: 'right' as const }, { header: 'ttft', align: 'right' as const }, { header: 'wall (med)', align: 'right' as const }]

  const rows = table(
    columns,
    report.scenarios.map((scenario) => {
      const prior = base?.get(scenario.id)
      const wallCell = prior ? `${scenario.wallMsMedian}ms ${deltaTag(prior.wallMsMedian, scenario.wallMsMedian)}` : fmtMs(scenario.wallMsMedian)
      const common = [
        scenario.structuralOk ? green('✓') : red('✗'),
        scenario.id,
        String(scenario.roundTrips),
        String(scenario.toolCalls),
        String(scenario.cachedToolCalls),
        fmtMs(scenario.firstTokenMsMedian),
      ]
      return report.live
        ? [...common, String(scenario.outputTokensMedian), String(scenario.tokensPerSecMedian), wallCell]
        : [...common, wallCell]
    }),
  )
  const [header, separator, ...dataRows] = rows
  lines.push(`  ${header}`, `  ${separator}`)
  report.scenarios.forEach((scenario, i) => {
    lines.push(`  ${dataRows[i]}`)
    for (const note of scenario.notes) lines.push(`      ${red(note)}`)
  })
  lines.push('')

  if (report.live) {
    const totalWall = report.scenarios.reduce((sum, s) => sum + s.wallMsMedian, 0)
    lines.push(`  ${dim(`total ${fmtMs(totalWall)} across ${report.scenarios.length} scenarios · a ✗ means the model chose a different tool-call shape than the ideal, not a failure`)}`)
    lines.push('')
    return lines.join('\n')
  }

  if (baseline) {
    if (!samePacing) {
      lines.push(`  ${dim(`baseline ran at ${baseline.modelPacing.ttftMs}ms/${baseline.modelPacing.tokenMs}ms pacing — comparing structure only, not wall-clock`)}`)
    }
    const comparison = compareLatency(baseline, report)
    for (const improvement of comparison.improvements) lines.push(`  ${green('▲')} ${improvement}`)
    for (const warning of comparison.warnings) lines.push(`  ${gold('•')} ${warning}`)
    for (const regression of comparison.regressions) lines.push(`  ${red('▼')} ${regression}`)
    lines.push('')
    lines.push(`  ${comparison.ok ? green('no regressions') : red(`${comparison.regressions.length} regression(s)`)}`)
    lines.push('')
  }

  return lines.join('\n')
}

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${round(ms / 1000)}s` : `${round(ms)}ms`
}

function deltaTag(from: number, to: number): string {
  if (from === 0) return ''
  const pct = Math.round(((to - from) / from) * 100)
  if (pct === 0) return dim('±0%')
  return pct > 0 ? red(`+${pct}%`) : green(`${pct}%`)
}

function round(value: number): number {
  return Math.round(value * 10) / 10
}
