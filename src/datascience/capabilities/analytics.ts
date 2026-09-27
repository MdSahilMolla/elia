import { readFileSync } from 'node:fs'
import { resolveWorkspacePath } from '../../autonomy/context.ts'
import { assertSafeFileAccess } from '../../autonomy/sensitivePaths.ts'
import { cohortRetention, customerLifetimeValue, funnel, kpiComparison, rfm, rootCause, type MetricSpec } from '../business.ts'
import { registerCapability } from '../engine.ts'
import { assertColumns, frameFromRows, type Frame } from '../frame.ts'
import { bleu, compareModels, evaluateLabels, exactMatch, grounding, retrievalMetrics, rougeL, structuredOutputValidity, tokenF1, usageProfile } from '../genai.ts'
import { densityGrid, geoDbscan, haversineKm, moransI, nearest, pMedian, spatialJoin, validatePoint, type Point } from '../geo.ts'
import { analyzeGraph, buildGraph, shortestPath } from '../graph.ts'
import { describeModel, solveLp, type LpProblem } from '../opt.ts'
import { createRng } from '../rng.ts'
import { mean } from '../stats/describe.ts'
import { monteCarlo, simulateQueue } from '../simulate.ts'
import { clusterDocuments, detectLanguage, ENTITY_KINDS, extractEntities, extractiveSummary, keywords, search, sentiment, topics } from '../text.ts'
import { barChart, funnelChart, heatmapChart, histogramChart, lineChart, mapChart, networkChart, waterfallChart } from '../viz.ts'
import { isMissing, toNumber, type Row } from '../values.ts'
import { refOf } from '../workspace.ts'
import { DATASET, list, outputName, saveChart, SEED, str, WHERE } from './common.ts'

function metricSpec(value: unknown): MetricSpec {
  if (!value || typeof value !== 'object') throw new Error('metric must be an object like { "kind": "sum", "column": "revenue" } or { "kind": "ratio", "numerator": "orders_converted", "denominator": "visits" }')
  const m = value as Record<string, unknown>
  if (!['sum', 'mean', 'count', 'count_distinct', 'ratio'].includes(String(m.kind))) throw new Error('metric.kind must be sum, mean, count, count_distinct, or ratio')
  return { kind: m.kind as MetricSpec['kind'], ...(typeof m.column === 'string' ? { column: m.column } : {}), ...(typeof m.numerator === 'string' ? { numerator: m.numerator } : {}), ...(typeof m.denominator === 'string' ? { denominator: m.denominator } : {}) }
}

registerCapability({
  tool: 'ds_analytics',
  action: 'root_cause',
  summary: 'explain a metric change: decompose it by each dimension (additive contributions, or mix vs rate effects for averages and ratios), drill recursively into the segment that explains most, and split volume vs value; observed evidence is separated from hypotheses',
  effect: 'compute',
  params: { dataset: DATASET, metric: { type: 'object', required: true, description: '{ "kind": "sum"|"mean"|"count"|"count_distinct"|"ratio", "column": …, "numerator": …, "denominator": … }' }, dimensions: { type: 'string|array', required: true, description: 'candidate dimensions to drill through, e.g. ["region", "product", "segment"]' }, before: { type: 'string', required: true, description: 'filter for the comparison period, e.g. month == "2025-01"' }, after: { type: 'string', required: true, description: 'filter for the period being explained' }, volumeKey: { type: 'string', description: 'sum metrics: count column for a volume × value split (e.g. order_id; "*" counts rows)' }, maxDepth: { type: 'integer', description: 'default 3' }, minShare: { type: 'number', description: 'stop when no segment explains this share (default 0.2)' } },
  example: { action: 'root_cause', dataset: 'sales', metric: { kind: 'sum', column: 'revenue' }, dimensions: ['region', 'product', 'channel'], before: 'quarter == "2025-Q1"', after: 'quarter == "2025-Q2"', volumeKey: 'order_id' },
  run(ctx) {
    const { entry, frame } = ctx.dataset(str(ctx, 'dataset'))
    const result = rootCause(frame, { metric: metricSpec(ctx.params.metric), dimensions: list(ctx.params.dimensions, 'dimensions'), before: str(ctx, 'before'), after: str(ctx, 'after'), ...(typeof ctx.params.maxDepth === 'number' ? { maxDepth: ctx.params.maxDepth } : {}), ...(typeof ctx.params.minShare === 'number' ? { minShare: ctx.params.minShare } : {}), ...(typeof ctx.params.volumeKey === 'string' ? { drivers: { count: ctx.params.volumeKey } } : {}) })
    ctx.record.code('expression', `before: ${result.periods.before}\nafter: ${result.periods.after}`)
    const top = result.levels[0]
    if (top) {
      const segments = top.segments.slice(0, 8)
      const rest = top.segments.slice(8).reduce((t, s) => t + s.contribution, 0)
      ctx.record.check('contributions reconcile', Math.abs(top.segments.reduce((t, s) => t + s.contribution, 0) - top.change) <= 1e-6 * Math.max(1, Math.abs(top.change)) ? 'pass' : 'warn', 'segment contributions sum to the total change')
      const chart = saveChart(ctx, waterfallChart({ title: `${result.metric}: change by ${top.dimension}`, subtitle: `${result.periods.before} → ${result.periods.after}`, start: { label: 'before', value: result.before }, steps: [...segments.map((s) => ({ label: s.segment, value: s.contribution })), ...(Math.abs(rest) > 0 ? [{ label: 'other', value: rest }] : [])], endLabel: 'after' }))
      return { dataset: refOf(entry), ...result, chart }
    }
    ctx.record.check('decomposition', 'warn', result.stoppedBecause)
    return { dataset: refOf(entry), ...result }
  },
})

registerCapability({
  tool: 'ds_analytics',
  action: 'cohorts',
  summary: 'cohort retention matrix (by first-activity period) and optional value per member, with a heatmap',
  effect: 'compute',
  params: { dataset: DATASET, entity: { type: 'string', required: true, description: 'customer/user id' }, time: { type: 'string', required: true, description: 'activity date' }, grain: { type: 'string', enum: ['day', 'week', 'month', 'quarter'], description: 'default month' }, maxPeriods: { type: 'integer', description: 'default 12' }, value: { type: 'string', description: 'value column (e.g. revenue) for value per cohort member' }, where: WHERE },
  run(ctx) {
    const { entry, frame } = ctx.dataset(str(ctx, 'dataset'))
    const result = cohortRetention(frame, { entity: str(ctx, 'entity'), time: str(ctx, 'time'), ...(ctx.params.grain ? { grain: ctx.params.grain as 'month' } : {}), ...(typeof ctx.params.maxPeriods === 'number' ? { maxPeriods: ctx.params.maxPeriods } : {}), ...(typeof ctx.params.value === 'string' ? { value: ctx.params.value } : {}) })
    const shown = result.cohorts.slice(-18)
    const chart = saveChart(ctx, heatmapChart({ title: `Retention by ${result.grain} cohort`, subtitle: 'share of each cohort active k periods after first activity', xLabels: result.averageRetention.map((_, k) => String(k)), yLabels: shown.map((c) => `${c.cohort} (n=${c.size})`), values: shown.map((c) => c.retention), format: 'percent', domain: [0, 1] }))
    ctx.record.check('cohorts built', 'pass', `${result.cohorts.length} cohorts`)
    const small = result.cohorts.filter((c) => c.size < 30).length
    if (small) ctx.record.check('cohort sizes', 'warn', `${small} cohorts have fewer than 30 members; their rates are noisy`)
    return { dataset: refOf(entry), ...result, chart }
  },
})

registerCapability({
  tool: 'ds_analytics',
  action: 'funnel',
  summary: 'conversion funnel from an event log (entity + step column, ordered by time) or from boolean step columns; conversion rates, biggest drop-off, optional per-segment funnels',
  effect: 'compute',
  params: { dataset: DATASET, steps: { type: 'array', required: true, description: 'ordered step names (event values, or boolean column names)' }, entity: { type: 'string', description: 'who performs the steps (event logs)' }, stepColumn: { type: 'string', description: 'event name column (event logs)' }, time: { type: 'string', description: 'event time, to enforce order' }, segment: { type: 'string', description: 'segment column' }, where: WHERE },
  run(ctx) {
    const { entry, frame } = ctx.dataset(str(ctx, 'dataset'))
    const result = funnel(frame, { steps: (ctx.params.steps as unknown[]).map(String), ...(typeof ctx.params.entity === 'string' ? { entity: ctx.params.entity } : {}), ...(typeof ctx.params.stepColumn === 'string' ? { stepColumn: ctx.params.stepColumn } : {}), ...(typeof ctx.params.time === 'string' ? { time: ctx.params.time } : {}), ...(typeof ctx.params.segment === 'string' ? { segment: ctx.params.segment } : {}) })
    ctx.record.expect('funnel is monotone', result.steps.every((s, i) => i === 0 || s.entities <= result.steps[i - 1]!.entities), 'each step has no more entities than the one before')
    const chart = saveChart(ctx, funnelChart({ title: 'Conversion funnel', steps: result.steps.map((s) => ({ label: s.step, value: s.entities })) }))
    return { dataset: refOf(entry), ...result, chart }
  },
})

registerCapability({
  tool: 'ds_analytics',
  action: 'rfm',
  summary: 'RFM customer segmentation (recency, frequency, monetary quintiles and named segments); writes a customer-level dataset',
  effect: 'local-write',
  params: { dataset: DATASET, customer: { type: 'string', required: true, description: 'customer id' }, date: { type: 'string', required: true, description: 'order date' }, amount: { type: 'string', required: true, description: 'order value' }, asOf: { type: 'string', description: 'reference date (default the day after the last order)' }, output: { type: 'string', description: 'output dataset' }, where: WHERE },
  run(ctx) {
    const { entry, frame } = ctx.dataset(str(ctx, 'dataset'))
    const result = rfm(frame, { customer: str(ctx, 'customer'), date: str(ctx, 'date'), amount: str(ctx, 'amount'), ...(typeof ctx.params.asOf === 'string' ? { asOf: ctx.params.asOf } : {}) })
    const saved = ctx.saveDataset(outputName(ctx, `${entry.name}_rfm`), frameFromRows(result.customers as unknown as Row[]), 'rfm', [refOf(entry)], [{ asOf: result.asOf }])
    const chart = saveChart(ctx, barChart({ title: 'Revenue share by RFM segment', categories: result.segments.map((s) => s.segment), series: [{ name: 'revenue share', values: result.segments.map((s) => s.revenueShare) }], format: 'percent', horizontal: true }))
    ctx.record.check('segments assigned', 'pass', `${result.segments.length} segments`)
    return { dataset: refOf(entry), output: refOf(saved), asOf: result.asOf, segments: result.segments, notes: result.notes, chart }
  },
})

registerCapability({
  tool: 'ds_analytics',
  action: 'clv',
  summary: 'customer lifetime value: historical value per customer and a discounted projection from average order value, frequency, retention, and margin (assumptions stated)',
  effect: 'compute',
  params: { dataset: DATASET, customer: { type: 'string', required: true, description: 'customer id' }, date: { type: 'string', required: true, description: 'order date' }, amount: { type: 'string', required: true, description: 'order value' }, margin: { type: 'number', description: 'gross margin share (default 1 = revenue)' }, discountRate: { type: 'number', description: 'annual discount rate (default 0.1)' }, horizonYears: { type: 'integer', description: 'default 5' }, where: WHERE },
  run(ctx) {
    const { entry, frame } = ctx.dataset(str(ctx, 'dataset'))
    const result = customerLifetimeValue(frame, { customer: str(ctx, 'customer'), date: str(ctx, 'date'), amount: str(ctx, 'amount'), ...(typeof ctx.params.margin === 'number' ? { margin: ctx.params.margin } : {}), ...(typeof ctx.params.discountRate === 'number' ? { discountRate: ctx.params.discountRate } : {}), ...(typeof ctx.params.horizonYears === 'number' ? { horizonYears: ctx.params.horizonYears } : {}) })
    ctx.record.check('churn estimable', result.annualChurnRate === null ? 'warn' : 'pass', result.annualChurnRate === null ? 'less than a year of history: no retention-based projection' : `annual churn ${(Number(result.annualChurnRate) * 100).toFixed(1)}%`)
    return { dataset: refOf(entry), ...result }
  },
})

registerCapability({
  tool: 'ds_analytics',
  action: 'kpis',
  summary: 'KPI table by period with period-over-period and year-over-year change and target attainment, plus a trend chart',
  effect: 'compute',
  params: { dataset: DATASET, time: { type: 'string', required: true, description: 'date column' }, measures: { type: 'array', required: true, description: '[{ "name": "Revenue", "metric": { "kind": "sum", "column": "amount" }, "target": 100000 }]' }, grain: { type: 'string', enum: ['day', 'week', 'month', 'quarter', 'year'], description: 'default month' }, periods: { type: 'integer', description: 'periods to show (default 13)' }, where: WHERE },
  run(ctx) {
    const { entry, frame } = ctx.dataset(str(ctx, 'dataset'))
    const measures = (ctx.params.measures as Array<Record<string, unknown>>).map((m) => ({ name: String(m.name), metric: metricSpec(m.metric), ...(typeof m.target === 'number' ? { target: m.target } : {}) }))
    const result = kpiComparison(frame, { time: str(ctx, 'time'), measures, ...(ctx.params.grain ? { grain: ctx.params.grain as 'month' } : {}), ...(typeof ctx.params.periods === 'number' ? { periods: ctx.params.periods } : {}) })
    const chart = saveChart(ctx, lineChart({ title: `${result.kpis[0]!.name} by ${result.grain}`, x: result.periods, series: [{ name: result.kpis[0]!.name, values: result.kpis[0]!.values }], zeroBaseline: true }))
    ctx.record.check('KPIs computed', 'pass', `${measures.length} measures over ${result.periods.length} periods`)
    return { dataset: refOf(entry), ...result, chart }
  },
})

registerCapability({
  tool: 'ds_analytics',
  action: 'simulate',
  summary: 'Monte Carlo simulation of a formula over uncertain inputs (normal, lognormal, uniform, triangular, pert, beta, poisson, bernoulli, discrete, empirical), with percentiles, threshold probabilities, tornado sensitivity, and named scenarios',
  effect: 'compute',
  params: { variables: { type: 'object', required: true, description: '{ "units": { "dist": "normal", "mean": 1000, "sd": 150 }, "price": { "dist": "triangular", "min": 8, "mode": 10, "max": 13 } }' }, outputs: { type: 'object', required: true, description: '{ "profit": "units * (price - unit_cost) - fixed_cost" }' }, iterations: { type: 'integer', description: 'default 10,000' }, thresholds: { type: 'object', description: '{ "profit": [0, 50000] } → P(profit < threshold)' }, scenarios: { type: 'object', description: '{ "downside": { "units": 700 } } evaluated with other inputs at their medians' }, empiricalFrom: { type: 'object', description: '{ "variable": "dataset.column" } to resample observed data' }, seed: SEED },
  run(ctx) {
    const variables = { ...(ctx.params.variables as Record<string, unknown>) }
    for (const [name, ref] of Object.entries((ctx.params.empiricalFrom as Record<string, string>) ?? {})) {
      const [dataset, column] = String(ref).split('.')
      const { frame } = ctx.dataset(dataset!, { where: '' })
      assertColumns(frame, [column!], 'empiricalFrom')
      variables[name] = { dist: 'empirical', values: frame.rows.map((r) => toNumber(r[column!])).filter((v): v is number => v !== undefined) }
    }
    const seed = typeof ctx.params.seed === 'number' ? ctx.params.seed : 42
    ctx.record.seed(seed)
    const result = monteCarlo({ variables, outputs: ctx.params.outputs as Record<string, string>, seed, ...(typeof ctx.params.iterations === 'number' ? { iterations: ctx.params.iterations } : {}), ...(ctx.params.thresholds ? { thresholds: ctx.params.thresholds as Record<string, number[]> } : {}), ...(ctx.params.scenarios ? { scenarios: ctx.params.scenarios as Record<string, Record<string, number>> } : {}) })
    ctx.record.code('expression', Object.entries(ctx.params.outputs as Record<string, string>).map(([k, v]) => `${k} = ${v}`).join('\n'))
    const [first] = Object.keys(result.outputs)
    const summary = result.outputs[first!]!
    const charts = [saveChart(ctx, barChart({ title: `Distribution of ${first}`, subtitle: `${result.iterations} simulations, seed ${seed}`, categories: summary.histogram.counts.map((_, i) => summary.histogram.edges[i]!.toPrecision(3)), series: [{ name: 'simulations', values: summary.histogram.counts }], valueLabels: false }))]
    const tornado = result.sensitivity.filter((s) => s.output === first).slice(0, 10)
    if (tornado.length) charts.push(saveChart(ctx, barChart({ title: `What moves ${first} most`, subtitle: 'swing from each input’s P10 to P90, others at their medians', categories: tornado.map((t) => t.variable), series: [{ name: 'swing', values: tornado.map((t) => t.swing) }], horizontal: true })))
    ctx.record.check('simulation ran', 'pass', `${result.iterations} iterations`)
    return { ...result, outputs: Object.fromEntries(Object.entries(result.outputs).map(([k, v]) => [k, { ...v, histogram: undefined }])), charts }
  },
})

registerCapability({
  tool: 'ds_analytics',
  action: 'queue',
  summary: 'discrete-event M/M/c queue simulation (waits, utilisation) checked against the analytic Erlang-C result',
  effect: 'compute',
  params: { arrivalRate: { type: 'number', required: true, description: 'arrivals per unit time' }, serviceRate: { type: 'number', required: true, description: 'services per server per unit time' }, servers: { type: 'integer', required: true, description: 'number of servers' }, duration: { type: 'number', description: 'simulated time (default 10,000)' }, seed: SEED },
  run(ctx) {
    const seed = typeof ctx.params.seed === 'number' ? ctx.params.seed : 42
    ctx.record.seed(seed)
    const result = simulateQueue({ arrivalRate: Number(ctx.params.arrivalRate), serviceRate: Number(ctx.params.serviceRate), servers: Number(ctx.params.servers), duration: typeof ctx.params.duration === 'number' ? ctx.params.duration : 10_000, seed }) as { meanWait: number; analytic: { meanWait: number; utilization: number } }
    const gap = Math.abs(result.meanWait - result.analytic.meanWait) / Math.max(1e-9, result.analytic.meanWait)
    ctx.record.check('simulation agrees with Erlang C', Number.isFinite(result.analytic.meanWait) ? (gap < 0.15 ? 'pass' : 'warn') : 'warn', Number.isFinite(result.analytic.meanWait) ? `mean wait ${result.meanWait.toPrecision(3)} vs analytic ${result.analytic.meanWait.toPrecision(3)}` : 'unstable queue (arrivals exceed capacity)')
    return result
  },
})

registerCapability({
  tool: 'ds_analytics',
  action: 'optimize',
  summary: 'linear / integer / mixed-integer programming: Objective → Variables → Constraints → Solution → Sensitivity (shadow prices, reduced costs, binding constraints)',
  effect: 'compute',
  params: { problem: { type: 'object', required: true, description: '{ "sense": "max", "objective": { "x": 3, "y": 5 }, "variables": [{ "name": "x", "upper": 4 }, { "name": "y", "integer": true }], "constraints": [{ "name": "capacity", "coefficients": { "x": 3, "y": 2 }, "sense": "<=", "rhs": 18 }] }' }, nodeLimit: { type: 'integer', description: 'branch-and-bound node limit (default 20,000)' } },
  run(ctx) {
    const problem = ctx.params.problem as LpProblem
    if (!problem || !Array.isArray(problem.variables) || !Array.isArray(problem.constraints) || typeof problem.objective !== 'object') throw new Error('problem needs sense, objective, variables, and constraints')
    const formulation = describeModel(problem)
    ctx.record.code('expression', formulation.join('\n'))
    const solution = solveLp(problem, typeof ctx.params.nodeLimit === 'number' ? { nodeLimit: ctx.params.nodeLimit } : {})
    ctx.record.check('solver status', solution.status === 'optimal' ? 'pass' : 'fail', solution.status)
    if (solution.status === 'optimal') {
      const violated = problem.constraints.filter((c) => { const a = Object.entries(c.coefficients).reduce((t, [n, v]) => t + v * solution.values[n]!, 0); return c.sense === '<=' ? a > c.rhs + 1e-6 : c.sense === '>=' ? a < c.rhs - 1e-6 : Math.abs(a - c.rhs) > 1e-6 })
      ctx.record.expect('solution satisfies every constraint', violated.length === 0, violated.length ? `violated: ${violated.map((c) => c.name ?? '?').join(', ')}` : `${problem.constraints.length} constraints satisfied`)
    }
    return { formulation, ...solution }
  },
})

registerCapability({
  tool: 'ds_analytics',
  action: 'graph',
  summary: 'network analysis on an edge list: degree, PageRank, betweenness, components, Louvain communities/modularity, bridges, degree outliers, shortest path; writes node metrics',
  effect: 'local-write',
  params: { dataset: DATASET, source: { type: 'string', required: true, description: 'source node column' }, target: { type: 'string', required: true, description: 'target node column' }, weight: { type: 'string', description: 'edge weight column' }, directed: { type: 'boolean', description: 'default false' }, path: { type: 'array', description: '[from, to] nodes for a shortest path' }, output: { type: 'string', description: 'node-metrics dataset name' }, seed: SEED, where: WHERE },
  run(ctx) {
    const { entry, frame } = ctx.dataset(str(ctx, 'dataset'))
    const source = str(ctx, 'source'); const target = str(ctx, 'target')
    assertColumns(frame, [source, target], 'graph')
    const weight = typeof ctx.params.weight === 'string' ? ctx.params.weight : undefined
    const edges = frame.rows.filter((r) => !isMissing(r[source]) && !isMissing(r[target])).map((r) => ({ source: String(r[source]), target: String(r[target]), ...(weight ? { weight: toNumber(r[weight]) ?? 1 } : {}) }))
    const graph = buildGraph(edges, ctx.params.directed === true)
    const seed = typeof ctx.params.seed === 'number' ? ctx.params.seed : 42
    ctx.record.seed(seed)
    const result = analyzeGraph(graph, { weighted: Boolean(weight), seed }) as Record<string, unknown> & { labels: { communities: number[]; components: number[]; pagerank: number[]; betweenness: number[]; degree: number[] } }
    const { labels, ...summary } = result
    const nodes = graph.nodes.map((node, i) => ({ node, degree: labels.degree[i]!, pagerank: labels.pagerank[i]!, betweenness: labels.betweenness[i]!, community: labels.communities[i]!, component: labels.components[i]! }))
    const saved = ctx.saveDataset(outputName(ctx, `${entry.name}_nodes`), frameFromRows(nodes), 'graph', [refOf(entry)], [{ source, target, weight, directed: ctx.params.directed === true }])
    let path: unknown
    if (Array.isArray(ctx.params.path) && ctx.params.path.length === 2) path = shortestPath(graph, String(ctx.params.path[0]), String(ctx.params.path[1]), Boolean(weight)) ?? 'no path'
    const top = [...nodes].sort((a, b) => b.pagerank - a.pagerank).slice(0, 150)
    const topSet = new Set(top.map((n) => n.node))
    const chart = saveChart(ctx, networkChart({ title: 'Network communities', subtitle: `${graph.nodes.length} nodes, ${graph.edgeCount} edges`, nodes: top.map((n) => ({ id: n.node, group: n.community, size: n.pagerank })), edges: edges.filter((e) => topSet.has(e.source) && topSet.has(e.target)).slice(0, 2000), seed }))
    ctx.record.check('graph analysed', 'pass', `${graph.nodes.length} nodes, modularity ${(summary.communities as { modularity: number }).modularity.toFixed(3)}`)
    return { dataset: refOf(entry), output: refOf(saved), ...summary, ...(path ? { shortestPath: path } : {}), chart }
  },
})

function points(frame: Frame, lat: string, lon: string): { points: Point[]; rows: number[]; invalid: number } {
  const out: Point[] = []
  const rows: number[] = []
  let invalid = 0
  frame.rows.forEach((row, i) => { const p = validatePoint(toNumber(row[lat]), toNumber(row[lon])); if (p) { out.push(p); rows.push(i) } else invalid++ })
  return { points: out, rows, invalid }
}

registerCapability({
  tool: 'ds_analytics',
  action: 'geo',
  summary: 'geospatial analysis on lat/lon: distances, nearest facility, DBSCAN clusters (km), density grid, GeoJSON spatial join, p-median site selection, Moran I spatial autocorrelation; with a map',
  effect: 'local-write',
  params: { dataset: DATASET, lat: { type: 'string', required: true, description: 'latitude column' }, lon: { type: 'string', required: true, description: 'longitude column' }, operation: { type: 'string', required: true, enum: ['clusters', 'nearest', 'density', 'join', 'pmedian', 'moran', 'distance_matrix'], description: 'analysis' }, facilities: { type: 'string', description: 'dataset of facilities/candidate sites (with the same lat/lon column names) for nearest and pmedian' }, facilityId: { type: 'string', description: 'id column in the facilities dataset' }, geojson: { type: 'string', description: 'workspace GeoJSON file of polygons for join' }, property: { type: 'string', description: 'GeoJSON property to assign in join' }, value: { type: 'string', description: 'value column (moran, density, pmedian weights)' }, epsKm: { type: 'number', description: 'cluster radius in km (default 5)' }, minPoints: { type: 'integer', description: 'default 5' }, k: { type: 'integer', description: 'sites to choose (pmedian)' }, bandKm: { type: 'number', description: 'neighbour distance for moran (default 50)' }, cellDegrees: { type: 'number', description: 'grid size (default 0.1)' }, output: { type: 'string', description: 'output dataset' }, where: WHERE },
  run(ctx) {
    const { entry, frame } = ctx.dataset(str(ctx, 'dataset'))
    const lat = str(ctx, 'lat'); const lon = str(ctx, 'lon')
    assertColumns(frame, [lat, lon], 'geo')
    const operation = str(ctx, 'operation')
    const { points: pts, rows, invalid } = points(frame, lat, lon)
    ctx.record.check('valid coordinates', invalid / Math.max(1, frame.rows.length) > 0.05 ? 'warn' : 'pass', `${pts.length} valid points; ${invalid} missing, out of range, or at 0,0 (excluded)`)
    const values = typeof ctx.params.value === 'string' ? rows.map((i) => toNumber(frame.rows[i]![ctx.params.value as string]) ?? 0) : undefined
    const facilities = () => {
      const f = ctx.dataset(str(ctx, 'facilities'), { where: '' }).frame
      const id = str(ctx, 'facilityId')
      assertColumns(f, [id, lat, lon], 'facilities')
      return f.rows.map((r) => ({ ...validatePoint(toNumber(r[lat]), toNumber(r[lon]))!, id: String(r[id]) })).filter((p) => p.lat !== undefined)
    }
    let result: Record<string, unknown>
    let outRows: Row[] | undefined
    if (operation === 'clusters') {
      const r = geoDbscan(pts, typeof ctx.params.epsKm === 'number' ? ctx.params.epsKm : 5, typeof ctx.params.minPoints === 'number' ? ctx.params.minPoints : 5)
      result = { clusters: r.clusters, noise: r.noise }
      outRows = frame.rows.map((row, i) => { const j = rows.indexOf(i); return { ...row, geo_cluster: j < 0 ? null : r.labels[j] === -1 ? 'noise' : `g${r.labels[j]}` } })
    } else if (operation === 'nearest') {
      const r = nearest(pts, facilities())
      result = { averageKm: mean(r.map((x) => x.distanceKm)), maxKm: Math.max(...r.map((x) => x.distanceKm)) }
      outRows = frame.rows.map((row, i) => { const j = rows.indexOf(i); return { ...row, nearest_facility: j < 0 ? null : r[j]!.facility, distance_km: j < 0 ? null : r[j]!.distanceKm } })
    } else if (operation === 'density') {
      result = { cells: densityGrid(pts, typeof ctx.params.cellDegrees === 'number' ? ctx.params.cellDegrees : 0.1, values).slice(0, 200) }
    } else if (operation === 'join') {
      const path = resolveWorkspacePath(str(ctx, 'geojson'))
      assertSafeFileAccess(path)
      const labels = spatialJoin(pts, JSON.parse(readFileSync(path, 'utf8')), str(ctx, 'property'))
      const matched = labels.filter((l) => l !== null).length
      ctx.record.check('points matched to polygons', matched / Math.max(1, pts.length) < 0.8 ? 'warn' : 'pass', `${matched} of ${pts.length} points fall inside a polygon`)
      result = { matched, unmatched: pts.length - matched }
      outRows = frame.rows.map((row, i) => { const j = rows.indexOf(i); return { ...row, [str(ctx, 'property')]: j < 0 ? null : labels[j] ?? null } })
    } else if (operation === 'pmedian') {
      const r = pMedian(pts.map((p, i) => ({ ...p, ...(values ? { weight: values[i]! } : {}) })), facilities(), Number(ctx.params.k ?? 1))
      result = { chosen: r.chosen, averageKm: r.averageKm, totalWeightedKm: r.totalWeightedKm, method: 'greedy start + swap improvement (a local optimum; verify with alternative starts for high-stakes siting)' }
    } else if (operation === 'moran') {
      if (!values) throw new Error('moran needs value')
      result = moransI(pts, values, typeof ctx.params.bandKm === 'number' ? ctx.params.bandKm : 50)
    } else {
      const sample = pts.slice(0, 50)
      result = { note: 'first 50 points', matrixKm: sample.map((a) => sample.map((b) => haversineKm(a, b))) }
    }
    let output: string | undefined
    if (outRows) output = refOf(ctx.saveDataset(outputName(ctx, `${entry.name}_${operation}`), frameFromRows(outRows), `geo.${operation}`, [refOf(entry)], [{ operation, lat, lon }]))
    const chart = saveChart(ctx, mapChart({ title: `Locations (${operation})`, points: pts.slice(0, 3000).map((p, i) => ({ ...p, ...(values ? { value: values[i]! } : {}) })) }))
    ctx.record.check('geo analysis', 'pass', operation)
    return { dataset: refOf(entry), operation, ...result, ...(output ? { output } : {}), chart }
  },
})

registerCapability({
  tool: 'ds_analytics',
  action: 'text',
  summary: 'text analytics on a column: keywords (TF-IDF, optionally by group), sentiment (lexicon baseline), language, NMF topics, document clusters, lexical search, extractive summary, pattern entities (emails, money, dates, …)',
  effect: 'local-write',
  params: { dataset: DATASET, column: { type: 'string', required: true, description: 'text column' }, operation: { type: 'string', required: true, enum: ['keywords', 'sentiment', 'language', 'topics', 'cluster', 'search', 'summary', 'entities'], description: 'analysis' }, groupBy: { type: 'string', description: 'keywords per group' }, k: { type: 'integer', description: 'topics/clusters (default 5)' }, query: { type: 'string', description: 'search query' }, kinds: { type: 'array', description: `entity kinds: ${ENTITY_KINDS.join(', ')}` }, output: { type: 'string', description: 'dataset with added columns (sentiment, language, topic, cluster)' }, seed: SEED, where: WHERE },
  run(ctx) {
    const { entry, frame } = ctx.dataset(str(ctx, 'dataset'))
    const column = str(ctx, 'column')
    assertColumns(frame, [column], 'column')
    const docs = frame.rows.map((r) => (typeof r[column] === 'string' ? (r[column] as string) : r[column] === null ? '' : String(r[column])))
    const operation = str(ctx, 'operation')
    const seed = typeof ctx.params.seed === 'number' ? ctx.params.seed : 42
    const k = typeof ctx.params.k === 'number' ? ctx.params.k : 5
    let result: Record<string, unknown>
    let added: Array<Record<string, unknown>> | undefined
    switch (operation) {
      case 'keywords': result = { keywords: keywords(docs, 20, typeof ctx.params.groupBy === 'string' ? frame.rows.map((r) => String(r[ctx.params.groupBy as string] ?? '(missing)')) : undefined) }; break
      case 'sentiment': {
        const scores = docs.map(sentiment)
        added = scores.map((s) => ({ sentiment_score: s.score, sentiment_label: s.label }))
        result = { method: 'lexicon baseline with negation and intensifiers — transparent but coarse; sarcasm, domain terms, and non-English text are missed. Validate on a labelled sample (ds_analytics llm_eval labels) before relying on it.', distribution: ['positive', 'neutral', 'negative'].map((label) => ({ label, share: scores.filter((s) => s.label === label).length / Math.max(1, scores.length) })), meanScore: mean(scores.map((s) => s.score)) }
        ctx.record.check('sentiment method', 'warn', 'lexicon baseline: validate against labelled examples')
        break
      }
      case 'language': { const langs = docs.map(detectLanguage); added = langs.map((l) => ({ language: l.language })); const counts = new Map<string, number>(); for (const l of langs) counts.set(l.language, (counts.get(l.language) ?? 0) + 1); result = { languages: [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([language, count]) => ({ language, count })), method: langs[0]?.method }; break }
      case 'topics': { const t = topics(docs, k, createRng(seed)); added = t.assignments.map((a) => ({ topic: a })); result = { topics: t.topics, method: t.method }; break }
      case 'cluster': { const c = clusterDocuments(docs, k, createRng(seed)); added = c.labels.map((l) => ({ text_cluster: `t${l}` })); result = { clusters: c.clusters }; break }
      case 'search': result = { hits: search(docs, str(ctx, 'query')).map((h) => ({ ...h, row: h.index })), method: 'TF-IDF cosine (lexical, not semantic)' }; break
      case 'summary': result = extractiveSummary(docs.join(' '), k); break
      case 'entities': { const kinds = Array.isArray(ctx.params.kinds) ? (ctx.params.kinds as string[]) : undefined; result = { entities: extractEntities(docs.join('\n'), kinds), method: 'regular-expression patterns, not named-entity recognition' }; break }
      default: throw new Error(`unknown operation ${operation}`)
    }
    let output: string | undefined
    if (added) output = refOf(ctx.saveDataset(outputName(ctx, `${entry.name}_${operation}`), frameFromRows(frame.rows.map((row, i) => ({ ...row, ...(added![i] as Row) }))), `text.${operation}`, [refOf(entry)], [{ column, operation, k, seed }]))
    if (operation === 'sentiment') result.chart = saveChart(ctx, histogramChart({ title: 'Sentiment scores', values: added!.map((a) => Number(a.sentiment_score)) }))
    ctx.record.check('text processed', 'pass', `${docs.filter(Boolean).length} non-empty documents`)
    return { dataset: refOf(entry), operation, ...result, ...(output ? { output } : {}) }
  },
})

registerCapability({
  tool: 'ds_analytics',
  action: 'llm_eval',
  summary: 'evaluate LLM / GenAI outputs against references: labels (classification metrics), qa (exact match, token F1), generation (ROUGE-L, BLEU), grounding (answers vs context; unsupported numbers), retrieval (recall/MRR/NDCG@k), structured (JSON validity vs schema), compare (McNemar + paired bootstrap), usage (tokens, latency, cost)',
  effect: 'compute',
  params: { dataset: DATASET, operation: { type: 'string', required: true, enum: ['labels', 'qa', 'generation', 'grounding', 'retrieval', 'structured', 'compare', 'usage'], description: 'evaluation' }, prediction: { type: 'string', description: 'model output column' }, reference: { type: 'string', description: 'gold/reference column' }, context: { type: 'string', description: 'retrieved context column (grounding)' }, retrieved: { type: 'string', description: 'retrieved ids column (JSON array or comma list)' }, relevant: { type: 'string', description: 'relevant ids column' }, k: { type: 'integer', description: 'cut-off for retrieval (default 10)' }, schema: { type: 'object', description: 'structured: { "required": [...], "types": { "field": "string" }, "enums": {...} }' }, correctA: { type: 'string', description: 'compare: 0/1 correctness column for model A' }, correctB: { type: 'string', description: 'compare: 0/1 correctness column for model B' }, group: { type: 'string', description: 'usage: model/prompt column' }, inputTokens: { type: 'string', description: 'usage column' }, outputTokens: { type: 'string', description: 'usage column' }, latencyMs: { type: 'string', description: 'usage column' }, cost: { type: 'string', description: 'usage column' }, seed: SEED, where: WHERE },
  run(ctx) {
    const { entry, frame } = ctx.dataset(str(ctx, 'dataset'))
    const operation = str(ctx, 'operation')
    const col = (name: string) => { const c = str(ctx, name); assertColumns(frame, [c], name); return frame.rows.map((r) => (r[c] === null || r[c] === undefined ? '' : String(r[c]))) }
    let result: Record<string, unknown>
    if (operation === 'labels') result = evaluateLabels(col('prediction'), col('reference'))
    else if (operation === 'qa') { const p = col('prediction'); const r = col('reference'); result = { exactMatch: mean(p.map((x, i) => exactMatch(x, r[i]!))), tokenF1: mean(p.map((x, i) => tokenF1(x, r[i]!))), n: p.length } }
    else if (operation === 'generation') { const p = col('prediction'); const r = col('reference'); result = { rougeL: mean(p.map((x, i) => rougeL(x, r[i]!))), bleu: mean(p.map((x, i) => bleu(x, [r[i]!]))), n: p.length, note: 'overlap metrics reward wording similar to the reference; they do not measure factual correctness' } }
    else if (operation === 'grounding') {
      const p = col('prediction'); const c = col('context')
      const g = p.map((x, i) => grounding(x, c[i]!))
      const withNumbers = g.filter((x) => x.numberSupport !== null)
      result = { meanTokenSupport: mean(g.map((x) => x.tokenSupport)), answersWithUnsupportedNumbers: g.filter((x) => x.unsupportedNumbers.length).length, numberSupportRate: withNumbers.length ? mean(withNumbers.map((x) => x.numberSupport!)) : null, examples: g.map((x, i) => ({ row: i, unsupported: x.unsupportedNumbers })).filter((x) => x.unsupported.length).slice(0, 10), note: 'lexical grounding is a proxy for hallucination: a supported number can still be misused, and a paraphrase can look unsupported' }
      ctx.record.check('unsupported numbers', (result.answersWithUnsupportedNumbers as number) > 0 ? 'warn' : 'pass', `${String(result.answersWithUnsupportedNumbers)} answers state numbers absent from their context`)
    } else if (operation === 'retrieval') {
      const parseIds = (s: string) => { try { const v = JSON.parse(s); return Array.isArray(v) ? v.map(String) : [String(v)] } catch { return s.split(',').map((x) => x.trim()).filter(Boolean) } }
      const retrieved = col('retrieved').map(parseIds); const relevant = col('relevant').map(parseIds)
      result = retrievalMetrics(retrieved.map((r, i) => ({ retrieved: r, relevant: relevant[i]! })), typeof ctx.params.k === 'number' ? ctx.params.k : 10)
    } else if (operation === 'structured') result = structuredOutputValidity(col('prediction'), (ctx.params.schema as Record<string, never>) ?? {})
    else if (operation === 'compare') {
      const a = col('correctA').map((x) => x === '1' || x === 'true'); const b = col('correctB').map((x) => x === '1' || x === 'true')
      result = compareModels(a, b, typeof ctx.params.seed === 'number' ? ctx.params.seed : 42)
    } else {
      const groupCol = str(ctx, 'group')
      const pick = (name: string) => (typeof ctx.params[name] === 'string' ? (r: Row) => toNumber(r[ctx.params[name] as string]) : () => undefined)
      const [inT, outT, lat, cost] = ['inputTokens', 'outputTokens', 'latencyMs', 'cost'].map(pick)
      result = { groups: usageProfile(frame.rows.map((r) => ({ group: String(r[groupCol] ?? '(missing)'), ...(inT!(r) !== undefined ? { inputTokens: inT!(r) } : {}), ...(outT!(r) !== undefined ? { outputTokens: outT!(r) } : {}), ...(lat!(r) !== undefined ? { latencyMs: lat!(r) } : {}), ...(cost!(r) !== undefined ? { cost: cost!(r) } : {}) }))) }
    }
    ctx.record.check('evaluated', 'pass', `${operation} on ${frame.rows.length} rows`)
    return { dataset: refOf(entry), operation, ...result, reminder: 'LLM outputs are probabilistic; report these scores with their sample size and re-evaluate after prompt or model changes.' }
  },
})
