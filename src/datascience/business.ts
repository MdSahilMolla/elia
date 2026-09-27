import { compileExpression } from './expr.ts'
import { assertColumns, type Frame } from './frame.ts'
import { mean, median, quantileSorted, sum } from './stats/describe.ts'
import { isMissing, isoDate, scalarKey, toDateMs, toNumber, type Scalar } from './values.ts'

/**
 * Business analytics: root-cause decomposition of a metric change, cohort retention,
 * funnels, RFM segmentation, customer lifetime value, and KPI period comparisons. Findings
 * are observed decompositions of the data; they say where a change happened, not why —
 * explanations beyond the data are returned separately as hypotheses to test.
 */

type Row = Record<string, Scalar>

export interface MetricSpec {
  /** "sum" of a column, "mean" of a column, "count" of rows, "count_distinct" of a column, or "ratio" of two sums. */
  kind: 'sum' | 'mean' | 'count' | 'count_distinct' | 'ratio'
  column?: string
  numerator?: string
  denominator?: string
}

function metricOf(rows: Row[], metric: MetricSpec): number {
  switch (metric.kind) {
    case 'count': return rows.length
    case 'count_distinct': return new Set(rows.map((row) => scalarKey(row[metric.column!] ?? null))).size
    case 'sum': return sum(rows.map((row) => toNumber(row[metric.column!]) ?? 0))
    case 'mean': { const values = rows.map((row) => toNumber(row[metric.column!])).filter((v): v is number => v !== undefined); return values.length ? mean(values) : Number.NaN }
    case 'ratio': { const d = sum(rows.map((row) => toNumber(row[metric.denominator!]) ?? 0)); return d === 0 ? Number.NaN : sum(rows.map((row) => toNumber(row[metric.numerator!]) ?? 0)) / d }
  }
}

function weightOf(rows: Row[], metric: MetricSpec): number {
  if (metric.kind === 'ratio') return sum(rows.map((row) => toNumber(row[metric.denominator!]) ?? 0))
  if (metric.kind === 'mean') return rows.filter((row) => toNumber(row[metric.column!]) !== undefined).length
  return rows.length
}

export interface SegmentContribution {
  segment: string
  before: number
  after: number
  change: number
  contribution: number
  shareOfChange: number
  /** What this segment would contribute if the change were spread in proportion to its size. */
  expected: number
  /** contribution − expected: the part of the change this segment's size does not explain. */
  excess: number
  mixEffect?: number
  rateEffect?: number
  rowsBefore: number
  rowsAfter: number
}

export interface DrillLevel {
  path: string[]
  dimension: string
  metricBefore: number
  metricAfter: number
  change: number
  /** Σ|excess| / |change|: how far the change departs from proportional (0 = spread evenly by size). */
  surprise: number
  segments: SegmentContribution[]
}

export interface RootCauseResult {
  metric: string
  periods: { before: string; after: string }
  before: number
  after: number
  change: number
  relativeChange: number
  driverDecomposition?: Array<{ driver: string; before: number; after: number; logContribution: number; shareOfChange: number }>
  levels: DrillLevel[]
  dimensionRanking: Array<{ dimension: string; surprise: number; topSegment: string; topShare: number }>
  findings: string[]
  hypotheses: string[]
  stoppedBecause: string
}

function describeMetric(metric: MetricSpec): string {
  return metric.kind === 'ratio' ? `${metric.numerator} / ${metric.denominator}` : metric.kind === 'count' ? 'row count' : `${metric.kind}(${metric.column})`
}

/** Contribution of each segment to the metric change. Additive metrics split exactly; means and ratios split into mix and rate effects. */
function decomposeBy(before: Row[], after: Row[], dimension: string, metric: MetricSpec): SegmentContribution[] {
  const groups = new Map<string, { b: Row[]; a: Row[] }>()
  for (const row of before) { const key = String(row[dimension] ?? '(missing)'); const g = groups.get(key) ?? { b: [], a: [] }; g.b.push(row); groups.set(key, g) }
  for (const row of after) { const key = String(row[dimension] ?? '(missing)'); const g = groups.get(key) ?? { b: [], a: [] }; g.a.push(row); groups.set(key, g) }
  const totalChange = metricOf(after, metric) - metricOf(before, metric)
  const totalBefore = metricOf(before, metric)
  const additive = metric.kind === 'sum' || metric.kind === 'count'
  const wB = weightOf(before, metric)
  const wA = weightOf(after, metric)
  const out: SegmentContribution[] = []
  for (const [segment, g] of groups) {
    const valueB = g.b.length ? metricOf(g.b, metric) : 0
    const valueA = g.a.length ? metricOf(g.a, metric) : 0
    let contribution: number
    let mixEffect: number | undefined
    let rateEffect: number | undefined
    if (additive || metric.kind === 'count_distinct') contribution = valueA - valueB
    else {
      const shareB = wB ? weightOf(g.b, metric) / wB : 0
      const shareA = wA ? weightOf(g.a, metric) / wA : 0
      const rB = g.b.length && Number.isFinite(valueB) ? valueB : 0
      const rA = g.a.length && Number.isFinite(valueA) ? valueA : 0
      const overallB = metricOf(before, metric)
      mixEffect = (shareA - shareB) * (rB - (Number.isFinite(overallB) ? overallB : 0))
      rateEffect = shareA * (rA - rB) * (g.b.length && g.a.length ? 1 : 0)
      contribution = mixEffect + rateEffect
    }
    const sizeShare = additive || metric.kind === 'count_distinct' ? (totalBefore === 0 ? 0 : valueB / totalBefore) : wB ? weightOf(g.b, metric) / wB : 0
    const expected = sizeShare * totalChange
    out.push({ segment, before: valueB, after: valueA, change: valueA - valueB, contribution, shareOfChange: totalChange === 0 ? 0 : contribution / totalChange, expected, excess: contribution - expected, ...(mixEffect !== undefined ? { mixEffect, rateEffect } : {}), rowsBefore: g.b.length, rowsAfter: g.a.length })
  }
  return out.sort((x, y) => Math.abs(y.excess) - Math.abs(x.excess))
}

export function rootCause(frame: Frame, input: { metric: MetricSpec; dimensions: string[]; before: string; after: string; maxDepth?: number; minShare?: number; minRows?: number; drivers?: { count?: string; value?: string } }): RootCauseResult {
  const columns = [input.metric.column, input.metric.numerator, input.metric.denominator].filter((c): c is string => typeof c === 'string')
  assertColumns(frame, [...columns, ...input.dimensions], 'root cause')
  const beforeFilter = compileExpression(input.before, frame.columns)
  const afterFilter = compileExpression(input.after, frame.columns)
  const before = frame.rows.filter((row) => beforeFilter.test(row))
  const after = frame.rows.filter((row) => afterFilter.test(row))
  if (!before.length || !after.length) throw new Error(`the periods must both contain rows (before: ${before.length}, after: ${after.length})`)
  const mB = metricOf(before, input.metric)
  const mA = metricOf(after, input.metric)
  const change = mA - mB
  const maxDepth = input.maxDepth ?? 3
  const minShare = input.minShare ?? 0.2
  const minRows = input.minRows ?? 30
  const levels: DrillLevel[] = []
  const findings: string[] = []
  let stoppedBecause = `reached the maximum depth of ${maxDepth}`
  let scopeB = before
  let scopeA = after
  let remaining = [...input.dimensions]
  const path: string[] = []
  const ranking: RootCauseResult['dimensionRanking'] = []
  for (let depth = 0; depth < maxDepth; depth++) {
    if (!remaining.length) { stoppedBecause = 'no dimensions left to split by'; break }
    if (scopeB.length + scopeA.length < minRows) { stoppedBecause = `the segment has only ${scopeB.length + scopeA.length} rows (< ${minRows}); splitting further would chase noise`; break }
    const scopeChange = metricOf(scopeA, input.metric) - metricOf(scopeB, input.metric)
    if (scopeChange === 0 || !Number.isFinite(scopeChange)) { stoppedBecause = 'the segment metric did not change'; break }
    const candidates = remaining.map((dimension) => {
      const segments = decomposeBy(scopeB, scopeA, dimension, input.metric)
      // Ranking by raw concentration favours dimensions with few levels; surprise asks which
      // dimension's segments moved out of proportion to their size (Adtributor-style).
      const surprise = segments.reduce((total, s) => total + Math.abs(s.excess), 0) / Math.max(1e-12, Math.abs(scopeChange))
      return { dimension, segments, surprise }
    })
    candidates.sort((a, b) => b.surprise - a.surprise)
    if (depth === 0) for (const c of candidates) ranking.push({ dimension: c.dimension, surprise: c.surprise, topSegment: c.segments[0]?.segment ?? '', topShare: c.segments[0]?.shareOfChange ?? 0 })
    const best = candidates[0]!
    levels.push({ path: [...path], dimension: best.dimension, metricBefore: metricOf(scopeB, input.metric), metricAfter: metricOf(scopeA, input.metric), change: scopeChange, surprise: best.surprise, segments: best.segments.slice(0, 12) })
    const top = best.segments[0]!
    const scale = input.metric.kind === 'sum' || input.metric.kind === 'count' ? '' : ' (weighted mix + rate)'
    const expectedShare = scopeChange === 0 ? 0 : top.expected / scopeChange
    findings.push(`${path.length ? `Within ${path.join(' › ')}, ` : ''}${best.dimension} = "${top.segment}" accounts for ${(top.shareOfChange * 100).toFixed(0)}% of the ${depth === 0 ? 'overall' : 'segment'} change versus ${(expectedShare * 100).toFixed(0)}% expected from its size${scale}: ${fmt(top.before)} → ${fmt(top.after)}${top.mixEffect !== undefined ? ` (mix effect ${fmt(top.mixEffect)}, rate effect ${fmt(top.rateEffect!)})` : ''}.`)
    if (best.surprise < minShare || Math.abs(top.excess) < minShare * Math.abs(scopeChange)) { stoppedBecause = `no ${best.dimension} segment departs from proportional change by at least ${(minShare * 100).toFixed(0)}% of the change — it is spread in line with segment sizes`; break }
    path.push(`${best.dimension}=${top.segment}`)
    scopeB = scopeB.filter((row) => String(row[best.dimension] ?? '(missing)') === top.segment)
    scopeA = scopeA.filter((row) => String(row[best.dimension] ?? '(missing)') === top.segment)
    remaining = remaining.filter((dimension) => dimension !== best.dimension)
  }
  let driverDecomposition: RootCauseResult['driverDecomposition']
  if (input.metric.kind === 'sum' && input.drivers?.count) {
    const countKey = input.drivers.count
    const volume = (rows: Row[]) => (countKey === '*' ? rows.length : new Set(rows.map((row) => scalarKey(row[countKey] ?? null))).size)
    const vB = volume(before)
    const vA = volume(after)
    const aovB = mB / vB
    const aovA = mA / vA
    const totalLog = Math.log(mA / mB)
    if (Number.isFinite(totalLog) && totalLog !== 0 && vB > 0 && vA > 0) {
      driverDecomposition = [
        { driver: countKey === '*' ? 'rows (volume)' : `distinct ${countKey} (volume)`, before: vB, after: vA, logContribution: Math.log(vA / vB), shareOfChange: Math.log(vA / vB) / totalLog },
        { driver: `${input.metric.column} per ${countKey === '*' ? 'row' : countKey} (value)`, before: aovB, after: aovA, logContribution: Math.log(aovA / aovB), shareOfChange: Math.log(aovA / aovB) / totalLog },
      ]
      findings.unshift(`${describeMetric(input.metric)} changed ${((mA / mB - 1) * 100).toFixed(1)}%: volume ${((vA / vB - 1) * 100).toFixed(1)}% and value per unit ${((aovA / aovB - 1) * 100).toFixed(1)}% (log-share ${(driverDecomposition[0]!.shareOfChange * 100).toFixed(0)}% / ${(driverDecomposition[1]!.shareOfChange * 100).toFixed(0)}%).`)
    }
  }
  const hypotheses = [
    'These decompositions show where the change is concentrated in the data; they do not establish why. Candidate explanations to test next:',
    ...(levels[0] ? [`something specific to ${levels[0].dimension} = "${levels[0].segments[0]?.segment}" (pricing, supply, a campaign ending, a tracking or data-pipeline change) — check event logs and data completeness for that segment first`] : []),
    'a data artefact: a partial latest period, late-arriving rows, or a change in definitions produces the same pattern as a real decline',
  ]
  return { metric: describeMetric(input.metric), periods: { before: input.before, after: input.after }, before: mB, after: mA, change, relativeChange: mB === 0 ? Number.NaN : change / mB, ...(driverDecomposition ? { driverDecomposition } : {}), levels, dimensionRanking: ranking, findings, hypotheses, stoppedBecause }
}

function fmt(value: number): string {
  if (!Number.isFinite(value)) return String(value)
  const abs = Math.abs(value)
  return abs >= 1e6 ? `${(value / 1e6).toFixed(2)}M` : abs >= 1e3 ? `${(value / 1e3).toFixed(1)}k` : abs >= 1 ? value.toFixed(2) : value.toPrecision(3)
}

// ---------------------------------------------------------------- cohorts

function periodStart(ms: number, grain: 'day' | 'week' | 'month' | 'quarter'): number {
  const d = new Date(ms)
  if (grain === 'day') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  if (grain === 'week') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7))
  if (grain === 'quarter') return Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3, 1)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
}

function periodIndex(start: number, ms: number, grain: 'day' | 'week' | 'month' | 'quarter'): number {
  if (grain === 'day') return Math.round((ms - start) / 86_400_000)
  if (grain === 'week') return Math.round((ms - start) / (7 * 86_400_000))
  const a = new Date(start)
  const b = new Date(ms)
  const months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + b.getUTCMonth() - a.getUTCMonth()
  return grain === 'quarter' ? Math.floor(months / 3) : months
}

export function cohortRetention(frame: Frame, input: { entity: string; time: string; grain?: 'day' | 'week' | 'month' | 'quarter'; maxPeriods?: number; value?: string }): { grain: string; cohorts: Array<{ cohort: string; size: number; retention: Array<number | null>; value?: Array<number | null> }>; averageRetention: Array<number | null>; notes: string[] } {
  assertColumns(frame, [input.entity, input.time, ...(input.value ? [input.value] : [])], 'cohort retention')
  const grain = input.grain ?? 'month'
  const events = frame.rows.map((row) => ({ entity: String(row[input.entity] ?? ''), ms: toDateMs(row[input.time]), value: input.value ? toNumber(row[input.value]) ?? 0 : 0 })).filter((event) => event.entity && event.ms !== undefined) as Array<{ entity: string; ms: number; value: number }>
  const first = new Map<string, number>()
  for (const event of events) first.set(event.entity, Math.min(first.get(event.entity) ?? Number.POSITIVE_INFINITY, event.ms))
  const lastPeriod = periodStart(Math.max(...events.map((event) => event.ms)), grain)
  const maxPeriods = input.maxPeriods ?? 12
  const cohorts = new Map<number, { members: Set<string>; active: Array<Set<string>>; value: number[] }>()
  for (const [entity, ms] of first) {
    const key = periodStart(ms, grain)
    const cohort = cohorts.get(key) ?? { members: new Set(), active: Array.from({ length: maxPeriods + 1 }, () => new Set<string>()), value: new Array<number>(maxPeriods + 1).fill(0) }
    cohort.members.add(entity)
    cohorts.set(key, cohort)
  }
  for (const event of events) {
    const key = periodStart(first.get(event.entity)!, grain)
    const offset = periodIndex(key, periodStart(event.ms, grain), grain)
    if (offset <= maxPeriods) {
      cohorts.get(key)!.active[offset]!.add(event.entity)
      cohorts.get(key)!.value[offset]! += event.value
    }
  }
  const rows = [...cohorts.entries()].sort((a, b) => a[0] - b[0]).map(([key, cohort]) => {
    const observable = periodIndex(key, lastPeriod, grain)
    return {
      cohort: isoDate(key),
      size: cohort.members.size,
      retention: cohort.active.map((set, offset) => (offset > observable ? null : set.size / cohort.members.size)),
      ...(input.value ? { value: cohort.value.map((total, offset) => (offset > observable ? null : total / cohort.members.size)) } : {}),
    }
  })
  const averageRetention = Array.from({ length: maxPeriods + 1 }, (_, offset) => {
    const eligible = rows.filter((row) => row.retention[offset] !== null)
    const members = eligible.reduce((total, row) => total + row.size, 0)
    return members ? eligible.reduce((total, row) => total + row.retention[offset]! * row.size, 0) / members : null
  })
  return { grain, cohorts: rows, averageRetention, notes: ['Retention at offset k = share of the cohort active in the k-th period after their first activity; the latest cohorts have fewer observable periods (null).', 'The most recent period may be partial, which depresses its retention.'] }
}

// ---------------------------------------------------------------- funnels

export function funnel(frame: Frame, input: { entity?: string; stepColumn?: string; steps: string[]; segment?: string; ordered?: boolean; time?: string }): { steps: Array<{ step: string; entities: number; conversionFromPrevious: number | null; conversionFromStart: number }>; biggestDropOff: { from: string; to: string; lost: number; rate: number } | null; bySegment?: Record<string, Array<{ step: string; entities: number; conversionFromStart: number }>>; notes: string[] } {
  const compute = (rows: Row[]) => {
    let reached: Set<string>[]
    if (input.stepColumn) {
      if (!input.entity) throw new Error('an event-log funnel needs entity (who performed the step)')
      const byEntity = new Map<string, Array<{ step: string; ms: number }>>()
      for (const row of rows) {
        const entity = String(row[input.entity] ?? '')
        if (!entity) continue
        byEntity.set(entity, [...(byEntity.get(entity) ?? []), { step: String(row[input.stepColumn] ?? ''), ms: input.time ? toDateMs(row[input.time]) ?? 0 : 0 }])
      }
      reached = input.steps.map(() => new Set<string>())
      for (const [entity, events] of byEntity) {
        const ordered = events.sort((a, b) => a.ms - b.ms)
        let lastMs = Number.NEGATIVE_INFINITY
        for (let s = 0; s < input.steps.length; s++) {
          const hit = ordered.find((event) => event.step === input.steps[s] && (!(input.ordered ?? true) || event.ms >= lastMs))
          if (!hit) break
          reached[s]!.add(entity)
          lastMs = hit.ms
        }
      }
    } else {
      reached = input.steps.map(() => new Set<string>())
      rows.forEach((row, index) => {
        const entity = input.entity ? String(row[input.entity] ?? index) : String(index)
        for (let s = 0; s < input.steps.length; s++) {
          const value = row[input.steps[s]!]
          if (!(value === true || value === 1 || value === 'true' || value === 'yes')) break
          reached[s]!.add(entity)
        }
      })
    }
    return input.steps.map((step, s) => ({ step, entities: reached[s]!.size }))
  }
  if (input.stepColumn) assertColumns(frame, [input.stepColumn, ...(input.entity ? [input.entity] : [])], 'funnel')
  else assertColumns(frame, input.steps, 'funnel')
  const counts = compute(frame.rows)
  const start = counts[0]?.entities ?? 0
  const steps = counts.map((entry, s) => ({ ...entry, conversionFromPrevious: s === 0 ? null : counts[s - 1]!.entities ? entry.entities / counts[s - 1]!.entities : 0, conversionFromStart: start ? entry.entities / start : 0 }))
  let biggest: { from: string; to: string; lost: number; rate: number } | null = null
  for (let s = 1; s < steps.length; s++) {
    const lost = steps[s - 1]!.entities - steps[s]!.entities
    const rate = steps[s - 1]!.entities ? lost / steps[s - 1]!.entities : 0
    if (!biggest || rate > biggest.rate) biggest = { from: steps[s - 1]!.step, to: steps[s]!.step, lost, rate }
  }
  let bySegment: Record<string, Array<{ step: string; entities: number; conversionFromStart: number }>> | undefined
  if (input.segment) {
    assertColumns(frame, [input.segment], 'funnel segment')
    bySegment = {}
    const groups = new Map<string, Row[]>()
    for (const row of frame.rows) groups.set(String(row[input.segment] ?? '(missing)'), [...(groups.get(String(row[input.segment] ?? '(missing)')) ?? []), row])
    for (const [segment, rows] of groups) {
      const segmentCounts = compute(rows)
      const first = segmentCounts[0]?.entities ?? 0
      bySegment[segment] = segmentCounts.map((entry) => ({ ...entry, conversionFromStart: first ? entry.entities / first : 0 }))
    }
  }
  return { steps, biggestDropOff: biggest, ...(bySegment ? { bySegment } : {}), notes: [input.stepColumn ? `entities must complete steps in order${input.time ? ' by time' : ''}; a later step without the earlier one does not count` : 'each row is one entity; a step counts only if every earlier step is also true'] }
}

// ---------------------------------------------------------------- RFM and CLV

const RFM_SEGMENTS: Array<[RegExp, string, string]> = [
  [/^[45][45][45]$/, 'Champions', 'bought recently, buy often, and spend the most'],
  [/^[345][45][345]$/, 'Loyal', 'buy regularly with good spend'],
  [/^[45][23][2-5]$/, 'Potential loyalists', 'recent customers with average frequency'],
  [/^5[1][1-5]$/, 'New customers', 'bought very recently, only once'],
  [/^[34][1][1-5]$/, 'Promising', 'recent but infrequent'],
  [/^[23][23][2-5]$/, 'Need attention', 'above-average but slipping'],
  [/^[12][345][345]$/, 'At risk', 'used to buy often and spend well, but not recently'],
  [/^1[45][45]$/, 'Cannot lose them', 'were among the best customers, now long inactive'],
  [/^[12][12][1-5]$/, 'Hibernating', 'low recency and frequency'],
]

export function rfm(frame: Frame, input: { customer: string; date: string; amount: string; asOf?: string }): { asOf: string; customers: Array<{ customer: string; recencyDays: number; frequency: number; monetary: number; r: number; f: number; m: number; score: string; segment: string }>; segments: Array<{ segment: string; description: string; customers: number; share: number; revenueShare: number; medianRecency: number }>; notes: string[] } {
  assertColumns(frame, [input.customer, input.date, input.amount], 'RFM')
  const agg = new Map<string, { last: number; orders: number; total: number }>()
  for (const row of frame.rows) {
    const customer = row[input.customer]
    const ms = toDateMs(row[input.date])
    if (isMissing(customer) || ms === undefined) continue
    const entry = agg.get(String(customer)) ?? { last: Number.NEGATIVE_INFINITY, orders: 0, total: 0 }
    entry.last = Math.max(entry.last, ms)
    entry.orders++
    entry.total += toNumber(row[input.amount]) ?? 0
    agg.set(String(customer), entry)
  }
  if (agg.size < 5) throw new Error('RFM needs at least 5 customers')
  const asOfMs = input.asOf ? toDateMs(input.asOf)! : Math.max(...[...agg.values()].map((entry) => entry.last)) + 86_400_000
  const records = [...agg.entries()].map(([customer, entry]) => ({ customer, recencyDays: (asOfMs - entry.last) / 86_400_000, frequency: entry.orders, monetary: entry.total }))
  const score = (values: number[], value: number, higherIsBetter: boolean) => {
    const sortedValues = [...values].sort((a, b) => a - b)
    const edges = [0.2, 0.4, 0.6, 0.8].map((q) => quantileSorted(sortedValues, q))
    let bucket = 1 + edges.filter((edge) => value > edge).length
    if (!higherIsBetter) bucket = 6 - bucket
    return Math.max(1, Math.min(5, bucket))
  }
  const recencies = records.map((r) => r.recencyDays)
  const frequencies = records.map((r) => r.frequency)
  const monetaries = records.map((r) => r.monetary)
  const customers = records.map((record) => {
    const r = score(recencies, record.recencyDays, false)
    const f = score(frequencies, record.frequency, true)
    const m = score(monetaries, record.monetary, true)
    const code = `${r}${f}${m}`
    return { ...record, r, f, m, score: code, segment: RFM_SEGMENTS.find(([pattern]) => pattern.test(code))?.[1] ?? 'Others' }
  })
  const totalRevenue = sum(monetaries) || 1
  const segments = [...new Set(customers.map((c) => c.segment))].map((segment) => {
    const members = customers.filter((c) => c.segment === segment)
    return { segment, description: RFM_SEGMENTS.find(([, name]) => name === segment)?.[2] ?? 'mixed profile', customers: members.length, share: members.length / customers.length, revenueShare: sum(members.map((c) => c.monetary)) / totalRevenue, medianRecency: median(members.map((c) => c.recencyDays)) }
  }).sort((a, b) => b.revenueShare - a.revenueShare)
  return { asOf: isoDate(asOfMs), customers: customers.sort((a, b) => b.monetary - a.monetary).slice(0, 200), segments, notes: ['Scores are quintiles within this customer base (5 = best); frequency ties at low counts make its quintiles coarse.', 'Segment names follow a common RFM convention and are labels for prioritisation, not predictions.'] }
}

export function customerLifetimeValue(frame: Frame, input: { customer: string; date: string; amount: string; margin?: number; discountRate?: number; horizonYears?: number }): Record<string, unknown> {
  assertColumns(frame, [input.customer, input.date, input.amount], 'CLV')
  const byCustomer = new Map<string, { first: number; last: number; orders: number; revenue: number }>()
  for (const row of frame.rows) {
    const ms = toDateMs(row[input.date])
    if (ms === undefined || isMissing(row[input.customer])) continue
    const key = String(row[input.customer])
    const entry = byCustomer.get(key) ?? { first: ms, last: ms, orders: 0, revenue: 0 }
    entry.first = Math.min(entry.first, ms)
    entry.last = Math.max(entry.last, ms)
    entry.orders++
    entry.revenue += toNumber(row[input.amount]) ?? 0
    byCustomer.set(key, entry)
  }
  const entries = [...byCustomer.values()]
  const end = Math.max(...entries.map((e) => e.last))
  const start = Math.min(...entries.map((e) => e.first))
  const years = Math.max((end - start) / (365.25 * 86_400_000), 1 / 12)
  const orders = sum(entries.map((e) => e.orders))
  const revenue = sum(entries.map((e) => e.revenue))
  const aov = revenue / orders
  const frequencyPerYear = orders / entries.length / years
  const inactiveCutoff = end - 365 * 86_400_000
  const eligible = entries.filter((e) => e.first <= inactiveCutoff)
  const churnRate = eligible.length ? eligible.filter((e) => e.last <= inactiveCutoff).length / eligible.length : null
  const margin = input.margin ?? 1
  const retention = churnRate === null ? null : 1 - churnRate
  const discount = input.discountRate ?? 0.1
  const horizon = input.horizonYears ?? 5
  let clv: number | null = null
  if (retention !== null) {
    clv = 0
    for (let year = 1; year <= horizon; year++) clv += (aov * frequencyPerYear * margin * retention ** (year - 1)) / (1 + discount) ** year
  }
  return {
    customers: entries.length,
    observedYears: years,
    averageOrderValue: aov,
    ordersPerCustomerPerYear: frequencyPerYear,
    annualChurnRate: churnRate,
    historicalValuePerCustomer: (revenue * margin) / entries.length,
    projectedClv: clv,
    formula: `CLV = Σ_{t=1..${horizon}} AOV × frequency × margin × retention^(t−1) / (1 + ${discount})^t`,
    assumptions: ['retention and spend stay at their historical averages', `a customer with no purchase in the last 365 days counts as churned${churnRate === null ? ' — not enough history to estimate churn, so no projection was made' : ''}`, `gross margin ${margin === 1 ? 'not given: values are revenue, not profit' : `of ${(margin * 100).toFixed(0)}%`}`],
  }
}

// ---------------------------------------------------------------- KPIs

export function kpiComparison(frame: Frame, input: { time: string; measures: Array<{ name: string; metric: MetricSpec; target?: number }>; grain?: 'day' | 'week' | 'month' | 'quarter' | 'year'; periods?: number }): { grain: string; periods: string[]; kpis: Array<{ name: string; values: number[]; latest: number; previous: number | null; change: number | null; relativeChange: number | null; samePeriodLastYear?: number | null; yoy?: number | null; target?: number; targetAttainment?: number }>; notes: string[] } {
  const grain = input.grain ?? 'month'
  assertColumns(frame, [input.time], 'KPI comparison')
  const buckets = new Map<number, Row[]>()
  for (const row of frame.rows) {
    const ms = toDateMs(row[input.time])
    if (ms === undefined) continue
    const d = new Date(ms)
    const key = grain === 'year' ? Date.UTC(d.getUTCFullYear(), 0, 1) : periodStart(ms, grain)
    buckets.set(key, [...(buckets.get(key) ?? []), row])
  }
  const keys = [...buckets.keys()].sort((a, b) => a - b).slice(-(input.periods ?? 13))
  const kpis = input.measures.map((measure) => {
    const values = keys.map((key) => metricOf(buckets.get(key)!, measure.metric))
    const latest = values.at(-1)!
    const previous = values.length > 1 ? values.at(-2)! : null
    const lastYearKey = grain === 'month' ? keys.find((key) => { const a = new Date(key); const b = new Date(keys.at(-1)!); return a.getUTCFullYear() === b.getUTCFullYear() - 1 && a.getUTCMonth() === b.getUTCMonth() }) : undefined
    const samePeriodLastYear = lastYearKey !== undefined ? metricOf(buckets.get(lastYearKey)!, measure.metric) : null
    return { name: measure.name, values, latest, previous, change: previous === null ? null : latest - previous, relativeChange: previous ? (latest - previous) / Math.abs(previous) : null, ...(grain === 'month' ? { samePeriodLastYear, yoy: samePeriodLastYear ? (latest - samePeriodLastYear) / Math.abs(samePeriodLastYear) : null } : {}), ...(measure.target !== undefined ? { target: measure.target, targetAttainment: latest / measure.target } : {}) }
  })
  return { grain, periods: keys.map((key) => isoDate(key)), kpis, notes: ['The latest period may be incomplete; compare like-for-like periods before concluding a decline.'] }
}
