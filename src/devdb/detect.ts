/**
 * What a project already says about its database, read from its own files.
 *
 * Nothing here connects to anything or runs anything: it reads env files,
 * ORM configs, compose files and migration folders, and reports what they
 * declare. Secrets never leave this module unredacted — a connection string is
 * kept whole only in `DatabaseTarget.url`, for the tool to connect with, and
 * every rendering goes through `redactDatabaseUrl`.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describeDatabaseUrl, engineOf, parseDatabaseUrl, type DatabaseEngine } from './url.ts'

/** Env files a project keeps its connection string in, most specific first. */
export const ENV_FILES = ['.env.development.local', '.env.local', '.env.development', '.env', '.env.example', '.env.sample', '.env.template']

/** Env variable names that conventionally carry a connection string. */
const URL_VARIABLES = ['DATABASE_URL', 'POSTGRES_URL', 'POSTGRES_PRISMA_URL', 'PG_URL', 'PGURL', 'DB_URL', 'DATABASE_URI', 'SQLALCHEMY_DATABASE_URI', 'MYSQL_URL', 'DIRECT_URL']

export interface DatabaseTarget {
  /** Where the connection string came from, e.g. `.env: DATABASE_URL` or `process env: DATABASE_URL`. */
  source: string
  variable: string
  url: string
  engine: DatabaseEngine
  local: boolean
  /** True for example/template files — a placeholder, not a database anyone runs. */
  example: boolean
}

export interface MigrationTool {
  name: string
  /** The command that applies pending migrations to a dev database, non-interactively. */
  command: string
  /** Creates a new migration from the schema and applies it; `{name}` is the migration name. */
  create?: string
  /** Lists applied and pending migrations without changing anything. */
  status?: string
  /** Reverts the most recent migration (or batch). Absent where the tool has no down migrations. */
  rollback?: string
  evidence: string
}

export interface ComposeService {
  file: string
  service: string
  image: string
  engine: DatabaseEngine
}

export interface DatabaseDetection {
  targets: DatabaseTarget[]
  migrationTools: MigrationTool[]
  composeServices: ComposeService[]
  migrationDirs: string[]
  /** One-line facts for a survey or a model, secrets redacted. */
  signals: string[]
}

/** Parses KEY=VALUE lines the way dotenv does (quotes stripped, `export` allowed, comments skipped). */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line)
    if (!match) continue
    let value = match[2]!.trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    else value = value.replace(/\s+#.*$/, '')
    out[match[1]!] = value
  }
  return out
}

function readText(path: string, limit = 256_000): string | undefined {
  try {
    if (!existsSync(path) || statSync(path).size > limit) return undefined
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

function envTargets(root: string, env: NodeJS.ProcessEnv): DatabaseTarget[] {
  const targets: DatabaseTarget[] = []
  const seen = new Set<string>()
  const add = (source: string, variable: string, url: string, example: boolean) => {
    const trimmed = url.trim()
    if (!trimmed || engineOf(trimmed) === 'unknown' || seen.has(`${variable}\0${trimmed}`)) return
    // `${OTHER_VAR}` interpolation is not a URL we can connect to.
    if (/\$\{?[A-Z_]/.test(trimmed)) return
    seen.add(`${variable}\0${trimmed}`)
    const parsed = parseDatabaseUrl(trimmed)
    targets.push({ source, variable, url: trimmed, engine: parsed?.engine ?? engineOf(trimmed), local: parsed?.local ?? false, example })
  }
  for (const variable of URL_VARIABLES) {
    const value = env[variable]
    if (value) add(`process env: ${variable}`, variable, value, false)
  }
  for (const file of ENV_FILES) {
    const text = readText(join(root, file))
    if (text === undefined) continue
    const parsed = parseEnvFile(text)
    const example = /\.(?:example|sample|template)$/.test(file)
    for (const variable of URL_VARIABLES) {
      const value = parsed[variable]
      if (value) add(`${file}: ${variable}`, variable, value, example)
    }
  }
  return targets
}

function packageDependencies(root: string): Record<string, string> {
  const text = readText(join(root, 'package.json'))
  if (!text) return {}
  try {
    const pkg = JSON.parse(text) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
    return { ...pkg.dependencies, ...pkg.devDependencies }
  } catch {
    return {}
  }
}

function nodeRunner(root: string): string {
  if (existsSync(join(root, 'bun.lock')) || existsSync(join(root, 'bun.lockb'))) return 'bunx'
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm exec'
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn'
  return 'npx'
}

function migrationTools(root: string): MigrationTool[] {
  const tools: MigrationTool[] = []
  const deps = packageDependencies(root)
  const run = nodeRunner(root)
  const prismaSchema = ['prisma/schema.prisma', 'schema.prisma'].find((file) => existsSync(join(root, file)))
  if (prismaSchema || deps.prisma || deps['@prisma/client']) {
    tools.push({ name: 'prisma', command: `${run} prisma migrate deploy`, create: `${run} prisma migrate dev --name {name}`, status: `${run} prisma migrate status`, evidence: prismaSchema ?? 'package.json: prisma' })
  }
  const drizzleConfig = ['drizzle.config.ts', 'drizzle.config.js', 'drizzle.config.mjs', 'drizzle.config.json'].find((file) => existsSync(join(root, file)))
  if (drizzleConfig || deps['drizzle-kit']) {
    tools.push({ name: 'drizzle', command: `${run} drizzle-kit migrate`, create: `${run} drizzle-kit generate --name {name}`, evidence: drizzleConfig ?? 'package.json: drizzle-kit' })
  }
  const knexfile = ['knexfile.ts', 'knexfile.js'].find((file) => existsSync(join(root, file)))
  if (knexfile) tools.push({ name: 'knex', command: `${run} knex migrate:latest`, create: `${run} knex migrate:make {name}`, status: `${run} knex migrate:status`, rollback: `${run} knex migrate:rollback`, evidence: knexfile })
  if (existsSync(join(root, '.sequelizerc')) || deps['sequelize-cli']) {
    tools.push({ name: 'sequelize', command: `${run} sequelize-cli db:migrate`, status: `${run} sequelize-cli db:migrate:status`, rollback: `${run} sequelize-cli db:migrate:undo`, evidence: existsSync(join(root, '.sequelizerc')) ? '.sequelizerc' : 'package.json: sequelize-cli' })
  }
  if (deps.typeorm && existsSync(join(root, 'ormconfig.json'))) {
    tools.push({ name: 'typeorm', command: `${run} typeorm migration:run`, status: `${run} typeorm migration:show`, rollback: `${run} typeorm migration:revert`, evidence: 'ormconfig.json' })
  }
  if (existsSync(join(root, 'alembic.ini'))) tools.push({ name: 'alembic', command: 'alembic upgrade head', create: 'alembic revision --autogenerate -m {name}', status: 'alembic current --verbose', rollback: 'alembic downgrade -1', evidence: 'alembic.ini' })
  if (existsSync(join(root, 'manage.py'))) tools.push({ name: 'django', command: 'python manage.py migrate --noinput', create: 'python manage.py makemigrations --name {name}', status: 'python manage.py showmigrations', evidence: 'manage.py' })
  if (existsSync(join(root, 'config', 'database.yml')) && existsSync(join(root, 'bin', 'rails'))) {
    tools.push({ name: 'rails', command: 'bin/rails db:migrate', status: 'bin/rails db:migrate:status', rollback: 'bin/rails db:rollback', evidence: 'config/database.yml' })
  }
  return tools
}

const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml', 'docker-compose.dev.yml']

/** Pulls `service: image:` pairs out of a compose file without a YAML dependency. */
export function composeDatabaseServices(file: string, text: string): ComposeService[] {
  const services: ComposeService[] = []
  const lines = text.split(/\r?\n/)
  let inServices = false
  let servicesIndent = -1
  let current: string | undefined
  let currentIndent = -1
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    if (/^services:\s*$/.test(line.trim()) && indent === 0) {
      inServices = true
      servicesIndent = indent
      continue
    }
    if (!inServices) continue
    if (indent <= servicesIndent) {
      inServices = false
      continue
    }
    const key = /^([A-Za-z0-9_.-]+):\s*$/.exec(line.trim())
    if (key && (currentIndent === -1 || indent <= currentIndent)) {
      current = key[1]
      currentIndent = indent
      continue
    }
    const image = /^image:\s*["']?([^"'\s]+)/.exec(line.trim())
    if (image && current) {
      const name = image[1]!.toLowerCase()
      const engine: DatabaseEngine = /(?:^|\/)(?:postgres|postgis|timescale|supabase\/postgres|pgvector)/.test(name) ? 'postgres' : /(?:^|\/)(?:mysql|mariadb)/.test(name) ? 'mysql' : 'unknown'
      if (engine !== 'unknown') services.push({ file, service: current, image: image[1]!, engine })
    }
  }
  return services
}

const MIGRATION_DIRS = ['prisma/migrations', 'migrations', 'db/migrate', 'db/migrations', 'alembic/versions', 'drizzle', 'supabase/migrations', 'src/migrations', 'database/migrations']

export function detectDatabase(root: string, env: NodeJS.ProcessEnv = process.env): DatabaseDetection {
  const targets = envTargets(root, env)
  const tools = migrationTools(root)
  const composeServices = COMPOSE_FILES.flatMap((file) => {
    const text = readText(join(root, file))
    return text === undefined ? [] : composeDatabaseServices(file, text)
  })
  const migrationDirs = MIGRATION_DIRS.filter((dir) => {
    try {
      return statSync(join(root, dir)).isDirectory() && readdirSync(join(root, dir)).length > 0
    } catch {
      return false
    }
  })
  const prismaProvider = /provider\s*=\s*"(postgresql|mysql|sqlite|sqlserver|mongodb|cockroachdb)"/.exec(readText(join(root, 'prisma', 'schema.prisma')) ?? '')?.[1]
  const signals = [
    ...targets.map((target) => `${target.source} → ${describeDatabaseUrl(target.url)}${target.example ? ' [example file]' : ''}`),
    ...(prismaProvider ? [`prisma datasource provider: ${prismaProvider}`] : []),
    ...tools.map((tool) => `migrations: ${tool.name} (${tool.evidence}) → \`${tool.command}\``),
    ...composeServices.map((service) => `compose service "${service.service}" in ${service.file}: ${service.image}`),
    ...migrationDirs.map((dir) => `migration folder: ${dir}/`),
  ]
  return { targets, migrationTools: tools, composeServices, migrationDirs, signals }
}

/**
 * A connection string under any variable name — `STAGING_DATABASE_URL`,
 * `ANALYTICS_DB` — from the process environment or the project's own env files
 * (example files excluded). This is how a DBA session reaches a second
 * database without its password ever being written into the conversation.
 */
export function findEnvDatabaseUrl(root: string, name: string, env: NodeJS.ProcessEnv = process.env): { url: string; source: string } | undefined {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return undefined
  const usable = (value: string | undefined): value is string => Boolean(value && engineOf(value.trim()) !== 'unknown' && !/\$\{?[A-Z_]/.test(value))
  const fromProcess = env[name]
  if (usable(fromProcess)) return { url: fromProcess.trim(), source: `process env: ${name}` }
  for (const file of ENV_FILES) {
    if (/\.(?:example|sample|template)$/.test(file)) continue
    const text = readText(join(root, file))
    const value = text === undefined ? undefined : parseEnvFile(text)[name]
    if (usable(value)) return { url: value.trim(), source: `${file}: ${name}` }
  }
  return undefined
}

/**
 * The connection the project itself would use in development: a real (non-
 * example) target, local ones first. Example files are only a fallback for the
 * database name — never a server to connect to.
 */
export function primaryTarget(detection: DatabaseDetection): DatabaseTarget | undefined {
  const real = detection.targets.filter((target) => !target.example)
  return real.find((target) => target.local) ?? real[0]
}
