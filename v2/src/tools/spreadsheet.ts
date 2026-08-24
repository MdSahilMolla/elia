import ExcelJS from 'exceljs'
import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Tool } from './types.ts'
import { resolveAllowedWorkspacePath } from '../autonomy/context.ts'
import { assertSafeFileAccess } from '../autonomy/sensitivePaths.ts'
import { paths } from '../config.ts'

type SpreadsheetAction = 'inspect' | 'analyze' | 'audit' | 'write'
type CellOperation = { sheet: string; cell: string; value: unknown }

interface SpreadsheetRequest {
  action: SpreadsheetAction
  path: string
  sheet?: string
  groupBy?: string
  measure?: string
  keyColumn?: string
  outputPath?: string
  operations?: CellOperation[]
}

interface SheetData {
  name: string
  rows: Record<string, unknown>[]
  headers: string[]
  formulas: number
  formulasWithoutCachedValue: number
}

const MAX_SAMPLE_ROWS = 5
const MAX_GROUP_ROWS = 100
const MAX_SPREADSHEET_BYTES = 25_000_000

function safeOutputPath(path: string | undefined, fallbackName: string): string {
  return resolveAllowedWorkspacePath(path ?? fallbackName, undefined, [paths.workspace])
}

function ensureParent(path: string): void {
  mkdirSync(dirname(path), { recursive: true })
}

async function atomicWriteWorkbook(workbook: ExcelJS.Workbook, outputPath: string): Promise<void> {
  ensureParent(outputPath)
  const temporary = `${outputPath}.${process.pid}.${Date.now()}.tmp.xlsx`
  const buffer = await workbook.xlsx.writeBuffer()
  await Bun.write(temporary, buffer)
  renameSync(temporary, outputPath)
}

async function readWorkbook(path: string): Promise<ExcelJS.Workbook> {
  assertSafeFileAccess(path)
  if (!existsSync(path)) throw new Error(`File not found: ${path}`)
  const size = Bun.file(path).size
  if (size > MAX_SPREADSHEET_BYTES) throw new Error(`spreadsheet exceeds ${MAX_SPREADSHEET_BYTES} bytes`)
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(path)
  return workbook
}

function valueForModel(cell: ExcelJS.Cell): unknown {
  const value = cell.value
  if (value && typeof value === 'object') {
    if ('formula' in value) return 'result' in value ? value.result : null
    if ('text' in value && typeof value.text === 'string') return value.text
    if ('richText' in value) return cell.text
  }
  return value
}

function sheetData(workbook: ExcelJS.Workbook, requestedSheet?: string): SheetData[] {
  const worksheets = requestedSheet ? [workbook.getWorksheet(requestedSheet)].filter((sheet): sheet is ExcelJS.Worksheet => Boolean(sheet)) : workbook.worksheets
  if (worksheets.length === 0) {
    const available = workbook.worksheets.map((sheet) => sheet.name).join(', ')
    throw new Error(`Sheet(s) not found: ${requestedSheet ?? '(none)'}. Available: ${available}`)
  }
  if (requestedSheet && worksheets.length !== 1) throw new Error(`Sheet(s) not found: ${requestedSheet}`)

  return worksheets.map((worksheet) => {
    const maxColumn = Math.max(worksheet.columnCount, 1)
    const headerRow = worksheet.getRow(1)
    const rawHeaders = Array.from({ length: maxColumn }, (_, index) => String(valueForModel(headerRow.getCell(index + 1)) ?? '').trim())
    const headers = rawHeaders.map((header, index) => header || `Column ${index + 1}`)
    const rows: Record<string, unknown>[] = []
    for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber += 1) {
      const row = worksheet.getRow(rowNumber)
      const output: Record<string, unknown> = {}
      let populated = false
      headers.forEach((header, index) => {
        const value = jsonValue(valueForModel(row.getCell(index + 1)))
        if (value !== null && value !== undefined && value !== '') populated = true
        output[header] = value
      })
      if (populated) rows.push(output)
    }

    let formulas = 0
    let formulasWithoutCachedValue = 0
    for (let rowNumber = 1; rowNumber <= worksheet.rowCount; rowNumber += 1) {
      const row = worksheet.getRow(rowNumber)
      for (let columnNumber = 1; columnNumber <= maxColumn; columnNumber += 1) {
        const cell = row.getCell(columnNumber)
        if (typeof cell.formula === 'string' && cell.formula.length > 0) {
          formulas += 1
          const result = cell.result
          if (result === undefined || result === null || result === '') formulasWithoutCachedValue += 1
        }
      }
    }
    return { name: worksheet.name, rows, headers, formulas, formulasWithoutCachedValue }
  })
}

function numeric(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function numericColumns(data: SheetData): string[] {
  return data.headers.filter((header) => data.rows.some((row) => numeric(row[header])))
}

function jsonValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString()
  return value
}

function inspectWorkbook(workbook: ExcelJS.Workbook, requestedSheet?: string): string {
  const sheets = sheetData(workbook, requestedSheet)
  return JSON.stringify({
    action: 'inspect',
    sheets: sheets.map((sheet) => ({
      name: sheet.name,
      rows: sheet.rows.length,
      columns: sheet.headers,
      numericColumns: numericColumns(sheet),
      formulaCells: sheet.formulas,
      formulasWithoutCachedValue: sheet.formulasWithoutCachedValue,
      sample: sheet.rows.slice(0, MAX_SAMPLE_ROWS),
    })),
  }, null, 2)
}

function analyzeWorkbook(workbook: ExcelJS.Workbook, requestedSheet?: string, requestedGroupBy?: string, requestedMeasure?: string): string {
  const sheets = sheetData(workbook, requestedSheet)
  const analyses = sheets.map((sheet) => {
    const numbers = numericColumns(sheet)
    const measure = requestedMeasure && sheet.headers.includes(requestedMeasure) ? requestedMeasure : numbers.find((name) => /sales|revenue|profit|amount|cost|value|total/i.test(name)) ?? numbers[0]
    const groupBy = requestedGroupBy && sheet.headers.includes(requestedGroupBy) ? requestedGroupBy : sheet.headers.find((name) => !numbers.includes(name))
    const summary = measure ? (() => {
      const values = sheet.rows.map((row) => row[measure]).filter(numeric)
      return {
        column: measure,
        count: values.length,
        sum: values.reduce((total, value) => total + value, 0),
        average: values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0,
        min: values.length ? Math.min(...values) : undefined,
        max: values.length ? Math.max(...values) : undefined,
      }
    })() : undefined
    const groups = measure && groupBy ? Object.entries(sheet.rows.reduce<Record<string, { count: number; sum: number }>>((acc, row) => {
      const key = String(row[groupBy] ?? '(blank)')
      const current = acc[key] ?? { count: 0, sum: 0 }
      current.count += 1
      if (numeric(row[measure])) current.sum += row[measure]
      acc[key] = current
      return acc
    }, {})).sort(([, a], [, b]) => b.sum - a.sum).slice(0, MAX_GROUP_ROWS).map(([group, value]) => ({ group, ...value })) : []
    return {
      sheet: sheet.name,
      rows: sheet.rows.length,
      columns: sheet.headers,
      numericColumns: numbers,
      selectedMeasure: measure,
      selectedGroupBy: groupBy,
      summary,
      groups,
      formulaCells: sheet.formulas,
      formulasWithoutCachedValue: sheet.formulasWithoutCachedValue,
    }
  })
  return JSON.stringify({ action: 'analyze', sheets: analyses }, null, 2)
}

function auditWorkbook(workbook: ExcelJS.Workbook, requestedSheet?: string, keyColumn?: string): string {
  const sheets = sheetData(workbook, requestedSheet)
  return JSON.stringify({
    action: 'audit',
    sheets: sheets.map((sheet) => {
      const duplicateKeys = keyColumn && sheet.headers.includes(keyColumn)
        ? sheet.rows.length - new Set(sheet.rows.map((row) => String(row[keyColumn] ?? ''))).size
        : undefined
      const blankHeaders = sheet.headers.filter((header) => /^Column \d+$/.test(header))
      const blankValues = Object.fromEntries(sheet.headers.map((header) => [header, sheet.rows.filter((row) => row[header] === null || row[header] === '').length]))
      return {
        sheet: sheet.name,
        rows: sheet.rows.length,
        columns: sheet.headers.length,
        blankHeaders,
        blankValues,
        formulaCells: sheet.formulas,
        formulasWithoutCachedValue: sheet.formulasWithoutCachedValue,
        duplicateKeys,
        keyColumn,
        status: blankHeaders.length === 0 && (duplicateKeys === undefined || duplicateKeys === 0) ? 'pass' : 'review',
      }
    }),
  }, null, 2)
}

function cellValue(value: unknown): ExcelJS.CellValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value instanceof Date) return value
  throw new Error('spreadsheet cell values must be strings, numbers, booleans, dates, or null')
}

async function writeWorkbook(request: SpreadsheetRequest): Promise<string> {
  const workbook = await readWorkbook(request.path)
  const operations = request.operations ?? []
  if (operations.length === 0) throw new Error('write requires at least one cell operation')
  if (operations.length > 200) throw new Error('write accepts at most 200 cell operations per request')
  for (const operation of operations) {
    if (!operation || typeof operation.sheet !== 'string' || typeof operation.cell !== 'string') throw new Error('each operation requires sheet and cell')
    const worksheet = workbook.getWorksheet(operation.sheet)
    if (!worksheet) throw new Error(`Sheet not found: ${operation.sheet}`)
    worksheet.getCell(operation.cell).value = cellValue(operation.value)
  }
  const outputPath = safeOutputPath(request.outputPath, 'edited-workbook.xlsx')
  await atomicWriteWorkbook(workbook, outputPath)
  return JSON.stringify({ action: 'write', outputPath, operations: operations.length, status: 'written' }, null, 2)
}

export function validateSpreadsheetRequest(input: Record<string, unknown>): SpreadsheetRequest {
  const action = input.action
  if (typeof action !== 'string' || !['inspect', 'analyze', 'audit', 'write'].includes(action)) throw new Error('action must be one of inspect, analyze, audit, or write')
  if (typeof input.path !== 'string' || input.path.trim().length === 0) throw new Error('path must be a non-empty string')
  if (input.sheet !== undefined && (typeof input.sheet !== 'string' || input.sheet.trim().length === 0)) throw new Error('sheet must be a non-empty string when provided')
  if (input.groupBy !== undefined && typeof input.groupBy !== 'string') throw new Error('groupBy must be a string')
  if (input.measure !== undefined && typeof input.measure !== 'string') throw new Error('measure must be a string')
  if (input.keyColumn !== undefined && typeof input.keyColumn !== 'string') throw new Error('keyColumn must be a string')
  if (input.outputPath !== undefined && (typeof input.outputPath !== 'string' || input.outputPath.trim().length === 0)) throw new Error('outputPath must be a non-empty string when provided')
  const operations = input.operations
  if (action === 'write' && (!Array.isArray(operations) || operations.length === 0)) throw new Error('write requires a non-empty operations array')
  if (operations !== undefined && !Array.isArray(operations)) throw new Error('operations must be an array')
  return { action: action as SpreadsheetAction, path: resolveAllowedWorkspacePath(input.path.trim(), undefined, [paths.workspace]), sheet: typeof input.sheet === 'string' ? input.sheet.trim() || undefined : undefined, groupBy: typeof input.groupBy === 'string' ? input.groupBy.trim() || undefined : undefined, measure: typeof input.measure === 'string' ? input.measure.trim() || undefined : undefined, keyColumn: typeof input.keyColumn === 'string' ? input.keyColumn.trim() || undefined : undefined, outputPath: typeof input.outputPath === 'string' ? input.outputPath.trim() || undefined : undefined, operations: operations as CellOperation[] | undefined }
}

export const spreadsheetTool: Tool = {
  name: 'spreadsheet',
  description: 'Work with local Excel workbooks through safe, auditable operations: inspect sheets, analyze numeric columns and grouped performance, audit formulas/data quality, or write bounded cell edits to a new workbook. Use this instead of shell scripts for routine spreadsheet work. Never claim a workbook is correct without checking the audit output.',
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['inspect', 'analyze', 'audit', 'write'] },
      path: { type: 'string', description: 'Input .xlsx/.xls workbook path inside the active or designated workspace' },
      sheet: { type: 'string', description: 'Optional sheet name' },
      groupBy: { type: 'string', description: 'Optional categorical column for grouped analysis' },
      measure: { type: 'string', description: 'Optional numeric measure column for analysis' },
      keyColumn: { type: 'string', description: 'Optional key column for duplicate detection during audit' },
      outputPath: { type: 'string', description: 'Write output path; must be inside the active or designated workspace' },
      operations: { type: 'array', description: 'For write: up to 200 {sheet, cell, value} operations' },
    },
    required: ['action', 'path'],
  },
  async execute(input) {
    const request = validateSpreadsheetRequest(input)
    const workbook = await readWorkbook(request.path)
    if (request.action === 'inspect') return inspectWorkbook(workbook, request.sheet)
    if (request.action === 'analyze') return analyzeWorkbook(workbook, request.sheet, request.groupBy, request.measure)
    if (request.action === 'audit') return auditWorkbook(workbook, request.sheet, request.keyColumn)
    return writeWorkbook(request)
  },
}

export { analyzeWorkbook, auditWorkbook, readWorkbook, safeOutputPath }
