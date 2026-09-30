/**
 * The project's own migrations, run through the project's own tool (Prisma,
 * Drizzle, Knex, Sequelize, TypeORM, Alembic, Django, Rails) against the
 * database the call targets: apply the pending ones, see where things stand,
 * create a new one, or roll the last one back — after a backup, because a
 * down migration usually drops columns or tables.
 */

import { currentAgent } from '../autonomy/context.ts'
import { formatShellResult, runShell } from '../shell.ts'
import { backupBeforeDestroying } from './backup.ts'
import { targetLine, type DbContext } from './common.ts'
import { detectDatabase, type MigrationTool } from './detect.ts'
import { redactDatabaseUrl, sqliteFileOf } from './url.ts'

export const MIGRATE_OPERATIONS = ['apply', 'status', 'create', 'rollback'] as const
type Operation = (typeof MIGRATE_OPERATIONS)[number]

/** DATABASE_URL in the spelling the migration tool expects: Prisma wants `file:` for SQLite, SQLAlchemy `sqlite:////abs`. */
function urlForTool(ctx: DbContext, tool: MigrationTool): string {
  if (ctx.engine !== 'sqlite') return ctx.target.url
  const file = sqliteFileOf(ctx.target.url)
  return tool.name === 'prisma' ? `file:${file}` : `sqlite:///${file}`
}

export async function migrate(ctx: DbContext, input: Record<string, unknown>): Promise<string> {
  const name = typeof input.name === 'string' ? input.name : undefined
  const requested = typeof input.operation === 'string' ? input.operation : ''
  const operation: Operation = (MIGRATE_OPERATIONS as readonly string[]).includes(requested) ? (requested as Operation) : name ? 'create' : 'apply'
  const tool = detectDatabase(ctx.root).migrationTools[0]
  if (!tool) {
    return `${targetLine(ctx.target)}\nNo migration tool detected (prisma, drizzle, knex, sequelize, typeorm, alembic, django, rails). Apply schema changes with action "query" instead, and keep the SQL in a migrations/ file so it is reproducible.`
  }
  let command: string
  const notes: string[] = []
  if (operation === 'create') {
    const safeName = name?.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60)
    if (!safeName) return 'Refused: a new migration needs `name`, with letters or digits in it.'
    if (!tool.create) return `${tool.name} migrations are applied here but not created; write the migration file yourself, then call migrate.`
    command = tool.create.replace('{name}', safeName)
  } else if (operation === 'status') {
    if (!tool.status) return `${tool.name} has no command that lists migration status; action schema shows what the database holds now.`
    command = tool.status
  } else if (operation === 'rollback') {
    if (!tool.rollback) {
      return `${tool.name} has no down migrations to roll back with. To undo the last change: restore the backup taken before it (action restore), or write a new migration that reverses it.`
    }
    const guard = await backupBeforeDestroying(ctx, input, 'rolling back the last migration')
    if (!guard.proceed) return guard.refusal ?? 'rollback refused'
    notes.push(...guard.notes)
    command = tool.rollback
  } else command = tool.command

  const url = urlForTool(ctx, tool)
  const env = { ...(process.env as Record<string, string>), DATABASE_URL: url }
  const result = await runShell(command, 300_000, ctx.root, currentAgent().signal, env)
  const output = formatShellResult(result).split(url).join(redactDatabaseUrl(url))
  return [targetLine(ctx.target), ...notes, `migration tool: ${tool.name} (${tool.evidence})`, `$ ${command}   [DATABASE_URL set to the target]`, output].join('\n')
}
