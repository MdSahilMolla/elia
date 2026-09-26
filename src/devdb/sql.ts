/**
 * SQL: what a statement does, and running it.
 *
 * The classifier reads SQL the way the governor reads a shell command — by
 * what it does, not by who asked. Four bands, ordered by how much they can
 * cost you:
 *
 *   read         SELECT, EXPLAIN, SHOW, a WITH that only selects
 *   write        INSERT, a scoped UPDATE/DELETE, COPY … FROM, SET
 *   schema       CREATE, ALTER (adding), COMMENT, GRANT, an index
 *   destructive  DROP, TRUNCATE, ALTER … DROP, an UPDATE/DELETE with no WHERE
 *
 * A batch takes the band of its worst statement. Comments and quoted text are
 * stripped first, so `SELECT 'DROP TABLE x'` is a read and a `-- DELETE` note
 * is nothing at all. Anything the classifier cannot place is treated as
 * destructive: a statement it does not understand gets the strictest
 * treatment, never the loosest.
 */

export type SqlClass = 'read' | 'write' | 'schema' | 'destructive'

const RANK: Record<SqlClass, number> = { read: 0, write: 1, schema: 2, destructive: 3 }

export function worstClass(classes: readonly SqlClass[]): SqlClass {
  return classes.reduce<SqlClass>((worst, next) => (RANK[next] > RANK[worst] ? next : worst), 'read')
}

/** Removes comments and the contents of quoted strings/identifiers, keeping statement boundaries. */
export function stripSqlNoise(sql: string): string {
  let out = ''
  let i = 0
  while (i < sql.length) {
    const ch = sql[i]!
    const next = sql[i + 1]
    if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i)
      i = end === -1 ? sql.length : end
      continue
    }
    if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2)
      i = end === -1 ? sql.length : end + 2
      out += ' '
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1
      while (j < sql.length) {
        if (sql[j] === ch && sql[j + 1] === ch) j += 2
        else if (sql[j] === ch) break
        else j += 1
      }
      out += ch === "'" ? "''" : '"x"'
      i = j + 1
      continue
    }
    // Postgres dollar quoting: $$ … $$ or $tag$ … $tag$ (function bodies).
    if (ch === '$') {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i))?.[0]
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length)
        i = end === -1 ? sql.length : end + tag.length
        out += "''"
        continue
      }
    }
    out += ch
    i += 1
  }
  return out
}

export function splitSqlStatements(sql: string): string[] {
  return stripSqlNoise(sql)
    .split(';')
    .map((statement) => statement.trim().replace(/\s+/g, ' '))
    .filter(Boolean)
}

export function classifyStatement(statement: string): SqlClass {
  const s = statement.trim().toUpperCase()
  const verb = /^[A-Z]+/.exec(s)?.[0] ?? ''
  switch (verb) {
    case 'SELECT':
    case 'VALUES':
    case 'TABLE':
      // Postgres `SELECT … INTO new_table` creates a table.
      return verb === 'SELECT' && /\bINTO\s+(?!STRICT\b)/.test(s) ? 'schema' : 'read'
    case 'EXPLAIN':
      // EXPLAIN ANALYZE really executes the statement it explains.
      return /^EXPLAIN\s+(?:\([^)]*\bANALY[SZ]E\b[^)]*\)|ANALY[SZ]E\b)/.test(s) ? classifyStatement(s.replace(/^EXPLAIN\s+(?:\([^)]*\)|ANALY[SZ]E(?:\s+VERBOSE)?)\s*/, '')) : 'read'
    case 'SHOW':
    case 'DESCRIBE':
    case 'DESC':
    case 'PRAGMA':
      return /^PRAGMA\s+\w+\s*=/.test(s) ? 'write' : 'read'
    case 'WITH': {
      // A CTE is a read unless one of its parts (or the final statement) writes.
      if (/\b(?:DELETE|UPDATE|INSERT|MERGE)\b/.test(s)) {
        if (/\bDELETE\s+FROM\b/.test(s) && !/\bWHERE\b/.test(s)) return 'destructive'
        return 'write'
      }
      return 'read'
    }
    case 'INSERT':
    case 'REPLACE':
    case 'MERGE':
    case 'UPSERT':
    case 'COPY':
    case 'CALL':
    case 'LOCK':
    case 'NOTIFY':
    case 'LISTEN':
    case 'SET':
    case 'RESET':
    case 'BEGIN':
    case 'START':
    case 'COMMIT':
    case 'END':
    case 'ROLLBACK':
    case 'SAVEPOINT':
    case 'RELEASE':
    case 'PREPARE':
    case 'DEALLOCATE':
    case 'ANALYZE':
    case 'VACUUM':
    case 'REFRESH':
      return verb === 'COPY' && /\bTO\s+(?:PROGRAM|'')/.test(s) ? 'destructive' : 'write'
    case 'UPDATE':
      return /\bWHERE\b/.test(s) ? 'write' : 'destructive'
    case 'DELETE':
      return /\bWHERE\b/.test(s) ? 'write' : 'destructive'
    case 'CREATE':
    case 'COMMENT':
    case 'GRANT':
    case 'REINDEX':
    case 'CLUSTER':
      return 'schema'
    case 'ALTER':
      return /\bDROP\b|\bRENAME\b|\bTYPE\b|\bOWNER\s+TO\b/.test(s) ? 'destructive' : 'schema'
    case 'DROP':
    case 'TRUNCATE':
    case 'REVOKE':
      return 'destructive'
    case 'DO':
      // An anonymous code block can do anything its body says.
      return 'destructive'
    default:
      return 'destructive'
  }
}

export function classifySql(sql: string): SqlClass {
  const statements = splitSqlStatements(sql)
  if (statements.length === 0) return 'read'
  return worstClass(statements.map(classifyStatement))
}

// ---------------------------------------------------------------------------
// Running SQL
// ---------------------------------------------------------------------------

export interface StatementResult {
  command: string
  rowCount: number
  rows: Record<string, unknown>[]
}

export interface SqlRunResult {
  ok: boolean
  statements: StatementResult[]
  error?: string
  elapsedMs: number
}

const MAX_ROWS_SHOWN = 200
const MAX_CELL_CHARS = 200

type BunSqlClient = {
  unsafe(query: string): { simple(): Promise<unknown> } & Promise<unknown>
  close(options?: { timeout?: number }): Promise<void>
}

/** Test seam: substitute the client factory (the real one is Bun's built-in `SQL`). */
let clientFactory: ((url: string) => BunSqlClient) | undefined
export function setSqlClientFactoryForTests(factory: ((url: string) => BunSqlClient) | undefined): void {
  clientFactory = factory
}

async function openClient(url: string): Promise<BunSqlClient> {
  if (clientFactory) return clientFactory(url)
  const { SQL } = (await import('bun')) as unknown as { SQL: new (url: string, options?: Record<string, unknown>) => BunSqlClient }
  return new SQL(url, { max: 1, idleTimeout: 5, connectionTimeout: 10 })
}

function normalizeResults(raw: unknown): StatementResult[] {
  if (!Array.isArray(raw)) return []
  const asResult = (value: unknown): StatementResult => {
    const rows = Array.isArray(value) ? (value as Record<string, unknown>[]).filter((row) => row !== null && typeof row === 'object' && !Array.isArray(row)) : []
    const meta = value as { command?: unknown; count?: unknown }
    return {
      command: typeof meta?.command === 'string' ? meta.command : 'OK',
      rowCount: typeof meta?.count === 'number' ? meta.count : rows.length,
      rows,
    }
  }
  // Bun hands back one result for a single statement and an array of results
  // for several; a single result is itself an array of row objects.
  const isMulti = raw.length > 0 && raw.every((item) => Array.isArray(item) && typeof (item as { command?: unknown }).command === 'string')
  return isMulti ? raw.map(asResult) : [asResult(raw)]
}

/** Runs one batch of SQL (several statements allowed) over a fresh single connection. */
export async function runSql(url: string, sql: string, options: { timeoutMs?: number } = {}): Promise<SqlRunResult> {
  const startedAt = Date.now()
  let client: BunSqlClient | undefined
  const timeoutMs = options.timeoutMs ?? 60_000
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    client = await openClient(url)
    const opened = client
    const run = opened.unsafe(sql).simple()
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`query timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs)
    })
    const raw = await Promise.race([run, timeout])
    return { ok: true, statements: normalizeResults(raw), elapsedMs: Date.now() - startedAt }
  } catch (error) {
    return { ok: false, statements: [], error: describeSqlError(error), elapsedMs: Date.now() - startedAt }
  } finally {
    if (timer) clearTimeout(timer)
    await client?.close({ timeout: 1 }).catch(() => undefined)
  }
}

export function describeSqlError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const detail = error as Error & { errno?: unknown; position?: unknown; detail?: unknown; hint?: unknown }
  const parts = [error.message]
  if (typeof detail.errno === 'string' && detail.errno) parts.push(`(SQLSTATE ${detail.errno})`)
  if (typeof detail.detail === 'string' && detail.detail) parts.push(`detail: ${detail.detail}`)
  if (typeof detail.hint === 'string' && detail.hint) parts.push(`hint: ${detail.hint}`)
  if (detail.position !== undefined && detail.position !== '' && detail.position !== 0) parts.push(`at character ${String(detail.position)}`)
  return parts.join(' ')
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  const text = value instanceof Date ? value.toISOString() : typeof value === 'object' ? JSON.stringify(value) : String(value)
  const flat = text.replace(/\s+/g, ' ')
  return flat.length > MAX_CELL_CHARS ? `${flat.slice(0, MAX_CELL_CHARS - 1)}…` : flat
}

/** Renders rows as a compact pipe table the model can read without guessing at alignment. */
export function formatRows(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '(0 rows)'
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))]
  const shown = rows.slice(0, MAX_ROWS_SHOWN)
  const lines = [columns.join(' | '), columns.map(() => '---').join(' | '), ...shown.map((row) => columns.map((column) => cell(row[column])).join(' | '))]
  if (rows.length > shown.length) lines.push(`… ${rows.length - shown.length} more row(s) not shown — add a LIMIT or aggregate`)
  lines.push(`(${rows.length} row${rows.length === 1 ? '' : 's'})`)
  return lines.join('\n')
}

export function formatSqlRun(result: SqlRunResult): string {
  if (!result.ok) return `SQL failed after ${result.elapsedMs}ms: ${result.error ?? 'unknown error'}`
  if (result.statements.length === 0) return `OK (${result.elapsedMs}ms)`
  const blocks = result.statements.map((statement, index) => {
    const head = result.statements.length > 1 ? `-- statement ${index + 1}: ${statement.command}` : `-- ${statement.command}`
    const body = statement.rows.length > 0 || /^(?:SELECT|SHOW|VALUES|EXPLAIN|TABLE)/i.test(statement.command)
      ? formatRows(statement.rows)
      : `${statement.rowCount} row(s) affected`
    return `${head}\n${body}`
  })
  return `${blocks.join('\n\n')}\n(${result.elapsedMs}ms)`
}
