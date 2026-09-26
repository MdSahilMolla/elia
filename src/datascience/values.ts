/**
 * Scalar values, strict parsing, and column type inference for the data-science engine.
 *
 * Parsing is deliberately strict. `Date.parse("1")` is a valid date in JavaScriptCore and
 * `Number("0123")` silently drops a leading zero that makes a ZIP or account code an
 * identifier, so both would quietly change what the data means. A column is typed only when
 * every non-missing value parses; anything less stays a string and the quality engine
 * reports the near-miss instead of this module repairing it.
 */

export type Scalar = number | string | boolean | null
export type Row = Record<string, Scalar>
export type ColumnType = 'integer' | 'number' | 'boolean' | 'date' | 'datetime' | 'string' | 'empty'

const INTEGER = /^[+-]?\d+$/
const DECIMAL = /^[+-]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?$/
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const ISO_DATETIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})?$/
const SLASH_DATE = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/
const YMD_SLASH = /^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/

/** Tokens that people use to mean "missing" but that a loader must not silently treat as missing. */
export const MISSING_MARKERS = new Set(['na', 'n/a', 'null', 'none', 'nan', '-', '--', '?', '#n/a', 'nil', 'missing', 'undefined', '(blank)'])

export function isMissing(value: unknown): value is null | undefined {
  return value === null || value === undefined || value === '' || (typeof value === 'number' && Number.isNaN(value))
}

/** A finite number from a number or a strictly numeric string; undefined otherwise. */
export function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!DECIMAL.test(trimmed)) return undefined
    const parsed = Number(trimmed)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function validCalendar(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return day <= days
}

/**
 * Parses a date or timestamp string to epoch milliseconds (UTC), or undefined.
 * `dayFirst` decides the ambiguous `03/04/2025` form; ISO forms never are ambiguous.
 */
export function parseDateMs(value: unknown, dayFirst = false): number | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  let match = ISO_DATE.exec(text)
  if (match) {
    const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
    return validCalendar(year, month, day) ? Date.UTC(year, month - 1, day) : undefined
  }
  match = ISO_DATETIME.exec(text)
  if (match) {
    const [year, month, day, hour, minute, second] = [1, 2, 3, 4, 5, 6].map((index) => Number(match![index] ?? 0)) as [number, number, number, number, number, number]
    if (!validCalendar(year, month, day) || hour > 23 || minute > 59 || second > 60) return undefined
    const fraction = match[7] ? Number(`0.${match[7]}`) * 1000 : 0
    let ms = Date.UTC(year, month - 1, day, hour, minute, second) + Math.round(fraction)
    const zone = match[8]
    if (zone && zone !== 'Z') {
      const sign = zone.startsWith('-') ? -1 : 1
      const digits = zone.slice(1).replace(':', '')
      ms -= sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4))) * 60_000
    }
    return ms
  }
  match = YMD_SLASH.exec(text)
  if (match) {
    const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
    return validCalendar(year, month, day) ? Date.UTC(year, month - 1, day) : undefined
  }
  match = SLASH_DATE.exec(text)
  if (match) {
    const first = Number(match[1])
    const second = Number(match[2])
    const year = Number(match[3])
    const [month, day] = dayFirst ? [second, first] : [first, second]
    return validCalendar(year, month, day) ? Date.UTC(year, month - 1, day) : undefined
  }
  return undefined
}

export function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

export function isoDateTime(ms: number): string {
  return new Date(ms).toISOString()
}

/** Epoch ms for a value already stored as a date/datetime string, or a Date-like number. */
export function toDateMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return parseDateMs(value)
}

export interface InferredColumn {
  type: ColumnType
  /** For slash dates: whether the column reads day-first. */
  dayFirst?: boolean
  /** Why a date column's day/month order was chosen, when it could not be proven. */
  ambiguousDateOrder?: boolean
  /** Values that stopped the column from being typed as its dominant type, with the share that did parse. */
  nearType?: { type: ColumnType; share: number; examples: string[] }
}

function slashOrder(values: string[]): { dayFirst: boolean; ambiguous: boolean } {
  let dayFirstEvidence = false
  let monthFirstEvidence = false
  for (const value of values) {
    const match = SLASH_DATE.exec(value.trim())
    if (!match) continue
    if (Number(match[1]) > 12) dayFirstEvidence = true
    if (Number(match[2]) > 12) monthFirstEvidence = true
  }
  if (dayFirstEvidence && !monthFirstEvidence) return { dayFirst: true, ambiguous: false }
  if (monthFirstEvidence && !dayFirstEvidence) return { dayFirst: false, ambiguous: false }
  return { dayFirst: false, ambiguous: true }
}

/** Infers the type of a column of raw strings. Every non-missing value must parse for a typed result. */
export function inferStringColumn(raw: string[]): InferredColumn {
  const present = raw.map((value) => value.trim()).filter((value) => value !== '')
  if (present.length === 0) return { type: 'empty' }
  const counts = { integer: 0, number: 0, boolean: 0, date: 0, datetime: 0 }
  const hasSlashDates = present.some((value) => SLASH_DATE.test(value))
  const order = hasSlashDates ? slashOrder(present) : { dayFirst: false, ambiguous: false }
  const failures: Record<keyof typeof counts, string[]> = { integer: [], number: [], boolean: [], date: [], datetime: [] }
  for (const value of present) {
    const leadingZero = /^[+-]?0\d/.test(value)
    if (INTEGER.test(value) && !leadingZero) counts.integer++
    else failures.integer.push(value)
    if (DECIMAL.test(value) && !leadingZero && Number.isFinite(Number(value))) counts.number++
    else failures.number.push(value)
    if (/^(true|false)$/i.test(value)) counts.boolean++
    else failures.boolean.push(value)
    const isDateOnly = ISO_DATE.test(value) || YMD_SLASH.test(value) || SLASH_DATE.test(value)
    const ms = parseDateMs(value, order.dayFirst)
    if (ms !== undefined && isDateOnly) counts.date++
    else failures.date.push(value)
    if (ms !== undefined) counts.datetime++
    else failures.datetime.push(value)
  }
  const n = present.length
  if (counts.boolean === n) return { type: 'boolean' }
  if (counts.integer === n) return { type: 'integer' }
  if (counts.number === n) return { type: 'number' }
  if (counts.date === n) return { type: 'date', ...(hasSlashDates ? { dayFirst: order.dayFirst, ambiguousDateOrder: order.ambiguous } : {}) }
  if (counts.datetime === n) return { type: 'datetime', ...(hasSlashDates ? { dayFirst: order.dayFirst, ambiguousDateOrder: order.ambiguous } : {}) }
  const candidates: Array<[ColumnType, number, string[]]> = [
    ['number', counts.number, failures.number],
    ['datetime', counts.datetime, failures.datetime],
    ['boolean', counts.boolean, failures.boolean],
  ]
  const best = candidates.sort((a, b) => b[1] - a[1])[0]!
  const share = best[1] / n
  return share >= 0.8 ? { type: 'string', nearType: { type: best[0], share, examples: [...new Set(best[2])].slice(0, 5) } } : { type: 'string' }
}

/** Converts one raw string to a scalar of the inferred column type. */
export function convertRaw(value: string, inferred: InferredColumn): Scalar {
  const trimmed = value.trim()
  if (trimmed === '') return null
  switch (inferred.type) {
    case 'integer':
    case 'number':
      return Number(trimmed)
    case 'boolean':
      return trimmed.toLowerCase() === 'true'
    case 'date': {
      const ms = parseDateMs(trimmed, inferred.dayFirst)
      return ms === undefined ? trimmed : isoDate(ms)
    }
    case 'datetime': {
      const ms = parseDateMs(trimmed, inferred.dayFirst)
      return ms === undefined ? trimmed : isoDateTime(ms)
    }
    default:
      return value
  }
}

/** Infers the type of a column of already-typed scalars (JSON, SQL, derived data). */
export function inferScalarColumn(values: Scalar[]): ColumnType {
  const present = values.filter((value) => !isMissing(value))
  if (present.length === 0) return 'empty'
  if (present.every((value) => typeof value === 'boolean')) return 'boolean'
  if (present.every((value) => typeof value === 'number')) return present.every((value) => Number.isInteger(value)) ? 'integer' : 'number'
  if (present.every((value) => typeof value === 'string')) {
    const strings = present as string[]
    if (strings.every((value) => ISO_DATE.test(value) && parseDateMs(value) !== undefined)) return 'date'
    if (strings.every((value) => ISO_DATETIME.test(value) && parseDateMs(value) !== undefined)) return 'datetime'
    return 'string'
  }
  return 'string'
}

export function isNumericType(type: ColumnType): boolean {
  return type === 'integer' || type === 'number'
}

export function isTemporalType(type: ColumnType): boolean {
  return type === 'date' || type === 'datetime'
}

/** Normalises any JS value to a Scalar; nested objects and arrays become JSON text. */
export function toScalar(value: unknown): Scalar {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return Number(value)
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
  if (value instanceof Uint8Array) return `<${value.byteLength} bytes>`
  return JSON.stringify(value)
}

/** A stable key for grouping and distinct counts that keeps 1 and "1" apart. */
export function scalarKey(value: Scalar | undefined): string {
  if (value === null || value === undefined) return '\u0000null'
  if (typeof value === 'number') return `n:${value}`
  if (typeof value === 'boolean') return `b:${value}`
  return `s:${value}`
}

/** Total order for sorting: nulls last, numbers before strings. */
export function compareScalars(a: Scalar | undefined, b: Scalar | undefined): number {
  const aMissing = isMissing(a)
  const bMissing = isMissing(b)
  if (aMissing || bMissing) return aMissing === bMissing ? 0 : aMissing ? 1 : -1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b)
  if (typeof a === 'number') return -1
  if (typeof b === 'number') return 1
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0
}

/** Rounds for display without turning small values into zero. */
export function round(value: number | null | undefined, digits = 6): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null
  if (value === 0) return 0
  const magnitude = Math.floor(Math.log10(Math.abs(value)))
  const places = Math.max(digits, digits - magnitude - 1)
  return Number(value.toFixed(Math.min(places, 15)))
}
