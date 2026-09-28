import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SQL } from 'bun'
import { withAgentIdentity } from '../autonomy/context.ts'
import { databaseTool } from '../tools/database.ts'
import { planHints } from './admin.ts'
import { parseQualifiedName } from './common.ts'
import { findPostgresBinaries, readLocalDbState, stopLocalPostgres } from './local.ts'
import { assessDatabaseRequest, resolveDatabaseTarget } from './policy.ts'
import { resolveSecretPlaceholders, scramSha256Verifier, scrubSecrets } from './secrets.ts'
import { cannotRunInTransaction, classifySql, isTransactionControl, splitSqlText } from './sql.ts'
import { columnName, inferColumnType } from './transfer.ts'
import { clientConnection, libpqConnection, resolveSqliteUrl, withDatabaseName } from './url.ts'

describe('splitting a batch into statements', () => {
  test('quotes, comments and dollar-quoted bodies do not end a statement', () => {
    expect(splitSqlText("select 'a;b'; select \"x;y\" from t; -- done; really\n")).toEqual(["select 'a;b'", 'select "x;y" from t'])
    expect(splitSqlText('CREATE FUNCTION f() RETURNS int AS $body$ BEGIN RETURN 1; END; $body$ LANGUAGE plpgsql; SELECT f()')).toHaveLength(2)
    expect(splitSqlText("SELECT E'it\\'s; fine'; SELECT 2")).toHaveLength(2)
    expect(splitSqlText("SELECT 'a\\'; b'; SELECT 2", 'mysql')).toHaveLength(2)
  })

  test('trigger and procedure bodies stay whole', () => {
    const sqlite = 'CREATE TRIGGER t AFTER INSERT ON a BEGIN UPDATE a SET n = CASE WHEN new.n > 0 THEN 1 ELSE 0 END; INSERT INTO log VALUES (1); END; SELECT 1'
    expect(splitSqlText(sqlite, 'sqlite')).toHaveLength(2)
    expect(splitSqlText(sqlite, 'sqlite')[0]).toEndWith('END')
    const mysql = 'CREATE PROCEDURE p() BEGIN IF 1 THEN SELECT 1; END IF; SELECT 2; END; CALL p()'
    expect(splitSqlText(mysql, 'mysql')).toEqual(['CREATE PROCEDURE p() BEGIN IF 1 THEN SELECT 1; END IF; SELECT 2; END', 'CALL p()'])
    expect(splitSqlText('CREATE FUNCTION f() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1; END; SELECT 2')).toHaveLength(2)
    expect(splitSqlText('BEGIN; UPDATE t SET a = 1; COMMIT')).toHaveLength(3)
  })

  test('transaction control and statements that cannot share a transaction are recognised', () => {
    expect(isTransactionControl('BEGIN')).toBe(true)
    expect(isTransactionControl('savepoint a')).toBe(true)
    expect(isTransactionControl('SELECT 1')).toBe(false)
    expect(cannotRunInTransaction('VACUUM t')).toBe(true)
    expect(cannotRunInTransaction('CREATE INDEX CONCURRENTLY i ON t (a)')).toBe(true)
    expect(cannotRunInTransaction('CREATE INDEX i ON t (a)')).toBe(false)
    expect(cannotRunInTransaction('PRAGMA journal_mode = WAL', 'sqlite')).toBe(true)
    expect(cannotRunInTransaction('ALTER TABLE t ADD c int', 'mysql')).toBe(true)
    expect(cannotRunInTransaction('INSERT INTO t VALUES (1)', 'mysql')).toBe(false)
  })

  test('a SELECT that changes state is not a read', () => {
    expect(classifySql("SELECT nextval('orders_id_seq')")).toBe('write')
    expect(classifySql('SELECT pg_cancel_backend(42)')).toBe('write')
    expect(classifySql('SELECT pg_terminate_backend(42)')).toBe('destructive')
    expect(classifySql('PREPARE p AS DELETE FROM t')).toBe('destructive')
    expect(classifySql('PREPARE p AS SELECT 1')).toBe('read')
    expect(classifySql('CHECK TABLE t', 'mysql')).toBe('read')
  })
})

describe('connection strings', () => {
  test('driver-only parameters never reach the server or libpq', () => {
    const prisma = 'postgresql://app:p%40ss@localhost:5432/shop?schema=public&connection_limit=5&sslmode=disable'
    const client = clientConnection(prisma)
    expect(client.url).toBe('postgres://app:p%40ss@localhost:5432/shop?sslmode=disable')
    expect(client.searchPath).toBe('public')
    expect(client.dropped).toEqual(['connection_limit'])
    const libpq = libpqConnection(prisma)
    expect(libpq.url).toBe('postgresql://app@localhost:5432/shop?sslmode=disable')
    expect(libpq.env.PGPASSWORD).toBe('p@ss')
    expect(clientConnection('postgres://h/db?ssl=true').url).toBe('postgres://h/db?sslmode=require')
    expect(withDatabaseName('postgres://u:p@h:5/app?sslmode=require', 'postgres')).toBe('postgres://u:p@h:5/postgres?sslmode=require')
  })

  test('sqlite paths follow the convention of whoever wrote them', () => {
    const root = mkdtempSync(join(tmpdir(), 'dba-sqlite-url-'))
    try {
      mkdirSync(join(root, 'prisma'))
      writeFileSync(join(root, 'prisma', 'schema.prisma'), 'datasource db { provider = "sqlite" }')
      expect(resolveSqliteUrl('file:./dev.db', root)).toBe(`sqlite://${join(root, 'prisma', 'dev.db')}`)
      writeFileSync(join(root, 'app.db'), '')
      expect(resolveSqliteUrl('sqlite:///app.db', root)).toBe(`sqlite://${join(root, 'app.db')}`)
      expect(resolveSqliteUrl('sqlite:./app.db?mode=rwc', root)).toBe(`sqlite://${join(root, 'app.db')}`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('table names parse with or without quotes', () => {
    expect(parseQualifiedName('users')).toEqual({ name: 'users' })
    expect(parseQualifiedName('"auth"."User"')).toEqual({ schema: 'auth', name: 'User' })
    expect(parseQualifiedName('"a.b"')).toEqual({ name: 'a.b' })
    expect(parseQualifiedName('a.b.c')).toBeUndefined()
    expect(parseQualifiedName('"open')).toBeUndefined()
  })
})

describe('passwords written as ${env:NAME}', () => {
  const lookup = (name: string) => ({ APP_DB_PASSWORD: "s3cret'pw", ODD: 'päss' } as Record<string, string>)[name]

  test('Postgres gets a SCRAM verifier, never the password', () => {
    const filled = resolveSecretPlaceholders('CREATE ROLE app LOGIN PASSWORD ${env:APP_DB_PASSWORD}', 'postgres', lookup)
    expect(filled.ok).toBe(true)
    if (!filled.ok) return
    expect(filled.sql).toStartWith("CREATE ROLE app LOGIN PASSWORD 'SCRAM-SHA-256$4096:")
    expect(filled.sql).not.toContain('s3cret')
    expect(filled.secrets).toEqual(["s3cret'pw"])
    // Non-ASCII passwords go in as a literal: SASLprep could change them.
    const odd = resolveSecretPlaceholders('ALTER ROLE app PASSWORD ${env:ODD}', 'postgres', lookup)
    expect(odd.ok && odd.sql).toBe("ALTER ROLE app PASSWORD 'päss'")
  })

  test('MySQL gets a quoted literal with its escapes', () => {
    const filled = resolveSecretPlaceholders("CREATE USER 'app'@'%' IDENTIFIED BY ${env:APP_DB_PASSWORD}", 'mysql', lookup)
    expect(filled.ok && filled.sql).toBe("CREATE USER 'app'@'%' IDENTIFIED BY 's3cret''pw'")
  })

  test('placeholders are refused where the value would come straight back out', () => {
    const select = resolveSecretPlaceholders('SELECT ${env:APP_DB_PASSWORD}', 'postgres', lookup)
    expect(select.ok).toBe(false)
    const quoted = resolveSecretPlaceholders("CREATE ROLE app PASSWORD '${env:APP_DB_PASSWORD}'", 'postgres', lookup)
    expect(!quoted.ok && quoted.error).toContain('without quotes')
    const own = resolveSecretPlaceholders('CREATE ROLE app PASSWORD ${env:ANTHROPIC_API_KEY}', 'postgres', () => 'sk-x')
    expect(!own.ok && own.error).toContain("elia's own credentials")
    const missing = resolveSecretPlaceholders('CREATE ROLE app PASSWORD ${env:NOPE}', 'postgres', lookup)
    expect(!missing.ok && missing.error).toContain('not set')
    expect(resolveSecretPlaceholders('SELECT 1', 'postgres', lookup)).toEqual({ ok: true, sql: 'SELECT 1', secrets: [] })
  })

  test('output is scrubbed of every filled-in value', () => {
    expect(scrubSecrets("error near 's3cret''pw' and s3cret'pw", ["s3cret'pw"])).toBe("error near '***' and ***")
  })
})

describe('governance of the DBA actions', () => {
  let dir: string
  const env = { STAGING_DB: 'postgres://ops:pw@staging.example.com/app' }
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'dba-policy-'))
    writeFileSync(join(dir, '.env'), 'DATABASE_URL=postgres://a:b@localhost:5432/app\n')
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const assess = (input: Record<string, unknown>) => assessDatabaseRequest(input, dir, env)

  test('looking at a local database runs freely; changing it is reviewed', () => {
    for (const action of ['overview', 'describe', 'roles', 'health', 'schema', 'status']) expect(assess({ action, table: 't' })).toMatchObject({ risk: 'safe', intent: 'database.inspect' })
    expect(assess({ action: 'settings' }).risk).toBe('safe')
    expect(assess({ action: 'settings', name: 'work_mem', value: '64MB' })).toMatchObject({ risk: 'review', intent: 'database.local-write' })
    expect(assess({ action: 'activity' })).toMatchObject({ risk: 'safe', intent: 'database.read' })
    expect(assess({ action: 'explain', sql: 'SELECT 1' })).toMatchObject({ risk: 'safe', intent: 'database.inspect' })
    expect(assess({ action: 'explain', sql: 'DELETE FROM t WHERE id = 1', analyze: true })).toMatchObject({ risk: 'safe', intent: 'database.dry-run' })
    expect(assess({ action: 'query', sql: 'UPDATE t SET a = 1', dry_run: true })).toMatchObject({ risk: 'safe', intent: 'database.dry-run' })
    expect(assess({ action: 'backup' })).toMatchObject({ risk: 'safe', intent: 'database.backup' })
    expect(assess({ action: 'export', sql: 'SELECT * FROM t', file: 'out.csv' })).toMatchObject({ risk: 'safe', intent: 'database.read' })
    expect(assess({ action: 'maintain', operation: 'vacuum' })).toMatchObject({ risk: 'review', intent: 'database.maintain' })
    expect(assess({ action: 'maintain', operation: 'check' }).risk).toBe('safe')
    expect(assess({ action: 'terminate', pid: 5 })).toMatchObject({ risk: 'review', intent: 'database.local-session' })
    expect(assess({ action: 'import', file: 'in.csv', table: 't' })).toMatchObject({ risk: 'review', intent: 'database.local-write' })
    expect(assess({ action: 'create_database', database: 'x' })).toMatchObject({ risk: 'review', intent: 'database.local-write' })
    expect(assess({ action: 'restore' })).toMatchObject({ risk: 'safe', intent: 'database.inspect' })
  })

  test('destroying data is reviewed with a backup; waiving the backup asks a person', () => {
    for (const input of [{ action: 'drop_database', database: 'x' }, { action: 'restore', file: 'b.dump' }, { action: 'import', file: 'in.csv', table: 't', truncate: true }, { action: 'migrate', operation: 'rollback' }, { action: 'terminate', pid: 5, mode: 'terminate' }]) {
      expect(assess(input)).toMatchObject({ risk: 'review', intent: 'database.local-destructive' })
    }
    expect(assess({ action: 'query', sql: 'DROP TABLE t', no_backup: true })).toMatchObject({ risk: 'critical', intent: 'database.local-unbacked' })
    expect(assess({ action: 'drop_database', database: 'x', no_backup: true }).risk).toBe('critical')
  })

  test('a remote database is critical for every action, split by what the action does', () => {
    const remote = (input: Record<string, unknown>) => assess({ ...input, target: 'STAGING_DB' })
    expect(resolveDatabaseTarget(dir, { target: 'STAGING_DB' }, env)).toMatchObject({ source: 'process env: STAGING_DB', local: false })
    expect(remote({ action: 'overview' })).toMatchObject({ risk: 'critical', intent: 'database.remote.inspect' })
    expect(remote({ action: 'query', sql: 'SELECT 1' })).toMatchObject({ risk: 'critical', intent: 'database.remote.read' })
    expect(remote({ action: 'backup' }).intent).toBe('database.remote.read')
    expect(remote({ action: 'query', sql: 'UPDATE t SET a = 1 WHERE id = 2', dry_run: true }).intent).toBe('database.remote.write')
    expect(remote({ action: 'maintain', operation: 'vacuum' }).intent).toBe('database.remote.write')
    expect(remote({ action: 'drop_database', database: 'app' }).intent).toBe('database.remote.destructive')
    expect(remote({ action: 'overview' }).resources.join(' ')).not.toContain(':pw@')
  })

  test('files stay in the workspace and off secret files', () => {
    expect(assess({ action: 'export', sql: 'SELECT 1', file: '../outside.csv' })).toMatchObject({ risk: 'critical', intent: 'database.export.outside-workspace' })
    expect(assess({ action: 'import', file: '.env', table: 't' })).toMatchObject({ risk: 'critical', intent: 'database.import.sensitive-file' })
    expect(assess({ action: 'backup', file: '.elia/allow.json' }).risk).toBe('critical')
    expect(assess({ action: 'restore', file: 'app-2026.dump' }).intent).toBe('database.local-destructive')
  })
})

describe('small helpers', () => {
  test('column types are inferred from the data', () => {
    expect(inferColumnType(['1', '2', null], 'postgres')).toBe('bigint')
    expect(inferColumnType(['1.5', '2'], 'postgres')).toBe('numeric')
    expect(inferColumnType(['true', 'FALSE'], 'postgres')).toBe('boolean')
    expect(inferColumnType(['2026-01-02'], 'postgres')).toBe('date')
    expect(inferColumnType(['2026-01-02T10:00:00Z'], 'mysql')).toBe('datetime')
    expect(inferColumnType([{ a: 1 }], 'postgres')).toBe('jsonb')
    expect(inferColumnType(['x', '1'], 'sqlite')).toBe('TEXT')
    expect(columnName('First Name')).toBe('first_name')
    expect(columnName('2nd')).toBe('c_2nd')
  })

  test('plan hints point at the usual suspects', () => {
    const hints = planHints([
      'Seq Scan on orders  (cost=0.00..1834.00 rows=50000 width=16) (actual time=0.01..9.1 rows=50000 loops=1)',
      'Index Scan using x on y  (cost=0.29..8.30 rows=1 width=8) (actual time=0.01..3.1 rows=4000 loops=1)',
      '  Sort Method: external merge  Disk: 4096kB',
    ])
    expect(hints.some((hint) => hint.includes('Seq Scan on orders'))).toBe(true)
    expect(hints.some((hint) => hint.includes('statistics are off'))).toBe(true)
    expect(hints.some((hint) => hint.includes('work_mem'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Against real databases
// ---------------------------------------------------------------------------

function runner(root: string) {
  return (input: Record<string, unknown>) => withAgentIdentity({ name: 't', role: 'lead', cwd: root }, () => databaseTool.execute(input))
}

describe('SQLite, end to end', () => {
  const root = mkdtempSync(join(tmpdir(), 'dba-sqlite-'))
  writeFileSync(join(root, '.env'), 'DATABASE_URL=sqlite:./app.db\n')
  const run = runner(root)
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  test('a batch runs every statement, and a failing batch keeps nothing', async () => {
    const created = await run({ action: 'query', sql: "CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT NOT NULL); CREATE TABLE books (id INTEGER PRIMARY KEY, author_id INTEGER REFERENCES authors(id), title TEXT); INSERT INTO authors (name) VALUES ('Le Guin'), ('Borges'); INSERT INTO books (author_id, title) VALUES (1, 'Earthsea'), (2, 'Ficciones');" })
    expect(created).toContain('4 statements ran as one transaction')
    expect(await run({ action: 'query', sql: 'SELECT count(*) AS n FROM books' })).toContain('2')
    const failed = await run({ action: 'query', sql: "INSERT INTO authors (name) VALUES ('Calvino'); INSERT INTO nowhere VALUES (1)" })
    expect(failed).toContain('statement 2 of 2 failed')
    expect(failed).toContain('nothing was committed')
    expect(await run({ action: 'query', sql: "SELECT count(*) AS n FROM authors WHERE name = 'Calvino'" })).toMatch(/n\n---\n0/)
    // Foreign keys are enforced on elia's connections.
    expect(await run({ action: 'query', sql: "INSERT INTO books (author_id, title) VALUES (99, 'Orphan')" })).toContain('FOREIGN KEY constraint failed')
  })

  test('a trigger with a body is created whole', async () => {
    const out = await run({ action: 'query', sql: "CREATE TABLE log (msg TEXT); CREATE TRIGGER book_added AFTER INSERT ON books BEGIN INSERT INTO log VALUES ('added ' || new.title); END; INSERT INTO books (author_id, title) VALUES (1, 'Lathe')" })
    expect(out).not.toContain('failed')
    expect(await run({ action: 'query', sql: 'SELECT msg FROM log' })).toContain('added Lathe')
  })

  test('dry run shows the effect and keeps nothing', async () => {
    const out = await run({ action: 'query', sql: "UPDATE books SET title = 'X'", dry_run: true })
    expect(out).toContain('3 row(s) affected')
    expect(out).toContain('nothing was changed')
    expect(await run({ action: 'query', sql: "SELECT count(*) AS n FROM books WHERE title = 'X'" })).toMatch(/n\n---\n0/)
  })

  test('overview, describe, health, explain', async () => {
    const overview = await run({ action: 'overview' })
    expect(overview).toContain('## Tables')
    expect(overview).toContain('books')
    const described = await run({ action: 'describe', table: 'authors' })
    expect(described).toContain('## Columns')
    expect(described).toContain('## Referenced by')
    const health = await run({ action: 'health' })
    expect(health).toContain('foreign key(s) have no index')
    expect(health).toContain('integrity ok')
    const plan = await run({ action: 'explain', sql: "SELECT * FROM books WHERE title = 'Earthsea'" })
    expect(plan).toContain('SCAN books')
    expect(plan).toContain('Full scan of books')
  })

  test('maintenance, settings and activity', async () => {
    expect(await run({ action: 'maintain', operation: 'check' })).toContain('integrity_check')
    expect(await run({ action: 'maintain', operation: 'vacuum_analyze' })).toContain('file size:')
    expect(await run({ action: 'settings', name: 'journal_mode', value: 'WAL' })).toContain('is now: wal')
    expect(await run({ action: 'settings', name: 'foreign_keys', value: 'ON' })).toContain('belongs to the connection')
    expect(await run({ action: 'activity' })).toContain('no server')
  })

  test('backup, destroy, restore', async () => {
    const backedUp = await run({ action: 'backup' })
    expect(backedUp).toContain('backup written')
    const dropped = await run({ action: 'query', sql: 'DROP TABLE log' })
    expect(dropped).toContain('backup taken before this destructive statement')
    const snapshot = /restore file=(\S+)/.exec(dropped)?.[1]
    expect(snapshot).toBeDefined()
    expect(await run({ action: 'restore' })).toContain(snapshot!)
    const restored = await run({ action: 'restore', file: snapshot })
    expect(restored).toContain('restored')
    expect(await run({ action: 'query', sql: 'SELECT count(*) AS n FROM log' })).not.toContain('failed')
  })

  test('export and import', async () => {
    const exported = await run({ action: 'export', sql: 'SELECT id, title FROM books ORDER BY id', file: 'books.csv' })
    expect(exported).toContain('exported 3 row(s)')
    expect(readFileSync(join(root, 'books.csv'), 'utf8').split('\n')[0]).toBe('id,title')
    expect(await run({ action: 'export', sql: 'SELECT 1', file: 'books.csv' })).toContain('already exists')
    writeFileSync(join(root, 'people.csv'), 'Full Name,Age,Joined\n"Ada, Countess",36,2026-01-02\nAlan,41,\n')
    const imported = await run({ action: 'import', file: 'people.csv', table: 'people', create: true })
    expect(imported).toContain('created')
    expect(imported).toContain('imported 2 row(s)')
    expect(await run({ action: 'query', sql: 'SELECT full_name, age, joined FROM people ORDER BY age' })).toContain('Ada, Countess | 36 | 2026-01-02')
    writeFileSync(join(root, 'more.json'), JSON.stringify([{ full_name: 'Grace', age: 85 }]))
    const again = await run({ action: 'import', file: 'more.json', table: 'people', truncate: true })
    expect(again).toContain('the table now holds 1 row(s)')
    expect(await run({ action: 'import', file: 'more.json', table: 'nope' })).toContain('create: true')
  })

  test('create a copy, drop it', async () => {
    const copy = await run({ action: 'create_database', database: 'copy.db', from: 'x' })
    expect(copy).toContain('as a copy of')
    const dropped = await run({ action: 'drop_database', url: `sqlite://${join(root, 'copy.db')}` })
    expect(dropped).toContain('deleted')
    expect(existsSync(join(root, 'copy.db'))).toBe(false)
  })
})

const binaries = findPostgresBinaries()
describe.skipIf(!binaries?.pgDump || !binaries.pgRestore || !binaries.psql)('PostgreSQL, end to end', () => {
  const root = mkdtempSync(join(tmpdir(), 'dba-pg-'))
  const run = runner(root)
  beforeAll(async () => {
    expect(await run({ action: 'start' })).toContain('database "')
    const schema = await run({
      action: 'query',
      target: 'devdb',
      sql: `CREATE TABLE customers (id serial PRIMARY KEY, email text NOT NULL UNIQUE);
        CREATE TABLE orders (id serial PRIMARY KEY, customer_id int NOT NULL REFERENCES customers(id), total numeric NOT NULL, placed_at timestamptz DEFAULT now());
        CREATE TABLE audit (at timestamptz, note text);
        CREATE INDEX orders_total_a ON orders (total);
        CREATE INDEX orders_total_b ON orders (total);
        INSERT INTO customers (email) SELECT 'c' || g || '@example.com' FROM generate_series(1, 50) g;
        INSERT INTO orders (customer_id, total) SELECT 1 + (g % 50), g FROM generate_series(1, 2000) g;`,
    })
    expect(schema).toContain('statements ran as one transaction')
  }, 120_000)
  afterAll(async () => {
    await stopLocalPostgres(root)
    rmSync(root, { recursive: true, force: true })
  })

  test('a failing batch commits nothing; dry run keeps nothing', async () => {
    const failed = await run({ action: 'query', target: 'devdb', sql: "INSERT INTO customers (email) VALUES ('new@example.com'); SELECT * FROM missing" })
    expect(failed).toContain('nothing was committed')
    expect(await run({ action: 'query', target: 'devdb', sql: "SELECT count(*) AS n FROM customers WHERE email = 'new@example.com'" })).toMatch(/n\n---\n0/)
    const dry = await run({ action: 'query', target: 'devdb', sql: 'DELETE FROM orders WHERE total > 1000', dry_run: true })
    expect(dry).toContain('1000 row(s) affected')
    expect(await run({ action: 'query', target: 'devdb', sql: 'SELECT count(*) AS n FROM orders' })).toContain('2000')
    expect(await run({ action: 'query', target: 'devdb', sql: 'VACUUM orders', dry_run: true })).toContain('dry_run refused')
  })

  test('overview, describe, roles, settings', async () => {
    const overview = await run({ action: 'overview', target: 'devdb' })
    for (const heading of ['## Server', '## Databases', '## Largest tables', '## Extensions']) expect(overview).toContain(heading)
    const described = await run({ action: 'describe', target: 'devdb', table: 'ORDERS' })
    expect(described).toContain('# table public.orders')
    expect(described).toContain('foreign key')
    expect(described).toContain('orders_total_a')
    expect(await run({ action: 'describe', target: 'devdb', table: 'customers' })).toContain('## Referenced by')
    expect(await run({ action: 'roles', target: 'devdb' })).toContain('superuser')
    expect(await run({ action: 'roles', target: 'devdb', role: 'elia' })).toContain('Table privileges of elia')
    expect(await run({ action: 'settings', target: 'devdb', name: 'work_mem' })).toContain('work_mem')
    const changed = await run({ action: 'settings', target: 'devdb', name: 'work_mem', value: '8MB' })
    expect(changed).toContain('ALTER SYSTEM SET')
    expect(changed).toContain('8MB')
    expect(await run({ action: 'settings', target: 'devdb', name: 'work_mem', value: 'default' })).toContain('ALTER SYSTEM RESET')
  })

  test('health finds the planted problems', async () => {
    const health = await run({ action: 'health', target: 'devdb' })
    expect(health).toContain('foreign key(s) have no index')
    expect(health).toContain('orders(customer_id)')
    expect(health).toContain('no primary key: public.audit')
    expect(health).toContain('identical indexes')
    expect(health).toContain('fix:')
  })

  test('explain, with analyze rolled back for a write', async () => {
    const plan = await run({ action: 'explain', target: 'devdb', sql: 'SELECT * FROM orders WHERE customer_id = 3' })
    expect(plan).toContain('Seq Scan on orders')
    const analyzed = await run({ action: 'explain', target: 'devdb', sql: 'UPDATE orders SET total = 0', analyze: true })
    expect(analyzed).toContain('actual time')
    expect(analyzed).toContain('rolled back')
    expect(await run({ action: 'query', target: 'devdb', sql: 'SELECT count(*) AS n FROM orders WHERE total = 0' })).toMatch(/n\n---\n0/)
  })

  test('maintenance and ending a session', async () => {
    expect(await run({ action: 'maintain', target: 'devdb', operation: 'vacuum_analyze', table: 'orders' })).toContain('VACUUM (ANALYZE) "orders"')
    expect(await run({ action: 'maintain', target: 'devdb', operation: 'reindex', table: 'orders' })).toContain('REINDEX TABLE')
    expect(await run({ action: 'maintain', target: 'devdb', operation: 'check' })).toContain('amcheck')
    const url = readLocalDbState(root)!.url
    const other = new SQL(url, { max: 1 })
    const sleeping = other.unsafe("SELECT pg_sleep(30) AS slept /* sleeper */").catch((error: Error) => error)
    await new Promise((resolve) => setTimeout(resolve, 400))
    const sessions = await run({ action: 'activity', target: 'devdb' })
    expect(sessions).toContain('sleeper')
    const pid = Number(/\n(\d+) \|[^\n]*sleeper/.exec(sessions)?.[1])
    const cancelled = await run({ action: 'terminate', target: 'devdb', pid })
    expect(cancelled).toContain('was cancelled')
    expect(await sleeping).toBeInstanceOf(Error)
    await other.close()
  }, 60_000)

  test('a role with a password that never appears in the conversation', async () => {
    writeFileSync(join(root, '.env.local'), 'REPORTING_PASSWORD=hunter2-long-enough\n')
    const created = await run({ action: 'query', target: 'devdb', sql: 'CREATE ROLE reporting LOGIN PASSWORD ${env:REPORTING_PASSWORD}; GRANT SELECT ON orders TO reporting' })
    expect(created).not.toContain('hunter2')
    expect(created).not.toContain('failed')
    const stored = await run({ action: 'query', target: 'devdb', sql: "SELECT rolpassword FROM pg_authid WHERE rolname = 'reporting'" })
    const verifier = /SCRAM-SHA-256\$(\d+):([^$\s]+)\$\S+/.exec(stored)
    expect(verifier).not.toBeNull()
    // The stored verifier is the one the password produces with the same salt: login would succeed.
    expect(scramSha256Verifier('hunter2-long-enough', Buffer.from(verifier![2]!, 'base64'), Number(verifier![1]))).toBe(verifier![0])
    expect(await run({ action: 'roles', target: 'devdb', role: 'reporting' })).toContain('SELECT')
  })

  test('backup, destroy, restore — and restore into a new database', async () => {
    const backedUp = await run({ action: 'backup', target: 'devdb' })
    expect(backedUp).toContain('pg_dump custom format')
    const plain = await run({ action: 'backup', target: 'devdb', format: 'sql', schema_only: true })
    expect(plain).toContain('plain SQL')
    const dropped = await run({ action: 'query', target: 'devdb', sql: 'DROP TABLE orders' })
    expect(dropped).toContain('backup taken before this destructive statement')
    const dump = /restore file=(\S+)/.exec(dropped)![1]!
    const restored = await run({ action: 'restore', target: 'devdb', file: dump })
    expect(restored).toContain('restored')
    expect(await run({ action: 'query', target: 'devdb', sql: 'SELECT count(*) AS n FROM orders' })).toContain('2000')
    const copy = await run({ action: 'restore', target: 'devdb', file: dump, into: 'new', database: 'restored_copy' })
    expect(copy).toContain('into restored_copy')
    expect(readdirSync(join(root, '.elia', 'devdb', 'backups')).length).toBeGreaterThanOrEqual(3)
  }, 120_000)

  test('create a copy, drop it after backing it up', async () => {
    const created = await run({ action: 'create_database', target: 'devdb', database: 'scratch_copy', from: 'restored_copy' })
    expect(created).toContain('as a copy of restored_copy')
    const dropped = await run({ action: 'drop_database', target: 'devdb', database: 'scratch_copy', force: true })
    expect(dropped).toContain('backup taken before dropping database scratch_copy')
    expect(dropped).toContain('dropped database scratch_copy')
    expect(await run({ action: 'drop_database', target: 'devdb', database: 'postgres' })).toContain('system database')
  }, 60_000)

  test('export and import, one transaction', async () => {
    expect(await run({ action: 'export', target: 'devdb', sql: 'SELECT id, email FROM customers ORDER BY id LIMIT 5', file: 'customers.jsonl' })).toContain('exported 5 row(s)')
    expect(readFileSync(join(root, 'customers.jsonl'), 'utf8').split('\n')[0]).toBe('{"id":1,"email":"c1@example.com"}')
    writeFileSync(join(root, 'orders.csv'), 'customer_id,total\n1,10.5\n2,oops\n')
    const bad = await run({ action: 'import', target: 'devdb', file: 'orders.csv', table: 'orders' })
    expect(bad).toContain('Nothing was imported')
    writeFileSync(join(root, 'orders.csv'), 'customer_id,total\n1,10.5\n2,7\n')
    expect(await run({ action: 'import', target: 'devdb', file: 'orders.csv', table: 'orders' })).toContain('now holds 2002 row(s)')
  })
})
