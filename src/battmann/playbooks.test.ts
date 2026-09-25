import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withAgentIdentity } from '../autonomy/context.ts'
import { feedTestHooks, resetFeedCaches, type FeedRequest } from './feeds.ts'
import { rollForward } from './monitor.ts'
import { PLAYBOOKS, seedPlaybook } from './playbooks.ts'
import { executeBattmannStoreAction } from './store.ts'

const DAY = 86_400_000

/** One stub for every feed host, shaped like the real responses. */
function serveAll(options: { gdeltDown?: boolean } = {}): void {
  feedTestHooks.fetch = async (url) => {
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
    if (url.hostname === 'api.frankfurter.dev') {
      const [start, end] = url.pathname.replace('/v1/', '').split('..') as [string, string]
      const rates: Record<string, Record<string, number>> = {}
      for (let t = Date.parse(`${start}T00:00:00Z`); t <= Date.parse(`${end}T00:00:00Z`); t += DAY) {
        const day = new Date(t)
        if ([0, 6].includes(day.getUTCDay())) continue
        const wobble = Math.sin(t / DAY / 7) * 0.01
        rates[day.toISOString().slice(0, 10)] = { INR: 95 * (1 + wobble), CNY: 6.7 * (1 + wobble), KRW: 1370 * (1 + wobble), JPY: 150 * (1 + wobble) }
      }
      return json({ amount: 1, base: 'USD', rates })
    }
    if (url.hostname === 'api.worldbank.org') {
      const indicator = url.pathname.split('/').at(-1)!
      return json([{ page: 1, lastupdated: '2026-07-13' }, Array.from({ length: 15 }, (_, index) => ({ indicator: { value: `${indicator} (annual %)` }, country: { value: 'India' }, date: String(2011 + index), value: 5 + (index % 4), unit: '' }))])
    }
    if (url.hostname === 'www.imf.org') {
      if (url.pathname.endsWith('/indicators')) return json({ indicators: { NGDP_RPCH: { label: 'Real GDP growth', unit: 'Annual percent change', source: 'World Economic Outlook (April 2026)' } } })
      return json({ values: { NGDP_RPCH: { IND: { 2024: 7.1, 2025: 7.6, 2026: 6.5 }, TWN: { 2024: 4.8, 2025: 3.7, 2026: 2.9 } } } })
    }
    if (url.hostname === 'comtradeapi.un.org') {
      if (url.pathname.endsWith('Reporters.json')) return json({ results: [{ id: 699, text: 'India', reporterCode: 699, reporterCodeIsoAlpha3: 'IND' }] })
      if (url.pathname.endsWith('partnerAreas.json')) return json({ results: [{ id: 0, text: 'World', PartnerCode: 0, PartnerCodeIsoAlpha3: 'W00' }, { id: 156, text: 'China', PartnerCode: 156, PartnerCodeIsoAlpha3: 'CHN' }, { id: 490, text: 'Other Asia, nes', PartnerCode: 490, PartnerCodeIsoAlpha3: 'S19' }, { id: 410, text: 'Rep. of Korea', PartnerCode: 410, PartnerCodeIsoAlpha3: 'KOR' }] })
      const period = url.searchParams.get('period')!
      const scale = period.length === 4 ? (Number(period) - 2019) : 0.2
      const cmd = url.searchParams.get('cmdCode')!
      const partner = url.searchParams.get('partnerCode')
      const row = (partnerCode: number, value: number) => ({ period, partnerCode, partner2Code: 0, customsCode: 'C00', motCode: 0, cmdCode: cmd, flowCode: 'M', primaryValue: value * scale })
      const rows = [row(0, 5e9), row(156, 2e9), row(490, 1.4e9), row(410, 8e8)]
      return json({ data: partner === null ? rows : rows.filter((item) => String(item.partnerCode) === partner) })
    }
    if (url.hostname === 'api.imf.org') {
      const codes = url.pathname.split('/').at(-1)!.split('.')[1]!.split('+')
      const obs = Array.from({ length: 36 }, (_, index) => { const date = new Date(Date.UTC(2023, 8 + index, 1)); return `<Obs TIME_PERIOD="${date.getUTCFullYear()}-M${String(date.getUTCMonth() + 1).padStart(2, '0')}" OBS_VALUE="${100 + index}"/>` }).join('')
      return new Response(`<message:StructureSpecificData><message:DataSet UPDATE_DATE="2026-09-08T18:42:56Z">${codes.map((code) => `<Series COUNTRY="G001" INDICATOR="${code}" DATA_TRANSFORMATION="USD" FREQUENCY="M">${obs}</Series>`).join('')}</message:DataSet></message:StructureSpecificData>`, { status: 200 })
    }
    if (url.hostname === 'wits.worldbank.org') {
      if (url.pathname.includes('/country/ALL')) return new Response('<wits:country countrycode="356" isreporter="1" ispartner="1" isgroup="No"><wits:iso3Code>IND</wits:iso3Code></wits:country>', { status: 200 })
      const products = url.pathname.split('/product/')[1]!.split('/')[0]!.split(';')
      return json({ dataSets: [{ series: Object.fromEntries(products.map((_, index) => [`0:0:${index}:0:0`, { observations: { 0: [index * 5, 0, null, 0] } }])) }], structure: { dimensions: { series: [{ id: 'FREQ', values: [{ id: 'A' }] }, { id: 'REPORTER', values: [{ id: '356' }] }, { id: 'PARTNER', values: [{ id: '000' }] }, { id: 'PRODUCTCODE', values: products.map((id) => ({ id })) }, { id: 'DATATYPE', values: [{ id: 'Reported' }] }] }, attributes: { observation: [{ id: 'NOMENCODE', values: [{ id: 'H6' }] }, { id: 'EXCLUDEDFROM', values: [] }, { id: 'TARIFFTYPE', values: [{ name: 'Most Favoured Nation Tariff' }] }] } } })
    }
    if (options.gdeltDown) return new Response('Please limit requests to one every 5 seconds', { status: 429 })
    return json({ timeline: [{ data: [{ date: '20260901T000000Z', value: 10, norm: 1000 }] }] })
  }
}

beforeEach(() => {
  resetFeedCaches()
  feedTestHooks.sleep = async () => {}
})

afterEach(() => {
  feedTestHooks.fetch = undefined
  feedTestHooks.sleep = undefined
})

test('seeding india-semiconductors records every feed and opens near-the-money certified questions with baselines', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'elia-battmann-playbook-'))
  serveAll({ gdeltDown: true })
  const lines: string[] = []
  const result = await withAgentIdentity({ name: 'operator', role: 'lead', cwd }, () => seedPlaybook(PLAYBOOKS['india-semiconductors']!, {}, (line) => lines.push(line)))
  const feeds = result.feeds as { feed: string; ok: boolean; error?: string }[]
  // An unreachable source is reported, never papered over.
  expect(feeds.filter((feed) => !feed.ok).map((feed) => feed.feed)).toEqual(['gdelt', 'gdelt'])
  expect(feeds.find((feed) => !feed.ok)!.error).toContain('rate limited')
  const questions = result.questions as { questionId: string; status: string; baseline: unknown }[]
  expect(questions.every((question) => question.status === 'opened')).toBe(true)
  expect(questions.map((question) => question.questionId)).toContain(`ind-semis:ic-imports-twn-${new Date().getUTCFullYear()}`)
  // Every question with a daily or annual observation gets a numeric baseline at opening.
  expect(questions.filter((question) => typeof question.baseline === 'number')).toHaveLength(questions.length)

  const listed = await withAgentIdentity({ name: 'operator', role: 'lead', cwd }, async () => JSON.parse(executeBattmannStoreAction({ action: 'list_questions' })) as { questions: { id: string; question: string; resolutionRule: { threshold: number } }[] })
  const inr = listed.questions.find((question) => question.id.startsWith('ind-semis:usdinr-'))!
  expect(inr.resolutionRule.threshold).toBeGreaterThan(90)
  expect(inr.resolutionRule.threshold).toBeLessThan(100)

  // Re-seeding keeps what is open instead of duplicating it.
  const again = await withAgentIdentity({ name: 'operator', role: 'lead', cwd }, () => seedPlaybook(PLAYBOOKS['india-semiconductors']!, {}))
  expect((again.questions as { status: string }[]).every((question) => question.status === 'already open')).toBe(true)
})

test('a subscription rolls its window forward to today and keeps its length', () => {
  const now = new Date('2026-09-25T12:00:00Z')
  expect(rollForward({ feed: 'fx', base: 'USD', quotes: ['INR'], start: '2025-06-01', end: '2025-06-11' }, now)).toMatchObject({ start: '2026-09-15', end: '2026-09-25' })
  expect(rollForward({ feed: 'worldbank', country: 'IND', indicator: 'X', startYear: 2000, endYear: 2010 }, now)).toMatchObject({ startYear: 2016, endYear: 2026 })
  expect((rollForward({ feed: 'comtrade', reporter: 'IND', partner: 'ALL', hs: '8542', flow: 'import', frequency: 'annual', periods: ['2019', '2020'] }, now) as Extract<FeedRequest, { feed: 'comtrade' }>).periods).toEqual(['2024', '2025'])
  expect((rollForward({ feed: 'comtrade', reporter: 'IND', partner: 'WLD', hs: '8542', flow: 'import', frequency: 'monthly', periods: ['202501', '202502', '202503'] }, now) as Extract<FeedRequest, { feed: 'comtrade' }>).periods).toEqual(['202606', '202607', '202608'])
})
