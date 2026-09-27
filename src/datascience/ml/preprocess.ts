import type { Frame } from '../frame.ts'
import { mean, median, standardDeviation } from '../stats/describe.ts'
import { isMissing, parseDateMs, scalarKey, toDateMs, toNumber, type Scalar } from '../values.ts'

/**
 * Leakage-safe preprocessing. A preprocessor is fitted on training rows only — imputation
 * medians, scaling statistics, category levels, and frequencies all come from the training
 * fold — and then applied unchanged to validation, test, and future rows. Its state is plain
 * JSON so it is saved inside the model artifact and reused at prediction time.
 */

export type FeatureKind = 'numeric' | 'categorical' | 'boolean' | 'date'

type FeatureState =
  | { name: string; kind: 'numeric'; fill: number; mean: number; sd: number; indicator: boolean }
  | { name: string; kind: 'boolean'; fill: number }
  | { name: string; kind: 'categorical'; encoding: 'onehot'; levels: string[]; other: boolean }
  | { name: string; kind: 'categorical'; encoding: 'frequency'; frequencies: Record<string, number> }
  | { name: string; kind: 'date'; fill: number; mean: number; sd: number }

export interface PreprocessorState {
  features: FeatureState[]
  scale: boolean
  outputNames: string[]
  /** Which input feature each output column came from, for importance roll-ups. */
  sources: string[]
}

export interface PreprocessOptions {
  scale?: boolean
  maxLevels?: number
  kinds?: Record<string, FeatureKind>
}

const MISSING_LEVEL = '__missing__'

export function featureKind(frame: Frame, name: string): FeatureKind {
  const type = frame.types[name]
  if (type === 'integer' || type === 'number') return 'numeric'
  if (type === 'boolean') return 'boolean'
  if (type === 'date' || type === 'datetime') return 'date'
  return 'categorical'
}

function levelOf(value: Scalar | undefined): string {
  return isMissing(value) ? MISSING_LEVEL : typeof value === 'string' ? value : String(value)
}

const DAY = 86_400_000

function dateParts(ms: number): number[] {
  const date = new Date(ms)
  const month = date.getUTCMonth()
  const dow = (date.getUTCDay() + 6) % 7
  return [ms / DAY, Math.sin((2 * Math.PI * month) / 12), Math.cos((2 * Math.PI * month) / 12), Math.sin((2 * Math.PI * dow) / 7), Math.cos((2 * Math.PI * dow) / 7), dow >= 5 ? 1 : 0]
}

const DATE_SUFFIXES = ['epoch_days', 'month_sin', 'month_cos', 'dow_sin', 'dow_cos', 'is_weekend']

export function fitPreprocessor(frame: Frame, rows: number[], features: string[], options: PreprocessOptions = {}): PreprocessorState {
  const scale = options.scale ?? true
  const maxLevels = options.maxLevels ?? 30
  const states: FeatureState[] = []
  const outputNames: string[] = []
  const sources: string[] = []
  for (const name of features) {
    const kind = options.kinds?.[name] ?? featureKind(frame, name)
    const values = rows.map((index) => frame.rows[index]![name])
    if (kind === 'numeric') {
      const numbers = values.map((value) => toNumber(value)).filter((value): value is number => value !== undefined)
      const fill = numbers.length ? median(numbers) : 0
      const indicator = numbers.length < values.length
      const sd = numbers.length > 1 ? standardDeviation(numbers) : 1
      states.push({ name, kind, fill, mean: numbers.length ? mean(numbers) : 0, sd: sd > 0 ? sd : 1, indicator })
      outputNames.push(name)
      sources.push(name)
      if (indicator) {
        outputNames.push(`${name}__missing`)
        sources.push(name)
      }
    } else if (kind === 'boolean') {
      const numbers = values.filter((value) => !isMissing(value)).map((value) => (value === true || value === 1 || value === 'true' ? 1 : 0))
      states.push({ name, kind, fill: numbers.length ? Math.round(mean(numbers)) : 0 })
      outputNames.push(name)
      sources.push(name)
    } else if (kind === 'date') {
      const ms = values.map((value) => (typeof value === 'string' ? parseDateMs(value) : toDateMs(value))).filter((value): value is number => value !== undefined)
      const days = ms.map((value) => value / DAY)
      const sd = days.length > 1 ? standardDeviation(days) : 1
      states.push({ name, kind, fill: days.length ? median(days) * DAY : 0, mean: days.length ? mean(days) : 0, sd: sd > 0 ? sd : 1 })
      for (const suffix of DATE_SUFFIXES) {
        outputNames.push(`${name}__${suffix}`)
        sources.push(name)
      }
    } else {
      const counts = new Map<string, number>()
      for (const value of values) counts.set(levelOf(value), (counts.get(levelOf(value)) ?? 0) + 1)
      if (counts.size > maxLevels) {
        const frequencies: Record<string, number> = {}
        for (const [level, count] of counts) frequencies[level] = count / values.length
        states.push({ name, kind: 'categorical', encoding: 'frequency', frequencies })
        outputNames.push(`${name}__frequency`)
        sources.push(name)
      } else {
        const levels = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([level]) => level)
        // Drop the most frequent level as the reference so linear models are not collinear.
        const kept = levels.slice(1)
        states.push({ name, kind: 'categorical', encoding: 'onehot', levels: kept, other: false })
        for (const level of kept) {
          outputNames.push(`${name}=${level}`)
          sources.push(name)
        }
      }
    }
  }
  return { features: states, scale, outputNames, sources }
}

export function transformRows(state: PreprocessorState, frame: Frame, rows: number[]): number[][] {
  return rows.map((index) => transformRecord(state, frame.rows[index]!))
}

export function transformRecord(state: PreprocessorState, record: Record<string, Scalar>): number[] {
  const out: number[] = []
  for (const feature of state.features) {
    const value = record[feature.name]
    switch (feature.kind) {
      case 'numeric': {
        const number = toNumber(value)
        const filled = number === undefined ? feature.fill : number
        out.push(state.scale ? (filled - feature.mean) / feature.sd : filled)
        if (feature.indicator) out.push(number === undefined ? 1 : 0)
        break
      }
      case 'boolean':
        out.push(isMissing(value) ? feature.fill : value === true || value === 1 || value === 'true' ? 1 : 0)
        break
      case 'date': {
        const ms = (typeof value === 'string' ? parseDateMs(value) : toDateMs(value)) ?? feature.fill
        const parts = dateParts(ms)
        parts[0] = state.scale ? (parts[0]! - feature.mean) / feature.sd : parts[0]!
        out.push(...parts)
        break
      }
      case 'categorical': {
        const level = levelOf(value)
        if (feature.encoding === 'frequency') out.push(feature.frequencies[level] ?? 0)
        else for (const candidate of feature.levels) out.push(candidate === level ? 1 : 0)
        break
      }
    }
  }
  return out
}

/** Columns that should never be model features: identifiers, constants, free text, and the target itself. */
export function excludedFeatures(frame: Frame, candidates: string[], profiles: Array<{ name: string; semanticType: string; role: string; distinct: number }>, target?: string, explicit: Set<string> = new Set()): { features: string[]; excluded: Array<{ name: string; reason: string }>; kept: Array<{ name: string; reason: string }> } {
  const excluded: Array<{ name: string; reason: string }> = []
  const kept: Array<{ name: string; reason: string }> = []
  const features: string[] = []
  const byName = new Map(profiles.map((profile) => [profile.name, profile]))
  for (const name of candidates) {
    const profile = byName.get(name)
    if (name === target) continue
    if (!profile) {
      features.push(name)
      continue
    }
    // A feature the user named explicitly is kept unless it cannot carry information at all.
    if (explicit.has(name) && !['constant', 'empty'].includes(profile.semanticType)) {
      if (['identifier', 'uuid', 'code'].includes(profile.semanticType) || profile.role === 'text') kept.push({ name, reason: `looks like a ${profile.semanticType === 'code' ? 'near-unique code' : profile.role === 'text' ? 'free-text column' : 'identifier'} but was requested explicitly, so it was kept — check that it generalises` })
      features.push(name)
      continue
    }
    if (profile.semanticType === 'identifier' || profile.semanticType === 'uuid') excluded.push({ name, reason: 'identifier — unique per row, so it memorises rather than generalises' })
    else if (profile.semanticType === 'constant' || profile.semanticType === 'empty') excluded.push({ name, reason: 'constant or empty — carries no information' })
    else if (profile.role === 'text') excluded.push({ name, reason: 'free text — derive text features explicitly (ds_analytics text) before modelling' })
    else if (['email', 'phone', 'url', 'ip_address', 'address', 'json'].includes(profile.semanticType)) excluded.push({ name, reason: `${profile.semanticType} — personal or unstructured data, not a feature` })
    else if (profile.semanticType === 'code' && profile.distinct > 0.9 * frame.rows.length) excluded.push({ name, reason: 'near-unique code — behaves like an identifier' })
    else features.push(name)
  }
  return { features, excluded, kept }
}

export { scalarKey }
