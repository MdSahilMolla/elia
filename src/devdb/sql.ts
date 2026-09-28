/**
 * SQL: what a statement does, and running it.
 *
 * The classifier reads SQL the way the governor reads a shell command — by
 * what it does, not by who asked. Five bands, ordered by how much they can
 * cost you:
 *
 *   read         SELECT, EXPLAIN, SHOW, a WITH that only selects
 *   write        INSERT, a scoped UPDATE/DELETE, COPY … FROM STDIN, SET,
 *                VACUUM/ANALYZE, a SELECT of a function that changes state
 *                (nextval, setval, pg_cancel_backend …)
 *   schema       CREATE, ALTER (adding), COMMENT, GRANT, an index
 *   destructive  DROP, TRUNCATE, ALTER … DROP, an UPDATE/DELETE with no WHERE,
 *                REVOKE, pg_terminate_backend
 *   host         anything that reaches past the database to the machine or the
 *                network: server-side files (COPY … TO 'file', pg_read_file,
 *                LOAD DATA, INTO OUTFILE, ATTACH), programs (COPY … PROGRAM),
 *                native code and untrusted languages (LANGUAGE C, plpython3u,
 *                LOAD), outbound connections (dblink, foreign servers,
 *                subscriptions), and grants of those powers
 *
 * `host` exists because a local development database is scratch space elia may
 * change on its own, but its superuser can also run shell commands and read any
 * file the user can. Without this band `COPY … TO PROGRAM` was a way around
 * every rule run_command obeys. Routine bodies (DO blocks, functions) are
 * scanned as written; SQL assembled from strings at run time inside one is the
 * gap a static reader cannot close.
 *
 * A batch takes the band of its worst statement. Comments and quoted text are
 * stripped first, so `SELECT 'DROP TABLE x'` is a read and a `-- DELETE` note
 * is nothing at all. Anything the classifier cannot place is treated as
 * destructive: a statement it does not understand gets strict treatment, never
 * the loosest.
 */

import { clientConnection, engineOf, sqliteFileOf, type DatabaseEngine } from './url.ts'

export type SqlClass = 'read' | 'write' | 'schema' | 'destructive' | 'host'

const RANK: Record<SqlClass, number> = { read: 0, write: 1, schema: 2, destructive: 3, host: 4 }

export function worstClass(classes: readonly SqlClass[]): SqlClass {
  return classes.reduce<SqlClass>((worst, next) => (RANK[next] > RANK[worst] ? next : worst), 'read')
}

// ---------------------------------------------------------------------------
// Reading SQL text
// ---------------------------------------------------------------------------

interface Segment {
  kind: 'code' | 'comment' | 'string' | 'identifier' | 'dollar'
  start: number
  /** Exclusive. */
  end: number
}

/** `$$` or `$tag$` — but not `$1` (a parameter) and not the `$` inside an identifier like `a$b`. */
const DOLLAR_TAG = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/

function quotedEnd(sql: string, start: number, closer: string, backslashEscapes: boolean): number {
  let j = start + 1
  while (j < sql.length) {
    const c = sql[j]!
    if (backslashEscapes && c === '\\') {
      j += 2
      continue
    }
    if (c === closer) {
      if (closer !== ']' && sql[j + 1] === closer) {
        j += 2
        continue
      }
      return j
    }
    j += 1
  }
  return sql.length - 1
}

/** Cuts SQL into code, comments, string literals, quoted identifiers and dollar-quoted bodies. */
function segmentSql(sql: string, engine: DatabaseEngine): Segment[] {
  const out: Segment[] = []
  let codeStart = 0
  let i = 0
  while (i < sql.length) {
    const ch = sql[i]!
    const next = sql[i + 1]
    let kind: Segment['kind'] | undefined
    let end = i
    if ((ch === '-' && next === '-') || (ch === '#' && engine === 'mysql')) {
      const newline = sql.indexOf('\n', i)
      end = newline === -1 ? sql.length : newline
      kind = 'comment'
    } else if (ch === '/' && next === '*') {
      const close = sql.indexOf('*/', i + 2)
      end = close === -1 ? sql.length : close + 2
      kind = 'comment'
    } else if (ch === "'" || ch === '"' || ch === '`' || (ch === '[' && engine === 'sqlite')) {
      // MySQL strings honour backslash escapes; so do Postgres E'…' strings.
      const escapeString = ch === "'" && /[Ee]/.test(sql[i - 1] ?? '') && !/[\w$]/.test(sql[i - 2] ?? '')
      const backslash = (engine === 'mysql' && ch !== '`') || escapeString
      end = quotedEnd(sql, i, ch === '[' ? ']' : ch, backslash) + 1
      kind = ch === "'" || (ch === '"' && engine === 'mysql') ? 'string' : 'identifier'
    } else if (ch === '$' && engine === 'postgres' && !/[\w$]/.test(sql[i - 1] ?? '')) {
      const tag = DOLLAR_TAG.exec(sql.slice(i, i + 66))?.[0]
      if (tag) {
        const close = sql.indexOf(tag, i + tag.length)
        end = close === -1 ? sql.length : close + tag.length
        kind = 'dollar'
      }
    }
    if (!kind) {
      i += 1
      continue
    }
    if (i > codeStart) out.push({ kind: 'code', start: codeStart, end: i })
    end = Math.min(Math.max(end, i + 1), sql.length)
    out.push({ kind, start: i, end })
    i = end
    codeStart = i
  }
  if (sql.length > codeStart) out.push({ kind: 'code', start: codeStart, end: sql.length })
  return out
}

function unquoteIdentifier(text: string): string {
  const open = text[0] ?? ''
  const close = open === '[' ? ']' : open
  const body = text.length > 1 && text.endsWith(close) ? text.slice(1, -1) : text.slice(1)
  return open === '[' ? body : body.split(close + close).join(close)
}

export interface StripOptions {
  engine?: DatabaseEngine
  /** Keep the text of quoted identifiers (`"plpython3u"` → `plpython3u`) instead of masking them as `"x"`. */
  keepIdentifiers?: boolean
}

/** Removes comments and the contents of quoted strings/identifiers, keeping statement boundaries. */
export function stripSqlNoise(sql: string, options: StripOptions = {}): string {
  const engine = options.engine ?? 'postgres'
  let out = ''
  for (const segment of segmentSql(sql, engine)) {
    const text = sql.slice(segment.start, segment.end)
    if (segment.kind === 'code') out += text
    else if (segment.kind === 'comment') out += text.startsWith('/*') ? ' ' : ''
    else if (segment.kind === 'identifier') out += options.keepIdentifiers ? ` ${unquoteIdentifier(text)} ` : '"x"'
    else out += "''"
  }
  return out
}

/** The statement as written, comments removed and everything else — literals, routine bodies — kept. */
function withoutComments(sql: string, engine: DatabaseEngine): string {
  return segmentSql(sql, engine).map((segment) => (segment.kind === 'comment' ? ' ' : sql.slice(segment.start, segment.end))).join('')
}

const ROUTINE_START = /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:DEFINER\s*=\s*\S+\s+)?(?:TEMP(?:ORARY)?\s+)?(?:TRIGGER|PROCEDURE|FUNCTION|EVENT)\b/

/**
 * True while a routine body is open: a SQLite or MySQL trigger, a MySQL
 * procedure, or a Postgres `BEGIN ATOMIC` body, whose statements end in `;`
 * without ending the CREATE. CASE … END nests inside those bodies too, so
 * opens and closes are counted rather than looking for the first END.
 */
function insideRoutineBody(shadow: string): boolean {
  const upper = shadow.toUpperCase()
  if (!ROUTINE_START.test(upper) && !/\bBEGIN\s+ATOMIC\b/.test(upper)) return false
  const opens = (upper.match(/\bBEGIN\b(?!\s+(?:TRANSACTION|WORK|DEFERRED|IMMEDIATE|EXCLUSIVE)\b)/g)?.length ?? 0) + (upper.match(/\bCASE\b/g)?.length ?? 0)
  if (opens === 0) return false
  const closes = upper.match(/\bEND\b(?!\s+(?:IF|LOOP|WHILE|REPEAT|FOR)\b)/g)?.length ?? 0
  return opens > closes
}

/**
 * Splits a batch into statements, each in its own original text. Semicolons in
 * quotes, comments, dollar-quoted bodies and trigger/procedure bodies do not
 * end a statement; a statement that is only a comment is dropped.
 */
export function splitSqlText(sql: string, engine: DatabaseEngine = 'postgres'): string[] {
  const statements: string[] = []
  let start = 0
  let shadow = ''
  const finish = (end: number) => {
    const text = sql.slice(start, end).trim()
    if (shadow.trim() && text) statements.push(text)
    shadow = ''
  }
  for (const segment of segmentSql(sql, engine)) {
    if (segment.kind !== 'code') {
      shadow += segment.kind === 'comment' ? ' ' : segment.kind === 'identifier' ? '"x"' : "''"
      continue
    }
    for (let i = segment.start; i < segment.end; i += 1) {
      const ch = sql[i]!
      if (ch === ';' && !insideRoutineBody(shadow)) {
        finish(i)
        start = i + 1
        continue
      }
      shadow += ch
    }
  }
  finish(sql.length)
  return statements
}

/** The statements of a batch in stripped, whitespace-collapsed form — what the classifier reads. */
export function splitSqlStatements(sql: string, engine: DatabaseEngine = 'postgres'): string[] {
  return splitSqlText(sql, engine)
    .map((statement) => stripSqlNoise(statement, { engine }).trim().replace(/\s+/g, ' '))
    .filter(Boolean)
}

function normalized(statement: string, engine: DatabaseEngine, keepIdentifiers = false): string {
  return stripSqlNoise(statement, { engine, keepIdentifiers }).trim().replace(/\s+/g, ' ').toUpperCase()
}

// ---------------------------------------------------------------------------
// Classifying SQL
// ---------------------------------------------------------------------------

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
      return /^PRAGMA\s+[\w.]+\s*=/.test(s) ? 'write' : 'read'
    case 'CHECK':
    case 'CHECKSUM':
      return 'read'
    case 'PREPARE': {
      // A prepared statement does what its body does; PREPARE TRANSACTION is transaction control.
      const body = s.replace(/^PREPARE\s+[^\s(]+(?:\s*\([^)]*\))?\s+AS\s+/, '')
      return body === s ? 'write' : classifyStatement(body)
    }
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
    case 'UNLOCK':
    case 'NOTIFY':
    case 'LISTEN':
    case 'UNLISTEN':
    case 'SET':
    case 'RESET':
    case 'BEGIN':
    case 'START':
    case 'COMMIT':
    case 'END':
    case 'ROLLBACK':
    case 'ABORT':
    case 'SAVEPOINT':
    case 'RELEASE':
    case 'DEALLOCATE':
    case 'DISCARD':
    case 'USE':
    case 'ANALYZE':
    case 'VACUUM':
    case 'CHECKPOINT':
    case 'OPTIMIZE':
    case 'REPAIR':
    case 'FLUSH':
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
    case 'SECURITY':
      return 'schema'
    case 'ALTER':
      return /\bDROP\b|\bRENAME\b|\bTYPE\b|\bOWNER\s+TO\b/.test(s) ? 'destructive' : 'schema'
    case 'DROP':
    case 'TRUNCATE':
    case 'REVOKE':
    case 'REASSIGN':
    case 'KILL':
      return 'destructive'
    case 'DO':
      // An anonymous code block can do anything its body says.
      return 'destructive'
    default:
      return 'destructive'
  }
}

/** Functions a SELECT can call that change state rather than read it. */
const DESTRUCTIVE_CALLS = /\b(?:PG_TERMINATE_BACKEND|LO_UNLINK|PG_DROP_REPLICATION_SLOT|PG_REPLICATION_ORIGIN_DROP|PG_PROMOTE)\s*\(/
const WRITE_CALLS = /\b(?:NEXTVAL|SETVAL|PG_CANCEL_BACKEND|PG_RELOAD_CONF|PG_ROTATE_LOGFILE|PG_SWITCH_WAL|PG_CREATE_RESTORE_POINT|PG_STAT_RESET\w*|PG_STAT_STATEMENTS_RESET|PG_NOTIFY|SET_CONFIG|LO_CREATE|LO_PUT|LO_FROM_BYTEA|PG_(?:TRY_)?ADVISORY_\w+|PG_CREATE_\w*REPLICATION_SLOT|PG_WAL_REPLAY_(?:PAUSE|RESUME)|PG_IMPORT_SYSTEM_COLLATIONS)\s*\(/

function callEffect(upper: string): SqlClass {
  if (DESTRUCTIVE_CALLS.test(upper)) return 'destructive'
  if (WRITE_CALLS.test(upper)) return 'write'
  return 'read'
}

/** Functions that read or write the server's files, run programs, or open connections. */
const HOST_CALLS = /\b(?:PG_READ_FILE|PG_READ_BINARY_FILE|PG_LS_DIR|PG_LS_\w*DIR|PG_STAT_FILE|PG_FILE_\w+|PG_LOGDIR_LS|LO_IMPORT|LO_EXPORT|DBLINK\w*|LOAD_FILE|LOAD_EXTENSION|SYS_EXEC|SYS_EVAL|READFILE|WRITEFILE)\s*\(/
const HOST_LANGUAGES = /\bLANGUAGE\s+(?:C|INTERNAL|PLPYTHON3U|PLPYTHON2U|PLPYTHONU|PLPERLU|PLTCLU|PLLUAU|PLSH|PLR|JAVAU)\b/
const HOST_EXTENSIONS = /\bCREATE\s+EXTENSION\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:PLPYTHON3U|PLPYTHON2U|PLPYTHONU|PLPERLU|PLTCLU|PLLUAU|PLSH|PLR|PLJAVA|DBLINK|POSTGRES_FDW|FILE_FDW|MYSQL_FDW|ORACLE_FDW|TDS_FDW|MONGO_FDW|REDIS_FDW|SQLITE_FDW|LOG_FDW|MULTICORN\w*|ADMINPACK|HTTP|PGSQL_HTTP|PG_NET|AWS_S3|AWS_COMMONS|AWS_LAMBDA|PG_BACKGROUND)\b/
/** Server settings that name a program to run, a library to load, a path, or a network address. */
const HOST_SETTINGS = /\b(?:ARCHIVE_COMMAND|ARCHIVE_LIBRARY|RESTORE_COMMAND|ARCHIVE_CLEANUP_COMMAND|RECOVERY_END_COMMAND|SSL_PASSPHRASE_COMMAND|SHARED_PRELOAD_LIBRARIES|SESSION_PRELOAD_LIBRARIES|LOCAL_PRELOAD_LIBRARIES|DYNAMIC_LIBRARY_PATH|DATA_DIRECTORY|CONFIG_FILE|HBA_FILE|IDENT_FILE|EXTERNAL_PID_FILE|LOG_DIRECTORY|UNIX_SOCKET_DIRECTORIES|LISTEN_ADDRESSES|PRIMARY_CONNINFO)\b/
const HOST_ROLES = /\bPG_(?:EXECUTE_SERVER_PROGRAM|READ_SERVER_FILES|WRITE_SERVER_FILES)\b/
const OUTBOUND_OBJECTS = /\b(?:CREATE|ALTER)\s+(?:SERVER|FOREIGN\s+DATA\s+WRAPPER|FOREIGN\s+TABLE|USER\s+MAPPING|SUBSCRIPTION)\b|\bIMPORT\s+FOREIGN\s+SCHEMA\b/

/** Patterns that mean "reaches the host" wherever they appear in a routine body. */
const HOST_IN_BODY = [
  HOST_CALLS,
  HOST_LANGUAGES,
  HOST_EXTENSIONS,
  HOST_ROLES,
  OUTBOUND_OBJECTS,
  /\bCOPY\b[^;]*\bPROGRAM\b/,
  /\bCOPY\b[^;]*\b(?:FROM|TO)\s+(?:E|U&)?'+(?!\s*')[^'\s]/,
  /\bLOAD\s+(?:E|U&)?'/,
  /\bLOAD\s+DATA\b/,
  /\bINTO\s+(?:OUTFILE|DUMPFILE)\b/,
  /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:TRUSTED\s+)?(?:PROCEDURAL\s+)?LANGUAGE\b/,
  new RegExp(`\\bALTER\\b[^;]*\\b(?:SET|RESET)\\s+${HOST_SETTINGS.source}`),
  /\b(?:CREATE|ALTER)\s+(?:ROLE|USER)\b[^;]*\bSUPERUSER\b/,
]

/**
 * True when a statement reaches outside the database: the machine's files,
 * programs, native code, or the network. `statement` is one statement in its
 * original text.
 */
export function reachesHost(statement: string, engine: DatabaseEngine = 'postgres'): boolean {
  const masked = normalized(statement, engine)
  const named = normalized(statement, engine, true)
  const verb = /^[A-Z]+/.exec(masked)?.[0] ?? ''
  if (/^(?:DO|CREATE (?:OR REPLACE )?(?:DEFINER ?= ?\S+ )?(?:FUNCTION|PROCEDURE|TRIGGER|EVENT|RULE|AGGREGATE FUNCTION))\b/.test(masked)) {
    const code = withoutComments(statement, engine).toUpperCase()
    if (HOST_IN_BODY.some((pattern) => pattern.test(code)) || /\bSONAME\b/.test(named)) return true
  }
  if (HOST_CALLS.test(named) || HOST_ROLES.test(named) || OUTBOUND_OBJECTS.test(named)) return true
  if (verb === 'COPY' && /\b(?:FROM|TO) (?:PROGRAM\b|(?:E|U&)?'')/.test(masked)) return true
  if (verb === 'LOAD' || verb === 'ATTACH') return true
  if (verb === 'VACUUM' && /\bINTO\b/.test(masked)) return true
  if (/^(?:INSTALL|UNINSTALL) (?:PLUGIN|COMPONENT)\b/.test(masked)) return true
  if (/\bINTO (?:OUTFILE|DUMPFILE)\b/.test(masked)) return true
  if (/^CREATE (?:OR REPLACE )?(?:TRUSTED )?(?:PROCEDURAL )?LANGUAGE\b/.test(masked)) return true
  if (HOST_EXTENSIONS.test(named)) return true
  if (/^CREATE (?:OR REPLACE )?(?:FUNCTION|PROCEDURE)\b/.test(named) && HOST_LANGUAGES.test(named)) return true
  if (/^ALTER\b/.test(named) && new RegExp(`\\b(?:SET|RESET) ${HOST_SETTINGS.source}`).test(named)) return true
  if (/^(?:CREATE|ALTER) (?:ROLE|USER)\b/.test(named) && /\bSUPERUSER\b/.test(named)) return true
  // MySQL's FILE privilege is read/write access to the server's filesystem; SUPER and a global ALL include it.
  if (engine === 'mysql' && /^GRANT\b/.test(named) && / ON \*\.\*/.test(named) && /\b(?:FILE|SUPER|ALL)\b/.test(named.split(' ON ')[0] ?? '')) return true
  return false
}

/** The band of one statement, in its original text. */
export function classifyRawStatement(statement: string, engine: DatabaseEngine = 'postgres'): SqlClass {
  if (reachesHost(statement, engine)) return 'host'
  const masked = normalized(statement, engine)
  return worstClass([classifyStatement(masked), callEffect(masked)])
}

export function classifySql(sql: string, engine: DatabaseEngine = 'postgres'): SqlClass {
  const statements = splitSqlText(sql, engine)
  if (statements.length === 0) return 'read'
  return worstClass(statements.map((statement) => classifyRawStatement(statement, engine)))
}

const TRANSACTION_CONTROL = /^(?:BEGIN(?! ATOMIC\b)|START TRANSACTION|COMMIT|END|ROLLBACK|ABORT|SAVEPOINT|RELEASE|PREPARE TRANSACTION)\b/

/** BEGIN / COMMIT / ROLLBACK / SAVEPOINT …: the statement manages a transaction itself. */
export function isTransactionControl(statement: string, engine: DatabaseEngine = 'postgres'): boolean {
  return TRANSACTION_CONTROL.test(normalized(statement, engine))
}

/**
 * Statements a database refuses (or silently ignores) inside a transaction:
 * VACUUM, CREATE/DROP DATABASE, anything CONCURRENTLY; SQLite pragmas that set
 * a value; and in MySQL every DDL statement, which commits whatever came
 * before it.
 */
export function cannotRunInTransaction(statement: string, engine: DatabaseEngine = 'postgres'): boolean {
  const s = normalized(statement, engine)
  if (engine === 'sqlite') return /^(?:VACUUM|ATTACH|DETACH)\b/.test(s) || /^PRAGMA [\w.]+ ?=/.test(s)
  if (engine === 'mysql') return /^(?:CREATE|ALTER|DROP|TRUNCATE|RENAME|GRANT|REVOKE|LOCK|UNLOCK|ANALYZE|OPTIMIZE|REPAIR|CHECK|FLUSH|INSTALL|UNINSTALL|LOAD|SET PASSWORD)\b/.test(s)
  return /^(?:VACUUM|CREATE DATABASE|DROP DATABASE|ALTER SYSTEM|CREATE TABLESPACE|DROP TABLESPACE|REINDEX (?:\([^)]*\) )?(?:SYSTEM|DATABASE)|(?:CREATE|ALTER|DROP) SUBSCRIPTION)\b/.test(s) || /\bCONCURRENTLY\b/.test(s)
}

// ---------------------------------------------------------------------------
// Running SQL
// ---------------------------------------------------------------------------

export interface StatementResult {
  command: string
  rowCount: number
  rows: Record<string, unknown>[]
}

/**
 * How a batch ran:
 *   single       one statement
 *   atomic       several statements in one transaction — all or nothing
 *   sequential   several statements that cannot share a transaction, each
 *                applied as it ran
 *   rolled-back  a dry run: executed inside a transaction that was rolled back
 */
export type BatchMode = 'single' | 'atomic' | 'sequential' | 'rolled-back'

export interface SqlRunResult {
  ok: boolean
  statements: StatementResult[]
  error?: string
  elapsedMs: number
  mode?: BatchMode
  /** How many statements the batch held. */
  total?: number
  /** 1-based index of the statement that failed, when it is known. */
  failedAt?: number
}

export interface SessionOptions {
  /** Nothing the connection runs can write: Postgres `default_transaction_read_only`, a read-only SQLite file. */
  readOnly?: boolean
  /** Postgres cancels a statement that runs longer than this (server side, so it stops working too). */
  statementTimeoutMs?: number
  /** Postgres gives up on a lock it waited this long for, instead of queueing every other query behind it. */
  lockTimeoutMs?: number
}

export interface RunOptions {
  timeoutMs?: number
  /** Bind parameters ($1 / ?) for a single statement. */
  params?: unknown[]
  /** Run inside a transaction that is always rolled back. */
  dryRun?: boolean
}

export interface SqlSession {
  readonly engine: DatabaseEngine
  run(sql: string, options?: RunOptions): Promise<SqlRunResult>
  close(): Promise<void>
}

const MAX_ROWS_SHOWN = 200
const MAX_CELL_CHARS = 200
const DEFAULT_TIMEOUT_MS = 60_000

type BunSqlQuery = { simple(): Promise<unknown> } & Promise<unknown>
type BunSqlClient = {
  unsafe(query: string, params?: unknown[]): BunSqlQuery
  close(options?: { timeout?: number }): Promise<void>
}

/** Test seam: substitute the client factory (the real one is Bun's built-in `SQL`). */
let clientFactory: ((url: string) => BunSqlClient) | undefined
export function setSqlClientFactoryForTests(factory: ((url: string) => BunSqlClient) | undefined): void {
  clientFactory = factory
}

async function openClient(url: string, engine: DatabaseEngine, options: SessionOptions): Promise<BunSqlClient> {
  if (clientFactory) return clientFactory(url)
  const { SQL } = (await import('bun')) as unknown as { SQL: new (url: string | Record<string, unknown>, options?: Record<string, unknown>) => BunSqlClient }
  if (engine === 'sqlite') {
    // The options form, not a URL: a path with spaces or `#` survives it.
    return new SQL({ adapter: 'sqlite', filename: sqliteFileOf(url), readonly: options.readOnly === true, max: 1 })
  }
  const connection = clientConnection(url)
  const settings: Record<string, string> = {}
  if (engine === 'postgres') {
    // Named so a DBA looking at pg_stat_activity can tell elia's sessions apart.
    settings.application_name = 'elia'
    if (connection.searchPath) settings.search_path = connection.searchPath
    if (options.statementTimeoutMs) settings.statement_timeout = String(Math.round(options.statementTimeoutMs))
    if (options.lockTimeoutMs) settings.lock_timeout = String(Math.round(options.lockTimeoutMs))
    if (options.readOnly) settings.default_transaction_read_only = 'on'
  }
  return new SQL(connection.url, { max: 1, idleTimeout: 5, connectionTimeout: 10, ...(Object.keys(settings).length > 0 ? { connection: settings } : {}) })
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

interface Progress {
  done: StatementResult[]
  total: number
  mode: BatchMode
  failedAt?: number
}

async function runEach(client: BunSqlClient, engine: DatabaseEngine, statements: string[], progress: Progress): Promise<StatementResult[]> {
  for (const [index, statement] of statements.entries()) {
    progress.failedAt = index + 1
    // The text protocol runs any statement; MySQL's binary one cannot prepare KILL, LOCK and friends.
    const raw = engine === 'sqlite' ? await client.unsafe(statement) : await client.unsafe(statement).simple()
    progress.done.push(...normalizeResults(raw))
  }
  progress.failedAt = undefined
  return progress.done
}

async function inTransaction(client: BunSqlClient, engine: DatabaseEngine, commit: boolean, work: () => Promise<StatementResult[]>): Promise<StatementResult[]> {
  await client.unsafe(engine === 'mysql' ? 'START TRANSACTION' : 'BEGIN')
  let results: StatementResult[]
  try {
    results = await work()
  } catch (error) {
    await client.unsafe('ROLLBACK').catch(() => undefined)
    throw error
  }
  await client.unsafe(commit ? 'COMMIT' : 'ROLLBACK')
  return results
}

async function execute(client: BunSqlClient, engine: DatabaseEngine, sql: string, options: RunOptions, progress: Progress): Promise<StatementResult[]> {
  if (options.params && options.params.length > 0) {
    progress.total = 1
    if (options.dryRun) {
      progress.mode = 'rolled-back'
      return inTransaction(client, engine, false, async () => normalizeResults(await client.unsafe(sql, options.params)))
    }
    return normalizeResults(await client.unsafe(sql, options.params))
  }
  const statements = splitSqlText(sql, engine)
  progress.total = statements.length
  if (statements.length === 0) return []
  const transactional = !statements.some((statement) => isTransactionControl(statement, engine) || cannotRunInTransaction(statement, engine))
  if (options.dryRun) {
    if (!transactional) throw new Error('this SQL manages its own transaction or cannot run inside one, so it cannot be dry-run')
    progress.mode = 'rolled-back'
    if (engine === 'postgres') {
      // One round trip; the statements are rejoined with the separator on its
      // own line, so a trailing `--` comment cannot swallow it.
      const raw = await client.unsafe(`BEGIN;\n${statements.join('\n;\n')}\n;\nROLLBACK`).simple()
      return normalizeResults(raw).slice(1, -1)
    }
    return inTransaction(client, engine, false, () => runEach(client, engine, statements, progress))
  }
  if (engine === 'postgres' && (statements.length === 1 || transactional || statements.some((statement) => isTransactionControl(statement, engine)))) {
    // Postgres runs a multi-statement simple query as one implicit transaction
    // (or in the transaction blocks it spells out itself).
    progress.mode = statements.length > 1 && transactional ? 'atomic' : 'single'
    return normalizeResults(await client.unsafe(sql).simple())
  }
  if (statements.length === 1) return runEach(client, engine, statements, progress)
  if (!transactional) {
    progress.mode = 'sequential'
    return runEach(client, engine, statements, progress)
  }
  progress.mode = 'atomic'
  return inTransaction(client, engine, true, () => runEach(client, engine, statements, progress))
}

/**
 * One connection for several calls. SQLite connections are set up the way
 * applications set theirs up: foreign keys enforced (SQLite leaves them off
 * per connection unless asked) and a busy timeout, so a write waits for the
 * app's lock instead of failing at once.
 */
export async function openSqlSession(url: string, options: SessionOptions = {}): Promise<SqlSession> {
  const engine = engineOf(url)
  const client = await openClient(url, engine, options)
  let prepared: Promise<unknown> | undefined
  const prepare = (): Promise<unknown> => {
    if (engine !== 'sqlite') return Promise.resolve()
    prepared ??= (async () => {
      await client.unsafe('PRAGMA busy_timeout = 5000')
      if (!options.readOnly) await client.unsafe('PRAGMA foreign_keys = ON')
    })()
    return prepared
  }
  return {
    engine,
    async run(sql: string, runOptions: RunOptions = {}): Promise<SqlRunResult> {
      const startedAt = Date.now()
      const timeoutMs = runOptions.timeoutMs ?? DEFAULT_TIMEOUT_MS
      const progress: Progress = { done: [], total: 0, mode: 'single' }
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const work = prepare().then(() => execute(client, engine, sql, runOptions, progress))
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`query timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs)
        })
        const statements = await Promise.race([work, timeout])
        return { ok: true, statements, elapsedMs: Date.now() - startedAt, mode: progress.mode, total: progress.total }
      } catch (error) {
        return { ok: false, statements: progress.done, error: describeSqlError(error), elapsedMs: Date.now() - startedAt, mode: progress.mode, total: progress.total, failedAt: progress.failedAt }
      } finally {
        if (timer) clearTimeout(timer)
      }
    },
    close: () => client.close({ timeout: 1 }).catch(() => undefined),
  }
}

export async function withSqlSession<T>(url: string, options: SessionOptions, fn: (session: SqlSession) => Promise<T>): Promise<T> {
  const session = await openSqlSession(url, options)
  try {
    return await fn(session)
  } finally {
    await session.close()
  }
}

/** Runs one batch of SQL (several statements allowed) over a fresh single connection. */
export async function runSql(url: string, sql: string, options: RunOptions & SessionOptions = {}): Promise<SqlRunResult> {
  let session: SqlSession | undefined
  try {
    session = await openSqlSession(url, {
      readOnly: options.readOnly,
      lockTimeoutMs: options.lockTimeoutMs,
      statementTimeoutMs: options.statementTimeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    })
    return await session.run(sql, options)
  } catch (error) {
    return { ok: false, statements: [], error: describeSqlError(error), elapsedMs: 0 }
  } finally {
    await session?.close()
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

/** A value as one table cell: NULL spelled out, bytes as hex, big numbers exact. */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? String(value) : value.toISOString()
  if (value instanceof Uint8Array) {
    const hex = Buffer.from(value.subarray(0, 32)).toString('hex')
    return `\\x${hex}${value.length > 32 ? `… (${value.length} bytes)` : ''}`
  }
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'object') return JSON.stringify(value, (_key, inner: unknown) => (typeof inner === 'bigint' ? inner.toString() : inner))
  return String(value)
}

function cell(value: unknown): string {
  const flat = cellText(value).replace(/\s+/g, ' ')
  return flat.length > MAX_CELL_CHARS ? `${flat.slice(0, MAX_CELL_CHARS - 1)}…` : flat
}

/** Renders rows as a compact pipe table the model can read without guessing at alignment. */
export function formatRows(rows: Record<string, unknown>[], maxRows = MAX_ROWS_SHOWN): string {
  if (rows.length === 0) return '(0 rows)'
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))]
  const shown = rows.slice(0, maxRows)
  const lines = [columns.join(' | '), columns.map(() => '---').join(' | '), ...shown.map((row) => columns.map((column) => cell(row[column])).join(' | '))]
  if (rows.length > shown.length) lines.push(`… ${rows.length - shown.length} more row(s) not shown — add a LIMIT or aggregate`)
  lines.push(`(${rows.length} row${rows.length === 1 ? '' : 's'})`)
  return lines.join('\n')
}

function batchNote(result: SqlRunResult): string | undefined {
  const total = result.total ?? result.statements.length
  if (result.ok) {
    if (result.mode === 'rolled-back') return 'dry run: everything above ran inside a transaction that was then rolled back — nothing was changed'
    if (result.mode === 'atomic') return `${total} statements ran as one transaction`
    return undefined
  }
  if (result.mode === 'rolled-back') return 'dry run: rolled back — nothing was changed'
  if (total <= 1) return undefined
  const where = result.failedAt ? `statement ${result.failedAt} of ${total} failed` : `the batch of ${total} statements failed`
  if (result.mode === 'atomic') return `${where}; the batch ran as one transaction, so nothing was committed`
  if (result.mode === 'sequential' && result.failedAt) {
    const applied = result.failedAt - 1
    return `${where}; ${applied === 0 ? 'nothing before it had run' : `statement${applied === 1 ? '' : 's'} 1${applied > 1 ? `–${applied}` : ''} had already been applied and stay applied`}; the rest did not run`
  }
  return where
}

function formatStatements(statements: StatementResult[]): string {
  return statements.map((statement, index) => {
    const head = statements.length > 1 ? `-- statement ${index + 1}: ${statement.command}` : `-- ${statement.command}`
    const body = statement.rows.length > 0 || /^(?:SELECT|SHOW|VALUES|EXPLAIN|TABLE|PRAGMA)/i.test(statement.command)
      ? formatRows(statement.rows)
      : `${statement.rowCount} row(s) affected`
    return `${head}\n${body}`
  }).join('\n\n')
}

export function formatSqlRun(result: SqlRunResult): string {
  const note = batchNote(result)
  if (!result.ok) {
    const done = result.statements.length > 0 ? `${formatStatements(result.statements)}\n\n` : ''
    return `${done}SQL failed after ${result.elapsedMs}ms: ${result.error ?? 'unknown error'}${note ? `\n${note}` : ''}`
  }
  if (result.statements.length === 0) return `OK (${result.elapsedMs}ms)${note ? `\n${note}` : ''}`
  return `${formatStatements(result.statements)}\n(${result.elapsedMs}ms)${note ? `\n${note}` : ''}`
}
