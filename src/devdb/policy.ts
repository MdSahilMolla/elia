/**
 * Which database a `database` tool call touches, and how much that may cost.
 *
 * Synchronous on purpose: the action governor classifies every tool call
 * before it runs and cannot await, so the target is resolved from the same
 * files `detect.ts` reads (env files, elia's own devdb state) with no network.
 *
 * The line is drawn at locality, not at the verb — with one exception:
 *
 *   local  (loopback, unix socket, a sqlite file in the project)
 *     inspect / read / export / backup / dry run      safe     — runs freely
 *     write / schema change / import / maintenance /
 *     migrate / create a database / cancel a query    review   — runs unattended; recorded
 *     destructive (DROP, TRUNCATE, drop a database,
 *     restore over it, roll a migration back, end a
 *     session)                                        review   — only after the tool has
 *                                                                 backed the database up
 *     destructive with the backup explicitly waived   critical (review on elia's own
 *                                                                 scratch database)
 *     start / stop elia's own postgres                review
 *
 *   remote (anything else — possibly somebody's production)
 *     every action                                    critical — never settled once for a
 *                                                                 run; unattended runs refuse it
 *     split into database.remote.{inspect,read,write,destructive}, so an
 *     "always allow" given for looking never stands for changing
 *
 *   anywhere
 *     SQL that reaches past the database (server files, programs, native code,
 *     outbound connections — sql.ts `host`)          critical — database.host-access
 *
 * Remote reads are critical too. Rows from a hosted database are real people's
 * data; an unsupervised run that pulls them into a model prompt is a privacy
 * incident even when nothing was written.
 */

import { isAbsolute, relative, resolve } from 'node:path'
import type { ActionAssessment } from '../autonomy/governor.ts'
import { isPathWithinWorkspace } from '../autonomy/context.ts'
import { isEliaTrustFile, isSensitivePath } from '../autonomy/sensitivePaths.ts'
import { detectDatabase, findEnvDatabaseUrl, primaryTarget } from './detect.ts'
import { readLocalDbState } from './local.ts'
import { classifyRawStatement, classifySql, reachesHost, splitSqlText, type SqlClass } from './sql.ts'
import { engineOf, parseDatabaseUrl, redactDatabaseUrl, resolveSqliteUrl, type DatabaseEngine } from './url.ts'

export type DatabaseAction =
  | 'detect' | 'status' | 'start' | 'stop'
  | 'overview' | 'schema' | 'describe' | 'roles' | 'settings' | 'activity' | 'health' | 'explain'
  | 'query' | 'migrate' | 'maintain' | 'terminate' | 'create_database' | 'drop_database'
  | 'backup' | 'restore' | 'export' | 'import'

export const DATABASE_ACTIONS: readonly DatabaseAction[] = [
  'detect', 'status', 'start', 'stop',
  'overview', 'schema', 'describe', 'roles', 'settings', 'activity', 'health', 'explain',
  'query', 'migrate', 'maintain', 'terminate', 'create_database', 'drop_database',
  'backup', 'restore', 'export', 'import',
]

export interface ResolvedTarget {
  url: string
  /** Human-readable origin: `elia devdb`, `.env: DATABASE_URL`, `explicit url`. */
  source: string
  local: boolean
  devdb: boolean
}

/**
 * Resolves the connection a call means.
 *
 *   url            an explicit connection string
 *   target=devdb   elia's own postgres for this project
 *   target=VAR     that variable from the project's env files / process env —
 *                  any name, so a second database is reached by naming the
 *                  variable that holds it, never by pasting its password
 *   (default)      the project's own local database if it declares one, else
 *                  elia's devdb if one exists, else whatever the project
 *                  declares (which may be remote — and then is governed so)
 *
 * SQLite URLs come back absolute (url.ts resolveSqliteUrl), so the file the
 * governor judged is the file the tool opens.
 */
export function resolveDatabaseTarget(root: string, input: { url?: unknown; target?: unknown }, env: NodeJS.ProcessEnv = process.env): ResolvedTarget | undefined {
  const devdb = readLocalDbState(root)
  const fromDevdb = (): ResolvedTarget | undefined => (devdb ? { url: devdb.url, source: 'elia devdb', local: true, devdb: true } : undefined)
  const described = (rawUrl: string, source: string, declaredLocal?: boolean): ResolvedTarget => {
    const url = engineOf(rawUrl) === 'sqlite' ? resolveSqliteUrl(rawUrl, root) : rawUrl
    const parsed = parseDatabaseUrl(url)
    const local = parsed?.engine === 'sqlite' ? sqliteInsideProject(root, parsed.database) : (declaredLocal ?? parsed?.local ?? false)
    return { url, source, local, devdb: Boolean(devdb && parsed?.engine === 'postgres' && parsed.local && parsed.port === devdb.port) }
  }
  if (typeof input.url === 'string' && input.url.trim()) return described(input.url.trim(), 'explicit url')
  const target = typeof input.target === 'string' ? input.target.trim() : ''
  if (target === 'devdb') return fromDevdb()
  const detection = detectDatabase(root, env)
  if (target && target !== 'project' && target !== 'auto') {
    const named = detection.targets.find((candidate) => candidate.variable === target && !candidate.example)
    if (named) return described(named.url, named.source, named.local)
    const other = findEnvDatabaseUrl(root, target, env)
    return other ? described(other.url, other.source) : undefined
  }
  const project = primaryTarget(detection)
  if (project && (project.local || target === 'project')) return described(project.url, project.source, project.local)
  return fromDevdb() ?? (project ? described(project.url, project.source, project.local) : undefined)
}

function sqliteInsideProject(root: string, file: string): boolean {
  if (!file || file === ':memory:') return true
  const absolute = isAbsolute(file) ? file : resolve(root, file)
  const rel = relative(root, absolute)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

function verdict(risk: ActionAssessment['risk'], reason: string, intent: string, resources: string[], reversible: boolean): ActionAssessment {
  return { risk, decision: risk === 'safe' ? 'allow' : 'approve', reason, intent, resources, reversible }
}

export function sqlClassOf(input: Record<string, unknown>, engine: DatabaseEngine = 'postgres'): SqlClass {
  return typeof input.sql === 'string' ? classifySql(input.sql, engine) : 'read'
}

/** What an action does to the database, before locality is taken into account. */
type Effect = 'inspect' | 'read' | 'dry-run' | 'backup' | 'write' | 'maintain' | 'session' | 'migrate' | 'destructive' | 'unbacked' | 'host'

/** Settings that name a program to run, a library to load, a path, or a network address. */
export const HOST_SETTING_NAMES = /^(?:archive_command|archive_library|restore_command|archive_cleanup_command|recovery_end_command|ssl_passphrase_command|shared_preload_libraries|session_preload_libraries|local_preload_libraries|dynamic_library_path|data_directory|config_file|hba_file|ident_file|external_pid_file|log_directory|unix_socket_directories|listen_addresses|primary_conninfo|secure_file_priv|plugin_dir|local_infile)$/i

function waived(input: Record<string, unknown>): boolean {
  return input.no_backup === true
}

function effectOf(action: DatabaseAction, input: Record<string, unknown>, engine: DatabaseEngine): Effect {
  switch (action) {
    case 'status':
    case 'schema':
    case 'overview':
    case 'describe':
    case 'roles':
    case 'health':
      return 'inspect'
    case 'settings':
      if (input.value === undefined || input.value === null || input.value === '') return 'inspect'
      return typeof input.name === 'string' && HOST_SETTING_NAMES.test(input.name.trim()) ? 'host' : 'write'
    // Session query texts carry the literals applications sent — real data.
    case 'activity':
      return 'read'
    case 'explain': {
      const statement = splitSqlText(typeof input.sql === 'string' ? input.sql : '', engine)[0] ?? ''
      if (statement && reachesHost(statement, engine)) return 'host'
      if (input.analyze !== true) return 'inspect'
      return (statement ? classifyRawStatement(statement, engine) : 'read') === 'read' ? 'read' : 'dry-run'
    }
    case 'query': {
      const sqlClass = sqlClassOf(input, engine)
      if (sqlClass === 'host') return 'host'
      if (sqlClass === 'read') return 'read'
      if (input.dry_run === true) return 'dry-run'
      if (sqlClass === 'destructive') return waived(input) ? 'unbacked' : 'destructive'
      return 'write'
    }
    case 'maintain':
      return input.operation === 'check' ? 'inspect' : 'maintain'
    // The tool cancels the running statement unless told to end the whole session.
    case 'terminate':
      return input.mode === 'terminate' ? 'destructive' : 'session'
    case 'create_database':
      return 'write'
    case 'drop_database':
      return waived(input) ? 'unbacked' : 'destructive'
    case 'backup':
      return 'backup'
    case 'restore':
      if (input.into === 'new') return 'write'
      return waived(input) ? 'unbacked' : 'destructive'
    case 'export':
      return sqlClassOf(input, engine) === 'host' ? 'host' : 'read'
    case 'import':
      if (input.truncate === true) return waived(input) ? 'unbacked' : 'destructive'
      return 'write'
    case 'migrate':
      if (input.operation === 'rollback') return waived(input) ? 'unbacked' : 'destructive'
      return 'migrate'
    default:
      return 'write'
  }
}

/** A file an action reads or writes must stay in the workspace and off elia's trust store and secret files. */
function fileVerdict(action: DatabaseAction, input: Record<string, unknown>, root: string): ActionAssessment | undefined {
  const file = typeof input.file === 'string' ? input.file.trim() : ''
  if (!file || !['backup', 'restore', 'export', 'import'].includes(action)) return undefined
  // restore accepts a bare backup name, which resolves inside .elia/devdb/backups.
  if (action === 'restore' && !/[\\/]/.test(file)) return undefined
  if (!isPathWithinWorkspace(file, root)) {
    return verdict('critical', `database ${action} ${action === 'import' || action === 'restore' ? 'reads' : 'writes'} a file outside the active workspace (${file})`, `database.${action}.outside-workspace`, [file], false)
  }
  if (isEliaTrustFile(resolve(root, file)) || isSensitivePath(file)) {
    return verdict('critical', `database ${action} names ${file}, a secret or trust-store file`, `database.${action}.sensitive-file`, [file], false)
  }
  return undefined
}

const LOCAL_VERDICT: Record<Exclude<Effect, 'host' | 'unbacked'>, { risk: ActionAssessment['risk']; intent: string; reversible: boolean; what: string }> = {
  inspect: { risk: 'safe', intent: 'database.inspect', reversible: true, what: 'only reads catalog metadata' },
  read: { risk: 'safe', intent: 'database.read', reversible: true, what: 'reads rows without changing anything' },
  'dry-run': { risk: 'safe', intent: 'database.dry-run', reversible: true, what: 'runs the change inside a transaction that is rolled back' },
  backup: { risk: 'safe', intent: 'database.backup', reversible: true, what: 'dumps the database into a new backup file' },
  write: { risk: 'review', intent: 'database.local-write', reversible: false, what: 'changes data or schema' },
  maintain: { risk: 'review', intent: 'database.maintain', reversible: true, what: 'runs maintenance (vacuum, analyze, reindex)' },
  session: { risk: 'review', intent: 'database.local-session', reversible: true, what: 'cancels a running query' },
  migrate: { risk: 'review', intent: 'database.migrate', reversible: false, what: "runs the project's own migration tool" },
  destructive: { risk: 'review', intent: 'database.local-destructive', reversible: true, what: 'destroys data or ends a session; the tool backs the database up before destroying data' },
}

const REMOTE_INTENT: Record<Exclude<Effect, 'host'>, string> = {
  inspect: 'database.remote.inspect',
  read: 'database.remote.read',
  backup: 'database.remote.read',
  'dry-run': 'database.remote.write',
  write: 'database.remote.write',
  maintain: 'database.remote.write',
  session: 'database.remote.write',
  migrate: 'database.remote.write',
  destructive: 'database.remote.destructive',
  unbacked: 'database.remote.destructive',
}

export function assessDatabaseRequest(input: Record<string, unknown>, root: string, env: NodeJS.ProcessEnv = process.env): ActionAssessment {
  const action = typeof input.action === 'string' ? (input.action as DatabaseAction) : undefined
  if (!action || !DATABASE_ACTIONS.includes(action)) {
    return verdict('critical', `database action "${String(input.action)}" is not one this tool knows`, 'database.unknown', [], false)
  }
  if (action === 'detect') return verdict('safe', 'reads the project\'s own database configuration files; connects to nothing', 'database.inspect', [], true)
  if (action === 'start' || action === 'stop') {
    return verdict('review', `${action}s elia's own project-local postgres (127.0.0.1 only, data under .elia/devdb)`, 'database.local-server', ['.elia/devdb'], true)
  }
  if (action === 'restore' && !(typeof input.file === 'string' && input.file.trim())) {
    return verdict('safe', 'lists the backups under .elia/devdb/backups; connects to nothing', 'database.inspect', ['.elia/devdb/backups'], true)
  }
  const file = fileVerdict(action, input, root)
  if (file) return file

  const target = resolveDatabaseTarget(root, input, env)
  if (!target) {
    // Nothing to connect to: the tool itself will say so. No side effect is possible.
    return verdict('safe', 'no database is configured or running for this project, so this call can only report that', 'database.inspect', [], true)
  }
  const resource = redactDatabaseUrl(target.url)
  const effect = effectOf(action, input, engineOf(target.url))
  if (effect === 'host') {
    return verdict('critical', `this ${action} reaches past the database to the machine or the network (server-side files, a program, native code, or an outbound connection) — no rollback or backup can undo that`, 'database.host-access', [resource], false)
  }
  if (!target.local) {
    return verdict('critical', `the target database (${target.source}) is not on this machine and may hold production data — database ${action}${effect === 'unbacked' ? ' with no backup taken first' : ''}`, REMOTE_INTENT[effect], [resource], effect === 'inspect' || effect === 'read' || effect === 'backup')
  }
  if (effect === 'unbacked') {
    return target.devdb
      ? verdict('review', `destroys data in elia's own scratch database without a backup (${action})`, 'database.local-destructive', [resource], false)
      : verdict('critical', `destroys data in a local database elia did not create (${target.source}) with the backup explicitly waived — there will be nothing to restore from`, 'database.local-unbacked', [resource], false)
  }
  const local = LOCAL_VERDICT[effect]
  return verdict(local.risk, `${action} ${local.what} on a local database (${target.source})`, local.intent, [resource], local.reversible)
}
