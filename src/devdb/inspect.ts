/**
 * Looking at a database the way a DBA does: what the server is and holds
 * (overview), one table in depth (describe), who is connected and what is
 * waiting on what (activity), who may do what (roles), and how the server is
 * configured (settings — the one action here that can also change something).
 *
 * Everything that only looks runs on a read-only connection: Postgres sessions
 * are opened with `default_transaction_read_only`, SQLite files read-only, so a
 * catalog query that is somehow wrong still cannot write.
 */

import { statSync } from 'node:fs'
import {
  connectionProblem, formatBytes, isPlainName, numberOf, parseQualifiedName, qualifiedIdent, queryRows, quoteIdent, quoteLiteral,
  renderSections, targetLine, type CatalogSection, type DbContext, type QualifiedName,
} from './common.ts'
import { formatRows, withSqlSession, type SqlSession } from './sql.ts'
import { sqliteFileOf } from './url.ts'

const READ_ONLY = { readOnly: true, statementTimeoutMs: 30_000 }

async function inspectWith(ctx: DbContext, body: (session: SqlSession) => Promise<string>): Promise<string> {
  try {
    return await withSqlSession(ctx.target.url, READ_ONLY, async (session) => (await connectionProblem(session, ctx.target)) ?? body(session))
  } catch (error) {
    return `${targetLine(ctx.target)}\ncould not open the database: ${error instanceof Error ? error.message : String(error)}`
  }
}

// ---------------------------------------------------------------------------
// overview
// ---------------------------------------------------------------------------

const PG_OVERVIEW: CatalogSection[] = [
  {
    title: 'Server',
    sql: `SELECT split_part(version(), ' on ', 1) AS version, current_database() AS database, current_user AS "user",
      current_setting('is_superuser') AS superuser, pg_is_in_recovery() AS replica,
      date_trunc('second', now() - pg_postmaster_start_time())::text AS uptime,
      (SELECT count(*) FROM pg_stat_activity)::text || ' / ' || current_setting('max_connections') AS connections,
      pg_size_pretty(pg_database_size(current_database())) AS size`,
  },
  {
    title: 'Databases',
    sql: `SELECT d.datname AS database, pg_get_userbyid(d.datdba) AS owner,
      CASE WHEN has_database_privilege(d.datname, 'CONNECT') THEN pg_size_pretty(pg_database_size(d.datname)) ELSE '(no access)' END AS size,
      pg_encoding_to_char(d.encoding) AS encoding, coalesce(s.numbackends, 0) AS connections
      FROM pg_database d LEFT JOIN pg_stat_database s ON s.datid = d.oid
      WHERE NOT d.datistemplate
      ORDER BY CASE WHEN has_database_privilege(d.datname, 'CONNECT') THEN pg_database_size(d.datname) ELSE 0 END DESC`,
  },
  {
    title: 'Schemas',
    sql: `SELECT n.nspname AS schema, pg_get_userbyid(n.nspowner) AS owner,
      count(c.oid) FILTER (WHERE c.relkind IN ('r', 'p')) AS tables, count(c.oid) FILTER (WHERE c.relkind IN ('v', 'm')) AS views,
      count(c.oid) FILTER (WHERE c.relkind = 'S') AS sequences,
      pg_size_pretty(coalesce(sum(pg_total_relation_size(c.oid)) FILTER (WHERE c.relkind IN ('r', 'p', 'm')), 0)) AS size
      FROM pg_namespace n LEFT JOIN pg_class c ON c.relnamespace = n.oid
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname !~ '^pg_(toast|temp)'
      GROUP BY n.nspname, n.nspowner ORDER BY 1`,
  },
  {
    title: 'Largest tables',
    sql: `SELECT n.nspname || '.' || c.relname AS "table", pg_size_pretty(pg_total_relation_size(c.oid)) AS total,
      pg_size_pretty(pg_relation_size(c.oid)) AS data, pg_size_pretty(pg_indexes_size(c.oid)) AS indexes, greatest(c.reltuples, 0)::bigint AS est_rows
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p', 'm') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname !~ '^pg_toast'
      ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 15`,
    empty: '(no tables yet)',
  },
  { title: 'Extensions', sql: `SELECT e.extname AS extension, e.extversion AS version, n.nspname AS schema FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace ORDER BY 1` },
  { title: 'Sessions by state', sql: `SELECT coalesce(state, backend_type) AS state, count(*) AS sessions FROM pg_stat_activity GROUP BY 1 ORDER BY 2 DESC` },
]

const MYSQL_OVERVIEW: CatalogSection[] = [
  { title: 'Server', sql: 'SELECT VERSION() AS version, DATABASE() AS `database`, CURRENT_USER() AS `user`, @@max_connections AS max_connections, @@read_only AS read_only' },
  { title: 'Status', sql: "SHOW GLOBAL STATUS WHERE Variable_name IN ('Uptime', 'Threads_connected', 'Threads_running', 'Questions', 'Slow_queries', 'Aborted_connects')" },
  {
    title: 'Databases',
    sql: 'SELECT table_schema AS `database`, COUNT(*) AS `tables`, ROUND(SUM(data_length + index_length) / 1048576, 1) AS size_mb FROM information_schema.tables GROUP BY table_schema ORDER BY size_mb DESC',
  },
  {
    title: 'Largest tables',
    sql: 'SELECT table_name AS `table`, engine, table_rows AS est_rows, ROUND(data_length / 1048576, 1) AS data_mb, ROUND(index_length / 1048576, 1) AS index_mb FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY data_length + index_length DESC LIMIT 15',
    empty: '(no tables yet)',
  },
]

async function sqliteOverview(ctx: DbContext, session: SqlSession): Promise<string> {
  const file = sqliteFileOf(ctx.target.url)
  let size = 'unknown'
  try {
    size = formatBytes(statSync(file).size)
  } catch {
    // an in-memory database has no file
  }
  const sections = await renderSections(session, [
    { title: 'Database', sql: `SELECT sqlite_version() AS version, ${quoteLiteral(file, 'sqlite')} AS file, ${quoteLiteral(size, 'sqlite')} AS size` },
    { title: 'Settings stored in the file', sql: 'SELECT * FROM pragma_journal_mode, pragma_page_size, pragma_page_count, pragma_freelist_count, pragma_auto_vacuum, pragma_user_version, pragma_encoding' },
    { title: 'Objects', sql: "SELECT type, count(*) AS count FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' GROUP BY type ORDER BY type" },
  ])
  const tables = await queryRows(session, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name LIMIT 60")
  const counts: Record<string, unknown>[] = []
  for (const row of tables.rows) {
    const name = String(row.name)
    const count = await queryRows(session, `SELECT count(*) AS n FROM ${quoteIdent(name, 'sqlite')}`)
    counts.push({ table: name, rows: count.error ? `(${count.error})` : count.rows[0]?.n })
  }
  sections.push(`## Tables\n${counts.length === 0 ? '(no tables yet)' : formatRows(counts)}`)
  sections.push('Foreign keys are enforced per connection in SQLite: elia turns them on for its own writes; the application must set PRAGMA foreign_keys = ON on its connections too.')
  return sections.join('\n\n')
}

export function overview(ctx: DbContext): Promise<string> {
  return inspectWith(ctx, async (session) => {
    const body = ctx.engine === 'sqlite' ? await sqliteOverview(ctx, session) : (await renderSections(session, ctx.engine === 'mysql' ? MYSQL_OVERVIEW : PG_OVERVIEW)).join('\n\n')
    return `${targetLine(ctx.target)}\n\n${body}`
  })
}

// ---------------------------------------------------------------------------
// describe
// ---------------------------------------------------------------------------

interface PgRelation {
  oid: number
  schema: string
  name: string
  kind: string
}

const PG_KIND: Record<string, string> = { r: 'table', p: 'partitioned table', v: 'view', m: 'materialized view', f: 'foreign table' }

async function findPgRelation(session: SqlSession, name: QualifiedName): Promise<{ relation?: PgRelation; others: string[]; error?: string }> {
  const lookup = (caseInsensitive: boolean) => queryRows(
    session,
    `SELECT c.oid::bigint AS oid, n.nspname AS schema, c.relname AS name, c.relkind::text AS kind
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND n.nspname !~ '^pg_toast'
       AND ${caseInsensitive ? 'lower(c.relname) = lower($1)' : 'c.relname = $1'}
       AND ($2::text IS NULL OR ${caseInsensitive ? 'lower(n.nspname) = lower($2)' : 'n.nspname = $2'})
     ORDER BY (n.nspname = ANY (current_schemas(false))) DESC, n.nspname LIMIT 10`,
    [name.name, name.schema ?? null],
  )
  let found = await lookup(false)
  if (found.error) return { others: [], error: found.error }
  if (found.rows.length === 0) found = await lookup(true)
  const rows = found.rows.map((row) => ({ oid: numberOf(row.oid), schema: String(row.schema), name: String(row.name), kind: String(row.kind) }))
  const [relation, ...rest] = rows
  return { relation, others: rest.map((other) => `${other.schema}.${other.name}`) }
}

function pgDescribeSections(relation: PgRelation): CatalogSection[] {
  const oid = `${relation.oid}::oid`
  const table = relation.kind === 'r' || relation.kind === 'p' || relation.kind === 'f'
  const sections: CatalogSection[] = [
    {
      title: 'Columns',
      sql: `SELECT a.attname AS "column", format_type(a.atttypid, a.atttypmod) AS type, CASE WHEN a.attnotnull THEN 'not null' ELSE '' END AS "null",
        coalesce(pg_get_expr(d.adbin, d.adrelid), '') AS "default",
        concat_ws(' ', CASE a.attidentity WHEN 'a' THEN 'identity always' WHEN 'd' THEN 'identity' END, CASE a.attgenerated WHEN 's' THEN 'generated' END) AS extra,
        coalesce(col_description(a.attrelid, a.attnum), '') AS comment
        FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = ${oid} AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`,
    },
  ]
  if (relation.kind === 'v' || relation.kind === 'm') sections.push({ title: 'Definition', sql: `SELECT pg_get_viewdef(${oid}, true) AS definition` })
  if (table || relation.kind === 'm') {
    sections.push(
      {
        title: 'Size and activity',
        sql: `SELECT pg_size_pretty(pg_total_relation_size(c.oid)) AS total, pg_size_pretty(pg_relation_size(c.oid)) AS data, pg_size_pretty(pg_indexes_size(c.oid)) AS indexes,
          greatest(c.reltuples, 0)::bigint AS est_rows, s.n_live_tup AS live_rows, s.n_dead_tup AS dead_rows, s.seq_scan, s.idx_scan,
          greatest(s.last_vacuum, s.last_autovacuum) AS last_vacuum, greatest(s.last_analyze, s.last_autoanalyze) AS last_analyze,
          CASE WHEN c.relrowsecurity THEN 'on' || CASE WHEN c.relforcerowsecurity THEN ' (forced)' ELSE '' END ELSE 'off' END AS row_security
          FROM pg_class c LEFT JOIN pg_stat_all_tables s ON s.relid = c.oid WHERE c.oid = ${oid}`,
      },
      {
        title: 'Constraints',
        sql: `SELECT conname AS name, CASE contype WHEN 'p' THEN 'primary key' WHEN 'f' THEN 'foreign key' WHEN 'u' THEN 'unique' WHEN 'c' THEN 'check' WHEN 'x' THEN 'exclusion' ELSE contype::text END AS type,
          pg_get_constraintdef(oid, true) AS definition FROM pg_constraint WHERE conrelid = ${oid} ORDER BY contype, conname`,
        empty: '(none — no primary key)',
      },
      {
        title: 'Indexes',
        sql: `SELECT i.relname AS index, pg_get_indexdef(x.indexrelid) AS definition, pg_size_pretty(pg_relation_size(x.indexrelid)) AS size,
          coalesce(s.idx_scan, 0) AS scans, CASE WHEN x.indisvalid THEN '' ELSE 'INVALID' END AS state
          FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid LEFT JOIN pg_stat_all_indexes s ON s.indexrelid = x.indexrelid
          WHERE x.indrelid = ${oid} ORDER BY i.relname`,
        empty: '(no indexes)',
      },
      {
        title: 'Referenced by',
        sql: `SELECT conrelid::regclass::text AS "table", conname AS "constraint", pg_get_constraintdef(oid, true) AS definition FROM pg_constraint WHERE confrelid = ${oid} AND contype = 'f' ORDER BY 1, 2`,
        hideEmpty: true,
      },
      {
        title: 'Triggers',
        sql: `SELECT tgname AS trigger, CASE tgenabled WHEN 'D' THEN 'disabled' ELSE 'enabled' END AS state, pg_get_triggerdef(oid, true) AS definition FROM pg_trigger WHERE tgrelid = ${oid} AND NOT tgisinternal ORDER BY 1`,
        hideEmpty: true,
      },
      {
        title: 'Row-level security policies',
        sql: `SELECT polname AS policy, CASE polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT' WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE' ELSE 'ALL' END AS command,
          CASE WHEN polpermissive THEN 'permissive' ELSE 'restrictive' END AS kind, coalesce(pg_get_expr(polqual, polrelid), '') AS "using", coalesce(pg_get_expr(polwithcheck, polrelid), '') AS with_check
          FROM pg_policy WHERE polrelid = ${oid} ORDER BY 1`,
        hideEmpty: true,
      },
    )
  }
  if (relation.kind === 'p') {
    sections.push({ title: 'Partitions', sql: `SELECT i.inhrelid::regclass::text AS partition, pg_get_expr(c.relpartbound, c.oid) AS bound FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid WHERE i.inhparent = ${oid} ORDER BY 1` })
  }
  sections.push({
    title: 'Privileges',
    sql: `SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee, string_agg(a.privilege_type, ', ' ORDER BY a.privilege_type) AS privileges
      FROM pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a WHERE c.oid = ${oid} GROUP BY 1 ORDER BY 1`,
  })
  return sections
}

async function describePostgres(ctx: DbContext, session: SqlSession, name: QualifiedName): Promise<string> {
  const found = await findPgRelation(session, name)
  if (found.error) return `${targetLine(ctx.target)}\nlookup failed: ${found.error}`
  if (!found.relation) return `${targetLine(ctx.target)}\nNo table or view named ${name.schema ? `${name.schema}.` : ''}${name.name}. Use action "schema" to list them.`
  const relation = found.relation
  const head = `${targetLine(ctx.target)}\n# ${PG_KIND[relation.kind] ?? 'relation'} ${relation.schema}.${relation.name}${found.others.length ? `\n(also: ${found.others.join(', ')} — pass the schema to pick one)` : ''}`
  return [head, ...(await renderSections(session, pgDescribeSections(relation)))].join('\n\n')
}

async function describeSqlite(ctx: DbContext, session: SqlSession, name: QualifiedName): Promise<string> {
  const exact = await queryRows(session, "SELECT type, name, sql FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?", [name.name])
  const rows = exact.rows.length > 0 ? exact.rows : (await queryRows(session, "SELECT type, name, sql FROM sqlite_master WHERE type IN ('table', 'view') AND lower(name) = lower(?)", [name.name])).rows
  const object = rows[0]
  if (!object) return `${targetLine(ctx.target)}\nNo table or view named ${name.name}. Use action "schema" to list them.`
  const table = String(object.name)
  const sections = await renderSections(session, [
    {
      title: 'Columns',
      sql: `SELECT name AS "column", type, CASE WHEN "notnull" THEN 'not null' ELSE '' END AS "null", coalesce(dflt_value, '') AS "default",
        CASE WHEN pk > 0 THEN 'primary key' || CASE WHEN pk > 1 THEN ' #' || pk ELSE '' END ELSE '' END AS "key",
        CASE hidden WHEN 1 THEN 'hidden' WHEN 2 THEN 'generated' WHEN 3 THEN 'generated stored' ELSE '' END AS extra
        FROM pragma_table_xinfo(?)`,
      params: [table],
    },
    { title: 'Rows', sql: `SELECT count(*) AS rows FROM ${quoteIdent(table, 'sqlite')}` },
    {
      title: 'Indexes',
      sql: `SELECT il.name AS "index", CASE WHEN il."unique" THEN 'unique' ELSE '' END AS "unique", CASE il.origin WHEN 'pk' THEN 'primary key' WHEN 'u' THEN 'unique constraint' ELSE 'created' END AS origin,
        (SELECT group_concat(ii.name, ', ') FROM pragma_index_info(il.name) ii) AS columns, CASE WHEN il.partial THEN 'partial' ELSE '' END AS partial
        FROM pragma_index_list(?) il ORDER BY il.name`,
      params: [table],
      empty: '(no indexes)',
    },
    {
      title: 'Foreign keys',
      sql: `SELECT "from" AS "column", "table" AS references_table, "to" AS references_column, on_update, on_delete FROM pragma_foreign_key_list(?)`,
      params: [table],
      hideEmpty: true,
    },
    {
      title: 'Referenced by',
      sql: `SELECT m.name AS "table", f."from" AS "column", f."to" AS references_column, f.on_delete FROM sqlite_master m, pragma_foreign_key_list(m.name) f WHERE m.type = 'table' AND f."table" = ?`,
      params: [table],
      hideEmpty: true,
    },
    { title: 'Triggers', sql: "SELECT name AS trigger, sql AS definition FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?", params: [table], hideEmpty: true },
  ])
  return [`${targetLine(ctx.target)}\n# ${String(object.type)} ${table}\n${String(object.sql ?? '')}`, ...sections].join('\n\n')
}

async function describeMysql(ctx: DbContext, session: SqlSession, name: QualifiedName): Promise<string> {
  const found = await queryRows(
    session,
    'SELECT table_schema AS `schema`, table_name AS `name`, table_type AS `type`, engine, table_rows AS est_rows, ROUND(data_length / 1048576, 2) AS data_mb, ROUND(index_length / 1048576, 2) AS index_mb, table_comment AS comment FROM information_schema.tables WHERE table_schema = COALESCE(?, DATABASE()) AND table_name = ?',
    [name.schema ?? null, name.name],
  )
  if (found.error) return `${targetLine(ctx.target)}\nlookup failed: ${found.error}`
  const object = found.rows[0]
  if (!object) return `${targetLine(ctx.target)}\nNo table or view named ${name.name}. Use action "schema" to list them.`
  const schema = String(object.schema)
  const table = String(object.name)
  const sections = await renderSections(session, [
    { title: 'Table', sql: 'SELECT ? AS `table`, ? AS `type`, ? AS engine, ? AS est_rows, ? AS data_mb, ? AS index_mb', params: [table, object.type, object.engine, object.est_rows, object.data_mb, object.index_mb] },
    {
      title: 'Columns',
      sql: "SELECT column_name AS `column`, column_type AS type, IF(is_nullable = 'NO', 'not null', '') AS `null`, COALESCE(column_default, '') AS `default`, column_key AS `key`, extra, column_comment AS comment FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position",
      params: [schema, table],
    },
    {
      title: 'Indexes',
      sql: "SELECT index_name AS `index`, IF(non_unique = 0, 'unique', '') AS `unique`, GROUP_CONCAT(column_name ORDER BY seq_in_index SEPARATOR ', ') AS columns, index_type AS type FROM information_schema.statistics WHERE table_schema = ? AND table_name = ? GROUP BY index_name, non_unique, index_type ORDER BY index_name",
      params: [schema, table],
      empty: '(no indexes)',
    },
    {
      title: 'Foreign keys',
      sql: 'SELECT k.constraint_name AS `constraint`, GROUP_CONCAT(k.column_name ORDER BY k.ordinal_position) AS columns, k.referenced_table_name AS references_table, GROUP_CONCAT(k.referenced_column_name ORDER BY k.ordinal_position) AS references_columns, r.update_rule, r.delete_rule FROM information_schema.key_column_usage k JOIN information_schema.referential_constraints r ON r.constraint_schema = k.constraint_schema AND r.constraint_name = k.constraint_name WHERE k.table_schema = ? AND k.table_name = ? AND k.referenced_table_name IS NOT NULL GROUP BY k.constraint_name, k.referenced_table_name, r.update_rule, r.delete_rule',
      params: [schema, table],
      hideEmpty: true,
    },
    {
      title: 'Referenced by',
      sql: 'SELECT table_name AS `table`, constraint_name AS `constraint`, GROUP_CONCAT(column_name) AS columns FROM information_schema.key_column_usage WHERE referenced_table_schema = ? AND referenced_table_name = ? GROUP BY table_name, constraint_name',
      params: [schema, table],
      hideEmpty: true,
    },
    {
      title: 'Triggers',
      sql: 'SELECT trigger_name AS `trigger`, action_timing AS timing, event_manipulation AS event, action_statement AS body FROM information_schema.triggers WHERE event_object_schema = ? AND event_object_table = ?',
      params: [schema, table],
      hideEmpty: true,
    },
    { title: 'Definition', sql: `SHOW CREATE TABLE ${quoteIdent(schema, 'mysql')}.${quoteIdent(table, 'mysql')}`, optional: true },
  ])
  return [`${targetLine(ctx.target)}\n# ${schema}.${table}`, ...sections].join('\n\n')
}

export function describe(ctx: DbContext, input: Record<string, unknown>): Promise<string> {
  const raw = typeof input.table === 'string' ? input.table.trim() : ''
  const name = raw ? parseQualifiedName(raw) : undefined
  if (!name) return Promise.resolve('describe needs `table`: a table or view name, optionally schema-qualified (public.users, "auth"."User").')
  return inspectWith(ctx, (session) => (ctx.engine === 'sqlite' ? describeSqlite(ctx, session, name) : ctx.engine === 'mysql' ? describeMysql(ctx, session, name) : describePostgres(ctx, session, name)))
}

// ---------------------------------------------------------------------------
// activity
// ---------------------------------------------------------------------------

async function pgSlowQueries(session: SqlSession): Promise<string> {
  const installed = await queryRows(session, "SELECT extversion FROM pg_extension WHERE extname = 'pg_stat_statements'")
  if (installed.rows.length === 0) {
    return '## Slowest statements\npg_stat_statements is not installed, so there is no per-statement history. To collect it: add pg_stat_statements to shared_preload_libraries (settings), restart the server, then CREATE EXTENSION pg_stat_statements.'
  }
  const scope = 'WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())'
  for (const [total, mean] of [['total_exec_time', 'mean_exec_time'], ['total_time', 'mean_time']] as const) {
    const result = await session.run(
      `SELECT calls, round(${total}::numeric, 1) AS total_ms, round(${mean}::numeric, 2) AS mean_ms, rows, left(regexp_replace(query, '\\s+', ' ', 'g'), 200) AS query FROM pg_stat_statements ${scope} ORDER BY ${total} DESC LIMIT 10`,
      { timeoutMs: 30_000 },
    )
    if (result.ok) return `## Slowest statements (pg_stat_statements, by total time)\n${formatRows(result.statements.at(-1)?.rows ?? [])}`
    if (!/column .* does not exist/i.test(result.error ?? '')) return `## Slowest statements\n(unavailable: ${result.error ?? 'unknown error'})`
  }
  return '## Slowest statements\n(unavailable: this pg_stat_statements version is not one elia reads)'
}

const PG_ACTIVITY: CatalogSection[] = [
  {
    title: 'Sessions',
    sql: `SELECT a.pid, a.usename AS "user", a.datname AS database, coalesce(a.application_name, '') AS app, coalesce(host(a.client_addr), 'local') AS client, a.state,
      coalesce(a.wait_event_type || ':' || a.wait_event, '') AS waiting_on,
      coalesce(date_trunc('second', now() - a.xact_start)::text, '') AS in_transaction,
      coalesce(date_trunc('second', now() - a.query_start)::text, '') AS since_query,
      coalesce(array_to_string(pg_blocking_pids(a.pid), ','), '') AS blocked_by,
      left(regexp_replace(coalesce(a.query, ''), '\\s+', ' ', 'g'), 200) AS query
      FROM pg_stat_activity a
      WHERE a.pid <> pg_backend_pid() AND a.backend_type = 'client backend'
      ORDER BY a.state = 'idle', a.xact_start NULLS LAST LIMIT 100`,
    empty: '(no other sessions)',
  },
  {
    title: 'Blocked sessions',
    sql: `SELECT blocked.pid AS blocked_pid, date_trunc('second', now() - blocked.query_start)::text AS waiting, left(regexp_replace(blocked.query, '\\s+', ' ', 'g'), 120) AS blocked_query,
      blocker.pid AS blocking_pid, blocker.state AS blocker_state, left(regexp_replace(blocker.query, '\\s+', ' ', 'g'), 120) AS blocking_query
      FROM pg_stat_activity blocked
      JOIN LATERAL unnest(pg_blocking_pids(blocked.pid)) AS b(pid) ON true
      JOIN pg_stat_activity blocker ON blocker.pid = b.pid
      ORDER BY blocked.query_start`,
    empty: '(nothing is waiting on a lock)',
  },
]

export function activity(ctx: DbContext): Promise<string> {
  if (ctx.engine === 'sqlite') {
    return Promise.resolve(`${targetLine(ctx.target)}\nSQLite has no server, sessions or lock table to inspect: each process opens the file itself. "database is locked" means another process holds the write lock — WAL mode (settings name=journal_mode value=WAL) lets readers carry on during a write.`)
  }
  return inspectWith(ctx, async (session) => {
    if (ctx.engine === 'mysql') {
      const sections = await renderSections(session, [
        {
          title: 'Sessions',
          sql: 'SELECT id, user, host, db, command, time AS seconds, state, LEFT(info, 200) AS query FROM information_schema.processlist WHERE id <> CONNECTION_ID() ORDER BY time DESC LIMIT 100',
          empty: '(no other sessions)',
        },
        { title: 'Lock waits', sql: 'SELECT * FROM sys.innodb_lock_waits', optional: true, empty: '(nothing is waiting on a lock)' },
      ])
      return [targetLine(ctx.target), ...sections, 'End a session with action "terminate" and its id.'].join('\n\n')
    }
    const sections = await renderSections(session, PG_ACTIVITY)
    sections.push(await pgSlowQueries(session))
    return [targetLine(ctx.target), ...sections, 'Cancel a query or end a session with action "terminate" and its pid.'].join('\n\n')
  })
}

// ---------------------------------------------------------------------------
// roles
// ---------------------------------------------------------------------------

const PG_ROLES: CatalogSection = {
  title: 'Roles',
  sql: `SELECT r.rolname AS role,
    concat_ws(', ', CASE WHEN r.rolsuper THEN 'superuser' END, CASE WHEN r.rolcanlogin THEN 'login' END, CASE WHEN r.rolcreatedb THEN 'createdb' END,
      CASE WHEN r.rolcreaterole THEN 'createrole' END, CASE WHEN r.rolreplication THEN 'replication' END, CASE WHEN r.rolbypassrls THEN 'bypassrls' END) AS attributes,
    CASE WHEN r.rolconnlimit >= 0 THEN r.rolconnlimit::text ELSE '' END AS conn_limit, coalesce(r.rolvaliduntil::text, '') AS valid_until,
    coalesce((SELECT string_agg(g.rolname, ', ' ORDER BY g.rolname) FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid WHERE m.member = r.oid), '') AS member_of
    FROM pg_roles r WHERE r.rolname !~ '^pg_' ORDER BY r.rolsuper DESC, r.rolcanlogin DESC, r.rolname`,
}

function pgRoleSections(role: string): CatalogSection[] {
  const privilege = (kind: string) => `CASE WHEN has_table_privilege($1, c.oid, '${kind}') THEN '${kind}' END`
  return [
    {
      title: `Databases ${role} can use`,
      sql: `SELECT datname AS database, has_database_privilege($1, datname, 'CONNECT') AS connect, has_database_privilege($1, datname, 'CREATE') AS "create", has_database_privilege($1, datname, 'TEMP') AS temp FROM pg_database WHERE NOT datistemplate ORDER BY 1`,
      params: [role],
    },
    {
      title: `Schemas ${role} can use`,
      sql: `SELECT nspname AS schema, has_schema_privilege($1, oid, 'USAGE') AS usage, has_schema_privilege($1, oid, 'CREATE') AS "create" FROM pg_namespace WHERE nspname <> 'information_schema' AND nspname !~ '^pg_' ORDER BY 1`,
      params: [role],
    },
    {
      title: `Table privileges of ${role}`,
      sql: `SELECT n.nspname || '.' || c.relname AS "table",
        concat_ws(', ', ${['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'].map(privilege).join(', ')}) AS privileges
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname !~ '^pg_toast'
        ORDER BY 1 LIMIT 300`,
      params: [role],
      empty: '(no tables)',
    },
  ]
}

export function roles(ctx: DbContext, input: Record<string, unknown>): Promise<string> {
  if (ctx.engine === 'sqlite') {
    return Promise.resolve(`${targetLine(ctx.target)}\nSQLite has no users, roles or privileges: whoever can read and write the file can do anything with it. Access control is the file's permissions.`)
  }
  const role = typeof input.role === 'string' ? input.role.trim() : ''
  return inspectWith(ctx, async (session) => {
    if (ctx.engine === 'mysql') {
      const sections = await renderSections(session, [
        { title: 'Accounts', sql: 'SELECT user, host, account_locked, password_expired FROM mysql.user ORDER BY user, host', optional: true },
        { title: role ? `Grants for ${role}` : 'Grants for the current user', sql: role ? `SHOW GRANTS FOR ${mysqlAccount(role)}` : 'SHOW GRANTS' },
      ])
      return [targetLine(ctx.target), ...sections].join('\n\n')
    }
    if (!role) return [targetLine(ctx.target), ...(await renderSections(session, [PG_ROLES])), 'Pass `role` to see what one role can reach. Change roles with query: CREATE ROLE / ALTER ROLE / GRANT / REVOKE — put a password in as ${env:NAME}, never as text.'].join('\n\n')
    const exists = await queryRows(session, 'SELECT 1 AS present FROM pg_roles WHERE rolname = $1', [role])
    if (exists.rows.length === 0) return `${targetLine(ctx.target)}\nNo role named ${role}.${exists.error ? ` (${exists.error})` : ''}`
    return [targetLine(ctx.target), ...(await renderSections(session, [{ ...PG_ROLES, sql: PG_ROLES.sql.replace("WHERE r.rolname !~ '^pg_'", 'WHERE r.rolname = $1'), params: [role] }, ...pgRoleSections(role)]))].join('\n\n')
  })
}

/** `app@%` / `'app'@'localhost'` → `'app'@'%'`, quoted for SHOW GRANTS. */
function mysqlAccount(role: string): string {
  const [user, host] = role.replace(/'/g, '').split('@')
  return `${quoteLiteral(user ?? role, 'mysql')}@${quoteLiteral(host || '%', 'mysql')}`
}

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

const PG_KEY_SETTINGS = ['shared_buffers', 'work_mem', 'maintenance_work_mem', 'effective_cache_size', 'max_connections', 'wal_level', 'max_wal_size', 'checkpoint_timeout', 'random_page_cost', 'autovacuum', 'statement_timeout', 'idle_in_transaction_session_timeout', 'log_min_duration_statement', 'shared_preload_libraries', 'timezone']
const SQLITE_PRAGMAS = ['journal_mode', 'synchronous', 'page_size', 'cache_size', 'auto_vacuum', 'user_version', 'application_id', 'encoding', 'wal_autocheckpoint', 'temp_store', 'secure_delete', 'recursive_triggers']
/** Pragmas that belong to the connection, not the file: setting them here changes nothing for the application. */
const SQLITE_CONNECTION_PRAGMAS = new Set(['foreign_keys', 'synchronous', 'cache_size', 'busy_timeout', 'temp_store', 'recursive_triggers', 'case_sensitive_like', 'defer_foreign_keys', 'query_only', 'secure_delete'])

async function readSettings(ctx: DbContext, session: SqlSession, name: string): Promise<string> {
  if (ctx.engine === 'sqlite') {
    const names = name ? SQLITE_PRAGMAS.filter((pragma) => pragma.includes(name.toLowerCase())) : SQLITE_PRAGMAS
    const rows: Record<string, unknown>[] = []
    for (const pragma of names.length > 0 ? names : [name.toLowerCase()]) {
      if (!isPlainName(pragma)) continue
      const result = await queryRows(session, `PRAGMA ${pragma}`)
      rows.push({ pragma, value: result.error ? `(${result.error})` : Object.values(result.rows[0] ?? {})[0] ?? '' , scope: SQLITE_CONNECTION_PRAGMAS.has(pragma) ? 'per connection' : 'stored in the file' })
    }
    return `## Pragmas\n${formatRows(rows)}`
  }
  if (ctx.engine === 'mysql') {
    return (await renderSections(session, [{ title: 'Variables', sql: 'SHOW GLOBAL VARIABLES LIKE ?', params: [name ? `%${name}%` : '%'], maxRows: 400 }])).join('\n\n')
  }
  const section: CatalogSection = name
    ? {
        title: `Settings matching "${name}"`,
        sql: `SELECT name, setting || coalesce(' ' || unit, '') AS value, source, context, short_desc AS description, CASE WHEN pending_restart THEN 'restart needed' ELSE '' END AS note FROM pg_settings WHERE name ILIKE '%' || $1 || '%' ORDER BY name LIMIT 60`,
        params: [name],
        empty: '(no setting by that name)',
      }
    : {
        title: 'Settings changed from the default, and the ones that matter most',
        sql: `SELECT name, setting || coalesce(' ' || unit, '') AS value, source, CASE WHEN pending_restart THEN 'restart needed' ELSE '' END AS note FROM pg_settings WHERE source NOT IN ('default', 'override') OR name = ANY ($1) ORDER BY name`,
        params: [PG_KEY_SETTINGS],
      }
  return (await renderSections(session, [section])).join('\n\n')
}

async function changeSetting(ctx: DbContext, name: string, value: string): Promise<string> {
  if (!isPlainName(name)) return `"${name}" is not a setting name.`
  const reset = /^default$/i.test(value)
  return withSqlSession(ctx.target.url, { statementTimeoutMs: 30_000 }, async (session) => {
    const problem = await connectionProblem(session, ctx.target)
    if (problem) return problem
    if (ctx.engine === 'sqlite') {
      if (reset) return 'SQLite pragmas have no stored default to reset to: set the value you want.'
      if (!/^[A-Za-z0-9_.+-]+$/.test(value)) return `"${value}" is not a pragma value (a word or a number).`
      const result = await session.run(`PRAGMA ${name} = ${value}`)
      if (!result.ok) return `PRAGMA ${name} failed: ${result.error ?? 'unknown error'}`
      const now = await queryRows(session, `PRAGMA ${name}`)
      const note = SQLITE_CONNECTION_PRAGMAS.has(name.toLowerCase())
        ? `\nNote: ${name} belongs to the connection, not the file — this changed nothing for the application, which must set it on its own connections.`
        : ''
      return `${targetLine(ctx.target)}\nPRAGMA ${name} is now: ${String(Object.values(now.rows[0] ?? {})[0] ?? '(no value)')}${note}`
    }
    if (ctx.engine === 'mysql') {
      const literal = reset ? 'DEFAULT' : /^-?\d+(?:\.\d+)?$/.test(value) || /^(?:ON|OFF)$/i.test(value) ? value : quoteLiteral(value, 'mysql')
      let result = await session.run(`SET PERSIST ${name} = ${literal}`)
      const persisted = result.ok
      if (!result.ok) result = await session.run(`SET GLOBAL ${name} = ${literal}`)
      if (!result.ok) return `setting ${name} failed: ${result.error ?? 'unknown error'}`
      const now = await queryRows(session, 'SHOW GLOBAL VARIABLES LIKE ?', [name])
      return `${targetLine(ctx.target)}\n${name} = ${String(now.rows[0]?.Value ?? now.rows[0]?.value ?? '?')} (${persisted ? 'persisted across restarts' : 'until the next restart — SET PERSIST was refused'})`
    }
    const statement = reset ? `ALTER SYSTEM RESET ${quoteIdent(name, 'postgres')}` : `ALTER SYSTEM SET ${quoteIdent(name, 'postgres')} = ${quoteLiteral(value, 'postgres')}`
    const altered = await session.run(statement)
    if (!altered.ok) return `${targetLine(ctx.target)}\n${statement} failed: ${altered.error ?? 'unknown error'}`
    await session.run('SELECT pg_reload_conf()')
    // pg_settings in this session reflects the reload only after the signal lands; a fresh read shows pending_restart.
    await new Promise((resolve) => setTimeout(resolve, 300))
    const now = await queryRows(session, "SELECT name, setting || coalesce(' ' || unit, '') AS value, context, pending_restart FROM pg_settings WHERE name = $1", [name])
    const row = now.rows[0]
    if (!row) return `${targetLine(ctx.target)}\n${statement} ran, but no setting named ${name} exists to read back.`
    const restart = row.pending_restart === true || row.context === 'postmaster'
    return `${targetLine(ctx.target)}\n${statement}\n${formatRows([row])}\n${restart
      ? `Takes effect after a server restart${ctx.target.devdb ? ' — action "stop" then "start" restarts elia\'s devdb' : ''}.`
      : 'Reloaded: new sessions use the new value (existing sessions pick it up at their next statement unless it is a per-session setting they changed).'}`
  })
}

export async function settings(ctx: DbContext, input: Record<string, unknown>): Promise<string> {
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  const value = input.value === undefined || input.value === null ? '' : String(input.value).trim()
  if (value) {
    if (!name) return 'settings needs `name` to change a setting.'
    try {
      return await changeSetting(ctx, name, value)
    } catch (error) {
      return `${targetLine(ctx.target)}\nchanging ${name} failed: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  return inspectWith(ctx, async (session) => `${targetLine(ctx.target)}\n\n${await readSettings(ctx, session, name)}\n\nChange one with settings name=<setting> value=<new value> (value "default" resets it).`)
}
