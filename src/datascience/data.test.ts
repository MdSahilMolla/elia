import { afterAll, beforeAll, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ExcelJS from 'exceljs'
import { withAgentIdentity } from '../autonomy/context.ts'
import { loadSource, parseDelimited, sniffDelimiter } from './ingest.ts'
import { discoverRelationships, understandDataset } from './understand.ts'
import { assessQuality } from './quality.ts'
import { runPipeline } from './transform.ts'
import { queryFrames } from './sqlwork.ts'
import { Workspace, clearFrameCache } from './workspace.ts'
import { compileExpression } from './expr.ts'
import type { Frame } from './frame.ts'

let dir: string
const inDir = <T>(fn: () => Promise<T>) => withAgentIdentity({ name: 'test', role: 'lead', cwd: dir }, fn)

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'elia-ds-'))
  writeFileSync(join(dir, 'orders.csv'), [
    'order_id,customer_id,order_date,amount,status,zip',
    '1,C1,2025-01-05,120.50,shipped,02134',
    '2,C2,2025-01-07,80,shipped,10001',
    '3,C1,2025-02-11,,cancelled,02134',
    '4,C3,2025-02-15,300,Shipped ,94105',
    '5,C9,2025-03-01,45.25,shipped,60601',
    '5,C9,2025-03-01,45.25,shipped,60601',
  ].join('\n'))
  writeFileSync(join(dir, 'customers.json'), JSON.stringify({ data: [
    { customer_id: 'C1', name: 'Ada', segment: 'enterprise', address: { city: 'Boston', country: 'US' } },
    { customer_id: 'C2', name: 'Bo', segment: 'smb', address: { city: 'New York', country: 'US' } },
    { customer_id: 'C3', name: 'Cy', segment: 'SMB', address: { city: 'San Francisco', country: 'US' } },
  ] }))
  writeFileSync(join(dir, 'semi.txt'), 'a;b;c\n1;x;2025-01-01\n2;y;2025-01-02\n')
  writeFileSync(join(dir, 'rates.xml'), '<rates><rate currency="EUR"><value>1.08</value><date>2025-06-30</date></rate><rate currency="GBP"><value>1.27</value><date>2025-06-30</date></rate></rates>')
  writeFileSync(join(dir, 'table.md'), '# Report\n\n| region | revenue |\n|---|---:|\n| north | 10 |\n| south | 20 |\n')
  writeFileSync(join(dir, 'evil.xml'), '<!DOCTYPE x [<!ENTITY a "aaaa">]><x>&a;</x>')
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Sales')
  sheet.addRow(['month', 'units', 'launched'])
  sheet.addRow([new Date(Date.UTC(2025, 0, 1)), 10, true])
  sheet.addRow([new Date(Date.UTC(2025, 1, 1)), 12, false])
  await workbook.xlsx.writeFile(join(dir, 'sales.xlsx'))
  const db = new Database(join(dir, 'shop.db'))
  db.run('create table products (sku text primary key, price real)')
  db.run("insert into products values ('A', 9.5), ('B', 12)")
  db.close()
})

afterAll(() => {
  clearFrameCache()
  rmSync(dir, { recursive: true, force: true })
})

test('CSV parsing handles quotes, embedded newlines, and delimiter sniffing', () => {
  expect(parseDelimited('a,b\n"x, y","line1\nline2"\n', ',')).toEqual([['a', 'b'], ['x, y', 'line1\nline2']])
  expect(sniffDelimiter('a;b;c\n1;2;3\n4;5;6\n')).toBe(';')
  expect(sniffDelimiter('a\tb\n1\t2\n')).toBe('\t')
})

test('CSV load types columns strictly and keeps leading-zero codes as text', async () => {
  const result = await inDir(() => loadSource({ path: 'orders.csv' }))
  expect(result.frame.types).toMatchObject({ order_id: 'integer', customer_id: 'string', order_date: 'date', amount: 'number', zip: 'string' })
  expect(result.frame.rows[0]!.zip).toBe('02134')
  expect(result.frame.rows[2]!.amount).toBeNull()
  expect(result.source.sha256).toHaveLength(64)
})

test('JSON, XML, Markdown, XLSX, delimited TXT, and SQLite load into frames', async () => {
  const json = await inDir(() => loadSource({ path: 'customers.json' }))
  expect(json.frame.columns).toContain('address.city')
  const xml = await inDir(() => loadSource({ path: 'rates.xml' }))
  expect(xml.frame.rows).toEqual([{ currency: 'EUR', value: 1.08, date: '2025-06-30' }, { currency: 'GBP', value: 1.27, date: '2025-06-30' }])
  const md = await inDir(() => loadSource({ path: 'table.md' }))
  expect(md.frame.rows[1]).toEqual({ region: 'south', revenue: 20 })
  const xlsx = await inDir(() => loadSource({ path: 'sales.xlsx' }))
  expect(xlsx.frame.rows[0]).toEqual({ month: '2025-01-01', units: 10, launched: true })
  const txt = await inDir(() => loadSource({ path: 'semi.txt' }))
  expect(txt.frame.columns).toEqual(['a', 'b', 'c'])
  const sqlite = await inDir(() => loadSource({ connection: 'sqlite', path: 'shop.db', table: 'products' }))
  expect(sqlite.frame.rows).toHaveLength(2)
  await expect(inDir(() => loadSource({ connection: 'sqlite', path: 'shop.db', query: 'delete from products' }))).rejects.toThrow(/read-only/)
})

test('XML with entity declarations is refused', async () => {
  await expect(inDir(() => loadSource({ path: 'evil.xml' }))).rejects.toThrow(/entity/)
})

test('a path outside the workspace is refused', async () => {
  await expect(inDir(() => loadSource({ path: '../../../../etc/passwd' }))).rejects.toThrow(/escapes/)
})

test('understanding finds semantic types, the grain, and value-validated relationships', async () => {
  const orders = (await inDir(() => loadSource({ path: 'orders.csv' }))).frame
  const customers = (await inDir(() => loadSource({ path: 'customers.json' }))).frame
  const u = understandDataset(orders)
  const byName = Object.fromEntries(u.profiles.map((p) => [p.name, p]))
  expect(byName.order_date!.semanticType).toBe('date')
  expect(byName.amount!.semanticType).toBe('currency_amount')
  expect(byName.zip!.semanticType).toBe('postal_code')
  const cu = understandDataset(customers)
  expect(cu.grain.key).toEqual(['customer_id'])
  const { relationships } = discoverRelationships([{ name: 'orders', frame: orders, profiles: u.profiles }, { name: 'customers', frame: customers, profiles: cu.profiles }], 0.7)
  const rel = relationships.find((r) => r.from.dataset === 'orders' && r.from.column === 'customer_id')!
  expect(rel.to).toEqual({ dataset: 'customers', column: 'customer_id' })
  expect(rel.orphanRows).toBe(2)
})

test('the quality engine reports duplicates, inconsistent labels, and missingness without fixing them', async () => {
  const orders = (await inDir(() => loadSource({ path: 'orders.csv' }))).frame
  const u = understandDataset(orders)
  const report = assessQuality(orders, u)
  const checks = report.issues.map((issue) => issue.check)
  expect(checks).toContain('duplicate-rows')
  expect(checks).toContain('missing-values')
  expect(checks).toContain('inconsistent-categories')
  expect(checks).toContain('whitespace')
  expect(report.score).toBeLessThan(100)
  expect(report.components.find((c) => c.dimension === 'integrity')!.score).toBeNull()
})

test('transform pipeline filters, derives, standardizes, aggregates, and preserves sums', async () => {
  const orders = (await inDir(() => loadSource({ path: 'orders.csv' }))).frame
  const result = runPipeline(orders, [
    { op: 'dedupe' },
    { op: 'standardize_categories', column: 'status', case: 'lower' },
    { op: 'filter', where: 'status == "shipped"' },
    { op: 'derive', columns: { month: 'month_start(order_date)', big: 'amount >= 100' } },
    { op: 'aggregate', groupBy: ['month'], metrics: [{ column: 'amount', fn: 'sum', as: 'revenue' }, { fn: 'count', as: 'orders' }] },
  ], () => { throw new Error('no joins here') })
  expect(result.frame.rows).toEqual([{ month: '2025-01-01', revenue: 200.5, orders: 2 }, { month: '2025-02-01', revenue: 300, orders: 1 }, { month: '2025-03-01', revenue: 45.25, orders: 1 }])
  expect(result.checks.every((check) => check.status !== 'fail')).toBe(true)
})

test('a join that would multiply rows is refused unless declared', async () => {
  const orders = (await inDir(() => loadSource({ path: 'orders.csv' }))).frame
  const resolve = (ref: string) => ({ ref, frame: orders })
  const customerDim: Frame = { columns: ['customer_id', 'tier'], types: { customer_id: 'string', tier: 'string' }, rows: [{ customer_id: 'C1', tier: 'gold' }, { customer_id: 'C1', tier: 'silver' }] }
  expect(() => runPipeline(orders, [{ op: 'join', right: 'dim', on: 'customer_id' }], () => ({ ref: 'dim', frame: customerDim }))).toThrow(/row-multiplication/)
  const allowed = runPipeline(orders, [{ op: 'join', right: 'dim', on: 'customer_id', validate: 'many_to_many' }], () => ({ ref: 'dim', frame: customerDim }))
  expect(allowed.frame.rows.length).toBe(orders.rows.length + 2)
  void resolve
})

test('window functions rank and lag within partitions', () => {
  const frame: Frame = { columns: ['g', 't', 'v'], types: { g: 'string', t: 'integer', v: 'number' }, rows: [{ g: 'a', t: 1, v: 10 }, { g: 'a', t: 2, v: 15 }, { g: 'b', t: 1, v: 7 }, { g: 'a', t: 3, v: 15 }] }
  const lag = runPipeline(frame, [{ op: 'window', partitionBy: 'g', orderBy: 't', column: 'v', fn: 'lag', as: 'prev' }], () => { throw new Error() })
  expect(lag.frame.rows.map((r) => r.prev)).toEqual([null, 10, null, 15])
  const rank = runPipeline(frame, [{ op: 'window', partitionBy: 'g', orderBy: 'v', fn: 'dense_rank', as: 'r', desc: true }], () => { throw new Error() })
  expect(rank.frame.rows.map((r) => r.r)).toEqual([2, 1, 1, 1])
})

test('SQL runs over workspace frames and cannot write', async () => {
  const orders = (await inDir(() => loadSource({ path: 'orders.csv' }))).frame
  const result = queryFrames([{ name: 'orders', frame: orders }], "select strftime('%Y-%m', order_date) as month, sum(amount) as revenue from orders group by 1 order by 1")
  expect(result.frame.rows[0]).toEqual({ month: '2025-01', revenue: 200.5 })
  expect(() => queryFrames([{ name: 'orders', frame: orders }], 'delete from orders')).toThrow()
})

test('the workspace versions datasets, snapshots them, and walks lineage back to the source', async () => {
  const workspace = new Workspace(dir)
  const loaded = await inDir(() => loadSource({ path: 'orders.csv' }))
  const first = workspace.registerDataset({ name: 'orders', frame: loaded.frame, kind: 'source', source: loaded.source })
  expect(first.entry.version).toBe(1)
  expect(workspace.registerDataset({ name: 'orders', frame: loaded.frame, kind: 'source', source: loaded.source }).reused).toBe(true)
  const derived = runPipeline(loaded.frame, [{ op: 'filter', where: 'amount > 100' }], () => { throw new Error() })
  workspace.registerDataset({ name: 'big_orders', frame: derived.frame, kind: 'derived', derivation: { inputs: ['orders@1'], operation: 'transform', steps: [{ op: 'filter', where: 'amount > 100' }], runId: 'r1' } })
  clearFrameCache()
  expect(workspace.frame('big_orders').frame.rows).toHaveLength(2)
  const lineage = workspace.lineage('big_orders')
  expect(lineage.map((step) => step.dataset)).toEqual(['orders@1', 'big_orders@1'])
})

test('expressions are sandboxed, typo-checked, and null-safe', () => {
  expect(() => compileExpression('amout > 1', ['amount'])).toThrow(/unknown column/)
  expect(() => compileExpression('constructor.constructor("return process")()', [])).toThrow()
  const e = compileExpression('if(amount > 100, "big", "small")', ['amount'])
  expect(e.evaluate({ amount: 150 })).toBe('big')
  expect(compileExpression('amount / 0', ['amount']).evaluate({ amount: 1 })).toBeNull()
  expect(compileExpression('status != "x"', ['status']).test({ status: null })).toBe(true)
  expect(compileExpression('`order total` * 2', ['order total']).evaluate({ 'order total': 3 })).toBe(6)
  expect(compileExpression('x between 1 and 3 and y in ["a", "b"]', ['x', 'y']).test({ x: 2, y: 'b' })).toBe(true)
})
