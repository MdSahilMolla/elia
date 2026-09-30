/**
 * Tuning and upkeep: why a query is slow (explain), keeping tables healthy
 * (maintain — vacuum, analyze, reindex, integrity checks), and dealing with a
 * runaway session (terminate).
 */

import { statSync } from 'node:fs'
import { connectionProblem, formatBytes, numberOf, parseQualifiedName, qualifiedIdent, queryRows, quoteIdent, targetLine, type DbContext, type QualifiedName } from './common.ts'
import { classifyRawStatement, formatRows, splitSqlText, withSqlSession, type SqlSession } from './sql.ts'
import { parseDatabaseUrl, sqliteFileOf } from './url.ts'

// ---------------------------------------------------------------------------
// explain
// ---------------------------------------------------------------------------

/** Plain-language pointers for the patterns in a Postgres plan that most often explain a slow query. */
export function planHints(lines: readonly string[]): string[] {
  const hints: string[] = []
  for (const line of lines) {
    const scan = /Seq Scan on (\S+)(?: \S+)?\s+\(cost=[^)]*rows=(\d+)[^)]*\)(?: \(actual [^)]*rows=(\d+)[^)]*\))?/.exec(line)
    if (scan) {
      const rows = Number(scan[3] ?? scan[2])
      if (rows >= 10_000) hints.push(`Seq Scan on ${scan[1]} reads ~${rows.toLocaleString('en-US')} rows: if the query filters or joins on a column of it, an index there may help — create it, then explain again.`)
    }
    const estimate = /rows=(\d+) width=\d+\) \(actual time=[^)]*rows=(\d+) loops/.exec(line)
    if (estimate) {
      const expected = Math.max(Number(estimate[1]), 1)
      const actual = Math.max(Number(estimate[2]), 1)
      const ratio = Math.max(expected / actual, actual / expected)
      if (ratio >= 10 && Math.max(expected, actual) >= 1_000) hints.push(`The planner expected ${expected.toLocaleString('en-US')} rows and got ${actual.toLocaleString('en-US')} (${line.trim().split('  (')[0]?.replace(/^->\s*/, '')}): statistics are off — maintain operation=analyze on its tables.`)
    }
    if (/Sort Method: external merge/.test(line)) hints.push('A sort spilled to disk: raise work_mem for this query (SET work_mem = \'64MB\' in the session) or add an index that returns rows already ordered.')
    const batches = /Hash Batches: (\d+)/.exec(line)
    if (batches && Number(batches[1]) > 1) hints.push('A hash join spilled to disk in batches: more work_mem would keep it in memory.')
  }
  return [...new Set(hints)].slice(0, 6)
}

function sqlitePlanTree(rows: Record<string, unknown>[]): { text: string; hints: string[] } {
  const depth = new Map<number, number>()
  const lines: string[] = []
  const hints: string[] = []
  for (const row of rows) {
    const id = numberOf(row.id)
    const parent = numberOf(row.parent)
    const level = (depth.get(parent) ?? -1) + 1
    depth.set(id, level)
    const detail = String(row.detail ?? '')
    lines.push(`${'  '.repeat(level)}${detail}`)
    const scan = /^SCAN (\S+)(?! USING)/.exec(detail)
    if (scan && !/USING (?:COVERING )?INDEX/.test(detail)) hints.push(`Full scan of ${scan[1]}: an index on the column it is filtered or joined by would avoid it.`)
    if (/USE TEMP B-TREE FOR (?:ORDER BY|GROUP BY|DISTINCT)/.test(detail)) hints.push(`${detail.replace(/^USE /, 'Builds a ')} — an index in that order would avoid the sort.`)
  }
  return { text: lines.join('\n'), hints: [...new Set(hints)] }
}

export async function explain(ctx: DbContext, input: Record<string, unknown>): Promise<string> {
  const sql = typeof input.sql === 'string' ? input.sql : ''
  const statements = splitSqlText(sql, ctx.engine)
  if (statements.length !== 1) return 'explain takes exactly one statement in `sql`.'
  const statement = statements[0]!.replace(/^\s*EXPLAIN\b(?:\s*\([^)]*\)|\s+ANALY[SZ]E|\s+VERBOSE|\s+QUERY\s+PLAN)*\s*/i, '')
  const analyze = input.analyze === true
  const sqlClass = classifyRawStatement(statement, ctx.engine)
  const writes = sqlClass !== 'read'
  const notes: string[] = []

  if (ctx.engine === 'sqlite') {
    if (analyze) notes.push('SQLite has no EXPLAIN ANALYZE: this is the planned strategy; time the statement itself with query to measure it.')
    return inspect(ctx, false, async (session) => {
      const result = await session.run(`EXPLAIN QUERY PLAN ${statement}`, { timeoutMs: 30_000 })
      if (!result.ok) return `${targetLine(ctx.target)}\nEXPLAIN failed: ${result.error ?? 'unknown error'}`
      const tree = sqlitePlanTree(result.statements.at(-1)?.rows ?? [])
      return [targetLine(ctx.target), ...notes, tree.text, ...(tree.hints.length ? ['', 'hints:', ...tree.hints.map((hint) => `- ${hint}`)] : [])].join('\n')
    })
  }

  if (ctx.engine === 'mysql') {
    if (analyze && writes) return 'MySQL can only EXPLAIN ANALYZE a SELECT; explain it without analyze, or dry-run it with query dry_run: true.'
    return inspect(ctx, !analyze || !writes, async (session) => {
      let result = await session.run(`${analyze ? 'EXPLAIN ANALYZE' : 'EXPLAIN FORMAT=TREE'} ${statement}`, { timeoutMs: 120_000 })
      if (!result.ok && !analyze) result = await session.run(`EXPLAIN ${statement}`, { timeoutMs: 60_000 })
      if (!result.ok) return `${targetLine(ctx.target)}\nEXPLAIN failed: ${result.error ?? 'unknown error'}`
      const rows = result.statements.at(-1)?.rows ?? []
      const text = rows.length > 0 && Object.keys(rows[0]!).length === 1 ? rows.map((row) => String(Object.values(row)[0])).join('\n') : formatRows(rows)
      return `${targetLine(ctx.target)}\n${text}`
    })
  }

  // Postgres. EXPLAIN ANALYZE really runs the statement: a write is run inside
  // a transaction that is rolled back, so the plan is real and nothing stays.
  const explainSql = `EXPLAIN ${analyze ? '(ANALYZE, BUFFERS) ' : ''}${statement}`
  if (analyze && writes) notes.push('The statement writes, so it ran inside a transaction that was rolled back — timings are real, nothing was kept.')
  return inspect(ctx, !(analyze && writes), async (session) => {
    const result = await session.run(explainSql, { timeoutMs: 300_000, dryRun: analyze && writes })
    if (!result.ok) return `${targetLine(ctx.target)}\nEXPLAIN failed: ${result.error ?? 'unknown error'}`
    const lines = (result.statements.at(-1)?.rows ?? []).map((row) => String(row['QUERY PLAN'] ?? Object.values(row)[0] ?? ''))
    const hints = planHints(lines)
    return [targetLine(ctx.target), ...notes, lines.join('\n'), ...(hints.length ? ['', 'hints:', ...hints.map((hint) => `- ${hint}`)] : [])].join('\n')
  })
}

async function inspect(ctx: DbContext, readOnly: boolean, body: (session: SqlSession) => Promise<string>): Promise<string> {
  try {
    return await withSqlSession(ctx.target.url, { readOnly, statementTimeoutMs: 300_000 }, async (session) => (await connectionProblem(session, ctx.target)) ?? body(session))
  } catch (error) {
    return `${targetLine(ctx.target)}\ncould not open the database: ${error instanceof Error ? error.message : String(error)}`
  }
}

// ---------------------------------------------------------------------------
// maintain
// ---------------------------------------------------------------------------

export const MAINTENANCE_OPERATIONS = ['vacuum', 'analyze', 'vacuum_analyze', 'vacuum_full', 'reindex', 'optimize', 'check'] as const
type Operation = (typeof MAINTENANCE_OPERATIONS)[number]

async function pgFootprint(session: SqlSession, table: QualifiedName | undefined): Promise<Record<string, unknown> | undefined> {
  const found = table
    ? await queryRows(session, `SELECT pg_size_pretty(pg_total_relation_size(c.oid)) AS size, s.n_live_tup AS live_rows, s.n_dead_tup AS dead_rows, greatest(s.last_vacuum, s.last_autovacuum) AS last_vacuum, greatest(s.last_analyze, s.last_autoanalyze) AS last_analyze FROM pg_class c LEFT JOIN pg_stat_all_tables s ON s.relid = c.oid WHERE c.oid = to_regclass($1)`, [qualifiedIdent(table, 'postgres')])
    : await queryRows(session, 'SELECT pg_size_pretty(pg_database_size(current_database())) AS size, (SELECT sum(n_dead_tup) FROM pg_stat_user_tables) AS dead_rows')
  return found.rows[0]
}

function pgMaintenanceSql(operation: Operation, table: QualifiedName | undefined, database: string): string | undefined {
  const target = table ? ` ${qualifiedIdent(table, 'postgres')}` : ''
  switch (operation) {
    case 'vacuum':
      return `VACUUM${target}`
    case 'analyze':
      return `ANALYZE${target}`
    case 'vacuum_analyze':
    case 'optimize':
      return `VACUUM (ANALYZE)${target}`
    case 'vacuum_full':
      return `VACUUM (FULL, ANALYZE)${target}`
    case 'reindex':
      return table ? `REINDEX TABLE${target}` : `REINDEX DATABASE ${quoteIdent(database, 'postgres')}`
    default:
      return undefined
  }
}

async function pgCheck(ctx: DbContext, session: SqlSession, table: QualifiedName | undefined): Promise<string> {
  const amcheck = await queryRows(session, "SELECT 1 AS present FROM pg_extension WHERE extname = 'amcheck'")
  if (amcheck.rows.length === 0) {
    return `${targetLine(ctx.target)}\nPostgres has no built-in integrity check. The amcheck extension (shipped with Postgres) verifies B-tree indexes against their tables: CREATE EXTENSION amcheck, then run check again. Data checksums, if enabled at initdb, also catch corruption as pages are read.`
  }
  const scope = table ? 'AND i.indrelid = to_regclass($1)' : "AND n.nspname NOT IN ('pg_catalog', 'information_schema')"
  const result = await session.run(
    `SELECT c.relname AS index, i.indrelid::regclass::text AS "table", bt_index_check(c.oid, true) IS NULL AS checked
     FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_am am ON am.oid = c.relam JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE am.amname = 'btree' AND i.indisvalid ${scope} ORDER BY 2, 1 LIMIT 500`,
    { params: table ? [qualifiedIdent(table, 'postgres')] : undefined, timeoutMs: 1_800_000 },
  )
  if (!result.ok) return `${targetLine(ctx.target)}\nintegrity check found a problem: ${result.error ?? 'unknown error'}`
  const rows = result.statements.at(-1)?.rows ?? []
  return `${targetLine(ctx.target)}\namcheck verified ${rows.length} B-tree index(es) against their tables${table ? ` on ${qualifiedIdent(table, 'postgres')}` : ''}: no corruption found.`
}

export async function maintain(ctx: DbContext, input: Record<string, unknown>): Promise<string> {
  const operation = (typeof input.operation === 'string' ? input.operation : '') as Operation
  if (!MAINTENANCE_OPERATIONS.includes(operation)) return `maintain needs operation: one of ${MAINTENANCE_OPERATIONS.join(', ')}.`
  const rawTable = typeof input.table === 'string' ? input.table.trim() : ''
  const table = rawTable ? parseQualifiedName(rawTable) : undefined
  if (rawTable && !table) return `"${rawTable}" is not a table name.`

  if (ctx.engine === 'sqlite') {
    const file = sqliteFileOf(ctx.target.url)
    const sizeOf = () => {
      try {
        return formatBytes(statSync(file).size)
      } catch {
        return 'unknown'
      }
    }
    const name = table ? ` ${quoteIdent(table.name, 'sqlite')}` : ''
    const statements: Record<Operation, string[]> = {
      vacuum: ['VACUUM'],
      vacuum_full: ['VACUUM'],
      analyze: [`ANALYZE${name}`],
      vacuum_analyze: ['VACUUM', `ANALYZE${name}`],
      reindex: [`REINDEX${name}`],
      optimize: ['PRAGMA optimize'],
      check: ['PRAGMA integrity_check', 'PRAGMA foreign_key_check'],
    }
    const before = sizeOf()
    return withSqlSession(ctx.target.url, { readOnly: operation === 'check' }, async (session) => {
      const problem = await connectionProblem(session, ctx.target)
      if (problem) return problem
      const out = [targetLine(ctx.target)]
      if (table && /vacuum/.test(operation)) out.push('SQLite vacuums the whole file; the table name applies only to analyze.')
      for (const statement of statements[operation]) {
        const result = await session.run(statement, { timeoutMs: 1_800_000 })
        if (!result.ok) return [...out, `${statement} failed: ${result.error ?? 'unknown error'}`].join('\n')
        const rows = result.statements.at(-1)?.rows ?? []
        out.push(`${statement}: ${rows.length ? formatRows(rows, 50) : 'done'}`)
      }
      if (operation !== 'check') out.push(`file size: ${before} → ${sizeOf()}`)
      return out.join('\n')
    })
  }

  if (ctx.engine === 'mysql') {
    if (!table) return 'On MySQL, maintain works one table at a time: pass `table`.'
    const verb = operation === 'check' ? 'CHECK' : operation === 'analyze' ? 'ANALYZE' : 'OPTIMIZE'
    return withSqlSession(ctx.target.url, {}, async (session) => {
      const problem = await connectionProblem(session, ctx.target)
      if (problem) return problem
      const result = await session.run(`${verb} TABLE ${qualifiedIdent(table, 'mysql')}`, { timeoutMs: 1_800_000 })
      return `${targetLine(ctx.target)}\n${verb} TABLE: ${result.ok ? formatRows(result.statements.at(-1)?.rows ?? []) : `failed: ${result.error ?? 'unknown error'}`}${verb === 'OPTIMIZE' && operation !== 'optimize' ? '\n(InnoDB OPTIMIZE rebuilds the table and its indexes — the MySQL counterpart of vacuum and reindex.)' : ''}`
    })
  }

  const database = parseDatabaseUrl(ctx.target.url)?.database ?? ''
  // A rewrite (VACUUM FULL, REINDEX) holds an exclusive lock; on a database
  // others use, give up rather than queue every other query behind it.
  const exclusive = operation === 'vacuum_full' || operation === 'reindex'
  return withSqlSession(ctx.target.url, { readOnly: operation === 'check', statementTimeoutMs: 3_600_000, lockTimeoutMs: exclusive && !ctx.target.devdb ? 15_000 : undefined }, async (session) => {
    const problem = await connectionProblem(session, ctx.target)
    if (problem) return problem
    if (operation === 'check') return pgCheck(ctx, session, table)
    if (table) {
      const exists = await queryRows(session, 'SELECT to_regclass($1) IS NOT NULL AS present', [qualifiedIdent(table, 'postgres')])
      if (exists.rows[0]?.present !== true) return `${targetLine(ctx.target)}\nNo table ${qualifiedIdent(table, 'postgres')}${exists.error ? ` (${exists.error})` : ''}. Names are case-sensitive once quoted; use action schema to list them.`
    }
    const statement = pgMaintenanceSql(operation, table, database)!
    const before = await pgFootprint(session, table)
    const result = await session.run(statement, { timeoutMs: 3_600_000 })
    if (!result.ok) {
      const lock = /lock timeout/i.test(result.error ?? '') ? ' The table is in use: it needs an exclusive lock that did not come free within 15s. Try again when it is quiet, or use vacuum_analyze, which does not block reads or writes.' : ''
      return `${targetLine(ctx.target)}\n${statement} failed: ${result.error ?? 'unknown error'}${lock}`
    }
    const after = await pgFootprint(session, table)
    const rows = [before, after].filter((row): row is Record<string, unknown> => Boolean(row)).map((row, index) => ({ when: index === 0 ? 'before' : 'after', ...row }))
    return `${targetLine(ctx.target)}\n${statement} — done in ${result.elapsedMs}ms\n${rows.length ? formatRows(rows) : ''}${exclusive ? '' : '\n(Plain VACUUM makes dead-row space reusable but rarely shrinks the file; vacuum_full rewrites the table to return space, holding an exclusive lock while it does.)'}`
  })
}

// ---------------------------------------------------------------------------
// terminate
// ---------------------------------------------------------------------------

export async function terminate(ctx: DbContext, input: Record<string, unknown>): Promise<string> {
  const pid = numberOf(input.pid)
  if (!Number.isSafeInteger(pid) || pid <= 0) return 'terminate needs `pid`: the session id from action activity.'
  const mode = input.mode === 'terminate' ? 'terminate' : 'cancel'
  if (ctx.engine === 'sqlite') return 'SQLite has no sessions to end: whatever holds the file open is a process on this machine.'
  return withSqlSession(ctx.target.url, {}, async (session) => {
    const problem = await connectionProblem(session, ctx.target)
    if (problem) return problem
    if (ctx.engine === 'mysql') {
      const info = await queryRows(session, 'SELECT id, user, host, db, command, time, LEFT(info, 160) AS query FROM information_schema.processlist WHERE id = ?', [pid])
      if (info.rows.length === 0) return `${targetLine(ctx.target)}\nNo session with id ${pid}.`
      const result = await session.run(`${mode === 'cancel' ? 'KILL QUERY' : 'KILL'} ${pid}`)
      return `${targetLine(ctx.target)}\n${formatRows(info.rows)}\n${result.ok ? (mode === 'cancel' ? 'its running statement was cancelled; the session stays connected' : 'the session was ended') : `failed: ${result.error ?? 'unknown error'}`}`
    }
    const info = await queryRows(session, "SELECT pid, usename AS \"user\", datname AS database, application_name AS app, state, left(regexp_replace(coalesce(query, ''), '\\s+', ' ', 'g'), 160) AS query FROM pg_stat_activity WHERE pid = $1", [pid])
    if (info.rows.length === 0) return `${targetLine(ctx.target)}\nNo session with pid ${pid}.`
    const own = await queryRows(session, 'SELECT pg_backend_pid() AS pid')
    if (numberOf(own.rows[0]?.pid) === pid) return 'That pid is elia\'s own connection.'
    const result = await queryRows(session, `SELECT ${mode === 'cancel' ? 'pg_cancel_backend' : 'pg_terminate_backend'}($1) AS done`, [pid])
    if (result.error) return `${targetLine(ctx.target)}\n${mode} failed: ${result.error}`
    const done = result.rows[0]?.done === true
    let after = ''
    if (done && mode === 'terminate') {
      await new Promise((resolve) => setTimeout(resolve, 250))
      const still = await queryRows(session, 'SELECT 1 AS present FROM pg_stat_activity WHERE pid = $1', [pid])
      after = still.rows.length === 0 ? ' It is gone from pg_stat_activity.' : ' It is still listed; it may be finishing a rollback.'
    }
    return `${targetLine(ctx.target)}\n${formatRows(info.rows)}\n${done
      ? (mode === 'cancel' ? 'Its running statement was cancelled — the client gets an error, and a transaction it was in is aborted; the session stays connected.' : `The session was ended; its open transaction was rolled back.${after}`)
      : 'Postgres did not signal it (it may already have finished, or this role may not be allowed to end sessions it does not own).'}`
  })
}
