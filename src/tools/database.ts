import type { Tool } from './types.ts'
import { currentAgent } from '../autonomy/context.ts'
import { formatShellResult, runShell } from '../shell.ts'
import { detectDatabase } from '../devdb/detect.ts'
import { backupLocalDatabase, canConnect, localDbStatus, startLocalPostgres, stopLocalPostgres } from '../devdb/local.ts'
import { resolveDatabaseTarget, sqlClassOf, type ResolvedTarget } from '../devdb/policy.ts'
import { formatSqlRun, runSql } from '../devdb/sql.ts'
import { describeDatabaseUrl, parseDatabaseUrl, redactDatabaseUrl } from '../devdb/url.ts'

/**
 * One governed door to the project's database, for development work.
 *
 * `run_command psql …` is `shell.unknown` to the governor — refused outright in
 * an unattended run — and would put the connection string, password included,
 * into the command line the ledger records. This tool knows which database a
 * call touches, so the governor can let an autonomous run create, migrate, seed
 * and query a *local* database on its own while every remote one still needs a
 * person (devdb/policy.ts). Destructive SQL on a local database is dumped to
 * `.elia/devdb/backups/` before it runs.
 */

const NO_TARGET = 'No database to connect to: the project declares no DATABASE_URL (or similar) in its env files, and elia has not started a local one. Call database with action "start" to run a project-local postgres, then point the app at the URL it returns.'

function rootOf(): string {
  return currentAgent().cwd ?? process.cwd()
}

function targetLine(target: ResolvedTarget): string {
  return `target: ${describeDatabaseUrl(target.url)} — from ${target.source}`
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
  lines.push(target ? `Default target for query/schema/migrate: ${describeDatabaseUrl(target.url)} (${target.source})` : 'Default target: none yet.')
  if (target && !target.local) lines.push('That target is remote: elia will not read or write it without an explicit approval. For development, start a local database and use target "devdb".')
  return lines.join('\n')
}

async function status(root: string, target: ResolvedTarget): Promise<string> {
  const parsed = parseDatabaseUrl(target.url)
  if (parsed?.engine === 'postgres' || parsed?.engine === 'mysql') {
    const port = parsed.port ?? (parsed.engine === 'postgres' ? 5432 : 3306)
    if (!parsed.host.startsWith('/') && !(await canConnect(parsed.host || '127.0.0.1', port))) {
      return `${targetLine(target)}\nstatus: NOT reachable — nothing is listening on ${parsed.host || '127.0.0.1'}:${port}.${target.devdb ? ' Start it with action "start".' : ''}`
    }
  }
  const probe = parsed?.engine === 'sqlite' ? 'SELECT sqlite_version() AS version' : 'SELECT version() AS version'
  const result = await runSql(target.url, probe, { timeoutMs: 15_000 })
  return `${targetLine(target)}\nstatus: ${result.ok ? 'reachable' : 'unreachable'}\n${result.ok ? formatSqlRun(result) : result.error}`
}

function schemaSql(engine: string | undefined, table: string | undefined): string {
  const safeTable = table?.replace(/'/g, "''")
  if (engine === 'sqlite') {
    return `SELECT name, sql FROM sqlite_master WHERE type IN ('table','view')${safeTable ? ` AND name = '${safeTable}'` : ''} ORDER BY name`
  }
  const tableFilter = safeTable ? ` AND c.table_name = '${safeTable}'` : ''
  if (engine === 'mysql') {
    return `SELECT c.table_name, GROUP_CONCAT(CONCAT(c.column_name, ' ', c.column_type, IF(c.is_nullable = 'NO', ' not null', ''), IF(c.column_key = 'PRI', ' pk', '')) ORDER BY c.ordinal_position SEPARATOR ', ') AS columns FROM information_schema.columns c WHERE c.table_schema = DATABASE()${tableFilter} GROUP BY c.table_name ORDER BY c.table_name LIMIT 300`
  }
  return `SELECT c.table_schema AS schema, c.table_name AS table, string_agg(c.column_name || ' ' || c.data_type || CASE WHEN c.is_nullable = 'NO' THEN ' not null' ELSE '' END || CASE WHEN c.column_default IS NOT NULL THEN ' default ' || c.column_default ELSE '' END, ', ' ORDER BY c.ordinal_position) AS columns FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema')${tableFilter} GROUP BY c.table_schema, c.table_name ORDER BY 1, 2 LIMIT 300`
}

async function query(root: string, target: ResolvedTarget, sql: string): Promise<string> {
  const sqlClass = sqlClassOf({ sql })
  const notes: string[] = []
  if (sqlClass === 'destructive') {
    const engine = parseDatabaseUrl(target.url)?.engine
    if (engine === 'postgres') {
      const size = await runSql(target.url, 'SELECT pg_database_size(current_database()) AS bytes', { timeoutMs: 15_000 })
      const bytes = Number(size.statements[0]?.rows[0]?.bytes ?? Number.NaN)
      const backup = await backupLocalDatabase(root, target.url, Number.isFinite(bytes) ? bytes : undefined)
      if (backup.ok) notes.push(`backup taken before this destructive statement: ${backup.path} (restore with psql -f)`)
      else if (!target.devdb) {
        return `Refused: this SQL is destructive and the database (${target.source}) is not one elia created, so it must be backed up first — but ${backup.message}. Scope the statement (add a WHERE), or run it against elia's own database (target "devdb").`
      } else notes.push(`no backup taken (${backup.message}); running anyway because this is elia's own scratch database`)
    } else if (!target.devdb && engine !== 'sqlite') {
      return `Refused: destructive SQL against a ${engine ?? 'unknown'} database elia did not create, and elia can only back up postgres automatically. Scope the statement instead.`
    }
  }
  const result = await runSql(target.url, sql)
  return [targetLine(target), `classified: ${sqlClass}`, ...notes, formatSqlRun(result)].join('\n')
}

async function migrate(root: string, target: ResolvedTarget, name: string | undefined): Promise<string> {
  const detection = detectDatabase(root)
  const tool = detection.migrationTools[0]
  if (!tool) {
    return `${targetLine(target)}\nNo migration tool detected (prisma, drizzle, knex, sequelize, typeorm, alembic, django, rails). Apply schema changes with action "query" instead, and keep the SQL in a migrations/ file so it is reproducible.`
  }
  const safeName = name?.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60)
  if (name && !safeName) return 'Refused: the migration name must contain letters or digits.'
  if (safeName && !tool.create) return `${tool.name} migrations are applied here but not created; write the migration file yourself, then call migrate without a name.`
  const command = safeName && tool.create ? tool.create.replace('{name}', safeName) : tool.command
  const agent = currentAgent()
  const env = { ...(process.env as Record<string, string>), DATABASE_URL: target.url }
  const result = await runShell(command, 300_000, root, agent.signal, env)
  const output = formatShellResult(result).split(target.url).join(redactDatabaseUrl(target.url))
  return `${targetLine(target)}\nmigration tool: ${tool.name} (${tool.evidence})\n$ ${command}   [DATABASE_URL set to the target]\n${output}`
}

export const databaseTool: Tool = {
  name: 'database',
  description:
    'Work with the project\'s database in development. detect: what the project configures (env URLs, ORM, compose, migrations). start/stop: a project-local PostgreSQL elia owns (127.0.0.1, data in .elia/devdb) — returns its URL. status, schema: reachability and tables/columns. query: run SQL (several statements allowed). migrate: apply the project\'s migrations, or create one with `name`. Local databases are fully usable; destructive SQL is backed up first. A remote database needs explicit approval. Prefer this over psql in run_command.',
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['detect', 'status', 'start', 'stop', 'query', 'schema', 'migrate'] },
      sql: { type: 'string', description: 'query: the SQL to run.' },
      target: { type: 'string', description: 'Which database: "devdb" (elia\'s local postgres), an env variable name such as DATABASE_URL, or omit for the project default.' },
      url: { type: 'string', description: 'An explicit connection string (overrides target).' },
      table: { type: 'string', description: 'schema: limit to one table.' },
      name: { type: 'string', description: 'migrate: create a new migration with this name (prisma, drizzle, knex, alembic, django), then apply.' },
      database: { type: 'string', description: 'start: database name to create (default <project>_dev).' },
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

    const target = resolveDatabaseTarget(root, input)
    if (!target) return typeof input.target === 'string' && input.target !== 'devdb' && input.target !== 'project' ? `No non-example env variable named ${input.target} holds a connection string in this project.` : NO_TARGET
    if (target.devdb && !(await localDbStatus(root)).running) {
      const restarted = await startLocalPostgres(root)
      if (!restarted.ok) return `elia's local postgres is stopped and could not be restarted: ${restarted.message}`
    }
    if (action === 'status') return status(root, target)
    if (action === 'schema') {
      const result = await runSql(target.url, schemaSql(parseDatabaseUrl(target.url)?.engine, typeof input.table === 'string' ? input.table.trim() : undefined))
      return `${targetLine(target)}\n${formatSqlRun(result)}`
    }
    if (action === 'query') {
      if (typeof input.sql !== 'string' || !input.sql.trim()) return 'query needs `sql`.'
      return query(root, target, input.sql)
    }
    if (action === 'migrate') return migrate(root, target, typeof input.name === 'string' ? input.name : undefined)
    return `Unknown database action "${action}". Use one of: detect, status, start, stop, query, schema, migrate.`
  },
}
