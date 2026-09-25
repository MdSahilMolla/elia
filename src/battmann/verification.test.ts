import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withAgentIdentity } from '../autonomy/context.ts'
import { publicFetchTestHooks } from '../networkPolicy.ts'
import { battmannTool } from '../tools/battmann.ts'
import { excerptIsOnPage, forgetFetchedPages } from '../tools/fetchedPages.ts'
import { webFetchTool } from '../tools/webFetch.ts'
import { feedTestHooks, resetFeedCaches } from './feeds.ts'
import { modelBoundaryTestHooks } from './modelBoundary.ts'

// Sources are graded: a page web_fetch retrieved can verify an excerpt; a snippet cannot.

const PAGE = '<html><body><h1>Semicon 2.0 scheme notified with ₹1.27 lakh crore outlay</h1><p>The Central government has formally notified Semicon 2.0, setting in motion a ₹1,27,500-crore programme aimed at expanding India’s semiconductor ecosystem beyond chip fabrication.</p></body></html>'
const URL = 'https://www.businesstoday.in/latest/corporate/story/semicon-2-0'
const DAY = 86_400_000
const day = (offset: number) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10)

beforeEach(() => {
  forgetFetchedPages()
  resetFeedCaches()
  modelBoundaryTestHooks.override = { ceiling: 'internal', allLocal: false, cloudRoutes: ['mercury (test)'] }
  publicFetchTestHooks.transport = async () => new Response(PAGE, { status: 200, headers: { 'content-type': 'text/html' } })
})

afterEach(() => {
  publicFetchTestHooks.transport = undefined
  feedTestHooks.fetch = undefined
  modelBoundaryTestHooks.override = undefined
})

function tool(cwd: string) {
  return async (input: Record<string, unknown>) => JSON.parse(await withAgentIdentity({ name: 'test', role: 'lead', cwd }, () => battmannTool.execute(input)))
}

const evidence = (excerpt: string, url = URL) => ({ action: 'register_evidence', title: 'Semicon 2.0 notified', url, publishedAt: day(-2), retrievedAt: new Date().toISOString(), excerpt, independenceGroup: 'media', reliability: 0.8 })

test('an excerpt is on a page when all of it, or every passage between ellipses, is there', () => {
  const text = 'The Central government has formally notified Semicon 2.0, setting in motion a programme aimed at expanding India’s semiconductor ecosystem beyond chip fabrication.'
  expect(excerptIsOnPage('formally notified Semicon 2.0, setting in motion a programme', text)).toBe(true)
  expect(excerptIsOnPage('"The Central government has formally notified Semicon 2.0 … expanding India\'s semiconductor ecosystem beyond chip fabrication"', text)).toBe(true)
  expect(excerptIsOnPage('The government has cancelled Semicon 2.0 after reviewing its costs', text)).toBe(false)
})

test('evidence quoted from a fetched page is verified; words not on it are refused; an unfetched page is unverified', async () => {
  const run = tool(mkdtempSync(join(tmpdir(), 'elia-battmann-verify-')))
  await webFetchTool.execute({ url: URL })
  const verified = await run(evidence('The Central government has formally notified Semicon 2.0, setting in motion a ₹1,27,500-crore programme'))
  expect(verified.verification).toBe('fetched')
  await expect(run(evidence('The scheme was cancelled after a cost review'))).rejects.toThrow('the excerpt is not on the page web_fetch returned')
  const snippet = await run(evidence('Semicon 2.0 has a ₹1.27 lakh crore outlay', 'https://example.com/never-fetched'))
  expect(snippet.verification).toBe('unverified')
  expect(snippet.note).toContain('web_fetch the page')
})

test('an observed fact whose figures are not in its evidence is refused, and its source grade is reported', async () => {
  const run = tool(mkdtempSync(join(tmpdir(), 'elia-battmann-facts-')))
  await webFetchTool.execute({ url: URL })
  const page = await run({ ...evidence('Semicon 2.0 scheme notified with ₹1.27 lakh crore outlay'), evidenceId: 'bt' })
  await run({ ...evidence('India semiconductor ecosystem', 'https://www.pib.gov.in/x'), evidenceId: 'pib' })
  const claim = (evidenceId: string, classification = 'observed_fact') => ({ action: 'register_claim', statement: 'Semicon 2.0 has a ₹1.27 lakh crore outlay', classification, confidence: 'high', asOf: day(0), evidenceLinks: [{ evidenceId, relation: 'supports', supportingExcerpt: '₹1.27 lakh crore' }] })
  await expect(run(claim('pib'))).rejects.toThrow("an observed_fact's figures must appear in the evidence it cites")
  const estimate = await run(claim('pib', 'model_estimate'))
  expect(estimate.unverifiedFigures).toEqual(['₹1.27 lakh'])
  const fact = await run(claim(page.evidenceId))
  expect(fact.sources).toEqual({ verified: 1, unverified: 0 })
  expect(fact.note).toBeUndefined()
})

test('a certified forecast far from the baseline is told to name the evidence the baseline cannot see', async () => {
  const run = tool(mkdtempSync(join(tmpdir(), 'elia-battmann-divergence-')))
  feedTestHooks.fetch = async (url) => {
    const [start, end] = url.pathname.replace('/v1/', '').split('..') as [string, string]
    const rates: Record<string, { INR: number }> = {}
    for (let t = Date.parse(`${start}T00:00:00Z`); t <= Date.parse(`${end ?? start}T00:00:00Z`); t += DAY) rates[new Date(t).toISOString().slice(0, 10)] = { INR: 95 + Math.sin(t / DAY) * 0.3 }
    return new Response(JSON.stringify({ base: 'USD', rates }), { status: 200 })
  }
  const created = await run({ action: 'create_question', questionId: 'q', question: 'USD/INR above 96?', resolutionRule: { source: { feed: 'fx', base: 'USD', quote: 'INR' }, observation: { period: day(20) }, comparator: '>', threshold: 96 } })
  const far = await run({ action: 'submit_forecast', questionId: 'q', probability: Math.min(0.95, created.baseline.probability + 0.4), method: 'judgement', rationale: 'Feels likely.' })
  expect(far.note).toContain('points from the statistical baseline')
  const near = await run({ action: 'submit_forecast', questionId: 'q', probability: Math.min(0.95, created.baseline.probability + 0.1), method: 'judgement', rationale: 'Slightly higher.' })
  expect(near.note).toBeUndefined()
})
