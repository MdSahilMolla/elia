import { compileExpression } from './expr.ts'
import { assertColumns, frameFromRows, refreshTypes, type Frame } from './frame.ts'
import type { Check } from './record.ts'
import { createRng } from './rng.ts'
import { mean, median, quantileSorted, standardDeviation, sum, variance } from './stats/describe.ts'
import { compareScalars, convertRaw, inferStringColumn, isMissing, isoDate, isoDateTime, parseDateMs, scalarKey, toDateMs, toNumber, type ColumnType, type Row, type Scalar } from './values.ts'

/**
 * Wrangling operations. Each step takes frames and returns a new frame plus checks and
 * notes — inputs are never mutated, and every step is serialisable so the whole pipeline
 * is recorded in the output dataset's lineage and can be replayed. Steps that can lose or
 * multiply rows (filters, joins, dedupes) report exactly how many.
 */

export interface StepResult {
  frame: Frame
  checks: Check[]
  notes: string[]
}

export type FrameResolver = (ref: string) => { ref: string; frame: Frame }

type Params = Record<string, unknown>

function str(params: Params, key: string, required = true): string {
  const value = params[key]
  if (typeof value === 'string' && value.trim()) return value
  if (!required && (value === undefined || value === null)) return ''
  throw new Error(`"${key}" must be a non-empty string`)
}

function strings(params: Params, key: string, required = true): string[] {
  const value = params[key]
  if (typeof value === 'string' && value.trim()) return [value]
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value as string[]
  if (!required && (value === undefined || value === null)) return []
  throw new Error(`"${key}" must be a column name or an array of column names`)
}

function num(params: Params, key: string, fallback?: number): number {
  const value = params[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (value === undefined && fallback !== undefined) return fallback
  throw new Error(`"${key}" must be a number`)
}

function withRows(frame: Frame, rows: Row[], columns = frame.columns): Frame {
  return { columns, types: Object.fromEntries(columns.map((name) => [name, frame.types[name] ?? 'string'])), rows }
}

// ---------------------------------------------------------------- aggregation functions

export const AGGREGATES = ['sum', 'mean', 'median', 'min', 'max', 'count', 'count_distinct', 'count_missing', 'std', 'var', 'first', 'last', 'p05', 'p10', 'p25', 'p75', 'p90', 'p95', 'p99', 'mode', 'any', 'all', 'share'] as const
export type Aggregate = (typeof AGGREGATES)[number]

export function aggregateValues(values: Scalar[], fn: Aggregate): Scalar {
  const present = values.filter((value) => !isMissing(value))
  const numbers = present.map((value) => (typeof value === 'string' ? parseDateMs(value) ?? toNumber(value) : toNumber(value))).filter((value): value is number => value !== undefined)
  const isDate = present.length > 0 && present.every((value) => typeof value === 'string' && parseDateMs(value) !== undefined)
  const asDate = (ms: number) => (present.some((value) => String(value).length > 10) ? isoDateTime(ms) : isoDate(ms))
  switch (fn) {
    case 'count': return present.length
    case 'count_distinct': return new Set(present.map((value) => scalarKey(value))).size
    case 'count_missing': return values.length - present.length
    case 'first': return present[0] ?? null
    case 'last': return present.at(-1) ?? null
    case 'any': return present.some((value) => value === true || value === 1)
    case 'all': return present.length > 0 && present.every((value) => value === true || value === 1)
    case 'share': return present.length ? present.filter((value) => value === true || value === 1).length / present.length : null
    case 'mode': {
      const counts = new Map<string, { value: Scalar; count: number }>()
      for (const value of present) {
        const key = scalarKey(value)
        const entry = counts.get(key) ?? { value, count: 0 }
        entry.count++
        counts.set(key, entry)
      }
      return [...counts.values()].sort((a, b) => b.count - a.count || compareScalars(a.value, b.value))[0]?.value ?? null
    }
    case 'min':
    case 'max': {
      if (isDate) {
        const ms = numbers
        return ms.length ? asDate(fn === 'min' ? Math.min(...ms) : Math.max(...ms)) : null
      }
      if (numbers.length === present.length && numbers.length) return fn === 'min' ? Math.min(...numbers) : Math.max(...numbers)
      const sorted = [...present].sort(compareScalars)
      return (fn === 'min' ? sorted[0] : sorted.at(-1)) ?? null
    }
  }
  if (numbers.length === 0) return null
  switch (fn) {
    case 'sum': return sum(numbers)
    case 'mean': return mean(numbers)
    case 'median': return median(numbers)
    case 'std': return numbers.length > 1 ? standardDeviation(numbers) : null
    case 'var': return numbers.length > 1 ? variance(numbers) : null
    default: {
      const p = Number(fn.slice(1)) / 100
      return quantileSorted([...numbers].sort((a, b) => a - b), p)
    }
  }
}

function groupRows(frame: Frame, keys: string[]): Map<string, { key: Row; rows: Row[] }> {
  const groups = new Map<string, { key: Row; rows: Row[] }>()
  for (const row of frame.rows) {
    const id = keys.map((name) => scalarKey(row[name] ?? null)).join('\u0001')
    let group = groups.get(id)
    if (!group) {
      group = { key: Object.fromEntries(keys.map((name) => [name, row[name] ?? null])), rows: [] }
      groups.set(id, group)
    }
    group.rows.push(row)
  }
  return groups
}

interface MetricSpec {
  column?: string
  fn: Aggregate
  as: string
  where?: string
}

function metricSpecs(frame: Frame, value: unknown): MetricSpec[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('metrics must be a non-empty array like [{ "column": "revenue", "fn": "sum", "as": "total_revenue" }]')
  return value.map((item, index) => {
    if (!item || typeof item !== 'object') throw new Error(`metrics[${index}] must be an object`)
    const spec = item as Record<string, unknown>
    const fn = spec.fn as Aggregate
    if (!AGGREGATES.includes(fn)) throw new Error(`metrics[${index}].fn must be one of ${AGGREGATES.join(', ')}`)
    const column = typeof spec.column === 'string' ? spec.column : undefined
    if (!column && fn !== 'count') throw new Error(`metrics[${index}] needs a column (only "count" can count rows)`)
    if (column) assertColumns(frame, [column], `metrics[${index}]`)
    return { ...(column ? { column } : {}), fn, as: typeof spec.as === 'string' && spec.as ? spec.as : `${fn}_${column ?? 'rows'}`, ...(typeof spec.where === 'string' ? { where: spec.where } : {}) }
  })
}

// ---------------------------------------------------------------- steps

type StepFn = (frame: Frame, params: Params, resolve: FrameResolver) => StepResult

const STEPS: Record<string, { usage: string; run: StepFn }> = {
  select: {
    usage: '{ "op": "select", "columns": ["a", "b"] }',
    run(frame, params) {
      const columns = strings(params, 'columns')
      assertColumns(frame, columns, 'select')
      return { frame: withRows(frame, frame.rows.map((row) => Object.fromEntries(columns.map((name) => [name, row[name] ?? null]))), columns), checks: [], notes: [`kept ${columns.length} of ${frame.columns.length} columns`] }
    },
  },
  drop: {
    usage: '{ "op": "drop", "columns": ["a"] }',
    run(frame, params) {
      const drop = strings(params, 'columns')
      assertColumns(frame, drop, 'drop')
      const columns = frame.columns.filter((name) => !drop.includes(name))
      return { frame: withRows(frame, frame.rows.map((row) => Object.fromEntries(columns.map((name) => [name, row[name] ?? null]))), columns), checks: [], notes: [`dropped ${drop.join(', ')}`] }
    },
  },
  rename: {
    usage: '{ "op": "rename", "mapping": { "old": "new" } }',
    run(frame, params) {
      const mapping = params.mapping as Record<string, string>
      if (!mapping || typeof mapping !== 'object') throw new Error('rename needs mapping: { "old": "new" }')
      assertColumns(frame, Object.keys(mapping), 'rename')
      const columns = frame.columns.map((name) => mapping[name] ?? name)
      if (new Set(columns).size !== columns.length) throw new Error('rename would create duplicate column names')
      const types = Object.fromEntries(frame.columns.map((name) => [mapping[name] ?? name, frame.types[name]!]))
      return { frame: { columns, types, rows: frame.rows.map((row) => Object.fromEntries(frame.columns.map((name) => [mapping[name] ?? name, row[name] ?? null]))) }, checks: [], notes: [] }
    },
  },
  filter: {
    usage: '{ "op": "filter", "where": "year(order_date) == 2025 and status != \\"cancelled\\"" }',
    run(frame, params) {
      const expression = compileExpression(str(params, 'where'), frame.columns)
      const rows = frame.rows.filter((row) => expression.test(row))
      const kept = rows.length
      const checks: Check[] = [{ name: 'filter keeps rows', status: kept === 0 ? 'fail' : 'pass', detail: `${kept} of ${frame.rows.length} rows kept (${frame.rows.length ? ((100 * kept) / frame.rows.length).toFixed(1) : '0'}%)` }]
      return { frame: withRows(frame, rows), checks, notes: [`filter "${expression.source}" removed ${frame.rows.length - kept} rows`] }
    },
  },
  derive: {
    usage: '{ "op": "derive", "columns": { "margin": "revenue - cost", "order_month": "month_start(order_date)" } }',
    run(frame, params) {
      const single = [params.column, params.name, params.as, params.output].find((value): value is string => typeof value === 'string')
      const expression = [params.expr, params.expression, params.formula].find((value): value is string => typeof value === 'string')
      const specs = (params.columns ?? (single && expression ? { [single]: expression } : undefined)) as Record<string, string> | undefined
      if (!specs || typeof specs !== 'object' || Object.keys(specs).length === 0) throw new Error('derive needs columns: { "new_column": "expression" }')
      let current = frame
      const notes: string[] = []
      const checks: Check[] = []
      for (const [name, source] of Object.entries(specs)) {
        const expression = compileExpression(source, current.columns)
        const values = current.rows.map((row) => expression.evaluate(row))
        const nulls = values.filter((value) => value === null).length
        const inputNulls = current.rows.filter((row) => expression.references.some((ref) => isMissing(row[ref]))).length
        const rows = current.rows.map((row, index) => ({ ...row, [name]: values[index]! }))
        const columns = current.columns.includes(name) ? current.columns : [...current.columns, name]
        current = refreshTypes({ columns, types: { ...current.types }, rows }, [name])
        if (nulls > inputNulls) checks.push({ name: `derive ${name}`, status: nulls === current.rows.length ? 'fail' : 'warn', detail: `${nulls - inputNulls} rows produced null from non-null inputs (e.g. division by zero, log of a non-positive, or an unparsable value)` })
        notes.push(`${name} = ${source}${frame.columns.includes(name) ? ' (replaced existing column)' : ''}`)
      }
      return { frame: current, checks, notes }
    },
  },
  cast: {
    usage: '{ "op": "cast", "columns": ["signup_date"], "to": "date", "dayFirst": false }',
    run(frame, params) {
      const columns = strings(params, 'columns')
      assertColumns(frame, columns, 'cast')
      const to = str(params, 'to') as ColumnType
      if (!['integer', 'number', 'string', 'date', 'datetime', 'boolean'].includes(to)) throw new Error('to must be integer, number, string, date, datetime, or boolean')
      const checks: Check[] = []
      let rows = frame.rows.map((row) => ({ ...row }))
      for (const name of columns) {
        let failed = 0
        const examples: Scalar[] = []
        rows = rows.map((row) => {
          const value = row[name]
          if (isMissing(value)) return { ...row, [name]: null }
          let converted: Scalar
          if (to === 'string') converted = String(value)
          else if (to === 'integer' || to === 'number') {
            const n = toNumber(value)
            converted = n === undefined ? null : to === 'integer' ? Math.trunc(n) : n
          } else if (to === 'boolean') {
            const text = String(value).trim().toLowerCase()
            converted = ['true', '1', 'yes', 'y', 't'].includes(text) ? true : ['false', '0', 'no', 'n', 'f'].includes(text) ? false : null
          } else {
            const ms = typeof value === 'number' ? value : parseDateMs(String(value), params.dayFirst === true)
            converted = ms === undefined ? null : to === 'date' ? isoDate(ms) : isoDateTime(ms)
          }
          if (converted === null) {
            failed++
            if (examples.length < 5) examples.push(value ?? null)
          }
          return { ...row, [name]: converted }
        })
        checks.push({ name: `cast ${name} to ${to}`, status: failed === 0 ? 'pass' : failed / frame.rows.length > 0.05 ? 'fail' : 'warn', detail: failed ? `${failed} values could not be converted and became null, e.g. ${examples.map((e) => JSON.stringify(e)).join(', ')}` : 'every value converted' })
      }
      return { frame: { columns: frame.columns, types: { ...frame.types, ...Object.fromEntries(columns.map((name) => [name, to])) }, rows }, checks, notes: [] }
    },
  },
  parse_number: {
    usage: '{ "op": "parse_number", "columns": ["price"] }  // strips $ € £ ¥ ₹, thousands separators and %, (1,234) → -1234',
    run(frame, params) {
      const columns = strings(params, 'columns')
      assertColumns(frame, columns, 'parse_number')
      const expression = compileExpression('parse_number(x)', ['x'])
      const checks: Check[] = []
      const rows = frame.rows.map((row) => ({ ...row }))
      for (const name of columns) {
        let failed = 0
        let percent = 0
        for (const row of rows) {
          const value = row[name]
          if (isMissing(value)) continue
          if (typeof value === 'string' && value.trim().endsWith('%')) percent++
          const parsed = typeof value === 'number' ? value : expression.evaluate({ x: value ?? null })
          if (parsed === null) failed++
          row[name] = parsed
        }
        checks.push({ name: `parse ${name}`, status: failed ? 'warn' : 'pass', detail: failed ? `${failed} values could not be parsed and became null` : 'every value parsed' })
        if (percent) checks.push({ name: `percent scale ${name}`, status: 'warn', detail: `${percent} values had a % sign; they are now percent points (12% → 12), not fractions` })
      }
      return { frame: refreshTypes({ ...frame, rows }, columns), checks, notes: [] }
    },
  },
  fill_missing: {
    usage: '{ "op": "fill_missing", "column": "age", "strategy": "median" | "mean" | "mode" | "value" | "zero" | "ffill" | "bfill", "value": 0, "groupBy": ["segment"], "indicator": true, "markers": true }',
    run(frame, params) {
      const name = str(params, 'column')
      assertColumns(frame, [name], 'fill_missing')
      const strategy = str(params, 'strategy')
      const groupBy = strings(params, 'groupBy', false)
      assertColumns(frame, groupBy, 'fill_missing groupBy')
      const markers = params.markers === true
      const isGap = (value: Scalar | undefined) => isMissing(value) || (markers && typeof value === 'string' && ['na', 'n/a', 'null', 'none', 'nan', '-', '--', '?', '#n/a', 'missing'].includes(value.trim().toLowerCase()))
      const rows = frame.rows.map((row) => ({ ...row }))
      const indicatorName = `${name}_was_missing`
      if (params.indicator === true) for (const row of rows) row[indicatorName] = isGap(row[name]) ? 1 : 0
      let filled = 0
      const fillGroup = (group: Row[]) => {
        const present = group.map((row) => row[name]).filter((value) => !isGap(value)) as Scalar[]
        if (strategy === 'ffill' || strategy === 'bfill') {
          const ordered = strategy === 'ffill' ? group : [...group].reverse()
          let last: Scalar = null
          for (const row of ordered) {
            if (isGap(row[name])) {
              if (last !== null) {
                row[name] = last
                filled++
              }
            } else last = row[name] ?? null
          }
          return
        }
        let fill: Scalar
        if (strategy === 'value') fill = (params.value ?? null) as Scalar
        else if (strategy === 'zero') fill = 0
        else if (strategy === 'mode') fill = aggregateValues(present, 'mode')
        else if (strategy === 'mean' || strategy === 'median') fill = aggregateValues(present, strategy)
        else throw new Error('strategy must be value, zero, mean, median, mode, ffill, or bfill')
        if (fill === null) return
        for (const row of group) if (isGap(row[name])) {
          row[name] = fill
          filled++
        }
      }
      if (groupBy.length) for (const group of groupRows({ ...frame, rows }, groupBy).values()) fillGroup(group.rows)
      else fillGroup(rows)
      const remaining = rows.filter((row) => isGap(row[name])).length
      const columns = params.indicator === true && !frame.columns.includes(indicatorName) ? [...frame.columns, indicatorName] : frame.columns
      return {
        frame: refreshTypes({ columns, types: { ...frame.types, [indicatorName]: 'integer' }, rows }, [name]),
        checks: [{ name: `impute ${name}`, status: remaining ? 'warn' : 'pass', detail: `${filled} values imputed by ${strategy}${groupBy.length ? ` within ${groupBy.join(', ')}` : ''}; ${remaining} still missing` }],
        notes: [`imputation changes the distribution of ${name}; in models, fit imputation on training folds only (ds_ml does this automatically)`],
      }
    },
  },
  drop_missing: {
    usage: '{ "op": "drop_missing", "columns": ["a", "b"], "how": "any" | "all" }',
    run(frame, params) {
      const columns = strings(params, 'columns', false)
      const scope = columns.length ? columns : frame.columns
      assertColumns(frame, scope, 'drop_missing')
      const how = params.how === 'all' ? 'all' : 'any'
      const rows = frame.rows.filter((row) => (how === 'any' ? !scope.some((name) => isMissing(row[name])) : !scope.every((name) => isMissing(row[name]))))
      const dropped = frame.rows.length - rows.length
      return { frame: withRows(frame, rows), checks: [{ name: 'drop missing', status: dropped / Math.max(1, frame.rows.length) > 0.2 ? 'warn' : 'pass', detail: `${dropped} rows dropped (${((100 * dropped) / Math.max(1, frame.rows.length)).toFixed(1)}%); dropping rows can bias results when missingness is not random` }], notes: [] }
    },
  },
  dedupe: {
    usage: '{ "op": "dedupe", "columns": ["order_id"], "keep": "first" | "last", "orderBy": "updated_at" }',
    run(frame, params) {
      const columns = strings(params, 'columns', false)
      const scope = columns.length ? columns : frame.columns
      assertColumns(frame, scope, 'dedupe')
      let rows = frame.rows
      if (typeof params.orderBy === 'string') {
        assertColumns(frame, [params.orderBy], 'dedupe orderBy')
        const by = params.orderBy
        rows = [...rows].sort((a, b) => compareScalars(a[by], b[by]))
      }
      const keep = params.keep === 'last' ? 'last' : 'first'
      const seen = new Map<string, number>()
      const kept: Row[] = []
      for (const row of rows) {
        const key = scope.map((name) => scalarKey(row[name] ?? null)).join('\u0001')
        if (seen.has(key)) {
          if (keep === 'last') kept[seen.get(key)!] = row
          continue
        }
        seen.set(key, kept.length)
        kept.push(row)
      }
      const removed = frame.rows.length - kept.length
      return { frame: withRows(frame, kept), checks: [{ name: 'dedupe', status: 'pass', detail: `${removed} duplicate rows removed on (${scope.join(', ')}), keeping the ${keep}` }], notes: [] }
    },
  },
  standardize_categories: {
    usage: '{ "op": "standardize_categories", "column": "city", "case": "title" | "lower" | "upper", "mapping": { "NYC": "New York" } }',
    run(frame, params) {
      const name = str(params, 'column')
      assertColumns(frame, [name], 'standardize_categories')
      const mapping = (params.mapping ?? {}) as Record<string, string>
      const caseMode = typeof params.case === 'string' ? params.case : undefined
      const applied = new Map<string, string>()
      const canonical = new Map<string, string>()
      const counts = new Map<string, number>()
      for (const row of frame.rows) if (typeof row[name] === 'string') counts.set(row[name] as string, (counts.get(row[name] as string) ?? 0) + 1)
      for (const [value] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
        const normalized = value.trim().replace(/\s+/g, ' ').toLowerCase()
        if (!canonical.has(normalized)) canonical.set(normalized, value.trim().replace(/\s+/g, ' '))
      }
      const convert = (value: string) => {
        const trimmed = value.trim().replace(/\s+/g, ' ')
        let out = mapping[value] ?? mapping[trimmed] ?? canonical.get(trimmed.toLowerCase()) ?? trimmed
        if (caseMode === 'lower') out = out.toLowerCase()
        else if (caseMode === 'upper') out = out.toUpperCase()
        else if (caseMode === 'title') out = out.toLowerCase().replace(/\b\p{L}/gu, (c) => c.toUpperCase())
        if (out !== value) applied.set(value, out)
        return out
      }
      const rows = frame.rows.map((row) => (typeof row[name] === 'string' ? { ...row, [name]: convert(row[name] as string) } : row))
      const before = counts.size
      const after = new Set(rows.map((row) => row[name]).filter((value) => typeof value === 'string')).size
      return { frame: withRows(frame, rows), checks: [{ name: `standardize ${name}`, status: 'pass', detail: `${before} labels consolidated to ${after}; ${applied.size} spellings changed` }], notes: [...applied.entries()].slice(0, 20).map(([from, to]) => `${JSON.stringify(from)} → ${JSON.stringify(to)}`) }
    },
  },
  replace: {
    usage: '{ "op": "replace", "column": "status", "values": { "N/A": null, "cancelled": "canceled" } }',
    run(frame, params) {
      const name = str(params, 'column')
      assertColumns(frame, [name], 'replace')
      const mapping = params.values as Record<string, Scalar>
      if (!mapping || typeof mapping !== 'object') throw new Error('replace needs values: { "from": "to" }')
      let changed = 0
      const rows = frame.rows.map((row) => {
        const key = row[name] === null || row[name] === undefined ? 'null' : String(row[name])
        if (Object.prototype.hasOwnProperty.call(mapping, key)) {
          changed++
          return { ...row, [name]: mapping[key] ?? null }
        }
        return row
      })
      return { frame: refreshTypes(withRows(frame, rows), [name]), checks: [{ name: `replace in ${name}`, status: 'pass', detail: `${changed} values replaced` }], notes: [] }
    },
  },
  clip: {
    usage: '{ "op": "clip", "column": "amount", "lower": 0, "upper": 10000 }  or  { "op": "clip", "column": "amount", "lowerQuantile": 0.01, "upperQuantile": 0.99 } (winsorize)',
    run(frame, params) {
      const name = str(params, 'column')
      assertColumns(frame, [name], 'clip')
      const numbers = frame.rows.map((row) => toNumber(row[name])).filter((value): value is number => value !== undefined).sort((a, b) => a - b)
      const lower = typeof params.lowerQuantile === 'number' ? quantileSorted(numbers, params.lowerQuantile) : typeof params.lower === 'number' ? params.lower : Number.NEGATIVE_INFINITY
      const upper = typeof params.upperQuantile === 'number' ? quantileSorted(numbers, params.upperQuantile) : typeof params.upper === 'number' ? params.upper : Number.POSITIVE_INFINITY
      let clipped = 0
      const rows = frame.rows.map((row) => {
        const value = toNumber(row[name])
        if (value === undefined) return row
        const out = Math.min(upper, Math.max(lower, value))
        if (out !== value) clipped++
        return { ...row, [name]: out }
      })
      return { frame: withRows(frame, rows), checks: [{ name: `clip ${name}`, status: 'pass', detail: `${clipped} values clipped to [${lower}, ${upper}]` }], notes: ['clipping changes extreme values; report results with and without it when outliers matter'] }
    },
  },
  bin: {
    usage: '{ "op": "bin", "column": "age", "as": "age_band", "edges": [0, 18, 35, 50, 65, 120] }  or  { "quantiles": 4 }',
    run(frame, params) {
      const name = str(params, 'column')
      assertColumns(frame, [name], 'bin')
      const target = typeof params.as === 'string' ? params.as : `${name}_bin`
      let edges: number[]
      if (Array.isArray(params.edges)) edges = (params.edges as number[]).map(Number).sort((a, b) => a - b)
      else {
        const q = num(params, 'quantiles', 4)
        const numbers = frame.rows.map((row) => toNumber(row[name])).filter((value): value is number => value !== undefined).sort((a, b) => a - b)
        edges = [...new Set(Array.from({ length: q + 1 }, (_, index) => quantileSorted(numbers, index / q)))]
      }
      if (edges.length < 2) throw new Error('bin needs at least two edges')
      const labels = edges.slice(0, -1).map((edge, index) => `[${edge}, ${edges[index + 1]}${index === edges.length - 2 ? ']' : ')'}`)
      const rows = frame.rows.map((row) => {
        const value = toNumber(row[name])
        if (value === undefined) return { ...row, [target]: null }
        const index = edges.findIndex((edge, i) => i < edges.length - 1 && value >= edge && (value < edges[i + 1]! || (i === edges.length - 2 && value <= edges[i + 1]!)))
        return { ...row, [target]: index === -1 ? null : labels[index]! }
      })
      const columns = frame.columns.includes(target) ? frame.columns : [...frame.columns, target]
      const outside = rows.filter((row) => row[target] === null && toNumber(row[name]) !== undefined).length
      return { frame: { columns, types: { ...frame.types, [target]: 'string' }, rows }, checks: [{ name: `bin ${name}`, status: outside ? 'warn' : 'pass', detail: outside ? `${outside} values fall outside the edges and got no bin` : `every value binned into ${labels.length} bins` }], notes: [] }
    },
  },
  sort: {
    usage: '{ "op": "sort", "by": [{ "column": "revenue", "desc": true }, "customer_id"] }',
    run(frame, params) {
      const raw = Array.isArray(params.by) ? params.by : [params.by]
      const keys = raw.map((item) => (typeof item === 'string' ? { column: item, desc: false } : { column: String((item as Record<string, unknown>).column), desc: (item as Record<string, unknown>).desc === true }))
      assertColumns(frame, keys.map((key) => key.column), 'sort')
      const rows = [...frame.rows].sort((a, b) => {
        for (const key of keys) {
          const c = compareScalars(a[key.column], b[key.column])
          if (c !== 0) return key.desc ? -c : c
        }
        return 0
      })
      return { frame: withRows(frame, rows), checks: [], notes: [] }
    },
  },
  sample: {
    usage: '{ "op": "sample", "n": 1000, "seed": 42, "stratify": "segment" }  or  { "fraction": 0.1 }',
    run(frame, params) {
      const rng = createRng(num(params, 'seed', 42))
      const size = typeof params.fraction === 'number' ? Math.round(frame.rows.length * params.fraction) : num(params, 'n')
      let rows: Row[]
      if (typeof params.stratify === 'string') {
        assertColumns(frame, [params.stratify], 'sample stratify')
        rows = []
        for (const group of groupRows(frame, [params.stratify]).values()) rows.push(...rng.shuffle(group.rows).slice(0, Math.round((group.rows.length / frame.rows.length) * size)))
      } else rows = rng.shuffle(frame.rows).slice(0, size)
      return { frame: withRows(frame, rows), checks: [{ name: 'sample', status: 'pass', detail: `${rows.length} of ${frame.rows.length} rows sampled at random (seed ${rng.seed})${typeof params.stratify === 'string' ? `, stratified by ${params.stratify}` : ''}` }], notes: [] }
    },
  },
  limit: {
    usage: '{ "op": "limit", "n": 100 }',
    run(frame, params) {
      return { frame: withRows(frame, frame.rows.slice(0, num(params, 'n'))), checks: [], notes: ['limit keeps the first rows in current order — not a random sample'] }
    },
  },
  aggregate: {
    usage: '{ "op": "aggregate", "groupBy": ["region", "month"], "metrics": [{ "column": "revenue", "fn": "sum", "as": "revenue" }, { "fn": "count", "as": "orders" }, { "column": "customer_id", "fn": "count_distinct", "as": "customers" }] }',
    run(frame, params) {
      const groupBy = strings(params, 'groupBy', false)
      assertColumns(frame, groupBy, 'aggregate')
      const metrics = metricSpecs(frame, params.metrics)
      const filters = new Map(metrics.filter((metric) => metric.where).map((metric) => [metric.as, compileExpression(metric.where!, frame.columns)]))
      const groups = groupBy.length ? groupRows(frame, groupBy) : new Map([['all', { key: {} as Row, rows: frame.rows }]])
      const rows: Row[] = []
      for (const group of groups.values()) {
        const row: Row = { ...group.key }
        for (const metric of metrics) {
          const scoped = filters.has(metric.as) ? group.rows.filter((r) => filters.get(metric.as)!.test(r)) : group.rows
          row[metric.as] = metric.fn === 'count' && !metric.column ? scoped.length : aggregateValues(scoped.map((r) => r[metric.column!] ?? null), metric.fn)
        }
        rows.push(row)
      }
      rows.sort((a, b) => {
        for (const name of groupBy) {
          const c = compareScalars(a[name], b[name])
          if (c !== 0) return c
        }
        return 0
      })
      const columns = [...groupBy, ...metrics.map((metric) => metric.as)]
      const totalBefore = metrics.filter((metric) => metric.fn === 'sum').map((metric) => ({ metric, total: sum(frame.rows.map((r) => toNumber(r[metric.column!])).filter((v): v is number => v !== undefined)) }))
      const checks: Check[] = totalBefore.filter(({ metric }) => !metric.where).map(({ metric, total }) => {
        const after = sum(rows.map((r) => toNumber(r[metric.as])).filter((v): v is number => v !== undefined))
        const ok = Math.abs(after - total) <= 1e-9 * Math.max(1, Math.abs(total))
        return { name: `sum of ${metric.as} is preserved`, status: ok ? 'pass' : 'fail', detail: `grouped total ${after} vs ungrouped ${total}` }
      })
      return { frame: frameFromRows(rows, columns), checks, notes: [`${frame.rows.length} rows aggregated to ${rows.length} groups${groupBy.length ? ` by ${groupBy.join(', ')}` : ''}`] }
    },
  },
  pivot: {
    usage: '{ "op": "pivot", "index": ["region"], "columns": "month", "values": "revenue", "fn": "sum", "fill": 0 }',
    run(frame, params) {
      const index = strings(params, 'index')
      const pivotColumn = str(params, 'columns')
      const valueColumn = str(params, 'values')
      assertColumns(frame, [...index, pivotColumn, valueColumn], 'pivot')
      const fn = (typeof params.fn === 'string' ? params.fn : 'sum') as Aggregate
      if (!AGGREGATES.includes(fn)) throw new Error(`fn must be one of ${AGGREGATES.join(', ')}`)
      const levels = [...new Set(frame.rows.map((row) => String(row[pivotColumn] ?? 'null')))].sort()
      if (levels.length > 500) throw new Error(`pivot would create ${levels.length} columns; aggregate or filter first`)
      const groups = groupRows(frame, index)
      const rows: Row[] = []
      for (const group of groups.values()) {
        const row: Row = { ...group.key }
        const byLevel = new Map<string, Scalar[]>()
        for (const r of group.rows) {
          const level = String(r[pivotColumn] ?? 'null')
          byLevel.set(level, [...(byLevel.get(level) ?? []), r[valueColumn] ?? null])
        }
        for (const level of levels) row[level] = byLevel.has(level) ? aggregateValues(byLevel.get(level)!, fn) : ((params.fill ?? null) as Scalar)
        rows.push(row)
      }
      return { frame: frameFromRows(rows, [...index, ...levels.filter((level) => !index.includes(level))]), checks: [], notes: [`pivoted ${levels.length} levels of ${pivotColumn} into columns`] }
    },
  },
  melt: {
    usage: '{ "op": "melt", "id": ["region"], "valueColumns": ["jan", "feb"], "variableName": "month", "valueName": "revenue" }',
    run(frame, params) {
      const id = strings(params, 'id')
      const valueColumns = strings(params, 'valueColumns', false)
      const scope = valueColumns.length ? valueColumns : frame.columns.filter((name) => !id.includes(name))
      assertColumns(frame, [...id, ...scope], 'melt')
      const variable = typeof params.variableName === 'string' ? params.variableName : 'variable'
      const valueName = typeof params.valueName === 'string' ? params.valueName : 'value'
      const rows: Row[] = []
      for (const row of frame.rows) for (const name of scope) rows.push({ ...Object.fromEntries(id.map((key) => [key, row[key] ?? null])), [variable]: name, [valueName]: row[name] ?? null })
      return { frame: frameFromRows(rows, [...id, variable, valueName]), checks: [{ name: 'melt row count', status: rows.length === frame.rows.length * scope.length ? 'pass' : 'fail', detail: `${frame.rows.length} × ${scope.length} = ${rows.length} rows` }], notes: [] }
    },
  },
  window: {
    usage: '{ "op": "window", "partitionBy": ["customer_id"], "orderBy": "order_date", "column": "amount", "fn": "lag" | "lead" | "diff" | "pct_change" | "cumsum" | "cummean" | "rolling_mean" | "rolling_sum" | "rolling_std" | "rank" | "dense_rank" | "row_number" | "share_of_total", "periods": 1, "window": 7, "as": "prev_amount" }',
    run(frame, params) {
      const partition = strings(params, 'partitionBy', false)
      const orderBy = strings(params, 'orderBy', false)
      const fn = str(params, 'fn')
      const valueColumn = typeof params.column === 'string' ? params.column : undefined
      assertColumns(frame, [...partition, ...orderBy, ...(valueColumn ? [valueColumn] : [])], 'window')
      if (!['row_number', 'rank', 'dense_rank'].includes(fn) && !valueColumn) throw new Error(`window ${fn} needs column`)
      const target = typeof params.as === 'string' ? params.as : `${fn}_${valueColumn ?? 'row'}`
      const periods = Math.max(1, Math.floor(num(params, 'periods', 1)))
      const size = Math.max(1, Math.floor(num(params, 'window', 3)))
      const desc = params.desc === true
      const indexed = frame.rows.map((row, index) => ({ row, index }))
      const groups = new Map<string, Array<{ row: Row; index: number }>>()
      for (const item of indexed) {
        const key = partition.map((name) => scalarKey(item.row[name] ?? null)).join('\u0001')
        groups.set(key, [...(groups.get(key) ?? []), item])
      }
      const output = new Array<Scalar>(frame.rows.length).fill(null)
      for (const items of groups.values()) {
        if (orderBy.length) items.sort((a, b) => { for (const name of orderBy) { const c = compareScalars(a.row[name], b.row[name]); if (c !== 0) return desc ? -c : c } return a.index - b.index })
        const values = items.map((item) => (valueColumn ? toNumber(item.row[valueColumn]) ?? null : null))
        const total = sum(values.filter((v): v is number => v !== null))
        let running = 0
        let count = 0
        // Ranks in one pass over the sorted partition: ties share a rank.
        const ranks: number[] = []
        const denseRanks: number[] = []
        let previousKey: string | undefined
        items.forEach((item, position) => {
          const key = orderBy.map((name) => scalarKey(item.row[name] ?? null)).join('\u0001')
          const tied = key === previousKey
          ranks.push(tied ? ranks[position - 1]! : position + 1)
          denseRanks.push(tied ? denseRanks[position - 1]! : (denseRanks[position - 1] ?? 0) + 1)
          previousKey = key
        })
        items.forEach((item, position) => {
          const value = values[position]
          let out: Scalar = null
          switch (fn) {
            case 'row_number': out = position + 1; break
            case 'rank': out = ranks[position]!; break
            case 'dense_rank': out = denseRanks[position]!; break
            case 'lag': out = position >= periods ? (valueColumn ? items[position - periods]!.row[valueColumn] ?? null : null) : null; break
            case 'lead': out = position + periods < items.length ? (valueColumn ? items[position + periods]!.row[valueColumn] ?? null : null) : null; break
            case 'diff': { const prev = position >= periods ? values[position - periods] : null; out = value !== null && value !== undefined && prev !== null && prev !== undefined ? value - prev : null; break }
            case 'pct_change': { const prev = position >= periods ? values[position - periods] : null; out = value !== null && value !== undefined && prev ? (value - prev) / Math.abs(prev) : null; break }
            case 'cumsum': if (value !== null && value !== undefined) running += value; out = running; break
            case 'cummean': if (value !== null && value !== undefined) { running += value; count++ } out = count ? running / count : null; break
            case 'share_of_total': out = value !== null && value !== undefined && total !== 0 ? value / total : null; break
            case 'rolling_mean':
            case 'rolling_sum':
            case 'rolling_std': {
              if (position + 1 < size) { out = null; break }
              const windowValues = values.slice(position + 1 - size, position + 1).filter((v): v is number => v !== null)
              if (windowValues.length < size) { out = null; break }
              out = fn === 'rolling_mean' ? mean(windowValues) : fn === 'rolling_sum' ? sum(windowValues) : standardDeviation(windowValues)
              break
            }
            default: throw new Error(`unknown window fn "${fn}"`)
          }
          output[item.index] = out
        })
      }
      const rows = frame.rows.map((row, index) => ({ ...row, [target]: output[index]! }))
      const columns = frame.columns.includes(target) ? frame.columns : [...frame.columns, target]
      const notes = !orderBy.length && ['lag', 'lead', 'diff', 'pct_change', 'cumsum', 'cummean', 'rolling_mean', 'rolling_sum', 'rolling_std'].includes(fn) ? ['no orderBy given: the current row order was used, which is only meaningful if the data is already sorted'] : []
      return { frame: refreshTypes({ columns, types: { ...frame.types }, rows }, [target]), checks: [], notes }
    },
  },
  join: {
    usage: '{ "op": "join", "right": "customers", "on": ["customer_id"] | "leftOn"/"rightOn", "how": "left" | "inner" | "right" | "outer" | "semi" | "anti", "validate": "many_to_one" | "one_to_one" | "one_to_many" | "many_to_many", "suffix": "_right" }',
    run(frame, params, resolve) {
      const right = resolve(str(params, 'right'))
      const on = strings(params, 'on', false)
      const leftOn = on.length ? on : strings(params, 'leftOn')
      const rightOn = on.length ? on : strings(params, 'rightOn')
      if (leftOn.length !== rightOn.length) throw new Error('leftOn and rightOn must list the same number of columns')
      assertColumns(frame, leftOn, 'join (left)')
      assertColumns(right.frame, rightOn, `join (right ${right.ref})`)
      const how = (typeof params.how === 'string' ? params.how : 'left') as 'left' | 'inner' | 'right' | 'outer' | 'semi' | 'anti'
      if (!['left', 'inner', 'right', 'outer', 'semi', 'anti'].includes(how)) throw new Error('how must be left, inner, right, outer, semi, or anti')
      const keyOf = (row: Row, columns: string[]) => {
        if (columns.some((name) => isMissing(row[name]))) return null
        return columns.map((name) => { const value = row[name]; const n = toNumber(value); return n !== undefined ? `n:${n}` : `s:${String(value).trim()}` }).join('\u0001')
      }
      const rightIndex = new Map<string, Row[]>()
      for (const row of right.frame.rows) {
        const key = keyOf(row, rightOn)
        if (key === null) continue
        rightIndex.set(key, [...(rightIndex.get(key) ?? []), row])
      }
      const leftKeys = new Map<string, number>()
      for (const row of frame.rows) {
        const key = keyOf(row, leftOn)
        if (key !== null) leftKeys.set(key, (leftKeys.get(key) ?? 0) + 1)
      }
      const rightDuplicates = [...rightIndex.values()].filter((rows) => rows.length > 1).length
      const leftDuplicates = [...leftKeys.values()].filter((count) => count > 1).length
      const validate = typeof params.validate === 'string' ? params.validate : 'many_to_one'
      const checks: Check[] = []
      if ((validate === 'many_to_one' || validate === 'one_to_one') && rightDuplicates > 0 && how !== 'semi' && how !== 'anti') {
        throw new Error(`join refused: ${rightDuplicates} key value(s) repeat in ${right.ref} (${rightOn.join(', ')}), so each matching left row would be duplicated — the classic row-multiplication error. Aggregate or dedupe the right side to one row per key first, or pass validate "one_to_many"/"many_to_many" if multiplying rows is intended.`)
      }
      if ((validate === 'one_to_one' || validate === 'one_to_many') && leftDuplicates > 0) throw new Error(`join refused: ${leftDuplicates} key value(s) repeat on the left side but validate is "${validate}"`)
      const suffix = typeof params.suffix === 'string' ? params.suffix : '_right'
      const rightColumns = right.frame.columns.filter((name) => !(on.length && rightOn.includes(name)))
      const renamed = new Map(rightColumns.map((name) => [name, frame.columns.includes(name) ? `${name}${suffix}` : name]))
      const outColumns = how === 'semi' || how === 'anti' ? frame.columns : [...frame.columns, ...rightColumns.map((name) => renamed.get(name)!)]
      const rows: Row[] = []
      let matchedLeft = 0
      const matchedRightKeys = new Set<string>()
      for (const row of frame.rows) {
        const key = keyOf(row, leftOn)
        const matches = key === null ? undefined : rightIndex.get(key)
        if (matches) {
          matchedLeft++
          matchedRightKeys.add(key!)
        }
        if (how === 'semi') { if (matches) rows.push(row); continue }
        if (how === 'anti') { if (!matches) rows.push(row); continue }
        if (matches) for (const match of matches) rows.push({ ...row, ...Object.fromEntries(rightColumns.map((name) => [renamed.get(name)!, match[name] ?? null])) })
        else if (how === 'left' || how === 'outer') rows.push({ ...row, ...Object.fromEntries(rightColumns.map((name) => [renamed.get(name)!, null])) })
      }
      if (how === 'right' || how === 'outer') {
        for (const [key, matches] of rightIndex) {
          if (matchedRightKeys.has(key)) continue
          for (const match of matches) {
            const row: Row = Object.fromEntries(frame.columns.map((name) => [name, null]))
            if (on.length) for (const name of on) row[name] = match[name] ?? null
            for (const name of rightColumns) row[renamed.get(name)!] = match[name] ?? null
            rows.push(row)
          }
        }
      }
      const unmatchedLeft = frame.rows.length - matchedLeft
      checks.push({ name: 'join match rate', status: matchedLeft === 0 ? 'fail' : unmatchedLeft / Math.max(1, frame.rows.length) > 0.2 ? 'warn' : 'pass', detail: `${matchedLeft} of ${frame.rows.length} left rows matched (${((100 * matchedLeft) / Math.max(1, frame.rows.length)).toFixed(1)}%); ${unmatchedLeft} unmatched${how === 'inner' && unmatchedLeft ? ' were DROPPED by the inner join' : ''}` })
      if (how === 'left' || how === 'inner') checks.push({ name: 'no row multiplication', status: rows.length <= frame.rows.length ? 'pass' : validate === 'one_to_many' || validate === 'many_to_many' ? 'warn' : 'fail', detail: `${frame.rows.length} left rows → ${rows.length} output rows` })
      const types: Record<string, ColumnType> = { ...frame.types }
      for (const name of rightColumns) types[renamed.get(name)!] = right.frame.types[name] ?? 'string'
      const notes = [...renamed.entries()].filter(([from, to]) => from !== to).map(([from, to]) => `right column ${from} renamed to ${to} to avoid a clash`)
      if (frame.types[leftOn[0]!] !== right.frame.types[rightOn[0]!]) notes.push(`key types differ (${frame.types[leftOn[0]!]} vs ${right.frame.types[rightOn[0]!]}); values were compared numerically where possible, otherwise as trimmed text`)
      return { frame: { columns: outColumns, types, rows }, checks, notes }
    },
  },
  union: {
    usage: '{ "op": "union", "datasets": ["sales_2024", "sales_2025"], "sourceColumn": "source" }',
    run(frame, params, resolve) {
      const others = strings(params, 'datasets').map(resolve)
      const sourceColumn = typeof params.sourceColumn === 'string' ? params.sourceColumn : undefined
      const all = [{ ref: 'current', frame }, ...others]
      const columns = [...new Set(all.flatMap((item) => item.frame.columns))]
      const notes: string[] = []
      for (const item of all) {
        const missing = columns.filter((name) => !item.frame.columns.includes(name))
        if (missing.length) notes.push(`${item.ref} lacks ${missing.join(', ')} (null-filled)`)
      }
      const conflicts = columns.filter((name) => new Set(all.map((item) => item.frame.types[name]).filter((type) => type && type !== 'empty')).size > 1)
      const rows: Row[] = all.flatMap((item) => item.frame.rows.map((row) => ({ ...Object.fromEntries(columns.map((name) => [name, row[name] ?? null])), ...(sourceColumn ? { [sourceColumn]: item.ref } : {}) })))
      const out = frameFromRows(rows, sourceColumn ? [...columns, sourceColumn] : columns)
      return { frame: out, checks: [{ name: 'union row count', status: 'pass', detail: `${rows.length} rows from ${all.length} datasets` }, ...(conflicts.length ? [{ name: 'union type conflicts', status: 'warn' as const, detail: `columns with different types across inputs: ${conflicts.join(', ')}` }] : [])], notes }
    },
  },
  text_clean: {
    usage: '{ "op": "text_clean", "column": "comment", "as": "comment_clean", "lower": true, "stripPunctuation": true, "stripNumbers": false }',
    run(frame, params) {
      const name = str(params, 'column')
      assertColumns(frame, [name], 'text_clean')
      const target = typeof params.as === 'string' ? params.as : name
      const rows = frame.rows.map((row) => {
        const value = row[name]
        if (typeof value !== 'string') return { ...row, [target]: value ?? null }
        let text = value.normalize('NFKC')
        if (params.lower !== false) text = text.toLowerCase()
        if (params.stripPunctuation === true) text = text.replace(/[\p{P}\p{S}]+/gu, ' ')
        if (params.stripNumbers === true) text = text.replace(/\d+/g, ' ')
        return { ...row, [target]: text.replace(/\s+/g, ' ').trim() }
      })
      const columns = frame.columns.includes(target) ? frame.columns : [...frame.columns, target]
      return { frame: { columns, types: { ...frame.types, [target]: 'string' }, rows }, checks: [], notes: [] }
    },
  },
  convert_units: {
    usage: '{ "op": "convert_units", "column": "weight_lb", "factor": 0.45359237, "as": "weight_kg" }  or  { "column": "amount", "currencyColumn": "currency", "rates": { "EUR": 1.08, "GBP": 1.27, "USD": 1 }, "to": "USD", "ratesSource": "ECB reference rates 2025-06-30", "as": "amount_usd" }',
    run(frame, params) {
      const name = str(params, 'column')
      assertColumns(frame, [name], 'convert_units')
      const target = typeof params.as === 'string' ? params.as : name
      const checks: Check[] = []
      let rows: Row[]
      if (typeof params.currencyColumn === 'string') {
        assertColumns(frame, [params.currencyColumn], 'convert_units currencyColumn')
        const rates = params.rates as Record<string, number>
        if (!rates || typeof rates !== 'object') throw new Error('currency conversion needs rates: { "EUR": 1.08, … } expressed in the target currency per unit')
        if (typeof params.ratesSource !== 'string' || !params.ratesSource.trim()) throw new Error('currency conversion needs ratesSource naming where the rates came from and their date — rates are never assumed')
        const currencyColumn = params.currencyColumn
        let unknown = 0
        rows = frame.rows.map((row) => {
          const value = toNumber(row[name])
          const code = String(row[currencyColumn] ?? '').trim().toUpperCase()
          const rate = rates[code]
          if (value === undefined) return { ...row, [target]: null }
          if (rate === undefined) { unknown++; return { ...row, [target]: null } }
          return { ...row, [target]: value * rate }
        })
        checks.push({ name: 'currency conversion', status: unknown ? 'warn' : 'pass', detail: `${unknown} rows had a currency with no supplied rate (left null); rates from ${params.ratesSource}` })
      } else {
        const factor = num(params, 'factor')
        rows = frame.rows.map((row) => { const value = toNumber(row[name]); return { ...row, [target]: value === undefined ? null : value * factor } })
        checks.push({ name: 'unit conversion', status: 'pass', detail: `${name} × ${factor} → ${target}` })
      }
      const columns = frame.columns.includes(target) ? frame.columns : [...frame.columns, target]
      return { frame: { columns, types: { ...frame.types, [target]: 'number' }, rows }, checks, notes: [] }
    },
  },
  retype: {
    usage: '{ "op": "retype", "columns": ["zip"] }  // re-infer column types from their current text values',
    run(frame, params) {
      const columns = strings(params, 'columns')
      assertColumns(frame, columns, 'retype')
      const rows = frame.rows.map((row) => ({ ...row }))
      const types = { ...frame.types }
      for (const name of columns) {
        const raw = rows.map((row) => (row[name] === null || row[name] === undefined ? '' : String(row[name])))
        const inferred = inferStringColumn(raw)
        types[name] = inferred.type
        rows.forEach((row, index) => { row[name] = convertRaw(raw[index]!, inferred) })
      }
      return { frame: { columns: frame.columns, types, rows }, checks: [], notes: columns.map((name) => `${name}: ${types[name]}`) }
    },
  },
}

export const TRANSFORM_OPS = Object.keys(STEPS)

export function transformUsage(op?: string): string {
  if (op && STEPS[op]) return STEPS[op]!.usage
  return Object.entries(STEPS).map(([name, step]) => `${name}: ${step.usage}`).join('\n')
}

/** Runs a pipeline of steps; each step's checks and notes are collected in order. */
export function runPipeline(frame: Frame, steps: unknown[], resolve: FrameResolver): StepResult & { perStep: Array<{ op: string; rowsIn: number; rowsOut: number }> } {
  if (!Array.isArray(steps) || steps.length === 0) throw new Error('steps must be a non-empty array of operations')
  if (steps.length > 100) throw new Error('at most 100 steps per transform call')
  let current = frame
  const checks: Check[] = []
  const notes: string[] = []
  const perStep: Array<{ op: string; rowsIn: number; rowsOut: number }> = []
  steps.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object') throw new Error(`steps[${index}] must be an object with an "op"`)
    const params = raw as Params
    const op = params.op
    if (typeof op !== 'string' || !STEPS[op]) throw new Error(`steps[${index}].op must be one of ${TRANSFORM_OPS.join(', ')}`)
    try {
      const result = STEPS[op]!.run(current, params, resolve)
      perStep.push({ op, rowsIn: current.rows.length, rowsOut: result.frame.rows.length })
      checks.push(...result.checks.map((check) => ({ ...check, name: `step ${index + 1} (${op}): ${check.name}` })))
      notes.push(...result.notes.map((note) => `step ${index + 1} (${op}): ${note}`))
      current = result.frame
    } catch (error) {
      throw new Error(`steps[${index}] (${op}) failed: ${(error as Error).message}\nusage: ${STEPS[op]!.usage}`)
    }
  })
  return { frame: current, checks, notes, perStep }
}

export { toDateMs }
