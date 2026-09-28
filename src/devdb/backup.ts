/**
 * Backups and restores — and the rule that nothing is destroyed without one.
 *
 * Every action that destroys data (destructive SQL, dropping a database,
 * restoring over one, rolling a migration back, a truncating import) first
 * calls `backupBeforeDestroying`. On a database elia did not create, a failed
 * backup stops the action unless the caller explicitly waived it
 * (`no_backup: true` — which the governor turns into a question for a person).
 * On elia's own scratch database a failed backup is noted and the work goes on.
 *
 * Formats:
 *   postgres  pg_dump custom format (compressed, complete, restored by
 *             pg_restore) by default; plain SQL on request (readable, loads
 *             anywhere with psql)
 *   sqlite    a consistent snapshot of the file (VACUUM INTO), restored by
 *             copying it back
 *   mysql     mysqldump, when the client is installed
 *
 * Passwords never go on a command line (every local user can read those in
 * `ps`): libpq tools get PGPASSWORD, the MySQL clients MYSQL_PWD.
 */

import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { resolveWorkspacePath } from '../autonomy/context.ts'
import { formatBytes, numberOf, quoteIdent, quoteLiteral, targetLine, type DbContext } from './common.ts'
import { devdbDir, findPostgresBinaries, installHint, readLocalDbState } from './local.ts'
import { formatRows, runSql } from './sql.ts'
import { describeDatabaseUrl, libpqConnection, mysqlCliConnection, parseDatabaseUrl, redactDatabaseUrl, sqliteFileOf, withDatabaseName, type DatabaseEngine } from './url.ts'

/** Databases larger than this are not dumped automatically before a destructive change — that call is the operator's. */
export const AUTO_BACKUP_LIMIT_BYTES = 512 * 1024 * 1024

export function backupsDir(root: string): string {
  return join(devdbDir(root), 'backups')
}

function prepareBackupsDir(root: string): string {
  const dir = backupsDir(root)
  mkdirSync(dir, { recursive: true })
  // Dumps hold the project's data: keep every file under .elia/devdb out of git.
  const ignore = join(devdbDir(root), '.gitignore')
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n')
  return dir
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function safeFileName(name: string): string {
  return name.replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'db'
}

export async function runTool(argv: string[], options: { env?: Record<string, string>; timeoutMs: number; stdinFile?: string; secret?: string }): Promise<{ ok: boolean; output: string }> {
  try {
    const proc = Bun.spawn(argv, {
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: options.stdinFile ? Bun.file(options.stdinFile) : 'ignore',
      env: { ...(process.env as Record<string, string>), LC_ALL: 'C', LANG: 'C', ...options.env },
      timeout: options.timeoutMs,
      killSignal: 'SIGKILL',
    })
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    const code = await proc.exited
    let output = `${stdout}${stderr}`.trim()
    if (options.secret) output = output.split(options.secret).join('***')
    if (proc.signalCode) output = `${output}\n(killed: ${proc.signalCode}${proc.signalCode === 'SIGKILL' ? ` after ${Math.round(options.timeoutMs / 1000)}s` : ''})`.trim()
    return { ok: code === 0 && !proc.signalCode, output }
  } catch (error) {
    return { ok: false, output: error instanceof Error ? error.message : String(error) }
  }
}

/** pg_dump refuses a newer server; say which client to install instead of pasting its complaint. */
function versionHint(output: string): string {
  const match = /server version:\s*(\d+)[\s\S]*?(?:pg_dump|pg_restore|psql) version:\s*(\d+)/i.exec(output)
  return match ? ` The server runs PostgreSQL ${match[1]} but the local client is ${match[2]}: install the matching client (${process.platform === 'darwin' ? `brew install postgresql@${match[1]}` : `postgresql-client-${match[1]}`}).` : ''
}

export async function databaseSize(url: string, engine: DatabaseEngine): Promise<number | undefined> {
  if (engine === 'sqlite') {
    try {
      return statSync(sqliteFileOf(url)).size
    } catch {
      return undefined
    }
  }
  const sql = engine === 'mysql'
    ? 'SELECT COALESCE(SUM(data_length + index_length), 0) AS bytes FROM information_schema.tables WHERE table_schema = DATABASE()'
    : 'SELECT pg_database_size(current_database()) AS bytes'
  const result = await runSql(url, sql, { timeoutMs: 15_000, readOnly: true })
  const bytes = numberOf(result.statements[0]?.rows[0]?.bytes)
  return Number.isFinite(bytes) ? bytes : undefined
}

export interface BackupRequest {
  format?: 'custom' | 'sql'
  schemaOnly?: boolean
  dataOnly?: boolean
  tables?: string[]
  /** Workspace-relative path to write; defaults to .elia/devdb/backups/<db>-<time>.<ext>. */
  file?: string
  /** Refuse above this size (automatic backups). */
  limitBytes?: number
  timeoutMs?: number
}

export interface BackupOutcome {
  ok: boolean
  path?: string
  bytes?: number
  message: string
}

export async function takeBackup(root: string, url: string, request: BackupRequest = {}): Promise<BackupOutcome> {
  const parsed = parseDatabaseUrl(url)
  const engine = parsed?.engine ?? 'unknown'
  if (engine === 'unknown') return { ok: false, message: 'elia cannot back up this kind of database' }
  if (request.limitBytes !== undefined) {
    const size = await databaseSize(url, engine)
    if (size !== undefined && size > request.limitBytes) {
      return { ok: false, message: `the database is ${formatBytes(size)}, over the ${formatBytes(request.limitBytes)} automatic-backup limit` }
    }
  }
  const format = engine === 'postgres' ? (request.format ?? 'custom') : 'sql'
  const extension = engine === 'sqlite' ? 'sqlite' : format === 'custom' ? 'dump' : 'sql'
  const name = safeFileName(engine === 'sqlite' ? basename(parsed?.database ?? 'db').replace(/\.[^.]+$/, '') : parsed?.database || 'db')
  let path: string
  try {
    path = request.file ? resolveWorkspacePath(request.file, root) : join(prepareBackupsDir(root), `${name}-${stamp()}.${extension}`)
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
  if (request.file && existsSync(path)) return { ok: false, message: `${request.file} already exists; elia does not overwrite files with a backup — pick a new name` }
  const timeoutMs = request.timeoutMs ?? 300_000

  if (engine === 'sqlite') {
    const source = sqliteFileOf(url)
    if (!existsSync(source)) return { ok: false, message: `there is no database file at ${source} yet` }
    // VACUUM INTO takes a consistent snapshot even while the app has the file open (and folds in a WAL).
    const result = await runSql(url, `VACUUM INTO ${quoteLiteral(path, 'sqlite')}`, { timeoutMs })
    if (!result.ok) return { ok: false, message: `snapshot failed: ${result.error ?? 'unknown error'}` }
    return { ok: true, path, bytes: statSync(path).size, message: `snapshot written to ${path}` }
  }

  if (engine === 'mysql') {
    const dump = Bun.which('mysqldump')
    const connection = mysqlCliConnection(url)
    if (!dump || !connection) return { ok: false, message: 'mysqldump is not installed, so no backup can be taken' }
    const args = [dump, ...connection.args, '--single-transaction', '--routines', '--triggers', '--events', `--result-file=${path}`, connection.database, ...(request.tables ?? [])]
    if (request.schemaOnly) args.splice(args.length - 1 - (request.tables?.length ?? 0), 0, '--no-data')
    const dumped = await runTool(args, { env: connection.env, timeoutMs, secret: connection.env.MYSQL_PWD })
    if (!dumped.ok) {
      rmSync(path, { force: true })
      return { ok: false, message: `mysqldump failed: ${dumped.output.slice(-600)}` }
    }
    return { ok: true, path, bytes: statSync(path).size, message: `dump written to ${path}` }
  }

  const binaries = findPostgresBinaries()
  if (!binaries?.pgDump) return { ok: false, message: `pg_dump is not installed, so no backup can be taken (\`${installHint()}\` provides it)` }
  const connection = libpqConnection(url)
  const args = [binaries.pgDump, `--file=${path}`]
  if (format === 'custom') args.push('--format=custom')
  // Plain SQL is the portable form: it drops what it recreates and names no owner or grantee, so it loads into any database.
  else args.push('--no-owner', '--no-privileges', '--clean', '--if-exists')
  if (request.schemaOnly) args.push('--schema-only')
  if (request.dataOnly) args.push('--data-only')
  for (const table of request.tables ?? []) args.push(`--table=${table}`)
  args.push(`--dbname=${connection.url}`)
  const dumped = await runTool(args, { env: connection.env, timeoutMs, secret: connection.env.PGPASSWORD })
  if (!dumped.ok) {
    rmSync(path, { force: true })
    const output = dumped.output.split(url).join(redactDatabaseUrl(url))
    return { ok: false, message: `pg_dump failed: ${output.slice(-600)}${versionHint(output)}` }
  }
  return { ok: true, path, bytes: statSync(path).size, message: `dump written to ${path}` }
}

export interface DestroyGuard {
  proceed: boolean
  notes: string[]
  refusal?: string
}

/**
 * Takes the backup a destructive action needs, or explains why it cannot run.
 * `url` is the database about to lose data — which for DROP DATABASE is not
 * necessarily the one the call is connected to.
 */
export async function backupBeforeDestroying(ctx: DbContext, input: Record<string, unknown>, what: string, url = ctx.target.url): Promise<DestroyGuard> {
  if (input.no_backup === true) return { proceed: true, notes: [`no backup taken before ${what}: explicitly waived (no_backup)`] }
  const backup = await takeBackup(ctx.root, url, { limitBytes: AUTO_BACKUP_LIMIT_BYTES })
  if (backup.ok && backup.path) {
    return { proceed: true, notes: [`backup taken before ${what}: ${backup.path} (${formatBytes(backup.bytes ?? Number.NaN)}) — undo with action restore file=${basename(backup.path)}`] }
  }
  if (ctx.target.devdb) return { proceed: true, notes: [`no backup taken before ${what} (${backup.message}); going ahead because this is elia's own scratch database`] }
  return {
    proceed: false,
    notes: [],
    refusal: `Refused: ${what} destroys data in ${describeDatabaseUrl(url)} (${ctx.target.source}), and elia backs a database up before destroying anything in it — but ${backup.message}. Either fix that, narrow the change so nothing is destroyed, or pass no_backup: true to go ahead without a backup (the user is asked to approve that explicitly).`,
  }
}

// ---------------------------------------------------------------------------
// backup action
// ---------------------------------------------------------------------------

export async function backup(ctx: DbContext, input: Record<string, unknown>): Promise<string> {
  const tables = Array.isArray(input.tables) ? input.tables.filter((table): table is string => typeof table === 'string' && table.trim() !== '').map((table) => table.trim()) : []
  const format = input.format === 'sql' ? 'sql' : input.format === 'custom' ? 'custom' : undefined
  const outcome = await takeBackup(ctx.root, ctx.target.url, {
    format,
    schemaOnly: input.schema_only === true,
    dataOnly: input.data_only === true,
    tables,
    file: typeof input.file === 'string' && input.file.trim() ? input.file.trim() : undefined,
    timeoutMs: 3_600_000,
  })
  if (!outcome.ok || !outcome.path) return `${targetLine(ctx.target)}\nbackup failed: ${outcome.message}`
  const how = ctx.engine === 'postgres'
    ? (format === 'sql' ? 'plain SQL (no owners or grants; loads into any database)' : 'pg_dump custom format (complete; restored with pg_restore)')
    : ctx.engine === 'sqlite' ? 'a consistent copy of the database file' : 'mysqldump SQL'
  return `${targetLine(ctx.target)}\nbackup written: ${outcome.path} (${formatBytes(outcome.bytes ?? Number.NaN)}, ${how}${input.schema_only === true ? ', schema only' : input.data_only === true ? ', data only' : ''}${tables.length ? `, tables: ${tables.join(', ')}` : ''})\nRestore it with action restore file=${basename(outcome.path)}${outcome.path.startsWith(backupsDir(ctx.root)) ? '' : ` (or the path above)`}.`
}

// ---------------------------------------------------------------------------
// restore action
// ---------------------------------------------------------------------------

export function listBackups(root: string): string {
  const dir = backupsDir(root)
  let entries: { name: string; bytes: number; modified: string }[] = []
  try {
    entries = readdirSync(dir)
      .filter((name) => /\.(?:dump|sql|sqlite)$/.test(name))
      .map((name) => {
        const stat = statSync(join(dir, name))
        return { name, bytes: stat.size, modified: stat.mtime.toISOString().slice(0, 19).replace('T', ' ') }
      })
      .sort((a, b) => b.modified.localeCompare(a.modified))
  } catch {
    // no backups yet
  }
  if (entries.length === 0) return `No backups under ${dir} yet. Take one with action backup.`
  return `Backups in ${dir} (newest first):\n${formatRows(entries.map((entry) => ({ file: entry.name, size: formatBytes(entry.bytes), taken: entry.modified })), 100)}\nRestore one with action restore file=<name> (into: "new" with database=<name> restores into a fresh database instead).`
}

function readHeader(path: string, bytes = 16): string {
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(bytes)
    const read = readSync(fd, buffer, 0, bytes, 0)
    return buffer.subarray(0, read).toString('latin1')
  } finally {
    closeSync(fd)
  }
}

function resolveBackupFile(root: string, file: string): string {
  if (!/[\\/]/.test(file)) {
    const inBackups = join(backupsDir(root), file)
    if (existsSync(inBackups)) return inBackups
  }
  return resolveWorkspacePath(file, root)
}

const DATABASE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_$-]{0,62}$/

/** Runs `fn` on a connection to the server's maintenance database, the one you connect to in order to create or drop others. */
async function onMaintenanceDatabase<T>(url: string, fn: (maintenanceUrl: string) => Promise<{ ok: boolean; value: T }>): Promise<T> {
  let last: T | undefined
  for (const database of ['postgres', 'template1']) {
    const attempt = await fn(withDatabaseName(url, database))
    if (attempt.ok) return attempt.value
    last = attempt.value
  }
  return last as T
}

/** Drops and recreates a Postgres database, empty. Other sessions on it are ended (PG 13+ WITH (FORCE)). */
export async function recreatePostgresDatabase(url: string, name: string): Promise<{ ok: boolean; message: string }> {
  return onMaintenanceDatabase<{ ok: boolean; message: string }>(url, async (maintenance) => {
    const version = await runSql(maintenance, "SELECT current_setting('server_version_num')::int AS num", { timeoutMs: 15_000 })
    if (!version.ok) return { ok: false, value: { ok: false, message: version.error ?? 'could not connect' } }
    const force = numberOf(version.statements[0]?.rows[0]?.num) >= 130_000
    if (!force) await runSql(maintenance, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${quoteLiteral(name, 'postgres')} AND pid <> pg_backend_pid()`)
    const dropped = await runSql(maintenance, `DROP DATABASE IF EXISTS ${quoteIdent(name, 'postgres')}${force ? ' WITH (FORCE)' : ''}`, { timeoutMs: 120_000 })
    if (!dropped.ok) return { ok: true, value: { ok: false, message: `DROP DATABASE failed: ${dropped.error ?? 'unknown error'}` } }
    const created = await runSql(maintenance, `CREATE DATABASE ${quoteIdent(name, 'postgres')}`, { timeoutMs: 120_000 })
    return { ok: true, value: created.ok ? { ok: true, message: 'recreated' } : { ok: false, message: `CREATE DATABASE failed: ${created.error ?? 'unknown error'}` } }
  })
}

async function createPostgresDatabase(url: string, name: string): Promise<{ ok: boolean; message: string }> {
  return onMaintenanceDatabase<{ ok: boolean; message: string }>(url, async (maintenance) => {
    const created = await runSql(maintenance, `CREATE DATABASE ${quoteIdent(name, 'postgres')}`, { timeoutMs: 120_000 })
    if (created.ok) return { ok: true, value: { ok: true, message: 'created' } }
    const unreachable = /connect|does not exist|authentication|password/i.test(created.error ?? '') && !/already exists/i.test(created.error ?? '')
    return { ok: !unreachable, value: { ok: false, message: `CREATE DATABASE failed: ${created.error ?? 'unknown error'}` } }
  })
}

async function loadPostgres(url: string, file: string, custom: boolean): Promise<{ ok: boolean; message: string }> {
  const binaries = findPostgresBinaries()
  const tool = custom ? binaries?.pgRestore : binaries?.psql
  if (!tool) return { ok: false, message: `${custom ? 'pg_restore' : 'psql'} is not installed (\`${installHint()}\` provides it)` }
  const connection = libpqConnection(url)
  // One transaction: a restore that fails part-way leaves nothing half-loaded behind.
  const args = custom
    ? [tool, '--no-owner', '--no-privileges', '--single-transaction', '--exit-on-error', `--dbname=${connection.url}`, file]
    : [tool, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '--single-transaction', `--dbname=${connection.url}`, '-f', file]
  const loaded = await runTool(args, { env: connection.env, timeoutMs: 3_600_000, secret: connection.env.PGPASSWORD })
  const output = loaded.output.split(url).join(redactDatabaseUrl(url))
  return loaded.ok ? { ok: true, message: output.slice(-400) } : { ok: false, message: `${custom ? 'pg_restore' : 'psql'} failed: ${output.slice(-800)}${versionHint(output)}` }
}

async function restoredSummary(url: string): Promise<string> {
  const engine = parseDatabaseUrl(url)?.engine
  const sql = engine === 'sqlite'
    ? "SELECT count(*) AS tables FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
    : engine === 'mysql'
      ? 'SELECT COUNT(*) AS `tables`, COALESCE(SUM(table_rows), 0) AS est_rows FROM information_schema.tables WHERE table_schema = DATABASE()'
      : "SELECT count(*) AS tables, coalesce(sum(greatest(c.reltuples, 0)), 0)::bigint AS est_rows FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname !~ '^pg_toast'"
  const result = await runSql(url, sql, { timeoutMs: 30_000, readOnly: true })
  return result.ok ? `after the restore: ${formatRows(result.statements[0]?.rows ?? [])}` : `could not read the restored database back: ${result.error ?? 'unknown error'}`
}

export async function restore(ctx: DbContext, input: Record<string, unknown>): Promise<string> {
  const fileInput = typeof input.file === 'string' ? input.file.trim() : ''
  if (!fileInput) return listBackups(ctx.root)
  let file: string
  try {
    file = resolveBackupFile(ctx.root, fileInput)
  } catch (error) {
    return `restore: ${error instanceof Error ? error.message : String(error)}`
  }
  if (!existsSync(file)) return `restore: no backup at ${fileInput}.\n${listBackups(ctx.root)}`
  const header = readHeader(file)
  const intoNew = input.into === 'new'
  const newName = typeof input.database === 'string' ? input.database.trim() : ''
  if (intoNew && !newName) return 'restore into "new" needs `database`: the name of the database to create (for SQLite, the new file path).'

  if (ctx.engine === 'sqlite') {
    if (!header.startsWith('SQLite format 3')) return `restore: ${fileInput} is not a SQLite database file.`
    const target = sqliteFileOf(ctx.target.url)
    if (intoNew) {
      let destination: string
      try {
        destination = resolveWorkspacePath(newName, ctx.root)
      } catch (error) {
        return `restore: ${error instanceof Error ? error.message : String(error)}`
      }
      if (existsSync(destination)) return `restore: ${newName} already exists; pick a new file name.`
      copyFileSync(file, destination)
      return `${targetLine(ctx.target)}\nrestored ${fileInput} into a new file: ${destination}\n${await restoredSummary(`sqlite://${destination}`)}`
    }
    if (file === target) return 'restore: that backup is the database file itself.'
    const guard = existsSync(target) ? await backupBeforeDestroying(ctx, input, 'restoring over the database') : { proceed: true, notes: [] as string[] }
    if (!guard.proceed) return guard.refusal ?? 'restore refused'
    copyFileSync(file, target)
    // A leftover write-ahead log from the old file would be replayed onto the new one.
    for (const suffix of ['-wal', '-shm']) rmSync(`${target}${suffix}`, { force: true })
    return [targetLine(ctx.target), ...guard.notes, `restored ${fileInput} over ${target}`, await restoredSummary(ctx.target.url)].join('\n')
  }

  if (ctx.engine === 'mysql') {
    const client = Bun.which('mysql')
    const connection = mysqlCliConnection(ctx.target.url)
    if (!client || !connection) return 'restore: the mysql client is not installed, so a dump cannot be loaded.'
    const database = intoNew ? newName : connection.database
    if (!DATABASE_NAME.test(database)) return `restore: "${database}" is not a database name elia will create.`
    const guard = intoNew ? { proceed: true, notes: [] as string[] } : await backupBeforeDestroying(ctx, input, 'restoring over the database')
    if (!guard.proceed) return guard.refusal ?? 'restore refused'
    const reset = await runSql(ctx.target.url, `${intoNew ? '' : `DROP DATABASE IF EXISTS ${quoteIdent(database, 'mysql')};\n`}CREATE DATABASE ${quoteIdent(database, 'mysql')}`, { timeoutMs: 120_000 })
    if (!reset.ok) return `restore: preparing ${database} failed: ${reset.error ?? 'unknown error'}`
    const loaded = await runTool([client, ...connection.args, `--database=${database}`], { env: connection.env, timeoutMs: 3_600_000, stdinFile: file, secret: connection.env.MYSQL_PWD })
    if (!loaded.ok) return [targetLine(ctx.target), ...guard.notes, `mysql failed: ${loaded.output.slice(-800)}`].join('\n')
    return [targetLine(ctx.target), ...guard.notes, `restored ${fileInput} into ${database}`, await restoredSummary(withDatabaseName(ctx.target.url, database))].join('\n')
  }

  const custom = header.startsWith('PGDMP')
  const current = parseDatabaseUrl(ctx.target.url)?.database ?? ''
  const database = intoNew ? newName : current
  if (!DATABASE_NAME.test(database)) return `restore: "${database}" is not a database name elia will create.`
  const destination = withDatabaseName(ctx.target.url, database)
  const notes: string[] = []
  if (intoNew) {
    const created = await createPostgresDatabase(ctx.target.url, database)
    if (!created.ok) return `${targetLine(ctx.target)}\nrestore: ${created.message}`
  } else {
    const guard = await backupBeforeDestroying(ctx, input, 'restoring over the database')
    if (!guard.proceed) return guard.refusal ?? 'restore refused'
    notes.push(...guard.notes)
    const recreated = await recreatePostgresDatabase(ctx.target.url, database)
    if (!recreated.ok) return [targetLine(ctx.target), ...notes, `restore: could not recreate ${database} empty: ${recreated.message}`].join('\n')
    notes.push(`${database} was dropped and recreated empty (other sessions on it were ended)`)
  }
  const loaded = await loadPostgres(destination, file, custom)
  if (!loaded.ok) return [targetLine(ctx.target), ...notes, `restore failed — ${loaded.message}`, intoNew ? '' : 'The database is now empty; restore the backup named above to put it back.'].filter(Boolean).join('\n')
  const state = readLocalDbState(ctx.root)
  const newUrl = intoNew ? (ctx.target.devdb && state ? withDatabaseName(state.url, database) : redactDatabaseUrl(destination)) : undefined
  return [
    targetLine(ctx.target),
    ...notes,
    `restored ${basename(file)} (${custom ? 'pg_restore; owners and grants from the dump were not applied' : 'psql'}) into ${database}${newUrl ? ` — url: ${newUrl}` : ''}`,
    await restoredSummary(destination),
  ].join('\n')
}

// ---------------------------------------------------------------------------
// create_database / drop_database
// ---------------------------------------------------------------------------

export async function createDatabase(ctx: DbContext, input: Record<string, unknown>): Promise<string> {
  const name = typeof input.database === 'string' ? input.database.trim() : ''
  const from = typeof input.from === 'string' ? input.from.trim() : ''
  if (!name) return 'create_database needs `database`: the new database\'s name (for SQLite, a file path).'
  if (ctx.engine === 'sqlite') {
    let path: string
    try {
      path = resolveWorkspacePath(name, ctx.root)
    } catch (error) {
      return `create_database: ${error instanceof Error ? error.message : String(error)}`
    }
    if (existsSync(path)) return `create_database: ${name} already exists.`
    const result = from
      ? await runSql(ctx.target.url, `VACUUM INTO ${quoteLiteral(path, 'sqlite')}`)
      : await runSql(`sqlite://${path}`, 'PRAGMA user_version = 0')
    return result.ok ? `created ${path}${from ? ` as a copy of ${sqliteFileOf(ctx.target.url)}` : ''} — url: sqlite://${path}` : `create_database failed: ${result.error ?? 'unknown error'}`
  }
  if (!DATABASE_NAME.test(name)) return `"${name}" is not a database name elia will create (letters, digits, _ $ -).`
  if (from && !DATABASE_NAME.test(from)) return `"${from}" is not a database name.`
  if (ctx.engine === 'mysql') {
    if (from) return 'MySQL cannot copy a database in one statement: back it up (action backup), then restore with into: "new".'
    const result = await runSql(ctx.target.url, `CREATE DATABASE ${quoteIdent(name, 'mysql')}`)
    return result.ok ? `${targetLine(ctx.target)}\ncreated database ${name} — url: ${redactDatabaseUrl(withDatabaseName(ctx.target.url, name))}` : `create_database failed: ${result.error ?? 'unknown error'}`
  }
  const created = await onMaintenanceDatabase(ctx.target.url, async (maintenance) => {
    const result = await runSql(maintenance, `CREATE DATABASE ${quoteIdent(name, 'postgres')}${from ? ` TEMPLATE ${quoteIdent(from, 'postgres')}` : ''}`, { timeoutMs: 600_000 })
    const unreachable = !result.ok && /connect|does not exist|authentication|password/i.test(result.error ?? '') && !/already exists|source database/i.test(result.error ?? '')
    return { ok: !unreachable, value: result }
  })
  if (!created.ok) {
    const busy = /being accessed by other users/i.test(created.error ?? '') ? ` Copying needs ${from} to have no other sessions; see them with action activity.` : ''
    return `${targetLine(ctx.target)}\nCREATE DATABASE failed: ${created.error ?? 'unknown error'}${busy}`
  }
  const state = readLocalDbState(ctx.root)
  const url = ctx.target.devdb && state ? withDatabaseName(state.url, name) : redactDatabaseUrl(withDatabaseName(ctx.target.url, name))
  return `${targetLine(ctx.target)}\ncreated database ${name}${from ? ` as a copy of ${from}` : ''} — url: ${url}\nReach it with url set to that, or point an env variable at it and pass target: "<THAT_VARIABLE>".`
}

export async function dropDatabase(ctx: DbContext, input: Record<string, unknown>): Promise<string> {
  const current = parseDatabaseUrl(ctx.target.url)?.database ?? ''
  const name = typeof input.database === 'string' && input.database.trim() ? input.database.trim() : current
  if (ctx.engine === 'sqlite') {
    const file = sqliteFileOf(ctx.target.url)
    if (!existsSync(file)) return `drop_database: there is no database file at ${file}.`
    const guard = await backupBeforeDestroying(ctx, input, `deleting ${basename(file)}`)
    if (!guard.proceed) return guard.refusal ?? 'drop refused'
    for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(`${file}${suffix}`, { force: true })
    return [targetLine(ctx.target), ...guard.notes, `deleted ${file}`].join('\n')
  }
  if (!DATABASE_NAME.test(name)) return `"${name}" is not a database name.`
  if (['postgres', 'template0', 'template1', 'mysql', 'sys', 'information_schema', 'performance_schema'].includes(name)) return `Refused: ${name} is a system database the server needs.`
  const doomed = withDatabaseName(ctx.target.url, name)
  const guard = await backupBeforeDestroying(ctx, input, `dropping database ${name}`, doomed)
  if (!guard.proceed) return guard.refusal ?? 'drop refused'
  if (ctx.engine === 'mysql') {
    const result = await runSql(ctx.target.url, `DROP DATABASE ${quoteIdent(name, 'mysql')}`, { timeoutMs: 120_000 })
    return [targetLine(ctx.target), ...guard.notes, result.ok ? `dropped database ${name}` : `DROP DATABASE failed: ${result.error ?? 'unknown error'}`].join('\n')
  }
  const force = input.force === true
  const result = await onMaintenanceDatabase(ctx.target.url, async (maintenance) => {
    const dropped = await runSql(maintenance, `DROP DATABASE ${quoteIdent(name, 'postgres')}${force ? ' WITH (FORCE)' : ''}`, { timeoutMs: 120_000 })
    const unreachable = !dropped.ok && /connect|authentication|password/i.test(dropped.error ?? '')
    return { ok: !unreachable, value: dropped }
  })
  if (!result.ok) {
    const busy = /being accessed by other users/i.test(result.error ?? '') ? ' Other sessions are connected to it: end them (activity → terminate) or pass force: true to end them as part of the drop.' : ''
    return [targetLine(ctx.target), ...guard.notes, `DROP DATABASE failed: ${result.error ?? 'unknown error'}${busy}`].join('\n')
  }
  const state = readLocalDbState(ctx.root)
  const devdbNote = ctx.target.devdb && state?.database === name ? '\nThat was the database elia\'s devdb points at; action start creates it again, empty.' : ''
  return [targetLine(ctx.target), ...guard.notes, `dropped database ${name}${devdbNote}`].join('\n')
}
