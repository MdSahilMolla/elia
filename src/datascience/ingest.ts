import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import { resolveWorkspacePath } from '../autonomy/context.ts'
import { assertSafeFileAccess } from '../autonomy/sensitivePaths.ts'
import { publicFetch } from '../networkPolicy.ts'
import { pdfToText, thinExtractionReason } from '../tools/pdfText.ts'
import { frameFromRows, MAX_FRAME_ROWS, type Frame } from './frame.ts'
import { detectPython, requirementMessage, runPythonJob } from './python.ts'
import { assertReadOnlySql, isPlainIdentifier, quoteIdentifier } from './sqlguard.ts'
import { convertRaw, inferStringColumn, isoDate, isoDateTime, toScalar, type InferredColumn, type Row, type Scalar } from './values.ts'
import { datascienceRoot, type SourceRecord } from './workspace.ts'

/**
 * Universal ingestion. Every source ends as a typed {@link Frame} plus a {@link SourceRecord}
 * describing exactly what was read (path and hash, or table/query, or URL) — credentials are
 * referenced by environment-variable name and never stored or shown. Databases are opened
 * read-only and model-written SQL passes the read-only guard.
 */

export const FILE_FORMATS = ['csv', 'tsv', 'txt', 'json', 'jsonl', 'xlsx', 'xls', 'parquet', 'feather', 'arrow', 'avro', 'orc', 'xml', 'md', 'pdf', 'docx', 'sqlite'] as const
export const DATABASES = ['sqlite', 'postgres', 'mysql', 'redshift', 'duckdb', 'sqlserver', 'oracle', 'snowflake', 'bigquery'] as const

export interface LoadRequest {
  path?: string
  format?: string
  sheet?: string
  delimiter?: string
  table?: string
  query?: string
  /** Record element (XML), table index (DOCX/Markdown), or dot path to the record array (JSON/API). */
  recordPath?: string
  connection?: string
  dsnEnv?: string
  url?: string
  urlEnv?: string
  headers?: Record<string, string>
  params?: Record<string, string | number | boolean>
  pageParam?: string
  maxPages?: number
  allowLocal?: boolean
  limit?: number
  dayFirst?: boolean
  timeoutMs?: number
}

export interface LoadResult {
  frame: Frame
  source: SourceRecord
  warnings: string[]
  inference: Record<string, InferredColumn>
}

const MAX_FILE_BYTES = 1_000_000_000
const MAX_HTTP_BYTES = 100_000_000
const DEFAULT_ROW_LIMIT = 1_000_000

function rowLimit(request: LoadRequest): number {
  const limit = request.limit ?? DEFAULT_ROW_LIMIT
  if (!Number.isInteger(limit) || limit < 1) throw new Error('limit must be a positive integer')
  return Math.min(limit, MAX_FRAME_ROWS)
}

// ---------------------------------------------------------------- delimited text

/** RFC 4180 parser: quoted fields, doubled quotes, embedded newlines, CRLF. */
export function parseDelimited(text: string, delimiter: string, maxRecords = Number.POSITIVE_INFINITY): string[][] {
  const records: string[][] = []
  let record: string[] = []
  let field = ''
  let quoted = false
  let index = text.charCodeAt(0) === 0xfeff ? 1 : 0
  for (; index < text.length; index++) {
    const character = text[index]!
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"'
          index++
        } else quoted = false
      } else field += character
      continue
    }
    if (character === '"' && field.trim() === '') {
      quoted = true
      field = ''
    } else if (character === delimiter) {
      record.push(field)
      field = ''
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && text[index + 1] === '\n') index++
      record.push(field)
      if (record.length > 1 || record[0]!.trim() !== '') records.push(record)
      record = []
      field = ''
      if (records.length >= maxRecords) return records
    } else field += character
  }
  if (field !== '' || record.length > 0) {
    record.push(field)
    if (record.length > 1 || record[0]!.trim() !== '') records.push(record)
  }
  return records
}

/** Picks the delimiter whose per-line field count is most consistent across the first lines. */
export function sniffDelimiter(text: string): string {
  const sample = text.slice(0, 64_000)
  let best = ','
  let bestScore = -1
  for (const candidate of [',', '\t', ';', '|']) {
    const records = parseDelimited(sample, candidate, 30).slice(0, -1)
    if (records.length === 0) continue
    const counts = records.map((record) => record.length)
    const mode = counts.sort((a, b) => counts.filter((c) => c === b).length - counts.filter((c) => c === a).length)[0]!
    if (mode < 2) continue
    const consistency = records.filter((record) => record.length === mode).length / records.length
    const score = consistency * 100 + Math.min(mode, 50)
    if (score > bestScore) {
      bestScore = score
      best = candidate
    }
  }
  return best
}

function dedupeHeaders(raw: string[], warnings: string[]): string[] {
  const seen = new Map<string, number>()
  return raw.map((header, index) => {
    let name = header.trim() || `column_${index + 1}`
    if (header.trim() === '') warnings.push(`column ${index + 1} has no header; named "${name}"`)
    const count = seen.get(name) ?? 0
    seen.set(name, count + 1)
    if (count > 0) {
      const renamed = `${name}_${count + 1}`
      warnings.push(`duplicate header "${name}" renamed to "${renamed}"`)
      name = renamed
    }
    return name
  })
}

/** Types string records column by column (strict; see values.ts) and builds a frame. */
export function frameFromStringRecords(records: string[][], warnings: string[], options: { dayFirst?: boolean; limit?: number } = {}): { frame: Frame; inference: Record<string, InferredColumn>; truncated: boolean } {
  if (records.length === 0) throw new Error('the source has no rows (not even a header)')
  const headers = dedupeHeaders(records[0]!, warnings)
  const limit = options.limit ?? DEFAULT_ROW_LIMIT
  const body = records.slice(1, 1 + limit)
  const truncated = records.length - 1 > limit
  let short = 0
  let long = 0
  for (const record of body) {
    if (record.length < headers.length) short++
    else if (record.length > headers.length) long++
  }
  if (short) warnings.push(`${short} row(s) have fewer fields than the header; missing fields are null (possible corrupted records)`)
  if (long) warnings.push(`${long} row(s) have more fields than the header; extra fields were dropped (possible unquoted delimiters — corrupted records)`)
  const inference: Record<string, InferredColumn> = {}
  headers.forEach((header, column) => {
    const inferred = inferStringColumn(body.map((record) => record[column] ?? ''))
    if (options.dayFirst !== undefined && (inferred.type === 'date' || inferred.type === 'datetime')) inferred.dayFirst = options.dayFirst
    inference[header] = inferred
    if (inferred.ambiguousDateOrder && options.dayFirst === undefined) warnings.push(`"${header}" has dates like 03/04/2025 that could be day-first or month-first; read as month-first. Pass dayFirst: true if that is wrong.`)
  })
  const rows: Row[] = body.map((record) => {
    const row: Row = {}
    headers.forEach((header, column) => {
      row[header] = convertRaw(record[column] ?? '', inference[header]!)
    })
    return row
  })
  const types = Object.fromEntries(headers.map((header) => [header, inference[header]!.type === 'string' || inference[header]!.type === 'empty' ? inference[header]!.type : inference[header]!.type]))
  return { frame: frameFromRows(rows, headers, types), inference, truncated }
}

// ---------------------------------------------------------------- JSON

function flatten(value: unknown, prefix: string, out: Row, depth: number): void {
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date) && depth < 3) {
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) flatten(inner, prefix ? `${prefix}.${key}` : key, out, depth + 1)
    return
  }
  out[prefix || 'value'] = toScalar(value)
}

function atPath(value: unknown, path: string | undefined): unknown {
  if (!path) return value
  let current = value
  for (const part of path.split('.')) {
    if (current === null || typeof current !== 'object') throw new Error(`recordPath "${path}" does not exist in the response (stopped at "${part}")`)
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

export function rowsFromJson(value: unknown, recordPath?: string): Row[] {
  let records = atPath(value, recordPath)
  if (!recordPath && records && typeof records === 'object' && !Array.isArray(records)) {
    const arrays = Object.entries(records as Record<string, unknown>).filter(([, inner]) => Array.isArray(inner) && (inner as unknown[]).some((item) => item && typeof item === 'object'))
    if (arrays.length === 1) records = arrays[0]![1]
    else if (arrays.length > 1) throw new Error(`the JSON has several arrays of records (${arrays.map(([key]) => key).join(', ')}); pick one with recordPath`)
    else records = [records]
  }
  if (!Array.isArray(records)) throw new Error('JSON records must be an array (use recordPath to point at it)')
  return records.map((record) => {
    const row: Row = {}
    if (record && typeof record === 'object' && !Array.isArray(record)) flatten(record, '', row, 0)
    else row.value = toScalar(record)
    return row
  })
}

function typedFrame(rows: Row[], limit: number, warnings: string[]): { frame: Frame; truncated: boolean } {
  const truncated = rows.length > limit
  const kept = truncated ? rows.slice(0, limit) : rows
  // Strings that are strictly dates become typed date columns; nothing else is coerced.
  const frame = frameFromRows(kept)
  const mixed = frame.columns.filter((name) => {
    const kinds = new Set(kept.map((row) => row[name]).filter((value) => value !== null && value !== undefined).map((value) => typeof value))
    return kinds.size > 1
  })
  if (mixed.length) warnings.push(`column(s) with mixed JSON value types (kept as text): ${mixed.join(', ')}`)
  return { frame, truncated }
}

// ---------------------------------------------------------------- XML (no DTDs, no entity expansion beyond the five predefined)

interface XmlNode {
  name: string
  attributes: Record<string, string>
  children: XmlNode[]
  text: string
}

function decodeEntities(text: string): string {
  return text.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (_, entity: string) => {
    if (entity === 'lt') return '<'
    if (entity === 'gt') return '>'
    if (entity === 'amp') return '&'
    if (entity === 'quot') return '"'
    if (entity === 'apos') return "'"
    const code = entity.startsWith('#x') ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10)
    return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : ''
  })
}

export function parseXml(xml: string): XmlNode {
  if (/<!DOCTYPE[^>]*\[/i.test(xml) || /<!ENTITY/i.test(xml)) throw new Error('XML with an internal DTD or entity declarations is refused (entity-expansion and external-entity attacks)')
  const root: XmlNode = { name: '#document', attributes: {}, children: [], text: '' }
  const stack: XmlNode[] = [root]
  const pattern = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/\s*([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g
  let nodes = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(xml))) {
    const top = stack.at(-1)!
    if (match[1] !== undefined) top.text += match[1]
    else if (match[2] !== undefined) {
      if (stack.length > 1 && top.name === match[2]) stack.pop()
      else throw new Error(`malformed XML: unexpected </${match[2]}>`)
    } else if (match[3] !== undefined) {
      if (++nodes > 5_000_000) throw new Error('XML has more than 5,000,000 elements')
      const attributes: Record<string, string> = {}
      for (const attribute of (match[4] ?? '').matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attributes[attribute[1]!] = decodeEntities(attribute[2] ?? attribute[3] ?? '')
      const node: XmlNode = { name: match[3], attributes, children: [], text: '' }
      top.children.push(node)
      if (match[5] !== '/') {
        if (stack.length > 200) throw new Error('XML nesting exceeds 200 levels')
        stack.push(node)
      }
    } else if (match[6] !== undefined) top.text += decodeEntities(match[6])
  }
  if (stack.length !== 1) throw new Error(`malformed XML: <${stack.at(-1)!.name}> is never closed`)
  return root
}

function localName(name: string): string {
  return name.includes(':') ? name.split(':').pop()! : name
}

function findRecords(root: XmlNode, recordName?: string): XmlNode[] {
  if (recordName) {
    const found: XmlNode[] = []
    const walk = (node: XmlNode) => {
      for (const child of node.children) {
        if (child.name === recordName || localName(child.name) === recordName) found.push(child)
        else walk(child)
      }
    }
    walk(root)
    if (found.length === 0) throw new Error(`no <${recordName}> elements found`)
    return found
  }
  let best: XmlNode[] = []
  const walk = (node: XmlNode) => {
    const counts = new Map<string, XmlNode[]>()
    for (const child of node.children) counts.set(child.name, [...(counts.get(child.name) ?? []), child])
    for (const group of counts.values()) if (group.length > best.length) best = group
    for (const child of node.children) walk(child)
  }
  walk(root)
  if (best.length === 0) throw new Error('no repeated record elements found in the XML; pass recordPath with the record element name')
  return best
}

function xmlRecordToRow(node: XmlNode): Row {
  const row: Row = {}
  for (const [key, value] of Object.entries(node.attributes)) row[localName(key)] = value
  const walk = (current: XmlNode, prefix: string, depth: number) => {
    for (const child of current.children) {
      const key = prefix ? `${prefix}.${localName(child.name)}` : localName(child.name)
      for (const [attribute, value] of Object.entries(child.attributes)) row[`${key}.${localName(attribute)}`] = value
      if (child.children.length === 0 || depth >= 2) row[key] = (child.text || child.children.map((c) => c.text).join(' ')).trim()
      else walk(child, key, depth + 1)
    }
  }
  walk(node, '', 0)
  if (node.children.length === 0 && node.text.trim()) row.text = node.text.trim()
  return row
}

// ---------------------------------------------------------------- office documents

function cellValue(cell: ExcelJS.Cell, warnings: string[], sheet: string): Scalar {
  const value = cell.value
  if (value === null || value === undefined) return null
  if (value instanceof Date) {
    const ms = value.getTime()
    if (Number.isNaN(ms)) return null
    return value.getUTCHours() === 0 && value.getUTCMinutes() === 0 && value.getUTCSeconds() === 0 ? isoDate(ms) : isoDateTime(ms)
  }
  if (typeof value === 'object') {
    if ('error' in value) {
      warnings.push(`${sheet}!${cell.address} holds the Excel error ${String((value as { error: unknown }).error)}; read as missing`)
      return null
    }
    if ('result' in value) {
      const result = (value as { result: unknown }).result
      return result instanceof Date ? isoDate(result.getTime()) : toScalar(result)
    }
    if ('richText' in value) return cell.text
    if ('text' in value) return String((value as { text: unknown }).text)
  }
  return toScalar(value)
}

async function readXlsx(bytes: Uint8Array, sheetName: string | undefined, limit: number, warnings: string[]): Promise<{ frame: Frame; sheet: string; truncated: boolean }> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
  const sheets = workbook.worksheets.map((worksheet) => worksheet.name)
  const worksheet = sheetName ? workbook.getWorksheet(sheetName) : workbook.worksheets.find((candidate) => candidate.actualRowCount > 0)
  if (!worksheet) throw new Error(sheetName ? `sheet "${sheetName}" not found; sheets: ${sheets.join(', ')}` : 'the workbook has no non-empty sheet')
  if (!sheetName && sheets.length > 1) warnings.push(`workbook has ${sheets.length} sheets (${sheets.join(', ')}); read "${worksheet.name}". Pass sheet to read another.`)
  let headerRow = 0
  for (let r = 1; r <= Math.min(worksheet.rowCount, 20); r++) {
    const row = worksheet.getRow(r)
    if (row.actualCellCount > 0) {
      headerRow = r
      break
    }
  }
  if (!headerRow) throw new Error(`sheet "${worksheet.name}" is empty`)
  const width = worksheet.columnCount
  const header = dedupeHeaders(Array.from({ length: width }, (_, c) => String(cellValue(worksheet.getRow(headerRow).getCell(c + 1), warnings, worksheet.name) ?? '')), warnings)
  const rows: Row[] = []
  let truncated = false
  for (let r = headerRow + 1; r <= worksheet.rowCount; r++) {
    const excelRow = worksheet.getRow(r)
    if (excelRow.actualCellCount === 0) continue
    if (rows.length >= limit) {
      truncated = true
      break
    }
    const row: Row = {}
    header.forEach((name, c) => {
      row[name] = cellValue(excelRow.getCell(c + 1), warnings, worksheet.name)
    })
    rows.push(row)
  }
  if (worksheet.model.merges?.length) warnings.push(`sheet "${worksheet.name}" has ${worksheet.model.merges.length} merged cell range(s); only the top-left cell of each carries a value`)
  return { frame: frameFromRows(rows, header), sheet: worksheet.name, truncated }
}

async function readDocx(bytes: Uint8Array, tableIndex: string | undefined, warnings: string[]): Promise<Frame> {
  const zip = await JSZip.loadAsync(bytes)
  const document = zip.file('word/document.xml')
  if (!document) throw new Error('not a Word document (word/document.xml missing)')
  const root = parseXml(await document.async('string'))
  const textOf = (node: XmlNode): string => (localName(node.name) === 't' ? node.text : '') + node.children.map(textOf).join('')
  const tables: string[][][] = []
  const paragraphs: string[] = []
  const walk = (node: XmlNode, inTable: boolean) => {
    for (const child of node.children) {
      const name = localName(child.name)
      if (name === 'tbl') {
        tables.push(child.children.filter((row) => localName(row.name) === 'tr').map((row) => row.children.filter((cell) => localName(cell.name) === 'tc').map((cell) => textOf(cell).trim())))
        walk(child, true)
      } else if (name === 'p' && !inTable) {
        const text = textOf(child).trim()
        if (text) paragraphs.push(text)
      } else walk(child, inTable)
    }
  }
  walk(root, false)
  if (tableIndex !== undefined) {
    const table = tables[Number(tableIndex)]
    if (!table) throw new Error(`table ${tableIndex} not found; the document has ${tables.length} table(s)`)
    return frameFromStringRecords(table, warnings).frame
  }
  if (tables.length) warnings.push(`the document has ${tables.length} table(s); pass recordPath "0".."${tables.length - 1}" to load one as a dataset`)
  return frameFromRows(paragraphs.map((text, index) => ({ paragraph: index + 1, text })), ['paragraph', 'text'])
}

function markdownTables(text: string): string[][][] {
  const tables: string[][][] = []
  let current: string[][] = []
  const flush = () => {
    if (current.length >= 2) tables.push(current)
    current = []
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('|')) {
      flush()
      continue
    }
    const cells = trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim())
    if (cells.every((cell) => /^:?-{2,}:?$/.test(cell))) continue
    current.push(cells)
  }
  flush()
  return tables
}

// ---------------------------------------------------------------- Python-backed binary formats

const PYTHON_READER = `
import json
fmt = INPUT["format"]; path = INPUT["path"]; limit = INPUT["limit"]
if fmt in ("parquet", "feather", "arrow", "orc"):
    import pyarrow as pa
    if fmt == "parquet":
        import pyarrow.parquet as pq
        table = pq.read_table(path)
    elif fmt == "orc":
        import pyarrow.orc as orc
        table = orc.read_table(path)
    else:
        import pyarrow.feather as feather
        table = feather.read_table(path)
    total = table.num_rows
    table = table.slice(0, limit)
    columns = table.column_names
    types = {name: str(table.schema.field(name).type) for name in columns}
    data = [table.column(name).to_pylist() for name in columns]
    rows = [list(values) for values in zip(*data)] if data else []
elif fmt == "avro":
    import fastavro
    rows_dicts = []
    total = 0
    with open(path, "rb") as handle:
        for record in fastavro.reader(handle):
            total += 1
            if len(rows_dicts) < limit:
                rows_dicts.append(record)
    columns = list({key: None for record in rows_dicts for key in record}.keys())
    rows = [[record.get(name) for name in columns] for record in rows_dicts]
    types = {}
elif fmt == "xls":
    import pandas as pd
    frame = pd.read_excel(path, sheet_name=INPUT.get("sheet") or 0, engine="xlrd")
    total = len(frame)
    frame = frame.head(limit)
    columns = [str(c) for c in frame.columns]
    types = {str(c): str(t) for c, t in frame.dtypes.items()}
    rows = frame.astype(object).where(frame.notna(), None).values.tolist()
else:
    raise ValueError("unsupported format " + fmt)
emit({"columns": columns, "rows": rows, "types": types, "total": total})
`

const PYTHON_FORMAT_NEEDS: Record<string, string[]> = { parquet: ['pyarrow'], feather: ['pyarrow'], arrow: ['pyarrow'], orc: ['pyarrow'], avro: ['fastavro'], xls: ['pandas', 'xlrd'] }

async function readWithPython(format: string, path: string, request: LoadRequest, limit: number, warnings: string[]): Promise<{ frame: Frame; truncated: boolean }> {
  const runtime = await detectPython()
  const needs = PYTHON_FORMAT_NEEDS[format]!
  if (!runtime || needs.some((name) => !runtime.packages[name])) throw new Error(requirementMessage(`Reading .${format} files`, needs, runtime))
  const job = await runPythonJob({ code: PYTHON_READER, input: { format, path, limit, sheet: request.sheet ?? null }, timeoutMs: request.timeoutMs ?? 600_000 })
  if (!job.ok) throw new Error(`the Python ${format} reader failed: ${job.stderr.trim().split('\n').slice(-3).join(' ') || `exit ${job.exitCode}${job.timedOut ? ' (timed out)' : ''}`}`)
  const payload = job.result as { columns: string[]; rows: unknown[][]; types: Record<string, string>; total: number }
  const rows = payload.rows.map((values) => Object.fromEntries(payload.columns.map((name, index) => [name, toScalar(values[index])])))
  if (Object.keys(payload.types).length) warnings.push(`source types: ${Object.entries(payload.types).slice(0, 30).map(([name, type]) => `${name}:${type}`).join(', ')}`)
  return { frame: frameFromRows(rows, payload.columns), truncated: payload.total > limit }
}

// ---------------------------------------------------------------- files

export function detectFormat(path: string, bytes: Uint8Array, declared?: string): string {
  if (declared) {
    const normalized = declared.toLowerCase().replace(/^\./, '')
    if (normalized === 'ndjson') return 'jsonl'
    if (normalized === 'markdown') return 'md'
    if (normalized === 'excel') return 'xlsx'
    if (![...FILE_FORMATS].includes(normalized as (typeof FILE_FORMATS)[number])) throw new Error(`format must be one of ${FILE_FORMATS.join(', ')}`)
    return normalized
  }
  const ext = extname(path.replace(/\.gz$/i, '')).toLowerCase().slice(1)
  if (bytes[0] === 0x50 && bytes[1] === 0x41 && bytes[2] === 0x52 && bytes[3] === 0x31) return 'parquet'
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return 'pdf'
  if (String.fromCharCode(...bytes.slice(0, 15)) === 'SQLite format 3') return 'sqlite'
  if (bytes[0] === 0x4f && bytes[1] === 0x62 && bytes[2] === 0x6a && bytes[3] === 0x01) return 'avro'
  const map: Record<string, string> = { csv: 'csv', tsv: 'tsv', tab: 'tsv', txt: 'txt', json: 'json', jsonl: 'jsonl', ndjson: 'jsonl', xlsx: 'xlsx', xlsm: 'xlsx', xls: 'xls', parquet: 'parquet', pq: 'parquet', feather: 'feather', arrow: 'arrow', ipc: 'arrow', avro: 'avro', orc: 'orc', xml: 'xml', md: 'md', markdown: 'md', pdf: 'pdf', docx: 'docx', db: 'sqlite', sqlite: 'sqlite', sqlite3: 'sqlite' }
  const format = map[ext]
  if (!format) throw new Error(`cannot tell the format of ${basename(path)}; pass format (one of ${FILE_FORMATS.join(', ')})`)
  return format
}

async function loadFile(request: LoadRequest): Promise<LoadResult> {
  const path = resolveWorkspacePath(request.path!)
  assertSafeFileAccess(path)
  if (!existsSync(path)) throw new Error(`file not found: ${request.path}`)
  const size = statSync(path).size
  if (size > MAX_FILE_BYTES) throw new Error(`file is ${(size / 1e9).toFixed(2)} GB; the in-memory engine reads at most 1 GB — query it through a database (DuckDB/SQLite) or aggregate it first`)
  let bytes: Uint8Array = readFileSync(path)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (path.toLowerCase().endsWith('.gz')) bytes = gunzipSync(bytes)
  const format = detectFormat(path, bytes, request.format)
  const warnings: string[] = []
  const limit = rowLimit(request)
  const source: SourceRecord = { kind: 'file', format, path: request.path!, bytes: size, sha256, loadedAt: new Date().toISOString() }
  let frame: Frame
  let truncated = false
  let inference: Record<string, InferredColumn> = {}
  const text = () => new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  switch (format) {
    case 'csv':
    case 'tsv':
    case 'txt': {
      const content = text()
      if (content.includes('�')) warnings.push('the file is not valid UTF-8; undecodable bytes were replaced (check the encoding)')
      const delimiter = request.delimiter ?? (format === 'tsv' ? '\t' : sniffDelimiter(content))
      const firstLines = parseDelimited(content, delimiter, 5)
      if (format === 'txt' && firstLines.every((record) => record.length < 2)) {
        const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
        truncated = lines.length > limit
        frame = frameFromRows(lines.slice(0, limit).map((line, index) => ({ line: index + 1, text: line })), ['line', 'text'])
        break
      }
      if (delimiter !== ',' && format === 'csv') warnings.push(`delimiter detected as ${JSON.stringify(delimiter)}`)
      const parsed = frameFromStringRecords(parseDelimited(content, delimiter, limit + 2), warnings, { limit, ...(request.dayFirst !== undefined ? { dayFirst: request.dayFirst } : {}) })
      frame = parsed.frame
      inference = parsed.inference
      truncated = parsed.truncated
      source.options = { delimiter }
      break
    }
    case 'json': {
      const typed = typedFrame(rowsFromJson(JSON.parse(text()), request.recordPath), limit, warnings)
      frame = typed.frame
      truncated = typed.truncated
      break
    }
    case 'jsonl': {
      const lines = text().split(/\r?\n/).filter((line) => line.trim())
      const bad: number[] = []
      const rows: Row[] = []
      lines.slice(0, limit).forEach((line, index) => {
        try {
          rows.push(...rowsFromJson([JSON.parse(line)]))
        } catch {
          bad.push(index + 1)
        }
      })
      if (bad.length) warnings.push(`${bad.length} JSONL line(s) are not valid JSON and were skipped (corrupted records), e.g. line ${bad.slice(0, 5).join(', ')}`)
      const typed = typedFrame(rows, limit, warnings)
      frame = typed.frame
      truncated = lines.length > limit
      break
    }
    case 'xlsx': {
      const result = await readXlsx(bytes, request.sheet, limit, warnings)
      frame = result.frame
      truncated = result.truncated
      source.sheet = result.sheet
      break
    }
    case 'xml': {
      const records = findRecords(parseXml(text()), request.recordPath)
      truncated = records.length > limit
      const rows = records.slice(0, limit).map(xmlRecordToRow)
      const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))]
      const parsed = frameFromStringRecords([columns, ...rows.map((row) => columns.map((column) => String(row[column] ?? '')))], warnings, { limit })
      frame = parsed.frame
      inference = parsed.inference
      break
    }
    case 'md': {
      const tables = markdownTables(text())
      if (tables.length === 0) throw new Error('no Markdown pipe tables found')
      const index = request.recordPath === undefined ? 0 : Number(request.recordPath)
      if (!tables[index]) throw new Error(`table ${index} not found; the document has ${tables.length}`)
      if (tables.length > 1 && request.recordPath === undefined) warnings.push(`the document has ${tables.length} tables; loaded table 0 (pass recordPath to choose)`)
      const parsed = frameFromStringRecords(tables[index]!, warnings, { limit })
      frame = parsed.frame
      inference = parsed.inference
      break
    }
    case 'pdf': {
      const extraction = pdfToText(bytes)
      const reason = thinExtractionReason(extraction)
      if (reason) warnings.push(`PDF text extraction is thin: ${reason}`)
      const paragraphs = extraction.text.split(/\n{2,}/).map((paragraph) => paragraph.replace(/\s+/g, ' ').trim()).filter(Boolean)
      frame = frameFromRows(paragraphs.slice(0, limit).map((paragraph, index) => ({ paragraph: index + 1, text: paragraph })), ['paragraph', 'text'])
      warnings.push('PDF tables are not reconstructed from layout; text is loaded paragraph by paragraph. Verify any figure against the document.')
      break
    }
    case 'docx':
      frame = await readDocx(bytes, request.recordPath, warnings)
      break
    case 'sqlite':
      return loadSqlite({ ...request, path: request.path! }, path, sha256, size)
    default: {
      const result = await readWithPython(format, path, request, limit, warnings)
      frame = result.frame
      truncated = result.truncated
    }
  }
  if (truncated) {
    source.truncatedAt = limit
    warnings.push(`only the first ${limit} rows were loaded — this is not a random sample; conclusions may not generalise to the rest of the file`)
  }
  return { frame, source, warnings, inference }
}

// ---------------------------------------------------------------- databases

function rowsToFrame(rows: Array<Record<string, unknown>>): Frame {
  return frameFromRows(rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, toScalar(value)]))))
}

export function sqliteSchema(db: Database): Array<{ table: string; type: string; columns: Array<{ name: string; type: string; notnull: boolean; pk: boolean }>; foreignKeys: Array<{ from: string; table: string; to: string }>; rows: number | null }> {
  const tables = db.query("select name, type from sqlite_master where type in ('table','view') and name not like 'sqlite_%' order by name").all() as Array<{ name: string; type: string }>
  return tables.map(({ name, type }) => {
    const columns = (db.query(`pragma table_info(${quoteIdentifier(name)})`).all() as Array<{ name: string; type: string; notnull: number; pk: number }>).map((column) => ({ name: column.name, type: column.type, notnull: column.notnull === 1, pk: column.pk > 0 }))
    const foreignKeys = (db.query(`pragma foreign_key_list(${quoteIdentifier(name)})`).all() as Array<{ from: string; table: string; to: string }>).map((fk) => ({ from: fk.from, table: fk.table, to: fk.to }))
    let rows: number | null = null
    try {
      rows = (db.query(`select count(*) as n from ${quoteIdentifier(name)}`).get() as { n: number }).n
    } catch {
      rows = null
    }
    return { table: name, type, columns, foreignKeys, rows }
  })
}

function loadSqlite(request: LoadRequest, path: string, sha256: string, size: number): LoadResult {
  const db = new Database(path, { readonly: true })
  try {
    const warnings: string[] = []
    const limit = rowLimit(request)
    let query: string
    if (request.query) query = assertReadOnlySql(request.query)
    else if (request.table) {
      if (!isPlainIdentifier(request.table)) throw new Error('table must be a plain identifier')
      query = `select * from ${quoteIdentifier(request.table)}`
    } else {
      const schema = sqliteSchema(db)
      throw new Error(`name a table or pass a read-only query. Tables: ${schema.map((table) => `${table.table} (${table.rows ?? '?'} rows)`).join(', ')}`)
    }
    const rows = db.query(`select * from (${query}) limit ${limit + 1}`).all() as Array<Record<string, unknown>>
    const truncated = rows.length > limit
    const frame = rowsToFrame(rows.slice(0, limit))
    if (truncated) warnings.push(`only the first ${limit} rows were loaded (not a random sample)`)
    return { frame, source: { kind: 'sqlite', path: request.path!, bytes: size, sha256, ...(request.table ? { table: request.table } : {}), ...(request.query ? { query } : {}), loadedAt: new Date().toISOString(), ...(truncated ? { truncatedAt: limit } : {}) }, warnings, inference: {} }
  } finally {
    db.close()
  }
}

function credentialFromEnv(name: string | undefined, what: string): string {
  if (!name) throw new Error(`${what} needs dsnEnv: the NAME of an environment variable holding the connection string (the value is never passed through the model)`)
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) throw new Error('dsnEnv must be an environment variable name like WAREHOUSE_URL')
  const value = process.env[name]
  if (!value) throw new Error(`environment variable ${name} is not set; set it to the connection string in the environment elia runs in (or in .env) and retry`)
  return value
}

async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms) })])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Postgres/Redshift/MySQL through Bun.SQL, inside a READ ONLY transaction that is always rolled back. */
async function loadServerDatabase(request: LoadRequest): Promise<LoadResult> {
  const connection = request.connection!
  const dsn = credentialFromEnv(request.dsnEnv, `a ${connection} connection`)
  const { SQL } = await import('bun')
  const limit = rowLimit(request)
  let query: string
  if (request.query) query = assertReadOnlySql(request.query)
  else if (request.table) {
    if (!isPlainIdentifier(request.table)) throw new Error('table must be a plain identifier (schema.table allowed)')
    query = `select * from ${request.table.split('.').map(connection === 'mysql' ? (part: string) => `\`${part.replace(/`/g, '``')}\`` : quoteIdentifier).join('.')}`
  } else throw new Error('name a table or pass a read-only query; use ds_data action "schema" to list tables first')
  const sql = new SQL(connection === 'mysql' ? dsn : dsn.replace(/^redshift:/, 'postgres:'))
  const timeoutMs = request.timeoutMs ?? 120_000
  try {
    const reserved = await sql.reserve()
    try {
      if (connection === 'mysql') await reserved.unsafe('START TRANSACTION READ ONLY')
      else {
        await reserved.unsafe('BEGIN TRANSACTION READ ONLY')
        await reserved.unsafe(`SET LOCAL statement_timeout = ${Math.floor(timeoutMs)}`)
      }
      const rows = (await withTimeout(reserved.unsafe(`select * from (${query}) as elia_q limit ${limit + 1}`), timeoutMs, 'the query')) as Array<Record<string, unknown>>
      await reserved.unsafe('ROLLBACK')
      const truncated = rows.length > limit
      const warnings = truncated ? [`only the first ${limit} rows were returned (not a random sample); aggregate in SQL for full-population figures`] : []
      if (rows.length === 0) warnings.push('the query returned no rows; column names are unavailable for an empty result')
      return { frame: rowsToFrame([...rows].slice(0, limit)), source: { kind: connection === 'mysql' ? 'mysql' : 'postgres', credentialEnv: request.dsnEnv!, ...(request.table ? { table: request.table } : {}), query, loadedAt: new Date().toISOString(), ...(truncated ? { truncatedAt: limit } : {}), options: { connection } }, warnings, inference: {} }
    } finally {
      reserved.release()
    }
  } finally {
    await sql.close()
  }
}

const PYTHON_DB_READER = `
import os
kind = INPUT["connection"]; query = INPUT["query"]; limit = INPUT["limit"]; dsn = os.environ.get(INPUT["dsnEnv"], "")
if kind == "duckdb":
    import duckdb
    con = duckdb.connect(INPUT["path"], read_only=True)
    cur = con.execute("select * from (" + query + ") limit " + str(limit + 1))
elif kind == "sqlserver":
    import pyodbc
    con = pyodbc.connect(dsn, readonly=True, autocommit=False)
    cur = con.cursor(); cur.execute("select top " + str(limit + 1) + " * from (" + query + ") as elia_q")
elif kind == "oracle":
    import oracledb
    con = oracledb.connect(dsn)
    cur = con.cursor(); cur.execute("set transaction read only"); cur.execute("select * from (" + query + ") where rownum <= " + str(limit + 1))
elif kind == "snowflake":
    import snowflake.connector, json as _j
    con = snowflake.connector.connect(**_j.loads(dsn))
    cur = con.cursor(); cur.execute("select * from (" + query + ") limit " + str(limit + 1))
elif kind == "bigquery":
    from google.cloud import bigquery
    client = bigquery.Client(project=dsn or None)
    job = client.query("select * from (" + query + ") limit " + str(limit + 1), job_config=bigquery.QueryJobConfig(dry_run=False, use_query_cache=True))
    result = list(job.result())
    columns = [field.name for field in job.result().schema]
    emit({"columns": columns, "rows": [[row[c] for c in columns] for row in result]})
    raise SystemExit(0)
columns = [d[0] for d in cur.description]
rows = [list(r) for r in cur.fetchall()]
emit({"columns": columns, "rows": rows})
`

const DB_PACKAGES: Record<string, string> = { duckdb: 'duckdb', sqlserver: 'pyodbc', oracle: 'oracledb', snowflake: 'snowflake.connector', bigquery: 'google.cloud.bigquery' }

async function loadPythonDatabase(request: LoadRequest): Promise<LoadResult> {
  const connection = request.connection!
  const runtime = await detectPython()
  const pkg = DB_PACKAGES[connection]!
  if (!runtime?.packages[pkg]) throw new Error(requirementMessage(`A ${connection} connection`, [pkg], runtime))
  if (!request.query && !request.table) throw new Error('name a table or pass a read-only query')
  const query = request.query ? assertReadOnlySql(request.query) : `select * from ${request.table}`
  if (request.table && !isPlainIdentifier(request.table)) throw new Error('table must be a plain identifier')
  let path: string | undefined
  if (connection === 'duckdb') {
    if (!request.path) throw new Error('a DuckDB connection needs path to the .duckdb file')
    path = resolveWorkspacePath(request.path)
    assertSafeFileAccess(path)
  } else credentialFromEnv(request.dsnEnv, `a ${connection} connection`)
  const limit = rowLimit(request)
  const job = await runPythonJob({ code: PYTHON_DB_READER, input: { connection, query, limit, dsnEnv: request.dsnEnv ?? '', path: path ?? null }, passEnv: request.dsnEnv ? [request.dsnEnv] : [], timeoutMs: request.timeoutMs ?? 300_000 })
  if (!job.ok) throw new Error(`the ${connection} query failed: ${job.stderr.trim().split('\n').slice(-3).join(' ')}`)
  const payload = job.result as { columns: string[]; rows: unknown[][] }
  const truncated = payload.rows.length > limit
  const rows = payload.rows.slice(0, limit).map((values) => Object.fromEntries(payload.columns.map((name, index) => [name, toScalar(values[index])])))
  return { frame: frameFromRows(rows, payload.columns), source: { kind: 'python', query, ...(request.dsnEnv ? { credentialEnv: request.dsnEnv } : {}), ...(request.path ? { path: request.path } : {}), loadedAt: new Date().toISOString(), options: { connection }, ...(truncated ? { truncatedAt: limit } : {}) }, warnings: truncated ? [`only the first ${limit} rows were returned`] : [], inference: {} }
}

// ---------------------------------------------------------------- HTTP APIs and object storage

function substituteEnv(template: string): string {
  return template.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, name: string) => {
    const value = process.env[name]
    if (value === undefined) throw new Error(`environment variable ${name} referenced in a header is not set`)
    return value
  })
}

async function fetchBytes(url: string, request: LoadRequest): Promise<{ bytes: Uint8Array; contentType: string }> {
  const headers: Record<string, string> = { accept: 'application/json, text/csv;q=0.9, */*;q=0.5', 'user-agent': 'elia-datascience/1' }
  for (const [name, template] of Object.entries(request.headers ?? {})) {
    if (/[\r\n]/.test(name) || /[\r\n]/.test(template)) throw new Error('header names and values must not contain line breaks')
    if (!/\$\{[A-Z_][A-Z0-9_]*\}/.test(template) && /authorization|token|key|secret|cookie/i.test(name)) throw new Error(`header "${name}" looks like a credential; reference it from the environment as "\${ENV_VAR}" instead of putting the value in the call`)
    headers[name] = substituteEnv(template)
  }
  let current = url
  for (let redirect = 0; redirect < 4; redirect++) {
    const response = await publicFetch(current, { headers, policy: request.allowLocal ? { allowExplicitLocal: true } : {}, signal: AbortSignal.timeout(request.timeoutMs ?? 60_000) })
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      current = new URL(response.headers.get('location')!, current).toString()
      continue
    }
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(current).origin}${new URL(current).pathname}`)
    const declared = Number(response.headers.get('content-length') ?? 0)
    if (declared > MAX_HTTP_BYTES) throw new Error(`response is ${declared} bytes; the limit is ${MAX_HTTP_BYTES}`)
    const buffer = new Uint8Array(await response.arrayBuffer())
    if (buffer.byteLength > MAX_HTTP_BYTES) throw new Error(`response exceeds ${MAX_HTTP_BYTES} bytes`)
    return { bytes: buffer, contentType: response.headers.get('content-type') ?? '' }
  }
  throw new Error('too many redirects')
}

async function loadHttp(request: LoadRequest): Promise<LoadResult> {
  const base = request.urlEnv ? credentialFromEnv(request.urlEnv, 'urlEnv') : request.url!
  const warnings: string[] = []
  const limit = rowLimit(request)
  const rows: Row[] = []
  const pages = request.pageParam ? Math.min(Math.max(1, request.maxPages ?? 10), 100) : 1
  let lastType = ''
  let bytesTotal = 0
  const hash = createHash('sha256')
  for (let page = 1; page <= pages; page++) {
    const url = new URL(base)
    for (const [key, value] of Object.entries(request.params ?? {})) url.searchParams.set(key, String(value))
    if (request.pageParam) url.searchParams.set(request.pageParam, String(page))
    const { bytes, contentType } = await fetchBytes(url.toString(), request)
    hash.update(bytes)
    bytesTotal += bytes.byteLength
    lastType = contentType
    const text = new TextDecoder().decode(bytes)
    let pageRows: Row[]
    if (/json/i.test(contentType) || /^\s*[[{]/.test(text)) pageRows = rowsFromJson(JSON.parse(text), request.recordPath)
    else if (/csv|text\/plain/i.test(contentType)) {
      const records = parseDelimited(text, request.delimiter ?? sniffDelimiter(text))
      pageRows = frameFromStringRecords(records, warnings).frame.rows
    } else throw new Error(`unsupported response content type "${contentType}"; JSON or CSV is expected`)
    rows.push(...pageRows)
    if (pageRows.length === 0 || rows.length > limit) break
  }
  const typed = typedFrame(rows, limit, warnings)
  const shownUrl = request.urlEnv ? `\${${request.urlEnv}}` : (() => { const u = new URL(base); u.search = ''; return u.toString() })()
  return { frame: typed.frame, source: { kind: 'http', url: shownUrl, ...(request.urlEnv ? { credentialEnv: request.urlEnv } : {}), bytes: bytesTotal, sha256: hash.digest('hex'), loadedAt: new Date().toISOString(), options: { contentType: lastType, pages, params: request.params ?? {}, headers: Object.keys(request.headers ?? {}) }, ...(typed.truncated ? { truncatedAt: limit } : {}) }, warnings, inference: {} }
}

async function loadS3(request: LoadRequest): Promise<LoadResult> {
  const match = /^s3:\/\/([^/]+)\/(.+)$/.exec(request.url!)
  if (!match) throw new Error('S3 URLs look like s3://bucket/key')
  if (!process.env.S3_ACCESS_KEY_ID && !process.env.AWS_ACCESS_KEY_ID) throw new Error('S3 access needs credentials in the environment (AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, or S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY, plus S3_ENDPOINT for GCS/MinIO/R2)')
  const client = new Bun.S3Client({ bucket: match[1]!, ...(process.env.S3_ENDPOINT ? { endpoint: process.env.S3_ENDPOINT } : {}) })
  const file = client.file(match[2]!)
  const size = await file.size
  if (size > MAX_FILE_BYTES) throw new Error(`object is ${size} bytes; the limit is ${MAX_FILE_BYTES}`)
  const bytes = new Uint8Array(await file.arrayBuffer())
  const staging = join(datascienceRoot(), 'jobs')
  mkdirSync(staging, { recursive: true })
  const dir = mkdtempSync(join(staging, 's3-'))
  const local = join(dir, basename(match[2]!))
  writeFileSync(local, bytes)
  try {
    const result = await loadFile({ ...request, path: local, url: undefined })
    const { path: _staged, ...rest } = result.source
    void _staged
    result.source = { ...rest, kind: 's3', url: request.url! }
    return result
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Loads any supported source. */
export async function loadSource(request: LoadRequest): Promise<LoadResult> {
  const connection = request.connection?.toLowerCase()
  if (connection && connection !== 'file') {
    if (!(DATABASES as readonly string[]).includes(connection)) throw new Error(`connection must be one of ${DATABASES.join(', ')}`)
    if (connection === 'sqlite') {
      if (!request.path) throw new Error('a SQLite connection needs path to the database file')
      const path = resolveWorkspacePath(request.path)
      assertSafeFileAccess(path)
      if (!existsSync(path)) throw new Error(`database file not found: ${request.path}`)
      const bytes = readFileSync(path)
      return loadSqlite(request, path, createHash('sha256').update(bytes).digest('hex'), bytes.byteLength)
    }
    if (connection === 'postgres' || connection === 'redshift' || connection === 'mysql') return loadServerDatabase({ ...request, connection })
    return loadPythonDatabase({ ...request, connection })
  }
  if (request.url?.startsWith('s3://')) return loadS3(request)
  if (request.url || request.urlEnv) return loadHttp(request)
  if (request.path) return loadFile(request)
  throw new Error('load needs a path (file), a connection (database), or a url (REST API / s3://bucket/key)')
}

/** Lists tables and columns of a database source without loading data. */
export async function describeDatabase(request: LoadRequest): Promise<unknown> {
  const connection = (request.connection ?? 'sqlite').toLowerCase()
  if (connection === 'sqlite') {
    if (!request.path) throw new Error('schema of a SQLite database needs path')
    const path = resolveWorkspacePath(request.path)
    assertSafeFileAccess(path)
    const db = new Database(path, { readonly: true })
    try {
      return sqliteSchema(db)
    } finally {
      db.close()
    }
  }
  if (connection === 'postgres' || connection === 'redshift' || connection === 'mysql') {
    const query = connection === 'mysql'
      ? "select table_schema as schema_name, table_name, column_name, data_type, is_nullable from information_schema.columns where table_schema not in ('mysql','information_schema','performance_schema','sys') order by table_schema, table_name, ordinal_position"
      : "select table_schema as schema_name, table_name, column_name, data_type, is_nullable from information_schema.columns where table_schema not in ('pg_catalog','information_schema') order by table_schema, table_name, ordinal_position"
    const result = await loadServerDatabase({ ...request, connection, query, limit: 20_000 })
    const tables = new Map<string, Array<{ name: string; type: string; nullable: boolean }>>()
    for (const row of result.frame.rows) {
      const key = `${row.schema_name}.${row.table_name}`
      tables.set(key, [...(tables.get(key) ?? []), { name: String(row.column_name), type: String(row.data_type), nullable: row.is_nullable === 'YES' }])
    }
    return [...tables.entries()].map(([table, columns]) => ({ table, columns }))
  }
  throw new Error(`schema listing for ${connection} runs through a read-only query: load with query "select * from information_schema.columns" (or the dialect's catalog view)`)
}
