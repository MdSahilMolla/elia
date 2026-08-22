import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as XLSX from 'xlsx'
import { readSpreadsheetTool } from './readSpreadsheet.ts'

let testDir: string
let fixturePath: string

beforeAll(() => {
  testDir = mkdtempSync(join(tmpdir(), 'elia-spreadsheet-test-'))
  fixturePath = join(testDir, 'budget.xlsx')

  const workbook = XLSX.utils.book_new()
  const revenue = XLSX.utils.aoa_to_sheet([
    ['month', 'revenue'],
    ['Jan', 1000],
    ['Feb', 1200],
  ])
  const costs = XLSX.utils.aoa_to_sheet([
    ['month', 'costs'],
    ['Jan', 400],
    ['Feb', 450],
  ])
  XLSX.utils.book_append_sheet(workbook, revenue, 'Revenue')
  XLSX.utils.book_append_sheet(workbook, costs, 'Costs')
  XLSX.writeFile(workbook, fixturePath)
})

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true })
})

test('read_spreadsheet throws on a missing file', async () => {
  await expect(readSpreadsheetTool.execute({ path: join(testDir, 'nope.xlsx') })).rejects.toThrow('File not found')
})

test('read_spreadsheet returns every sheet as CSV by default', async () => {
  const result = await readSpreadsheetTool.execute({ path: fixturePath })
  expect(result).toContain('## Sheet: Revenue')
  expect(result).toContain('Jan,1000')
  expect(result).toContain('## Sheet: Costs')
  expect(result).toContain('Feb,450')
})

test('read_spreadsheet returns only the requested sheet', async () => {
  const result = await readSpreadsheetTool.execute({ path: fixturePath, sheet: 'Costs' })
  expect(result).toContain('## Sheet: Costs')
  expect(result).not.toContain('Revenue')
})

test('read_spreadsheet throws on an unknown sheet name', async () => {
  await expect(readSpreadsheetTool.execute({ path: fixturePath, sheet: 'Nope' })).rejects.toThrow('Sheet(s) not found')
})
