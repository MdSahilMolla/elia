/**
 * Small pieces every database action shares: quoting names safely for each
 * engine, reading a `schema.table` argument, and rendering a series of catalog
 * queries run over one connection.
 */

import type { ResolvedTarget } from './policy.ts'
import { formatRows, type SqlSession } from './sql.ts'
import { describeDatabaseUrl, type DatabaseEngine } from './url.ts'

export interface DbContext {
  /** The project root the call runs for (the agent's cwd). */
  root: string
  target: ResolvedTarget
  engine: DatabaseEngine
}

export function targetLine(target: ResolvedTarget): string {
  return `target: ${describeDatabaseUrl(target.url)} — from ${target.source}`
}

/** An identifier, quoted for the engine: `"a""b"` for Postgres/SQLite, `` `a``b` `` for MySQL. */
export function quoteIdent(name: string, engine: DatabaseEngine): string {
  return engine === 'mysql' ? `\`${name.replace(/`/g, '``')}\`` : `"${name.replace(/"/g, '""')}"`
}

/** A string literal, quoted for the engine. MySQL reads a backslash inside a string as an escape; the others do not. */
export function quoteLiteral(value: string, engine: DatabaseEngine): string {
  const escaped = engine === 'mysql' ? value.replace(/\\/g, '\\\\').replace(/'/g, "''") : value.replace(/'/g, "''")
  return `'${escaped}'`
}

export interface QualifiedName {
  schema?: string
  name: string
}

/**
 * Reads `users`, `public.users`, `"Weird Name"`, `"auth"."User"` or
 * `` `shop`.`orders` `` into its parts. Quotes keep dots and case; nothing is
 * folded here — the lookup decides how to match case.
 */
export function parseQualifiedName(input: string): QualifiedName | undefined {
  const parts: string[] = []
  let current = ''
  let quote: string | undefined
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!
    if (quote) {
      const close = quote === '[' ? ']' : quote
      if (ch === close) {
        if (close !== ']' && input[i + 1] === close) {
          current += ch
          i += 1
        } else quote = undefined
        continue
      }
      current += ch
      continue
    }
    if (ch === '"' || ch === '`' || ch === '[') quote = ch
    else if (ch === '.') {
      parts.push(current)
      current = ''
    } else if (!/\s/.test(ch)) current += ch
  }
  parts.push(current)
  if (quote || parts.length > 2 || parts.some((part) => !part)) return undefined
  return parts.length === 2 ? { schema: parts[0]!, name: parts[1]! } : { name: parts[0]! }
}

export function qualifiedIdent(name: QualifiedName, engine: DatabaseEngine): string {
  return name.schema ? `${quoteIdent(name.schema, engine)}.${quoteIdent(name.name, engine)}` : quoteIdent(name.name, engine)
}

/** A plain SQL name (setting, pragma, role): letters, digits, underscores, dots. */
export function isPlainName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_.$]*$/.test(name)
}

export interface CatalogSection {
  title: string
  sql: string
  params?: unknown[]
  /** Printed instead of "(0 rows)". */
  empty?: string
  /** Left out when it fails — an optional extension, a view an older server lacks. */
  optional?: boolean
  /** Left out when it returns no rows. */
  hideEmpty?: boolean
  maxRows?: number
}

/** Runs each section on the session and renders it under its heading; a failed section says why instead of aborting the rest. */
export async function renderSections(session: SqlSession, sections: readonly CatalogSection[]): Promise<string[]> {
  const out: string[] = []
  for (const section of sections) {
    const result = await session.run(section.sql, { params: section.params, timeoutMs: 30_000 })
    if (!result.ok) {
      if (!section.optional) out.push(`## ${section.title}\n(unavailable: ${result.error ?? 'unknown error'})`)
      continue
    }
    const rows = result.statements.at(-1)?.rows ?? []
    if (rows.length === 0 && section.hideEmpty) continue
    out.push(`## ${section.title}\n${rows.length === 0 && section.empty ? section.empty : formatRows(rows, section.maxRows)}`)
  }
  return out
}

/** Rows of one query, or the error. For code that needs values rather than a rendered table. */
export async function queryRows(session: SqlSession, sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; error?: string }> {
  const result = await session.run(sql, { params, timeoutMs: 30_000 })
  return result.ok ? { rows: result.statements.at(-1)?.rows ?? [] } : { rows: [], error: result.error ?? 'unknown error' }
}

/** Connects (the first query opens the connection) and reports a failure in words the model can act on. */
export async function connectionProblem(session: SqlSession, target: ResolvedTarget): Promise<string | undefined> {
  const probe = await session.run('SELECT 1 AS ok', { timeoutMs: 20_000 })
  if (probe.ok) return undefined
  const hint = target.devdb ? ' Start it with action "start".' : ''
  return `${targetLine(target)}\ncould not connect: ${probe.error ?? 'unknown error'}.${hint}`
}

export function numberOf(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string' && value.trim() !== '') return Number(value)
  return Number.NaN
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return 'unknown'
  const units = ['B', 'kB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}
