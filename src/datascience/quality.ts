import type { Frame } from './frame.ts'
import { median, quantileSorted } from './stats/describe.ts'
import type { ColumnProfile, DatasetUnderstanding, Relationship } from './understand.ts'
import { MISSING_MARKERS, isMissing, parseDateMs, scalarKey, toDateMs, type InferredColumn, type Scalar } from './values.ts'

/**
 * The data-quality engine. It finds problems and reports them with counts, examples, and
 * a suggested remedy — it never repairs anything itself. The score is a weighted average
 * of named components whose inputs are listed, so a reader can see exactly why a dataset
 * scored what it did; a component that could not be assessed is excluded, not guessed.
 */

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info'
export type QualityDimension = 'completeness' | 'uniqueness' | 'validity' | 'consistency' | 'plausibility' | 'integrity' | 'representativeness'

export interface QualityIssue {
  check: string
  dimension: QualityDimension
  severity: Severity
  column?: string
  count: number
  share: number
  detail: string
  examples?: Scalar[]
  suggestion?: string
}

export interface QualityComponent {
  dimension: QualityDimension
  score: number | null
  weight: number
  basis: string
}

export interface QualityReport {
  score: number
  grade: 'A' | 'B' | 'C' | 'D' | 'F'
  components: QualityComponent[]
  issues: QualityIssue[]
  summary: { rows: number; columns: number; criticalIssues: number; highIssues: number }
}

const WEIGHTS: Record<QualityDimension, number> = { completeness: 0.22, uniqueness: 0.13, validity: 0.22, consistency: 0.15, plausibility: 0.13, integrity: 0.1, representativeness: 0.05 }
const SENTINELS = new Set([-1, -9, -99, -999, -9999, 999, 9999, 99999, 999999, 1e9 - 1])

function severityFromShare(share: number, thresholds: [number, number, number] = [0.01, 0.05, 0.2]): Severity {
  return share >= thresholds[2] ? 'high' : share >= thresholds[1] ? 'medium' : share >= thresholds[0] ? 'low' : 'info'
}

function pushIssue(issues: QualityIssue[], issue: QualityIssue): void {
  if (issue.count > 0) issues.push(issue)
}

export interface QualityOptions {
  inference?: Record<string, InferredColumn>
  /** Key columns declared by the user; otherwise identifier-like columns are checked. */
  keys?: string[]
  relationships?: Relationship[]
  datasetName?: string
  truncatedAt?: number
  now?: Date
  target?: string
}

export function assessQuality(frame: Frame, understanding: DatasetUnderstanding, options: QualityOptions = {}): QualityReport {
  const issues: QualityIssue[] = []
  const n = frame.rows.length
  const now = options.now ?? new Date()
  const cells = Math.max(1, n * frame.columns.length)
  let missingCells = 0
  let invalidCells = 0
  let implausibleCells = 0
  let inconsistentColumns = 0
  const byName = new Map(understanding.profiles.map((profile) => [profile.name, profile]))

  // ---- completeness
  for (const profile of understanding.profiles) {
    missingCells += profile.missing
    if (profile.missing > 0) pushIssue(issues, { check: 'missing-values', dimension: 'completeness', severity: profile.missingRate === 1 ? 'high' : severityFromShare(profile.missingRate), column: profile.name, count: profile.missing, share: profile.missingRate, detail: `${profile.missing} of ${n} values are missing (${(profile.missingRate * 100).toFixed(1)}%)`, suggestion: profile.missingRate > 0.5 ? 'consider dropping the column or modelling missingness explicitly' : 'check whether missingness is random before imputing; add a missing-indicator when imputing for models' })
    const markers = frame.rows.map((row) => row[profile.name]).filter((value): value is string => typeof value === 'string' && MISSING_MARKERS.has(value.trim().toLowerCase()))
    if (markers.length) {
      missingCells += markers.length
      pushIssue(issues, { check: 'missing-markers', dimension: 'completeness', severity: severityFromShare(markers.length / n, [0.001, 0.01, 0.1]), column: profile.name, count: markers.length, share: markers.length / n, detail: `${markers.length} values are text markers of missingness (${[...new Set(markers)].slice(0, 4).map((value) => JSON.stringify(value)).join(', ')}) that are not treated as missing`, examples: [...new Set(markers)].slice(0, 4), suggestion: 'replace these markers with null in a transform (fill_missing / replace) so counts and averages are correct' })
    }
  }

  // ---- uniqueness
  const rowKeys = frame.rows.map((row) => frame.columns.map((name) => scalarKey(row[name] ?? null)).join('\u0001'))
  const duplicateRows = n - new Set(rowKeys).size
  pushIssue(issues, { check: 'duplicate-rows', dimension: 'uniqueness', severity: severityFromShare(duplicateRows / Math.max(1, n), [0.001, 0.01, 0.05]), count: duplicateRows, share: duplicateRows / Math.max(1, n), detail: `${duplicateRows} rows are exact duplicates of another row`, suggestion: 'confirm whether duplicates are real repeated events or load errors; dedupe with an explicit key if they are errors' })
  const keyColumns = options.keys ?? understanding.profiles.filter((profile) => profile.semanticType === 'identifier' || profile.semanticType === 'uuid').map((profile) => profile.name)
  let duplicateKeyRows = 0
  for (const key of keyColumns) {
    const profile = byName.get(key)
    if (!profile) continue
    const present = n - profile.missing
    const duplicates = present - profile.distinct
    if (duplicates > 0 && profile.uniqueness > 0.8) {
      duplicateKeyRows += duplicates
      pushIssue(issues, { check: 'duplicate-keys', dimension: 'uniqueness', severity: options.keys ? 'high' : 'medium', column: key, count: duplicates, share: duplicates / Math.max(1, n), detail: `identifier "${key}" repeats: ${duplicates} rows share an id with another row`, suggestion: 'either the grain is finer than this id (e.g. order lines, not orders) or these are duplicate entities; check before joining or counting' })
    }
  }

  // ---- validity, consistency, plausibility per column
  for (const profile of understanding.profiles) {
    const name = profile.name
    const values = frame.rows.map((row) => row[name] ?? null)
    const inferred = options.inference?.[name]
    if (inferred?.nearType) {
      const bad = Math.round((1 - inferred.nearType.share) * (n - profile.missing))
      invalidCells += bad
      pushIssue(issues, { check: 'mixed-types', dimension: 'validity', severity: 'high', column: name, count: bad, share: bad / Math.max(1, n), detail: `${(inferred.nearType.share * 100).toFixed(1)}% of values are ${inferred.nearType.type} but the rest are not, so the column was kept as text`, examples: inferred.nearType.examples, suggestion: `inspect the non-${inferred.nearType.type} values; parse with a cast/parse_number transform once they are understood` })
    }
    if (inferred?.ambiguousDateOrder) pushIssue(issues, { check: 'ambiguous-dates', dimension: 'validity', severity: 'medium', column: name, count: n - profile.missing, share: 1, detail: 'dates like 03/04/2025 could be day-first or month-first; they were read month-first', suggestion: 'confirm the convention and reload with dayFirst if needed' })
    if (profile.semanticType === 'constant') pushIssue(issues, { check: 'constant-column', dimension: 'consistency', severity: 'low', column: name, count: n, share: 1, detail: `every row has the same value (${String(profile.examples[0])}); it carries no information`, suggestion: 'exclude it from analysis and models' })
    if (profile.type === 'string' || profile.type === 'empty') {
      const strings = values.filter((value): value is string => typeof value === 'string')
      const padded = strings.filter((value) => value !== value.trim()).length
      if (padded) {
        invalidCells += padded
        pushIssue(issues, { check: 'whitespace', dimension: 'consistency', severity: severityFromShare(padded / n), column: name, count: padded, share: padded / n, detail: `${padded} values have leading or trailing whitespace`, examples: strings.filter((value) => value !== value.trim()).slice(0, 3), suggestion: 'trim in a derive/standardize_categories step before grouping or joining' })
      }
      if (profile.role === 'dimension' || profile.semanticType === 'category' || profile.semanticType === 'country' || profile.semanticType === 'region' || profile.semanticType === 'city') {
        const groups = new Map<string, Set<string>>()
        for (const value of strings) {
          const normalized = value.trim().toLowerCase().replace(/[\s_-]+/g, ' ').replace(/[.]/g, '')
          const set = groups.get(normalized) ?? new Set<string>()
          set.add(value)
          groups.set(normalized, set)
        }
        const variants = [...groups.values()].filter((set) => set.size > 1)
        if (variants.length) {
          inconsistentColumns++
          const affected = strings.filter((value) => (groups.get(value.trim().toLowerCase().replace(/[\s_-]+/g, ' ').replace(/[.]/g, ''))?.size ?? 0) > 1).length
          pushIssue(issues, { check: 'inconsistent-categories', dimension: 'consistency', severity: severityFromShare(affected / n, [0.001, 0.01, 0.05]), column: name, count: affected, share: affected / n, detail: `${variants.length} label(s) are written in several ways (case, spacing, punctuation), e.g. ${variants.slice(0, 3).map((set) => [...set].map((value) => JSON.stringify(value)).join(' / ')).join('; ')}`, examples: variants.slice(0, 3).flatMap((set) => [...set]), suggestion: 'consolidate with a standardize_categories transform; otherwise group-bys split one category into several' })
        }
        if (profile.distinct > 100 && profile.uniqueness > 0.5 && profile.semanticType === 'category') pushIssue(issues, { check: 'high-cardinality', dimension: 'consistency', severity: 'low', column: name, count: profile.distinct, share: profile.uniqueness, detail: `${profile.distinct} distinct labels (${(profile.uniqueness * 100).toFixed(0)}% unique) — too many to use as a plain category`, suggestion: 'group rare levels or use frequency/target encoding in models' })
      }
      if (profile.semanticType === 'currency_amount' || profile.semanticType === 'percentage') {
        const symbols = new Set(strings.map((value) => (/[$€£¥₹]|USD|EUR|GBP|INR|JPY/i.exec(value)?.[0] ?? '').toUpperCase()).filter(Boolean))
        pushIssue(issues, { check: 'numbers-stored-as-text', dimension: 'validity', severity: 'medium', column: name, count: strings.length, share: strings.length / n, detail: `${profile.semanticType === 'percentage' ? 'percentages' : 'amounts'} are stored as text${symbols.size > 1 ? ` in ${symbols.size} currencies (${[...symbols].join(', ')}) — values are not comparable until converted` : ''}`, suggestion: 'use a parse_number transform; convert currencies only with an explicit, sourced rate table', examples: strings.slice(0, 3) })
        if (symbols.size > 1) inconsistentColumns++
      }
      if (/date|time|_at$|_on$|day/i.test(name)) {
        const unparsed = strings.filter((value) => parseDateMs(value) === undefined)
        if (unparsed.length && unparsed.length < strings.length) {
          invalidCells += unparsed.length
          pushIssue(issues, { check: 'invalid-dates', dimension: 'validity', severity: severityFromShare(unparsed.length / n), column: name, count: unparsed.length, share: unparsed.length / n, detail: `${unparsed.length} values in a date-named column do not parse as dates`, examples: [...new Set(unparsed)].slice(0, 5), suggestion: 'fix or null them, then cast the column to date' })
        }
      }
      if (profile.semanticType === 'email') {
        const invalid = strings.filter((value) => !/^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(value.trim()))
        invalidCells += invalid.length
        pushIssue(issues, { check: 'malformed-strings', dimension: 'validity', severity: severityFromShare(invalid.length / n), column: name, count: invalid.length, share: invalid.length / n, detail: `${invalid.length} values are not well-formed email addresses`, examples: invalid.slice(0, 3) })
      }
    }
    if (profile.type === 'date' || profile.type === 'datetime') {
      const ms = values.map((value) => toDateMs(value)).filter((value): value is number => value !== undefined)
      const future = ms.filter((value) => value > now.getTime() + 86_400_000).length
      const ancient = ms.filter((value) => value < Date.UTC(1900, 0, 1)).length
      if (future) {
        implausibleCells += future
        pushIssue(issues, { check: 'future-dates', dimension: 'plausibility', severity: severityFromShare(future / n), column: name, count: future, share: future / n, detail: `${future} dates are after today (${now.toISOString().slice(0, 10)})`, suggestion: 'legitimate for schedules and forecasts; an error for events that already happened' })
      }
      if (ancient) {
        implausibleCells += ancient
        pushIssue(issues, { check: 'implausible-dates', dimension: 'plausibility', severity: severityFromShare(ancient / n), column: name, count: ancient, share: ancient / n, detail: `${ancient} dates are before 1900 — often placeholder values like 1900-01-01`, suggestion: 'treat placeholder dates as missing' })
      }
    }
    if (profile.numeric) {
      const numbers = values.filter((value): value is number => typeof value === 'number')
      const lower = name.toLowerCase()
      const nonNegative = ['count', 'currency_amount', 'duration'].includes(profile.semanticType) || /age|price|qty|quantity|units|count|weight|height|distance|revenue|sales/.test(lower)
      if (nonNegative && profile.semanticType !== 'currency_amount') {
        const negatives = numbers.filter((value) => value < 0).length
        if (negatives) {
          implausibleCells += negatives
          pushIssue(issues, { check: 'impossible-values', dimension: 'plausibility', severity: severityFromShare(negatives / n, [0.0001, 0.01, 0.05]), column: name, count: negatives, share: negatives / n, detail: `${negatives} negative values in a column that should be non-negative`, examples: numbers.filter((value) => value < 0).slice(0, 5), suggestion: 'check for returns/refunds or sign errors; do not silently drop them' })
        }
      }
      if (profile.semanticType === 'currency_amount') {
        const negatives = numbers.filter((value) => value < 0).length
        if (negatives) pushIssue(issues, { check: 'negative-amounts', dimension: 'plausibility', severity: 'info', column: name, count: negatives, share: negatives / n, detail: `${negatives} negative amounts (refunds, credits, or errors?) — sums net them out`, examples: numbers.filter((value) => value < 0).slice(0, 5) })
      }
      if (/(^|_)age($|_)/.test(lower)) {
        const bad = numbers.filter((value) => value > 120).length
        implausibleCells += bad
        pushIssue(issues, { check: 'impossible-values', dimension: 'plausibility', severity: 'high', column: name, count: bad, share: bad / n, detail: `${bad} ages above 120`, examples: numbers.filter((value) => value > 120).slice(0, 5) })
      }
      if (profile.semanticType === 'percentage') {
        const max = profile.numeric.max
        const overHundred = numbers.filter((value) => value > 100 || value < -100).length
        if (overHundred) {
          implausibleCells += overHundred
          pushIssue(issues, { check: 'impossible-values', dimension: 'plausibility', severity: 'medium', column: name, count: overHundred, share: overHundred / n, detail: `${overHundred} rate/percentage values beyond ±100`, examples: numbers.filter((value) => value > 100).slice(0, 5) })
        }
        const fractions = numbers.filter((value) => value > 0 && value <= 1).length
        const points = numbers.filter((value) => value > 1 && value <= 100).length
        if (max > 1 && fractions > 0.1 * numbers.length && points > 0.1 * numbers.length) {
          inconsistentColumns++
          pushIssue(issues, { check: 'inconsistent-units', dimension: 'consistency', severity: 'high', column: name, count: Math.min(fractions, points), share: Math.min(fractions, points) / n, detail: `the column mixes fractions (0–1) and percent points (1–100): ${fractions} vs ${points} values`, suggestion: 'decide on one scale and convert before aggregating' })
        }
      }
      if (profile.semanticType === 'latitude' || profile.semanticType === 'longitude') {
        const zeros = numbers.filter((value) => value === 0).length
        if (zeros) pushIssue(issues, { check: 'null-island', dimension: 'plausibility', severity: severityFromShare(zeros / n), column: name, count: zeros, share: zeros / n, detail: `${zeros} coordinates are exactly 0 — usually a failed geocode, not a real location`, suggestion: 'treat 0,0 as missing' })
      }
      // Outliers by Tukey's fences and a robust z-score; reported, never removed.
      if (profile.role === 'measure' && numbers.length >= 20) {
        const sorted = [...numbers].sort((a, b) => a - b)
        const q1 = quantileSorted(sorted, 0.25)
        const q3 = quantileSorted(sorted, 0.75)
        const iqr = q3 - q1
        const med = median(sorted)
        const mad = median(sorted.map((value) => Math.abs(value - med))) * 1.4826
        const extreme = iqr > 0 ? numbers.filter((value) => value < q1 - 3 * iqr || value > q3 + 3 * iqr) : mad > 0 ? numbers.filter((value) => Math.abs(value - med) / mad > 6) : []
        if (extreme.length) {
          implausibleCells += extreme.length * 0.5
          pushIssue(issues, { check: 'outliers', dimension: 'plausibility', severity: extreme.length / n > 0.02 ? 'medium' : 'low', column: name, count: extreme.length, share: extreme.length / n, detail: `${extreme.length} extreme values beyond 3×IQR from the quartiles (fences ${(q1 - 3 * iqr).toPrecision(4)} to ${(q3 + 3 * iqr).toPrecision(4)})`, examples: [...new Set(extreme)].sort((a, b) => Math.abs(b - med) - Math.abs(a - med)).slice(0, 5), suggestion: 'verify them against the source; use medians, robust models, or winsorizing rather than deletion if they are real' })
        }
        const sentinel = numbers.filter((value) => SENTINELS.has(value))
        if (sentinel.length >= Math.max(3, 0.005 * n)) {
          implausibleCells += sentinel.length
          pushIssue(issues, { check: 'sentinel-values', dimension: 'plausibility', severity: 'medium', column: name, count: sentinel.length, share: sentinel.length / n, detail: `${sentinel.length} values are common placeholder codes (${[...new Set(sentinel)].join(', ')})`, suggestion: 'these usually mean "unknown"; replace with null before computing statistics' })
        }
        const zeros = profile.numeric.zeros
        if (zeros / n > 0.5 && profile.semanticType !== 'count') pushIssue(issues, { check: 'excess-zeros', dimension: 'plausibility', severity: 'info', column: name, count: zeros, share: zeros / n, detail: `${((zeros / n) * 100).toFixed(1)}% zeros — zero-inflated; means and linear models will mislead`, suggestion: 'model the zero/non-zero split separately (hurdle) or use a Tweedie/zero-inflated model' })
        const integers = numbers.filter((value) => Number.isInteger(value))
        const roundHundreds = integers.filter((value) => value !== 0 && value % 100 === 0).length
        if (integers.length > 50 && roundHundreds / numbers.length > 0.4 && profile.numeric.max > 1000) pushIssue(issues, { check: 'heaping', dimension: 'plausibility', severity: 'info', column: name, count: roundHundreds, share: roundHundreds / n, detail: `${((roundHundreds / numbers.length) * 100).toFixed(0)}% of values are round hundreds — likely estimates or bucketed entry, not measurements` })
      }
    }
  }

  // ---- integrity
  let orphanRows = 0
  const relationships = (options.relationships ?? []).filter((relationship) => !options.datasetName || relationship.from.dataset === options.datasetName)
  for (const relationship of relationships) {
    orphanRows += relationship.orphanRows
    pushIssue(issues, { check: 'referential-integrity', dimension: 'integrity', severity: severityFromShare(relationship.orphanRows / Math.max(1, n)), column: relationship.from.column, count: relationship.orphanRows, share: relationship.orphanRows / Math.max(1, n), detail: `${relationship.orphanRows} rows reference ${relationship.to.dataset}.${relationship.to.column} values that do not exist (${relationship.orphanValues} distinct missing keys)`, suggestion: 'an inner join would silently drop these rows; use a left join and report unmatched rows' })
  }

  // ---- representativeness
  const representativeness: string[] = []
  if (options.truncatedAt) {
    representativeness.push('truncated')
    pushIssue(issues, { check: 'sampling', dimension: 'representativeness', severity: 'high', count: options.truncatedAt, share: 1, detail: `only the first ${options.truncatedAt} rows were loaded — not a random sample; totals and rates describe that slice only`, suggestion: 'aggregate at the source or load the full data' })
  }
  if (options.target) {
    const profile = byName.get(options.target)
    if (profile?.topValues && profile.distinct >= 2 && profile.distinct <= 20) {
      const minority = profile.topValues.at(-1)!
      if (minority.share < 0.1) pushIssue(issues, { check: 'class-imbalance', dimension: 'representativeness', severity: minority.share < 0.02 ? 'high' : 'medium', column: options.target, count: minority.count, share: minority.share, detail: `target class "${String(minority.value)}" is ${(minority.share * 100).toFixed(1)}% of rows`, suggestion: 'use stratified splits, PR-AUC/recall rather than accuracy, and threshold tuning' })
    }
  }
  for (const time of understanding.timeColumns) {
    if (!/daily|weekly|monthly/.test(time.granularity)) continue
    const unit = time.granularity === 'daily' ? 1 : time.granularity === 'weekly' ? 7 : 30.44
    const ms = [...new Set(frame.rows.map((row) => toDateMs(row[time.name])).filter((value): value is number => value !== undefined))].sort((a, b) => a - b)
    if (ms.length < 3) continue
    const expected = Math.round((ms.at(-1)! - ms[0]!) / 86_400_000 / unit) + 1
    const gaps = expected - ms.length
    if (gaps > Math.max(1, 0.02 * expected)) pushIssue(issues, { check: 'time-coverage-gaps', dimension: 'representativeness', severity: severityFromShare(gaps / expected), column: time.name, count: gaps, share: gaps / expected, detail: `about ${gaps} of ${expected} expected ${time.granularity} periods have no rows between ${new Date(ms[0]!).toISOString().slice(0, 10)} and ${new Date(ms.at(-1)!).toISOString().slice(0, 10)}`, suggestion: 'distinguish true zero activity from missing data before trend or forecast work' })
  }

  // ---- components
  const completeness = 100 * (1 - missingCells / cells)
  const uniqueness = 100 * (1 - Math.min(1, (duplicateRows + duplicateKeyRows) / Math.max(1, n)))
  const validity = 100 * (1 - Math.min(1, invalidCells / cells) * 5)
  const consistency = 100 * (1 - Math.min(1, inconsistentColumns / Math.max(1, frame.columns.length)) )
  const plausibility = 100 * (1 - Math.min(1, (implausibleCells / cells) * 10))
  const components: QualityComponent[] = [
    { dimension: 'completeness', score: completeness, weight: WEIGHTS.completeness, basis: `${missingCells} missing or marker cells of ${cells}` },
    { dimension: 'uniqueness', score: uniqueness, weight: WEIGHTS.uniqueness, basis: `${duplicateRows} duplicate rows, ${duplicateKeyRows} repeated identifier rows` },
    { dimension: 'validity', score: Math.max(0, validity), weight: WEIGHTS.validity, basis: `${invalidCells} cells failing type, format, or parse checks (penalty ×5 per cell share)` },
    { dimension: 'consistency', score: consistency, weight: WEIGHTS.consistency, basis: `${inconsistentColumns} of ${frame.columns.length} columns with inconsistent labels, units, or currencies` },
    { dimension: 'plausibility', score: Math.max(0, plausibility), weight: WEIGHTS.plausibility, basis: `${Math.round(implausibleCells)} impossible, placeholder, or extreme cells (penalty ×10 per cell share)` },
    { dimension: 'integrity', score: relationships.length ? 100 * (1 - Math.min(1, orphanRows / Math.max(1, n))) : null, weight: WEIGHTS.integrity, basis: relationships.length ? `${orphanRows} rows referencing missing parent keys across ${relationships.length} relationship(s)` : 'not assessed: no relationships to other datasets were evaluated' },
    { dimension: 'representativeness', score: representativeness.length ? 40 : null, weight: WEIGHTS.representativeness, basis: representativeness.length ? 'the data is a truncated slice of the source' : 'not assessed: no sampling metadata indicates a problem' },
  ]
  const assessed = components.filter((component) => component.score !== null)
  const totalWeight = assessed.reduce((total, component) => total + component.weight, 0)
  const score = assessed.reduce((total, component) => total + component.score! * component.weight, 0) / totalWeight
  const critical = issues.filter((issue) => issue.severity === 'critical').length
  const high = issues.filter((issue) => issue.severity === 'high').length
  const capped = high > 0 ? Math.min(score, 89) : score
  const grade = capped >= 90 ? 'A' : capped >= 80 ? 'B' : capped >= 70 ? 'C' : capped >= 60 ? 'D' : 'F'
  const order: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }
  issues.sort((a, b) => order[a.severity] - order[b.severity] || b.share - a.share)
  return { score: Math.round(capped * 10) / 10, grade, components, issues, summary: { rows: n, columns: frame.columns.length, criticalIssues: critical, highIssues: high } }
}

export function profileMap(profiles: ColumnProfile[]): Map<string, ColumnProfile> {
  return new Map(profiles.map((profile) => [profile.name, profile]))
}

export { isMissing }
