/**
 * Reads the sidecar's own pairing state, read-only.
 *
 * The mesh must not start itself into a pairing it was never told about, and
 * the only authority on whether this folder is paired is the sidecar's state
 * database. Reading it directly couples Elia to the component's schema, which
 * is a real cost; it is paid here, once, instead of threading a query command
 * through the component's CLI for a single boolean.
 *
 * The coupling is kept honest by failing safe: any schema surprise — a missing
 * table, a renamed column, a locked or absent file — yields `present: false` or
 * an empty result, so `auto` declines to start rather than starting something
 * it does not understand. Only `require` acts on an unreadable state as if it
 * were present-and-unpaired.
 */

import { Database } from 'bun:sqlite'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

/** Mirrors `internal/store`: the state directory and database file names. */
const STATE_DIR = '.workspace'
const DB_FILE = 'state.db'

export interface MeshPairing {
  /** A sidecar workspace exists at this root (its state database is present). */
  present: boolean
  role?: 'host' | 'member'
  /** The pinned host certificate fingerprint, when this node is a paired member. */
  hostCert?: string
  /** How many peers the database knows about. Zero when unknown. */
  peers: number
}

/** Reads pairing state from `<root>/.workspace/state.db`, tolerating any failure. */
export function readMeshPairing(root: string): MeshPairing {
  const dbPath = join(root, STATE_DIR, DB_FILE)
  if (!existsSync(dbPath)) return { present: false, peers: 0 }

  let db: Database | undefined
  try {
    db = new Database(dbPath, { readonly: true })
    const role = readMeta(db, 'role')
    const hostCert = readMeta(db, 'host_cert_sha256')
    return {
      present: true,
      ...(role === 'host' || role === 'member' ? { role } : {}),
      ...(hostCert ? { hostCert } : {}),
      peers: countPeers(db),
    }
  } catch {
    // The database exists but could not be read — a lock, a version from a
    // newer component, corruption. "Present but unknown" is the safe reading:
    // auto must not start without a positive pairing signal.
    return { present: true, peers: 0 }
  } finally {
    db?.close()
  }
}

/**
 * Whether this workspace has completed a pairing. Matches the component's own
 * rule: a peer exists, or a member has pinned its host. A lone host that has
 * never been joined is *not* paired — starting it would offer a join code that
 * only a deliberate, user-driven pairing should produce.
 */
export function isMeshPaired(pairing: MeshPairing): boolean {
  return pairing.present && (pairing.peers > 0 || (pairing.hostCert !== undefined && pairing.hostCert !== ''))
}

function readMeta(db: Database, key: string): string | undefined {
  const row = db.query('SELECT value FROM meta WHERE key = ?').get(key) as { value?: unknown } | null
  return row && typeof row.value === 'string' ? row.value : undefined
}

function countPeers(db: Database): number {
  const row = db.query('SELECT COUNT(*) AS n FROM peers').get() as { n?: unknown } | null
  return row && typeof row.n === 'number' ? row.n : 0
}
