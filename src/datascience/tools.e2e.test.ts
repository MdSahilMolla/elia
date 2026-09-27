import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withAgentIdentity } from '../autonomy/context.ts'
import { datascienceTools } from '../tools/dsMode.ts'
import { createRng } from './rng.ts'
import { clearFrameCache } from './workspace.ts'

let dir: string
const tool = (name: string) => datascienceTools.find((t) => t.name === name)!
async function call(name: string, input: Record<string, unknown>): Promise<{ runId: string; status: string; result: Record<string, any>; checks: { failed: number; details: Array<{ name: string; status: string; detail: string }> }; warnings: string[] }> {
  const text = await withAgentIdentity({ name: 'test', role: 'lead', cwd: dir }, () => tool(name).execute(input))
  return JSON.parse(text)
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'elia-ds-e2e-'))
  const rng = createRng(1)
  const regions = ['North', 'South', 'East', 'West']
  const lines = ['order_id,order_date,customer_id,region,channel,discount,amount']
  let id = 1
  for (let m = 0; m < 24; m++) {
    for (let i = 0; i < 60; i++) {
      const region = regions[rng.int(4)]!
      const drop = m >= 22 && region === 'South'
      if (drop && rng.next() < 0.6) continue
      const day = 1 + rng.int(27)
      const date = `${2024 + Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
      const discount = Math.round(rng.next() * 20) / 100
      const amount = Math.round((80 + 5 * m + 40 * discount + (region === 'North' ? 20 : 0) + 15 * Math.sin((2 * Math.PI * m) / 12) + rng.normal(0, 10)) * 100) / 100
      lines.push(`${id++},${date},C${rng.int(200)},${region},${rng.next() < 0.5 ? 'web' : 'store'},${discount},${amount}`)
    }
  }
  writeFileSync(join(dir, 'orders.csv'), lines.join('\n'))
  writeFileSync(join(dir, 'customers.csv'), ['customer_id,segment,churned', ...Array.from({ length: 200 }, (_, i) => `C${i},${['SMB', 'Enterprise', 'Consumer'][i % 3]},${i % 7 === 0 ? 1 : 0}`)].join('\n'))
})

afterAll(() => {
  clearFrameCache()
  rmSync(dir, { recursive: true, force: true })
})

test('a full analysis runs through the tools with records, checks, and verified artifacts', async () => {
  const load = await call('ds_data', { action: 'load', name: 'orders', path: 'orders.csv' })
  expect(load.status).toMatch(/passed/)
  expect(load.result.dataset).toBe('orders@1')
  await call('ds_data', { action: 'load', name: 'customers', path: 'customers.csv' })
  const inspect = await call('ds_data', { action: 'inspect', dataset: 'orders' })
  expect(inspect.result.grain.key).toEqual(['order_id'])
  const quality = await call('ds_data', { action: 'quality', dataset: 'orders' })
  expect(quality.result.score).toBeGreaterThan(80)
  const rel = await call('ds_data', { action: 'relationships' })
  expect(rel.result.relationships.some((r: any) => r.from.column === 'customer_id')).toBe(true)
  const t = await call('ds_data', { action: 'transform', dataset: 'orders', output: 'orders_enriched', steps: [{ op: 'join', right: 'customers', on: 'customer_id', how: 'left' }, { op: 'derive', columns: { month: 'month_start(order_date)' } }] })
  expect(t.result.output).toBe('orders_enriched@1')
  const sql = await call('ds_data', { action: 'sql', query: 'select region, sum(amount) as revenue from orders group by region order by revenue desc', output: 'revenue_by_region' })
  expect(sql.result.rows).toBe(4)
  const refused = await withAgentIdentity({ name: 't', role: 'lead', cwd: dir }, () => tool('ds_data').execute({ action: 'sql', query: 'delete from orders' })).catch((e: Error) => e.message)
  expect(String(refused)).toContain('read-only')
  const testRun = await call('ds_stats', { action: 'test', dataset: 'orders', value: 'amount', group: 'channel' })
  expect(['welch_t', 'mann_whitney']).toContain(testRun.result.testUsed)
  const reg = await call('ds_stats', { action: 'regression', dataset: 'orders', target: 'amount', features: ['discount', 'region'], covariance: 'HC3' })
  expect(reg.result.coefficients.find((c: any) => c.term === 'discount').estimate).toBeGreaterThan(10)
  const train = await call('ds_ml', { action: 'train', dataset: 'orders_enriched', target: 'churned', features: ['amount', 'discount', 'region', 'channel', 'segment'], algorithms: ['logistic', 'decision_tree'], name: 'churn' })
  expect(train.result.model).toBe('churn@1')
  // Churn here depends on the customer id, not on any feature: the engine must not claim a useful model.
  const baselineChecks = train.checks.details.filter((c) => c.name.includes('baseline'))
  expect(baselineChecks.length).toBe(2)
  expect(baselineChecks.every((c) => c.status !== 'pass')).toBe(true)
  expect(train.status).not.toBe('passed')
  const predict = await call('ds_ml', { action: 'predict', model: 'churn', dataset: 'orders_enriched', output: 'scored' })
  expect(predict.result.output).toBe('scored@1')
  const forecast = await call('ds_timeseries', { action: 'forecast', dataset: 'orders', time: 'order_date', value: 'amount', frequency: 'month', horizon: 6, methods: ['seasonal_naive', 'holt_winters_additive', 'drift'] })
  expect(forecast.result.forecast).toHaveLength(6)
  const rc = await call('ds_analytics', { action: 'root_cause', dataset: 'orders_enriched', metric: { kind: 'sum', column: 'amount' }, dimensions: ['region', 'channel'], before: 'month == "2025-08-01" or month == "2025-09-01"', after: 'month == "2025-11-01" or month == "2025-12-01"', volumeKey: 'order_id' })
  expect(rc.result.levels[0].segments[0].segment).toBe('South')
  const chart = await call('ds_report', { action: 'chart', dataset: 'orders', x: 'region', y: 'amount' })
  expect(existsSync(join(dir, chart.result.path))).toBe(true)
  const report = await call('ds_report', { action: 'report', title: 'Orders review', objective: 'Why did revenue fall?', runs: [quality.runId, rc.runId, forecast.runId], narrative: [{ heading: 'Finding', text: `South drove the decline; revenue fell ${Math.abs(Math.round(rc.result.change))} and an invented 987654 appears here.` }] })
  expect(report.result.untracedNumbers).toEqual(['987654'])
  const html = readFileSync(join(dir, report.result.html), 'utf8')
  expect(html).toContain('id="validation"')
  const pbi = await call('ds_report', { action: 'powerbi', name: 'Orders', tables: [{ dataset: 'orders', role: 'fact', name: 'Orders' }, { dataset: 'customers', role: 'dimension', name: 'Customers' }] })
  expect(pbi.result.relationships[0]).toMatchObject({ fromTable: 'Orders', toTable: 'Customers' })
  expect(existsSync(join(dir, pbi.result.open))).toBe(true)
  const deliver = await call('ds_report', { action: 'deliver' })
  expect(deliver.result.artifacts.length).toBeGreaterThan(3)
  expect(deliver.result.unverifiedArtifacts).toEqual([])
  const lineage = await call('ds_data', { action: 'lineage', dataset: 'scored' })
  expect(lineage.result.lineage.map((n: any) => n.dataset)).toEqual(['orders@1', 'customers@1', 'orders_enriched@1', 'scored@1'])
}, 120_000)

test('a bad call returns the action usage and still leaves an error record', async () => {
  const message = await withAgentIdentity({ name: 't', role: 'lead', cwd: dir }, () => tool('ds_stats').execute({ action: 'regression', dataset: 'orders' })).catch((e: Error) => e.message)
  expect(message).toContain('"target" is required')
  expect(message).toContain('ds_stats action "regression"')
  const unknown = await withAgentIdentity({ name: 't', role: 'lead', cwd: dir }, () => tool('ds_stats').execute({ action: 'nope' })).catch((e: Error) => e.message)
  expect(unknown).toContain('Actions:')
})

test('the spellings a real model sent in a live run are normalised, not refused', async () => {
  // Each call below failed verbatim in a Data Science mode run on mercury-2.5.
  const rc = await call('ds_analytics', { action: 'root_cause', dataset: 'orders', metric: '{"column":"amount","kind":"sum"}', dimensions: '["region", "channel"]', before: 'order_date >= "2025-08-01" and order_date < "2025-10-01"', after: 'order_date >= "2025-11-01"' })
  expect(rc.status).not.toBe('error')
  expect(rc.result.levels[0].segments[0].segment).toBe('South')
  const described = await call('ds_stats', { action: 'describe', dataset: 'orders', columns: '["amount"]' })
  expect(described.status).not.toBe('error')
  const sql = await call('ds_data', { action: 'sql', dataset: 'orders', query: 'select count(*) as n from orders' })
  expect(sql.result.preview[0].n).toBeGreaterThan(1000)
  const derived = await call('ds_data', { action: 'transform', dataset: 'orders', output: 'orders_period', steps: '[{"op":"derive","name":"period","expression":"month(order_date) == 12 ? \'Dec\' : \'other\'"}]' })
  expect(derived.status).toBe('passed')
  const preview = await call('ds_data', { action: 'preview', dataset: 'orders_period', where: 'period == "Dec"', n: '3' })
  expect(preview.status).not.toBe('error')
  expect(JSON.stringify(preview.result)).toContain('Dec')
})

test('a two-sample test refuses a many-level grouping instead of comparing two arbitrary levels', async () => {
  // Seen live: group by order_date (56 levels) + mann_whitney compared the first two dates and "passed".
  const message = await withAgentIdentity({ name: 't', role: 'lead', cwd: dir }, () => tool('ds_stats').execute({ action: 'test', dataset: 'orders', value: 'amount', group: 'order_date', test: 'mann_whitney' })).catch((e: Error) => e.message)
  expect(message).toContain('compares two groups')
  const chosen = await call('ds_stats', { action: 'test', dataset: 'orders', value: 'amount', group: 'region', groups: ['North', 'South'], test: 'mann_whitney' })
  expect(chosen.status).not.toBe('error')
})
