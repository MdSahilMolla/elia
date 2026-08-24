import ExcelJS from 'exceljs'
import type { Tool } from './types.ts'
import { resolveWorkspacePath } from '../autonomy/context.ts'
import { assertSafeFileAccess } from '../autonomy/sensitivePaths.ts'

/** Real spreadsheet numbers for the Finance persona — .csv already works through read_file, this covers .xlsx files. */
const MAX_SPREADSHEET_BYTES = 25_000_000

export const readSpreadsheetTool: Tool = {
  name: 'read_spreadsheet',
  description:
    'Read an Excel .xlsx spreadsheet and return its sheets as plain CSV-style text tables. For .csv files, use read_file directly instead.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the .xlsx file' },
      sheet: { type: 'string', description: 'Optional sheet name; defaults to all sheets' },
    },
    required: ['path'],
  },
  async execute(input) {
    if (typeof input.path !== 'string' || input.path.trim().length === 0) throw new Error('path must be a non-empty string')
    if (input.sheet !== undefined && (typeof input.sheet !== 'string' || input.sheet.trim().length === 0)) throw new Error('sheet must be a non-empty string when provided')
    const path = resolveWorkspacePath(input.path)
    assertSafeFileAccess(path)
    const requestedSheet = input.sheet as string | undefined
    const file = Bun.file(path)
    if (!(await file.exists())) throw new Error(`File not found: ${path}`)
    if (file.size > MAX_SPREADSHEET_BYTES) throw new Error(`spreadsheet exceeds ${MAX_SPREADSHEET_BYTES} bytes`)

    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(await file.arrayBuffer())
    const sheetNames = requestedSheet ? [requestedSheet] : workbook.worksheets.map((worksheet) => worksheet.name)
    const missing = sheetNames.filter((name) => !workbook.getWorksheet(name))
    if (missing.length > 0) {
      throw new Error(`Sheet(s) not found: ${missing.join(', ')}. Available: ${workbook.worksheets.map((worksheet) => worksheet.name).join(', ')}`)
    }

    return sheetNames
      .map((name) => {
        const worksheet = workbook.getWorksheet(name)!
        const csv = worksheetToCsv(worksheet).trim()
        return `## Sheet: ${name}\n${csv || '(empty)'}`
      })
      .join('\n\n')
  },
}

function worksheetToCsv(worksheet: ExcelJS.Worksheet): string {
  const maxColumn = Math.max(worksheet.columnCount, 1)
  const rows: string[] = []
  for (let rowNumber = 1; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber)
    const values = Array.from({ length: maxColumn }, (_, index) => csvEscape(cellText(row.getCell(index + 1))))
    rows.push(values.join(','))
  }
  return rows.join('\n')
}

function cellText(cell: ExcelJS.Cell): string {
  const value = cell.value
  if (value instanceof Date) return value.toISOString()
  if (value && typeof value === 'object') {
    if ('result' in value) return scalarText(value.result)
    if ('text' in value && typeof value.text === 'string') return value.text
    if ('richText' in value) return cell.text
  }
  return scalarText(value)
}

function scalarText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  return String(value)
}

function csvEscape(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}
