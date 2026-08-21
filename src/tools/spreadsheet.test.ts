import { beforeAll, afterAll, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import * as XLSX from 'xlsx'
import { spreadsheetTool } from './spreadsheet.ts'

let testDir: string
let workbookPath: string

beforeAll(() => {
  testDir = mkdtempSync(join('/tmp', 'elia-spreadsheet-workflow-'))
  workbookPath = join(testDir, 'sales.xlsx')
  const workbook = XLSX.utils.book_new()
  const sheet = XLSX.utils.aoa_to_sheet([
    ['Order ID', 'Region', 'Sales', 'Profit', null, 'Computed'],
    ['A-1', 'East', 1000, 200],
    ['A-2', 'West', 700, -50],
    ['A-2', 'West', 300, 25],
  ])
  sheet.F2 = { t: 'n', v: 200, f: '=C2-D2' }
  sheet['!ref'] = 'A1:F4'
  XLSX.utils.book_append_sheet(workbook, sheet, 'Sales')
  XLSX.writeFile(workbook, workbookPath)
})

afterAll(() => rmSync(testDir, { recursive: true, force: true }))

test('spreadsheet inspect exposes sheet shape, numeric columns, formulas, and samples', async () => {
  const result = JSON.parse(await spreadsheetTool.execute({ action: 'inspect', path: workbookPath })) as { sheets: Array<{ name: string; rows: number; numericColumns: string[]; formulaCells: number; formulasWithoutCachedValue: number }> }
  expect(result.sheets[0]?.name).toBe('Sales')
  expect(result.sheets[0]?.rows).toBe(3)
  expect(result.sheets[0]?.numericColumns).toEqual(['Sales', 'Profit', 'Computed'])
  expect(result.sheets[0]?.formulaCells).toBe(1)
  expect(result.sheets[0]?.formulasWithoutCachedValue).toBe(0)
})

test('spreadsheet analyze computes grouped sums and selects the requested measure', async () => {
  const result = JSON.parse(await spreadsheetTool.execute({ action: 'analyze', path: workbookPath, sheet: 'Sales', groupBy: 'Region', measure: 'Sales' })) as { sheets: Array<{ summary: { sum: number }; groups: Array<{ group: string; count: number; sum: number }> }> }
  expect(result.sheets[0]?.summary.sum).toBe(2000)
  expect(result.sheets[0]?.groups).toEqual([
    { group: 'East', count: 1, sum: 1000 },
    { group: 'West', count: 2, sum: 1000 },
  ])
})

test('spreadsheet audit detects duplicate keys and reports formula counts', async () => {
  const result = JSON.parse(await spreadsheetTool.execute({ action: 'audit', path: workbookPath, sheet: 'Sales', keyColumn: 'Order ID' })) as { sheets: Array<{ duplicateKeys: number; formulaCells: number; formulasWithoutCachedValue: number; status: string }> }
  expect(result.sheets[0]?.duplicateKeys).toBe(1)
  expect(result.sheets[0]?.formulaCells).toBe(1)
  expect(result.sheets[0]?.formulasWithoutCachedValue).toBe(0)
  expect(result.sheets[0]?.status).toBe('review')
})

test('spreadsheet write creates an atomic output workbook with bounded cell edits', async () => {
  const outputPath = join(process.cwd(), 'workspace', `spreadsheet-test-${process.pid}.xlsx`)
  const result = JSON.parse(await spreadsheetTool.execute({
    action: 'write',
    path: workbookPath,
    outputPath,
    operations: [{ sheet: 'Sales', cell: 'E1', value: 'Status' }, { sheet: 'Sales', cell: 'E2', value: 'Review' }],
  })) as { status: string; operations: number; outputPath: string }
  expect(result.status).toBe('written')
  expect(result.operations).toBe(2)
  const edited = XLSX.read(readFileSync(outputPath), { type: 'buffer' })
  expect(edited.Sheets.Sales?.E2?.v).toBe('Review')
  rmSync(outputPath, { force: true })
})

test('spreadsheet write rejects outputs outside the workspace or repository root', async () => {
  await expect(spreadsheetTool.execute({
    action: 'write',
    path: workbookPath,
    outputPath: '/tmp/elia-outside.xlsx',
    operations: [{ sheet: 'Sales', cell: 'E1', value: 'Blocked' }],
  })).rejects.toThrow('must stay inside')
})
