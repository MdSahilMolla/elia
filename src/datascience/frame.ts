import { createHash } from 'node:crypto'
import { inferScalarColumn, isMissing, isNumericType, toDateMs, toNumber, type ColumnType, type Row, type Scalar } from './values.ts'

/**
 * A row-oriented table with a declared schema. Row-oriented because transformations,
 * joins, and lineage are row operations; numerical code converts the columns it needs to
 * Float64Array through {@link numericMatrix} rather than working on objects.
 */
export interface Frame {
  columns: string[]
  types: Record<string, ColumnType>
  rows: Row[]
}

/** Hard ceiling on rows held in memory by the TypeScript engine. Larger inputs are sampled explicitly, never silently. */
export const MAX_FRAME_ROWS = 2_000_000
export const MAX_FRAME_CELLS = 40_000_000

export function frameFromRows(rows: Row[], columns?: string[], types?: Record<string, ColumnType>): Frame {
  const names = columns ?? [...new Set(rows.flatMap((row) => Object.keys(row)))]
  const normalized = rows.map((row) => {
    const out: Row = {}
    for (const name of names) out[name] = row[name] ?? null
    return out
  })
  const schema: Record<string, ColumnType> = {}
  for (const name of names) schema[name] = types?.[name] ?? inferScalarColumn(normalized.map((row) => row[name] ?? null))
  return { columns: names, types: schema, rows: normalized }
}

export function refreshTypes(frame: Frame, only?: string[]): Frame {
  const types = { ...frame.types }
  for (const name of only ?? frame.columns) types[name] = inferScalarColumn(frame.rows.map((row) => row[name] ?? null))
  return { ...frame, types }
}

export function column(frame: Frame, name: string): Scalar[] {
  return frame.rows.map((row) => row[name] ?? null)
}

/** Closest existing column names, for error messages that tell the model what it meant. */
export function suggestColumns(frame: Frame, name: string, limit = 3): string[] {
  const target = name.toLowerCase()
  const distance = (a: string, b: string) => {
    const dp = Array.from({ length: b.length + 1 }, (_, index) => index)
    for (let i = 1; i <= a.length; i++) {
      let previous = dp[0]!
      dp[0] = i
      for (let j = 1; j <= b.length; j++) {
        const current = dp[j]!
        dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1))
        previous = current
      }
    }
    return dp[b.length]!
  }
  return frame.columns
    .map((candidate) => ({ candidate, score: candidate.toLowerCase().includes(target) || target.includes(candidate.toLowerCase()) ? 0 : distance(candidate.toLowerCase(), target) }))
    .sort((a, b) => a.score - b.score)
    .slice(0, limit)
    .map((entry) => entry.candidate)
}

export function assertColumns(frame: Frame, names: string[], context: string): void {
  for (const name of names) {
    if (!frame.columns.includes(name)) {
      const suggestions = suggestColumns(frame, name)
      throw new Error(`${context}: column "${name}" does not exist.${suggestions.length ? ` Did you mean ${suggestions.map((s) => `"${s}"`).join(', ')}?` : ''} Columns: ${frame.columns.slice(0, 40).join(', ')}${frame.columns.length > 40 ? ', …' : ''}`)
    }
  }
}

export function numericValues(frame: Frame, name: string): number[] {
  const out: number[] = []
  for (const row of frame.rows) {
    const value = toNumber(row[name])
    if (value !== undefined) out.push(value)
  }
  return out
}

/** Column values as numbers, keeping row alignment: a missing or non-numeric cell is NaN. */
export function alignedNumbers(frame: Frame, name: string): Float64Array {
  const out = new Float64Array(frame.rows.length)
  frame.rows.forEach((row, index) => {
    const value = frame.types[name] === 'date' || frame.types[name] === 'datetime' ? toDateMs(row[name]) : toNumber(row[name])
    out[index] = value === undefined ? Number.NaN : value
  })
  return out
}

export function isNumericColumn(frame: Frame, name: string): boolean {
  return isNumericType(frame.types[name] ?? 'string')
}

export function missingCount(frame: Frame, name: string): number {
  let count = 0
  for (const row of frame.rows) if (isMissing(row[name])) count++
  return count
}

/** SHA-256 over the canonical schema and rows: the version identity of a dataset's content. */
export function fingerprintFrame(frame: Frame): string {
  const hash = createHash('sha256')
  hash.update(JSON.stringify(frame.columns))
  hash.update(JSON.stringify(frame.columns.map((name) => frame.types[name])))
  for (const row of frame.rows) hash.update(JSON.stringify(frame.columns.map((name) => row[name] ?? null)))
  return hash.digest('hex')
}

/** A bounded, JSON-safe preview for the model: the first rows, never the whole table. */
export function previewRows(frame: Frame, limit = 10): Row[] {
  return frame.rows.slice(0, limit).map((row) => {
    const out: Row = {}
    for (const name of frame.columns) {
      const value = row[name] ?? null
      out[name] = typeof value === 'string' && value.length > 200 ? `${value.slice(0, 200)}…` : value
    }
    return out
  })
}

export function assertFrameSize(frame: Frame, context: string): void {
  if (frame.rows.length > MAX_FRAME_ROWS) throw new Error(`${context}: ${frame.rows.length} rows exceeds the in-memory limit of ${MAX_FRAME_ROWS}; aggregate or sample in the source query first.`)
  if (frame.rows.length * Math.max(1, frame.columns.length) > MAX_FRAME_CELLS) throw new Error(`${context}: ${frame.rows.length}×${frame.columns.length} cells exceeds the in-memory limit of ${MAX_FRAME_CELLS}; select fewer columns or aggregate first.`)
}
