import { column, type Frame } from './frame.ts'
import { summarize, type NumericSummary } from './stats/describe.ts'
import { isMissing, isNumericType, isTemporalType, parseDateMs, scalarKey, toDateMs, toNumber, type ColumnType, type Scalar } from './values.ts'

/**
 * Dataset understanding: what each column *means* (semantic type), what role it can play
 * in an analysis, what the grain of the table is, and how tables relate. Everything here
 * is inferred from names and values together and labelled as inference — a relationship
 * is proposed only when the values actually nest, never because two columns share a name.
 */

export type SemanticType =
  | 'identifier' | 'email' | 'url' | 'phone' | 'uuid' | 'ip_address' | 'postal_code' | 'country' | 'region' | 'city' | 'address'
  | 'latitude' | 'longitude' | 'currency_amount' | 'percentage' | 'count' | 'year' | 'month' | 'date' | 'timestamp' | 'duration'
  | 'boolean_flag' | 'binary' | 'category' | 'ordinal' | 'free_text' | 'measure' | 'code' | 'constant' | 'empty' | 'json'

export type AnalyticalRole = 'identifier' | 'dimension' | 'measure' | 'time' | 'geo' | 'text' | 'flag' | 'metadata' | 'unusable'

export interface ColumnProfile {
  name: string
  type: ColumnType
  semanticType: SemanticType
  role: AnalyticalRole
  confidence: 'high' | 'medium' | 'low'
  evidence: string
  count: number
  missing: number
  missingRate: number
  distinct: number
  uniqueness: number
  examples: Scalar[]
  numeric?: NumericSummary
  topValues?: Array<{ value: Scalar; count: number; share: number }>
  temporal?: { min: string; max: string; spanDays: number }
  text?: { meanLength: number; maxLength: number }
  unit?: string
  description: string
}

const PATTERNS = {
  email: /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/,
  url: /^https?:\/\/[^\s]+$/i,
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  ip: /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/,
  phone: /^\+?[\d\s().-]{7,20}$/,
  currencyText: /^[-+]?\s*(?:[$€£¥₹]|USD|EUR|GBP|INR|JPY)\s*-?[\d,]+(?:\.\d+)?$|^-?[\d,]+(?:\.\d+)?\s*(?:[$€£¥₹]|USD|EUR|GBP|INR|JPY)$/i,
  percentText: /^-?\d+(?:\.\d+)?\s*%$/,
  json: /^\s*[[{].*[\]}]\s*$/s,
}

const NAME_HINTS: Array<[RegExp, SemanticType]> = [
  [/(^|_|\b)(lat|latitude)($|_|\b)/i, 'latitude'],
  [/(^|_|\b)(lon|lng|long|longitude)($|_|\b)/i, 'longitude'],
  [/(zip|postal|postcode|pin_?code)/i, 'postal_code'],
  [/(^|_)(country|nation)(_?code|_?name)?$/i, 'country'],
  [/(^|_)(state|province|region|territory)(_?code|_?name)?$/i, 'region'],
  [/(^|_)(city|town)(_?name)?$/i, 'city'],
  [/(address|street)/i, 'address'],
  [/(price|amount|revenue|sales|cost|profit|spend|income|salary|fee|payment|value_usd|usd|eur|inr|gbp|gmv|arpu|ltv|clv|cac|budget|margin_amt)/i, 'currency_amount'],
  [/(pct|percent|percentage|rate|ratio|share|conversion|ctr|churn_rate|margin_pct)/i, 'percentage'],
  [/(^|_)(count|qty|quantity|units|num|n_|number_of|visits|sessions|clicks|impressions|orders)(_|$)/i, 'count'],
  [/(^|_)(year|yr|fiscal_year)$/i, 'year'],
  [/(^|_)(month|mon)$/i, 'month'],
  [/(duration|seconds|minutes|hours|days_to|time_to|lead_time|latency|_ms$|_sec$)/i, 'duration'],
  [/(email|e_mail)/i, 'email'],
  [/(phone|mobile|tel)/i, 'phone'],
  [/(url|link|website|href)/i, 'url'],
  [/(^|_)(is|has|flag|was|did|can)_|_(flag|ind|indicator)$|^(active|churned|converted|fraud|default)$/i, 'boolean_flag'],
]

const ID_NAME = /(^id$|_id$|^id_|Id$|ID$|_key$|^key$|_uuid$|^uuid$|guid|_no$|_number$|^code$|_code$|sku|isbn|ssn)/

const COUNTRIES = new Set(['us', 'usa', 'united states', 'uk', 'gb', 'united kingdom', 'in', 'ind', 'india', 'cn', 'chn', 'china', 'de', 'deu', 'germany', 'fr', 'fra', 'france', 'jp', 'jpn', 'japan', 'br', 'bra', 'brazil', 'ca', 'can', 'canada', 'au', 'aus', 'australia', 'mx', 'mex', 'mexico', 'es', 'esp', 'spain', 'it', 'ita', 'italy', 'nl', 'nld', 'netherlands', 'kr', 'kor', 'south korea', 'ru', 'rus', 'russia', 'sg', 'sgp', 'singapore', 'ae', 'are', 'uae', 'za', 'zaf', 'south africa', 'id', 'idn', 'indonesia', 'se', 'swe', 'sweden', 'ch', 'che', 'switzerland', 'pl', 'pol', 'poland', 'tr', 'tur', 'turkey', 'ar', 'arg', 'argentina', 'ng', 'nga', 'nigeria', 'eg', 'egy', 'egypt', 'pk', 'pak', 'pakistan', 'bd', 'bgd', 'bangladesh', 'vn', 'vnm', 'vietnam', 'ph', 'phl', 'philippines', 'th', 'tha', 'thailand', 'my', 'mys', 'malaysia', 'ie', 'irl', 'ireland', 'nz', 'nzl', 'new zealand', 'be', 'bel', 'belgium', 'at', 'aut', 'austria', 'pt', 'prt', 'portugal', 'no', 'nor', 'norway', 'dk', 'dnk', 'denmark', 'fi', 'fin', 'finland', 'il', 'isr', 'israel', 'sa', 'sau', 'saudi arabia', 'cl', 'chl', 'chile', 'co', 'col', 'colombia', 'pe', 'per', 'peru', 'ke', 'ken', 'kenya'])

function share(values: Scalar[], test: (value: Scalar) => boolean): number {
  if (values.length === 0) return 0
  let hits = 0
  for (const value of values) if (test(value)) hits++
  return hits / values.length
}

function unitFromName(name: string): string | undefined {
  const lower = name.toLowerCase()
  const units: Array<[RegExp, string]> = [[/usd|dollar|\$/, 'USD'], [/eur/, 'EUR'], [/gbp|pound/, 'GBP'], [/inr|rupee/, 'INR'], [/jpy|yen/, 'JPY'], [/_ms$|millis/, 'milliseconds'], [/_sec$|seconds/, 'seconds'], [/minutes|_min$/, 'minutes'], [/hours|_hr$/, 'hours'], [/days/, 'days'], [/_kg$|kilogram/, 'kg'], [/_lb$|pounds_weight/, 'lb'], [/_km$|kilomet/, 'km'], [/miles|_mi$/, 'miles'], [/_m$|meters/, 'm'], [/celsius|_c$/, '°C'], [/fahrenheit|_f$/, '°F'], [/pct|percent/, '%']]
  return units.find(([pattern]) => pattern.test(lower))?.[1]
}

export function profileColumn(frame: Frame, name: string): ColumnProfile {
  const values = column(frame, name)
  const present = values.filter((value) => !isMissing(value))
  const type = frame.types[name] ?? 'string'
  const counts = new Map<string, { value: Scalar; count: number }>()
  for (const value of present) {
    const key = scalarKey(value)
    const entry = counts.get(key)
    if (entry) entry.count++
    else counts.set(key, { value, count: 1 })
  }
  const distinct = counts.size
  const uniqueness = present.length ? distinct / present.length : 0
  const examples = [...counts.values()].slice(0, 5).map((entry) => entry.value)
  const lower = name.toLowerCase()
  const hint = NAME_HINTS.find(([pattern]) => pattern.test(name))?.[1]
  const numbers = isNumericType(type) ? present.map((value) => value as number) : []
  let semanticType: SemanticType = 'category'
  let confidence: ColumnProfile['confidence'] = 'medium'
  let evidence = ''
  const stringValues = present.filter((value): value is string => typeof value === 'string')
  if (present.length === 0) {
    semanticType = 'empty'
    confidence = 'high'
    evidence = 'no non-missing values'
  } else if (distinct === 1) {
    semanticType = 'constant'
    confidence = 'high'
    evidence = `a single value (${String(examples[0])})`
  } else if (type === 'boolean' || (distinct === 2 && numbers.length && numbers.every((value) => value === 0 || value === 1))) {
    semanticType = hint === 'boolean_flag' || type === 'boolean' ? 'boolean_flag' : 'binary'
    confidence = 'high'
    evidence = 'two values (0/1 or true/false)'
  } else if (type === 'date') {
    semanticType = 'date'
    confidence = 'high'
    evidence = 'every value parses as a calendar date'
  } else if (type === 'datetime') {
    semanticType = 'timestamp'
    confidence = 'high'
    evidence = 'every value parses as a timestamp'
  } else if (stringValues.length && share(stringValues, (value) => PATTERNS.uuid.test(String(value))) > 0.95) {
    semanticType = 'uuid'
    confidence = 'high'
    evidence = 'UUID-formatted values'
  } else if (stringValues.length && share(stringValues, (value) => PATTERNS.email.test(String(value))) > 0.9) {
    semanticType = 'email'
    confidence = 'high'
    evidence = 'email-formatted values'
  } else if (stringValues.length && share(stringValues, (value) => PATTERNS.url.test(String(value))) > 0.9) {
    semanticType = 'url'
    confidence = 'high'
    evidence = 'URL-formatted values'
  } else if (stringValues.length && share(stringValues, (value) => PATTERNS.ip.test(String(value))) > 0.9) {
    semanticType = 'ip_address'
    confidence = 'high'
    evidence = 'IPv4 addresses'
  } else if (stringValues.length && share(stringValues, (value) => PATTERNS.currencyText.test(String(value).trim())) > 0.9) {
    semanticType = 'currency_amount'
    confidence = 'high'
    evidence = 'amounts written with a currency symbol or code (stored as text — parse before arithmetic)'
  } else if (stringValues.length && share(stringValues, (value) => PATTERNS.percentText.test(String(value).trim())) > 0.9) {
    semanticType = 'percentage'
    confidence = 'high'
    evidence = 'values written with % (stored as text — parse before arithmetic)'
  } else if (hint === 'latitude' && numbers.length && numbers.every((value) => value >= -90 && value <= 90)) {
    semanticType = 'latitude'
    confidence = 'high'
    evidence = 'name and every value within [-90, 90]'
  } else if (hint === 'longitude' && numbers.length && numbers.every((value) => value >= -180 && value <= 180)) {
    semanticType = 'longitude'
    confidence = 'high'
    evidence = 'name and every value within [-180, 180]'
  } else if (ID_NAME.test(name) && uniqueness > 0.5) {
    semanticType = 'identifier'
    confidence = uniqueness === 1 ? 'high' : 'medium'
    evidence = `identifier-like name with ${(uniqueness * 100).toFixed(1)}% distinct values`
  } else if (hint === 'year' && numbers.length && numbers.every((value) => Number.isInteger(value) && value >= 1800 && value <= 2200)) {
    semanticType = 'year'
    confidence = 'high'
    evidence = 'name and integer values in 1800–2200'
  } else if (hint === 'month' && numbers.length && numbers.every((value) => Number.isInteger(value) && value >= 1 && value <= 12)) {
    semanticType = 'month'
    confidence = 'high'
    evidence = 'name and integer values in 1–12'
  } else if (hint === 'postal_code' || (stringValues.length && share(stringValues, (value) => /^0\d{3,5}$/.test(String(value))) > 0.5 && /zip|post|pin/i.test(lower))) {
    semanticType = 'postal_code'
    confidence = 'medium'
    evidence = 'postal-code name'
  } else if (hint === 'country' || (stringValues.length && share(stringValues, (value) => COUNTRIES.has(String(value).trim().toLowerCase())) > 0.8)) {
    semanticType = 'country'
    confidence = hint === 'country' ? 'high' : 'medium'
    evidence = hint === 'country' ? 'country name' : 'values are country names or ISO codes'
  } else if (hint === 'region' || hint === 'city' || hint === 'address') {
    semanticType = hint
    confidence = 'medium'
    evidence = `${hint} name`
  } else if (hint === 'email' || hint === 'phone' || hint === 'url') {
    semanticType = stringValues.length && hint === 'phone' && share(stringValues, (value) => PATTERNS.phone.test(String(value))) > 0.8 ? 'phone' : hint === 'phone' ? 'code' : hint
    confidence = 'low'
    evidence = `${hint}-like name but values do not all match the format`
  } else if (numbers.length) {
    const integers = numbers.every(Number.isInteger)
    const nonNegative = numbers.every((value) => value >= 0)
    if (hint === 'currency_amount') {
      semanticType = 'currency_amount'
      evidence = 'monetary name on a numeric column'
    } else if (hint === 'percentage') {
      semanticType = 'percentage'
      const max = Math.max(...numbers)
      evidence = max <= 1 ? 'rate-like name with values in [0, 1] (fractions)' : max <= 100 ? 'rate-like name with values in [0, 100] (percent points)' : 'rate-like name, but values exceed 100'
    } else if (hint === 'duration') {
      semanticType = 'duration'
      evidence = 'duration-like name'
    } else if (integers && nonNegative && (hint === 'count' || (distinct < 50 && Math.max(...numbers) < 1000 && !ID_NAME.test(name) && uniqueness < 0.2))) {
      semanticType = hint === 'count' ? 'count' : distinct <= 12 ? 'ordinal' : 'count'
      evidence = hint === 'count' ? 'count-like name with non-negative integers' : 'few distinct non-negative integers'
      confidence = hint === 'count' ? 'high' : 'low'
    } else if (integers && uniqueness === 1 && present.length > 20 && (ID_NAME.test(name) || isSequential(numbers))) {
      semanticType = 'identifier'
      evidence = 'unique integers in a sequence'
    } else {
      semanticType = 'measure'
      evidence = 'continuous numeric values'
    }
  } else if (stringValues.length) {
    const lengths = stringValues.map((value) => String(value).length)
    const meanLength = lengths.reduce((a, b) => a + b, 0) / lengths.length
    const withSpaces = share(stringValues, (value) => String(value).trim().includes(' '))
    if (share(stringValues, (value) => PATTERNS.json.test(String(value))) > 0.9) {
      semanticType = 'json'
      evidence = 'JSON text'
    } else if (meanLength > 40 && withSpaces > 0.5) {
      semanticType = 'free_text'
      evidence = `long text (mean ${meanLength.toFixed(0)} characters)`
    } else if (uniqueness > 0.95 && present.length > 20) {
      semanticType = ID_NAME.test(name) ? 'identifier' : 'code'
      evidence = 'nearly every value distinct'
      confidence = 'low'
    } else {
      semanticType = 'category'
      evidence = `${distinct} distinct labels`
    }
  }
  const role: AnalyticalRole = (() => {
    switch (semanticType) {
      case 'identifier': case 'uuid': return 'identifier'
      case 'date': case 'timestamp': case 'year': case 'month': return 'time'
      case 'latitude': case 'longitude': case 'country': case 'region': case 'city': case 'postal_code': case 'address': return 'geo'
      case 'free_text': return 'text'
      case 'boolean_flag': case 'binary': return 'flag'
      case 'currency_amount': case 'percentage': case 'count': case 'measure': case 'duration': return typeof present[0] === 'number' ? 'measure' : 'metadata'
      case 'category': case 'ordinal': return 'dimension'
      case 'email': case 'phone': case 'url': case 'ip_address': case 'code': case 'json': return 'metadata'
      default: return 'unusable'
    }
  })()
  const profile: ColumnProfile = {
    name,
    type,
    semanticType,
    role,
    confidence,
    evidence,
    count: values.length,
    missing: values.length - present.length,
    missingRate: values.length ? (values.length - present.length) / values.length : 0,
    distinct,
    uniqueness,
    examples,
    description: '',
  }
  if (numbers.length) profile.numeric = summarize(numbers)
  if (!numbers.length && distinct > 0) {
    profile.topValues = [...counts.values()].sort((a, b) => b.count - a.count).slice(0, 10).map((entry) => ({ value: entry.value, count: entry.count, share: entry.count / present.length }))
  }
  if (isTemporalType(type)) {
    const ms = present.map((value) => toDateMs(value)).filter((value): value is number => value !== undefined)
    if (ms.length) {
      let min = ms[0]!
      let max = ms[0]!
      for (const value of ms) {
        if (value < min) min = value
        if (value > max) max = value
      }
      profile.temporal = { min: new Date(min).toISOString(), max: new Date(max).toISOString(), spanDays: (max - min) / 86_400_000 }
    }
  }
  if (stringValues.length && !numbers.length) {
    const lengths = stringValues.map((value) => String(value).length)
    profile.text = { meanLength: lengths.reduce((a, b) => a + b, 0) / lengths.length, maxLength: Math.max(...lengths) }
  }
  const unit = semanticType === 'currency_amount' || semanticType === 'duration' || semanticType === 'measure' || semanticType === 'percentage' ? unitFromName(name) : undefined
  if (unit) profile.unit = unit
  profile.description = describeColumn(profile)
  return profile
}

function isSequential(numbers: number[]): boolean {
  const sorted = [...numbers].sort((a, b) => a - b)
  let steps = 0
  for (let index = 1; index < sorted.length; index++) if (sorted[index]! - sorted[index - 1]! === 1) steps++
  return steps / Math.max(1, sorted.length - 1) > 0.9
}

function describeColumn(profile: ColumnProfile): string {
  const parts = [`${profile.semanticType.replace(/_/g, ' ')} (${profile.type})`]
  parts.push(profile.missing ? `${profile.missing} missing (${(profile.missingRate * 100).toFixed(1)}%)` : 'no missing values')
  parts.push(profile.uniqueness === 1 && profile.distinct > 1 ? `all ${profile.distinct} values distinct` : `${profile.distinct} distinct`)
  if (profile.numeric) parts.push(`range ${fmt(profile.numeric.min)} to ${fmt(profile.numeric.max)}, median ${fmt(profile.numeric.median)}`)
  if (profile.temporal) parts.push(`from ${profile.temporal.min.slice(0, 10)} to ${profile.temporal.max.slice(0, 10)}`)
  if (profile.topValues?.length && profile.distinct <= 50) parts.push(`most common "${String(profile.topValues[0]!.value)}" (${(profile.topValues[0]!.share * 100).toFixed(1)}%)`)
  if (profile.unit) parts.push(`unit inferred from the name: ${profile.unit}`)
  return parts.join('; ')
}

function fmt(value: number): string {
  if (!Number.isFinite(value)) return String(value)
  return Math.abs(value) >= 1e5 || (Math.abs(value) < 1e-3 && value !== 0) ? value.toExponential(3) : Number(value.toFixed(4)).toString()
}

// ---------------------------------------------------------------- keys and grain

export interface KeyCandidate {
  columns: string[]
  unique: boolean
  nullFree: boolean
  duplicates: number
}

function distinctTuples(frame: Frame, columns: string[]): { distinct: number; nullRows: number } {
  const seen = new Set<string>()
  let nullRows = 0
  for (const row of frame.rows) {
    if (columns.some((name) => isMissing(row[name]))) {
      nullRows++
      continue
    }
    seen.add(columns.map((name) => scalarKey(row[name] ?? null)).join('\u0001'))
  }
  return { distinct: seen.size, nullRows }
}

/** Minimal keys: single columns first, then pairs (and triples of low-cardinality columns) if nothing single is unique. */
export function candidateKeys(frame: Frame, profiles: ColumnProfile[], maxKeys = 5): KeyCandidate[] {
  const n = frame.rows.length
  if (n === 0) return []
  const out: KeyCandidate[] = []
  const eligible = profiles.filter((profile) => profile.missing === 0 && profile.role !== 'text' && profile.type !== 'number' && profile.semanticType !== 'constant')
  for (const profile of profiles) {
    if (profile.distinct === n && profile.missing === 0 && profile.type !== 'number') out.push({ columns: [profile.name], unique: true, nullFree: true, duplicates: 0 })
  }
  if (out.length) return out.sort((a, b) => keyRank(profiles, a) - keyRank(profiles, b)).slice(0, maxKeys)
  const ranked = eligible.sort((a, b) => keyRank(profiles, { columns: [a.name] } as KeyCandidate) - keyRank(profiles, { columns: [b.name] } as KeyCandidate)).slice(0, 12)
  for (let i = 0; i < ranked.length && out.length < maxKeys; i++) {
    for (let j = i + 1; j < ranked.length && out.length < maxKeys; j++) {
      const columns = [ranked[i]!.name, ranked[j]!.name]
      const { distinct, nullRows } = distinctTuples(frame, columns)
      if (nullRows === 0 && distinct === n) out.push({ columns, unique: true, nullFree: true, duplicates: 0 })
    }
  }
  if (!out.length) {
    const small = ranked.slice(0, 8)
    for (let i = 0; i < small.length && out.length < maxKeys; i++)
      for (let j = i + 1; j < small.length && out.length < maxKeys; j++)
        for (let k = j + 1; k < small.length && out.length < maxKeys; k++) {
          const columns = [small[i]!.name, small[j]!.name, small[k]!.name]
          const { distinct, nullRows } = distinctTuples(frame, columns)
          if (nullRows === 0 && distinct === n) out.push({ columns, unique: true, nullFree: true, duplicates: 0 })
        }
  }
  return out
}

function keyRank(profiles: ColumnProfile[], key: Pick<KeyCandidate, 'columns'>): number {
  return key.columns.reduce((total, name) => {
    const profile = profiles.find((candidate) => candidate.name === name)
    if (!profile) return total + 10
    return total + (profile.semanticType === 'identifier' || profile.semanticType === 'uuid' ? 0 : profile.role === 'time' ? 1 : profile.role === 'dimension' ? 2 : 5)
  }, key.columns.length * 10)
}

export interface GrainDescription {
  key: string[] | null
  statement: string
  level: string
  confidence: 'high' | 'medium' | 'low'
}

/** States the grain: what one row represents. */
export function describeGrain(frame: Frame, profiles: ColumnProfile[], keys: KeyCandidate[]): GrainDescription {
  const key = keys[0]?.columns ?? null
  if (!key) {
    const duplicates = frame.rows.length - new Set(frame.rows.map((row) => JSON.stringify(frame.columns.map((name) => row[name] ?? null)))).size
    return { key: null, statement: `no column combination (up to three) uniquely identifies a row${duplicates ? `, and ${duplicates} rows are exact duplicates` : ''}; treat rows as events/observations and aggregate carefully`, level: 'event or observation (no key)', confidence: 'low' }
  }
  const names = key.join(', ')
  const lowerNames = key.map((name) => name.toLowerCase()).join(' ')
  const timeParts = key.filter((name) => profiles.find((profile) => profile.name === name)?.role === 'time')
  let level = 'row'
  if (/order_?line|line_?item|line_?no|line_?id/.test(lowerNames)) level = 'order-line'
  else if (/order/.test(lowerNames)) level = 'order'
  else if (/transaction|txn|payment/.test(lowerNames)) level = 'transaction'
  else if (/session/.test(lowerNames)) level = 'session'
  else if (/event/.test(lowerNames)) level = 'event'
  else if (/invoice/.test(lowerNames)) level = 'invoice'
  else if (/customer|user|client|account|member/.test(lowerNames) && !timeParts.length) level = 'customer'
  else if (/product|sku|item/.test(lowerNames) && !timeParts.length) level = 'product'
  else if (/employee|staff/.test(lowerNames)) level = 'employee'
  if (timeParts.length && key.length > 1) {
    const time = profiles.find((profile) => profile.name === timeParts[0])
    const others = key.filter((name) => !timeParts.includes(name))
    const granularity = time?.temporal ? temporalGranularity(frame, time.name) : 'period'
    level = `${others.join(' × ')} × ${granularity}`
  } else if (timeParts.length) level = `${temporalGranularity(frame, timeParts[0]!)} (time series)`
  return { key, statement: `one row per ${key.length > 1 ? `(${names})` : names}`, level, confidence: key.length === 1 ? 'high' : 'medium' }
}

/** The typical spacing of a date column's distinct values: daily, weekly, monthly, quarterly, yearly, or irregular. */
export function temporalGranularity(frame: Frame, name: string): string {
  const ms = [...new Set(frame.rows.map((row) => toDateMs(row[name])).filter((value): value is number => value !== undefined))].sort((a, b) => a - b)
  if (ms.length < 3) return 'period'
  const gaps = ms.slice(1).map((value, index) => (value - ms[index]!) / 86_400_000).sort((a, b) => a - b)
  const median = gaps[Math.floor(gaps.length / 2)]!
  if (median < 1 / 24) return 'sub-hourly'
  if (median < 1) return 'hourly'
  if (median <= 1.5) return 'daily'
  if (median >= 6 && median <= 8) return 'weekly'
  if (median >= 27 && median <= 32) return 'monthly'
  if (median >= 88 && median <= 93) return 'quarterly'
  if (median >= 360 && median <= 370) return 'yearly'
  return `irregular (median gap ${median.toFixed(1)} days)`
}

// ---------------------------------------------------------------- relationships across datasets

export interface Relationship {
  from: { dataset: string; column: string }
  to: { dataset: string; column: string }
  cardinality: 'many-to-one' | 'one-to-one'
  containment: number
  orphanValues: number
  orphanRows: number
  matchedParentShare: number
  nameSimilarity: boolean
  confidence: 'high' | 'medium' | 'low'
  evidence: string
}

function comparableKey(value: Scalar): string | null {
  if (isMissing(value)) return null
  const number = toNumber(value)
  if (number !== undefined) return `n:${number}`
  return `s:${String(value).trim()}`
}

function normalizedName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/(id|key|code|no|number)$/, '')
}

/**
 * Proposes foreign keys between datasets by value containment: child column values must
 * be (almost all) contained in a parent column that is unique. Name similarity only raises
 * confidence; it never creates a relationship on its own.
 */
export function discoverRelationships(datasets: Array<{ name: string; frame: Frame; profiles: ColumnProfile[] }>, minimumContainment = 0.9): { relationships: Relationship[]; warnings: string[] } {
  const relationships: Relationship[] = []
  const warnings: string[] = []
  const valueSets = new Map<string, { keys: Set<string>; rowKeys: Array<string | null> }>()
  const keysOf = (dataset: string, frame: Frame, name: string) => {
    const id = `${dataset}\u0000${name}`
    let cached = valueSets.get(id)
    if (!cached) {
      const rowKeys = frame.rows.map((row) => comparableKey(row[name] ?? null))
      cached = { keys: new Set(rowKeys.filter((key): key is string => key !== null)), rowKeys }
      valueSets.set(id, cached)
    }
    return cached
  }
  for (const parent of datasets) {
    const parentKeys = parent.profiles.filter((profile) => profile.distinct >= 2 && profile.uniqueness === 1 && profile.missingRate < 0.01 && profile.role !== 'text' && profile.role !== 'measure' && profile.type !== 'number')
    for (const child of datasets) {
      for (const parentKey of parentKeys) {
        const parentValues = keysOf(parent.name, parent.frame, parentKey.name).keys
        for (const childColumn of child.profiles) {
          if (child.name === parent.name && childColumn.name === parentKey.name) continue
          if (childColumn.distinct < 2 || childColumn.role === 'text' || childColumn.role === 'measure' || childColumn.type === 'number' || childColumn.role === 'time') continue
          if (isNumericType(childColumn.type) !== isNumericType(parentKey.type)) continue
          const childValues = keysOf(child.name, child.frame, childColumn.name)
          let contained = 0
          for (const key of childValues.keys) if (parentValues.has(key)) contained++
          const containment = childValues.keys.size ? contained / childValues.keys.size : 0
          const similar = normalizedName(childColumn.name) !== '' && (normalizedName(childColumn.name) === normalizedName(parentKey.name) || normalizedName(childColumn.name) === normalizedName(parent.name).replace(/s$/, ''))
          if (containment < minimumContainment) {
            if (similar && child.name !== parent.name && contained / Math.max(1, childValues.keys.size) < 0.5) warnings.push(`${child.name}.${childColumn.name} and ${parent.name}.${parentKey.name} have similar names but only ${(containment * 100).toFixed(0)}% of values match — do not join on them without checking`)
            continue
          }
          if (child.name === parent.name && !similar) continue
          if (!similar && childColumn.distinct < 10) continue
          let orphanRows = 0
          for (const key of childValues.rowKeys) if (key !== null && !parentValues.has(key)) orphanRows++
          const matchedParentShare = parentValues.size ? contained / parentValues.size : 0
          const confidence: Relationship['confidence'] = containment >= 0.99 && similar ? 'high' : containment >= 0.99 || similar ? 'medium' : 'low'
          relationships.push({
            from: { dataset: child.name, column: childColumn.name },
            to: { dataset: parent.name, column: parentKey.name },
            cardinality: childColumn.uniqueness === 1 && childColumn.missing === 0 ? 'one-to-one' : 'many-to-one',
            containment,
            orphanValues: childValues.keys.size - contained,
            orphanRows,
            matchedParentShare,
            nameSimilarity: similar,
            confidence,
            evidence: `${(containment * 100).toFixed(1)}% of ${childColumn.distinct} distinct ${child.name}.${childColumn.name} values exist in unique ${parent.name}.${parentKey.name}${orphanRows ? `; ${orphanRows} rows reference missing parents (referential-integrity violations)` : ''}`,
          })
        }
      }
    }
  }
  const best = new Map<string, Relationship>()
  for (const relationship of relationships) {
    const key = `${relationship.from.dataset}.${relationship.from.column}`
    const current = best.get(key)
    const score = (r: Relationship) => r.containment + (r.nameSimilarity ? 0.5 : 0) + (r.confidence === 'high' ? 0.2 : 0)
    if (!current || score(relationship) > score(current)) best.set(key, relationship)
  }
  return { relationships: [...best.values()], warnings: [...new Set(warnings)] }
}

export interface DatasetUnderstanding {
  rows: number
  columns: number
  grain: GrainDescription
  keys: KeyCandidate[]
  profiles: ColumnProfile[]
  roles: Record<AnalyticalRole, string[]>
  timeColumns: Array<{ name: string; granularity: string; min?: string; max?: string }>
  suggestedTargets: string[]
}

export function understandDataset(frame: Frame): DatasetUnderstanding {
  const profiles = frame.columns.map((name) => profileColumn(frame, name))
  const keys = candidateKeys(frame, profiles)
  const grain = describeGrain(frame, profiles, keys)
  const roles = { identifier: [], dimension: [], measure: [], time: [], geo: [], text: [], flag: [], metadata: [], unusable: [] } as Record<AnalyticalRole, string[]>
  for (const profile of profiles) roles[profile.role].push(profile.name)
  const timeColumns = profiles.filter((profile) => profile.role === 'time' && (profile.type === 'date' || profile.type === 'datetime')).map((profile) => ({ name: profile.name, granularity: temporalGranularity(frame, profile.name), ...(profile.temporal ? { min: profile.temporal.min, max: profile.temporal.max } : {}) }))
  const suggestedTargets = profiles.filter((profile) => (profile.role === 'flag' && /churn|convert|default|fraud|outcome|target|label|won|success|retain|cancel|click|purchase/i.test(profile.name)) || (profile.role === 'measure' && /revenue|sales|price|amount|demand|target|label|score|value|cost|profit/i.test(profile.name))).map((profile) => profile.name)
  return { rows: frame.rows.length, columns: frame.columns.length, grain, keys, profiles, roles, timeColumns, suggestedTargets }
}

export { parseDateMs }
