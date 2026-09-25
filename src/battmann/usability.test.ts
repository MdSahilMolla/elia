import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withAgentIdentity } from '../autonomy/context.ts'
import { battmannTool } from '../tools/battmann.ts'
import { feedTestHooks, fetchFeed, normalizeFeedRequest, resetFeedCaches } from './feeds.ts'
import { modelBoundaryTestHooks } from './modelBoundary.ts'

// Shapes a live model actually sent (Nemotron 3 Super, 2026-09-24), and what the tool now does with them.

const DAY = 86_400_000
const day = (offset: number) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10)

beforeEach(() => {
  resetFeedCaches()
  feedTestHooks.sleep = async () => {}
  modelBoundaryTestHooks.override = { ceiling: 'internal', allLocal: false, cloudRoutes: ['nvidia (test)'] }
})

afterEach(() => {
  feedTestHooks.fetch = undefined
  feedTestHooks.sleep = undefined
  modelBoundaryTestHooks.override = undefined
})

function tool(cwd: string) {
  return async (input: Record<string, unknown>) => JSON.parse(await withAgentIdentity({ name: 'test', role: 'lead', cwd }, () => battmannTool.execute(input)))
}

test('fields wrapped in a nested object are lifted, and a failure says exactly what the action takes', async () => {
  const run = tool(mkdtempSync(join(tmpdir(), 'elia-battmann-usability-')))
  const nested = await run({ action: 'register_evidence', evidence: { title: 'EU control list update', url: 'https://policy.trade.ec.europa.eu/news/x', publishedAt: '2026-09-14', retrievedAt: new Date().toISOString(), excerpt: 'Adds items.', independenceGroup: 'eu', reliability: 0.9 } })
  expect(nested.status).toBe('created')
  const failure = run({ action: 'register_evidence', evidence: { type: 'web', title: 'No dates', url: 'https://example.com' } })
  await expect(failure).rejects.toThrow('register_evidence takes flat fields: title, url, publishedAt')
})

test('feed_query returns an evidence id that a certified forecast can cite, and defaults fill the rest', async () => {
  const run = tool(mkdtempSync(join(tmpdir(), 'elia-battmann-citable-')))
  feedTestHooks.fetch = async (url) => {
    const [start, end] = url.pathname.replace('/v1/', '').split('..') as [string, string]
    const rates: Record<string, { INR: number }> = {}
    for (let t = Date.parse(`${start}T00:00:00Z`); t <= Date.parse(`${end ?? start}T00:00:00Z`); t += DAY) rates[new Date(t).toISOString().slice(0, 10)] = { INR: 95 + Math.sin(t / DAY) * 0.3 }
    return new Response(JSON.stringify({ base: 'USD', rates }), { status: 200 })
  }
  const queried = await run({ action: 'feed_query', feed: 'fx', quote: 'INR', start: day(-30), end: day(-1) })
  expect(queried.evidenceId).toMatch(/^feed:fx:/)
  expect(queried.recorded).toContain('evidence only')

  await run({ action: 'create_question', questionId: 'q', question: 'USD/INR above 95?', resolutionRule: { source: { feed: 'fx', base: 'USD', quote: 'INR' }, observation: { period: day(20) }, comparator: '>', threshold: 95 } })
  const cited = await run({ action: 'submit_forecast', questionId: 'q', probability: 0.55, method: 'judgement', rationale: 'Near the money.', evidenceIds: [queried.evidenceId] })
  expect(cited.forecaster).toBe('elia')
  // With no evidence given, the question's own feed series is attached, and the clock stamps asOf.
  const bare = await run({ action: 'submit_forecast', questionId: 'q', probability: 0.6, method: 'judgement', rationale: 'Slightly higher.', asOf: day(0) })
  expect(bare.evidenceAttached).toContain('feed:fx:')
  expect(bare.asOfSetBy).toBe('clock')
})

test('supplier_concentration reads partner shares and HHI from stored trade series', async () => {
  const run = tool(mkdtempSync(join(tmpdir(), 'elia-battmann-concentration-')))
  feedTestHooks.fetch = async (url) => {
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
    if (url.pathname.endsWith('Reporters.json')) return json({ results: [{ id: 699, text: 'India', reporterCode: 699, reporterCodeIsoAlpha3: 'IND' }] })
    if (url.pathname.endsWith('partnerAreas.json')) return json({ results: [{ id: 0, text: 'World', PartnerCode: 0, PartnerCodeIsoAlpha3: 'W00' }, { id: 156, text: 'China', PartnerCode: 156, PartnerCodeIsoAlpha3: 'CHN' }, { id: 490, text: 'Other Asia, nes', PartnerCode: 490, PartnerCodeIsoAlpha3: 'S19' }] })
    const row = (partnerCode: number, primaryValue: number) => ({ period: '2025', partnerCode, partner2Code: 0, customsCode: 'C00', motCode: 0, cmdCode: '8542', flowCode: 'M', primaryValue })
    return json({ data: [row(0, 100), row(156, 60), row(490, 40)] })
  }
  await run({ action: 'ingest_feed', feed: 'comtrade', reporter: 'IND', hs: '8542', periods: ['2025'] })
  const result = await run({ action: 'supplier_concentration' })
  const [group] = result.groups
  expect(group.period).toBe('2025')
  expect(group.topPartners.map((partner: { name: string; share: number }) => [partner.name, partner.share])).toEqual([['China', 0.6], ['Other Asia, nes (Taiwan)', 0.4]])
  expect(group.hhi).toBe(5200)
  expect(group.hhiBand).toBe('highly concentrated')
})

test('commodity prices are read from the IMF SDMX XML, and WITS tariffs from the key position that varies', async () => {
  feedTestHooks.fetch = async (url) => {
    if (url.hostname === 'api.imf.org') return new Response('<message:StructureSpecificData><message:DataSet UPDATE_DATE="2026-09-08T18:42:56Z"><Series COUNTRY="G001" INDICATOR="PCOPP" DATA_TRANSFORMATION="USD" FREQUENCY="M"><Obs TIME_PERIOD="2026-M07" OBS_VALUE="13900.5"/><Obs TIME_PERIOD="2026-M08" OBS_VALUE="14331.26"/></Series></message:DataSet></message:StructureSpecificData>', { status: 200 })
    if (url.pathname.includes('/country/ALL')) return new Response('<wits:country countrycode="356" isreporter="1" ispartner="1" isgroup="No"><wits:iso3Code>IND</wits:iso3Code></wits:country>', { status: 200 })
    if (url.pathname.includes('/year/2024/')) return new Response('{}Not Found - NoRecordsFound', { status: 404 })
    // As WITS serves it: the product index sits at key position 2, not the declared position 3.
    return new Response(JSON.stringify({ dataSets: [{ series: { '0:0:0:0:0': { observations: { 0: [25, 0, null, 0] } }, '0:0:1:0:0': { observations: { 0: [0, 0, null, 0] } } } }], structure: { dimensions: { series: [{ id: 'FREQ', values: [{ id: 'A' }] }, { id: 'REPORTER', values: [{ id: '356' }] }, { id: 'PARTNER', values: [{ id: '000' }] }, { id: 'PRODUCTCODE', values: [{ id: '854142' }, { id: '854231' }] }, { id: 'DATATYPE', values: [{ id: 'Reported' }] }] }, attributes: { observation: [{ id: 'NOMENCODE', values: [{ id: 'H6' }] }, { id: 'EXCLUDEDFROM', values: [] }, { id: 'TARIFFTYPE', values: [{ name: 'Most Favoured Nation Tariff' }] }] } } }), { status: 200 })
  }
  const copper = await fetchFeed(normalizeFeedRequest({ feed: 'commodity', commodity: 'pcopp', start: '2026-07' }))
  expect(copper.series[0]!.key).toBe('commodity:PCOPP:USD')
  expect(copper.series[0]!.observations.map((item) => [item.period, item.value])).toEqual([['2026-07', 13900.5], ['2026-08', 14331.26]])
  expect(copper.sourceUpdatedAt).toBe('2026-09-08T18:42:56.000Z')

  const tariffs = await fetchFeed(normalizeFeedRequest({ feed: 'tariff', reporter: 'IND', products: ['854231', '854142'], years: [2023, 2024] }))
  expect(tariffs.series.map((series) => [series.key, series.observations.map((item) => item.value)])).toEqual([['tariff:IND:WLD:854142', [25]], ['tariff:IND:WLD:854231', [0]]])
  expect(tariffs.series[0]!.name).toContain('Most Favoured Nation Tariff')
  expect(tariffs.notes.join(' ')).toContain('No tariff data yet for 2024')
})

test('an artifact call with no outputPath writes to its default, and the governor assesses that same path', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'elia-battmann-defaults-'))
  const run = tool(cwd)
  await run({ action: 'register_evidence', evidenceId: 'e1', title: 'Source', url: 'https://example.com/s', publishedAt: '2026-01-01', retrievedAt: '2026-01-02', excerpt: 'Text.', independenceGroup: 'x', reliability: 0.9 })
  const dashboard = await run({ action: 'dashboard' })
  expect(dashboard.dashboardPath.replaceAll('\\', '/').endsWith('.elia/artifacts/battmann-dashboard.html')).toBe(true)
  const report = await run({ action: 'report_from_store', title: 'Brief', executiveSummary: 'Summary.', author: 'elia battmann' })
  expect(report.reportPath.replaceAll('\\', '/').endsWith('.elia/artifacts/battmann-report.md')).toBe(true)
  const { assessAction } = await import('../autonomy/governor.ts')
  expect(assessAction({ name: 'battmann', input: { action: 'dashboard' } }, cwd).risk).toBe('review')
})

test('a bare-date asOf means that day up to now, so evidence retrieved earlier today can be cited', async () => {
  const run = tool(mkdtempSync(join(tmpdir(), 'elia-battmann-asof-')))
  await run({ action: 'register_evidence', evidenceId: 'today', title: 'Fresh source', url: 'https://example.com/today', publishedAt: day(-1), retrievedAt: new Date(Date.now() - 60_000).toISOString(), excerpt: 'Text.', independenceGroup: 'x', reliability: 0.9 })
  const claim = await run({ action: 'register_claim', statement: 'Something observed today.', classification: 'observed_fact', confidence: 'high', asOf: day(0), evidenceLinks: [{ evidenceId: 'today', relation: 'supports', supportingExcerpt: 'Text.' }] })
  expect(claim.status).toBe('created')
  const listed = await run({ action: 'list_claims' })
  expect(listed.claims.map((item: { id: string; evidenceIds: string[]; review: string }) => [item.id, item.evidenceIds, item.review])).toEqual([[claim.claimId, ['today'], 'unreviewed']])
})

test('a forecast that copies the baseline is recorded with a note saying it cannot show skill', async () => {
  const run = tool(mkdtempSync(join(tmpdir(), 'elia-battmann-copy-')))
  feedTestHooks.fetch = async (url) => {
    const [start, end] = url.pathname.replace('/v1/', '').split('..') as [string, string]
    const rates: Record<string, { INR: number }> = {}
    for (let t = Date.parse(`${start}T00:00:00Z`); t <= Date.parse(`${end ?? start}T00:00:00Z`); t += DAY) rates[new Date(t).toISOString().slice(0, 10)] = { INR: 95 + Math.sin(t / DAY) * 0.3 }
    return new Response(JSON.stringify({ base: 'USD', rates }), { status: 200 })
  }
  const created = await run({ action: 'create_question', questionId: 'q', question: 'USD/INR above 95.2?', resolutionRule: { source: { feed: 'fx', base: 'USD', quote: 'INR' }, observation: { period: day(20) }, comparator: '>', threshold: 95.2 } })
  const copied = await run({ action: 'submit_forecast', questionId: 'q', probability: created.baseline.probability, method: 'copied', rationale: 'Same as baseline.' })
  expect(copied.note).toContain('copies the baseline cannot show skill')
  const own = await run({ action: 'submit_forecast', questionId: 'q', probability: Math.min(0.95, created.baseline.probability + 0.2), method: 'judgement', rationale: 'Evidence points higher.' })
  expect(own.note).toBeUndefined()
})
