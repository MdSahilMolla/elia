/**
 * Read-only SQL enforcement for model-written queries. The guard is a lexical allow-list —
 * one statement, starting with SELECT/WITH/EXPLAIN/VALUES/SHOW/DESCRIBE, with no
 * data-modifying keyword and no file- or server-reaching function outside string literals —
 * and it is only the first layer: connectors also open read-only connections or read-only
 * transactions, so a query the guard misjudges still cannot write.
 */

// A query must start with a read keyword, so statement-level verbs (SET, USE, LOAD, COPY …)
// cannot lead it; what can hide inside a SELECT is a data-modifying CTE, a row lock, or
// REPLACE INTO — those are what this list catches.
const WRITE_KEYWORDS = /\b(insert|update|delete|merge|upsert|drop|alter|create|truncate|grant|revoke|attach|detach|copy|call|exec|execute|vacuum|reindex|lock|pragma|replace\s+into|for\s+share|for\s+no\s+key)\b/i
const DANGEROUS_FUNCTIONS = /\b(nextval|setval|set_config|pg_notify|pg_advisory\w*|pg_try_advisory\w*|pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_file|lo_import|lo_export|dblink\w*|pg_sleep\w*|pg_terminate_backend|pg_cancel_backend|load_file|sys_exec|sys_eval|xp_cmdshell|openrowset|opendatasource|bulk|utl_file|utl_http|dbms_\w+|load_extension|readfile|writefile|edit|fts3_tokenizer|read_csv\w*|read_parquet|read_json\w*|read_text|read_blob|httpfs|glob)\s*\(/i
const SELECT_INTO = /\binto\s+(?!\s*\()(?:outfile|dumpfile|temp|temporary|unlogged|[\w".]+)/i
const READ_START = /^(select|with|explain|values|show|describe|desc|table)\b/i
const ALLOWED_PRAGMAS = /^pragma\s+(table_info|table_xinfo|index_list|index_info|foreign_key_list|table_list)\s*\(\s*['"`]?[\w.]+['"`]?\s*\)\s*;?\s*$/i

/** Replaces string literals, quoted identifiers, and comments with spaces so keyword checks see only SQL structure. */
export function stripSqlLiterals(sql: string): string {
  let out = ''
  let index = 0
  while (index < sql.length) {
    const character = sql[index]!
    const next = sql[index + 1]
    if (character === '-' && next === '-') {
      while (index < sql.length && sql[index] !== '\n') index++
      out += ' '
      continue
    }
    if (character === '/' && next === '*') {
      const end = sql.indexOf('*/', index + 2)
      index = end === -1 ? sql.length : end + 2
      out += ' '
      continue
    }
    if (character === "'" || character === '"' || character === '`' || character === '[') {
      const close = character === '[' ? ']' : character
      index++
      while (index < sql.length) {
        if (sql[index] === close && sql[index + 1] === close && close !== ']') {
          index += 2
          continue
        }
        if (sql[index] === close) break
        index++
      }
      index++
      out += character === "'" ? " '' " : ' "q" '
      continue
    }
    if (character === '$' && /[A-Za-z_$]/.test(next ?? '')) {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(index))
      if (tag) {
        const end = sql.indexOf(tag[0], index + tag[0].length)
        index = end === -1 ? sql.length : end + tag[0].length
        out += " '' "
        continue
      }
    }
    out += character
    index++
  }
  return out
}

export class UnsafeSqlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsafeSqlError'
  }
}

/** Throws unless `sql` is a single read-only statement. Returns the statement without a trailing semicolon. */
export function assertReadOnlySql(sql: string): string {
  if (typeof sql !== 'string' || !sql.trim()) throw new UnsafeSqlError('query must be a non-empty SQL string')
  if (sql.length > 100_000) throw new UnsafeSqlError('query exceeds 100,000 characters')
  const trimmed = sql.trim()
  if (ALLOWED_PRAGMAS.test(trimmed)) return trimmed.replace(/;\s*$/, '')
  const structure = stripSqlLiterals(trimmed).trim().replace(/;\s*$/, '')
  if (structure.includes(';')) throw new UnsafeSqlError('only one SQL statement is allowed per query')
  if (!READ_START.test(structure)) throw new UnsafeSqlError('only read-only queries (SELECT, WITH … SELECT, EXPLAIN, VALUES, SHOW, DESCRIBE) are allowed; changes to a database need a separately approved, explicit workflow')
  const write = WRITE_KEYWORDS.exec(structure)
  if (write) throw new UnsafeSqlError(`the query contains "${write[1]}", which can modify data or take locks; it is refused`)
  // EXPLAIN ANALYZE executes the statement, so only a plain EXPLAIN of a read is allowed.
  if (/^explain\b/i.test(structure) && !/^explain\s+(query\s+plan\s+)?(select|with|values)\b/i.test(structure)) throw new UnsafeSqlError('EXPLAIN is only allowed directly on a SELECT (EXPLAIN ANALYZE runs the statement)')
  const fn = DANGEROUS_FUNCTIONS.exec(structure)
  if (fn) throw new UnsafeSqlError(`the query calls ${fn[1]}(), which can reach files, the network, or the server process; it is refused`)
  if (SELECT_INTO.test(structure)) throw new UnsafeSqlError('SELECT … INTO creates or writes objects; it is refused')
  return trimmed.replace(/;\s*$/, '')
}

/** Quotes an identifier for SQLite/Postgres-style SQL. */
export function quoteIdentifier(name: string): string {
  if (name.includes('\u0000')) throw new UnsafeSqlError('identifier contains a NUL character')
  return `"${name.replace(/"/g, '""')}"`
}

/** Case-insensitive plain identifier check for table names passed as parameters. */
export function isPlainIdentifier(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_$]*(\.[A-Za-z_][A-Za-z0-9_$]*){0,2}$/.test(name)
}
