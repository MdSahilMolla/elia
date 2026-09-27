import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describeDatabaseUrl, isLocalDatabaseUrl, parseDatabaseUrl, redactDatabaseUrl } from './url.ts'
import { classifySql, splitSqlStatements, stripSqlNoise, formatRows } from './sql.ts'
import { composeDatabaseServices, detectDatabase, parseEnvFile, primaryTarget } from './detect.ts'
import { assessDatabaseRequest, resolveDatabaseTarget } from './policy.ts'
import { devDatabaseName, findPostgresBinaries, startLocalPostgres, stopLocalPostgres, readLocalDbState } from './local.ts'
import { assessAction } from '../autonomy/governor.ts'
import { capabilityContractFor } from '../autonomy/capabilityContract.ts'
import { withAgentIdentity } from '../autonomy/context.ts'
import { databaseTool } from '../tools/database.ts'
import { toolsForRole } from '../autonomy/roles.ts'

describe('database urls', () => {
  test('loopback hosts and sockets are local; everything else is remote', () => {
    expect(isLocalDatabaseUrl('postgres://u:p@localhost:5432/app')).toBe(true)
    expect(isLocalDatabaseUrl('postgresql://127.0.0.1/app')).toBe(true)
    expect(isLocalDatabaseUrl('postgres://u@[::1]:5433/app')).toBe(true)
    expect(isLocalDatabaseUrl('postgres://u@/app?host=/var/run/postgresql')).toBe(true)
    expect(isLocalDatabaseUrl('sqlite://./dev.db')).toBe(true)
    expect(isLocalDatabaseUrl('postgres://u:p@db.abc.supabase.co:5432/postgres')).toBe(false)
    expect(isLocalDatabaseUrl('postgres://u:p@10.0.0.4:5432/app')).toBe(false)
    expect(isLocalDatabaseUrl('mysql://root@db:3306/app')).toBe(false)
    expect(isLocalDatabaseUrl('not a url')).toBe(false)
  })

  test('parses the parts a model needs and never the password', () => {
    const parsed = parseDatabaseUrl('postgres://admin:s3cret@localhost:6543/shop')
    expect(parsed).toMatchObject({ engine: 'postgres', host: 'localhost', port: 6543, database: 'shop', user: 'admin', local: true })
    expect(redactDatabaseUrl('postgres://admin:s3cret@localhost:6543/shop')).toBe('postgres://admin:***@localhost:6543/shop')
    expect(redactDatabaseUrl('postgres://h/db?user=a&password=zz')).toBe('postgres://h/db?user=a&password=***')
    expect(describeDatabaseUrl('postgres://admin:s3cret@db.example.com/shop')).toBe('postgres @ db.example.com/shop (remote)')
    expect(describeDatabaseUrl('postgres://admin:s3cret@db.example.com/shop')).not.toContain('s3cret')
  })
})

describe('sql classification', () => {
  const cases: Array<[string, ReturnType<typeof classifySql>]> = [
    ['SELECT * FROM users', 'read'],
    ['  select 1; select 2 ', 'read'],
    ["SELECT 'DROP TABLE users' AS s", 'read'],
    ['-- DELETE FROM users\nSELECT 1', 'read'],
    ['EXPLAIN SELECT * FROM t', 'read'],
    ['EXPLAIN ANALYZE DELETE FROM t', 'destructive'],
    ['WITH x AS (SELECT 1) SELECT * FROM x', 'read'],
    ['WITH gone AS (DELETE FROM t WHERE id = 1 RETURNING *) SELECT * FROM gone', 'write'],
    ["INSERT INTO t VALUES (1, 'a')", 'write'],
    ['UPDATE t SET a = 1 WHERE id = 2', 'write'],
    ['UPDATE t SET a = 1', 'destructive'],
    ['DELETE FROM t', 'destructive'],
    ['DELETE FROM t WHERE id = 3', 'write'],
    ['CREATE TABLE t (id int)', 'schema'],
    ['ALTER TABLE t ADD COLUMN b text', 'schema'],
    ['ALTER TABLE t DROP COLUMN b', 'destructive'],
    ['DROP TABLE t', 'destructive'],
    ['TRUNCATE t', 'destructive'],
    ['CREATE TABLE a (id int); DROP TABLE b', 'destructive'],
    ["DO $$ BEGIN EXECUTE 'DROP TABLE t'; END $$", 'destructive'],
    ['SELECT * INTO backup_t FROM t', 'schema'],
    ['VACUUM', 'write'],
    ['frobnicate the table', 'destructive'],
    ['', 'read'],
  ]
  for (const [sql, expected] of cases) {
    test(`${JSON.stringify(sql)} → ${expected}`, () => expect(classifySql(sql)).toBe(expected))
  }

  test('quoted text and dollar-quoted bodies never leak keywords into the verdict', () => {
    expect(stripSqlNoise("select 'a;b' , $f$ drop table x $f$")).not.toContain('drop')
    expect(splitSqlStatements("select 'a;b'; select 2")).toHaveLength(2)
  })

  test('formats rows as a bounded pipe table', () => {
    expect(formatRows([])).toBe('(0 rows)')
    const out = formatRows([{ id: 1, name: null }, { id: 2, name: 'x'.repeat(500) }])
    expect(out.split('\n')[0]).toBe('id | name')
    expect(out).toContain('NULL')
    expect(out).toContain('…')
    expect(out).toContain('(2 rows)')
  })
})

describe('project detection', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'devdb-detect-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test('reads env files, prisma, compose and migration folders', () => {
    writeFileSync(join(dir, '.env'), 'export DATABASE_URL="postgres://app:pw@localhost:5432/app_dev"\nOTHER=1\n')
    writeFileSync(join(dir, '.env.example'), 'DATABASE_URL=postgres://user:password@localhost:5432/example\n')
    mkdirSync(join(dir, 'prisma', 'migrations', '001_init'), { recursive: true })
    writeFileSync(join(dir, 'prisma', 'schema.prisma'), 'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\n')
    writeFileSync(join(dir, 'prisma', 'migrations', '001_init', 'migration.sql'), 'CREATE TABLE a (id int);')
    writeFileSync(join(dir, 'bun.lock'), '')
    writeFileSync(join(dir, 'docker-compose.yml'), 'services:\n  db:\n    image: postgres:16\n  web:\n    image: node:22\n')
    const detection = detectDatabase(dir, {})
    expect(detection.targets.map((t) => [t.source, t.example])).toEqual([['.env: DATABASE_URL', false], ['.env.example: DATABASE_URL', true]])
    expect(primaryTarget(detection)?.url).toBe('postgres://app:pw@localhost:5432/app_dev')
    expect(detection.migrationTools[0]).toMatchObject({ name: 'prisma', command: 'bunx prisma migrate deploy' })
    expect(detection.composeServices).toEqual([{ file: 'docker-compose.yml', service: 'db', image: 'postgres:16', engine: 'postgres' }])
    expect(detection.migrationDirs).toContain('prisma/migrations')
    expect(detection.signals.join('\n')).not.toContain(':pw@')
    expect(detection.signals.join('\n')).toContain('prisma datasource provider: postgresql')
  })

  test('dotenv parsing strips quotes, export and trailing comments', () => {
    expect(parseEnvFile("A=1 # note\nexport B='x y'\n# C=3\nD=\"q#r\"")).toEqual({ A: '1', B: 'x y', D: 'q#r' })
  })

  test('compose parsing only reports database images under services', () => {
    const text = 'version: "3"\nservices:\n  cache:\n    image: redis:7\n  primary:\n    image: "bitnami/postgresql:15"\n  maria:\n    image: mariadb\nvolumes:\n  data:\n'
    expect(composeDatabaseServices('compose.yml', text).map((s) => s.service)).toEqual(['primary', 'maria'])
  })
})

describe('governance', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'devdb-policy-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test('local work runs unattended; destructive local work is flagged; anything remote is critical', () => {
    writeFileSync(join(dir, '.env'), 'DATABASE_URL=postgres://a:b@localhost:5432/app\n')
    expect(assessDatabaseRequest({ action: 'detect' }, dir, {}).risk).toBe('safe')
    expect(assessDatabaseRequest({ action: 'query', sql: 'select 1' }, dir, {})).toMatchObject({ risk: 'safe', intent: 'database.read' })
    expect(assessDatabaseRequest({ action: 'query', sql: 'insert into t values (1)' }, dir, {})).toMatchObject({ risk: 'review', intent: 'database.local-write' })
    expect(assessDatabaseRequest({ action: 'query', sql: 'drop table t' }, dir, {})).toMatchObject({ risk: 'review', intent: 'database.local-destructive' })
    expect(assessDatabaseRequest({ action: 'migrate' }, dir, {})).toMatchObject({ risk: 'review', intent: 'database.migrate' })
    expect(assessDatabaseRequest({ action: 'start' }, dir, {})).toMatchObject({ risk: 'review', intent: 'database.local-server' })
    const remote = assessDatabaseRequest({ action: 'query', sql: 'select 1', url: 'postgres://u:secret@prod.example.com/app' }, dir, {})
    expect(remote).toMatchObject({ risk: 'critical', intent: 'database.remote' })
    expect(remote.resources.join(' ')).not.toContain('secret')
    expect(assessDatabaseRequest({ action: 'nuke' }, dir, {}).risk).toBe('critical')
  })

  test('a project pointing at a remote database is governed as remote by default', () => {
    writeFileSync(join(dir, '.env'), 'DATABASE_URL=postgres://a:b@db.neon.tech/app\n')
    expect(resolveDatabaseTarget(dir, {}, {})?.local).toBe(false)
    expect(assessDatabaseRequest({ action: 'schema' }, dir, {}).risk).toBe('critical')
  })

  test('a sqlite file outside the project is not local', () => {
    expect(assessDatabaseRequest({ action: 'query', sql: 'delete from t', url: 'sqlite:///etc/some.db' }, dir, {}).risk).toBe('critical')
    expect(assessDatabaseRequest({ action: 'query', sql: 'delete from t where 1', url: 'sqlite://./dev.db' }, dir, {}).risk).toBe('review')
  })

  test('the governor and the capability catalog both know the tool', () => {
    expect(capabilityContractFor('database')?.risk).toBe('review')
    expect(assessAction({ name: 'database', input: { action: 'query', sql: 'select 1', url: 'postgres://x@remote.example.com/db' } }, dir).risk).toBe('critical')
    expect(assessAction({ name: 'database', input: { action: 'detect' } }, dir).decision).toBe('allow')
  })

  test('builders get the tool; read-only roles do not', () => {
    expect(toolsForRole('backend').some((tool) => tool.name === 'database')).toBe(true)
    expect(toolsForRole('scout').some((tool) => tool.name === 'database')).toBe(false)
  })
})

test('a project folder becomes a safe database name', () => {
  expect(devDatabaseName('/x/my-app')).toBe('my_app_dev')
  expect(devDatabaseName('/x/2048 Game')).toBe('db_2048_game_dev')
})

// A real cluster: initdb, start, create/insert/select, destructive-with-backup,
// stop. Skipped on machines without postgres installed.
const binaries = findPostgresBinaries()
describe.skipIf(!binaries)('elia-owned local postgres (integration)', () => {
  const root = mkdtempSync(join(tmpdir(), 'devdb-pg-'))
  afterAll(async () => {
    await stopLocalPostgres(root)
    rmSync(root, { recursive: true, force: true })
  })
  const run = (input: Record<string, unknown>) => withAgentIdentity({ name: 't', role: 'lead', cwd: root }, () => databaseTool.execute(input))

  test('start → write → read → destructive (backed up) → stop', async () => {
    const started = await run({ action: 'start' })
    expect(started).toContain('database "')
    const state = readLocalDbState(root)!
    expect(state.host).toBe('127.0.0.1')
    expect(existsSync(join(root, '.elia', 'devdb', '.gitignore'))).toBe(true)

    // A second start reuses the running cluster.
    expect(await run({ action: 'start' })).toContain('already running')

    const created = await run({ action: 'query', target: 'devdb', sql: "CREATE TABLE notes (id serial primary key, body text not null); INSERT INTO notes (body) VALUES ('a'), ('b');" })
    expect(created).toContain('classified: schema')
    expect(created).not.toContain('SQL failed')

    const read = await run({ action: 'query', target: 'devdb', sql: 'SELECT id, body FROM notes ORDER BY id' })
    expect(read).toContain('id | body')
    expect(read).toContain('(2 rows)')

    const schema = await run({ action: 'schema', target: 'devdb' })
    expect(schema).toContain('notes')
    expect(schema).toContain('body text not null')

    const failed = await run({ action: 'query', target: 'devdb', sql: 'SELECT * FROM missing_table' })
    expect(failed).toContain('SQL failed')
    expect(failed).toContain('42P01')

    const dropped = await run({ action: 'query', target: 'devdb', sql: 'DROP TABLE notes' })
    expect(dropped).toContain('classified: destructive')
    if (binaries?.pgDump) {
      expect(dropped).toContain('backup taken')
      expect(readdirSync(join(root, '.elia', 'devdb', 'backups')).length).toBe(1)
    }

    expect(await run({ action: 'stop' })).toContain('Stopped')
    // A query against a stopped devdb brings it back rather than failing.
    expect(await run({ action: 'query', target: 'devdb', sql: 'SELECT 1 AS one' })).toContain('(1 row)')
    await startLocalPostgres(root)
  }, 90_000)
})
