/**
 * Moving rows in and out: a read query written to CSV / JSON / JSON Lines in
 * the workspace (export), and a file of rows loaded into a table (import).
 *
 * An import is one transaction — every row lands or none does — with the
 * table's own column types applied on the way in, so "42" becomes an integer
 * in an integer column instead of an error. `create` makes the table first,
 * with types inferred from the data; `truncate` empties it first, after the
 * backup every destructive action takes.
 */

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { extname } from 'node:path'
import { resolveWorkspacePath } from '../autonomy/context.ts'
import { assertSafeFileAccess } from '../autonomy/sensitivePaths.ts'
import { backupBeforeDestroying } from './backup.ts'
import { connectionProblem, formatBytes, numberOf, parseQualifiedName, qualifiedIdent, queryRows, quoteIdent, targetLine, type DbContext, type QualifiedName } from './common.ts'
import { classifySql, withSqlSession, type SqlSession } from './sql.ts'
import type { DatabaseEngine } from './url.ts'

type Format = 'csv' | 'tsv' | 'json' | 'jsonl'

function formatOf(input: Record<string, unknown>, path: string): Format | undefined {
  const declared = typeof input.format === 'string' ? input.format.toLowerCase() : ''
  if (declared === 'csv' || declared === 'tsv' || declared === 'json' || declared === 'jsonl') return declared
  if (declared === 'ndjson') return 'jsonl'
  const extension = extname(path).toLowerCase()
  if (extension === '.tsv' || extension === '.tab') return 'tsv'
  if (extension === '.json') return 'json'
  if (extension === '.jsonl' || extension === '.ndjson') return 'jsonl'
  if (extension === '.csv' || extension === '.txt' || extension === '') return 'csv'
  return undefined
}

function workspaceFile(root: string, file: string): string {
  const path = resolveWorkspacePath(file, root)
  assertSafeFileAccess(path)
  return path
}

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------

function plain(value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
  if (value instanceof Uint8Array) return `\\x${Buffer.from(value).toString('hex')}`
  if (typeof value === 'bigint') return value.toString()
  return value
}

function csvField(value: unknown, delimiter: string): string {
  if (value === null || value === undefined) return ''
  const structured = typeof value === 'object' && !(value instanceof Date) && !(value instanceof Uint8Array)
  const text = structured ? JSON.stringify(value, (_key, inner: unknown) => plain(inner)) : String(plain(value))
  return text.includes(delimiter) || /["\r\n]/.test(text) || text !== text.trim() ? `"${text.replace(/"/g, '""')}"` : text
}

export async function exportRows(ctx: DbContext, input: Record<string, unknown>): Promise<string> {
  const sql = typeof input.sql === 'string' ? input.sql.trim() : ''
  const file = typeof input.file === 'string' ? input.file.trim() : ''
  if (!sql || !file) return 'export needs `sql` (a query that reads) and `file` (where to write, inside the workspace).'
  if (classifySql(sql, ctx.engine) !== 'read') return 'export takes a query that only reads (SELECT / WITH … SELECT). Change data with query, then export the result.'
  let path: string
  try {
    path = workspaceFile(ctx.root, file)
  } catch (error) {
    return `export: ${error instanceof Error ? error.message : String(error)}`
  }
  if (existsSync(path) && input.overwrite !== true) return `export: ${file} already exists. Pick a new file, or pass overwrite: true to replace it.`
  const format = formatOf(input, path)
  if (!format) return `export: cannot tell the format of ${file}; pass format: csv, tsv, json or jsonl.`
  return withSqlSession(ctx.target.url, { readOnly: true, statementTimeoutMs: 1_800_000 }, async (session) => {
    const problem = await connectionProblem(session, ctx.target)
    if (problem) return problem
    const result = await session.run(sql, { timeoutMs: 1_800_000 })
    if (!result.ok) return `${targetLine(ctx.target)}\nexport query failed: ${result.error ?? 'unknown error'}`
    const rows = result.statements.at(-1)?.rows ?? []
    const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))]
    let body: string
    if (format === 'json') body = `${JSON.stringify(rows, (_key, value: unknown) => plain(value), 2)}\n`
    else if (format === 'jsonl') body = rows.map((row) => JSON.stringify(row, (_key, value: unknown) => plain(value))).join('\n') + (rows.length ? '\n' : '')
    else {
      const delimiter = format === 'tsv' ? '\t' : ','
      body = [columns.map((column) => csvField(column, delimiter)).join(delimiter), ...rows.map((row) => columns.map((column) => csvField(row[column], delimiter)).join(delimiter))].join('\n') + '\n'
    }
    writeFileSync(path, body)
    return `${targetLine(ctx.target)}\nexported ${rows.length} row(s) × ${columns.length} column(s) to ${path} (${format}, ${formatBytes(statSync(path).size)})${columns.length ? `\ncolumns: ${columns.join(', ')}` : ''}`
  })
}

// ---------------------------------------------------------------------------
// import
// ---------------------------------------------------------------------------

const MAX_IMPORT_BYTES = 200 * 1024 * 1024

interface Parsed {
  columns: string[]
  rows: unknown[][]
}

async function parseFile(path: string, format: Format): Promise<Parsed> {
  const text = readFileSync(path, 'utf8')
  if (format === 'csv' || format === 'tsv') {
    const { parseDelimited, sniffDelimiter } = await import('../datascience/ingest.ts')
    const records = parseDelimited(text, format === 'tsv' ? '\t' : sniffDelimiter(text))
    const [header, ...body] = records
    if (!header || header.length === 0) throw new Error('the file has no header row')
    const columns = header.map((name) => name.trim())
    // An empty field is a missing value, the way every CSV writer means it.
    return { columns, rows: body.map((record) => columns.map((_column, index) => (record[index] === undefined || record[index] === '' ? null : record[index]))) }
  }
  const objects: unknown[] = format === 'jsonl'
    ? text.split(/\r?\n/).filter((line) => line.trim()).map((line, index) => {
        try {
          return JSON.parse(line)
        } catch {
          throw new Error(`line ${index + 1} is not valid JSON`)
        }
      })
    : (() => {
        const parsed = JSON.parse(text) as unknown
        if (Array.isArray(parsed)) return parsed
        const nested = parsed && typeof parsed === 'object' ? Object.values(parsed as Record<string, unknown>).find(Array.isArray) : undefined
        if (nested) return nested as unknown[]
        throw new Error('the JSON is not an array of objects')
      })()
  const records = objects.filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object' && !Array.isArray(item))
  if (records.length !== objects.length) throw new Error('every item must be an object ({"column": value, …})')
  const columns = [...new Set(records.flatMap((record) => Object.keys(record)))]
  return { columns, rows: records.map((record) => columns.map((column) => record[column] ?? null)) }
}

interface TableColumn {
  name: string
  type: string
}

async function tableColumns(session: SqlSession, engine: DatabaseEngine, table: QualifiedName): Promise<{ columns: TableColumn[]; error?: string }> {
  const found = engine === 'sqlite'
    ? await queryRows(session, 'SELECT name, type FROM pragma_table_info(?)', [table.name])
    : engine === 'mysql'
      ? await queryRows(session, 'SELECT column_name AS name, column_type AS type FROM information_schema.columns WHERE table_schema = COALESCE(?, DATABASE()) AND table_name = ? ORDER BY ordinal_position', [table.schema ?? null, table.name])
      : await queryRows(session, 'SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type FROM pg_attribute a WHERE a.attrelid = to_regclass($1) AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum', [qualifiedIdent(table, 'postgres')])
  return { columns: found.rows.map((row) => ({ name: String(row.name), type: String(row.type ?? '') })), error: found.error }
}

/** A column name a created table can use without quoting: `First Name` → `first_name`. */
export function columnName(name: string): string {
  const base = name.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60)
  return !base ? 'column' : /^[0-9]/.test(base) ? `c_${base}` : base
}

const INTEGER = /^-?\d{1,18}$/
const DECIMAL = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/
const BOOLEAN = /^(?:true|false)$/i
const DATE = /^\d{4}-\d{2}-\d{2}$/
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?$/

/** The narrowest column type every value fits, per engine. */
export function inferColumnType(values: readonly unknown[], engine: DatabaseEngine): string {
  const present = values.filter((value) => value !== null && value !== undefined && value !== '')
  const types = { integer: engine === 'sqlite' ? 'INTEGER' : 'bigint', decimal: engine === 'sqlite' ? 'REAL' : engine === 'mysql' ? 'double' : 'numeric', boolean: engine === 'sqlite' ? 'INTEGER' : 'boolean', date: engine === 'sqlite' ? 'TEXT' : 'date', timestamp: engine === 'sqlite' ? 'TEXT' : engine === 'mysql' ? 'datetime' : 'timestamptz', json: engine === 'sqlite' ? 'TEXT' : engine === 'mysql' ? 'json' : 'jsonb', text: engine === 'sqlite' ? 'TEXT' : 'text' }
  if (present.length === 0) return types.text
  if (present.some((value) => typeof value === 'object')) return types.json
  const texts = present.map((value) => String(value))
  if (present.every((value) => typeof value === 'boolean') || texts.every((text) => BOOLEAN.test(text))) return types.boolean
  if (texts.every((text) => INTEGER.test(text))) return types.integer
  if (texts.every((text) => DECIMAL.test(text))) return types.decimal
  if (texts.every((text) => DATE.test(text))) return types.date
  if (texts.every((text) => TIMESTAMP.test(text))) return types.timestamp
  return types.text
}

function toParam(value: unknown, engine: DatabaseEngine, type: string): unknown {
  if (value === null || value === undefined) return null
  if (typeof value === 'object') return JSON.stringify(value)
  if (typeof value === 'boolean') return engine === 'postgres' ? value : value ? 1 : 0
  if (engine !== 'postgres' && /^(?:true|false)$/i.test(String(value)) && /int|bool/i.test(type)) return /^true$/i.test(String(value)) ? 1 : 0
  return typeof value === 'number' ? value : String(value)
}

export async function importRows(ctx: DbContext, input: Record<string, unknown>): Promise<string> {
  const file = typeof input.file === 'string' ? input.file.trim() : ''
  const rawTable = typeof input.table === 'string' ? input.table.trim() : ''
  if (!file || !rawTable) return 'import needs `file` (CSV, TSV, JSON or JSON Lines inside the workspace) and `table`.'
  const table = parseQualifiedName(rawTable)
  if (!table) return `"${rawTable}" is not a table name.`
  let path: string
  try {
    path = workspaceFile(ctx.root, file)
  } catch (error) {
    return `import: ${error instanceof Error ? error.message : String(error)}`
  }
  if (!existsSync(path)) return `import: no file at ${file}.`
  if (statSync(path).size > MAX_IMPORT_BYTES) return `import: ${file} is ${formatBytes(statSync(path).size)}; elia imports files up to ${formatBytes(MAX_IMPORT_BYTES)} (for bigger loads use the database's own bulk loader, e.g. psql \\copy).`
  const format = formatOf(input, path)
  if (!format) return `import: cannot tell the format of ${file}; pass format: csv, tsv, json or jsonl.`
  let parsed: Parsed
  try {
    parsed = await parseFile(path, format)
  } catch (error) {
    return `import: could not read ${file}: ${error instanceof Error ? error.message : String(error)}`
  }
  if (parsed.columns.length === 0 || parsed.columns.some((column) => !column)) return `import: ${file} has an empty column name in its header.`
  if (parsed.rows.length === 0) return `import: ${file} has no rows.`

  const notes: string[] = []
  if (input.truncate === true) {
    const guard = await backupBeforeDestroying(ctx, input, `emptying ${qualifiedIdent(table, ctx.engine)} before the import`)
    if (!guard.proceed) return guard.refusal ?? 'import refused'
    notes.push(...guard.notes)
  }

  return withSqlSession(ctx.target.url, { statementTimeoutMs: 1_800_000 }, async (session) => {
    const problem = await connectionProblem(session, ctx.target)
    if (problem) return problem
    const existing = await tableColumns(session, ctx.engine, table)
    if (existing.error) return `${targetLine(ctx.target)}\nimport: reading ${rawTable}'s columns failed: ${existing.error}`
    let columns = existing.columns
    const statements: string[] = []
    if (columns.length === 0) {
      if (input.create !== true) return `${targetLine(ctx.target)}\nimport: there is no table ${rawTable}. Create it first, or pass create: true to make one with column types inferred from the file.`
      columns = parsed.columns.map((column, index) => ({ name: columnName(column), type: inferColumnType(parsed.rows.map((row) => row[index]), ctx.engine) }))
      const names = columns.map((column) => column.name)
      const duplicate = names.find((name, index) => names.indexOf(name) !== index)
      if (duplicate) return `import: two columns in ${file} both become "${duplicate}"; rename one in the file.`
      statements.push(`CREATE TABLE ${qualifiedIdent(table, ctx.engine)} (${columns.map((column) => `${quoteIdent(column.name, ctx.engine)} ${column.type}`).join(', ')})`)
      notes.push(`created ${qualifiedIdent(table, ctx.engine)} (${columns.map((column) => `${column.name} ${column.type}`).join(', ')})`)
    }
    // Match file columns to table columns: exactly, then ignoring case, then as a created table would name them.
    const mapping: TableColumn[] = []
    const unknown: string[] = []
    for (const header of parsed.columns) {
      const match = columns.find((column) => column.name === header)
        ?? columns.find((column) => column.name.toLowerCase() === header.toLowerCase())
        ?? columns.find((column) => column.name === columnName(header))
      if (match) mapping.push(match)
      else unknown.push(header)
    }
    if (unknown.length > 0) return `${targetLine(ctx.target)}\nimport: ${rawTable} has no column for ${unknown.map((name) => `"${name}"`).join(', ')} (its columns: ${columns.map((column) => column.name).join(', ')}). Rename the file's header, or add the columns first.`

    const target = qualifiedIdent(table, ctx.engine)
    const columnList = mapping.map((column) => quoteIdent(column.name, ctx.engine)).join(', ')
    const perRow = mapping.length
    const batchRows = Math.max(1, Math.min(1000, Math.floor(30_000 / perRow)))
    const placeholder = (index: number, column: TableColumn) => (ctx.engine === 'postgres' ? `$${index}::${column.type}` : '?')

    const begin = await session.run(ctx.engine === 'mysql' ? 'START TRANSACTION' : 'BEGIN')
    if (!begin.ok) return `${targetLine(ctx.target)}\nimport: could not start a transaction: ${begin.error ?? 'unknown error'}`
    const fail = async (what: string) => {
      await session.run('ROLLBACK')
      return [targetLine(ctx.target), ...notes.filter((note) => !note.startsWith('created')), `import failed — ${what}. Nothing was imported (the whole load is one transaction).`].join('\n')
    }
    for (const statement of statements) {
      const result = await session.run(statement)
      if (!result.ok) return fail(`${statement.slice(0, 80)}…: ${result.error ?? 'unknown error'}`)
    }
    if (input.truncate === true) {
      // MySQL's TRUNCATE commits on its own; DELETE keeps the import atomic there and in SQLite.
      const empty = ctx.engine === 'postgres' ? `TRUNCATE ${target}` : `DELETE FROM ${target}`
      const result = await session.run(empty)
      if (!result.ok) return fail(`emptying the table: ${result.error ?? 'unknown error'}`)
      notes.push(`emptied ${target} first`)
    }
    for (let start = 0; start < parsed.rows.length; start += batchRows) {
      const batch = parsed.rows.slice(start, start + batchRows)
      const params: unknown[] = []
      const tuples = batch.map((row) => `(${mapping.map((column, index) => {
        params.push(toParam(row[index], ctx.engine, column.type))
        return placeholder(params.length, column)
      }).join(', ')})`)
      const result = await session.run(`INSERT INTO ${target} (${columnList}) VALUES ${tuples.join(', ')}`, { params, timeoutMs: 600_000 })
      if (!result.ok) return fail(`rows ${start + 1}–${start + batch.length}: ${result.error ?? 'unknown error'}`)
    }
    const commit = await session.run('COMMIT')
    if (!commit.ok) return fail(`commit: ${commit.error ?? 'unknown error'}`)
    const count = await queryRows(session, `SELECT count(*) AS n FROM ${target}`)
    return [targetLine(ctx.target), ...notes, `imported ${parsed.rows.length} row(s) from ${file} into ${target} in one transaction; the table now holds ${numberOf(count.rows[0]?.n)} row(s).`].join('\n')
  })
}
