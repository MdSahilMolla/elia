import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import ExcelJS from 'exceljs'
import { presentationTool } from './presentation.ts'

let testDir: string
let workbookPath: string

beforeAll(async () => {
  testDir = join(process.cwd(), 'workspace', `presentation-test-${process.pid}`)
  mkdirSync(testDir, { recursive: true })
  workbookPath = join(testDir, 'sales.xlsx')
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Sales')
  sheet.addRows([
    ['Region', 'Sales', 'Profit'],
    ['East', 1000, 200],
    ['West', 700, -50],
    ['North', 400, 80],
  ])
  await workbook.xlsx.writeFile(workbookPath)
})

afterAll(() => rmSync(testDir, { recursive: true, force: true }))

test('presentation creates an editable management deck and analysis sidecar from a workbook', async () => {
  const outputPath = join(testDir, 'sales-review.pptx')
  const result = JSON.parse(await presentationTool.execute({ action: 'from_workbook', path: workbookPath, outputPath, sheet: 'Sales', groupBy: 'Region', measure: 'Sales', title: 'Sales Review' })) as { outputPath: string; analysisPath: string; slides: number; status: string }
  expect(result.status).toBe('created')
  expect(result.slides).toBe(5)
  expect(result.outputPath).toBe(outputPath)
  expect(existsSync(outputPath)).toBe(true)
  expect(existsSync(result.analysisPath)).toBe(true)
  expect((await Bun.file(outputPath).arrayBuffer()).byteLength).toBeGreaterThan(10_000)
  expect(await Bun.file(result.analysisPath).text()).toContain('East')
  const verified = JSON.parse(await presentationTool.execute({ action: 'verify', path: outputPath })) as { validPackage: boolean; slides: number; status: string }
  expect(verified.validPackage).toBe(true)
  expect(verified.slides).toBe(5)
  expect(verified.status).toBe('pass')
})

test('presentation rejects output paths outside the current repository', async () => {
  await expect(presentationTool.execute({ action: 'from_workbook', path: workbookPath, outputPath: '/tmp/outside.pptx' })).rejects.toThrow('escapes the active workspace')
})
