import { createHash } from 'node:crypto'
import { publicFetch } from '../networkPolicy.ts'
import { readBoundedBytes } from '../tools/webFetch.ts'

/**
 * Battmann's real data feeds: public statistical and event APIs fetched by code, never typed in by a model.
 *
 * Every figure a feed returns carries the exact request URL, the retrieval time, and a SHA-256 of the raw
 * response bytes, so a reading in the store can be traced to what the source actually served. The hosts are
 * fixed here; a caller supplies only validated parameters (country codes, indicator ids, HS codes), so no
 * model-chosen URL is ever requested. API keys travel in headers and never appear in a recorded URL.
 */

export const FEED_NAMES = ['fx', 'worldbank', 'imf', 'comtrade', 'gdelt', 'commodity', 'tariff'] as const
export type FeedName = (typeof FEED_NAMES)[number]
export type FeedFrequency = 'daily' | 'monthly' | 'quarterly' | 'annual'
export type HigherIs = 'risk-on' | 'risk-off' | 'neutral'

export interface FxRequest { feed: 'fx'; base: string; quotes: string[]; start: string; end: string }
export interface WorldBankRequest { feed: 'worldbank'; country: string; indicator: string; startYear: number; endYear: number }
export interface ImfRequest { feed: 'imf'; country: string; indicator: string }
export interface ComtradeRequest { feed: 'comtrade'; reporter: string; partner: string; hs: string; flow: 'import' | 'export'; frequency: 'annual' | 'monthly'; periods: string[] }
export interface GdeltRequest { feed: 'gdelt'; query: string; start: string; end: string }
export interface CommodityRequest { feed: 'commodity'; commodities: string[]; unit: 'USD' | 'IX'; start: string }
export interface TariffRequest { feed: 'tariff'; reporter: string; partner: string; products: string[]; years: number[] }
export type FeedRequest = FxRequest | WorldBankRequest | ImfRequest | ComtradeRequest | GdeltRequest | CommodityRequest | TariffRequest

export interface FeedObservation { period: string; observedAt: string; value: number; status: 'actual' | 'projection' }
export interface FeedSeries { key: string; name: string; unit: string; frequency: FeedFrequency; higherIs: HigherIs; observations: FeedObservation[] }
export interface FeedResult {
  feed: FeedName
  request: FeedRequest
  publisher: string
  title: string
  /** The request URL(s), without credentials. The first is the canonical source URL. */
  sourceUrls: string[]
  retrievedAt: string
  /** When the source says the dataset was last updated, if it says. */
  sourceUpdatedAt: string | null
  /** SHA-256 over the raw response bytes, in request order. */
  responseSha256: string
  /** How far this source's figures can be trusted as measurements (0-1); a documented default, not a fitted value. */
  reliability: number
  series: FeedSeries[]
  notes: string[]
  /** A per-partner breakdown of a Comtrade period, computed from the rows above. */
  breakdown?: { period: string; total: number | null; partners: { partner: string; name: string; value: number; share: number | null }[] }[]
}

const HOSTS = {
  fx: 'api.frankfurter.dev',
  worldbank: 'api.worldbank.org',
  imf: 'www.imf.org',
  comtrade: 'comtradeapi.un.org',
  gdelt: 'api.gdeltproject.org',
  commodity: 'api.imf.org',
  tariff: 'wits.worldbank.org',
} as const

const RELIABILITY: Record<FeedName, number> = { fx: 0.98, worldbank: 0.95, imf: 0.9, comtrade: 0.9, gdelt: 0.6, commodity: 0.95, tariff: 0.9 }
const MIN_INTERVAL_MS: Record<string, number> = { [HOSTS.gdelt]: 5_500, [HOSTS.comtrade]: 1_500 }
const TIMEOUT_MS: Record<string, number> = { [HOSTS.comtrade]: 90_000, [HOSTS.gdelt]: 45_000, [HOSTS.tariff]: 90_000, [HOSTS.commodity]: 60_000 }
const MAX_RESPONSE_BYTES = 12 * 1024 * 1024
const DAY_MS = 86_400_000

/** Test seam: replaces the network, waiting, and the clock. Never set outside tests. */
export const feedTestHooks: { fetch?: (url: URL, headers: Record<string, string>) => Promise<Response>; sleep?: (ms: number) => Promise<void>; now?: () => Date } = {}

const sleep = (ms: number) => (feedTestHooks.sleep ? feedTestHooks.sleep(ms) : new Promise<void>((resolve) => setTimeout(resolve, ms)))
export const feedNow = (): Date => (feedTestHooks.now ? feedTestHooks.now() : new Date())

const lastRequestAt = new Map<string, number>()

interface Fetched { json: unknown; bytes: Uint8Array; url: string }
interface FetchedText { text: string; bytes: Uint8Array; url: string }

async function getJson(url: URL, options: { headers?: Record<string, string>; retries?: number } = {}): Promise<Fetched> {
  const fetched = await getText(url, options)
  try {
    return { json: JSON.parse(fetched.text), bytes: fetched.bytes, url: fetched.url }
  } catch {
    throw new Error(`${url.hostname} returned a non-JSON response: ${fetched.text.slice(0, 200).replace(/\s+/g, ' ')}`)
  }
}

async function getText(url: URL, options: { headers?: Record<string, string>; retries?: number; accept?: string } = {}): Promise<FetchedText> {
  if (!(Object.values(HOSTS) as string[]).includes(url.hostname) || url.protocol !== 'https:') throw new Error(`feed host is not allowed: ${url.origin}`)
  const minInterval = MIN_INTERVAL_MS[url.hostname] ?? 0
  const retries = options.retries ?? 2
  let lastProblem = ''
  for (let attempt = 0; attempt <= retries; attempt++) {
    const waited = Date.now() - (lastRequestAt.get(url.hostname) ?? 0)
    if (minInterval && waited < minInterval) await sleep(minInterval - waited)
    if (attempt > 0) await sleep(url.hostname === HOSTS.gdelt ? 6_000 * attempt : 2_000 * attempt)
    lastRequestAt.set(url.hostname, Date.now())
    const headers = { accept: options.accept ?? 'application/json', 'user-agent': 'elia-battmann (+https://github.com/MdSahilMolla/elia)', ...options.headers }
    let response: Response
    try {
      response = feedTestHooks.fetch
        ? await feedTestHooks.fetch(url, headers)
        : await publicFetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS[url.hostname] ?? 30_000) })
    } catch (error) {
      lastProblem = error instanceof Error ? error.message : String(error)
      continue
    }
    if (response.status >= 300 && response.status < 400) throw new Error(`${url.hostname} answered with a redirect (${response.status}); feeds never follow redirects`)
    const { bytes, truncated } = await readBoundedBytes(response.body, MAX_RESPONSE_BYTES)
    if (truncated) throw new Error(`${url.hostname} response exceeded ${MAX_RESPONSE_BYTES} bytes`)
    const body = new TextDecoder().decode(bytes)
    if (response.status === 429 || response.status >= 500 || !body.trim()) {
      lastProblem = response.status === 429 ? `rate limited by ${url.hostname} (HTTP 429)` : `${url.hostname} returned HTTP ${response.status}${body.trim() ? '' : ' with an empty body'}`
      continue
    }
    if (response.status >= 400) throw new Error(`${url.hostname} returned HTTP ${response.status}: ${body.slice(0, 200)}`)
    return { text: body, bytes, url: url.toString() }
  }
  throw new Error(`${url.hostname} did not return data after ${retries + 1} attempts: ${lastProblem}`)
}

function sha256(chunks: Uint8Array[]): string {
  const hash = createHash('sha256')
  for (const chunk of chunks) hash.update(chunk)
  return hash.digest('hex')
}

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

type Raw = Record<string, unknown>

function str(value: unknown, name: string, pattern: RegExp, hint: string): string {
  if (typeof value !== 'string' || !pattern.test(value.trim())) throw new Error(`${name} must be ${hint}`)
  return value.trim()
}

function isoDay(value: unknown, name: string): string {
  const day = str(value, name, /^\d{4}-\d{2}-\d{2}$/, 'a date like 2026-09-24')
  if (!Number.isFinite(Date.parse(`${day}T00:00:00Z`))) throw new Error(`${name} is not a real date`)
  return day
}

const dayOf = (date: Date): string => date.toISOString().slice(0, 10)
const addDays = (day: string, days: number): string => dayOf(new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS))

function year(value: unknown, name: string): number {
  const result = typeof value === 'string' ? Number(value) : value
  if (typeof result !== 'number' || !Number.isInteger(result) || result < 1960 || result > 2100) throw new Error(`${name} must be a year between 1960 and 2100`)
  return result
}

/** Validates a caller's parameters and fills defaults. The result is the exact, reproducible request. */
export function normalizeFeedRequest(raw: Raw, now: Date = feedNow()): FeedRequest {
  const feed = raw.feed
  const today = dayOf(now)
  if (feed === 'fx') {
    const base = str(raw.base ?? 'USD', 'base', /^[A-Za-z]{3}$/, 'a three-letter currency code').toUpperCase()
    const quoteList = Array.isArray(raw.quotes) ? raw.quotes : raw.quote === undefined ? [] : [raw.quote]
    const quotes = quoteList.map((value, index) => str(value, `quotes[${index}]`, /^[A-Za-z]{3}$/, 'a three-letter currency code').toUpperCase())
    if (!quotes.length || quotes.length > 10) throw new Error('fx needs one to ten quote currencies (quote or quotes)')
    if (quotes.includes(base)) throw new Error('a quote currency must differ from the base')
    const end = raw.end === undefined ? today : isoDay(raw.end, 'end')
    const start = raw.start === undefined ? addDays(end, -365) : isoDay(raw.start, 'start')
    if (start > end) throw new Error('start must not be after end')
    if (Date.parse(end) - Date.parse(start) > 5 * 366 * DAY_MS) throw new Error('an fx window may span at most five years')
    return { feed, base, quotes: [...new Set(quotes)].sort(), start, end: end > today ? today : end }
  }
  if (feed === 'worldbank') {
    const endYear = raw.endYear === undefined ? now.getUTCFullYear() : year(raw.endYear, 'endYear')
    const startYear = raw.startYear === undefined ? endYear - 20 : year(raw.startYear, 'startYear')
    if (startYear > endYear) throw new Error('startYear must not be after endYear')
    return {
      feed,
      country: str(raw.country, 'country', /^[A-Za-z]{2,3}$/, 'an ISO 3166 alpha-2 or alpha-3 country code').toUpperCase(),
      indicator: str(raw.indicator, 'indicator', /^[A-Za-z][A-Za-z0-9._]{1,79}$/, 'a World Bank indicator id such as NY.GDP.MKTP.KD.ZG'),
      startYear, endYear,
    }
  }
  if (feed === 'imf') {
    return {
      feed,
      country: str(raw.country, 'country', /^[A-Za-z]{3}$/, 'an ISO 3166 alpha-3 country code').toUpperCase(),
      indicator: str(raw.indicator, 'indicator', /^[A-Za-z][A-Za-z0-9_]{1,59}$/, 'an IMF DataMapper indicator id such as NGDP_RPCH').toUpperCase(),
    }
  }
  if (feed === 'comtrade') {
    const frequency = raw.frequency === undefined || raw.frequency === 'annual' ? 'annual' : raw.frequency === 'monthly' ? 'monthly' : undefined
    if (!frequency) throw new Error('frequency must be annual or monthly')
    const periodList = Array.isArray(raw.periods) ? raw.periods : raw.period === undefined ? [] : [raw.period]
    const periods = (periodList.length ? periodList : [frequency === 'annual' ? String(now.getUTCFullYear() - 1) : dayOf(new Date(now.getTime() - 90 * DAY_MS)).slice(0, 7).replace('-', '')])
      .map((value, index) => str(String(value), `periods[${index}]`, frequency === 'annual' ? /^\d{4}$/ : /^\d{4}(0[1-9]|1[0-2])$/, frequency === 'annual' ? 'a year like 2025' : 'a month like 202606'))
    if (periods.length > 6) throw new Error('comtrade takes at most six periods per request')
    const flow = raw.flow === undefined || raw.flow === 'import' ? 'import' : raw.flow === 'export' ? 'export' : undefined
    if (!flow) throw new Error('flow must be import or export')
    return {
      feed,
      reporter: str(raw.reporter, 'reporter', /^[A-Za-z]{3}$/, 'an ISO 3166 alpha-3 country code').toUpperCase(),
      partner: str(raw.partner ?? 'ALL', 'partner', /^[A-Za-z0-9]{3}$/, 'ALL, WLD (world total), or an ISO alpha-3 partner code').toUpperCase(),
      hs: str(raw.hs, 'hs', /^(\d{2}|\d{4}|\d{6}|TOTAL)$/, 'an HS code of 2, 4 or 6 digits, or TOTAL'),
      flow, frequency, periods: [...new Set(periods)].sort(),
    }
  }
  if (feed === 'gdelt') {
    const query = typeof raw.query === 'string' ? raw.query.trim() : ''
    if (query.length < 2 || query.length > 300 || /[\u0000-\u001f]/.test(query)) throw new Error('gdelt query must be 2-300 printable characters')
    const end = raw.end === undefined ? today : isoDay(raw.end, 'end')
    const start = raw.start === undefined ? addDays(end, -30) : isoDay(raw.start, 'start')
    if (start > end) throw new Error('start must not be after end')
    if (start < addDays(today, -90)) throw new Error('the GDELT DOC API only covers the last 90 days; start must be within that window')
    return { feed, query, start, end: end > today ? today : end }
  }
  if (feed === 'commodity') {
    const list = Array.isArray(raw.commodities) ? raw.commodities : raw.commodity === undefined ? [] : [raw.commodity]
    const commodities = list.map((value, index) => str(typeof value === 'string' ? value.toUpperCase() : value, `commodities[${index}]`, /^P[A-Z0-9]{2,15}$/, 'an IMF PCPS commodity code such as POILAPSP (crude oil), PCOPP (copper) or PTIN (tin)'))
    if (!commodities.length || commodities.length > 10) throw new Error('commodity needs one to ten codes (commodity or commodities)')
    const unit = raw.unit === undefined || raw.unit === 'USD' ? 'USD' : raw.unit === 'IX' ? 'IX' : undefined
    if (!unit) throw new Error('unit must be USD (prices) or IX (index)')
    const start = raw.start === undefined ? dayOf(new Date(now.getTime() - 36 * 31 * DAY_MS)).slice(0, 7) : str(String(raw.start).slice(0, 7), 'start', /^\d{4}-(0[1-9]|1[0-2])$/, 'a month like 2023-09')
    return { feed, commodities: [...new Set(commodities)].sort(), unit, start }
  }
  if (feed === 'tariff') {
    const productList = Array.isArray(raw.products) ? raw.products : raw.hs === undefined ? [] : [raw.hs]
    const products = productList.map((value, index) => str(String(value), `products[${index}]`, /^\d{6}$/, 'a six-digit HS code such as 854231'))
    if (!products.length || products.length > 10) throw new Error('tariff needs one to ten six-digit HS codes (hs or products)')
    const yearList = Array.isArray(raw.years) ? raw.years : raw.year === undefined ? [now.getUTCFullYear() - 3, now.getUTCFullYear() - 2] : [raw.year]
    const years = yearList.map((value, index) => year(value, `years[${index}]`))
    if (years.length > 5) throw new Error('tariff takes at most five years per request')
    return {
      feed,
      reporter: str(raw.reporter, 'reporter', /^[A-Za-z]{3}$/, 'an ISO 3166 alpha-3 country code').toUpperCase(),
      partner: str(raw.partner ?? 'WLD', 'partner', /^[A-Za-z]{3}$/, 'WLD (the MFN rate applied to all) or an ISO alpha-3 partner code').toUpperCase(),
      products: [...new Set(products)].sort(), years: [...new Set(years)].sort(),
    }
  }
  throw new Error(`feed must be one of: ${FEED_NAMES.join(', ')}`)
}

/** A stable identifier for a request, used to de-duplicate subscriptions. */
export function feedRequestKey(request: FeedRequest): string {
  const { start: _start, end: _end, startYear: _startYear, endYear: _endYear, periods: _periods, ...stable } = request as FeedRequest & Record<string, unknown>
  return createHash('sha256').update(JSON.stringify(stable, Object.keys(stable).sort())).digest('hex').slice(0, 16)
}

/** The end-of-period instant a period label refers to (a year ends on 31 Dec, a month on its last day). */
export function periodEnd(period: string): string {
  if (/^\d{4}$/.test(period)) return `${period}-12-31T00:00:00.000Z`
  const month = /^(\d{4})-?(0[1-9]|1[0-2])$/.exec(period) ?? /^(\d{4})M(0[1-9]|1[0-2])$/.exec(period)
  if (month) return new Date(Date.UTC(Number(month[1]), Number(month[2]), 0)).toISOString()
  const quarter = /^(\d{4})Q([1-4])$/.exec(period)
  if (quarter) return new Date(Date.UTC(Number(quarter[1]), Number(quarter[2]) * 3, 0)).toISOString()
  const day = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(period)
  if (day) return `${day[1]}-${day[2]}-${day[3]}T00:00:00.000Z`
  throw new Error(`unrecognised period label: ${period}`)
}

function observation(period: string, value: number, now: Date, projection = false): FeedObservation {
  const observedAt = periodEnd(period)
  return { period, observedAt, value, status: projection || Date.parse(observedAt) > now.getTime() ? 'projection' : 'actual' }
}

// ---------------------------------------------------------------------------
// Feeds
// ---------------------------------------------------------------------------

async function fetchFx(request: FxRequest, now: Date): Promise<FeedResult> {
  const url = new URL(`https://${HOSTS.fx}/v1/${request.start}..${request.end}`)
  url.searchParams.set('base', request.base)
  url.searchParams.set('symbols', request.quotes.join(','))
  const fetched = await getJson(url)
  const body = fetched.json as { rates?: Record<string, Record<string, number>>; message?: string }
  if (!body.rates || typeof body.rates !== 'object') throw new Error(`Frankfurter returned no rates${body.message ? `: ${body.message}` : ''}`)
  const days = Object.keys(body.rates).sort()
  const series: FeedSeries[] = request.quotes.map((quote) => ({
    key: `fx:${request.base}:${quote}`,
    name: `${request.base}/${quote} reference rate`,
    unit: `${quote} per ${request.base}`,
    frequency: 'daily',
    higherIs: 'neutral',
    observations: days.flatMap((day) => {
      const value = body.rates![day]![quote]
      return typeof value === 'number' && Number.isFinite(value) ? [observation(day, value, now)] : []
    }),
  }))
  return {
    feed: 'fx', request, publisher: 'European Central Bank reference rates, via Frankfurter',
    title: `${request.base} against ${request.quotes.join(', ')}, ${request.start} to ${request.end}`,
    sourceUrls: [fetched.url], retrievedAt: now.toISOString(), sourceUpdatedAt: days.length ? periodEnd(days[days.length - 1]!) : null,
    responseSha256: sha256([fetched.bytes]), reliability: RELIABILITY.fx, series,
    notes: [
      'The ECB publishes reference rates on TARGET business days only (about 16:00 CET); weekends and holidays have no rate.',
      ...(request.base === 'EUR' ? [] : [`Rates against ${request.base} are cross rates Frankfurter derives from the ECB's EUR reference rates.`]),
    ],
  }
}

async function fetchWorldBank(request: WorldBankRequest, now: Date): Promise<FeedResult> {
  const url = new URL(`https://${HOSTS.worldbank}/v2/country/${request.country}/indicator/${request.indicator}`)
  url.searchParams.set('format', 'json')
  url.searchParams.set('per_page', '500')
  url.searchParams.set('date', `${request.startYear}:${request.endYear}`)
  const fetched = await getJson(url)
  const body = fetched.json as unknown[]
  const meta = Array.isArray(body) ? body[0] as { message?: { value?: string }[]; lastupdated?: string } | undefined : undefined
  if (!Array.isArray(body) || meta?.message) throw new Error(`World Bank rejected the request: ${meta?.message?.map((item) => item.value).join('; ') ?? 'unexpected response shape'}`)
  const rows = (Array.isArray(body[1]) ? body[1] : []) as { indicator?: { value?: string }; country?: { value?: string }; date?: string; value?: number | null; unit?: string }[]
  if (!rows.length) throw new Error(`World Bank has no data for ${request.indicator} in ${request.country} between ${request.startYear} and ${request.endYear}`)
  const indicatorName = rows[0]?.indicator?.value ?? request.indicator
  const countryName = rows[0]?.country?.value ?? request.country
  const observations = rows
    .filter((row) => typeof row.value === 'number' && Number.isFinite(row.value) && typeof row.date === 'string')
    .map((row) => observation(row.date!, row.value!, now))
    .sort((a, b) => a.observedAt.localeCompare(b.observedAt))
  const frequency: FeedFrequency = rows.some((row) => /M\d{2}$/.test(row.date ?? '')) ? 'monthly' : rows.some((row) => /Q\d$/.test(row.date ?? '')) ? 'quarterly' : 'annual'
  const unitMatch = /\(([^)]+)\)\s*$/.exec(indicatorName)
  return {
    feed: 'worldbank', request, publisher: 'World Bank, World Development Indicators API',
    title: `${indicatorName}: ${countryName}, ${request.startYear}-${request.endYear}`,
    sourceUrls: [fetched.url], retrievedAt: now.toISOString(),
    sourceUpdatedAt: meta?.lastupdated && Number.isFinite(Date.parse(meta.lastupdated)) ? new Date(meta.lastupdated).toISOString() : null,
    responseSha256: sha256([fetched.bytes]), reliability: RELIABILITY.worldbank,
    series: [{ key: `wb:${request.country}:${request.indicator}`, name: `${indicatorName} — ${countryName}`, unit: rows[0]?.unit || unitMatch?.[1] || 'value', frequency, higherIs: 'neutral', observations }],
    notes: [`${rows.length - observations.length} period(s) in the window have no value yet (World Bank publishes with a lag).`].filter(() => rows.length > observations.length),
  }
}

let imfCatalogue: Promise<{ fetched: Fetched; indicators: Record<string, { label?: string; unit?: string; source?: string; 'last-modified'?: string }> }> | undefined

async function fetchImf(request: ImfRequest, now: Date): Promise<FeedResult> {
  imfCatalogue ??= getJson(new URL(`https://${HOSTS.imf}/external/datamapper/api/v1/indicators`)).then((fetched) => ({ fetched, indicators: (fetched.json as { indicators?: Record<string, never> }).indicators ?? {} }))
  const catalogue = await imfCatalogue.catch((error: unknown) => {
    imfCatalogue = undefined
    throw error
  })
  const meta = catalogue.indicators[request.indicator]
  if (!meta) throw new Error(`IMF DataMapper has no indicator ${request.indicator}; examples: NGDP_RPCH (real GDP growth), PCPIPCH (inflation), BCA_NGDPD (current account, % of GDP)`)
  const url = new URL(`https://${HOSTS.imf}/external/datamapper/api/v1/${request.indicator}/${request.country}`)
  const fetched = await getJson(url)
  const values = (fetched.json as { values?: Record<string, Record<string, Record<string, number>>> }).values?.[request.indicator]?.[request.country]
  if (!values) throw new Error(`IMF DataMapper has no ${request.indicator} values for ${request.country}`)
  const currentYear = now.getUTCFullYear()
  const observations = Object.entries(values)
    .filter(([period, value]) => /^\d{4}$/.test(period) && typeof value === 'number' && Number.isFinite(value))
    .map(([period, value]) => observation(period, value, now, Number(period) >= currentYear))
    .sort((a, b) => a.observedAt.localeCompare(b.observedAt))
  const source = meta.source ?? 'IMF DataMapper'
  return {
    feed: 'imf', request, publisher: `International Monetary Fund, ${source}`,
    title: `${meta.label ?? request.indicator}: ${request.country}`,
    sourceUrls: [fetched.url, catalogue.fetched.url], retrievedAt: now.toISOString(),
    sourceUpdatedAt: meta['last-modified'] && Number.isFinite(Date.parse(meta['last-modified'])) ? new Date(meta['last-modified'].replace(' ', 'T') + 'Z').toISOString() : null,
    responseSha256: sha256([fetched.bytes]), reliability: RELIABILITY.imf,
    series: [{ key: `imf:${request.country}:${request.indicator}`, name: `${meta.label ?? request.indicator} — ${request.country} (IMF)`, unit: meta.unit ?? 'value', frequency: 'annual', higherIs: 'neutral', observations }],
    notes: [
      `Values for ${currentYear} onward are IMF projections from the ${source}, not observations; they are returned but never recorded as readings.`,
      'The most recent past years can be IMF estimates that later editions revise.',
    ],
  }
}

interface ComtradeArea { code: number; iso3: string; name: string }
let comtradeReference: Promise<{ reporters: ComtradeArea[]; partners: ComtradeArea[] }> | undefined

async function loadComtradeReference(): Promise<{ reporters: ComtradeArea[]; partners: ComtradeArea[] }> {
  comtradeReference ??= (async () => {
    const parse = (json: unknown, codeKey: string, isoKey: string): ComtradeArea[] => ((json as { results?: Raw[] }).results ?? [])
      .filter((row) => !row.entryExpiredDate)
      .map((row) => ({ code: Number(row[codeKey] ?? row.id), iso3: String(row[isoKey] ?? ''), name: String(row.text ?? row.id) }))
    const reporters = await getJson(new URL(`https://${HOSTS.comtrade}/files/v1/app/reference/Reporters.json`))
    const partners = await getJson(new URL(`https://${HOSTS.comtrade}/files/v1/app/reference/partnerAreas.json`))
    return { reporters: parse(reporters.json, 'reporterCode', 'reporterCodeIsoAlpha3'), partners: parse(partners.json, 'PartnerCode', 'PartnerCodeIsoAlpha3') }
  })()
  return comtradeReference.catch((error: unknown) => {
    comtradeReference = undefined
    throw error
  })
}

/** Comtrade files Taiwan's trade under "Other Asia, nes" (partner code 490); it is not a Comtrade reporter. */
const TAIWAN_PARTNER_CODE = 490

async function fetchComtrade(request: ComtradeRequest, now: Date): Promise<FeedResult> {
  const reference = await loadComtradeReference()
  const reporter = reference.reporters.find((area) => area.iso3 === request.reporter)
  if (!reporter) throw new Error(`UN Comtrade has no reporter with ISO code ${request.reporter}`)
  let partnerCode: number | undefined
  if (request.partner === 'WLD') partnerCode = 0
  else if (request.partner === 'TWN') partnerCode = TAIWAN_PARTNER_CODE
  else if (request.partner !== 'ALL') {
    partnerCode = reference.partners.find((area) => area.iso3 === request.partner && area.code !== 0)?.code
    if (partnerCode === undefined) throw new Error(`UN Comtrade has no partner with ISO code ${request.partner}`)
  }
  const partnerName = (code: number) => code === TAIWAN_PARTNER_CODE ? 'Other Asia, nes (Taiwan)' : reference.partners.find((area) => area.code === code)?.name ?? `partner ${code}`
  const partnerIso = (code: number) => code === 0 ? 'WLD' : code === TAIWAN_PARTNER_CODE ? 'TWN' : reference.partners.find((area) => area.code === code)?.iso3 || `C${code}`
  const key = process.env.COMTRADE_API_KEY?.trim()
  const freq = request.frequency === 'annual' ? 'A' : 'M'
  const flowCode = request.flow === 'import' ? 'M' : 'X'
  const rows: Raw[] = []
  const urls: string[] = []
  const chunks: Uint8Array[] = []
  // The keyless preview serves one period per call, so every mode asks one period at a time.
  for (const period of request.periods) {
    const url = new URL(key ? `https://${HOSTS.comtrade}/data/v1/get/C/${freq}/HS` : `https://${HOSTS.comtrade}/public/v1/preview/C/${freq}/HS`)
    url.searchParams.set('reporterCode', String(reporter.code))
    url.searchParams.set('period', period)
    if (partnerCode !== undefined) url.searchParams.set('partnerCode', String(partnerCode))
    url.searchParams.set('cmdCode', request.hs)
    url.searchParams.set('flowCode', flowCode)
    url.searchParams.set('partner2Code', '0')
    url.searchParams.set('customsCode', 'C00')
    url.searchParams.set('motCode', '0')
    const fetched = await getJson(url, key ? { headers: { 'Ocp-Apim-Subscription-Key': key } } : {})
    const body = fetched.json as { data?: Raw[]; error?: string }
    if (body.error) throw new Error(`UN Comtrade rejected the request: ${body.error}`)
    rows.push(...(body.data ?? []))
    urls.push(fetched.url)
    chunks.push(fetched.bytes)
  }
  const clean = rows.filter((row) => Number(row.partner2Code) === 0 && row.customsCode === 'C00' && Number(row.motCode) === 0 && String(row.cmdCode) === request.hs && row.flowCode === flowCode && typeof row.primaryValue === 'number')
  const byPartner = new Map<number, FeedObservation[]>()
  for (const row of clean) {
    const code = Number(row.partnerCode)
    const period = String(row.period)
    const list = byPartner.get(code) ?? []
    if (!list.some((item) => item.period === period)) list.push(observation(period, Number(row.primaryValue), now))
    byPartner.set(code, list)
  }
  const flowWord = request.flow === 'import' ? 'imports' : 'exports'
  const direction = request.flow === 'import' ? 'from' : 'to'
  const series: FeedSeries[] = [...byPartner.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([code, observations]) => ({
      key: `comtrade:${request.reporter}:${request.flow}:${request.hs}:${partnerIso(code)}:${request.frequency}`,
      name: `${reporter.name} ${flowWord} of HS ${request.hs} ${direction} ${code === 0 ? 'the world' : partnerName(code)} (${request.frequency})`,
      unit: 'USD',
      frequency: request.frequency,
      higherIs: 'neutral' as const,
      observations: observations.sort((a, b) => a.observedAt.localeCompare(b.observedAt)),
    }))
  const breakdown = request.partner === 'ALL'
    ? request.periods.map((period) => {
      const total = clean.find((row) => String(row.period) === period && Number(row.partnerCode) === 0)
      const totalValue = total ? Number(total.primaryValue) : null
      const partners = clean.filter((row) => String(row.period) === period && Number(row.partnerCode) !== 0)
        .map((row) => ({ partner: partnerIso(Number(row.partnerCode)), name: partnerName(Number(row.partnerCode)), value: Number(row.primaryValue), share: totalValue ? Number((Number(row.primaryValue) / totalValue).toFixed(4)) : null }))
        .sort((a, b) => b.value - a.value)
        .slice(0, 15)
      return { period, total: totalValue, partners }
    })
    : undefined
  const missing = request.periods.filter((period) => !clean.some((row) => String(row.period) === period))
  return {
    feed: 'comtrade', request, publisher: key ? 'UN Comtrade (subscription API)' : 'UN Comtrade (public preview API)',
    title: `${reporter.name} ${flowWord}, HS ${request.hs}, ${request.partner === 'ALL' ? 'by partner' : request.partner === 'WLD' ? 'world total' : partnerName(partnerCode!)}, ${request.periods.join(', ')}`,
    sourceUrls: urls, retrievedAt: now.toISOString(), sourceUpdatedAt: null,
    responseSha256: sha256(chunks), reliability: RELIABILITY.comtrade, series, breakdown,
    notes: [
      'Values are the reporter\'s declared trade value in US dollars (primaryValue), all customs procedures and transport modes combined.',
      'UN Comtrade records trade with Taiwan under "Other Asia, nes" (partner code 490), shown here as TWN.',
      ...(key ? [] : ['Fetched through the keyless public preview (at most 500 rows per call); set COMTRADE_API_KEY for the full API.']),
      ...(missing.length ? [`No data yet for period(s) ${missing.join(', ')}: the reporter may not have submitted them.`] : []),
    ],
  }
}

/** The indicator id a GDELT query's series is recorded under: a readable slug plus a short hash of the query. */
export function gdeltSeriesKey(query: string, measure: 'count' | 'share'): string {
  const slug = query.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'query'
  return `gdelt:${slug}-${createHash('sha256').update(query).digest('hex').slice(0, 6)}:${measure}`
}

async function fetchGdelt(request: GdeltRequest, now: Date): Promise<FeedResult> {
  const url = new URL(`https://${HOSTS.gdelt}/api/v2/doc/doc`)
  url.searchParams.set('query', request.query)
  url.searchParams.set('mode', 'timelinevolraw')
  url.searchParams.set('format', 'json')
  url.searchParams.set('startdatetime', `${request.start.replaceAll('-', '')}000000`)
  url.searchParams.set('enddatetime', `${request.end.replaceAll('-', '')}235959`)
  const fetched = await getJson(url, { retries: 3 })
  const timeline = (fetched.json as { timeline?: { series?: string; data?: { date?: string; value?: number; norm?: number }[] }[] }).timeline
  const points = timeline?.[0]?.data ?? []
  const byDay = new Map<string, { count: number; norm: number }>()
  for (const point of points) {
    const day = /^(\d{4})(\d{2})(\d{2})/.exec(point.date ?? '')
    if (!day || typeof point.value !== 'number') continue
    const label = `${day[1]}-${day[2]}-${day[3]}`
    const entry = byDay.get(label) ?? { count: 0, norm: 0 }
    entry.count += point.value
    entry.norm += typeof point.norm === 'number' ? point.norm : 0
    byDay.set(label, entry)
  }
  const days = [...byDay.keys()].sort()
  const series: FeedSeries[] = [{
    key: gdeltSeriesKey(request.query, 'count'), name: `News articles matching "${request.query}" (GDELT)`, unit: 'articles per day', frequency: 'daily', higherIs: 'risk-off',
    observations: days.map((day) => observation(day, byDay.get(day)!.count, now)),
  }]
  if (days.some((day) => byDay.get(day)!.norm > 0)) {
    series.push({
      key: gdeltSeriesKey(request.query, 'share'), name: `Share of monitored news coverage matching "${request.query}" (GDELT)`, unit: 'percent of monitored articles', frequency: 'daily', higherIs: 'risk-off',
      observations: days.filter((day) => byDay.get(day)!.norm > 0).map((day) => observation(day, Number(((byDay.get(day)!.count / byDay.get(day)!.norm) * 100).toFixed(6)), now)),
    })
  }
  return {
    feed: 'gdelt', request, publisher: 'The GDELT Project, DOC 2.0 API',
    title: `News volume for "${request.query}", ${request.start} to ${request.end}`,
    sourceUrls: [fetched.url], retrievedAt: now.toISOString(), sourceUpdatedAt: null,
    responseSha256: sha256([fetched.bytes]), reliability: RELIABILITY.gdelt, series,
    notes: [
      'GDELT counts worldwide online news coverage; a spike means attention, not that an event happened. The share series normalises for GDELT\'s total monitored volume.',
      ...(points.length ? [] : ['GDELT returned no matching coverage for this query and window.']),
    ],
  }
}


/** Names for the IMF Primary Commodity Price System codes Battmann uses most; others show as their code. */
const COMMODITY_NAMES: Record<string, string> = {
  POILAPSP: 'Crude oil, average of Brent, Dubai and WTI', POILBRE: 'Crude oil, Brent', POILWTI: 'Crude oil, WTI', POILDUB: 'Crude oil, Dubai',
  PNGASEU: 'Natural gas, Europe (TTF)', PNGASJP: 'LNG, Asia (Japan)', PNGASUS: 'Natural gas, US (Henry Hub)', PCOALAU: 'Coal, Australia',
  PCOPP: 'Copper', PALUM: 'Aluminium', PNICK: 'Nickel', PTIN: 'Tin', PZINC: 'Zinc', PLEAD: 'Lead', PIORECR: 'Iron ore', PGOLD: 'Gold', PSILVER: 'Silver',
  PWHEAMT: 'Wheat', PMAIZMT: 'Maize', PRICENPQ: 'Rice', PSOYB: 'Soybeans', PSUGAISA: 'Sugar',
  PALLFNF: 'All commodities index', PNFUEL: 'Non-fuel commodities index', PMETA: 'Metals index', PNRG: 'Energy index', PFOOD: 'Food index',
}

function xmlAttribute(tag: string, name: string): string | undefined {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1]
}

async function fetchCommodity(request: CommodityRequest, now: Date): Promise<FeedResult> {
  const url = new URL(`https://${HOSTS.commodity}/external/sdmx/2.1/data/IMF.RES,PCPS/G001.${request.commodities.join('+')}.${request.unit}.M`)
  url.searchParams.set('startPeriod', request.start)
  const fetched = await getText(url, { accept: 'application/xml' })
  if (!fetched.text.includes('StructureSpecificData')) throw new Error(`IMF returned an unexpected response: ${fetched.text.slice(0, 200).replace(/\s+/g, ' ')}`)
  const updated = xmlAttribute(/<message:DataSet [^>]*>/.exec(fetched.text)?.[0] ?? '', 'UPDATE_DATE')
  const series: FeedSeries[] = []
  for (const block of fetched.text.split('<Series ').slice(1)) {
    const code = xmlAttribute(block.slice(0, block.indexOf('>')), 'INDICATOR')
    if (!code) continue
    const observations = [...block.matchAll(/<Obs [^>]*>/g)].flatMap(([tag]) => {
      const period = /^(\d{4})-M(\d{2})$/.exec(xmlAttribute(tag, 'TIME_PERIOD') ?? '')
      const value = Number(xmlAttribute(tag, 'OBS_VALUE'))
      return period && Number.isFinite(value) ? [observation(`${period[1]}-${period[2]}`, value, now)] : []
    }).sort((a, b) => a.observedAt.localeCompare(b.observedAt))
    series.push({
      key: `commodity:${code}:${request.unit}`, name: `${COMMODITY_NAMES[code] ?? code} (IMF, monthly ${request.unit === 'USD' ? 'price' : 'index'})`,
      unit: request.unit === 'USD' ? 'USD (IMF quotation unit)' : 'index, 2016 = 100', frequency: 'monthly', higherIs: 'neutral', observations,
    })
  }
  const missing = request.commodities.filter((code) => !series.some((item) => item.key === `commodity:${code}:${request.unit}`))
  if (!series.length) throw new Error(`IMF has no ${request.unit} series for ${request.commodities.join(', ')}; check the codes (e.g. POILAPSP, PCOPP, PTIN)`)
  return {
    feed: 'commodity', request, publisher: 'International Monetary Fund, Primary Commodity Price System',
    title: `Commodity prices: ${series.map((item) => COMMODITY_NAMES[item.key.split(':')[1]!] ?? item.key.split(':')[1]).join(', ')}, from ${request.start}`,
    sourceUrls: [fetched.url], retrievedAt: now.toISOString(),
    sourceUpdatedAt: updated && Number.isFinite(Date.parse(updated)) ? new Date(updated).toISOString() : null,
    responseSha256: sha256([fetched.bytes]), reliability: RELIABILITY.commodity, series,
    notes: [
      'Monthly averages of daily benchmark prices, in the unit the IMF quotes each commodity in (for example USD per barrel, USD per metric ton).',
      ...(missing.length ? [`No series returned for ${missing.join(', ')}.`] : []),
    ],
  }
}

let witsCountries: Promise<Map<string, string>> | undefined

/** WITS identifies countries by ISO numeric code; its own country list maps ISO3 to it. */
async function witsCountryCode(iso3: string): Promise<string> {
  if (iso3 === 'WLD') return '000'
  witsCountries ??= getText(new URL(`https://${HOSTS.tariff}/API/V1/wits/datasource/trn/country/ALL`), { accept: 'application/xml' }).then(({ text }) => {
    const map = new Map<string, string>()
    for (const match of text.matchAll(/<wits:country countrycode="([^"]+)"[^>]*isreporter="1"[^>]*>\s*<wits:iso3Code>([A-Z0-9]{3})<\/wits:iso3Code>/g)) map.set(match[2]!, match[1]!)
    return map
  })
  const map = await witsCountries.catch((error: unknown) => {
    witsCountries = undefined
    throw error
  })
  const code = map.get(iso3)
  if (!code) throw new Error(`WITS has no tariff reporter with ISO code ${iso3}`)
  return code
}

async function fetchTariff(request: TariffRequest, now: Date): Promise<FeedResult> {
  const reporter = await witsCountryCode(request.reporter)
  const partner = await witsCountryCode(request.partner).catch(() => { throw new Error(`WITS has no partner with ISO code ${request.partner}; use WLD for the MFN rate`) })
  const byProduct = new Map<string, FeedObservation[]>()
  const detail = new Map<string, string>()
  const urls: string[] = []
  const chunks: Uint8Array[] = []
  const missingYears: number[] = []
  for (const yearValue of request.years) {
    const url = new URL(`https://${HOSTS.tariff}/API/V1/SDMX/V21/datasource/TRN/reporter/${reporter}/partner/${partner}/product/${request.products.join(';')}/year/${yearValue}/datatype/reported`)
    url.searchParams.set('format', 'JSON')
    let fetched: FetchedText
    try {
      fetched = await getText(url)
    } catch (error) {
      if (/NoRecordsFound|HTTP 404/.test(error instanceof Error ? error.message : String(error))) { missingYears.push(yearValue); continue }
      throw error
    }
    if (fetched.text.includes('NoRecordsFound')) { missingYears.push(yearValue); continue }
    urls.push(fetched.url)
    chunks.push(fetched.bytes)
    const body = JSON.parse(fetched.text) as { dataSets?: { series?: Record<string, { observations?: Record<string, (number | null)[]> }> }[]; structure?: { dimensions?: { series?: { id: string; values: { id: string }[] }[] }; attributes?: { observation?: { id: string; values: { name?: string; id?: string }[] }[] } } }
    const dimensions = body.structure?.dimensions?.series ?? []
    const productValues = dimensions.find((dimension) => dimension.id === 'PRODUCTCODE')?.values ?? []
    const entries = Object.entries(body.dataSets?.[0]?.series ?? {})
    // WITS keys do not always put the product index at the position the structure declares, so use the one
    // position whose index actually varies across series (only the product does); with one series, any works.
    const keyLength = entries[0]?.[0].split(':').length ?? 0
    const spread = Array.from({ length: keyLength }, (_, position) => new Set(entries.map(([key]) => key.split(':')[position])).size)
    const declared = dimensions.findIndex((dimension) => dimension.id === 'PRODUCTCODE')
    const productPosition = Math.max(...spread, 0) > 1 ? spread.indexOf(Math.max(...spread)) : declared
    const attributes = body.structure?.attributes?.observation ?? []
    const typeIndex = attributes.findIndex((attribute) => attribute.id === 'TARIFFTYPE')
    for (const [key, series] of entries) {
      const product = productValues[Number(key.split(':')[productPosition])]?.id
      const values = series.observations?.['0']
      if (!product || !values || typeof values[0] !== 'number') continue
      const list = byProduct.get(product) ?? []
      if (list.some((item) => item.period === String(yearValue))) continue
      list.push(observation(String(yearValue), values[0], now))
      byProduct.set(product, list)
      const typeValue = typeIndex >= 0 ? values[typeIndex + 1] : null
      if (typeof typeValue === 'number') detail.set(product, attributes[typeIndex]!.values[typeValue]?.name ?? '')
    }
  }
  if (!urls.length) throw new Error(`WITS has no ${request.reporter} tariff data for ${request.years.join(', ')}; tariff schedules are published with a lag of about two years`)
  const series: FeedSeries[] = [...byProduct.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([product, observations]) => ({
    key: `tariff:${request.reporter}:${request.partner}:${product}`,
    name: `${request.reporter} tariff on HS ${product}${request.partner === 'WLD' ? '' : ` from ${request.partner}`} (${detail.get(product) || 'simple average of reported rates'})`,
    unit: '% ad valorem', frequency: 'annual', higherIs: 'risk-off', observations: observations.sort((a, b) => a.observedAt.localeCompare(b.observedAt)),
  }))
  return {
    feed: 'tariff', request, publisher: 'World Bank WITS, UNCTAD TRAINS tariff data',
    title: `${request.reporter} tariffs on HS ${request.products.join(', ')}, ${request.years.join(', ')}`,
    sourceUrls: urls, retrievedAt: now.toISOString(), sourceUpdatedAt: null,
    responseSha256: sha256(chunks), reliability: RELIABILITY.tariff, series,
    notes: [
      'Simple average of the reported ad valorem rates across the national tariff lines in each HS code; specific duties, surcharges and trade remedies are not included.',
      ...(missingYears.length ? [`No tariff data yet for ${missingYears.join(', ')}.`] : []),
    ],
  }
}

/** Fetches one feed request. Throws with a plain explanation when the source is unreachable or rejects it. */
export async function fetchFeed(request: FeedRequest): Promise<FeedResult> {
  const now = feedNow()
  switch (request.feed) {
    case 'fx': return fetchFx(request, now)
    case 'worldbank': return fetchWorldBank(request, now)
    case 'imf': return fetchImf(request, now)
    case 'comtrade': return fetchComtrade(request, now)
    case 'gdelt': return fetchGdelt(request, now)
    case 'commodity': return fetchCommodity(request, now)
    case 'tariff': return fetchTariff(request, now)
  }
}

/** Test seam: forget cached reference tables and request timestamps. */
export function resetFeedCaches(): void {
  imfCatalogue = undefined
  comtradeReference = undefined
  witsCountries = undefined
  lastRequestAt.clear()
}

/**
 * The series worth showing when a result has many (a Comtrade pull by partner has one per partner): the world
 * total first, then the largest by latest value. Everything is still recorded; this only bounds what is shown.
 */
export function leadingSeries(result: FeedResult, limit = 15): { shown: FeedSeries[]; omitted: number } {
  if (result.series.length <= limit) return { shown: result.series, omitted: 0 }
  const latest = (series: FeedSeries) => series.observations.filter((item) => item.status === 'actual').at(-1)?.value ?? -Infinity
  const world = result.series.filter((series) => series.key.includes(':WLD:'))
  const rest = result.series.filter((series) => !world.includes(series)).sort((a, b) => latest(b) - latest(a))
  const shown = [...world, ...rest].slice(0, limit)
  return { shown, omitted: result.series.length - shown.length }
}

/** A compact, human-readable account of a feed result, for the evidence excerpt and the model. */
export function describeFeedResult(result: FeedResult, maxLength = 3_500): string {
  const lines = [`${result.publisher} — ${result.title}. Retrieved ${result.retrievedAt}.`]
  for (const period of result.breakdown ?? []) {
    lines.push(`${period.period} total ${period.total === null ? 'n/a' : formatValue(period.total)}; top partners: ${period.partners.slice(0, 6).map((item) => `${item.name} ${formatValue(item.value)}${item.share === null ? '' : ` (${(item.share * 100).toFixed(1)}%)`}`).join(', ')}.`)
  }
  lines.push(...result.notes)
  const { shown, omitted } = leadingSeries(result, 10)
  for (const series of shown) {
    const actual = series.observations.filter((item) => item.status === 'actual')
    const projected = series.observations.filter((item) => item.status === 'projection')
    const tail = actual.slice(-6).map((item) => `${item.period}: ${formatValue(item.value)}`).join('; ')
    lines.push(`${series.name} [${series.unit}]: ${actual.length} observation(s)${tail ? ` — latest ${tail}` : ''}${projected.length ? `; projections ${projected.slice(0, 4).map((item) => `${item.period}: ${formatValue(item.value)}`).join('; ')}` : ''}.`)
  }
  if (omitted) lines.push(`${omitted} smaller series recorded but not listed here.`)
  const text = lines.join('\n')
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text
}

function formatValue(value: number): string {
  const absolute = Math.abs(value)
  if (absolute >= 1e9) return `${(value / 1e9).toFixed(2)}B`
  if (absolute >= 1e6) return `${(value / 1e6).toFixed(2)}M`
  return Number(value.toFixed(4)).toString()
}
