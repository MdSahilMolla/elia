import { fetchFeed, normalizeFeedRequest, type FeedRequest } from './feeds.ts'
import { openRuleQuestion } from './monitor.ts'
import { executeBattmannStoreAction, readIndicatorReadings, recordFeedResult } from './store.ts'

/**
 * Playbooks: a named monitoring setup — which feeds to subscribe to, which certified questions to open — and
 * the brief the Battmann agent writes from it. `india-semiconductors` is the platform's first worked example:
 * the Government of India watching its semiconductor import dependence.
 *
 * Seeding is deterministic and model-free. Question thresholds are derived from the latest code-fetched value
 * at seeding time, so they are near the money rather than chosen to be easy, and each is paired with the
 * statistical baseline straight away.
 */

type Row = Record<string, unknown>

export interface Playbook {
  id: string
  title: string
  feeds: (now: Date) => Row[]
  questions: (latest: (key: string) => number | undefined, now: Date) => Row[]
  brief: string
}

const round = (value: number, places: number) => Number(value.toFixed(places))

/** The next weekday on or after a date, as YYYY-MM-DD (the ECB publishes on business days). */
function weekdayOnOrAfter(date: Date): string {
  const next = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  while ([0, 6].includes(next.getUTCDay())) next.setUTCDate(next.getUTCDate() + 1)
  return next.toISOString().slice(0, 10)
}

const INDIA_SEMICONDUCTORS: Playbook = {
  id: 'india-semiconductors',
  title: 'India semiconductor import dependence',
  feeds: (now) => {
    const lastYear = now.getUTCFullYear() - 1
    const years = Array.from({ length: 5 }, (_, index) => String(lastYear - 4 + index))
    const months = Array.from({ length: 4 }, (_, index) => {
      const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5 + index, 1))
      return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}`
    })
    return [
      { feed: 'comtrade', reporter: 'IND', partner: 'ALL', hs: '8542', flow: 'import', frequency: 'annual', periods: years },
      { feed: 'comtrade', reporter: 'IND', partner: 'ALL', hs: '8541', flow: 'import', frequency: 'annual', periods: [String(lastYear)] },
      { feed: 'comtrade', reporter: 'IND', partner: 'WLD', hs: '8542', flow: 'import', frequency: 'monthly', periods: months },
      { feed: 'fx', base: 'USD', quotes: ['INR', 'CNY', 'KRW', 'JPY'] },
      { feed: 'worldbank', country: 'IND', indicator: 'NY.GDP.MKTP.KD.ZG' },
      { feed: 'worldbank', country: 'IND', indicator: 'TM.VAL.MRCH.CD.WT' },
      { feed: 'worldbank', country: 'IND', indicator: 'TX.VAL.TECH.CD' },
      { feed: 'imf', country: 'IND', indicator: 'NGDP_RPCH' },
      { feed: 'imf', country: 'TWN', indicator: 'NGDP_RPCH' },
      { feed: 'gdelt', query: '(taiwan OR "taiwan strait") semiconductor' },
      { feed: 'gdelt', query: 'semiconductor "export controls"' },
    ]
  },
  questions: (latest, now) => {
    const year = now.getUTCFullYear()
    const soon = weekdayOnOrAfter(new Date(now.getTime() + 14 * 86_400_000))
    const month = weekdayOnOrAfter(new Date(now.getTime() + 35 * 86_400_000))
    const quarter = weekdayOnOrAfter(new Date(now.getTime() + 95 * 86_400_000))
    const questions: Row[] = []
    const fx = (quote: string, day: string, move: number, places: number) => {
      const value = latest(`fx:USD:${quote}`)
      if (value === undefined) return
      const threshold = round(value * (1 + move), places)
      questions.push({
        questionId: `ind-semis:usd${quote.toLowerCase()}-${day}`,
        question: `Will the ECB USD/${quote} reference rate on ${day} be above ${threshold}?`,
        domain: 'financial', tags: ['india-semiconductors', 'fx'],
        resolutionRule: { source: { feed: 'fx', base: 'USD', quote }, observation: { period: day }, comparator: '>', threshold },
      })
    }
    fx('INR', soon, 0.004, 2)
    fx('INR', month, 0.008, 2)
    fx('INR', quarter, 0.015, 2)
    fx('CNY', month, 0, 4)
    fx('KRW', month, 0.01, 1)
    const trade = (partner: string, label: string, growth: number) => {
      const value = latest(`comtrade:IND:import:8542:${partner}:annual`)
      if (value === undefined) return
      const threshold = Math.round(value * (1 + growth))
      questions.push({
        questionId: `ind-semis:ic-imports-${partner.toLowerCase()}-${year}`,
        question: `Will India's ${year} imports of integrated circuits (HS 8542) from ${label} exceed $${(threshold / 1e9).toFixed(2)}B, as reported to UN Comtrade?`,
        domain: 'trade', tags: ['india-semiconductors', 'comtrade'],
        resolutionRule: { source: { feed: 'comtrade', reporter: 'IND', partner, hs: '8542', flow: 'import', frequency: 'annual' }, observation: { period: String(year) }, comparator: '>', threshold },
      })
    }
    trade('WLD', 'the world', 0.2)
    trade('CHN', 'China', 0.1)
    trade('TWN', 'Taiwan ("Other Asia, nes")', 0.1)
    trade('KOR', 'South Korea', 0.1)
    const growth = latest('wb:IND:NY.GDP.MKTP.KD.ZG')
    if (growth !== undefined) questions.push({
      questionId: `ind-semis:gdp-growth-${year}`,
      question: `Will India's real GDP growth for ${year} exceed 6.5%, as published by the World Bank?`,
      domain: 'macro', tags: ['india-semiconductors', 'worldbank'],
      resolutionRule: { source: { feed: 'worldbank', country: 'IND', indicator: 'NY.GDP.MKTP.KD.ZG' }, observation: { period: String(year) }, comparator: '>', threshold: 6.5 },
    })
    return questions
  },
  brief: `Write the India semiconductor supply-risk brief: the Government of India is monitoring its semiconductor imports and wants to prepare before a disruption, not after.

The Battmann store already holds code-fetched data for this (provenance "feed"): UN Comtrade India imports of integrated circuits (HS 8542) by partner for five years and by month, discrete semiconductors (HS 8541), USD against INR/CNY/KRW/JPY, World Bank and IMF indicators, GDELT news-volume series where GDELT was reachable, and open certified questions each paired with a statistical baseline.

1. Read the picture: battmann list_feeds, list_indicators, list_questions, and indicator_series or feed_query for the series you use. Use the Comtrade partner breakdown for concentration (who supplies what share).
2. Re-confirm the current situation from recent primary reporting (last 30 days): export controls on chips and tools, the Taiwan Strait, shipping disruptions, memory and chip prices, and India's own semiconductor programme. Register what you rely on with register_evidence.
3. Submit a live forecast on every open certified question (submit_forecast, forecastClass live, asOf now), citing feed evidence and your own. Where you differ from the baseline, say why in the rationale.
4. Build the analysis with the deterministic tools: risk_assessment for a supply-disruption risk score from dated factors; consequence_chain for second- and third-order effects on Indian industries; alternatives to rank alternative supplier countries using the Comtrade values and shares.
5. Register the key judgements as claims, then write report_from_store (draft) to .elia/artifacts/india-semiconductors.md and the dashboard to .elia/artifacts/battmann-dashboard.html.

Label every number as feed data, calculation, model estimate, or judgement, with its date. Never invent a figure; if something is missing, say so.`,
}

export const PLAYBOOKS: Record<string, Playbook> = { [INDIA_SEMICONDUCTORS.id]: INDIA_SEMICONDUCTORS }

export interface SeedProgress { (line: string): void }

/** Subscribes the playbook's feeds and opens its certified questions. Safe to re-run: existing questions are kept. */
export async function seedPlaybook(playbook: Playbook, input: Row, progress: SeedProgress = () => {}): Promise<Row> {
  const now = new Date()
  const feeds: Row[] = []
  for (const raw of playbook.feeds(now)) {
    let request: FeedRequest
    try {
      request = normalizeFeedRequest(raw, now)
    } catch (error) {
      feeds.push({ feed: raw.feed, ok: false, error: error instanceof Error ? error.message : String(error) })
      continue
    }
    progress(`pulling ${describeRequest(request)}…`)
    try {
      const result = await fetchFeed(request)
      const recorded = recordFeedResult(input, result, { subscribe: true }) as { series: { newReadings: number }[] }
      const added = recorded.series.reduce((sum, item) => sum + item.newReadings, 0)
      feeds.push({ feed: request.feed, ok: true, title: result.title, newReadings: added })
      progress(`  ✓ ${result.title} (${added} new reading${added === 1 ? '' : 's'})`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      feeds.push({ feed: request.feed, ok: false, request, error: message })
      progress(`  ✗ ${describeRequest(request)}: ${message}`)
    }
  }
  const latest = (key: string) => readIndicatorReadings(input, key).at(-1)?.value
  const existing = new Set((JSON.parse(executeBattmannStoreAction({ ...input, action: 'list_questions' })) as { questions: { id: string }[] }).questions.map((question) => question.id))
  const questions: Row[] = []
  for (const question of playbook.questions(latest, now)) {
    if (existing.has(String(question.questionId))) {
      questions.push({ questionId: question.questionId, status: 'already open' })
      continue
    }
    try {
      const created = await openRuleQuestion({ ...input, ...question })
      const baseline = created.baseline as Row | undefined
      questions.push({ questionId: created.questionId, status: 'opened', horizon: created.horizon, baseline: baseline?.recorded ? baseline.probability : `none (${String(baseline?.reason ?? 'unavailable')})` })
      progress(`  ✓ opened ${String(question.question)} — baseline ${baseline?.recorded ? `${Math.round(Number(baseline.probability) * 100)}%` : 'none'}`)
    } catch (error) {
      questions.push({ questionId: question.questionId, status: 'failed', error: error instanceof Error ? error.message : String(error) })
      progress(`  ✗ ${String(question.question)}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { playbook: playbook.id, feeds, questions }
}

export function describeRequest(request: FeedRequest): string {
  switch (request.feed) {
    case 'fx': return `ECB rates ${request.base}/${request.quotes.join(',')}`
    case 'worldbank': return `World Bank ${request.indicator} for ${request.country}`
    case 'imf': return `IMF ${request.indicator} for ${request.country}`
    case 'comtrade': return `UN Comtrade ${request.reporter} ${request.flow}s HS ${request.hs} (${request.partner}, ${request.periods.join(',')})`
    case 'gdelt': return `GDELT "${request.query}"`
  }
}
