import * as XLSX from 'xlsx'
import type { Tool } from './types.ts'
import { resolvePath } from '../autonomy/context.ts'

/** Real spreadsheet numbers for the Finance persona — .csv already works through read_file, this covers .xlsx/.xls. */
const MAX_SPREADSHEET_BYTES = 25_000_000

export const readSpreadsheetTool: Tool = {
  name: 'read_spreadsheet',
  description:
    'Read an Excel spreadsheet (.xlsx/.xls) and return its sheets as plain CSV-style text tables. For .csv files, use read_file directly instead.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the .xlsx or .xls file' },
      sheet: { type: 'string', description: 'Optional sheet name; defaults to all sheets' },
    },
    required: ['path'],
  },
  async execute(input) {
    if (typeof input.path !== 'string' || input.path.trim().length === 0) throw new Error('path must be a non-empty string')
    if (input.sheet !== undefined && (typeof input.sheet !== 'string' || input.sheet.trim().length === 0)) throw new Error('sheet must be a non-empty string when provided')
    const path = resolvePath(input.path)
    const requestedSheet = input.sheet as string | undefined

    const file = Bun.file(path)
    if (!(await file.exists())) throw new Error(`File not found: ${path}`)
    if (file.size > MAX_SPREADSHEET_BYTES) throw new Error(`spreadsheet exceeds ${MAX_SPREADSHEET_BYTES} bytes`)

    const bytes = new Uint8Array(await file.arrayBuffer())
    const workbook = XLSX.read(bytes, { type: 'array' })

    const sheetNames = requestedSheet ? [requestedSheet] : workbook.SheetNames
    const missing = sheetNames.filter((name) => !workbook.SheetNames.includes(name))
    if (missing.length > 0) {
      throw new Error(`Sheet(s) not found: ${missing.join(', ')}. Available: ${workbook.SheetNames.join(', ')}`)
    }

    return sheetNames
      .map((name) => {
        const sheet = workbook.Sheets[name]!
        const csv = XLSX.utils.sheet_to_csv(sheet).trim()
        return `## Sheet: ${name}\n${csv || '(empty)'}`
      })
      .join('\n\n')
  },
}
