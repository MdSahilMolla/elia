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
  if (engine === 'sqlite') {
    const path = raw.replace(/^[a-z+]+:(?:\/\/)?/i, '')
    return { engine, host: '', database: path, local: true }
  }
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
