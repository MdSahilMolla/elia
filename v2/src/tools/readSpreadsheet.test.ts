import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ExcelJS from 'exceljs'
import { readSpreadsheetTool } from './readSpreadsheet.ts'
import { withAgentIdentity } from '../autonomy/context.ts'

let testDir: string
let fixturePath: string

beforeAll(async () => {
  testDir = mkdtempSync(join(tmpdir(), 'elia-spreadsheet-test-'))
  fixturePath = join(testDir, 'budget.xlsx')

  const workbook = new ExcelJS.Workbook()
  workbook.addWorksheet('Revenue').addRows([
    ['month', 'revenue'],
    ['Jan', 1000],
    ['Feb', 1200],
  ])
  workbook.addWorksheet('Costs').addRows([
    ['month', 'costs'],
    ['Jan', 400],
    ['Feb', 450],
  ])
  await workbook.xlsx.writeFile(fixturePath)
})

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true })
})

function executeReadSpreadsheet(input: Record<string, unknown>) {
  return withAgentIdentity({ name: 'test', role: 'lead', cwd: testDir }, () => readSpreadsheetTool.execute(input))
}

test('read_spreadsheet throws on a missing file', async () => {
  await expect(executeReadSpreadsheet({ path: join(testDir, 'nope.xlsx') })).rejects.toThrow('File not found')
})

test('read_spreadsheet returns every sheet as CSV by default', async () => {
  const result = await executeReadSpreadsheet({ path: fixturePath })
  expect(result).toContain('## Sheet: Revenue')
  expect(result).toContain('Jan,1000')
  expect(result).toContain('## Sheet: Costs')
  expect(result).toContain('Feb,450')
})

test('read_spreadsheet returns only the requested sheet', async () => {
  const result = await executeReadSpreadsheet({ path: fixturePath, sheet: 'Costs' })
  expect(result).toContain('## Sheet: Costs')
  expect(result).not.toContain('Revenue')
})

test('read_spreadsheet throws on an unknown sheet name', async () => {
  await expect(executeReadSpreadsheet({ path: fixturePath, sheet: 'Nope' })).rejects.toThrow('Sheet(s) not found')
})

test('read_spreadsheet validates inputs and resolves relative paths against the active agent cwd', async () => {
  await expect(executeReadSpreadsheet({})).rejects.toThrow('path must be a non-empty string')
  await expect(executeReadSpreadsheet({ path: fixturePath, sheet: 42 })).rejects.toThrow('sheet must be a non-empty string')
  const result = await executeReadSpreadsheet({ path: 'budget.xlsx', sheet: 'Revenue' })
  expect(result).toContain('Jan,1000')
})
