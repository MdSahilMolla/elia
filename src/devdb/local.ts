/**
 * A project-local PostgreSQL that elia owns.
 *
 * When a project needs a database and none is running, elia starts its own:
 * a cluster under `.elia/devdb/pg/`, bound to 127.0.0.1 on a free port, with
 * trust auth for the local `elia` role. It never touches a system-wide server,
 * never listens beyond loopback, and never binds a unix socket — on macOS a
 * socket path over 103 bytes is fatal to postgres, and project paths nested a
 * few folders deep cross that easily.
 *
 * Because elia created this database, it is scratch space: the governance for
 * the `database` tool treats it as local and disposable. Destructive SQL is
 * still dumped to `.elia/devdb/backups/` first, so even a dropped table here
 * is one `psql -f` away from coming back.
 *
 * No Docker required. When the postgres binaries are missing the tool says so
 * and names the install command; installing software is the operator's call.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createServer, Socket } from 'node:net'
import { basename, join } from 'node:path'
import { parseDatabaseUrl } from './url.ts'

export interface LocalDbState {
  engine: 'postgres'
  port: number
  host: '127.0.0.1'
  user: string
  database: string
  dataDir: string
  binDir: string
  version: string
  url: string
  startedAt: string
}

export interface LocalDbOutcome {
  ok: boolean
  state?: LocalDbState
  message: string
}

const DEVDB_USER = 'elia'

export function devdbDir(root: string): string {
  return join(root, '.elia', 'devdb')
}

function statePath(root: string): string {
  return join(devdbDir(root), 'state.json')
}

export function readLocalDbState(root: string): LocalDbState | undefined {
  try {
    const parsed = JSON.parse(readFileSync(statePath(root), 'utf8')) as LocalDbState
    return parsed && typeof parsed.port === 'number' && typeof parsed.url === 'string' ? parsed : undefined
  } catch {
    return undefined
  }
}

function writeLocalDbState(root: string, state: LocalDbState): void {
  mkdirSync(devdbDir(root), { recursive: true })
  // The cluster, its logs and its backups are machine-local; keep every file
  // under here out of the project's git history without editing its .gitignore.
  const ignore = join(devdbDir(root), '.gitignore')
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n')
  writeFileSync(statePath(root), `${JSON.stringify(state, null, 2)}\n`)
}

/** A database name derived from the project folder: `my-app` → `my_app_dev`. */
export function devDatabaseName(root: string): string {
  const base = basename(root).toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40)
  return `${/^[a-z_]/.test(base) ? base : `db_${base}`}_dev`.replace(/^_dev$/, 'app_dev')
}

/** Directories postgres binaries commonly live in, beyond PATH. */
function candidateBinDirs(): string[] {
  const dirs = ['/opt/homebrew/bin', '/usr/local/bin', '/Applications/Postgres.app/Contents/Versions/latest/bin']
  for (const parent of ['/opt/homebrew/opt', '/usr/local/opt']) {
    try {
      for (const entry of readdirSync(parent)) if (/^postgresql(@\d+)?$/.test(entry)) dirs.push(join(parent, entry, 'bin'))
    } catch {
      // not a Homebrew machine
    }
  }
  try {
    const versions = readdirSync('/usr/lib/postgresql').sort((a, b) => Number(b) - Number(a))
    for (const version of versions) dirs.push(join('/usr/lib/postgresql', version, 'bin'))
  } catch {
    // not Debian/Ubuntu
  }
  return dirs
}

export interface PostgresBinaries {
  binDir: string
  initdb: string
  pgCtl: string
  pgDump?: string
  pgRestore?: string
  psql?: string
}

export function findPostgresBinaries(which: (name: string) => string | null = (name) => Bun.which(name)): PostgresBinaries | undefined {
  const exe = process.platform === 'win32' ? '.exe' : ''
  const onPath = which('initdb')
  const pgCtlOnPath = which('pg_ctl')
  if (onPath && pgCtlOnPath) {
    const binDir = onPath.slice(0, onPath.length - `initdb${exe}`.length - 1)
    return { binDir, initdb: onPath, pgCtl: pgCtlOnPath, pgDump: which('pg_dump') ?? undefined, pgRestore: which('pg_restore') ?? undefined, psql: which('psql') ?? undefined }
  }
  for (const dir of candidateBinDirs()) {
    const initdb = join(dir, `initdb${exe}`)
    const pgCtl = join(dir, `pg_ctl${exe}`)
    if (existsSync(initdb) && existsSync(pgCtl)) {
      const optional = (name: string) => (existsSync(join(dir, `${name}${exe}`)) ? join(dir, `${name}${exe}`) : undefined)
      return { binDir: dir, initdb, pgCtl, pgDump: optional('pg_dump'), pgRestore: optional('pg_restore'), psql: optional('psql') }
    }
  }
  return undefined
}

export function installHint(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'darwin') return 'brew install postgresql@16'
  if (platform === 'win32') return 'winget install PostgreSQL.PostgreSQL'
  return 'sudo apt-get install postgresql (or your distribution\'s postgresql package)'
}

export function canConnect(host: string, port: number, timeoutMs = 1_500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket()
    const done = (ok: boolean) => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
    socket.connect(port, host)
  })
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => (port ? resolve(port) : reject(new Error('no free port'))))
    })
  })
}

/** Postgres refuses to start on macOS when the locale is unset ("postmaster became multithreaded"). */
function pgEnv(): Record<string, string> {
  return { ...(process.env as Record<string, string>), LC_ALL: 'C', LANG: 'C' }
}

async function spawnChecked(argv: string[], timeoutMs: number): Promise<{ ok: boolean; output: string }> {
  try {
    const proc = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe', env: pgEnv(), timeout: timeoutMs, killSignal: 'SIGKILL' })
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    const code = await proc.exited
    return { ok: code === 0 && !proc.signalCode, output: `${stdout}${stderr}`.trim() }
  } catch (error) {
    return { ok: false, output: error instanceof Error ? error.message : String(error) }
  }
}

function tail(path: string, lines = 12): string {
  try {
    return readFileSync(path, 'utf8').trim().split(/\r?\n/).slice(-lines).join('\n')
  } catch {
    return ''
  }
}

export async function localDbStatus(root: string): Promise<{ state?: LocalDbState; running: boolean }> {
  const state = readLocalDbState(root)
  if (!state) return { running: false }
  return { state, running: await canConnect(state.host, state.port) }
}

/**
 * Starts (initialising on first use) the project's own postgres and makes sure
 * `database` exists in it. Idempotent: a cluster that is already up is reused.
 */
export async function startLocalPostgres(root: string, options: { database?: string; binaries?: PostgresBinaries } = {}): Promise<LocalDbOutcome> {
  const database = (options.database ?? devDatabaseName(root)).replace(/[^A-Za-z0-9_]/g, '_')
  const existing = readLocalDbState(root)
  if (existing && (await canConnect(existing.host, existing.port))) {
    const url = `postgres://${existing.user}@127.0.0.1:${existing.port}/${database}`
    const created = await ensureDatabase(existing.port, existing.user, database)
    if (!created.ok) return { ok: false, state: existing, message: created.message }
    const state = { ...existing, database, url }
    writeLocalDbState(root, state)
    return { ok: true, state, message: `elia's local postgres is already running on 127.0.0.1:${existing.port}; database "${database}" is ready.` }
  }

  const binaries = options.binaries ?? findPostgresBinaries()
  if (!binaries) {
    return { ok: false, message: `PostgreSQL is not installed on this machine (no initdb/pg_ctl found on PATH or in the usual install folders). Install it with \`${installHint()}\` and try again.` }
  }

  const dataDir = join(devdbDir(root), 'pg', 'data')
  const logFile = join(devdbDir(root), 'pg', 'server.log')
  mkdirSync(join(devdbDir(root), 'pg'), { recursive: true })
  if (!existsSync(join(devdbDir(root), '.gitignore'))) writeFileSync(join(devdbDir(root), '.gitignore'), '*\n')

  if (!existsSync(join(dataDir, 'PG_VERSION'))) {
    const init = await spawnChecked([binaries.initdb, '-D', dataDir, '-U', DEVDB_USER, '--auth=trust', '-E', 'UTF8', '--locale=C', '--no-instructions'], 120_000)
    if (!init.ok) return { ok: false, message: `initdb failed:\n${init.output.slice(-1_500)}` }
  }
  const version = (() => {
    try {
      return readFileSync(join(dataDir, 'PG_VERSION'), 'utf8').trim()
    } catch {
      return 'unknown'
    }
  })()

  const port = existing?.port && !(await canConnect('127.0.0.1', existing.port)) ? existing.port : await freePort()
  const started = await spawnChecked(
    [binaries.pgCtl, '-D', dataDir, '-l', logFile, '-o', `-p ${port} -h 127.0.0.1 -k ''`, '-w', '-t', '30', 'start'],
    60_000,
  )
  if (!started.ok || !(await canConnect('127.0.0.1', port))) {
    return { ok: false, message: `postgres did not start on 127.0.0.1:${port}.\n${started.output.slice(-800)}\nserver log:\n${tail(logFile)}` }
  }
  const created = await ensureDatabase(port, DEVDB_USER, database)
  if (!created.ok) return { ok: false, message: created.message }

  const state: LocalDbState = {
    engine: 'postgres',
    port,
    host: '127.0.0.1',
    user: DEVDB_USER,
    database,
    dataDir,
    binDir: binaries.binDir,
    version,
    url: `postgres://${DEVDB_USER}@127.0.0.1:${port}/${database}`,
    startedAt: new Date().toISOString(),
  }
  writeLocalDbState(root, state)
  return { ok: true, state, message: `Started elia's local postgres ${version} on 127.0.0.1:${port}; database "${database}" is ready.` }
}

async function ensureDatabase(port: number, user: string, database: string): Promise<{ ok: boolean; message: string }> {
  const { runSql } = await import('./sql.ts')
  const admin = `postgres://${user}@127.0.0.1:${port}/postgres`
  const exists = await runSql(admin, `SELECT 1 AS present FROM pg_database WHERE datname = '${database.replace(/'/g, "''")}'`)
  if (!exists.ok) return { ok: false, message: `could not reach the local postgres: ${exists.error}` }
  if ((exists.statements[0]?.rows.length ?? 0) > 0) return { ok: true, message: 'exists' }
  const create = await runSql(admin, `CREATE DATABASE "${database.replace(/"/g, '""')}"`)
  return create.ok ? { ok: true, message: 'created' } : { ok: false, message: `CREATE DATABASE failed: ${create.error}` }
}

export async function stopLocalPostgres(root: string): Promise<LocalDbOutcome> {
  const state = readLocalDbState(root)
  if (!state) return { ok: true, message: 'elia has no local postgres for this project.' }
  if (!(await canConnect(state.host, state.port))) return { ok: true, state, message: 'elia\'s local postgres is already stopped.' }
  const pgCtl = join(state.binDir, process.platform === 'win32' ? 'pg_ctl.exe' : 'pg_ctl')
  const stopped = await spawnChecked([pgCtl, '-D', state.dataDir, '-m', 'fast', '-w', '-t', '30', 'stop'], 60_000)
  return stopped.ok
    ? { ok: true, state, message: `Stopped elia's local postgres on 127.0.0.1:${state.port}. Its data stays in .elia/devdb/pg/ for next time.` }
    : { ok: false, state, message: `pg_ctl stop failed: ${stopped.output.slice(-800)}` }
}

/** True when `url` points at the cluster elia started for this project. */
export function isEliaDevDatabase(root: string, url: string): boolean {
  const state = readLocalDbState(root)
  const parsed = parseDatabaseUrl(url)
  return Boolean(state && parsed?.local && parsed.port === state.port)
}
