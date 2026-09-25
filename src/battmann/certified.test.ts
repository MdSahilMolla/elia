import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withAgentIdentity } from '../autonomy/context.ts'
import { battmannTool } from '../tools/battmann.ts'
import { feedTestHooks, resetFeedCaches } from './feeds.ts'
import { modelBoundaryTestHooks } from './modelBoundary.ts'
import { runMonitorPass } from './monitor.ts'

// End to end: a question with a resolution rule gets a baseline at opening, refuses anything that would let a
// model shape its own record, and is resolved by code from the feed once the source publishes the value.

const DAY = 86_400_000
const day = (offset: number, from = Date.now()) => new Date(from + offset * DAY).toISOString().slice(0, 10)
/** A deterministic USD/INR path: business days only, like the ECB. */
const inr = (date: string) => Number((95 + 0.02 * (Math.floor(Date.parse(`${date}T00:00:00Z`) / DAY) % 40)).toFixed(4))
const isBusinessDay = (date: string) => ![0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay())

let fxCalls = 0
beforeEach(() => {
  fxCalls = 0
  resetFeedCaches()
  feedTestHooks.sleep = async () => {}
  feedTestHooks.fetch = async (url) => {
    fxCalls += 1
    const [start, end] = url.pathname.replace('/v1/', '').split('..') as [string, string]
    const rates: Record<string, { INR: number }> = {}
    for (let t = Date.parse(`${start}T00:00:00Z`); t <= Date.parse(`${end ?? start}T00:00:00Z`); t += DAY) {
      const date = new Date(t).toISOString().slice(0, 10)
      if (isBusinessDay(date)) rates[date] = { INR: inr(date) }
    }
    return new Response(JSON.stringify({ amount: 1, base: 'USD', rates }), { status: 200 })
  }
  // A cloud session: the certified record must hold even when the model is not local.
  modelBoundaryTestHooks.override = { ceiling: 'internal', allLocal: false, cloudRoutes: ['anthropic (test)'] }
})

afterEach(() => {
  feedTestHooks.fetch = undefined
  feedTestHooks.sleep = undefined
  feedTestHooks.now = undefined
  modelBoundaryTestHooks.override = undefined
})

test('a rule question is baselined at opening, protected from the model, and resolved by code', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'elia-battmann-certified-'))
  const run = async (input: Record<string, unknown>) => JSON.parse(await withAgentIdentity({ name: 'test', role: 'lead', cwd }, () => battmannTool.execute(input)))
  const observationDay = day(12)
  const threshold = 95.4

  const created = await run({ action: 'create_question', questionId: 'usd-inr', question: `Will USD/INR be above ${threshold} on ${observationDay}?`, domain: 'financial', resolutionRule: { source: { feed: 'fx', base: 'USD', quote: 'INR' }, observation: { period: observationDay }, comparator: '>', threshold } })
  expect(created.horizon).toBe(`${observationDay}T00:00:00.000Z`)
  expect(created.resolvedBy).toContain('fx feed')
  expect(created.baseline.recorded).toBe(true)
  expect(created.baseline.method).toBe('baseline:random-walk')
  expect(created.baseline.probability).toBeGreaterThan(0)

  // The model cannot resolve, void, impersonate the baseline, or backdate a forecast on a certified question.
  await expect(run({ action: 'resolve_question', questionId: 'usd-inr', outcome: 1, resolvedAt: new Date().toISOString(), resolutionSourceUrl: 'https://example.com', resolver: 'model', rationale: 'I say so' })).rejects.toThrow('resolved by code')
  await expect(run({ action: 'resolve_question', questionId: 'usd-inr', resolutionStatus: 'void', resolvedAt: new Date().toISOString(), resolutionSourceUrl: 'https://example.com', resolver: 'model', rationale: 'inconvenient' })).rejects.toThrow('only a human can void')
  const feeds = await run({ action: 'list_indicators' })
  expect(feeds.indicators.map((row: { id: string }) => row.id)).toContain('fx:USD:INR')
  const series = await run({ action: 'indicator_series', indicatorId: 'fx:USD:INR' })
  const evidenceId = series.readings.at(-1).evidenceId
  const forecast = { action: 'submit_forecast', questionId: 'usd-inr', probability: 0.8, method: 'judgement', forecaster: 'battmann', rationale: 'Rupee weakness persists.', evidenceIds: [evidenceId] }
  await expect(run({ ...forecast, forecaster: 'baseline-v2' })).rejects.toThrow('reserved')
  // The clock stamps a certified forecast: a backdated asOf is simply not used.
  const backdated = await run({ ...forecast, probability: 0.7, asOf: new Date(Date.now() - 2 * DAY).toISOString() })
  expect(backdated.asOfSetBy).toBe('clock')
  expect(Math.abs(Date.parse(backdated.asOf) - Date.now())).toBeLessThan(60_000)
  const logged = await run(forecast)
  expect(logged.revision).toBe(3)

  // Before the day, nothing resolves; the monitor never guesses.
  const early = await run({ action: 'resolve_due' })
  expect(early.pending[0].reason).toContain('has not ended')

  // After the day, the value is read back from the source and decides the question.
  feedTestHooks.now = () => new Date(Date.parse(`${observationDay}T00:00:00Z`) + 5 * DAY)
  const pass = await withAgentIdentity({ name: 'monitor', role: 'lead', cwd }, () => runMonitorPass({}))
  const resolved = (pass.resolutions as { resolved: { questionId: string; outcome: number; observedValue: number }[] }).resolved
  const decisiveDay = isBusinessDay(observationDay) ? observationDay : [1, 2, 3].map((back) => day(-back, Date.parse(`${observationDay}T00:00:00Z`))).find(isBusinessDay)!
  expect(resolved).toHaveLength(1)
  expect(resolved[0]!.observedValue).toBe(inr(decisiveDay))
  expect(resolved[0]!.outcome).toBe(inr(decisiveDay) > threshold ? 1 : 0)

  const detail = await run({ action: 'question_detail', questionId: 'usd-inr' })
  expect(detail.resolutions[0].provenance).toBe('feed')
  expect(detail.resolutions[0].resolver).toBe('feed:fx')

  const score = await run({ action: 'scorecard' })
  expect(score.certified.system.sampleSize).toBe(1)
  expect(score.certified.baseline.sampleSize).toBe(1)
  expect(score.certified.matchedQuestions).toBe(1)
  expect(score.certified.system.brierScore).toBe(Number(((0.8 - resolved[0]!.outcome) ** 2).toFixed(6)))
  expect(score.certified.skillNote).toContain('not yet meaningful')

  // Every row the feed wrote has its own entry in the tamper-evident chain.
  const audit = await run({ action: 'audit_trail', fullVerify: true, limit: 5 })
  expect(audit.chainValid).toBe(true)
  expect(audit.auditGaps).toEqual([])
})

test('ingest_feed is append-only: a re-pull adds nothing, and an upstream revision is reported, not overwritten', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'elia-battmann-ingest-'))
  const run = async (input: Record<string, unknown>) => JSON.parse(await withAgentIdentity({ name: 'test', role: 'lead', cwd }, () => battmannTool.execute(input)))
  const window = { action: 'ingest_feed', feed: 'fx', base: 'USD', quote: 'INR', start: day(-20), end: day(-1) }
  const first = await run(window)
  expect(first.recorded.provenance).toBe('feed')
  expect(first.recorded.series[0].newReadings).toBeGreaterThan(5)
  expect(first.recorded.subscriptionId).toMatch(/^[0-9a-f]{16}$/)
  const again = await run(window)
  expect(again.recorded.series[0].newReadings).toBe(0)
  expect(again.recorded.reusedEvidence).toBe(true)

  const revisedDay = Object.keys(first.series[0].latestObservations.reduce((all: Record<string, true>, item: { period: string }) => ({ ...all, [item.period]: true }), {})).at(-1)!
  const original = feedTestHooks.fetch!
  feedTestHooks.fetch = async (url, headers) => {
    const response = await original(url, headers)
    const body = await response.json() as { rates: Record<string, { INR: number }> }
    if (body.rates[revisedDay]) body.rates[revisedDay]!.INR += 1
    return new Response(JSON.stringify(body), { status: 200 })
  }
  const revised = await run(window)
  expect(revised.recorded.series[0].upstreamRevisionCount).toBe(1)
  expect(revised.recorded.series[0].upstreamRevisions[0].period).toBe(revisedDay)
  const stored = await run({ action: 'indicator_series', indicatorId: 'fx:USD:INR' })
  expect(stored.readings.find((item: { observedAt: string }) => item.observedAt.startsWith(revisedDay)).value).toBe(inr(revisedDay))

  const listed = await run({ action: 'list_feeds' })
  expect(listed.subscriptions).toHaveLength(1)
  expect(fxCalls).toBe(3)
})
