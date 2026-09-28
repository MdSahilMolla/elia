import type { Tool } from './types.ts'
import { existsSync } from 'node:fs'
import { currentAgent } from '../autonomy/context.ts'
import { explain, maintain, MAINTENANCE_OPERATIONS, terminate } from '../devdb/admin.ts'
import { backup, backupBeforeDestroying, createDatabase, dropDatabase, listBackups, restore } from '../devdb/backup.ts'
import { quoteLiteral, targetLine, type DbContext } from '../devdb/common.ts'
import { detectDatabase } from '../devdb/detect.ts'
import { health } from '../devdb/health.ts'
import { activity, describe, overview, roles, settings } from '../devdb/inspect.ts'
import { canConnect, localDbStatus, startLocalPostgres, stopLocalPostgres } from '../devdb/local.ts'
import { migrate, MIGRATE_OPERATIONS } from '../devdb/migrations.ts'
import { DATABASE_ACTIONS, resolveDatabaseTarget, type ResolvedTarget } from '../devdb/policy.ts'
import { lookupEnv, resolveSecretPlaceholders, scrubSecrets } from '../devdb/secrets.ts'
import { cannotRunInTransaction, classifySql, formatSqlRun, isTransactionControl, runSql, splitSqlText, stripSqlNoise } from '../devdb/sql.ts'
import { exportRows, importRows } from '../devdb/transfer.ts'
import { describeDatabaseUrl, engineOf, parseDatabaseUrl, sqliteFileOf, type DatabaseEngine } from '../devdb/url.ts'

/**
 * One governed door to the project's databases — a DBA's toolkit.
 *
 * `run_command psql …` is `shell.unknown` to the governor — refused outright in
 * an unattended run — and would put the connection string, password included,
 * into the command line the ledger records. This tool knows which database a
 * call touches and what the call does to it, so the governor can let an
 * autonomous run create, migrate, seed, tune and repair a *local* database on
 * its own while every remote one still needs a person (devdb/policy.ts).
 * Anything that destroys data is backed up first (devdb/backup.ts).
 */

const NO_TARGET = 'No database to connect to: the project declares no DATABASE_URL (or similar) in its env files, and elia has not started a local one. Call database with action "start" to run a project-local postgres, then point the app at the URL it returns.'

function rootOf(): string {
  return currentAgent().cwd ?? process.cwd()
}

async function detect(root: string): Promise<string> {
  const detection = detectDatabase(root)
  const devdb = await localDbStatus(root)
  const lines = ['Database configuration found in this project:']
  if (detection.signals.length === 0) lines.push('  (nothing — no connection string, ORM config, compose database service or migration folder)')
  for (const signal of detection.signals) lines.push(`  - ${signal}`)
  lines.push('', devdb.state
    ? `elia's local postgres: ${devdb.running ? 'running' : 'stopped'} on 127.0.0.1:${devdb.state.port}, database "${devdb.state.database}" (url: ${devdb.state.url})`
    : 'elia\'s local postgres: not created yet (action "start" creates one under .elia/devdb/).')
  const target = resolveDatabaseTarget(root, {})
  lines.push(target ? `Default target: ${describeDatabaseUrl(target.url)} (${target.source})` : 'Default target: none yet.')
  if (target && !target.local) lines.push('That target is remote: every action on it needs the user\'s approval. For development, start a local database and use target "devdb".')
  return lines.join('\n')
}

async function status(target: ResolvedTarget): Promise<string> {
  const parsed = parseDatabaseUrl(target.url)
  if (parsed?.engine === 'postgres' || parsed?.engine === 'mysql') {
    const port = parsed.port ?? (parsed.engine === 'postgres' ? 5432 : 3306)
    if (!parsed.host.startsWith('/') && !(await canConnect(parsed.host || '127.0.0.1', port))) {
      return `${targetLine(target)}\nstatus: NOT reachable — nothing is listening on ${parsed.host || '127.0.0.1'}:${port}.${target.devdb ? ' Start it with action "start".' : ''}`
    }
  }
  if (parsed?.engine === 'sqlite' && !existsSync(sqliteFileOf(target.url))) {
    return `${targetLine(target)}\nstatus: the file does not exist yet — the first write (query, import, migrate) creates it.`
  }
  const probe = parsed?.engine === 'sqlite' ? 'SELECT sqlite_version() AS version' : 'SELECT version() AS version'
  const result = await runSql(target.url, probe, { timeoutMs: 15_000, readOnly: true })
  return `${targetLine(target)}\nstatus: ${result.ok ? 'reachable' : 'unreachable'}\n${result.ok ? formatSqlRun(result) : result.error}`
}

function schemaSql(engine: DatabaseEngine, table: string | undefined): string {
  const literal = table ? quoteLiteral(table, engine) : undefined
  if (engine === 'sqlite') {
    return `SELECT name, sql FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'${literal ? ` AND name = ${literal}` : ''} ORDER BY name`
  }
  const tableFilter = literal ? ` AND c.table_name = ${literal}` : ''
  if (engine === 'mysql') {
    return `SELECT c.table_name, GROUP_CONCAT(CONCAT(c.column_name, ' ', c.column_type, IF(c.is_nullable = 'NO', ' not null', ''), IF(c.column_key = 'PRI', ' pk', '')) ORDER BY c.ordinal_position SEPARATOR ', ') AS columns FROM information_schema.columns c WHERE c.table_schema = DATABASE()${tableFilter} GROUP BY c.table_name ORDER BY c.table_name LIMIT 300`
  }
  return `SELECT c.table_schema AS schema, c.table_name AS table, string_agg(c.column_name || ' ' || c.data_type || CASE WHEN c.is_nullable = 'NO' THEN ' not null' ELSE '' END || CASE WHEN c.column_default IS NOT NULL THEN ' default ' || c.column_default ELSE '' END, ', ' ORDER BY c.ordinal_position) AS columns FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema')${tableFilter} GROUP BY c.table_schema, c.table_name ORDER BY 1, 2 LIMIT 300`
}

/** Why a batch cannot be dry-run, or nothing when it can. */
function dryRunProblem(sql: string, engine: DatabaseEngine): string | undefined {
  const statements = splitSqlText(sql, engine)
  if (statements.some((statement) => isTransactionControl(statement, engine))) return 'the SQL manages its own transaction (BEGIN / COMMIT / ROLLBACK / SAVEPOINT), so it cannot be wrapped in one that is rolled back'
  if (statements.some((statement) => cannotRunInTransaction(statement, engine))) {
    return engine === 'mysql'
      ? 'MySQL commits DDL (CREATE / ALTER / DROP …) the moment it runs, so it cannot be rolled back — dry_run only works for data changes there'
      : 'it holds a statement that cannot run inside a transaction (VACUUM, CREATE/DROP DATABASE, … CONCURRENTLY, ALTER SYSTEM, a SQLite pragma), so it cannot be rolled back'
  }
  if (classifySql(sql, engine) === 'host') return 'it reaches outside the database (files, programs, network), which no rollback undoes'
  return undefined
}

function timeoutOf(input: Record<string, unknown>): number {
  const seconds = typeof input.timeout_seconds === 'number' ? input.timeout_seconds : Number.NaN
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 3_600) * 1000 : 60_000
}

async function query(ctx: DbContext, input: Record<string, unknown>): Promise<string> {
  const sql = typeof input.sql === 'string' ? input.sql : ''
  const sqlClass = classifySql(sql, ctx.engine)
  const dryRun = input.dry_run === true
  const dropsDatabase = splitSqlText(sql, ctx.engine).some((statement) => /^DROP\s+DATABASE\b/i.test(stripSqlNoise(statement, { engine: ctx.engine }).trim()))
  if (dropsDatabase) {
    return 'Use action drop_database for that: it backs up the database being dropped (which is not necessarily the one this call is connected to) and connects to the server\'s maintenance database to drop it.'
  }
  if (dryRun) {
    const problem = dryRunProblem(sql, ctx.engine)
    if (problem) return `dry_run refused: ${problem}.`
  }
  const filled = resolveSecretPlaceholders(sql, ctx.engine, (name) => lookupEnv(ctx.root, name))
  if (!filled.ok) return `Refused: ${filled.error}`
  const notes: string[] = []
  if (sqlClass === 'destructive' && !dryRun) {
    const guard = await backupBeforeDestroying(ctx, input, 'this destructive statement')
    if (!guard.proceed) return guard.refusal ?? 'refused'
    notes.push(...guard.notes)
  }
  // DDL waits for an exclusive lock and makes every other query wait behind
  // it; on a database other people use, give up after a few seconds instead.
  const lockTimeoutMs = ctx.engine === 'postgres' && !ctx.target.devdb && (sqlClass === 'schema' || sqlClass === 'destructive') ? 10_000 : undefined
  const result = await runSql(ctx.target.url, filled.sql, { dryRun, timeoutMs: timeoutOf(input), lockTimeoutMs })
  const lockHint = !result.ok && /lock timeout/i.test(result.error ?? '')
    ? 'The table is in use: the change needs a lock that did not come free within 10s, and waiting longer would stall every other query on it. Retry when it is quiet (activity shows who holds it).'
    : undefined
  const text = [targetLine(ctx.target), `classified: ${sqlClass}${dryRun ? ' (dry run)' : ''}`, ...notes, formatSqlRun(result), ...(lockHint ? [lockHint] : [])].join('\n')
  return scrubSecrets(text, filled.secrets)
}

const DESCRIPTION = [
  'The project\'s databases, with a DBA\'s full toolkit: PostgreSQL and SQLite fully, MySQL/MariaDB for the portable parts. Prefer this over psql/sqlite3 in run_command.',
  'Setup: detect (what the project configures), start/stop (a project-local PostgreSQL elia owns, 127.0.0.1, data in .elia/devdb; returns its URL), status.',
  'Look: overview (server, databases, sizes, largest tables, extensions, sessions), schema (tables and columns), describe `table` (columns, keys, indexes and their use, foreign keys both ways, triggers, row-level security, grants, size, dead rows), roles (users/roles; `role` for what one can reach), settings (configuration; `name` filters; with `value` it changes the setting, "default" resets), activity (sessions, lock waits, slowest statements).',
  'Diagnose: health (checkup — connection pressure, cache hit ratio, bloat, duplicate/unused/invalid indexes, foreign keys without an index, tables without a primary key, stale statistics, sequences running out, transaction-ID wraparound — each finding with its fix), explain `sql` (the plan with hints; analyze: true runs it for real timings, inside a rolled-back transaction when it writes).',
  'Change: query `sql` (any SQL; several statements run as one transaction where the database allows; dry_run: true runs it and rolls back to show what it would do), migrate (operation apply | status | create with `name` | rollback, through the project\'s own migration tool), maintain (operation vacuum | analyze | vacuum_analyze | vacuum_full | reindex | optimize | check; one `table` or the whole database), terminate `pid` (mode cancel | terminate), create_database `database` (from: copy another), drop_database `database` (force: end its sessions).',
  'Data: backup (pg_dump custom format by default, format "sql" for plain SQL, a snapshot for SQLite; into .elia/devdb/backups), restore `file` (over the database, or into: "new" with `database`; without `file` it lists the backups), export `sql` to `file` (csv/tsv/json/jsonl), import `file` into `table` (one transaction; create: true makes the table; truncate: true empties it first).',
  'Targets: default is the project\'s local database, else elia\'s devdb; target "devdb", or target "<ENV_VAR>" for any variable holding a connection string — use that instead of pasting a URL with a password. A password in SQL is written ${env:NAME} (CREATE ROLE app LOGIN PASSWORD ${env:APP_DB_PASSWORD}), never as its value.',
  'Safety: local databases are yours to change, and anything that destroys data is backed up first (no_backup: true skips that and needs the user\'s approval). Every action on a remote database needs the user\'s approval, and so does SQL that reaches outside the database (server files, programs, native code, network).',
].join('\n')

export const databaseTool: Tool = {
  name: 'database',
  description: DESCRIPTION,
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [...DATABASE_ACTIONS] },
      sql: { type: 'string', description: 'query / explain / export: the SQL.' },
      target: { type: 'string', description: 'Which database: "devdb" (elia\'s local postgres), the name of an env variable holding a connection string (DATABASE_URL, STAGING_DATABASE_URL, …), or omit for the project default.' },
      url: { type: 'string', description: 'An explicit connection string (overrides target). Prefer target for anything with a password.' },
      table: { type: 'string', description: 'schema: limit to one table. describe / maintain / import: the table (schema-qualified if needed).' },
      name: { type: 'string', description: 'migrate: the new migration\'s name. settings: the setting to show or change.' },
      value: { type: 'string', description: 'settings: the new value ("default" resets it).' },
      operation: { type: 'string', enum: [...new Set<string>([...MAINTENANCE_OPERATIONS, ...MIGRATE_OPERATIONS])], description: `maintain: ${MAINTENANCE_OPERATIONS.join(' | ')}. migrate: ${MIGRATE_OPERATIONS.join(' | ')} (default apply, or create when name is given).` },
      database: { type: 'string', description: 'start: the database to create in elia\'s postgres. create_database / drop_database: its name (SQLite: a file path). restore into "new": the new database.' },
      from: { type: 'string', description: 'create_database: copy this database (Postgres TEMPLATE; SQLite snapshot).' },
      role: { type: 'string', description: 'roles: show what this role can reach.' },
      pid: { type: 'number', description: 'terminate: the session id from activity.' },
      mode: { type: 'string', enum: ['cancel', 'terminate'], description: 'terminate: cancel the running statement (default) or end the whole session.' },
      analyze: { type: 'boolean', description: 'explain: run the statement to get real timings.' },
      dry_run: { type: 'boolean', description: 'query: run inside a transaction that is rolled back.' },
      no_backup: { type: 'boolean', description: 'Destroy data without the automatic backup first. Needs the user\'s explicit approval.' },
      force: { type: 'boolean', description: 'drop_database: end the sessions connected to it.' },
      file: { type: 'string', description: 'backup: where to write (default .elia/devdb/backups/…). restore: the backup (a name from the list, or a path). export / import: the data file.' },
      format: { type: 'string', enum: ['custom', 'sql', 'csv', 'tsv', 'json', 'jsonl'], description: 'backup: custom (default) or sql. export / import: the file format (default from the extension).' },
      into: { type: 'string', enum: ['replace', 'new'], description: 'restore: over the target database (default) or into a new one named by `database`.' },
      tables: { type: 'array', items: { type: 'string' }, description: 'backup: only these tables.' },
      schema_only: { type: 'boolean', description: 'backup: structure without rows.' },
      data_only: { type: 'boolean', description: 'backup: rows without structure.' },
      create: { type: 'boolean', description: 'import: create the table (types inferred from the file) when it does not exist.' },
      truncate: { type: 'boolean', description: 'import: empty the table first (backed up before).' },
      overwrite: { type: 'boolean', description: 'export: replace an existing file.' },
      timeout_seconds: { type: 'number', description: 'query: how long the SQL may run (default 60, max 3600).' },
    },
    required: ['action'],
  },
  async execute(input) {
    const root = rootOf()
    const action = typeof input.action === 'string' ? input.action : ''
    if (action === 'detect') return detect(root)
    if (action === 'start') {
      const outcome = await startLocalPostgres(root, { database: typeof input.database === 'string' && input.database.trim() ? input.database.trim() : undefined })
      if (!outcome.ok || !outcome.state) return `database start failed: ${outcome.message}`
      return `${outcome.message}\nurl: ${outcome.state.url}\nTo make the app and its tests use it, set DATABASE_URL=${outcome.state.url} in the project's local env file (.env.local or .env), then run action "migrate" to create the schema.`
    }
    if (action === 'stop') return (await stopLocalPostgres(root)).message
    if (!(DATABASE_ACTIONS as readonly string[]).includes(action)) return `Unknown database action "${action}". Use one of: ${DATABASE_ACTIONS.join(', ')}.`
    if (action === 'restore' && !(typeof input.file === 'string' && input.file.trim())) return listBackups(root)

    const target = resolveDatabaseTarget(root, input)
    if (!target) {
      return typeof input.target === 'string' && input.target !== 'devdb' && input.target !== 'project'
        ? `No env variable named ${input.target} holds a connection string (checked the process environment and the project's non-example env files).`
        : NO_TARGET
    }
    if (target.devdb && !(await localDbStatus(root)).running) {
      const restarted = await startLocalPostgres(root)
      if (!restarted.ok) return `elia's local postgres is stopped and could not be restarted: ${restarted.message}`
    }
    const engine = engineOf(target.url)
    if (engine === 'unknown') return `${targetLine(target)}\nelia cannot work with this kind of database (only PostgreSQL, MySQL/MariaDB and SQLite).`
    const ctx: DbContext = { root, target, engine }
    switch (action) {
      case 'status':
        return status(target)
      case 'schema': {
        const result = await runSql(target.url, schemaSql(engine, typeof input.table === 'string' ? input.table.trim() : undefined), { readOnly: true })
        return `${targetLine(target)}\n${formatSqlRun(result)}`
      }
      case 'query':
        if (typeof input.sql !== 'string' || !input.sql.trim()) return 'query needs `sql`.'
        return query(ctx, input)
      case 'overview':
        return overview(ctx)
      case 'describe':
        return describe(ctx, input)
      case 'roles':
        return roles(ctx, input)
      case 'settings':
        return settings(ctx, input)
      case 'activity':
        return activity(ctx)
      case 'health':
        return health(ctx)
      case 'explain':
        return explain(ctx, input)
      case 'maintain':
        return maintain(ctx, input)
      case 'terminate':
        return terminate(ctx, input)
      case 'migrate':
        return migrate(ctx, input)
      case 'create_database':
        return createDatabase(ctx, input)
      case 'drop_database':
        return dropDatabase(ctx, input)
      case 'backup':
        return backup(ctx, input)
      case 'restore':
        return restore(ctx, input)
      case 'export':
        return exportRows(ctx, input)
      case 'import':
        return importRows(ctx, input)
      default:
        return `Unknown database action "${action}". Use one of: ${DATABASE_ACTIONS.join(', ')}.`
    }
  },
}
