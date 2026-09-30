/**
 * Database connection strings: parse, redact, and decide whether one points at
 * this machine.
 *
 * Locality is the single fact the database tool's governance turns on. A dev
 * database on localhost is scratch space the agent may create, migrate, seed
 * and wipe on its own; anything else may be somebody's production, where elia
 * reads at most and never writes without an exact human "yes". So the check is
 * deliberately narrow: a loopback address or a local socket counts, nothing
 * else does — not a private-network IP, not a hostname that happens to resolve
 * to one, not a container alias that might be forwarded somewhere else.
 */

import { existsSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

export type DatabaseEngine = 'postgres' | 'mysql' | 'sqlite' | 'unknown'

export interface ParsedDatabaseUrl {
  engine: DatabaseEngine
  host: string
  port?: number
  database: string
  user?: string
  /** True when the URL names a loopback host, a unix socket, or a local file. */
  local: boolean
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0', ''])

export function engineOf(url: string): DatabaseEngine {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url.trim())?.[1]?.toLowerCase() ?? ''
  if (scheme === 'postgres' || scheme === 'postgresql' || scheme.startsWith('postgresql+') || scheme.startsWith('postgres+')) return 'postgres'
  if (scheme === 'mysql' || scheme === 'mariadb' || scheme.startsWith('mysql+')) return 'mysql'
  if (scheme === 'sqlite' || scheme === 'file' || scheme.startsWith('sqlite+')) return 'sqlite'
  return 'unknown'
}

export function parseDatabaseUrl(url: string): ParsedDatabaseUrl | undefined {
  const raw = url.trim()
  const engine = engineOf(raw)
  if (engine === 'unknown') return undefined
  if (engine === 'sqlite') return { engine, host: '', database: sqliteFileOf(raw), local: true }
  let parsed: URL
  try {
    // WHATWG URL only fills host/port for special schemes; swap in http so a
    // `postgres://` string parses the same way everywhere. An empty host
    // (`postgres://u@/db`) is libpq's default unix socket — local — which
    // http: cannot express, so it is spelled as localhost.
    const withHost = raw.replace(/^([a-z][a-z0-9+.-]*:\/\/(?:[^/@?]*@)?)(?=[/?]|$)/i, '$1localhost')
    parsed = new URL(withHost.replace(/^[a-z][a-z0-9+.-]*:/i, 'http:'))
  } catch {
    return undefined
  }
  const socketHost = parsed.searchParams.get('host') ?? ''
  const host = decodeURIComponent(parsed.hostname).toLowerCase()
  const port = parsed.port ? Number(parsed.port) : undefined
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''))
  const user = parsed.username ? decodeURIComponent(parsed.username) : undefined
  // `?host=/var/run/postgresql` is a unix socket: local by construction.
  const local = socketHost.startsWith('/') ? true : LOOPBACK_HOSTS.has(host)
  return { engine, host: socketHost.startsWith('/') ? socketHost : host, port, database, user, local }
}

export function isLocalDatabaseUrl(url: string): boolean {
  return parseDatabaseUrl(url)?.local ?? false
}

/**
 * The URL with its password replaced. Every URL elia prints, logs, or hands
 * back to the model goes through here first: the model needs the host and
 * database name to reason about, never the secret.
 */
export function redactDatabaseUrl(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/[^:/@\s]*):([^@\s]*)@/i, (_all, head: string) => `${head}:***@`)
    .replace(/([?&](?:password|sslpassword)=)[^&\s]*/gi, '$1***')
}

/** A short human label: `postgres @ 127.0.0.1:5432/app (local)`. */
export function describeDatabaseUrl(url: string): string {
  const parsed = parseDatabaseUrl(url)
  if (!parsed) return redactDatabaseUrl(url)
  if (parsed.engine === 'sqlite') return `sqlite @ ${parsed.database} (local file)`
  const where = `${parsed.host || 'localhost'}${parsed.port ? `:${parsed.port}` : ''}`
  return `${parsed.engine} @ ${where}/${parsed.database || '(default)'} (${parsed.local ? 'local' : 'remote'})`
}

// ---------------------------------------------------------------------------
// Handing a connection string to a client
// ---------------------------------------------------------------------------

/** The file a sqlite URL names, as written: `file:./dev.db?connection_limit=1` → `./dev.db`. */
export function sqliteFileOf(url: string): string {
  return url.trim().replace(/^[a-z][a-z0-9+.-]*:(?:\/\/)?/i, '').replace(/\?.*$/, '')
}

/**
 * A sqlite URL made absolute against the project, following the conventions of
 * whoever wrote it. Opening the wrong path is not an error in SQLite — it
 * silently creates an empty database there — so the path is settled first:
 *
 *   - Prisma resolves `file:./dev.db` against the folder its schema lives in
 *     (`prisma/dev.db`), not the project root.
 *   - SQLAlchemy spells a relative file `sqlite:///dev.db` (the third slash is
 *     the separator, not the root).
 *
 * An existing file wins; otherwise the convention the URL most likely follows.
 */
export function resolveSqliteUrl(url: string, root: string, exists: (path: string) => boolean = existsSync): string {
  const file = sqliteFileOf(url)
  if (!file || file === ':memory:') return 'sqlite://:memory:'
  const prisma = /^file:/i.test(url.trim()) && exists(join(root, 'prisma', 'schema.prisma'))
  const candidates = isAbsolute(file)
    ? [file, resolve(root, file.replace(/^\/+/, ''))]
    : prisma ? [resolve(root, 'prisma', file), resolve(root, file)] : [resolve(root, file), resolve(root, 'prisma', file)]
  const found = candidates.find((candidate) => exists(candidate))
  if (found) return `sqlite://${found}`
  // A single leading segment is the SQLAlchemy spelling of a project-relative
  // file (`sqlite:///dev.db`); more than one is a real absolute path. Deciding
  // by segment count rather than by whether the parent directory happens to
  // exist keeps the answer the same on every platform: testing the directory
  // silently relocated `/etc/some.db` to `<project>/etc/some.db` on Windows,
  // where `/etc` is absent, so an out-of-project database was classified
  // local and a destructive query on it cleared as review instead of critical.
  const segments = file.replace(/^[\\/]+/, '').split(/[\\/]/)
  const absoluteUsable = isAbsolute(file) && segments.length > 1 && !segments[0]?.includes(':')
  return `sqlite://${absoluteUsable ? file : isAbsolute(file) ? candidates[1]! : candidates[0]!}`
}

/**
 * Query parameters ORMs and drivers put in a connection string for themselves.
 * Postgres takes every parameter it is handed at connect time as a session
 * setting and refuses the session when it does not know one — so a Prisma URL,
 * which carries `?schema=public` by default, failed on every call with
 * `unrecognized configuration parameter "schema"`.
 */
const DRIVER_ONLY_PARAMS = new Set([
  'schema', 'connection_limit', 'pool_timeout', 'pgbouncer', 'socket_timeout', 'statement_cache_size', 'sslaccept', 'sslidentity',
  'connect_timeout', 'pool', 'pool_max', 'pool_min', 'max_idle_connection_lifetime', 'reconnect', 'encoding', 'timeout',
])

/** What libpq's own tools (pg_dump, psql, pg_restore) accept in a URI; anything else makes them exit. */
const LIBPQ_PARAMS = new Set([
  'host', 'hostaddr', 'port', 'dbname', 'user', 'passfile', 'channel_binding', 'connect_timeout', 'client_encoding', 'options',
  'application_name', 'fallback_application_name', 'keepalives', 'keepalives_idle', 'keepalives_interval', 'keepalives_count',
  'tcp_user_timeout', 'gssencmode', 'sslmode', 'sslnegotiation', 'requiressl', 'sslcompression', 'sslcert', 'sslkey', 'sslpassword',
  'sslcertmode', 'sslrootcert', 'sslcrl', 'sslcrldir', 'sslsni', 'requirepeer', 'ssl_min_protocol_version', 'ssl_max_protocol_version',
  'krbsrvname', 'gsslib', 'gssdelegation', 'service', 'target_session_attrs', 'load_balance_hosts',
])

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text.replace(/\+/g, ' '))
  } catch {
    return text
  }
}

function splitUrlQuery(url: string): { base: string; params: [string, string][] } {
  const index = url.indexOf('?')
  if (index === -1) return { base: url, params: [] }
  const params: [string, string][] = []
  for (const part of url.slice(index + 1).replace(/#.*$/, '').split('&')) {
    if (!part) continue
    const eq = part.indexOf('=')
    params.push([safeDecode(eq === -1 ? part : part.slice(0, eq)), eq === -1 ? '' : safeDecode(part.slice(eq + 1))])
  }
  return { base: url.slice(0, index), params }
}

function joinUrlQuery(base: string, params: [string, string][]): string {
  return params.length === 0 ? base : `${base}?${params.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&')}`
}

/** `postgresql+asyncpg://` → `postgres://`, `mariadb://` → `mysql://`: the driver suffix means nothing to a client. */
function canonicalScheme(url: string): string {
  const engine = engineOf(url)
  if (engine === 'postgres') return url.replace(/^[a-z][a-z0-9+.-]*:/i, 'postgres:')
  if (engine === 'mysql') return url.replace(/^[a-z][a-z0-9+.-]*:/i, 'mysql:')
  return url
}

const SSL_ON = /^(?:true|1|require|required)$/i

export interface ClientConnection {
  /** The URL the client may connect with: canonical scheme, driver-only parameters removed. */
  url: string
  /** Prisma's `?schema=` — applied as the session's search_path instead. */
  searchPath?: string
  /** Parameter names that were removed, for a note to the model. */
  dropped: string[]
}

/** The connection string for elia's own SQL client (Bun's `SQL`). */
export function clientConnection(url: string): ClientConnection {
  const { base, params } = splitUrlQuery(canonicalScheme(url.trim()))
  const hasSslMode = params.some(([key]) => key.toLowerCase() === 'sslmode')
  const kept: [string, string][] = []
  const dropped: string[] = []
  let searchPath: string | undefined
  for (const [key, value] of params) {
    const name = key.toLowerCase()
    if (name === 'schema') {
      if (value) searchPath = value
      continue
    }
    if (name === 'ssl') {
      if (SSL_ON.test(value) && !hasSslMode) kept.push(['sslmode', 'require'])
      continue
    }
    if (DRIVER_ONLY_PARAMS.has(name)) dropped.push(key)
    else kept.push([key, value])
  }
  return { url: joinUrlQuery(base, kept), searchPath, dropped }
}

/**
 * The connection for libpq's command-line tools. The password moves from the
 * argument list — readable by every user on the machine through `ps` — into
 * PGPASSWORD, and only parameters libpq knows are kept.
 */
export function libpqConnection(url: string): { url: string; env: Record<string, string> } {
  const { base, params } = splitUrlQuery(canonicalScheme(url.trim()).replace(/^postgres:/i, 'postgresql:'))
  const env: Record<string, string> = {}
  const bare = base.replace(/^(postgresql:\/\/[^:/@]*):([^@]*)@/i, (_all, head: string, password: string) => {
    env.PGPASSWORD = safeDecode(password)
    return `${head}@`
  })
  const hasSslMode = params.some(([key]) => key.toLowerCase() === 'sslmode')
  const kept: [string, string][] = []
  for (const [key, value] of params) {
    const name = key.toLowerCase()
    if (name === 'password') env.PGPASSWORD = value
    else if (name === 'ssl') {
      if (SSL_ON.test(value) && !hasSslMode) kept.push(['sslmode', 'require'])
    } else if (LIBPQ_PARAMS.has(name)) kept.push([name, value])
  }
  return { url: joinUrlQuery(bare, kept), env }
}

/** Arguments for the mysql / mysqldump clients, with the password in MYSQL_PWD rather than on the command line. */
export function mysqlCliConnection(url: string): { args: string[]; env: Record<string, string>; database: string } | undefined {
  const parsed = parseDatabaseUrl(url)
  if (parsed?.engine !== 'mysql') return undefined
  const password = /^[a-z][a-z0-9+.-]*:\/\/[^:/@]*:([^@]*)@/i.exec(url.trim())?.[1]
  const args = [`--host=${parsed.host || '127.0.0.1'}`, `--port=${parsed.port ?? 3306}`]
  if (parsed.user) args.push(`--user=${parsed.user}`)
  return { args, env: password ? { MYSQL_PWD: safeDecode(password) } : {}, database: parsed.database }
}

/** The same server and credentials, another database: `…/app` → `…/postgres`. */
export function withDatabaseName(url: string, database: string): string {
  const { base, params } = splitUrlQuery(url.trim())
  const match = /^([a-z][a-z0-9+.-]*:\/\/[^/]*)(?:\/.*)?$/i.exec(base)
  return match ? joinUrlQuery(`${match[1]}/${encodeURIComponent(database)}`, params) : url
}
