/**
 * `WorkspaceStore` — the durable core of the collaborative workspace.
 *
 * One SQLite file (`.elia/workspace.sqlite`) holds an append-only event spine
 * plus the projections `applyProjection` derives from it, and a tamper-evident
 * `audit_log` hash chain. A single long-lived handle is held open by the
 * workspace server; CLI one-shots open, act, and `close()`.
 *
 * `append` is the only writer: it runs the event insert, the projection update,
 * and the audit entry inside one transaction, so a rejected transition or a
 * dangling reference rolls the whole thing back and no half-state is ever
 * observable.
 *
 * Conventions (WAL, `strict`, `PRAGMA foreign_keys`, hardened `-wal`/`-shm`)
 * follow `src/battmann/store.ts`.
 */

import { Database } from 'bun:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { ensureSecureDirectory, hardenSecureFile } from '../securePersistence.ts'
import { redactSecrets } from '../ui/redact.ts'
import { applyProjection, isWorkspaceEventType, type PersistedEvent, type WorkspaceEventInput } from './events.ts'
import { migrate } from './schema.ts'
import {
  toAgent, toAgentIdentity, toAgentMessage, toApproval, toDecision, toMember, toObjective,
  toPresence, toProject, toReservation, toTask, toToken, toWorkspace, type Row,
} from './rows.ts'
import { LEASE_TTL_MS, type TaskStatus } from './types.ts'

export const DEFAULT_WORKSPACE_DB = join(process.cwd(), '.elia', 'workspace.sqlite')

const MAX_PAYLOAD_TEXT = 20_000

export interface EventQuery {
  sinceSeq?: number
  limit?: number
  objectiveId?: string
  types?: string[]
}

export class WorkspaceStore {
  private constructor(
    readonly path: string,
    private readonly db: Database,
  ) {}

  static open(path: string = DEFAULT_WORKSPACE_DB): WorkspaceStore {
    ensureSecureDirectory(dirname(path))
    const db = new Database(path, { create: true, strict: true })
    db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
    db.exec('PRAGMA journal_mode = WAL;')
    // Schema creation is idempotent; run it every open so an older file upgrades.
    migrate(db)
    hardenFiles(path)
    return new WorkspaceStore(path, db)
  }

  close(): void {
    try {
      // Fold the WAL back into the main file so no -wal/-shm sidecar is left
      // holding a lock (matters on Windows, where a stale handle blocks unlink).
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);')
    } catch {
      // A read-only or already-detached handle cannot checkpoint; closing still frees it.
    }
    try {
      this.db.close()
    } finally {
      hardenFiles(this.path)
    }
  }

  /** The single mutation entry point. Returns the persisted, streamable event. */
  append(input: WorkspaceEventInput): PersistedEvent {
    if (!isWorkspaceEventType(input.type)) throw new Error(`unknown workspace event type: ${String(input.type)}`)
    const at = new Date().toISOString()
    const id = `evt_${randomUUID().replaceAll('-', '')}`
    const payload = redactPayload(input.payload ?? {})

    const run = this.db.transaction(() => {
      const info = this.db.query(
        `INSERT INTO workspace_events (id, type, objective_id, task_id, actor_kind, actor_id, payload_json, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, input.type, input.objectiveId ?? null, input.taskId ?? null, input.actorKind, input.actorId, JSON.stringify(payload), at)
      const seq = Number(info.lastInsertRowid)
      const event: PersistedEvent = {
        seq, id, type: input.type, actorKind: input.actorKind, actorId: input.actorId,
        objectiveId: input.objectiveId, taskId: input.taskId, payload, at,
      }
      applyProjection(this.db, event)
      this.appendAudit(event)
      return event
    })
    return run()
  }

  private appendAudit(event: PersistedEvent): void {
    const payloadHash = createHash('sha256').update(JSON.stringify(event.payload)).digest('hex')
    const previous = this.db.query('SELECT entry_hash FROM audit_log ORDER BY seq DESC LIMIT 1').get() as Row | null
    const prevHash = previous ? String(previous.entry_hash) : ''
    const id = randomUUID()
    const target = event.taskId ?? event.objectiveId ?? null
    const entryHash = createHash('sha256')
      .update([prevHash, id, event.type, event.actorKind, event.actorId, target ?? '', payloadHash, event.at].join('␟'))
      .digest('hex')
    this.db.query(
      `INSERT INTO audit_log (id, action, actor_kind, actor_id, target, payload_hash, prev_hash, entry_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, event.type, event.actorKind, event.actorId, target, payloadHash, prevHash, entryHash, event.at)
  }

  /** Verify the audit hash chain end to end. */
  auditChainIntact(): boolean {
    const rows = this.db.query('SELECT * FROM audit_log ORDER BY seq ASC').all() as Row[]
    let prevHash = ''
    for (const row of rows) {
      if (String(row.prev_hash) !== prevHash) return false
      const recomputed = createHash('sha256')
        .update([prevHash, row.id, row.action, row.actor_kind, row.actor_id, row.target ?? '', row.payload_hash, row.created_at].join('␟'))
        .digest('hex')
      if (recomputed !== String(row.entry_hash)) return false
      prevHash = String(row.entry_hash)
    }
    return true
  }

  // --- Queries ---

  workspace(): ReturnType<typeof toWorkspace> | undefined {
    const row = this.db.query('SELECT * FROM workspaces LIMIT 1').get() as Row | null
    return row ? toWorkspace(row) : undefined
  }

  projects() {
    return (this.db.query('SELECT * FROM projects ORDER BY created_at').all() as Row[]).map(toProject)
  }

  project(id: string) {
    const row = this.db.query('SELECT * FROM projects WHERE id = ?').get(id) as Row | null
    return row ? toProject(row) : undefined
  }

  members(includeRemoved = false) {
    const sql = includeRemoved ? 'SELECT * FROM members ORDER BY created_at' : 'SELECT * FROM members WHERE removed_at IS NULL ORDER BY created_at'
    return (this.db.query(sql).all() as Row[]).map(toMember)
  }

  member(id: string) {
    const row = this.db.query('SELECT * FROM members WHERE id = ?').get(id) as Row | null
    return row ? toMember(row) : undefined
  }

  tokens(subjectId?: string) {
    const rows = subjectId
      ? this.db.query('SELECT * FROM tokens WHERE subject_id = ? ORDER BY created_at').all(subjectId)
      : this.db.query('SELECT * FROM tokens ORDER BY created_at').all()
    return (rows as Row[]).map(toToken)
  }

  tokenByHash(hash: string) {
    const row = this.db.query('SELECT * FROM tokens WHERE hash = ?').get(hash) as Row | null
    return row ? toToken(row) : undefined
  }

  touchToken(id: string): void {
    this.db.query('UPDATE tokens SET last_used_at = ? WHERE id = ?').run(new Date().toISOString(), id)
  }

  agentIdentities(includeRemoved = false) {
    const sql = includeRemoved
      ? 'SELECT * FROM agent_identities ORDER BY created_at'
      : 'SELECT * FROM agent_identities WHERE removed_at IS NULL ORDER BY created_at'
    return (this.db.query(sql).all() as Row[]).map(toAgentIdentity)
  }

  agentIdentity(idOrName: string) {
    const row = this.db.query('SELECT * FROM agent_identities WHERE id = ? OR name = ?').get(idOrName, idOrName) as Row | null
    return row ? toAgentIdentity(row) : undefined
  }

  agents() {
    return (this.db.query('SELECT * FROM agents ORDER BY started_at').all() as Row[]).map(toAgent)
  }

  agent(id: string) {
    const row = this.db.query('SELECT * FROM agents WHERE id = ?').get(id) as Row | null
    return row ? toAgent(row) : undefined
  }

  agentByName(name: string) {
    const row = this.db.query('SELECT * FROM agents WHERE name = ? ORDER BY started_at DESC LIMIT 1').get(name) as Row | null
    return row ? toAgent(row) : undefined
  }

  objectives() {
    return (this.db.query('SELECT * FROM objectives ORDER BY created_at').all() as Row[]).map(toObjective)
  }

  objective(id: string) {
    const row = this.db.query('SELECT * FROM objectives WHERE id = ?').get(id) as Row | null
    return row ? toObjective(row) : undefined
  }

  tasks(filter: { objectiveId?: string; status?: TaskStatus | TaskStatus[] } = {}) {
    const clauses: string[] = []
    const values: unknown[] = []
    if (filter.objectiveId) {
      clauses.push('objective_id = ?')
      values.push(filter.objectiveId)
    }
    if (filter.status) {
      const list = Array.isArray(filter.status) ? filter.status : [filter.status]
      clauses.push(`status IN (${list.map(() => '?').join(',')})`)
      values.push(...list)
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    return (this.db.query(`SELECT * FROM tasks ${where} ORDER BY created_at`).all(...values as never[]) as Row[]).map(toTask)
  }

  task(id: string) {
    const row = this.db.query('SELECT * FROM tasks WHERE id = ?').get(id) as Row | null
    return row ? toTask(row) : undefined
  }

  reservations(activeOnly = true) {
    const sql = activeOnly
      ? 'SELECT * FROM reservations WHERE released_at IS NULL ORDER BY acquired_at'
      : 'SELECT * FROM reservations ORDER BY acquired_at'
    return (this.db.query(sql).all() as Row[]).map(toReservation)
  }

  messages(filter: { objectiveId?: string; toId?: string; sinceSeq?: number; limit?: number } = {}) {
    const clauses: string[] = []
    const values: unknown[] = []
    if (filter.objectiveId) {
      clauses.push('objective_id = ?')
      values.push(filter.objectiveId)
    }
    if (filter.toId) {
      clauses.push('(to_id = ? OR to_id IS NULL)')
      values.push(filter.toId)
    }
    if (filter.sinceSeq !== undefined) {
      clauses.push('seq > ?')
      values.push(filter.sinceSeq)
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const limit = Math.min(Math.max(filter.limit ?? 200, 1), 1000)
    return (this.db.query(`SELECT * FROM agent_messages ${where} ORDER BY seq DESC LIMIT ${limit}`).all(...values as never[]) as Row[])
      .map(toAgentMessage)
      .reverse()
  }

  decisions(objectiveId: string) {
    return (this.db.query('SELECT * FROM decisions WHERE objective_id = ? ORDER BY at').all(objectiveId) as Row[]).map(toDecision)
  }

  approvals(status?: 'pending' | 'granted' | 'rejected') {
    const rows = status
      ? this.db.query('SELECT * FROM approvals WHERE status = ? ORDER BY requested_at').all(status)
      : this.db.query('SELECT * FROM approvals ORDER BY requested_at').all()
    return (rows as Row[]).map(toApproval)
  }

  presence() {
    return (this.db.query('SELECT * FROM presence ORDER BY connected_at').all() as Row[]).map(toPresence)
  }

  events(query: EventQuery = {}): PersistedEvent[] {
    const clauses: string[] = []
    const values: unknown[] = []
    if (query.sinceSeq !== undefined) {
      clauses.push('seq > ?')
      values.push(query.sinceSeq)
    }
    if (query.objectiveId) {
      clauses.push('objective_id = ?')
      values.push(query.objectiveId)
    }
    if (query.types?.length) {
      clauses.push(`type IN (${query.types.map(() => '?').join(',')})`)
      values.push(...query.types)
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const limit = Math.min(Math.max(query.limit ?? 500, 1), 5000)
    return (this.db.query(`SELECT * FROM workspace_events ${where} ORDER BY seq ASC LIMIT ${limit}`).all(...values as never[]) as Row[])
      .map(rowToEvent)
  }

  latestSeq(): number {
    const row = this.db.query('SELECT MAX(seq) AS seq FROM workspace_events').get() as Row | null
    return row && row.seq != null ? Number(row.seq) : 0
  }

  /**
   * Recover work stranded by a crashed agent or interrupted server. Expired task
   * leases go back to `ready` (dependencies permitting) with an attempt already
   * counted; agents that missed their heartbeat window are marked `failed`;
   * expired reservations are released. Every recovery is itself an appended
   * event, so the history stays complete.
   */
  reconcileLeases(now = Date.now()): { tasks: string[]; agents: string[]; reservations: string[] } {
    const tasks: string[] = []
    const agents: string[] = []
    const reservations: string[] = []

    for (const task of this.tasks({ status: ['assigned', 'in-progress'] })) {
      if (task.leaseExpiresAt && task.leaseExpiresAt <= now) {
        const target: TaskStatus = task.attemptCount >= task.maxAttempts ? 'failed' : 'ready'
        this.append({
          type: target === 'failed' ? 'TaskFailed' : 'TaskStatusChanged',
          actorKind: 'system', actorId: 'lease-reconciler', objectiveId: task.objectiveId, taskId: task.id,
          payload: target === 'failed'
            ? { error: 'stale execution lease recovered after interruption' }
            : { status: 'ready' },
        })
        tasks.push(task.id)
      }
    }

    const staleCutoff = now - LEASE_TTL_MS
    for (const agent of this.agents()) {
      const alive = agent.status !== 'cancelled' && agent.status !== 'completed' && agent.status !== 'failed'
      if (alive && Date.parse(agent.lastHeartbeatAt) <= staleCutoff) {
        this.append({
          type: 'AgentStateChanged', actorKind: 'system', actorId: 'lease-reconciler',
          payload: { id: agent.id, status: 'failed', lastError: 'missed heartbeat window', currentTaskId: null },
        })
        agents.push(agent.id)
      }
    }

    for (const reservation of this.reservations(true)) {
      if (reservation.expiresAt <= now) {
        this.append({
          type: 'ReservationExpired', actorKind: 'system', actorId: 'lease-reconciler',
          taskId: reservation.taskId, payload: { id: reservation.id },
        })
        reservations.push(reservation.id)
      }
    }

    return { tasks, agents, reservations }
  }

  /** Escape hatch for advanced queries and tests. Prefer the typed getters. */
  raw(): Database {
    return this.db
  }
}

function hardenFiles(path: string): void {
  hardenSecureFile(path)
  hardenSecureFile(`${path}-wal`)
  hardenSecureFile(`${path}-shm`)
}

function rowToEvent(row: Row): PersistedEvent {
  let payload: Record<string, unknown> = {}
  try {
    payload = row.payload_json ? JSON.parse(String(row.payload_json)) : {}
  } catch {
    payload = {}
  }
  return {
    seq: Number(row.seq), id: String(row.id), type: String(row.type) as PersistedEvent['type'],
    actorKind: String(row.actor_kind) as PersistedEvent['actorKind'], actorId: String(row.actor_id),
    objectiveId: row.objective_id == null ? undefined : String(row.objective_id),
    taskId: row.task_id == null ? undefined : String(row.task_id),
    payload, at: String(row.at),
  }
}

/**
 * Bound and secret-scrub payload strings before they reach the durable log or
 * the wire, without flattening whitespace (agents' instructions carry meaningful
 * newlines). `hash` is the one field left untouched — it is a one-way digest,
 * safe to persist, and the secret regex would otherwise mistake it for a token.
 */
const LONG_TEXT_KEYS = new Set(['goal', 'instructions', 'body', 'detail', 'instruction'])
const STRUCTURAL_KEYS = new Set(['hash'])

function bound(value: string, max: number): string {
  const safe = redactSecrets(value)
  return safe.length > max ? `${safe.slice(0, max - 1)}…` : safe
}

function redactPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(payload)) {
    if (STRUCTURAL_KEYS.has(key)) out[key] = value
    else if (typeof value === 'string') out[key] = bound(value, LONG_TEXT_KEYS.has(key) ? MAX_PAYLOAD_TEXT : 4_000)
    else if (Array.isArray(value)) out[key] = value.slice(0, 500).map((item) => (typeof item === 'string' ? bound(item, 4_000) : item))
    else if (value && typeof value === 'object') out[key] = value
    else out[key] = value
  }
  return out
}
