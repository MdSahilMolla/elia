import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import ExcelJS from 'exceljs'
import { withAgentIdentity } from '../autonomy/context.ts'
import { spreadsheetTool } from './spreadsheet.ts'

let testDir: string
let workbookPath: string

beforeAll(async () => {
  testDir = mkdtempSync(join('/tmp', 'elia-spreadsheet-workflow-'))
  workbookPath = join(testDir, 'sales.xlsx')
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Sales')
  sheet.addRows([
    ['Order ID', 'Region', 'Sales', 'Profit', null, 'Computed'],
    ['A-1', 'East', 1000, 200, null, { formula: 'C2-D2', result: 200 }],
    ['A-2', 'West', 700, -50],
    ['A-2', 'West', 300, 25],
  ])
  await workbook.xlsx.writeFile(workbookPath)
})

afterAll(() => rmSync(testDir, { recursive: true, force: true }))

function executeSpreadsheet(input: Record<string, unknown>) {
  return withAgentIdentity({ name: 'test', role: 'lead', cwd: testDir }, () => spreadsheetTool.execute(input))
}

test('spreadsheet inspect exposes sheet shape, numeric columns, formulas, and samples', async () => {
  const result = JSON.parse(await executeSpreadsheet({ action: 'inspect', path: workbookPath })) as { sheets: Array<{ name: string; rows: number; numericColumns: string[]; formulaCells: number; formulasWithoutCachedValue: number }> }
  expect(result.sheets[0]?.name).toBe('Sales')
  expect(result.sheets[0]?.rows).toBe(3)
  expect(result.sheets[0]?.numericColumns).toEqual(['Sales', 'Profit', 'Computed'])
  expect(result.sheets[0]?.formulaCells).toBe(1)
  expect(result.sheets[0]?.formulasWithoutCachedValue).toBe(0)
})

test('spreadsheet analyze computes grouped sums and selects the requested measure', async () => {
  const result = JSON.parse(await executeSpreadsheet({ action: 'analyze', path: workbookPath, sheet: 'Sales', groupBy: 'Region', measure: 'Sales' })) as { sheets: Array<{ summary: { sum: number }; groups: Array<{ group: string; count: number; sum: number }> }> }
  expect(result.sheets[0]?.summary.sum).toBe(2000)
  expect(result.sheets[0]?.groups).toEqual([
    { group: 'East', count: 1, sum: 1000 },
    { group: 'West', count: 2, sum: 1000 },
  ])
})

test('spreadsheet audit detects duplicate keys and reports formula counts', async () => {
  const result = JSON.parse(await executeSpreadsheet({ action: 'audit', path: workbookPath, sheet: 'Sales', keyColumn: 'Order ID' })) as { sheets: Array<{ duplicateKeys: number; formulaCells: number; formulasWithoutCachedValue: number; status: string }> }
  expect(result.sheets[0]?.duplicateKeys).toBe(1)
  expect(result.sheets[0]?.formulaCells).toBe(1)
  expect(result.sheets[0]?.formulasWithoutCachedValue).toBe(0)
  expect(result.sheets[0]?.status).toBe('review')
})

test('spreadsheet write creates an atomic output workbook with bounded cell edits', async () => {
  const outputPath = join(process.cwd(), 'workspace', `spreadsheet-test-${process.pid}.xlsx`)
  const result = JSON.parse(await executeSpreadsheet({
    action: 'write',
    path: workbookPath,
    outputPath,
    operations: [{ sheet: 'Sales', cell: 'E1', value: 'Status' }, { sheet: 'Sales', cell: 'E2', value: 'Review' }],
  })) as { status: string; operations: number; outputPath: string }
  expect(result.status).toBe('written')
  expect(result.operations).toBe(2)
  const edited = new ExcelJS.Workbook()
  await edited.xlsx.readFile(outputPath)
  expect(edited.getWorksheet('Sales')?.getCell('E2').value).toBe('Review')
  rmSync(outputPath, { force: true })
})

test('spreadsheet write rejects outputs outside the workspace or repository root', async () => {
  await expect(spreadsheetTool.execute({
    action: 'write',
    path: workbookPath,
    outputPath: '/tmp/elia-outside.xlsx',
    operations: [{ sheet: 'Sales', cell: 'E1', value: 'Blocked' }],
  })).rejects.toThrow('escapes the active workspace')
})
