import { afterEach, beforeEach, expect, test } from 'bun:test'
import { describeFeedResult, feedRequestKey, feedTestHooks, fetchFeed, normalizeFeedRequest, periodEnd, resetFeedCaches } from './feeds.ts'

// Fixtures follow the real response shapes, captured from each API on 2026-09-24/25.
const NOW = new Date('2026-09-25T12:00:00Z')
let requests: { url: URL; headers: Record<string, string> }[] = []

function serve(handler: (url: URL) => unknown | Response): void {
  feedTestHooks.fetch = async (url, headers) => {
    requests.push({ url, headers })
    const result = handler(url)
    return result instanceof Response ? result : new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } })
  }
}

beforeEach(() => {
  requests = []
  resetFeedCaches()
  feedTestHooks.now = () => NOW
  feedTestHooks.sleep = async () => {}
})

afterEach(() => {
  feedTestHooks.fetch = undefined
  feedTestHooks.now = undefined
  feedTestHooks.sleep = undefined
  delete process.env.COMTRADE_API_KEY
})

test('requests are validated and defaulted into an exact, reproducible form', () => {
  expect(normalizeFeedRequest({ feed: 'fx', quote: 'inr' }, NOW)).toEqual({ feed: 'fx', base: 'USD', quotes: ['INR'], start: '2025-09-25', end: '2026-09-25' })
  expect(normalizeFeedRequest({ feed: 'comtrade', reporter: 'ind', hs: '8542' }, NOW)).toEqual({ feed: 'comtrade', reporter: 'IND', partner: 'ALL', hs: '8542', flow: 'import', frequency: 'annual', periods: ['2025'] })
  expect(() => normalizeFeedRequest({ feed: 'fx', quote: 'USD' }, NOW)).toThrow('must differ')
  expect(() => normalizeFeedRequest({ feed: 'worldbank', country: 'IND', indicator: 'x/../../evil' }, NOW)).toThrow('indicator')
  expect(() => normalizeFeedRequest({ feed: 'comtrade', reporter: 'IND', hs: '85a2' }, NOW)).toThrow('HS code')
  expect(() => normalizeFeedRequest({ feed: 'gdelt', query: 'taiwan', start: '2026-01-01' }, NOW)).toThrow('90 days')
  expect(() => normalizeFeedRequest({ feed: 'weather' }, NOW)).toThrow('feed must be one of')
  // Subscriptions are keyed without their window, so a rolled-forward refresh is the same subscription.
  expect(feedRequestKey(normalizeFeedRequest({ feed: 'fx', quote: 'INR', start: '2026-01-01' }, NOW))).toBe(feedRequestKey(normalizeFeedRequest({ feed: 'fx', quote: 'INR' }, NOW)))
})

test('period labels map to the end of the period they name', () => {
  expect(periodEnd('2025')).toBe('2025-12-31T00:00:00.000Z')
  expect(periodEnd('202602')).toBe('2026-02-28T00:00:00.000Z')
  expect(periodEnd('2025M06')).toBe('2025-06-30T00:00:00.000Z')
  expect(periodEnd('2025Q3')).toBe('2025-09-30T00:00:00.000Z')
  expect(periodEnd('2026-09-24')).toBe('2026-09-24T00:00:00.000Z')
})

test('fx reads ECB reference rates per quote and hashes the raw response', async () => {
  serve(() => ({ amount: 1, base: 'USD', start_date: '2026-09-17', end_date: '2026-09-24', rates: { '2026-09-17': { INR: 95.94, KRW: 1382.55 }, '2026-09-18': { INR: 95.88, KRW: 1388.1 }, '2026-09-24': { INR: 95.96, KRW: 1368.6 } } }))
  const result = await fetchFeed(normalizeFeedRequest({ feed: 'fx', quotes: ['INR', 'KRW'], start: '2026-09-17', end: '2026-09-24' }, NOW))
  expect(requests[0]!.url.toString()).toBe('https://api.frankfurter.dev/v1/2026-09-17..2026-09-24?base=USD&symbols=INR%2CKRW')
  expect(result.series.map((series) => series.key)).toEqual(['fx:USD:INR', 'fx:USD:KRW'])
  expect(result.series[0]!.observations.at(-1)).toEqual({ period: '2026-09-24', observedAt: '2026-09-24T00:00:00.000Z', value: 95.96, status: 'actual' })
  expect(result.responseSha256).toMatch(/^[0-9a-f]{64}$/)
  expect(result.notes.join(' ')).toContain('cross rates')
})

test('world bank errors are reported, and missing years are noted rather than invented', async () => {
  serve(() => [{ message: [{ id: '120', key: 'Invalid value', value: 'The provided parameter value is not valid' }] }])
  await expect(fetchFeed(normalizeFeedRequest({ feed: 'worldbank', country: 'IND', indicator: 'NOPE.X' }, NOW))).rejects.toThrow('not valid')

  serve(() => [{ page: 1, pages: 1, lastupdated: '2026-07-13' }, [
    { indicator: { value: 'GDP growth (annual %)' }, country: { value: 'India' }, date: '2025', value: 7.5667, unit: '' },
    { indicator: { value: 'GDP growth (annual %)' }, country: { value: 'India' }, date: '2024', value: 7.0993, unit: '' },
    { indicator: { value: 'GDP growth (annual %)' }, country: { value: 'India' }, date: '2026', value: null, unit: '' },
  ]])
  const result = await fetchFeed(normalizeFeedRequest({ feed: 'worldbank', country: 'IND', indicator: 'NY.GDP.MKTP.KD.ZG', startYear: 2024, endYear: 2026 }, NOW))
  expect(result.series[0]!.key).toBe('wb:IND:NY.GDP.MKTP.KD.ZG')
  expect(result.series[0]!.unit).toBe('annual %')
  expect(result.series[0]!.observations.map((item) => item.period)).toEqual(['2024', '2025'])
  expect(result.sourceUpdatedAt).toBe('2026-07-13T00:00:00.000Z')
  expect(result.notes.join(' ')).toContain('no value yet')
})

test('imf values from the current year on are labelled projections', async () => {
  serve((url) => url.pathname.endsWith('/indicators')
    ? { indicators: { NGDP_RPCH: { label: 'Real GDP growth', unit: 'Annual percent change', source: 'World Economic Outlook (April 2026)', 'last-modified': '2026-04-08 16:07:34' } } }
    : { values: { NGDP_RPCH: { IND: { 2024: 7.1, 2025: 7.6, 2026: 6.5, 2027: 6.5 }, CHN: { 2025: 5 } } } })
  const result = await fetchFeed(normalizeFeedRequest({ feed: 'imf', country: 'IND', indicator: 'ngdp_rpch' }, NOW))
  expect(result.series[0]!.observations.map((item) => [item.period, item.status])).toEqual([['2024', 'actual'], ['2025', 'actual'], ['2026', 'projection'], ['2027', 'projection']])
  expect(result.publisher).toContain('April 2026')
  await expect(fetchFeed(normalizeFeedRequest({ feed: 'imf', country: 'IND', indicator: 'NOPE' }, NOW))).rejects.toThrow('has no indicator')
})

const REPORTERS = { results: [{ id: 699, text: 'India', reporterCode: 699, reporterCodeIsoAlpha3: 'IND', isGroup: false }, { id: 280, text: 'Fed. Rep. of Germany (...1990)', reporterCode: 280, reporterCodeIsoAlpha3: 'DEU', entryExpiredDate: '1990-12-31T00:00:00' }] }
const PARTNERS = { results: [
  { id: 0, text: 'World', PartnerCode: 0, PartnerCodeIsoAlpha3: 'W00', isGroup: true },
  { id: 156, text: 'China', PartnerCode: 156, PartnerCodeIsoAlpha3: 'CHN', isGroup: false },
  { id: 490, text: 'Other Asia, nes', PartnerCode: 490, PartnerCodeIsoAlpha3: 'S19', isGroup: false },
  { id: 410, text: 'Rep. of Korea', PartnerCode: 410, PartnerCodeIsoAlpha3: 'KOR', isGroup: false },
] }
const row = (partnerCode: number, primaryValue: number, extra: Record<string, unknown> = {}) => ({ period: '2025', partnerCode, partner2Code: 0, customsCode: 'C00', motCode: 0, cmdCode: '8542', flowCode: 'M', primaryValue, ...extra })

test('comtrade maps ISO codes, keeps only totals, and breaks a period down by partner', async () => {
  serve((url) => url.pathname.endsWith('Reporters.json') ? REPORTERS : url.pathname.endsWith('partnerAreas.json') ? PARTNERS : {
    count: 5,
    data: [row(0, 28_616_482_893.97), row(156, 11_710_232_694.19), row(490, 8_046_184_379.77), row(410, 4_580_707_625.56), row(156, 1, { motCode: 1000 })],
  })
  const result = await fetchFeed(normalizeFeedRequest({ feed: 'comtrade', reporter: 'IND', hs: '8542', periods: ['2025'] }, NOW))
  const dataRequest = requests.find((request) => request.url.pathname.includes('/preview/'))!
  expect(dataRequest.url.searchParams.get('reporterCode')).toBe('699')
  expect(dataRequest.url.searchParams.has('partnerCode')).toBe(false)
  expect(result.series.map((series) => series.key)).toContain('comtrade:IND:import:8542:TWN:annual')
  expect(result.breakdown![0]!.total).toBe(28_616_482_893.97)
  expect(result.breakdown![0]!.partners[0]).toEqual({ partner: 'CHN', name: 'China', value: 11_710_232_694.19, share: 0.4092 })
  expect(result.breakdown![0]!.partners[1]!.name).toBe('Other Asia, nes (Taiwan)')
  expect(describeFeedResult(result)).toContain('China 11.71B (40.9%)')
})

test('a comtrade key travels in a header and never in the recorded URL', async () => {
  process.env.COMTRADE_API_KEY = 'secret-subscription-key'
  serve((url) => url.pathname.endsWith('Reporters.json') ? REPORTERS : url.pathname.endsWith('partnerAreas.json') ? PARTNERS : { data: [row(156, 5)] })
  const result = await fetchFeed(normalizeFeedRequest({ feed: 'comtrade', reporter: 'IND', partner: 'CHN', hs: '8542', periods: ['2025'] }, NOW))
  const dataRequest = requests.find((request) => request.url.pathname.includes('/data/v1/get/'))!
  expect(dataRequest.headers['Ocp-Apim-Subscription-Key']).toBe('secret-subscription-key')
  expect(result.sourceUrls.join(' ')).not.toContain('secret')
  expect(result.publisher).toContain('subscription')
})

test('gdelt aggregates to days and derives a coverage share when GDELT supplies the norm', async () => {
  serve(() => ({ timeline: [{ series: 'Article Count', data: [
    { date: '20260901T000000Z', value: 10, norm: 1000 }, { date: '20260901T120000Z', value: 5, norm: 1000 }, { date: '20260902T000000Z', value: 30, norm: 2000 },
  ] }] }))
  const result = await fetchFeed(normalizeFeedRequest({ feed: 'gdelt', query: 'taiwan semiconductor', start: '2026-09-01', end: '2026-09-02' }, NOW))
  const [count, share] = result.series
  expect(count!.observations.map((item) => item.value)).toEqual([15, 30])
  expect(share!.observations.map((item) => item.value)).toEqual([0.75, 1.5])
  expect(requests[0]!.url.searchParams.get('startdatetime')).toBe('20260901000000')
})

test('rate limits are retried, redirects and foreign hosts are refused', async () => {
  let calls = 0
  serve(() => (++calls < 3 ? new Response('Please limit requests', { status: 429 }) : { amount: 1, base: 'USD', rates: { '2026-09-24': { INR: 95.96 } } }))
  const result = await fetchFeed(normalizeFeedRequest({ feed: 'fx', quote: 'INR', start: '2026-09-24', end: '2026-09-24' }, NOW))
  expect(calls).toBe(3)
  expect(result.series[0]!.observations).toHaveLength(1)

  serve(() => new Response('', { status: 429 }))
  await expect(fetchFeed(normalizeFeedRequest({ feed: 'fx', quote: 'INR' }, NOW))).rejects.toThrow('rate limited')

  serve(() => new Response(null, { status: 301, headers: { location: 'https://evil.example/' } }))
  await expect(fetchFeed(normalizeFeedRequest({ feed: 'fx', quote: 'INR' }, NOW))).rejects.toThrow('never follow redirects')
})
