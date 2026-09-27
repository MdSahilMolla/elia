import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { registerCapability, type ActionContext } from '../engine.ts'
import { assertColumns, type Frame } from '../frame.ts'
import { buildPowerBiProject, frameToCsv, type ModelMeasure, type ModelRelationship, type ModelTable, type PageSpec } from '../powerbi/project.ts'
import { buildReportHtml, buildReportMarkdown, type ReportBlock, type ReportInput } from '../report.ts'
import { aggregateValues, AGGREGATES, type Aggregate } from '../transform.ts'
import { discoverRelationships, understandDataset } from '../understand.ts'
import { barChart, boxChart, CHART_TYPES, formatNumber, heatmapChart, histogramChart, lineChart, recommendChart, scatterChart, treemapChart, type ChartResult } from '../viz.ts'
import { compareScalars, toDateMs, toNumber } from '../values.ts'
import { refOf } from '../workspace.ts'
import { DATASET, list, saveChart, str, WHERE } from './common.ts'

// ---------------------------------------------------------------- plan

const WORKFLOWS: Record<string, string[]> = {
  descriptive: ['ds_data load', 'ds_data inspect', 'ds_data quality', 'ds_stats describe / correlations', 'ds_report chart', 'ds_report report'],
  diagnostic: ['ds_data load/inspect/quality', 'ds_analytics kpis', 'ds_analytics root_cause', 'ds_stats test (is the change beyond noise?)', 'ds_report report with evidence vs hypotheses separated'],
  predictive: ['ds_data load/inspect/quality', 'ds_data transform (clean, derive features without future information)', 'ds_ml train (baseline + candidates, leakage screen, holdout)', 'ds_ml explain', 'ds_ml model_card', 'ds_report report'],
  forecasting: ['ds_data load/quality', 'ds_timeseries analyze (seasonality, stationarity, breaks)', 'ds_timeseries forecast (backtested, with intervals)', 'ds_report report'],
  experiment: ['ds_stats design_experiment (before launch)', 'ds_stats ab_test (sample ratio, lift, CIs, guardrails, segments)', 'ds_report report'],
  causal: ['ds_stats causal method "dag" (write down the assumed graph)', 'ds_stats causal (did / propensity / rdd / iv / synthetic_control)', 'sensitivity: vary covariates and specifications', 'ds_report report stating assumptions'],
  segmentation: ['ds_data load/quality', 'ds_ml cluster or ds_analytics rfm', 'validate segments against outcomes', 'ds_report chart/report'],
  optimization: ['formulate objective, variables, constraints', 'ds_analytics optimize', 'sensitivity via shadow prices and re-solves', 'ds_report report'],
  simulation: ['estimate input distributions from data (empiricalFrom) or sourced assumptions', 'ds_analytics simulate', 'ds_report report'],
  bi: ['ds_data load all sources', 'ds_data relationships (validate keys and grain)', 'ds_data transform (clean dimensions, one row per key)', 'ds_report powerbi', 'ds_report report'],
  research: ['state hypotheses and success criteria', 'baselines first', 'ds_ml train / ds_timeseries forecast comparisons on identical splits', 'ablations (remove one component at a time)', 'ds_ml / ds_stats significance of differences', 'ds_report report'],
}

registerCapability({
  tool: 'ds_report',
  action: 'plan',
  summary: 'record the analytical plan (objective, questions, problem type, data, methods, validation, deliverables, assumptions) and get the standard workflow for that problem type',
  effect: 'local-write',
  params: { objective: { type: 'string', required: true, description: 'what the user needs to decide or know' }, questions: { type: 'array', description: 'specific questions to answer' }, problemType: { type: 'string', required: true, enum: Object.keys(WORKFLOWS), description: 'the kind of problem' }, datasets: { type: 'array', description: 'datasets or sources to use' }, methods: { type: 'array', description: 'chosen methods and why' }, validation: { type: 'array', description: 'how results will be checked' }, deliverables: { type: 'array', description: 'artifacts to produce' }, assumptions: { type: 'array', description: 'assumptions being made' } },
  run(ctx) {
    const strings = (name: string) => (Array.isArray(ctx.params[name]) ? (ctx.params[name] as unknown[]).map(String) : [])
    const plan = ctx.workspace.savePlan({ objective: str(ctx, 'objective'), questions: strings('questions'), problemType: str(ctx, 'problemType'), datasets: strings('datasets'), methods: strings('methods'), validation: strings('validation'), deliverables: strings('deliverables'), assumptions: strings('assumptions') })
    ctx.record.check('plan recorded', 'pass', plan.id)
    return { plan, standardWorkflow: WORKFLOWS[plan.problemType], reminder: 'Use the minimum methodology that answers the question rigorously; do not run every analysis on every dataset.' }
  },
})

// ---------------------------------------------------------------- chart

function aggregateFrame(frame: Frame, x: string, y: string[], series: string | undefined, fn: Aggregate): { categories: string[]; seriesNames: string[]; values: Map<string, Map<string, number | null>> } {
  const groups = new Map<string, Map<string, Array<unknown>>>()
  for (const row of frame.rows) {
    const key = row[x] === null || row[x] === undefined ? '(missing)' : String(row[x])
    for (const measure of y) {
      const name = series ? String(row[series] ?? '(missing)') : measure
      const bySeries = groups.get(key) ?? new Map<string, Array<unknown>>()
      bySeries.set(name, [...(bySeries.get(name) ?? []), row[measure] ?? null])
      groups.set(key, bySeries)
    }
  }
  const seriesNames = [...new Set([...groups.values()].flatMap((m) => [...m.keys()]))]
  const values = new Map([...groups.entries()].map(([key, m]) => [key, new Map(seriesNames.map((s) => [s, m.has(s) ? (aggregateValues(m.get(s) as never, fn) as number | null) : null]))]))
  return { categories: [...groups.keys()], seriesNames, values }
}

registerCapability({
  tool: 'ds_report',
  action: 'chart',
  summary: `chart a dataset (${CHART_TYPES.join(', ')}; "auto" picks the form from the column types): aggregates as needed, starts bars at zero, never uses two y-axes, and saves an SVG plus its data table`,
  effect: 'artifact-write',
  params: { dataset: DATASET, type: { type: 'string', enum: ['auto', 'bar', 'line', 'area', 'scatter', 'histogram', 'box', 'violin', 'heatmap', 'treemap'], description: 'default auto' }, x: { type: 'string', description: 'x / category column' }, y: { type: 'string|array', description: 'value column(s)' }, series: { type: 'string', description: 'column that splits the data into series (≤ 8 shown; the rest fold into Other)' }, aggregate: { type: 'string', enum: AGGREGATES, description: 'how rows combine per x (default sum; mean for averages)' }, top: { type: 'integer', description: 'keep the top N categories by value (bars)' }, title: { type: 'string', description: 'chart title (default from the fields)' }, subtitle: { type: 'string', description: 'subtitle' }, horizontal: { type: 'boolean', description: 'horizontal bars' }, stacked: { type: 'boolean', description: 'stack series' }, where: WHERE },
  run(ctx) {
    const { entry, frame } = ctx.dataset(str(ctx, 'dataset'))
    const x = typeof ctx.params.x === 'string' ? ctx.params.x : undefined
    const y = list(ctx.params.y, 'y')
    assertColumns(frame, [...(x ? [x] : []), ...y, ...(typeof ctx.params.series === 'string' ? [ctx.params.series] : [])], 'chart')
    let type = str(ctx, 'type', 'auto')
    if (type === 'auto') {
      const xType = x ? (frame.types[x] === 'date' || frame.types[x] === 'datetime' ? 'time' : frame.types[x] === 'integer' || frame.types[x] === 'number' ? 'number' : 'category') : undefined
      type = !x && y.length === 1 ? 'histogram' : recommendChart({ ...(xType ? { xType } : {}), yCount: y.length, categories: x ? new Set(frame.rows.map((r) => r[x])).size : 0 }).type
    }
    const fn = (ctx.params.aggregate as Aggregate) ?? 'sum'
    const title = typeof ctx.params.title === 'string' ? ctx.params.title : `${y.join(', ') || x} ${x && y.length ? `by ${x}` : ''}`.trim()
    const subtitle = typeof ctx.params.subtitle === 'string' ? ctx.params.subtitle : `${entry.name}${y.length && x && type !== 'scatter' ? `, ${fn}` : ''}${typeof ctx.params.where === 'string' ? `, where ${ctx.params.where}` : ''}`
    let chart: ChartResult
    if (type === 'histogram') chart = histogramChart({ title, subtitle, values: frame.rows.map((r) => toNumber(r[y[0] ?? x!])).filter((v): v is number => v !== undefined) })
    else if (type === 'box' || type === 'violin') {
      if (!x || !y[0]) throw new Error('box/violin needs x (group) and y (value)')
      const groups = new Map<string, number[]>()
      for (const row of frame.rows) { const v = toNumber(row[y[0]]); if (v === undefined) continue; const key = String(row[x] ?? '(missing)'); groups.set(key, [...(groups.get(key) ?? []), v]) }
      chart = boxChart({ title, subtitle, groups: [...groups.entries()].slice(0, 20).map(([name, values]) => ({ name, values })), violin: type === 'violin', yLabel: y[0] })
    } else if (type === 'scatter') {
      if (!x || !y[0]) throw new Error('scatter needs x and y')
      chart = scatterChart({ title, subtitle, xLabel: x, yLabel: y[0], trend: true, points: frame.rows.map((r) => ({ x: toNumber(r[x]) ?? toDateMs(r[x]) ?? NaN, y: toNumber(r[y[0]!]) ?? NaN, ...(typeof ctx.params.series === 'string' ? { group: String(r[ctx.params.series] ?? '(missing)') } : {}) })) })
    } else if (type === 'heatmap') {
      if (!x || !y[0] || typeof ctx.params.series !== 'string') throw new Error('heatmap needs x (columns), series (rows), and y (value)')
      const agg = aggregateFrame(frame, x, [y[0]], ctx.params.series, fn)
      const rowsLabels = agg.seriesNames.slice(0, 40)
      chart = heatmapChart({ title, subtitle, xLabels: agg.categories.slice(0, 40), yLabels: rowsLabels, values: rowsLabels.map((s) => agg.categories.slice(0, 40).map((c) => agg.values.get(c)?.get(s) ?? null)) })
    } else {
      if (!x || !y.length) throw new Error(`${type} needs x and y`)
      const agg = aggregateFrame(frame, x, y, typeof ctx.params.series === 'string' ? ctx.params.series : undefined, fn)
      let categories = agg.categories
      const isTime = frame.types[x] === 'date' || frame.types[x] === 'datetime' || frame.types[x] === 'integer' || frame.types[x] === 'number'
      if (isTime || type === 'line' || type === 'area') categories = [...categories].sort((a, b) => compareScalars(toNumber(a) ?? toDateMs(a) ?? a, toNumber(b) ?? toDateMs(b) ?? b))
      else categories = [...categories].sort((a, b) => (agg.values.get(b)!.get(agg.seriesNames[0]!) ?? 0) - (agg.values.get(a)!.get(agg.seriesNames[0]!) ?? 0))
      if (typeof ctx.params.top === 'number' && categories.length > ctx.params.top) categories = categories.slice(0, ctx.params.top)
      const seriesOrder = agg.seriesNames.sort((a, b) => categories.reduce((t, c) => t + (agg.values.get(c)!.get(b) ?? 0), 0) - categories.reduce((t, c) => t + (agg.values.get(c)!.get(a) ?? 0), 0))
      const series = seriesOrder.map((name) => ({ name, values: categories.map((c) => agg.values.get(c)!.get(name) ?? null) }))
      if (type === 'treemap') chart = treemapChart({ title, subtitle, items: categories.map((c, i) => ({ label: c, value: series[0]!.values[i] ?? 0 })) })
      else if (type === 'line' || type === 'area') chart = lineChart({ title, subtitle, x: categories, series, area: type === 'area', zeroBaseline: type === 'area' })
      else chart = barChart({ title, subtitle, categories, series, ...(typeof ctx.params.horizontal === 'boolean' ? { horizontal: ctx.params.horizontal } : {}), ...(ctx.params.stacked === true ? { stacked: true } : {}) })
    }
    const saved = saveChart(ctx, chart)
    for (const warning of chart.warnings) ctx.record.warn(warning)
    ctx.record.check('chart rendered', 'pass', `${chart.type}, ${chart.table.rows.length} data rows`)
    return { dataset: refOf(entry), type: chart.type, ...saved, table: { columns: chart.table.columns, rows: chart.table.rows.slice(0, 30) } }
  },
})

// ---------------------------------------------------------------- report

interface StoredRecord { id: string; tool: string; action: string; status: string; startedAt: string; inputs: Array<{ dataset: string; fingerprint: string; rows: number }>; params: Record<string, unknown>; code: Array<{ language: string; text: string }>; seed?: number; environment: Record<string, string>; outputs: { datasets: string[]; models: string[]; artifacts: Array<{ path: string; sha256: string; bytes: number }> }; checks: Array<{ name: string; status: string; detail: string }>; warnings: string[]; result?: Record<string, unknown> }

function collectNumbers(value: unknown, out: number[] = []): number[] {
  if (typeof value === 'number' && Number.isFinite(value)) out.push(value)
  else if (typeof value === 'string') for (const m of value.matchAll(/-?\d[\d,]*\.?\d*(?:e-?\d+)?/gi)) { const n = Number(m[0].replace(/,/g, '')); if (Number.isFinite(n)) out.push(n) }
  else if (Array.isArray(value)) for (const item of value) collectNumbers(item, out)
  else if (value && typeof value === 'object') for (const item of Object.values(value)) collectNumbers(item, out)
  return out
}

/**
 * Numbers in narrative text that cannot be traced to any computed value. A token matches when
 * some computed number equals it after the rounding the token shows (12.3 matches 12.2961),
 * in either sign ("fell 12%" matches -0.12), and with %, pp, K, M, B units understood.
 * Small counts (≤ 12) and calendar years are not checked.
 */
export function untracedNumbers(text: string, evidence: number[]): string[] {
  const out: string[] = []
  const pool = evidence.filter(Number.isFinite).map(Math.abs)
  for (const match of text.matchAll(/(?<![\w.])-?\$?(\d[\d,]*(?:\.\d+)?)\s*(%|pp\b|percentage points|[kKmMbB](?![A-Za-z]))?/g)) {
    const digits = match[1]!
    const base = Number(digits.replace(/,/g, ''))
    if (!Number.isFinite(base)) continue
    const unit = (match[2] ?? '').toLowerCase()
    if (!unit && Number.isInteger(base) && (base <= 12 || (base >= 1900 && base <= 2100))) continue
    const decimals = (digits.split('.')[1] ?? '').length
    const step = 10 ** -decimals
    const candidates: Array<{ value: number; tolerance: number }> =
      unit === '%' || unit === 'pp' || unit === 'percentage points' ? [{ value: base, tolerance: step / 2 }, { value: base / 100, tolerance: step / 200 }]
      : unit === 'k' ? [{ value: base * 1e3, tolerance: (step / 2) * 1e3 }]
      : unit === 'm' ? [{ value: base * 1e6, tolerance: (step / 2) * 1e6 }]
      : unit === 'b' ? [{ value: base * 1e9, tolerance: (step / 2) * 1e9 }]
      : [{ value: base, tolerance: step / 2 }]
    const traced = candidates.some(({ value, tolerance }) => pool.some((e) => Math.abs(e - value) <= Math.max(tolerance * 1.0001, Math.abs(value) * 0.005)))
    if (!traced) out.push(match[0].trim())
  }
  return [...new Set(out)]
}

function blockForRecord(ctx: ActionContext, record: StoredRecord): ReportBlock[] {
  const r = record.result ?? {}
  const blocks: ReportBlock[] = []
  const heading = `${record.tool.replace('ds_', '')} · ${record.action}${record.inputs[0] ? ` — ${record.inputs[0].dataset}` : ''}`
  const metrics: Array<{ label: string; value: string; detail?: string }> = []
  const tables: ReportBlock['table'][] = []
  const bullets: string[] = []
  const key = `${record.tool}.${record.action}`
  if (key === 'ds_stats.test' && typeof r.interpretation === 'string') { bullets.push(r.interpretation); if (r.ci) metrics.push({ label: 'confidence interval', value: `${formatNumber((r.ci as { lower: number }).lower, 'plain')} to ${formatNumber((r.ci as { upper: number }).upper, 'plain')}` }) }
  if (key === 'ds_stats.regression' && Array.isArray(r.coefficients)) tables.push({ caption: `${String(r.model)} coefficients (${String(r.rowsUsed)} rows)`, columns: ['term', 'estimate', 'std. error', 'p-value', 'CI low', 'CI high'], rows: (r.coefficients as Array<Record<string, number | string>>).map((c) => [c.term!, c.estimate!, c.se!, c.pValue!, c.ciLower!, c.ciUpper!]) })
  if (key === 'ds_ml.train') {
    const holdout = r.holdout as { selected: Record<string, number>; baseline: Record<string, number> }
    const metric = String(r.primaryMetric)
    metrics.push({ label: `holdout ${metric}`, value: formatNumber(holdout.selected[metric], 'plain'), detail: `baseline ${formatNumber(holdout.baseline[metric], 'plain')}` })
    bullets.push(String((r.selected as { reason: string }).reason))
    tables.push({ caption: 'Model comparison (cross-validation)', columns: ['algorithm', 'CV mean', 'CV sd', 'fit s', 'interpretability'], rows: (r.leaderboard as Array<Record<string, unknown>>).map((row) => [String(row.algorithm), Number(row.cvMean), Number(row.cvSd), Number(row.fitSeconds), String(row.interpretability)]) })
    if (Array.isArray(r.leakage) && r.leakage.length) bullets.push(`Leakage screen: ${(r.leakage as Array<{ feature: string; reason: string; action: string }>).map((l) => `${l.feature} ${l.action} (${l.reason})`).join('; ')}`)
  }
  if (key === 'ds_timeseries.forecast' && Array.isArray(r.forecast)) {
    bullets.push(String(r.selectionReason))
    tables.push({ caption: `Forecast (${String(r.method)}, ${Math.round(Number(r.level) * 100)}% interval)`, columns: ['period', 'forecast', 'lower', 'upper'], rows: (r.forecast as Array<Record<string, number | string>>).map((f) => [f.date!, f.forecast!, f.lower!, f.upper!]) })
  }
  if (key === 'ds_analytics.root_cause' && Array.isArray(r.findings)) { bullets.push(...(r.findings as string[])); if (Array.isArray(r.hypotheses)) bullets.push(`_Hypotheses (not established by the data):_ ${(r.hypotheses as string[]).slice(1).join('; ')}`) }
  if (key === 'ds_data.quality') {
    metrics.push({ label: 'quality score', value: `${String(r.score)} (${String(r.grade)})` })
    tables.push({ caption: 'Quality issues', columns: ['severity', 'check', 'column', 'count', 'detail'], rows: (r.issues as Array<Record<string, unknown>>).slice(0, 25).map((i) => [String(i.severity), String(i.check), String(i.column ?? ''), Number(i.count), String(i.detail)]) })
  }
  if (key === 'ds_stats.ab_test' && Array.isArray(r.interpretation)) bullets.push(...(r.interpretation as string[]))
  if (key === 'ds_stats.causal' && r.effect) { const e = r.effect as { estimand: string; estimate: number; ci: [number, number]; pValue: number }; metrics.push({ label: e.estimand, value: formatNumber(e.estimate, 'plain'), detail: `95% CI ${formatNumber(e.ci[0], 'plain')} to ${formatNumber(e.ci[1], 'plain')}` }) }
  if (key === 'ds_ml.cluster' && Array.isArray(r.profiles)) tables.push({ caption: 'Cluster profiles', columns: ['cluster', 'size', 'share'], rows: (r.profiles as Array<Record<string, unknown>>).map((p) => [String(p.cluster), Number(p.size), Number(p.share)]) })
  if (bullets.length || metrics.length || tables.length) blocks.push({ heading, ...(metrics.length ? { metrics } : {}), ...(bullets.length ? { bullets } : {}), ...(tables[0] ? { table: tables[0] } : {}) })
  for (const table of tables.slice(1)) blocks.push({ table: table! })
  for (const artifact of record.outputs.artifacts.filter((a) => a.path.endsWith('.svg'))) {
    const absolute = join(ctx.workspace.cwd, artifact.path)
    const dataPath = absolute.replace(/\.svg$/, '.json')
    if (!existsSync(absolute)) continue
    const data = existsSync(dataPath) ? (JSON.parse(readFileSync(dataPath, 'utf8')) as { title: string; type: string; warnings: string[]; table: ChartResult['table'] }) : { title: artifact.path, type: 'chart', warnings: [], table: { columns: [], rows: [] } }
    blocks.push({ chart: { svg: readFileSync(absolute, 'utf8'), table: data.table, warnings: data.warnings, type: data.type, title: data.title } })
  }
  if (!blocks.length) blocks.push({ heading, text: `Run ${record.id} (${record.status}); see its execution record for the full result.` })
  return blocks
}

registerCapability({
  tool: 'ds_report',
  action: 'report',
  summary: 'build the analysis report (HTML + Markdown) from execution records: Objective, Data, Method, Results, Validation, Limitations, Artifacts. Numbers in your narrative are checked against the computed results and untraceable ones are flagged',
  effect: 'artifact-write',
  params: { title: { type: 'string', required: true, description: 'report title' }, subtitle: { type: 'string', description: 'subtitle' }, objective: { type: 'string', required: true, description: 'what was asked' }, runs: { type: 'array', required: true, description: 'run ids whose results go into the report, in order' }, narrative: { type: 'array', description: '[{ "heading": "What happened", "text": "…" }] — interpretation; every number must come from the runs' }, limitations: { type: 'array', description: 'limitations beyond those recorded by the runs' }, name: { type: 'string', description: 'file name stem (default from the title)' } },
  run(ctx) {
    const runIds = (ctx.params.runs as unknown[]).map(String)
    const records = runIds.map((id) => ctx.workspace.readRecord(id) as unknown as StoredRecord)
    const narrative = Array.isArray(ctx.params.narrative) ? (ctx.params.narrative as Array<{ heading?: string; text?: string }>) : []
    const evidence = records.flatMap((record) => [...collectNumbers(record.result), ...collectNumbers(record.params), ...record.inputs.map((i) => i.rows)])
    const narrativeText = narrative.map((n) => `${n.heading ?? ''} ${n.text ?? ''}`).join('\n') + (typeof ctx.params.objective === 'string' ? '' : '')
    const untraced = untracedNumbers(narrativeText, evidence)
    ctx.record.check('narrative numbers trace to computed results', untraced.length ? 'warn' : 'pass', untraced.length ? `not found in any referenced run: ${untraced.slice(0, 12).join(', ')}` : 'every number in the narrative matches a computed value')
    const failed = records.filter((r) => r.status === 'failed' || r.status === 'error')
    if (failed.length) ctx.record.check('source runs validated', 'warn', `runs ${failed.map((r) => r.id).join(', ')} failed validation; the report marks them`)
    const datasets = new Map<string, { fingerprint: string; rows: number }>()
    for (const record of records) for (const input of record.inputs) datasets.set(input.dataset, { fingerprint: input.fingerprint, rows: input.rows })
    const allChecks = records.flatMap((record) => record.checks.map((check) => ({ ...check, run: record.id })))
    const verified = ctx.workspace.verifyArtifacts().filter((a) => a.status === 'ok' && records.some((r) => r.id === a.runId))
    const input: ReportInput = {
      title: str(ctx, 'title'),
      ...(typeof ctx.params.subtitle === 'string' ? { subtitle: ctx.params.subtitle } : {}),
      objective: str(ctx, 'objective'),
      data: [{ table: { caption: 'Datasets used (content fingerprints identify the exact version)', columns: ['dataset', 'rows', 'fingerprint'], rows: [...datasets.entries()].map(([name, d]) => [name, d.rows, d.fingerprint.slice(0, 16)]) } }, ...[...datasets.keys()].slice(0, 6).map((ref) => { try { const lineage = ctx.workspace.lineage(ref); return { bullets: lineage.map((step) => `${step.dataset}: ${step.kind === 'source' ? `source ${step.source?.path ?? step.source?.url ?? step.source?.table ?? step.source?.kind}` : `${step.operation} of ${step.inputs?.join(', ')}`}`) } } catch { return { text: ref } } })],
      method: [{ table: { caption: 'Analysis steps (each is an execution record)', columns: ['run', 'action', 'status', 'seed', 'code'], rows: records.map((r) => [r.id, `${r.tool}.${r.action}`, r.status, r.seed ?? null, r.code.map((c) => c.text).join(' | ').slice(0, 160) || null]) } }],
      results: [...narrative.map((n) => ({ ...(n.heading ? { heading: n.heading } : {}), ...(n.text ? { text: n.text } : {}) })), ...records.flatMap((record) => blockForRecord(ctx, record))],
      validation: [
        { callout: failed.length ? { tone: 'critical' as const, text: `${failed.length} analysis step(s) failed validation (${failed.map((r) => r.id).join(', ')}); their results are not reliable.` } : allChecks.some((c) => c.status === 'warn') ? { tone: 'warning' as const, text: `${allChecks.filter((c) => c.status === 'warn').length} check(s) raised warnings; see below.` } : { tone: 'success' as const, text: `All ${allChecks.length} checks passed.` } },
        ...(untraced.length ? [{ callout: { tone: 'warning' as const, text: `These numbers in the narrative could not be traced to a computed result and should be verified: ${untraced.join(', ')}` } }] : []),
        { table: { caption: 'Checks', columns: ['run', 'check', 'status', 'detail'], rows: allChecks.sort((a, b) => (a.status === b.status ? 0 : a.status === 'fail' ? -1 : b.status === 'fail' ? 1 : a.status === 'warn' ? -1 : 1)).map((c) => [c.run, c.name, c.status, c.detail]) } },
      ],
      limitations: [...new Set([...records.flatMap((r) => r.warnings), ...(Array.isArray(ctx.params.limitations) ? (ctx.params.limitations as unknown[]).map(String) : [])])],
      artifacts: verified.map((a) => ({ path: a.path, kind: a.kind, sha256: a.sha256, bytes: a.bytes, ...(a.description ? { description: a.description } : {}) })),
      reproducibility: [`Execution records: ${records.map((r) => `.elia/datascience/runs/*-${r.id}.json`).join(', ')}`, `Engine ${records[0]?.environment.engine ?? ''}, elia ${records[0]?.environment.elia ?? ''}, Bun ${records[0]?.environment.bun ?? ''}`, 'Re-running the same actions on the same dataset versions with the same seeds reproduces these results.'],
    }
    const stem = (typeof ctx.params.name === 'string' ? ctx.params.name : input.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'report'
    const html = ctx.artifact(`reports/${stem}.html`, buildReportHtml(input), 'report-html', input.title)
    const md = ctx.artifact(`reports/${stem}.md`, buildReportMarkdown(input), 'report-markdown', input.title)
    ctx.record.check('report written', 'pass', `${records.length} runs, ${input.artifacts.length} verified artifacts`)
    return { html: html.path, markdown: md.path, runs: records.length, untracedNumbers: untraced, artifactsListed: input.artifacts.length }
  },
})

// ---------------------------------------------------------------- Power BI

registerCapability({
  tool: 'ds_report',
  action: 'powerbi',
  summary: 'generate a Power BI project (PBIP): TMDL semantic model (star schema, validated relationships, DAX measures incl. time intelligence, marked Date table, hierarchies) + PBIR report pages, with the data as CSV. A .pbix cannot be generated programmatically; open the .pbip in Power BI Desktop and Save as .pbix if needed',
  effect: 'artifact-write',
  params: { name: { type: 'string', required: true, description: 'project name' }, tables: { type: 'array', required: true, description: '[{ "dataset": "sales", "role": "fact" }, { "dataset": "customers", "role": "dimension", "name": "Customers" }]' }, relationships: { type: 'array', description: '[{ "fromTable": "Sales", "fromColumn": "customer_id", "toTable": "Customers", "toColumn": "customer_id" }] (default: discovered by value containment)' }, measures: { type: 'array', description: 'extra DAX measures [{ "table": "Sales", "name": "Margin %", "expression": "DIVIDE([Total Profit], [Total Revenue])", "formatString": "0.0%" }]' }, dateColumns: { type: 'array', description: 'fact date columns to relate to the Date table [{ "table": "Sales", "column": "order_date" }] (default: the first date column of each fact)' }, noDateTable: { type: 'boolean', description: 'skip the Date table' }, pages: { type: 'array', description: 'report pages [{ "name": "Overview", "visuals": [{ "kind": "kpis", "measures": ["Total Revenue"] }, { "kind": "line", "category": "Date.Year Month", "measures": ["Total Revenue"] }] }] (default: an overview and a detail page)' }, audience: { type: 'string', description: 'executive, sales, finance, marketing, operations, customer, product, supply chain, hr, risk, ml monitoring' } },
  run(ctx) {
    const specs = ctx.params.tables as Array<Record<string, unknown>>
    if (!Array.isArray(specs) || specs.length === 0) throw new Error('tables must list at least one dataset')
    const tables: ModelTable[] = specs.map((spec) => {
      const { entry, frame } = ctx.dataset(String(spec.dataset), { where: '' })
      const name = typeof spec.name === 'string' ? spec.name : entry.name.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).replace(/ /g, '')
      const profiles = understandDataset(frame).profiles
      return { name, frame, role: spec.role === 'dimension' ? 'dimension' : 'fact', semantic: Object.fromEntries(profiles.map((p) => [p.name, p.semanticType])), ...(entry.description ? { description: entry.description } : {}) }
    })
    let relationships = (ctx.params.relationships as ModelRelationship[] | undefined) ?? []
    if (!ctx.params.relationships) {
      const found = discoverRelationships(tables.map((t) => ({ name: t.name, frame: t.frame, profiles: understandDataset(t.frame).profiles })), 0.95).relationships
      relationships = found.filter((r) => tables.find((t) => t.name === r.to.dataset)?.role === 'dimension' && r.from.dataset !== r.to.dataset).map((r) => ({ fromTable: r.from.dataset, fromColumn: r.from.column, toTable: r.to.dataset, toColumn: r.to.column }))
      ctx.record.check('relationships discovered from values', relationships.length ? 'pass' : 'warn', relationships.length ? relationships.map((r) => `${r.fromTable}[${r.fromColumn}] → ${r.toTable}[${r.toColumn}]`).join('; ') : 'no fact → dimension key relationships found; pass relationships explicitly')
    }
    const folder = `powerbi/${str(ctx, 'name').replace(/[^A-Za-z0-9 _-]/g, '').trim() || 'Analysis'}`
    const absoluteFolder = ctx.workspace.artifactPath(folder)
    const result = buildPowerBiProject({ name: str(ctx, 'name'), tables, relationships, dataFolder: join(absoluteFolder, 'Data'), ...(Array.isArray(ctx.params.measures) ? { measures: ctx.params.measures as ModelMeasure[] } : {}), ...(ctx.params.noDateTable === true ? { dateTable: false as const } : Array.isArray(ctx.params.dateColumns) ? { dateTable: { columns: ctx.params.dateColumns as Array<{ table: string; column: string }> } } : {}), ...(Array.isArray(ctx.params.pages) ? { pages: ctx.params.pages as PageSpec[] } : {}), ...(typeof ctx.params.audience === 'string' ? { audience: ctx.params.audience } : {}) })
    for (const check of result.checks) ctx.record.check(check.name, check.status, check.detail)
    for (const file of result.files) ctx.artifact(`${folder}/${file.path}`, file.content, file.path.endsWith('.tmdl') ? 'powerbi-tmdl' : file.path.endsWith('.json') || file.path.endsWith('.pbir') || file.path.endsWith('.pbism') || file.path.endsWith('.pbip') ? 'powerbi-json' : 'powerbi')
    for (const table of tables) ctx.artifact(`${folder}/Data/${table.name}.csv`, frameToCsv(table.frame), 'powerbi-data', `${table.name} data`)
    ctx.record.code('dax', result.measures.map((m) => `${m.table}[${m.name}] = ${m.expression}`).join('\n'))
    return { project: ctx.workspace.relative(absoluteFolder), open: `${ctx.workspace.relative(absoluteFolder)}/${str(ctx, 'name').replace(/[^A-Za-z0-9 _-]/g, '').trim()}.pbip`, tables: tables.map((t) => ({ name: t.name, role: t.role, rows: t.frame.rows.length })), relationships: result.relationships, measures: result.measures.map((m) => ({ table: m.table, name: m.name, expression: m.expression })), pages: result.pages.map((p) => ({ name: p.name, visuals: p.visuals.map((v) => `${v.kind}${v.title ? `: ${v.title}` : ''}`) })), limitations: result.limitations }
  },
})

// ---------------------------------------------------------------- records and delivery

registerCapability({
  tool: 'ds_report',
  action: 'records',
  summary: 'list recent execution records, or show one record in full (inputs, code/SQL/DAX, seed, environment, outputs with hashes, checks)',
  effect: 'compute',
  params: { run: { type: 'string', description: 'a run id to show in full' }, limit: { type: 'integer', description: 'how many recent runs to list (default 30)' } },
  run(ctx) {
    if (typeof ctx.params.run === 'string') { const record = ctx.workspace.readRecord(ctx.params.run); ctx.record.check('record read', 'pass', ctx.params.run); return record }
    const records = ctx.workspace.listRecords(typeof ctx.params.limit === 'number' ? ctx.params.limit : 30)
    ctx.record.check('records listed', 'pass', `${records.length}`)
    return { runs: records.map(({ file, record }) => ({ run: record.id, action: `${String(record.tool)}.${String(record.action)}`, status: record.status, at: record.startedAt, inputs: (record.inputs as Array<{ dataset: string }> | undefined)?.map((i) => i.dataset), outputs: record.outputs, file })) }
  },
})

registerCapability({
  tool: 'ds_report',
  action: 'deliver',
  summary: 'assemble the final answer scaffold from the recorded work: Objective, Data, Method, Results, Validation, Limitations, Artifacts — artifacts are listed only if their files still match their recorded hashes',
  effect: 'compute',
  params: { runs: { type: 'array', description: 'run ids to include (default: every run since the active plan was recorded, or the last 25)' } },
  run(ctx) {
    const plan = ctx.workspace.activePlan()
    const all = ctx.workspace.listRecords(1000).map((r) => r.record as unknown as StoredRecord).filter((r) => !(r.tool === 'ds_report' && (r.action === 'deliver' || r.action === 'records')))
    const chosen = Array.isArray(ctx.params.runs) ? all.filter((r) => (ctx.params.runs as unknown[]).map(String).includes(r.id)) : plan ? all.filter((r) => r.startedAt >= plan.createdAt) : all.slice(-25)
    const checks = chosen.flatMap((r) => r.checks.map((c) => ({ ...c, run: r.id, action: `${r.tool}.${r.action}` })))
    const artifacts = ctx.workspace.verifyArtifacts().filter((a) => chosen.some((r) => r.id === a.runId))
    const problems = artifacts.filter((a) => a.status !== 'ok')
    ctx.record.check('artifacts verified', problems.length ? 'warn' : 'pass', problems.length ? `${problems.length} artifact(s) missing or modified since they were written: ${problems.map((p) => p.path).join(', ')}` : `${artifacts.length} artifact(s) match their recorded hashes`)
    const failed = chosen.filter((r) => r.status === 'failed' || r.status === 'error')
    ctx.record.check('all steps validated', failed.length ? 'warn' : 'pass', failed.length ? `${failed.length} step(s) failed: ${failed.map((r) => `${r.tool}.${r.action} ${r.id}`).join(', ')}` : `${chosen.length} step(s)`)
    const datasets = new Map<string, number>()
    for (const r of chosen) for (const input of r.inputs) datasets.set(input.dataset, input.rows)
    return {
      format: 'Answer with: Objective · Data · Method · Results · Validation · Limitations · Artifacts. Use only numbers from these results; say which steps failed.',
      objective: plan?.objective ?? '(no plan recorded — state the objective from the request)',
      data: [...datasets.entries()].map(([dataset, rows]) => ({ dataset, rows })),
      method: chosen.map((r) => ({ run: r.id, action: `${r.tool}.${r.action}`, status: r.status })),
      results: chosen.filter((r) => r.status !== 'error').map((r) => ({ run: r.id, action: `${r.tool}.${r.action}`, summary: summarizeResult(r) })),
      validation: { steps: chosen.length, passed: checks.filter((c) => c.status === 'pass').length, warnings: checks.filter((c) => c.status === 'warn').map((c) => `${c.action}: ${c.name} — ${c.detail}`).slice(0, 25), failures: checks.filter((c) => c.status === 'fail').map((c) => `${c.action}: ${c.name} — ${c.detail}`) },
      limitations: [...new Set(chosen.flatMap((r) => r.warnings))].slice(0, 25),
      // Supporting files (chart data, the parts of a Power BI project) are summarised by their entry point.
      artifacts: artifacts.filter((a) => a.status === 'ok' && (a.path.endsWith('.pbip') || !['chart-data', 'powerbi-tmdl', 'powerbi-json', 'powerbi', 'powerbi-data'].includes(a.kind))).map((a) => ({ path: a.path, kind: a.kind, description: a.description })),
      unverifiedArtifacts: problems.map((a) => ({ path: a.path, status: a.status })),
    }
  },
})

function summarizeResult(record: StoredRecord): Record<string, unknown> {
  const r = record.result ?? {}
  const pick = (...keys: string[]) => Object.fromEntries(keys.filter((k) => r[k] !== undefined).map((k) => [k, r[k]]))
  switch (`${record.tool}.${record.action}`) {
    case 'ds_ml.train': return { model: r.model, primaryMetric: r.primaryMetric, holdout: (r.holdout as { selected: unknown })?.selected, baseline: (r.holdout as { baseline: unknown })?.baseline, selected: r.selected, topDrivers: (r.permutationImportance as unknown[] | undefined)?.slice(0, 5) }
    case 'ds_stats.test': return pick('test', 'statistic', 'pValue', 'effectSize', 'ci', 'interpretation')
    case 'ds_timeseries.forecast': return { method: r.method, selectionReason: r.selectionReason, beatsNaive: r.beatsNaive, forecast: r.forecast }
    case 'ds_analytics.root_cause': return pick('before', 'after', 'change', 'relativeChange', 'findings', 'stoppedBecause')
    case 'ds_data.quality': return { score: r.score, grade: r.grade, topIssues: (r.issues as unknown[] | undefined)?.slice(0, 5) }
    default: {
      const entries = Object.entries(r).filter(([, v]) => typeof v !== 'object' || v === null).slice(0, 12)
      return Object.fromEntries(entries)
    }
  }
}

