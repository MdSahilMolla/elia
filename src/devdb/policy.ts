/**
 * Which database a `database` tool call touches, and how much that may cost.
 *
 * Synchronous on purpose: the action governor classifies every tool call
 * before it runs and cannot await, so the target is resolved from the same
 * files `detect.ts` reads (env files, elia's own devdb state) with no network.
 *
 * The line is drawn at locality, not at the verb:
 *
 *   local  (loopback, unix socket, a sqlite file in the project)
 *     read / detect / status / schema     safe      — runs freely
 *     write / schema change / migrate     review    — runs unattended; recorded
 *     destructive SQL                     review    — runs only after the tool
 *                                                     has dumped the database
 *     start / stop elia's own postgres    review
 *
 *   remote (anything else — possibly somebody's production)
 *     every action                        critical  — `database.remote`, never
 *                                                     settled once for a run;
 *                                                     unattended runs refuse it
 *
 * Remote reads are critical too. Rows from a hosted database are real people's
 * data; an unsupervised run that pulls them into a model prompt is a privacy
 * incident even when nothing was written.
 */

import { isAbsolute, relative, resolve } from 'node:path'
import type { ActionAssessment } from '../autonomy/governor.ts'
import { detectDatabase, primaryTarget } from './detect.ts'
import { readLocalDbState } from './local.ts'
import { classifySql, type SqlClass } from './sql.ts'
import { parseDatabaseUrl, redactDatabaseUrl } from './url.ts'

export type DatabaseAction = 'detect' | 'status' | 'start' | 'stop' | 'query' | 'schema' | 'migrate'

export const DATABASE_ACTIONS: readonly DatabaseAction[] = ['detect', 'status', 'start', 'stop', 'query', 'schema', 'migrate']

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
 *   target=VAR     that variable from the project's env files / process env
 *   (default)      the project's own local database if it declares one, else
 *                  elia's devdb if one exists, else whatever the project
 *                  declares (which may be remote — and then is governed so)
 */
export function resolveDatabaseTarget(root: string, input: { url?: unknown; target?: unknown }, env: NodeJS.ProcessEnv = process.env): ResolvedTarget | undefined {
  const devdb = readLocalDbState(root)
  const fromDevdb = (): ResolvedTarget | undefined => (devdb ? { url: devdb.url, source: 'elia devdb', local: true, devdb: true } : undefined)
  if (typeof input.url === 'string' && input.url.trim()) {
    const url = input.url.trim()
    const parsed = parseDatabaseUrl(url)
    const local = parsed?.engine === 'sqlite' ? sqliteInsideProject(root, parsed.database) : (parsed?.local ?? false)
    return { url, source: 'explicit url', local, devdb: Boolean(devdb && parsed?.local && parsed.port === devdb.port) }
  }
  const target = typeof input.target === 'string' ? input.target.trim() : ''
  if (target === 'devdb') return fromDevdb()
  const detection = detectDatabase(root, env)
  if (target && target !== 'project' && target !== 'auto') {
    const named = detection.targets.find((candidate) => candidate.variable === target && !candidate.example)
    return named ? { url: named.url, source: named.source, local: named.local, devdb: false } : undefined
  }
  const project = primaryTarget(detection)
  if (project && (project.local || target === 'project')) {
    const parsed = parseDatabaseUrl(project.url)
    const local = parsed?.engine === 'sqlite' ? sqliteInsideProject(root, parsed.database) : project.local
    return { url: project.url, source: project.source, local, devdb: Boolean(devdb && parsed?.local && parsed.port === devdb.port) }
  }
  return fromDevdb() ?? (project ? { url: project.url, source: project.source, local: project.local, devdb: false } : undefined)
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

export function sqlClassOf(input: Record<string, unknown>): SqlClass {
  return typeof input.sql === 'string' ? classifySql(input.sql) : 'read'
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

  const target = resolveDatabaseTarget(root, input, env)
  if (!target) {
    // Nothing to connect to: the tool itself will say so. No side effect is possible.
    return verdict('safe', 'no database is configured or running for this project, so this call can only report that', 'database.inspect', [], true)
  }
  const resource = redactDatabaseUrl(target.url)
  if (!target.local) {
    return verdict('critical', `the target database (${target.source}) is not on this machine and may hold production data`, 'database.remote', [resource], false)
  }
  if (action === 'status' || action === 'schema') {
    return verdict('safe', `${action} only reads catalog metadata from a local database`, 'database.inspect', [resource], true)
  }
  if (action === 'migrate') {
    return verdict('review', `applies the project's own migrations to a local database (${target.source})`, 'database.migrate', [resource], false)
  }
  const sqlClass = sqlClassOf(input)
  if (sqlClass === 'read') return verdict('safe', 'read-only SQL against a local database', 'database.read', [resource], true)
  if (sqlClass === 'destructive') {
    return verdict('review', `destructive SQL against a local database (${target.source}); the tool dumps the database before running it`, 'database.local-destructive', [resource], true)
  }
  return verdict('review', `${sqlClass === 'schema' ? 'schema change' : 'data write'} against a local database (${target.source})`, 'database.local-write', [resource], false)
}
