import { existsSync, readFileSync } from 'node:fs'
import { extname } from 'node:path'
import { resolvePath } from '../autonomy/context.ts'
import type { Tool } from './types.ts'

type DataScienceAction = 'profile' | 'validate' | 'group_summary' | 'correlation' | 'linear_regression'
type Row = Record<string, unknown>

interface Dataset {
  path: string
  parser: 'csv' | 'tsv' | 'json' | 'jsonl'
  rows: Row[]
  columns: string[]
}

const MAX_ROWS = 100_000
const MAX_OUTPUT_ROWS = 500

function scalar(value: string): unknown {
  const trimmed = value.trim()
  if (trimmed === '') return null
  if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === 'true'
  if (/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(trimmed)) {
    const number = Number(trimmed)
    if (Number.isFinite(number)) return number
  }
  return trimmed
}

function parseDelimited(text: string, delimiter: string): Row[] {
  const records: string[][] = []
  let record: string[] = []
  let field = ''
  let quoted = false
  for (let index = 0; index < text.length; index++) {
    const character = text[index]
    const next = text[index + 1]
    if (quoted) {
      if (character === '"' && next === '"') {
        field += '"'
        index++
      } else if (character === '"') {
        quoted = false
      } else {
        field += character
      }
    } else if (character === '"' && field.length === 0) {
      quoted = true
    } else if (character === delimiter) {
      record.push(field)
      field = ''
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && next === '\n') index++
      record.push(field)
      if (record.some((value) => value.trim() !== '')) records.push(record)
      record = []
      field = ''
    } else {
      field += character
    }
  }
  if (field.length > 0 || record.length > 0) {
    record.push(field)
    if (record.some((value) => value.trim() !== '')) records.push(record)
  }
  const headers = (records.shift() ?? []).map((header, index) => header.trim() || `column_${index + 1}`)
  return records.slice(0, MAX_ROWS).map((values) => Object.fromEntries(headers.map((header, index) => [header, scalar(values[index] ?? '')])))
}

function parseJson(text: string, parser: 'json' | 'jsonl'): Row[] {
  if (parser === 'jsonl') {
    return text.split(/\r?\n/).filter((line) => line.trim()).slice(0, MAX_ROWS).map((line, index) => {
      const value: unknown = JSON.parse(line)
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`JSONL line ${index + 1} must contain an object`)
      return value as Row
    })
  }
  const parsed: unknown = JSON.parse(text)
  const values = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' && Array.isArray((parsed as { data?: unknown }).data) ? (parsed as { data: unknown[] }).data : undefined
  if (!values) throw new Error('JSON input must be an array of objects or an object with a data array')
  return values.slice(0, MAX_ROWS).map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`JSON row ${index + 1} must be an object`)
    return value as Row
  })
}

function readDataset(inputPath: string): Dataset {
  const path = resolvePath(inputPath)
  if (!existsSync(path)) throw new Error(`Dataset not found: ${path}`)
  const extension = extname(path).toLowerCase()
  const text = readFileSync(path, 'utf8')
  let parser: Dataset['parser']
  let rows: Row[]
  if (extension === '.jsonl' || extension === '.ndjson') {
    parser = 'jsonl'
    rows = parseJson(text, parser)
  } else if (extension === '.json') {
    parser = 'json'
    rows = parseJson(text, parser)
  } else if (extension === '.tsv') {
    parser = 'tsv'
    rows = parseDelimited(text, '\t')
  } else {
    parser = 'csv'
    rows = parseDelimited(text, ',')
  }
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))]
  return { path, parser, rows, columns }
}

function values(dataset: Dataset, column: string): unknown[] {
  return dataset.rows.map((row) => row[column]).filter((value) => value !== null && value !== undefined && value !== '')
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function numericValues(dataset: Dataset, column: string): number[] {
  return values(dataset, column).map(numberValue).filter((value): value is number => value !== undefined)
}

function percentile(sorted: number[], probability: number): number | null {
  if (sorted.length === 0) return null
  const position = (sorted.length - 1) * probability
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  const lowerValue = sorted[lower]
  const upperValue = sorted[upper]
  if (lowerValue === undefined || upperValue === undefined) return null
  return lower === upper ? lowerValue : lowerValue + (upperValue - lowerValue) * (position - lower)
}

function numericSummary(dataset: Dataset, column: string): Record<string, number | null> | null {
  const numbers = numericValues(dataset, column).sort((a, b) => a - b)
  if (numbers.length === 0 || numbers.length !== values(dataset, column).length) return null
  const sum = numbers.reduce((total, value) => total + value, 0)
  return {
    count: numbers.length,
    sum,
    mean: sum / numbers.length,
    min: numbers[0] ?? null,
    p25: percentile(numbers, 0.25),
    median: percentile(numbers, 0.5),
    p75: percentile(numbers, 0.75),
    max: numbers.at(-1) ?? null,
  }
}

function inferType(columnValues: unknown[]): string {
  const present = columnValues.filter((value) => value !== null && value !== undefined && value !== '')
  if (present.length === 0) return 'empty'
  if (present.every((value) => numberValue(value) !== undefined)) return 'number'
  if (present.every((value) => typeof value === 'boolean')) return 'boolean'
  if (present.every((value) => typeof value === 'string' && !Number.isNaN(Date.parse(value)))) return 'date-like'
  return 'string'
}

function profile(dataset: Dataset): string {
  const columns = dataset.columns.map((column) => {
    const columnValues = dataset.rows.map((row) => row[column])
    const present = columnValues.filter((value) => value !== null && value !== undefined && value !== '')
    return {
      name: column,
      inferredType: inferType(columnValues),
      missing: columnValues.length - present.length,
      missingRate: dataset.rows.length ? (columnValues.length - present.length) / dataset.rows.length : 0,
      unique: new Set(present.map((value) => JSON.stringify(value))).size,
      numericSummary: numericSummary(dataset, column),
    }
  })
  const duplicateRows = dataset.rows.length - new Set(dataset.rows.map((row) => JSON.stringify(row))).size
  return JSON.stringify({
    action: 'profile',
    dataset: { path: dataset.path, parser: dataset.parser, rows: dataset.rows.length, columns: dataset.columns },
    columns,
    duplicateRows,
    qualityStatus: columns.some((column) => column.missingRate > 0 || column.inferredType === 'empty') || duplicateRows > 0 ? 'review' : 'pass',
    limitations: ['Type inference is heuristic and does not establish semantic meaning, causality, or absence of leakage.', 'Rows beyond the bounded scan limit are not included.', 'Missingness and duplicates are reported, not silently repaired.'],
  }, null, 2)
}

function validate(dataset: Dataset, input: Record<string, unknown>): string {
  const requiredColumns = Array.isArray(input.requiredColumns) ? input.requiredColumns.filter((value): value is string => typeof value === 'string') : []
  const uniqueColumns = Array.isArray(input.uniqueColumns) ? input.uniqueColumns.filter((value): value is string => typeof value === 'string') : []
  const notNullColumns = Array.isArray(input.notNullColumns) ? input.notNullColumns.filter((value): value is string => typeof value === 'string') : []
  const numericColumns = Array.isArray(input.numericColumns) ? input.numericColumns.filter((value): value is string => typeof value === 'string') : []
  const minRows = typeof input.minRows === 'number' && Number.isFinite(input.minRows) ? Math.max(0, Math.floor(input.minRows)) : 0
  const issues: Array<{ rule: string; column?: string; detail: string }> = []
  for (const column of requiredColumns) if (!dataset.columns.includes(column)) issues.push({ rule: 'required-column', column, detail: 'column is missing' })
  if (dataset.rows.length < minRows) issues.push({ rule: 'minimum-rows', detail: `expected at least ${minRows} rows, found ${dataset.rows.length}` })
  for (const column of notNullColumns) {
    if (!dataset.columns.includes(column)) continue
    const missing = dataset.rows.filter((row) => row[column] === null || row[column] === undefined || row[column] === '').length
    if (missing > 0) issues.push({ rule: 'not-null', column, detail: `${missing} rows are missing a value` })
  }
  for (const column of numericColumns) {
    if (!dataset.columns.includes(column)) continue
    const invalid = values(dataset, column).filter((value) => numberValue(value) === undefined).length
    if (invalid > 0) issues.push({ rule: 'numeric', column, detail: `${invalid} non-numeric values found` })
  }
  for (const column of uniqueColumns) {
    if (!dataset.columns.includes(column)) continue
    const seen = new Set<string>()
    let duplicates = 0
    for (const row of dataset.rows) {
      const key = JSON.stringify(row[column] ?? null)
      if (seen.has(key)) duplicates++
      seen.add(key)
    }
    if (duplicates > 0) issues.push({ rule: 'unique', column, detail: `${duplicates} duplicate values found` })
  }
  return JSON.stringify({ action: 'validate', dataset: { path: dataset.path, rows: dataset.rows.length, columns: dataset.columns }, rules: { requiredColumns, uniqueColumns, notNullColumns, numericColumns, minRows }, status: issues.length === 0 ? 'pass' : 'review', issues }, null, 2)
}

function groupSummary(dataset: Dataset, input: Record<string, unknown>): string {
  const groupBy = input.groupBy
  const measure = input.measure
  if (typeof groupBy !== 'string' || !dataset.columns.includes(groupBy)) throw new Error('group_summary requires a valid groupBy column')
  if (typeof measure !== 'string' || !dataset.columns.includes(measure)) throw new Error('group_summary requires a valid measure column')
  const groups = new Map<string, number[]>()
  for (const row of dataset.rows) {
    const key = String(row[groupBy] ?? '(blank)')
    const value = numberValue(row[measure])
    const current = groups.get(key) ?? []
    if (value !== undefined) current.push(value)
    groups.set(key, current)
  }
  const summaries = [...groups.entries()].map(([group, groupValues]) => {
    const sorted = [...groupValues].sort((a, b) => a - b)
    const sum = sorted.reduce((total, value) => total + value, 0)
    return { group, count: groupValues.length, sum, mean: groupValues.length ? sum / groupValues.length : null, median: percentile(sorted, 0.5), min: sorted[0] ?? null, max: sorted.at(-1) ?? null }
  }).sort((a, b) => (b.sum ?? 0) - (a.sum ?? 0)).slice(0, MAX_OUTPUT_ROWS)
  return JSON.stringify({ action: 'group_summary', dataset: { path: dataset.path, rows: dataset.rows.length }, groupBy, measure, groups: summaries, limitations: ['Rows with non-numeric measures are excluded from group aggregates and are not imputed.'] }, null, 2)
}

function linearRegression(dataset: Dataset, input: Record<string, unknown>): string {
  const xColumn = input.xColumn
  const yColumn = input.yColumn
  if (typeof xColumn !== 'string' || !dataset.columns.includes(xColumn)) throw new Error('linear_regression requires a valid xColumn')
  if (typeof yColumn !== 'string' || !dataset.columns.includes(yColumn)) throw new Error('linear_regression requires a valid yColumn')
  const pairs = dataset.rows.map((row) => [numberValue(row[xColumn]), numberValue(row[yColumn])] as const).filter((pair): pair is readonly [number, number] => pair[0] !== undefined && pair[1] !== undefined)
  if (pairs.length < 3) throw new Error('linear_regression requires at least three complete numeric pairs')
  const xMean = pairs.reduce((sum, pair) => sum + pair[0], 0) / pairs.length
  const yMean = pairs.reduce((sum, pair) => sum + pair[1], 0) / pairs.length
  const sumXX = pairs.reduce((sum, pair) => sum + (pair[0] - xMean) ** 2, 0)
  if (sumXX === 0) throw new Error('linear_regression requires variation in xColumn')
  const slope = pairs.reduce((sum, pair) => sum + (pair[0] - xMean) * (pair[1] - yMean), 0) / sumXX
  const intercept = yMean - slope * xMean
  const residuals = pairs.map(([x, y]) => y - (intercept + slope * x))
  const residualSumSquares = residuals.reduce((sum, residual) => sum + residual ** 2, 0)
  const totalSumSquares = pairs.reduce((sum, pair) => sum + (pair[1] - yMean) ** 2, 0)
  return JSON.stringify({
    action: 'linear_regression',
    dataset: { path: dataset.path, rows: dataset.rows.length },
    xColumn,
    yColumn,
    completePairs: pairs.length,
    coefficients: { intercept, slope },
    metrics: { rSquared: totalSumSquares === 0 ? null : 1 - residualSumSquares / totalSumSquares, rmse: Math.sqrt(residualSumSquares / pairs.length) },
    interpretation: 'This is an ordinary-least-squares fit for the supplied sample. Coefficients describe association under the model; they do not establish causation, forecast validity, statistical significance, or absence of confounding and leakage.',
    limitations: ['No confidence intervals, p-values, robust errors, nonlinear terms, cross-validation, causal identification, or outlier treatment is performed.'],
  }, null, 2)
}

function correlation(dataset: Dataset, input: Record<string, unknown>): string {
  const xColumn = input.xColumn
  const yColumn = input.yColumn
  if (typeof xColumn !== 'string' || !dataset.columns.includes(xColumn)) throw new Error('correlation requires a valid xColumn')
  if (typeof yColumn !== 'string' || !dataset.columns.includes(yColumn)) throw new Error('correlation requires a valid yColumn')
  const pairs = dataset.rows.map((row) => [numberValue(row[xColumn]), numberValue(row[yColumn])] as const).filter((pair): pair is readonly [number, number] => pair[0] !== undefined && pair[1] !== undefined)
  if (pairs.length < 2) throw new Error('correlation requires at least two complete numeric pairs')
  const xMean = pairs.reduce((sum, pair) => sum + pair[0], 0) / pairs.length
  const yMean = pairs.reduce((sum, pair) => sum + pair[1], 0) / pairs.length
  const numerator = pairs.reduce((sum, pair) => sum + (pair[0] - xMean) * (pair[1] - yMean), 0)
  const xVariance = pairs.reduce((sum, pair) => sum + (pair[0] - xMean) ** 2, 0)
  const yVariance = pairs.reduce((sum, pair) => sum + (pair[1] - yMean) ** 2, 0)
  const denominator = Math.sqrt(xVariance * yVariance)
  return JSON.stringify({ action: 'correlation', dataset: { path: dataset.path, rows: dataset.rows.length }, xColumn, yColumn, completePairs: pairs.length, pearsonR: denominator === 0 ? null : numerator / denominator, interpretation: 'Correlation measures linear association in the supplied sample; it does not establish causation or control for confounding variables.', limitations: ['No causal inference, statistical significance test, confidence interval, or leakage analysis is performed.'] }, null, 2)
}

export function validateDataScienceRequest(input: Record<string, unknown>): { action: DataScienceAction; path: string } {
  const action = input.action
  if (typeof action !== 'string' || !['profile', 'validate', 'group_summary', 'correlation', 'linear_regression'].includes(action)) throw new Error('action must be profile, validate, group_summary, correlation, or linear_regression')
  if (typeof input.path !== 'string' || input.path.trim() === '') throw new Error('path is required')
  return { action: action as DataScienceAction, path: input.path }
}

export const dataScienceTool: Tool = {
  name: 'data_science',
  description: 'Run deterministic, reproducible data-science workflows on CSV, TSV, JSON, or JSONL files: profile schema/types/missingness/duplicates, validate explicit data-quality rules, compute bounded group summaries, calculate Pearson correlation, or fit a simple linear regression. It does not silently impute/drop data, infer causality, or claim statistical significance.',
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['profile', 'validate', 'group_summary', 'correlation', 'linear_regression'] },
      path: { type: 'string', description: 'CSV, TSV, JSON, or JSONL dataset path' },
      requiredColumns: { type: 'array' },
      uniqueColumns: { type: 'array' },
      notNullColumns: { type: 'array' },
      numericColumns: { type: 'array' },
      minRows: { type: 'number' },
      groupBy: { type: 'string' },
      measure: { type: 'string' },
      xColumn: { type: 'string' },
      yColumn: { type: 'string' },
    },
    required: ['action', 'path'],
  },
  async execute(input) {
    const request = validateDataScienceRequest(input)
    const dataset = readDataset(request.path)
    if (request.action === 'profile') return profile(dataset)
    if (request.action === 'validate') return validate(dataset, input)
    if (request.action === 'group_summary') return groupSummary(dataset, input)
    if (request.action === 'linear_regression') return linearRegression(dataset, input)
    return correlation(dataset, input)
  },
}

export { readDataset, profile, validate, groupSummary, correlation, linearRegression }
