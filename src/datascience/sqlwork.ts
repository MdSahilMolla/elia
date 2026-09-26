import { Database } from 'bun:sqlite'
import { frameFromRows, type Frame } from './frame.ts'
import { assertReadOnlySql, quoteIdentifier } from './sqlguard.ts'
import { toScalar } from './values.ts'

/**
 * SQL over workspace datasets. Each referenced dataset is loaded into a private in-memory
 * SQLite database (built into Bun, so it works on every machine), the read-only guard
 * checks the query, and the result becomes a new frame. Dates stay ISO-8601 text, so
 * SQLite's date(), strftime() and julianday() work on them; booleans become 0/1.
 */

const SQLITE_TYPES: Record<string, string> = { integer: 'INTEGER', number: 'REAL', boolean: 'INTEGER', date: 'TEXT', datetime: 'TEXT', string: 'TEXT', empty: 'TEXT' }

export function queryFrames(tables: Array<{ name: string; frame: Frame }>, sql: string, limit = 1_000_000): { frame: Frame; statement: string; truncated: boolean } {
  const statement = assertReadOnlySql(sql)
  const db = new Database(':memory:')
  try {
    for (const { name, frame } of tables) {
      const columns = frame.columns.map((column) => `${quoteIdentifier(column)} ${SQLITE_TYPES[frame.types[column] ?? 'string'] ?? 'TEXT'}`).join(', ')
      db.run(`CREATE TABLE ${quoteIdentifier(name)} (${columns})`)
      if (frame.rows.length === 0) continue
      const insert = db.prepare(`INSERT INTO ${quoteIdentifier(name)} VALUES (${frame.columns.map(() => '?').join(', ')})`)
      const load = db.transaction((rows: Frame['rows']) => {
        for (const row of rows) insert.run(...frame.columns.map((column) => {
          const value = row[column]
          return value === undefined ? null : typeof value === 'boolean' ? Number(value) : value
        }))
      })
      load(frame.rows)
    }
    db.run('PRAGMA query_only = ON')
    const rows = db.query(`SELECT * FROM (${statement}) LIMIT ${limit + 1}`).all() as Array<Record<string, unknown>>
    const truncated = rows.length > limit
    const kept = rows.slice(0, limit).map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, toScalar(value)])))
    const columns = kept.length ? Object.keys(kept[0]!) : (db.query(`SELECT * FROM (${statement}) LIMIT 0`).columnNames ?? [])
    return { frame: frameFromRows(kept, columns), statement, truncated }
  } finally {
    db.close()
  }
}

/** Validates a query against the workspace tables without returning data (for SQL generation checks). */
export function explainFrames(tables: Array<{ name: string; frame: Frame }>, sql: string): string[] {
  const statement = assertReadOnlySql(sql)
  const db = new Database(':memory:')
  try {
    for (const { name, frame } of tables) db.run(`CREATE TABLE ${quoteIdentifier(name)} (${frame.columns.map((column) => `${quoteIdentifier(column)} ${SQLITE_TYPES[frame.types[column] ?? 'string'] ?? 'TEXT'}`).join(', ')})`)
    return (db.query(`EXPLAIN QUERY PLAN ${statement}`).all() as Array<{ detail: string }>).map((row) => row.detail)
  } finally {
    db.close()
  }
}
