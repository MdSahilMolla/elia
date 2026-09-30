/**
 * A DBA's checkup: the problems that take a database down or make it slow,
 * each reported with the evidence that raised it and the fix.
 *
 * Every check is its own query on a read-only connection. One that fails — a
 * view an older server lacks, a permission the role does not have — is listed
 * as skipped rather than taking the rest of the report with it. Findings are
 * ranked: critical (will cause an outage or data loss), warning (costs
 * performance or safety now), note (worth knowing).
 */

import { connectionProblem, formatBytes, numberOf, queryRows, quoteIdent, targetLine, type DbContext } from './common.ts'
import { withSqlSession, type SqlSession } from './sql.ts'

type Severity = 'critical' | 'warning' | 'note'

interface Finding {
  severity: Severity
  title: string
  detail?: string
  fix?: string
}

interface Checkup {
  findings: Finding[]
  passed: string[]
  skipped: string[]
}

interface Check {
  name: string
  sql: string
  judge: (rows: Record<string, unknown>[], checkup: Checkup) => void
}

function list(rows: Record<string, unknown>[], render: (row: Record<string, unknown>) => string, max = 8): string {
  const shown = rows.slice(0, max).map(render)
  return `${shown.join('; ')}${rows.length > max ? `; … ${rows.length - max} more` : ''}`
}

const pct = (value: number) => `${(value * 100).toFixed(1)}%`

/** Postgres major versions and the month community support ends (postgresql.org/support/versioning). */
const PG_END_OF_LIFE: Record<number, string> = { 11: '2023-11', 12: '2024-11', 13: '2025-11', 14: '2026-11', 15: '2027-11', 16: '2028-11', 17: '2029-11', 18: '2030-11' }

const PG_CHECKS: Check[] = [
  {
    name: 'server version',
    sql: "SELECT current_setting('server_version_num')::int AS num",
    judge(rows, checkup) {
      const major = Math.floor(numberOf(rows[0]?.num) / 10_000)
      const eol = PG_END_OF_LIFE[major]
      if (!eol) {
        checkup.passed.push(`version ${major}`)
        return
      }
      const today = new Date().toISOString().slice(0, 7)
      if (eol <= today) checkup.findings.push({ severity: 'warning', title: `PostgreSQL ${major} is past end of life (${eol}) and gets no security fixes`, fix: 'plan an upgrade (pg_upgrade, or dump and restore into a current major version)' })
      else checkup.passed.push(`version ${major} (supported until ${eol})`)
    },
  },
  {
    name: 'connections',
    sql: `SELECT count(*)::int AS used, current_setting('max_connections')::int AS max FROM pg_stat_activity`,
    judge(rows, checkup) {
      const used = numberOf(rows[0]?.used)
      const max = numberOf(rows[0]?.max)
      const share = used / max
      if (share >= 0.9) checkup.findings.push({ severity: 'critical', title: `connections at ${used} of ${max} (${pct(share)})`, detail: 'new connections will be refused at the limit', fix: 'put a pooler (PgBouncer) in front, lower each app\'s pool size, or end idle sessions (activity → terminate)' })
      else if (share >= 0.75) checkup.findings.push({ severity: 'warning', title: `connections at ${used} of ${max} (${pct(share)})`, fix: 'check each application\'s pool size; consider a pooler' })
      else checkup.passed.push(`connections ${used}/${max}`)
    },
  },
  {
    name: 'idle transactions',
    sql: `SELECT pid, usename AS "user", date_trunc('second', now() - xact_start)::text AS open_for FROM pg_stat_activity
      WHERE state LIKE 'idle in transaction%' AND now() - xact_start > interval '1 minute' ORDER BY xact_start LIMIT 20`,
    judge(rows, checkup) {
      if (rows.length === 0) return void checkup.passed.push('no long idle transactions')
      checkup.findings.push({
        severity: 'warning',
        title: `${rows.length} session(s) idle inside an open transaction for over a minute`,
        detail: `${list(rows, (row) => `pid ${String(row.pid)} (${String(row.user)}, ${String(row.open_for)})`)} — they hold locks and stop vacuum from cleaning up`,
        fix: 'terminate them (action terminate), fix the code that leaves transactions open, and set idle_in_transaction_session_timeout',
      })
    },
  },
  {
    name: 'long-running queries',
    sql: `SELECT pid, usename AS "user", date_trunc('second', now() - query_start)::text AS running FROM pg_stat_activity
      WHERE state = 'active' AND pid <> pg_backend_pid() AND backend_type = 'client backend' AND now() - query_start > interval '5 minutes' ORDER BY query_start LIMIT 20`,
    judge(rows, checkup) {
      if (rows.length === 0) return void checkup.passed.push('no queries running over 5 minutes')
      checkup.findings.push({ severity: 'warning', title: `${rows.length} quer${rows.length === 1 ? 'y has' : 'ies have'} been running over 5 minutes`, detail: list(rows, (row) => `pid ${String(row.pid)} (${String(row.running)})`), fix: 'see them with action activity; explain the query; cancel with terminate mode=cancel if it is stuck' })
    },
  },
  {
    name: 'lock waits',
    sql: 'SELECT count(*)::int AS blocked FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid)) > 0',
    judge(rows, checkup) {
      const blocked = numberOf(rows[0]?.blocked)
      if (blocked > 0) checkup.findings.push({ severity: 'warning', title: `${blocked} session(s) are waiting on a lock right now`, fix: 'action activity shows who blocks whom' })
      else checkup.passed.push('no lock waits')
    },
  },
  {
    name: 'cache hit ratio',
    sql: 'SELECT blks_hit::bigint AS hit, blks_read::bigint AS read FROM pg_stat_database WHERE datname = current_database()',
    judge(rows, checkup) {
      const hit = numberOf(rows[0]?.hit)
      const read = numberOf(rows[0]?.read)
      if (hit + read < 10_000) return void checkup.passed.push('cache hit ratio (too little traffic to judge)')
      const ratio = hit / (hit + read)
      if (ratio < 0.95) checkup.findings.push({ severity: 'warning', title: `cache hit ratio is ${pct(ratio)}`, detail: 'a busy database usually serves over 99% of reads from memory', fix: 'raise shared_buffers (about 25% of RAM) and effective_cache_size, or add memory; check the largest tables with overview' })
      else checkup.passed.push(`cache hit ratio ${pct(ratio)}`)
    },
  },
  {
    name: 'transaction ID wraparound',
    sql: 'SELECT datname, age(datfrozenxid)::bigint AS age FROM pg_database ORDER BY 2 DESC LIMIT 1',
    judge(rows, checkup) {
      const age = numberOf(rows[0]?.age)
      const name = String(rows[0]?.datname ?? '')
      if (age > 1_600_000_000) checkup.findings.push({ severity: 'critical', title: `database ${name} is ${Math.round(age / 1e6)}M transactions from its last freeze`, detail: 'at about 2,000M Postgres stops accepting writes to protect the data', fix: `VACUUM (FREEZE) the oldest tables in ${name} now, and check why autovacuum is not keeping up` })
      else if (age > 1_000_000_000) checkup.findings.push({ severity: 'warning', title: `database ${name} is ${Math.round(age / 1e6)}M transactions from its last freeze`, fix: 'check autovacuum is running and not blocked; VACUUM (FREEZE) the oldest tables' })
      else checkup.passed.push(`transaction ID age ${Math.round(age / 1e6)}M`)
    },
  },
  {
    name: 'sequences near their limit',
    sql: `SELECT s.schemaname || '.' || s.sequencename AS sequence, s.last_value::numeric AS last_value,
      least(s.max_value::numeric, CASE WHEN a.atttypid = 'int4'::regtype THEN 2147483647 WHEN a.atttypid = 'int2'::regtype THEN 32767 ELSE s.max_value::numeric END) AS ceiling,
      coalesce(d.refobjid::regclass::text || '.' || a.attname, '') AS used_by
      FROM pg_sequences s
      JOIN pg_namespace sn ON sn.nspname = s.schemaname
      JOIN pg_class sc ON sc.relname = s.sequencename AND sc.relnamespace = sn.oid
      LEFT JOIN pg_depend d ON d.objid = sc.oid AND d.classid = 'pg_class'::regclass AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')
      LEFT JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
      WHERE s.last_value IS NOT NULL`,
    judge(rows, checkup) {
      const near = rows
        .map((row): Record<string, unknown> & { share: number } => ({ ...row, share: numberOf(row.last_value) / numberOf(row.ceiling) }))
        .filter((row) => row.share > 0.75)
        .sort((a, b) => b.share - a.share)
      if (near.length === 0) return void checkup.passed.push('sequences have headroom')
      for (const row of near.slice(0, 10)) {
        const column = String(row.used_by || row.sequence)
        checkup.findings.push({
          severity: row.share > 0.9 ? 'critical' : 'warning',
          title: `${column} has used ${pct(row.share)} of its ${Number(row.ceiling).toLocaleString('en-US')} values`,
          detail: 'inserts fail once it runs out',
          fix: row.used_by ? `ALTER TABLE … ALTER COLUMN … TYPE bigint on ${column} (rewrites the table; schedule it)` : `ALTER SEQUENCE ${String(row.sequence)} AS bigint`,
        })
      }
    },
  },
  {
    name: 'invalid indexes',
    sql: 'SELECT indexrelid::regclass::text AS index, indrelid::regclass::text AS "table" FROM pg_index WHERE NOT indisvalid',
    judge(rows, checkup) {
      if (rows.length === 0) return void checkup.passed.push('no invalid indexes')
      checkup.findings.push({ severity: 'warning', title: `${rows.length} invalid index(es): ${list(rows, (row) => String(row.index))}`, detail: 'left by a failed CREATE INDEX CONCURRENTLY: never used by queries, still maintained on every write', fix: rows.slice(0, 3).map((row) => `REINDEX INDEX CONCURRENTLY ${String(row.index)}`).join('; ') })
    },
  },
  {
    name: 'duplicate indexes',
    sql: `SELECT array_to_string(array_agg(i.indexrelid::regclass::text ORDER BY i.indexrelid), ', ') AS indexes, i.indrelid::regclass::text AS "table",
      pg_size_pretty(sum(pg_relation_size(i.indexrelid))::bigint) AS size
      FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname !~ '^pg_toast'
      GROUP BY i.indrelid, i.indkey::text, i.indclass::text, coalesce(pg_get_expr(i.indexprs, i.indrelid), ''), coalesce(pg_get_expr(i.indpred, i.indrelid), '')
      HAVING count(*) > 1`,
    judge(rows, checkup) {
      if (rows.length === 0) return void checkup.passed.push('no duplicate indexes')
      checkup.findings.push({ severity: 'warning', title: `${rows.length} set(s) of identical indexes`, detail: list(rows, (row) => `${String(row.table)}: ${String(row.indexes)} (${String(row.size)})`), fix: 'drop all but one of each set (keep the one backing a constraint): DROP INDEX CONCURRENTLY …' })
    },
  },
  {
    name: 'foreign keys without an index',
    sql: `SELECT c.conrelid::regclass::text AS "table", c.conname AS "constraint", string_agg(quote_ident(a.attname), ', ' ORDER BY x.n) AS columns
      FROM pg_constraint c
      CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS x(attnum, n)
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = x.attnum
      WHERE c.contype = 'f' AND NOT EXISTS (
        SELECT 1 FROM pg_index i WHERE i.indrelid = c.conrelid
          AND (i.indkey::int2[])[0:cardinality(c.conkey) - 1] @> c.conkey AND (i.indkey::int2[])[0:cardinality(c.conkey) - 1] <@ c.conkey)
      GROUP BY c.conrelid, c.conname ORDER BY 1, 2 LIMIT 50`,
    judge(rows, checkup) {
      if (rows.length === 0) return void checkup.passed.push('every foreign key has an index')
      checkup.findings.push({
        severity: 'warning',
        title: `${rows.length} foreign key(s) have no index on their columns`,
        detail: `${list(rows, (row) => `${String(row.table)}(${String(row.columns)})`)} — a delete or key update on the referenced table scans these tables, and joins on them cannot use an index`,
        fix: rows.slice(0, 5).map((row) => `CREATE INDEX CONCURRENTLY ON ${String(row.table)} (${String(row.columns)})`).join('; '),
      })
    },
  },
  {
    name: 'tables without a primary key',
    sql: `SELECT n.nspname || '.' || c.relname AS "table" FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname !~ '^pg_toast'
        AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = c.oid AND k.contype = 'p') ORDER BY 1 LIMIT 50`,
    judge(rows, checkup) {
      if (rows.length === 0) return void checkup.passed.push('every table has a primary key')
      checkup.findings.push({ severity: 'warning', title: `${rows.length} table(s) have no primary key: ${list(rows, (row) => String(row.table))}`, detail: 'duplicate rows cannot be told apart, ORMs and logical replication need one', fix: 'ALTER TABLE … ADD PRIMARY KEY (…), or add an identity column' })
    },
  },
  {
    name: 'dead rows (bloat)',
    sql: `SELECT schemaname || '.' || relname AS "table", n_live_tup AS live, n_dead_tup AS dead,
      coalesce(greatest(last_vacuum, last_autovacuum)::text, 'never') AS last_vacuum
      FROM pg_stat_user_tables WHERE n_dead_tup > 1000 AND n_dead_tup > 0.2 * greatest(n_live_tup, 1) ORDER BY n_dead_tup DESC LIMIT 20`,
    judge(rows, checkup) {
      if (rows.length === 0) return void checkup.passed.push('dead rows under control')
      checkup.findings.push({
        severity: 'warning',
        title: `${rows.length} table(s) carry many dead rows`,
        detail: list(rows, (row) => `${String(row.table)}: ${String(row.dead)} dead vs ${String(row.live)} live, last vacuum ${String(row.last_vacuum)}`),
        fix: `maintain operation=vacuum_analyze table=${String(rows[0]?.table)} (and check nothing holds a long transaction open)`,
      })
    },
  },
  {
    name: 'planner statistics',
    sql: `SELECT schemaname || '.' || relname AS "table", n_live_tup AS rows, n_mod_since_analyze AS changed,
      (last_analyze IS NULL AND last_autoanalyze IS NULL) AS never
      FROM pg_stat_user_tables WHERE n_live_tup > 1000 AND ((last_analyze IS NULL AND last_autoanalyze IS NULL) OR n_mod_since_analyze > 0.5 * n_live_tup)
      ORDER BY n_live_tup DESC LIMIT 20`,
    judge(rows, checkup) {
      if (rows.length === 0) return void checkup.passed.push('planner statistics are fresh')
      checkup.findings.push({ severity: 'note', title: `${rows.length} table(s) have missing or stale planner statistics`, detail: list(rows, (row) => `${String(row.table)} (${row.never === true ? 'never analyzed' : `${String(row.changed)} rows changed since`})`), fix: 'maintain operation=analyze (the whole database, or one table)' })
    },
  },
  {
    name: 'unused indexes',
    sql: `SELECT s.schemaname || '.' || s.relname AS "table", s.indexrelname AS index, pg_relation_size(s.indexrelid)::bigint AS bytes
      FROM pg_stat_user_indexes s JOIN pg_index i ON i.indexrelid = s.indexrelid
      WHERE s.idx_scan = 0 AND NOT i.indisunique AND NOT i.indisprimary AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = s.indexrelid)
        AND pg_relation_size(s.indexrelid) > 1048576
      ORDER BY pg_relation_size(s.indexrelid) DESC LIMIT 20`,
    judge(rows, checkup) {
      if (rows.length === 0) return void checkup.passed.push('no large unused indexes')
      checkup.findings.push({ severity: 'note', title: `${rows.length} index(es) over 1 MB have never been scanned since statistics were last reset`, detail: list(rows, (row) => `${String(row.index)} on ${String(row.table)} (${formatBytes(numberOf(row.bytes))})`), fix: 'if the stats cover a representative period (and no replica uses them), DROP INDEX CONCURRENTLY …' })
    },
  },
  {
    name: 'replication slots',
    sql: `SELECT slot_name, pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)::bigint AS retained FROM pg_replication_slots WHERE NOT active`,
    judge(rows, checkup) {
      if (rows.length === 0) return void checkup.passed.push('no inactive replication slots')
      checkup.findings.push({ severity: 'warning', title: `${rows.length} inactive replication slot(s) are holding WAL`, detail: list(rows, (row) => `${String(row.slot_name)} (${formatBytes(numberOf(row.retained))})`), fix: 'reconnect the consumer, or SELECT pg_drop_replication_slot(\'…\') — retained WAL grows until the disk fills' })
    },
  },
  {
    name: 'extension updates',
    sql: 'SELECT name, installed_version, default_version FROM pg_available_extensions WHERE installed_version IS NOT NULL AND installed_version <> default_version',
    judge(rows, checkup) {
      if (rows.length === 0) return void checkup.passed.push('extensions up to date')
      checkup.findings.push({ severity: 'note', title: `${rows.length} extension(s) have a newer version installed on the server`, detail: list(rows, (row) => `${String(row.name)} ${String(row.installed_version)} → ${String(row.default_version)}`), fix: rows.slice(0, 3).map((row) => `ALTER EXTENSION ${String(row.name)} UPDATE`).join('; ') })
    },
  },
]

const SQLITE_CHECKS: Check[] = [
  {
    name: 'integrity',
    sql: 'PRAGMA quick_check',
    judge(rows, checkup) {
      const messages = rows.map((row) => String(Object.values(row)[0]))
      if (messages.length === 1 && messages[0] === 'ok') return void checkup.passed.push('integrity ok')
      checkup.findings.push({ severity: 'critical', title: 'the database file fails its integrity check', detail: messages.slice(0, 5).join('; '), fix: 'restore from a backup, or recover with the sqlite3 CLI (.recover) into a new file' })
    },
  },
  {
    name: 'foreign key violations',
    sql: 'SELECT "table", rowid, parent FROM pragma_foreign_key_check LIMIT 200',
    judge(rows, checkup) {
      if (rows.length === 0) return void checkup.passed.push('no foreign key violations')
      checkup.findings.push({ severity: 'warning', title: `${rows.length}${rows.length === 200 ? '+' : ''} row(s) point at parent rows that do not exist`, detail: list(rows, (row) => `${String(row.table)} rowid ${String(row.rowid)} → ${String(row.parent)}`), fix: 'fix or delete the orphans, and make sure the application sets PRAGMA foreign_keys = ON (SQLite does not enforce them otherwise)' })
    },
  },
  {
    name: 'foreign keys without an index',
    sql: `SELECT m.name AS "table", f."from" AS "column", f."table" AS "references" FROM sqlite_master m, pragma_foreign_key_list(m.name) f
      WHERE m.type = 'table' AND f.seq = 0 AND NOT EXISTS (SELECT 1 FROM pragma_index_list(m.name) il, pragma_index_info(il.name) ii WHERE ii.seqno = 0 AND ii.name = f."from")`,
    judge(rows, checkup) {
      if (rows.length === 0) return void checkup.passed.push('every foreign key has an index')
      checkup.findings.push({ severity: 'warning', title: `${rows.length} foreign key(s) have no index`, detail: list(rows, (row) => `${String(row.table)}(${String(row.column)}) → ${String(row.references)}`), fix: rows.slice(0, 5).map((row) => `CREATE INDEX ${quoteIdent(`${String(row.table)}_${String(row.column)}_idx`, 'sqlite')} ON ${quoteIdent(String(row.table), 'sqlite')} (${quoteIdent(String(row.column), 'sqlite')})`).join('; ') })
    },
  },
  {
    name: 'tables without a primary key',
    sql: `SELECT m.name AS "table" FROM sqlite_master m WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' AND NOT EXISTS (SELECT 1 FROM pragma_table_info(m.name) WHERE pk > 0)`,
    judge(rows, checkup) {
      if (rows.length === 0) return void checkup.passed.push('every table declares a primary key')
      checkup.findings.push({ severity: 'note', title: `${rows.length} table(s) declare no primary key: ${list(rows, (row) => String(row.table))}`, detail: 'rows still have a rowid, but nothing the application can rely on as an identity' })
    },
  },
  {
    name: 'free space',
    sql: 'SELECT page_count, freelist_count, page_size FROM pragma_page_count, pragma_freelist_count, pragma_page_size',
    judge(rows, checkup) {
      const pages = numberOf(rows[0]?.page_count)
      const free = numberOf(rows[0]?.freelist_count)
      const size = numberOf(rows[0]?.page_size)
      if (pages > 256 && free / pages > 0.2) checkup.findings.push({ severity: 'note', title: `${pct(free / pages)} of the file is free pages (${formatBytes(free * size)})`, fix: 'maintain operation=vacuum rewrites the file without them' })
      else checkup.passed.push(`file ${formatBytes(pages * size)}, ${pct(pages > 0 ? free / pages : 0)} free`)
    },
  },
  {
    name: 'journal mode',
    sql: 'PRAGMA journal_mode',
    judge(rows, checkup) {
      const mode = String(rows[0]?.journal_mode ?? '').toLowerCase()
      if (mode === 'wal') return void checkup.passed.push('WAL journal')
      checkup.findings.push({ severity: 'note', title: `journal mode is ${mode || 'unknown'}`, detail: 'in WAL mode readers keep reading while a write is in progress, and writes are faster', fix: 'settings name=journal_mode value=WAL' })
    },
  },
  {
    name: 'planner statistics',
    sql: "SELECT (SELECT count(*) FROM sqlite_master WHERE name = 'sqlite_stat1') AS analyzed, (SELECT count(*) FROM sqlite_master WHERE type = 'index') AS indexes",
    judge(rows, checkup) {
      if (numberOf(rows[0]?.indexes) === 0) return void checkup.passed.push('planner statistics (no indexes yet, so none are needed)')
      if (numberOf(rows[0]?.analyzed) > 0) return void checkup.passed.push('planner statistics present')
      checkup.findings.push({ severity: 'note', title: 'the query planner has no statistics (ANALYZE has never run)', fix: 'maintain operation=optimize (PRAGMA optimize) or operation=analyze' })
    },
  },
]

const MYSQL_CHECKS: Check[] = [
  {
    name: 'connections',
    sql: "SELECT (SELECT VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME = 'Threads_connected') AS used, @@max_connections AS max",
    judge(rows, checkup) {
      const used = numberOf(rows[0]?.used)
      const max = numberOf(rows[0]?.max)
      if (used / max >= 0.75) checkup.findings.push({ severity: used / max >= 0.9 ? 'critical' : 'warning', title: `connections at ${used} of ${max}`, fix: 'lower application pool sizes or raise max_connections' })
      else checkup.passed.push(`connections ${used}/${max}`)
    },
  },
  {
    name: 'tables without a primary key',
    sql: "SELECT t.table_name AS `table` FROM information_schema.tables t WHERE t.table_schema = DATABASE() AND t.table_type = 'BASE TABLE' AND NOT EXISTS (SELECT 1 FROM information_schema.table_constraints c WHERE c.table_schema = t.table_schema AND c.table_name = t.table_name AND c.constraint_type = 'PRIMARY KEY')",
    judge(rows, checkup) {
      if (rows.length === 0) return void checkup.passed.push('every table has a primary key')
      checkup.findings.push({ severity: 'warning', title: `${rows.length} table(s) have no primary key: ${list(rows, (row) => String(row.table))}`, detail: 'InnoDB clusters rows on the primary key; without one it invents a hidden key and replication suffers' })
    },
  },
  {
    name: 'storage engines',
    sql: "SELECT table_name AS `table`, engine FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' AND engine <> 'InnoDB'",
    judge(rows, checkup) {
      if (rows.length === 0) return void checkup.passed.push('all tables InnoDB')
      checkup.findings.push({ severity: 'warning', title: `${rows.length} table(s) are not InnoDB: ${list(rows, (row) => `${String(row.table)} (${String(row.engine)})`)}`, detail: 'MyISAM and friends have no transactions and no crash safety', fix: 'ALTER TABLE … ENGINE = InnoDB' })
    },
  },
  {
    name: 'long-running queries',
    sql: "SELECT id, user, time FROM information_schema.processlist WHERE command = 'Query' AND time > 300 AND id <> CONNECTION_ID()",
    judge(rows, checkup) {
      if (rows.length === 0) return void checkup.passed.push('no queries running over 5 minutes')
      checkup.findings.push({ severity: 'warning', title: `${rows.length} quer${rows.length === 1 ? 'y has' : 'ies have'} been running over 5 minutes`, detail: list(rows, (row) => `id ${String(row.id)} (${String(row.time)}s)`), fix: 'action activity; terminate mode=cancel' })
    },
  },
  {
    name: 'redundant indexes',
    sql: 'SELECT table_name, redundant_index_name, dominant_index_name FROM sys.schema_redundant_indexes WHERE table_schema = DATABASE()',
    judge(rows, checkup) {
      if (rows.length === 0) return void checkup.passed.push('no redundant indexes')
      checkup.findings.push({ severity: 'warning', title: `${rows.length} redundant index(es)`, detail: list(rows, (row) => `${String(row.table_name)}.${String(row.redundant_index_name)} (covered by ${String(row.dominant_index_name)})`), fix: 'ALTER TABLE … DROP INDEX …' })
    },
  },
  {
    name: 'unused indexes',
    sql: 'SELECT object_name AS `table`, index_name AS `index` FROM sys.schema_unused_indexes WHERE object_schema = DATABASE()',
    judge(rows, checkup) {
      if (rows.length === 0) return void checkup.passed.push('no unused indexes')
      checkup.findings.push({ severity: 'note', title: `${rows.length} index(es) unused since the server started`, detail: list(rows, (row) => `${String(row.table)}.${String(row.index)}`) })
    },
  },
]

async function runChecks(session: SqlSession, checks: readonly Check[]): Promise<Checkup> {
  const checkup: Checkup = { findings: [], passed: [], skipped: [] }
  for (const check of checks) {
    const result = await queryRows(session, check.sql)
    if (result.error) checkup.skipped.push(`${check.name} (${result.error.split('\n')[0]!.slice(0, 120)})`)
    else check.judge(result.rows, checkup)
  }
  return checkup
}

const ORDER: Record<Severity, number> = { critical: 0, warning: 1, note: 2 }
const LABEL: Record<Severity, string> = { critical: 'CRITICAL', warning: 'WARNING ', note: 'NOTE    ' }

export function renderCheckup(checkup: Checkup, total: number): string {
  const count = (severity: Severity) => checkup.findings.filter((finding) => finding.severity === severity).length
  const lines = [`Health check — ${count('critical')} critical, ${count('warning')} warning(s), ${count('note')} note(s); ${total - checkup.skipped.length} of ${total} checks ran.`]
  const sorted = [...checkup.findings].sort((a, b) => ORDER[a.severity] - ORDER[b.severity])
  for (const finding of sorted) {
    lines.push('', `${LABEL[finding.severity]}  ${finding.title}`)
    if (finding.detail) lines.push(`          ${finding.detail}`)
    if (finding.fix) lines.push(`          fix: ${finding.fix}`)
  }
  if (sorted.length === 0) lines.push('', 'No problems found.')
  if (checkup.passed.length > 0) lines.push('', `Passed: ${checkup.passed.join('; ')}.`)
  if (checkup.skipped.length > 0) lines.push('', `Skipped: ${checkup.skipped.join('; ')}.`)
  return lines.join('\n')
}

export async function health(ctx: DbContext): Promise<string> {
  const checks = ctx.engine === 'sqlite' ? SQLITE_CHECKS : ctx.engine === 'mysql' ? MYSQL_CHECKS : PG_CHECKS
  try {
    return await withSqlSession(ctx.target.url, { readOnly: true, statementTimeoutMs: 30_000 }, async (session) => {
      const problem = await connectionProblem(session, ctx.target)
      if (problem) return problem
      const checkup = await runChecks(session, checks)
      if (ctx.engine === 'postgres' && !ctx.target.devdb) {
        const superuser = await queryRows(session, "SELECT current_setting('is_superuser') AS on")
        if (superuser.rows[0]?.on === 'on') checkup.findings.push({ severity: 'note', title: 'this connection is a superuser', detail: 'if the application uses the same credentials, any SQL injection in it owns the whole server', fix: 'give the application its own least-privilege role (roles; CREATE ROLE … LOGIN PASSWORD ${env:NAME}; GRANT only what it needs)' })
      }
      return `${targetLine(ctx.target)}\n${renderCheckup(checkup, checks.length)}`
    })
  } catch (error) {
    return `${targetLine(ctx.target)}\ncould not open the database: ${error instanceof Error ? error.message : String(error)}`
  }
}
