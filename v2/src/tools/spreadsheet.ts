import * as XLSX from 'xlsx'
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { paths } from '../config.ts'
import type { Tool } from './types.ts'
import { resolvePath } from '../autonomy/context.ts'

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
  const root = resolve(resolvePath('.'))
  const candidate = path ? resolve(resolvePath(path)) : resolve(root, fallbackName)
  const workspace = resolve(paths.workspace)
  const inside = (base: string) => {
    const rel = relative(base, candidate)
    return rel === '' || (!rel.startsWith(`..${requireSeparator()}`) && rel !== '..' && !isAbsolute(rel))
  }
  if (!inside(root) && !inside(workspace)) throw new Error(`spreadsheet output must stay inside the current workspace: ${candidate}`)
  return candidate
}

function requireSeparator(): string {
  return process.platform === 'win32' ? '\\' : '/'
}

function ensureParent(path: string): void {
  mkdirSync(dirname(path), { recursive: true })
}

function atomicWriteWorkbook(workbook: XLSX.WorkBook, outputPath: string): void {
  ensureParent(outputPath)
  const temp = `${outputPath}.${process.pid}.${Date.now()}.tmp.xlsx`
  XLSX.writeFile(workbook, temp)
  renameSync(temp, outputPath)
}

function readWorkbook(path: string): XLSX.WorkBook {
  if (!existsSync(path)) throw new Error(`File not found: ${path}`)
  const size = Bun.file(path).size
  if (size > MAX_SPREADSHEET_BYTES) throw new Error(`spreadsheet exceeds ${MAX_SPREADSHEET_BYTES} bytes`)
  return XLSX.readFile(path, { cellFormula: true, cellNF: true, cellStyles: true })
}

function sheetData(workbook: XLSX.WorkBook, requestedSheet?: string): SheetData[] {
  const names = requestedSheet ? [requestedSheet] : workbook.SheetNames
  const missing = names.filter((name) => !workbook.SheetNames.includes(name))
  if (missing.length > 0) throw new Error(`Sheet(s) not found: ${missing.join(', ')}. Available: ${workbook.SheetNames.join(', ')}`)
  return names.map((name) => {
    const sheet = workbook.Sheets[name]!
    const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null, raw: true })
    const rawHeaders = (matrix[0] ?? []).map((header) => String(header ?? '').trim())
    const headers = rawHeaders.map((header, index) => header || `Column ${index + 1}`)
    const rows = matrix.slice(1).filter((row) => row.some((value) => value !== null && value !== '')).map((row) => {
      const output: Record<string, unknown> = {}
      headers.forEach((header, index) => { output[header] = row[index] ?? null })
      return output
    })
    let formulas = 0
    let formulasWithoutCachedValue = 0
    for (const cell of Object.values(sheet)) {
      if (cell && typeof cell === 'object' && 'f' in cell && typeof cell.f === 'string') {
        formulas += 1
        if (!('v' in cell) || cell.v === undefined || cell.v === null || cell.v === '') formulasWithoutCachedValue += 1
      }
    }
    return { name, rows, headers, formulas, formulasWithoutCachedValue }
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

function inspectWorkbook(workbook: XLSX.WorkBook, requestedSheet?: string): string {
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
      sample: sheet.rows.slice(0, MAX_SAMPLE_ROWS).map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, jsonValue(value)]))),
    })),
  }, null, 2)
}

function analyzeWorkbook(workbook: XLSX.WorkBook, requestedSheet?: string, requestedGroupBy?: string, requestedMeasure?: string): string {
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

function auditWorkbook(workbook: XLSX.WorkBook, requestedSheet?: string, keyColumn?: string): string {
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

function writeWorkbook(request: SpreadsheetRequest): string {
  const workbook = readWorkbook(request.path)
  const operations = request.operations ?? []
  if (operations.length === 0) throw new Error('write requires at least one cell operation')
  if (operations.length > 200) throw new Error('write accepts at most 200 cell operations per request')
  for (const operation of operations) {
    if (!operation || typeof operation.sheet !== 'string' || typeof operation.cell !== 'string') throw new Error('each operation requires sheet and cell')
    if (!workbook.SheetNames.includes(operation.sheet)) throw new Error(`Sheet not found: ${operation.sheet}`)
    const sheet = workbook.Sheets[operation.sheet]!
    sheet[operation.cell] = { t: typeof operation.value === 'number' ? 'n' : 's', v: operation.value }
    const range = XLSX.utils.decode_range(sheet['!ref'] ?? 'A1:A1')
    const cell = XLSX.utils.decode_cell(operation.cell)
    range.s.r = Math.min(range.s.r, cell.r)
    range.s.c = Math.min(range.s.c, cell.c)
    range.e.r = Math.max(range.e.r, cell.r)
    range.e.c = Math.max(range.e.c, cell.c)
    sheet['!ref'] = XLSX.utils.encode_range(range)
  }
  const outputPath = safeOutputPath(request.outputPath, 'edited-workbook.xlsx')
  atomicWriteWorkbook(workbook, outputPath)
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
  return { action: action as SpreadsheetAction, path: resolvePath(input.path.trim()), sheet: typeof input.sheet === 'string' ? input.sheet.trim() || undefined : undefined, groupBy: typeof input.groupBy === 'string' ? input.groupBy.trim() || undefined : undefined, measure: typeof input.measure === 'string' ? input.measure.trim() || undefined : undefined, keyColumn: typeof input.keyColumn === 'string' ? input.keyColumn.trim() || undefined : undefined, outputPath: typeof input.outputPath === 'string' ? input.outputPath.trim() || undefined : undefined, operations: operations as CellOperation[] | undefined }
}

export const spreadsheetTool: Tool = {
  name: 'spreadsheet',
  description: 'Work with local Excel workbooks through safe, auditable operations: inspect sheets, analyze numeric columns and grouped performance, audit formulas/data quality, or write bounded cell edits to a new workbook. Use this instead of shell scripts for routine spreadsheet work. Never claim a workbook is correct without checking the audit output.',
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['inspect', 'analyze', 'audit', 'write'] },
      path: { type: 'string', description: 'Input .xlsx/.xls workbook path' },
      sheet: { type: 'string', description: 'Optional sheet name' },
      groupBy: { type: 'string', description: 'Optional categorical column for grouped analysis' },
      measure: { type: 'string', description: 'Optional numeric measure column for analysis' },
      keyColumn: { type: 'string', description: 'Optional key column for duplicate detection during audit' },
      outputPath: { type: 'string', description: 'Write output path; must be inside the current workspace' },
      operations: { type: 'array', description: 'For write: up to 200 {sheet, cell, value} operations' },
    },
    required: ['action', 'path'],
  },
  async execute(input) {
    const request = validateSpreadsheetRequest(input)
    const workbook = readWorkbook(request.path)
    if (request.action === 'inspect') return inspectWorkbook(workbook, request.sheet)
    if (request.action === 'analyze') return analyzeWorkbook(workbook, request.sheet, request.groupBy, request.measure)
    if (request.action === 'audit') return auditWorkbook(workbook, request.sheet, request.keyColumn)
    return writeWorkbook(request)
  },
}

export { analyzeWorkbook, auditWorkbook, readWorkbook, safeOutputPath }
