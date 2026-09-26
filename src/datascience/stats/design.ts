import { assertColumns, type Frame } from '../frame.ts'
import { isMissing, scalarKey, toNumber, type Scalar } from '../values.ts'
import type { Matrix } from './linalg.ts'

/**
 * Builds a numeric design matrix from a frame: numeric columns as-is, booleans as 0/1,
 * categorical columns as treatment (dummy) codes against a reference level, optional
 * pairwise interactions, and an intercept. Rows missing any used value are dropped
 * listwise and the count is reported — never imputed silently here.
 */

export interface DesignSpec {
  target?: string
  features: string[]
  /** Force these features to be treated as categorical even if numeric (e.g. a store id). */
  categorical?: string[]
  /** Reference level per categorical feature; defaults to the most frequent level. */
  reference?: Record<string, string>
  intercept?: boolean
  interactions?: Array<[string, string]>
  /** Maximum levels for one categorical feature before the build refuses. */
  maxLevels?: number
}

export interface CategoricalEncoding {
  feature: string
  reference: string
  levels: string[]
}

export interface Design {
  x: Matrix
  y?: number[]
  names: string[]
  /** Original frame row index for each design row. */
  rowIndex: number[]
  droppedRows: number
  categorical: CategoricalEncoding[]
  intercept: boolean
}

function levelKey(value: Scalar): string {
  return typeof value === 'string' ? value : String(value)
}

export function isCategoricalFeature(frame: Frame, feature: string, forced: string[] = []): boolean {
  if (forced.includes(feature)) return true
  const type = frame.types[feature]
  return type === 'string' || type === 'boolean' || type === 'empty'
}

export function buildDesign(frame: Frame, spec: DesignSpec, targetTransform?: (value: Scalar) => number | undefined): Design {
  const features = [...new Set(spec.features)]
  if (features.length === 0) throw new Error('at least one feature is required')
  assertColumns(frame, [...features, ...(spec.target ? [spec.target] : [])], 'design matrix')
  if (spec.target && features.includes(spec.target)) throw new Error(`the target "${spec.target}" cannot also be a feature`)
  for (const feature of features) {
    if (frame.types[feature] === 'date' || frame.types[feature] === 'datetime') throw new Error(`feature "${feature}" is a date; derive numeric features first (e.g. year(${feature}), days_between(...)) with a derive transform`)
  }
  const forced = spec.categorical ?? []
  const maxLevels = spec.maxLevels ?? 60
  const intercept = spec.intercept ?? true
  const used = [...features, ...(spec.target ? [spec.target] : [])]
  const rowIndex: number[] = []
  for (let index = 0; index < frame.rows.length; index++) {
    const row = frame.rows[index]!
    let complete = true
    for (const name of used) {
      const value = row[name]
      if (isMissing(value)) { complete = false; break }
      if (name === spec.target && targetTransform) {
        if (targetTransform(value ?? null) === undefined) { complete = false; break }
      } else if (!isCategoricalFeature(frame, name, forced) && toNumber(value) === undefined) {
        complete = false
        break
      }
    }
    if (complete) rowIndex.push(index)
  }
  const categorical: CategoricalEncoding[] = []
  for (const feature of features) {
    if (!isCategoricalFeature(frame, feature, forced)) continue
    const counts = new Map<string, number>()
    for (const index of rowIndex) {
      const key = levelKey(frame.rows[index]![feature] ?? null)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    if (counts.size > maxLevels) throw new Error(`categorical feature "${feature}" has ${counts.size} levels (limit ${maxLevels}); group rare levels first or treat it as an identifier, not a feature`)
    const byFrequency = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([level]) => level)
    const reference = spec.reference?.[feature] ?? byFrequency[0]!
    if (!counts.has(reference)) throw new Error(`reference level "${reference}" does not occur in "${feature}"; levels: ${byFrequency.slice(0, 20).join(', ')}`)
    categorical.push({ feature, reference, levels: byFrequency.filter((level) => level !== reference).sort() })
  }
  const columns: Array<{ name: string; value: (row: Record<string, Scalar>) => number }> = []
  if (intercept) columns.push({ name: '(Intercept)', value: () => 1 })
  const encoders = new Map<string, Array<{ name: string; value: (row: Record<string, Scalar>) => number }>>()
  for (const feature of features) {
    const encoding = categorical.find((entry) => entry.feature === feature)
    const parts = encoding
      ? encoding.levels.map((level) => ({ name: `${feature}[${level}]`, value: (row: Record<string, Scalar>) => (levelKey(row[feature] ?? null) === level ? 1 : 0) }))
      : [{ name: feature, value: (row: Record<string, Scalar>) => toNumber(row[feature]) ?? Number.NaN }]
    encoders.set(feature, parts)
    columns.push(...parts)
  }
  for (const [left, right] of spec.interactions ?? []) {
    if (!encoders.has(left) || !encoders.has(right)) throw new Error(`interaction ${left}:${right} needs both terms listed in features`)
    for (const l of encoders.get(left)!) for (const r of encoders.get(right)!) columns.push({ name: `${l.name}:${r.name}`, value: (row) => l.value(row) * r.value(row) })
  }
  const x = rowIndex.map((index) => columns.map((column) => column.value(frame.rows[index]!)))
  const y = spec.target ? rowIndex.map((index) => (targetTransform ? targetTransform(frame.rows[index]![spec.target!] ?? null)! : toNumber(frame.rows[index]![spec.target!])!)) : undefined
  return { x, ...(y ? { y } : {}), names: columns.map((column) => column.name), rowIndex, droppedRows: frame.rows.length - rowIndex.length, categorical, intercept }
}

/** Maps a binary target (0/1, boolean, or a two-level string) to 0/1, naming the positive class. */
export function binaryTarget(frame: Frame, target: string, positive?: string): { transform: (value: Scalar) => number | undefined; positive: string; negative: string } {
  const levels = new Map<string, Scalar>()
  for (const row of frame.rows) {
    const value = row[target]
    if (isMissing(value)) continue
    levels.set(scalarKey(value ?? null), value ?? null)
    if (levels.size > 2) break
  }
  if (levels.size !== 2) throw new Error(`binary target "${target}" must have exactly two distinct values, found ${levels.size}${levels.size > 2 ? '+' : ''}; for more classes use a multiclass model`)
  const values = [...levels.values()]
  const texts = values.map((value) => String(value))
  let positiveText = positive
  if (positiveText === undefined) {
    if (texts.includes('1')) positiveText = '1'
    else if (texts.includes('true')) positiveText = 'true'
    else positiveText = [...texts].sort()[1]!
  }
  if (!texts.includes(positiveText)) throw new Error(`positive class "${positiveText}" is not one of ${texts.join(', ')}`)
  const negative = texts.find((text) => text !== positiveText)!
  return { transform: (value) => (isMissing(value) ? undefined : String(value) === positiveText ? 1 : 0), positive: positiveText, negative }
}
