import { expect, test } from 'bun:test'
import { frameFromRows } from '../frame.ts'
import { buildPowerBiProject, checkDax, tmdlName } from './project.ts'

const customers = frameFromRows([{ customer_id: 'C1', segment: 'SMB' }, { customer_id: 'C2', segment: 'Enterprise' }, { customer_id: 'C3', segment: 'SMB' }])
const sales = frameFromRows([
  { order_id: 1, order_date: '2024-02-01', customer_id: 'C1', revenue: 100.5, channel: 'Web' },
  { order_id: 2, order_date: '2025-03-04', customer_id: 'C2', revenue: 80, channel: 'Store' },
  { order_id: 3, order_date: '2025-05-06', customer_id: 'C9', revenue: 20, channel: 'Web' },
])
const request = () => ({ name: 'Sales Model', dataFolder: '/data', tables: [{ name: 'Sales', frame: sales, role: 'fact' as const, semantic: { revenue: 'currency_amount' } }, { name: 'Customers', frame: customers, role: 'dimension' as const }], relationships: [{ fromTable: 'Sales', fromColumn: 'customer_id', toTable: 'Customers', toColumn: 'customer_id' }] })

test('a PBIP project has the documented files, schema URLs, and a byPath report binding', () => {
  const result = buildPowerBiProject(request())
  const paths = result.files.map((f) => f.path)
  for (const required of ['Sales Model.pbip', 'Sales Model.SemanticModel/definition.pbism', 'Sales Model.SemanticModel/definition/model.tmdl', 'Sales Model.SemanticModel/definition/tables/Sales.tmdl', 'Sales Model.SemanticModel/definition/tables/Date.tmdl', 'Sales Model.SemanticModel/definition/relationships.tmdl', 'Sales Model.Report/definition.pbir', 'Sales Model.Report/definition/report.json', 'Sales Model.Report/definition/pages/pages.json']) expect(paths).toContain(required)
  const pbir = JSON.parse(result.files.find((f) => f.path.endsWith('definition.pbir'))!.content)
  expect(pbir.datasetReference).toEqual({ byPath: { path: '../Sales Model.SemanticModel' } })
  for (const file of result.files.filter((f) => f.path.endsWith('.json') && !f.path.includes('StaticResources'))) expect(JSON.parse(file.content).$schema).toMatch(/^https:\/\/developer\.microsoft\.com\/json-schemas\/fabric\//)
  const visuals = result.files.filter((f) => f.path.endsWith('visual.json')).map((f) => JSON.parse(f.content))
  expect(visuals.map((v) => v.visual.visualType)).toContain('cardVisual')
  for (const v of visuals) expect(v.name.length).toBeLessThanOrEqual(50)
  expect(result.measures.map((m) => m.name)).toContain('Total Revenue YoY %')
})

test('relationship checks report orphans and refuse a non-unique dimension key', () => {
  const result = buildPowerBiProject(request())
  expect(result.relationships[0]!.orphanRows).toBe(1)
  expect(result.checks.find((c) => c.name.startsWith('relationship Sales[customer_id]'))!.status).toBe('warn')
  const duplicated = frameFromRows([{ customer_id: 'C1', segment: 'a' }, { customer_id: 'C1', segment: 'b' }])
  const bad = buildPowerBiProject({ ...request(), tables: [request().tables[0]!, { name: 'Customers', frame: duplicated, role: 'dimension' }] })
  expect(bad.checks.find((c) => c.name.startsWith('relationship'))!.status).toBe('fail')
})

test('DAX checks catch unknown references and unbalanced parentheses; TMDL names are quoted', () => {
  const model = { tables: new Map([['Sales', new Set(['revenue'])]]), measures: new Set(['Total Revenue']) }
  expect(checkDax("SUM('Sales'[revenue])", model)).toEqual([])
  expect(checkDax("SUM('Sales'[revnue])", model)[0]).toContain('unknown column')
  expect(checkDax('DIVIDE([Total Revenue], [Nope])', model)[0]).toContain('[Nope]')
  expect(checkDax('SUM(Sales[revenue]', model)).toContain('unbalanced parentheses')
  expect(tmdlName('Total Revenue')).toBe("'Total Revenue'")
  expect(tmdlName("Bob's")).toBe("'Bob''s'")
  expect(tmdlName('revenue')).toBe('revenue')
})

test('report fields that do not exist in the model are refused', () => {
  expect(() => buildPowerBiProject({ ...request(), pages: [{ name: 'P', visuals: [{ kind: 'bar', category: 'Sales.nope', measures: ['Total Revenue'] }] }] })).toThrow(/does not exist in the model/)
})
