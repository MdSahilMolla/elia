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
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { ensureSecureDirectory, hardenSecureFile } from '../securePersistence.ts'
import { redactSecrets } from '../ui/redact.ts'
import {
  applyProjection, derivedEvents, isWorkspaceEventType, ownsObjective,
  type PersistedEvent, type ReplicatedEvent, type WorkspaceEventInput,
} from './events.ts'
import { migrate } from './schema.ts'
import { agentIdOf, classifyEvent, isAgentScoped, isTaskScoped } from './authority.ts'
import {
  toAgent, toAgentIdentity, toAgentMessage, toApproval, toDecision, toMember, toNode,
  toNodePresence, toObjective, toPresence, toProject, toReservation, toTask, toTaskGrant,
  toToken, toWorkspace, type Row,
} from './rows.ts'
import { LEASE_TTL_MS, type NodePresenceRecord, type TaskGrantRecord, type TaskRecord, type TaskStatus } from './types.ts'

export const DEFAULT_WORKSPACE_DB = join(process.cwd(), '.elia', 'workspace.sqlite')

const MAX_PAYLOAD_TEXT = 20_000

/** Default retention for `pruneOldEvents` — see its doc comment. */
const DEFAULT_KEEP_EVENTS = 200_000
const DEFAULT_EVENT_MAX_AGE_MS = 90 * 24 * 60 * 60_000

export interface EventQuery {
  sinceSeq?: number
  limit?: number
  objectiveId?: string
  types?: string[]
}

export type EventListener = (event: PersistedEvent) => void

export class WorkspaceStore {
  private readonly listeners = new Set<EventListener>()
  // Depth of nested `transact()` calls currently on the stack. `append` checks
  // this to decide whether to notify immediately (depth 0 — the normal,
  // non-nested case) or buffer until the outermost `transact()` actually
  // commits (depth > 0) — see `append` and `transact` below.
  private transactDepth = 0
  private pendingNotifications: PersistedEvent[] = []
  /** Set when an inbound event could not be projected. See `applyRemote`. */
  private lastReplicationError: string | undefined
  /**
   * This process's node id, persisted on first use.
   *
   * It is generated rather than derived from the workspace or the machine,
   * because it has to survive both a restart and a *second* workspace on the
   * same machine without colliding — and because a node's identity in the mesh is
   * its certificate fingerprint, which is learned later and then pinned onto this
   * same row (see `bindNodeFingerprint`).
   */
  readonly localNodeId: string

  private constructor(
    readonly path: string,
    private readonly db: Database,
    /** False for a read-only handle, which must not mint or touch a node row. */
    writable = true,
  ) {
    this.localNodeId = ensureLocalNode(db, writable)
  }

  /**
   * Observe every committed event. The workspace server uses this to fan events
   * out to connected clients; the listener runs after the transaction commits,
   * and a throwing listener never rolls back the write.
   */
  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Opens an existing workspace for reading only.
   *
   * A reader that can write is a hazard even when it only intends to read: a
   * writable handle takes locks it has no reason to hold, and the node-id
   * bootstrap below would make an inspection part of the state it is inspecting.
   * The database file must already exist — this reports what is there, so an
   * absent one is an error rather than something to create.
   */
  static openReadOnly(path: string = DEFAULT_WORKSPACE_DB): WorkspaceStore {
    const db = new Database(path, { readonly: true, strict: true })
    db.exec('PRAGMA busy_timeout = 5000;')
    return new WorkspaceStore(path, db, false)
  }

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
      // A read-only or already-detached handle cannot checkpoint; closing still
      // frees it either way. Deliberately not logged to diagnostics.ts: this is
      // the expected, frequent outcome for every read-only store instance, not
      // a failure worth a persistent record.
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
    const actorNode = input.actorNode ?? this.localNodeId
    this.assertMayAppend(input.type, input, actorNode)

    // The event plus anything it implies (see `derivedEvents`) commit together,
    // so a replica never sees the task finish without the objective finishing.
    const run = this.db.transaction(() => {
      const event = this.insertEvent(input, at, actorNode)
      const committed = [event]
      for (const derived of derivedEvents(this.db, event, actorNode)) committed.push(this.insertEvent(derived, at, actorNode))
      return committed
    })
    const committed = run()
    // Inside a `transact()` call (e.g. `acquireForTask`'s whole reserve loop),
    // this insert is only a savepoint of the outer transaction — it can still be
    // rolled back by a later `append` in the same `transact` callback throwing.
    // Notifying now would tell listeners (the Orchestrator, WebSocket clients)
    // about a row that may never actually persist. Buffer instead; `transact`
    // flushes this queue once the outermost transaction actually commits, and
    // discards it on rollback.
    for (const event of committed) {
      if (this.transactDepth > 0) this.pendingNotifications.push(event)
      else this.notify(event)
    }
    return committed[0]!
  }

  /**
   * Refuse an event whose node is not entitled to write it.
   *
   * This is the single choke point for partitioned ownership, and it is here
   * rather than in the RPC layer so that everything which mutates the workspace —
   * the orchestrator, the agent RPC handlers, the reconcilers, a replication
   * receive — inherits the check without knowing it exists.
   *
   * Two rules keep it inert for a single-node workspace, which is what stops this
   * from being a change to existing behaviour:
   *
   * - An objective with no `owner_node_id`, and a task with no
   *   `executor_node_id`, predate partitioning. They are unpartitioned, not
   *   unowned-and-therefore-locked, so the legacy single-writer rules apply.
   * - A node that owns nothing yet may register itself and create work; it is
   *   refused only when it tries to write *someone else's* objective.
   */
  private assertMayAppend(type: WorkspaceEventInput['type'], input: WorkspaceEventInput, actorNode: string): void {
    const authority = classifyEvent(type)

    if (authority === 'coordination') return
    if (authority === 'local') {
      if (actorNode !== this.localNodeId) throw new Error(`${type} is process-local and cannot be written by node ${actorNode}`)
      return
    }

    if (authority === 'executor') {
      if (isTaskScoped(type)) {
        if (!input.taskId) throw new Error(`${type} requires a taskId`)
        const task = this.db.query('SELECT executor_node_id FROM tasks WHERE id = ?').get(input.taskId) as Row | null
        const executor = task?.executor_node_id
        // No executor recorded: the task has not been dispatched to a node, so
        // there is no partition to respect yet.
        if (executor == null || executor === '') return
        if (String(executor) !== actorNode) {
          throw new Error(`task ${input.taskId} is granted to node ${String(executor)}; node ${actorNode} may not write ${type} for it`)
        }
        return
      }
      if (isAgentScoped(type)) {
        const agentId = agentIdOf(input.payload ?? {})
        if (!agentId) return
        const row = this.db.query('SELECT node_id FROM agents WHERE id = ?').get(agentId) as Row | null
        const agentNode = row?.node_id
        // An unknown or pre-v4 agent has no node to check against.
        if (agentNode == null || agentNode === '') return
        if (String(agentNode) !== actorNode) {
          throw new Error(`agent ${agentId} runs on node ${String(agentNode)}; node ${actorNode} may not report its state`)
        }
        return
      }
      return
    }

    // Owner-authoritative. `ObjectiveCreated` establishes the partition rather
    // than being bound by it, so it is checked against the workspace owner only.
    const owner = this.ownerFor(type, input)
    if (owner === undefined) return
    if (owner !== actorNode) {
      const scope = input.objectiveId ? `objective ${input.objectiveId}` : 'this workspace'
      throw new Error(`${scope} is owned by node ${owner}; node ${actorNode} may not write ${type}`)
    }
  }

  /**
   * The node entitled to write an owner-authoritative event, or `undefined` when
   * the row is not partitioned and therefore imposes no restriction.
   */
  private ownerFor(type: WorkspaceEventInput['type'], input: WorkspaceEventInput): string | undefined {
    // Workspace-level facts — members, tokens, agent identities — have no
    // objective to inherit an owner from.
    const workspaceLevel = type === 'WorkspaceCreated' || type.startsWith('Member') || type.startsWith('Token') || type.startsWith('AgentIdentity')
    if (type !== 'ObjectiveCreated' && !workspaceLevel && input.objectiveId) {
      const row = this.db.query('SELECT owner_node_id FROM objectives WHERE id = ?').get(input.objectiveId) as Row | null
      const owner = row?.owner_node_id
      if (owner == null || owner === '') return undefined
      return String(owner)
    }
    const row = this.db.query('SELECT owner_node_id FROM workspaces LIMIT 1').get() as Row | null
    const owner = row?.owner_node_id
    if (owner == null || owner === '') return undefined
    return String(owner)
  }

  /**
   * Apply an event that arrived from the peer.
   *
   * Three deliberate differences from `append`, each following from the replica
   * not being the writer (design note §6.6):
   *
   * - The authority guard is *not* re-run. It already ran on the node that wrote
   *   the event, against that node's ownership of that objective; re-running it
   *   here would compare the origin node against *this* workspace's owner and
   *   refuse every legitimate mirrored row.
   * - `derivedEvents` is not run. The events it implies were already appended by
   *   the originator, so deriving them again would duplicate them.
   * - `appendAudit` is not run. The chain is this node's record of this node's
   *   appends; adding a row the chain never hashed would break the verification
   *   that the chain exists to provide.
   *
   * Idempotent on the event `id`, so a re-sent batch costs one ignored insert.
   * Notifications still fire, so a replica's own orchestrator and clients see
   * the change — but derived events are then appended through the normal path,
   * which is what lets the owner complete an objective from a mirrored task.
   */
  applyRemote(event: ReplicatedEvent): boolean {
    let inserted: PersistedEvent | undefined
    let derived: PersistedEvent[] = []
    const apply = this.db.transaction(() => {
      inserted = this.insertRemote(event)
      if (!inserted) return
      const at = inserted.at
      derived = derivedEvents(this.db, inserted, this.localNodeId)
        .map((input) => this.insertEvent(input, at, this.localNodeId))
    })
    try {
      apply()
    } catch (err) {
      // A peer can send something this database cannot project: an objective it
      // has never seen, or a transition its state machine forbids. Two ways this
      // could be handled, both bad — refusing the batch would let one bad event
      // stall replication permanently, and letting the error escape would kill
      // the transport from inside a network callback. So the event is skipped
      // alone (its own transaction rolls it back completely) and the reason is
      // kept for whoever is showing replication health.
      this.lastReplicationError = `${event.type} ${event.id}: ${message(err)}`
      return false
    }
    if (!inserted) return false
    this.lastReplicationError = undefined
    for (const committed of [inserted, ...derived]) {
      if (this.transactDepth > 0) this.pendingNotifications.push(committed)
      else this.notify(committed)
    }
    return true
  }

  /**
   * Why the last inbound event was refused, if it was. Cleared by the next
   * successful apply, so it always describes the most recent outcome.
   */
  replicationError(): string | undefined {
    return this.lastReplicationError
  }

  /**
   * Insert a mirrored event and project it, without the guard, derivation or
   * audit chain. Caller owns the transaction.
   */
  private insertRemote(input: ReplicatedEvent): PersistedEvent | undefined {
    const payload = redactPayload(input.payload ?? {})
    // `INSERT OR IGNORE` on the event id is what makes replication idempotent: a
    // batch re-sent after a reconnect applies once, and the projection is skipped
    // for a row already present rather than applied twice.
    const info = this.db.query(
      `INSERT OR IGNORE INTO workspace_events (id, type, objective_id, task_id, actor_kind, actor_id, actor_node, payload_json, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(input.id, input.type, input.objectiveId ?? null, input.taskId ?? null, input.actorKind, input.actorId,
      input.actorNode ?? null, JSON.stringify(payload), input.at)
    if (Number(info.changes) === 0) return undefined
    // Marked in the same transaction as the projection below, so a crash cannot
    // leave an applied event looking locally originated and eligible for sending
    // back to the peer that sent it.
    this.db.query('INSERT OR IGNORE INTO inbound_events (id, peer_node_id, received_at) VALUES (?, ?, ?)')
      .run(input.id, input.actorNode ?? null, input.at)
    const event: PersistedEvent = {
      seq: Number(info.lastInsertRowid), id: input.id, type: input.type, actorKind: input.actorKind,
      actorId: input.actorId, actorNode: input.actorNode, objectiveId: input.objectiveId,
      taskId: input.taskId, payload, at: input.at,
    }
    applyProjection(this.db, event)
    return event
  }

  /** Insert one event row, project it, and chain it into the audit log. Caller owns the transaction. */
  private insertEvent(input: WorkspaceEventInput, at: string, actorNode: string): PersistedEvent {
    const id = `evt_${randomUUID().replaceAll('-', '')}`
    const payload = redactPayload(input.payload ?? {})
    const info = this.db.query(
      `INSERT INTO workspace_events (id, type, objective_id, task_id, actor_kind, actor_id, actor_node, payload_json, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, input.type, input.objectiveId ?? null, input.taskId ?? null, input.actorKind, input.actorId, actorNode, JSON.stringify(payload), at)
    const seq = Number(info.lastInsertRowid)
    const event: PersistedEvent = {
      seq, id, type: input.type, actorKind: input.actorKind, actorId: input.actorId, actorNode,
      objectiveId: input.objectiveId, taskId: input.taskId, payload, at,
    }
    applyProjection(this.db, event)
    this.appendAudit(event)
    return event
  }

  private notify(event: PersistedEvent): void {
    // Snapshot before iterating: a listener may synchronously append another
    // event (a client disconnect handler emits `PresenceLeft`), whose fan-out
    // runs `unsubscribe` and mutates `this.listeners` mid-loop — skipping
    // listeners or throwing a "Set changed size during iteration" error that the
    // catch below would then hide.
    for (const listener of [...this.listeners]) {
      if (!this.listeners.has(listener)) continue
      try {
        listener(event)
      } catch {
        // A subscriber (e.g. a dropped WebSocket) must not break the writer.
      }
    }
  }

  /**
   * Chain one append into the audit log.
   *
   * The chain is *per target* — per objective, or per task where the event names
   * one, with workspace-level events forming their own chain under a null target.
   * This is what makes the hash chain survive having two nodes: partitioned
   * ownership gives exactly one writer per objective, so that writer's local
   * order is a valid total order and its `prevHash` walk is sound. A single
   * global chain across two writers would read as tampered (`auditChainIntact`
   * would return false) the moment both appended at once, which is the failure
   * the whole partitioning exists to prevent.
   *
   * The cost is that the guarantee is now scoped per objective rather than over
   * the whole log, which is the honest trade: reordering events across two
   * different objectives is not detectable, and never was.
   */
  private appendAudit(event: PersistedEvent): void {
    const payloadHash = createHash('sha256').update(JSON.stringify(event.payload)).digest('hex')
    const target = event.taskId ?? event.objectiveId ?? null
    // `IS` rather than `=`: SQLite's `=` is never true against NULL, so `=` would
    // find no predecessor for workspace-level events and every one of them would
    // chain from the empty string.
    const previous = this.db.query('SELECT entry_hash FROM audit_log WHERE target IS ? ORDER BY seq DESC LIMIT 1').get(target) as Row | null
    const prevHash = previous ? String(previous.entry_hash) : ''
    const id = randomUUID()
    const entryHash = createHash('sha256')
      .update([prevHash, id, event.type, event.actorKind, event.actorId, target ?? '', payloadHash, event.at].join('␟'))
      .digest('hex')
    this.db.query(
      `INSERT INTO audit_log (id, action, actor_kind, actor_id, target, payload_hash, prev_hash, entry_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, event.type, event.actorKind, event.actorId, target, payloadHash, prevHash, entryHash, event.at)
  }

  /**
   * Verify the audit hash chain end to end.
   *
   * Each target's chain is verified independently and in order, because the
   * chains are independent: a per-objective chain is only required to be a valid
   * sequence for its own objective. Verification walks targets in sorted order
   * purely so the work is deterministic, not because there is an order between
   * them.
   *
   * Paginated by `seq` (keyset, not `OFFSET` — `OFFSET` would re-scan every
   * already-verified row on each batch) so a long-lived audit log is verified a
   * few thousand rows at a time instead of loading the whole table into one
   * array — `bun:sqlite` calls are synchronous, so a giant `SELECT *` here would
   * block the event loop (and the WS server) for the duration.
   */
  auditChainIntact(): boolean {
    const BATCH = 5_000
    const targets = this.db.query('SELECT DISTINCT target FROM audit_log').all() as Row[]
    for (const { target } of targets) {
      // `IS ?` binds NULL correctly (SQLite's `=` never matches NULL), which is
      // what puts workspace-level events in their own chain.
      const key = target == null ? null : String(target)
      let prevHash = ''
      let afterSeq = 0
      for (;;) {
        const rows = this.db.query('SELECT * FROM audit_log WHERE target IS ? AND seq > ? ORDER BY seq ASC LIMIT ?')
          .all(key, afterSeq, BATCH) as Row[]
        if (rows.length === 0) break
        for (const row of rows) {
          if (String(row.prev_hash) !== prevHash) return false
          const recomputed = createHash('sha256')
            .update([prevHash, row.id, row.action, row.actor_kind, row.actor_id, row.target ?? '', row.payload_hash, row.created_at].join('␟'))
            .digest('hex')
          if (recomputed !== String(row.entry_hash)) return false
          prevHash = String(row.entry_hash)
          afterSeq = Number(row.seq)
        }
        if (rows.length < BATCH) break
      }
    }
    return true
  }

  /**
   * Delete `workspace_events` rows outside the retention window, keeping
   * `audit_log` untouched — see the module doc: `audit_log` is the
   * tamper-evident chain (verified by `auditChainIntact`), and pruning rows out
   * from under it would either break the chain or require a checkpoint-anchor
   * scheme this codebase does not have yet. `workspace_events` has no such
   * guarantee to preserve: every projection it feeds (`tasks`, `objectives`, …)
   * is already durably up to date, so deleting an old event only shrinks the
   * replay/history log, not current state.
   *
   * Conservative by construction: a row is only pruned when it is BOTH older
   * than `maxAgeMs` AND beyond the most recent `keepEvents` rows, so whichever
   * limit would keep more history wins. Cheap to call repeatedly — once the
   * table is within both limits this is a no-op single-row-range lookup, not a
   * table scan, so it is safe to wire into an existing periodic sweep (e.g. the
   * workspace server's lease-reconcile timer) rather than needing its own
   * scheduler.
   */
  pruneOldEvents(options: { keepEvents?: number; maxAgeMs?: number; now?: number } = {}): number {
    const keepEvents = options.keepEvents ?? DEFAULT_KEEP_EVENTS
    const maxAgeMs = options.maxAgeMs ?? DEFAULT_EVENT_MAX_AGE_MS
    const now = options.now ?? Date.now()
    const cutoffAt = new Date(now - maxAgeMs).toISOString()
    const seqFloor = Math.max(0, this.latestSeq() - keepEvents)
    if (seqFloor <= 0) return 0
    const result = this.db.query('DELETE FROM workspace_events WHERE seq <= ? AND at < ?').run(seqFloor, cutoffAt)
    return Number(result.changes)
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

  reservations(activeOnly = true, filter: { taskId?: string } = {}) {
    const clauses: string[] = []
    const values: unknown[] = []
    if (activeOnly) clauses.push('released_at IS NULL')
    if (filter.taskId) {
      clauses.push('task_id = ?')
      values.push(filter.taskId)
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    return (this.db.query(`SELECT * FROM reservations ${where} ORDER BY acquired_at`).all(...values as never[]) as Row[]).map(toReservation)
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

  nodes() {
    return (this.db.query('SELECT * FROM nodes ORDER BY first_seen_at').all() as Row[]).map(toNode)
  }

  node(id: string) {
    const row = this.db.query('SELECT * FROM nodes WHERE id = ?').get(id) as Row | null
    return row ? toNode(row) : undefined
  }

  /**
   * Node-level presence, newest beat first.
   *
   * Every node with a known presence row is returned, stale or not, flagged by
   * `online`: a machine that dropped off the mesh must still be *reportable*
   * ("last seen 4 minutes ago"), which it cannot be if the row is filtered out
   * here. Callers that only want live nodes filter on the flag.
   */
  nodePresence(staleAfterMs = 90_000, now = Date.now()): Array<NodePresenceRecord & { online: boolean }> {
    const cutoff = new Date(now - staleAfterMs).toISOString()
    const rows = this.db.query('SELECT * FROM node_presence ORDER BY last_seen_at DESC').all() as Row[]
    return rows.map((row) => {
      const record = toNodePresence(row)
      return { ...record, online: record.lastSeenAt >= cutoff }
    })
  }

  /**
   * Pin this node's certificate fingerprint, learned from the file plane.
   *
   * This is the whole of node identity as far as Elia is concerned: the
   * sidecar's transport already authenticates both machines against a pinned
   * certificate, so binding to that fingerprint gives the control plane exactly
   * one identity per machine instead of a second keypair minted here
   * (design note §6.1). Two independent identity systems for the same two
   * machines would be a defect.
   */
  bindNodeFingerprint(fingerprint: string, name = hostname()): void {
    const row = this.db.query('SELECT * FROM nodes WHERE id = ?').get(this.localNodeId) as Row | null
    const firstSeenAt = row ? String(row.first_seen_at) : new Date().toISOString()
    this.db.query(
      `INSERT INTO nodes (id, name, kind, fingerprint, is_local, first_seen_at, last_seen_at)
       VALUES (?, ?, 'mesh', ?, 1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET fingerprint = excluded.fingerprint, kind = 'mesh', last_seen_at = excluded.last_seen_at`,
    ).run(this.localNodeId, name, fingerprint, firstSeenAt, new Date().toISOString())
  }

  /** The node a task is granted to, and whether that grant is still open. */
  taskGrants(taskId: string): TaskGrantRecord[] {
    return (this.db.query('SELECT * FROM task_grants WHERE task_id = ? ORDER BY granted_at').all(taskId) as Row[]).map(toTaskGrant)
  }

  hasActiveGrant(taskId: string, nodeId: string): boolean {
    const row = this.db.query(
      'SELECT 1 AS ok FROM task_grants WHERE task_id = ? AND node_id = ? AND released_at IS NULL LIMIT 1',
    ).get(taskId, nodeId) as Row | null
    return row !== null
  }

  /** How far this node has consumed `peerNodeId`'s log. */
  replicationCursor(peerNodeId: string): number {
    const row = this.db.query('SELECT last_seq FROM replication_state WHERE peer_node_id = ?').get(peerNodeId) as Row | null
    return row ? Number(row.last_seq) : 0
  }

  setReplicationCursor(peerNodeId: string, seq: number): void {
    this.db.query(
      `INSERT INTO replication_state (peer_node_id, last_seq, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(peer_node_id) DO UPDATE SET last_seq = excluded.last_seq, updated_at = excluded.updated_at`,
    ).run(peerNodeId, seq, new Date().toISOString())
  }

  /**
   * Which of these event ids arrived from a peer rather than being written here.
   *
   * One query for the whole batch: the send filter asks this for every event in
   * each flush, and a per-event lookup would be a query per row on a table that
   * grows without bound.
   */
  inboundEventIds(ids: string[]): Set<string> {
    if (ids.length === 0) return new Set()
    const placeholders = ids.map(() => '?').join(',')
    const rows = this.db.query(`SELECT id FROM inbound_events WHERE id IN (${placeholders})`).all(...ids) as Row[]
    return new Set(rows.map((row) => String(row.id)))
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
   *
   * Scoped to what *this* node may write. A follower that reclaimed a lease for
   * an objective it does not own would both fail the authority guard and — worse,
   * if that guard were ever relaxed — race the owner into two contradictory
   * recoveries for one task. Ownership scoping fixes it by construction rather
   * than by an idempotence key, which is the design note's stated preference.
   */
  reconcileLeases(now = Date.now()): { tasks: string[]; agents: string[]; reservations: string[] } {
    const tasks: string[] = []
    const agents: string[] = []
    const reservations: string[] = []

    for (const task of this.tasks({ status: ['assigned', 'in-progress'] })) {
      if (!ownsObjective(this.db, task.objectiveId, this.localNodeId)) continue
      if (!this.mayExecute(task, this.localNodeId)) continue
      // A lease that can never expire must not hold a task forever (M-33).
      //
      // No lease at all reads back as `undefined` — SQL NULL through `optNum`.
      // For an `assigned` task that is legitimate: none has been granted yet,
      // and it stays put. For an `in-progress` task it never is: `TaskStarted`
      // is the only way into that status and it always writes a lease, so a
      // NULL there means one was lost. The way that happened was a malformed
      // lease coerced to `NaN`, which SQLite stores as NULL — indistinguishable
      // from "never leased", so the old finite-only guard let it through on
      // every pass and the task was stranded with no agent behind it.
      // `leaseExpiry` in events.ts now stops new ones being written; this
      // reclaims any already on disk. A non-finite in-memory value is treated
      // as expired too, matching the heartbeat and reservation checks below.
      const expiresAt = task.leaseExpiresAt
      const stranded = expiresAt === undefined && task.status === 'in-progress'
      if (stranded || (expiresAt !== undefined && (!Number.isFinite(expiresAt) || expiresAt <= now))) {
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
      // Only this machine's own agents. Faulting a mirrored agent would append an
      // agent-scoped event about another node's process, which the guard refuses
      // anyway — and the node that *can* fault it is the one whose heartbeat
      // window actually elapsed.
      if (agent.nodeId !== undefined && agent.nodeId !== this.localNodeId) continue
      const alive = agent.status !== 'cancelled' && agent.status !== 'completed' && agent.status !== 'failed'
      // `Date.parse` of a malformed/unset heartbeat yields `NaN`, and
      // `NaN <= cutoff` is false — the agent would never be faulted. A
      // non-expired, non-heartbeating agent is a stuck agent; expire it
      // rather than leave it immortal.
      const heartbeatAt = Date.parse(agent.lastHeartbeatAt)
      if (alive && (Number.isNaN(heartbeatAt) || heartbeatAt <= staleCutoff)) {
        this.append({
          type: 'AgentStateChanged', actorKind: 'system', actorId: 'lease-reconciler',
          payload: { id: agent.id, status: 'failed', lastError: 'missed heartbeat window', currentTaskId: null },
        })
        agents.push(agent.id)
      }
    }

    for (const reservation of this.reservations(true)) {
      const task = this.task(reservation.taskId)
      // A reservation is executor-scoped, so expiring one that belongs to the
      // peer is the peer's to release — mirror it, do not reclaim it.
      if (task === undefined || !this.mayExecute(task, this.localNodeId)) continue
      // `reservations(true)` should only return rows with a real expiry, but a
      // malformed persisted value must fail closed: an unbounded/`null`/`NaN`
      // expiry must expire the reservation (freeing the file for others) rather
      // than block the task forever.
      const expiresAt = reservation.expiresAt
      if (!Number.isFinite(expiresAt) || expiresAt <= now) {
        this.append({
          type: 'ReservationExpired', actorKind: 'system', actorId: 'lease-reconciler',
          taskId: reservation.taskId, payload: { id: reservation.id },
        })
        reservations.push(reservation.id)
      }
    }

    return { tasks, agents, reservations }
  }

  /**
   * Run `fn` inside a single SQLite transaction so a caller's read-then-write
   * sequence (reservation acquisition checks for a conflict and only then
   * inserts) commits or rolls back as one unit and cannot be interleaved by
   * another writer — the `append`s inside become savepoints of this outer
   * transaction.
   *
   * Listener notification for those inner `append`s is deferred (see `append`)
   * until this — the outermost — call actually commits, and discarded if it
   * rolls back, so a subscriber is never told about a row that a later `append`
   * in the same `fn` caused to be rolled back.
   */
  transact<T>(fn: () => T): T {
    const isOutermost = this.transactDepth === 0
    this.transactDepth += 1
    try {
      const result = this.db.transaction(fn)()
      if (isOutermost) this.flushPendingNotifications()
      return result
    } catch (err) {
      if (isOutermost) this.pendingNotifications = []
      throw err
    } finally {
      this.transactDepth -= 1
    }
  }

  private flushPendingNotifications(): void {
    if (this.pendingNotifications.length === 0) return
    const pending = this.pendingNotifications
    this.pendingNotifications = []
    for (const event of pending) this.notify(event)
  }

  /**
   * May `nodeId` run this task?
   *
   * A task with no `executor_node_id` is unpartitioned and answers to whoever
   * the legacy rules allow. Once it *is* set, only that node may execute it —
   * which is why a follower mirrors the row but never acquires it, and why the
   * owner dispatches instead of running work on the other machine's behalf.
   */
  mayExecute(task: TaskRecord, nodeId: string): boolean {
    return task.executorNodeId === undefined || task.executorNodeId === nodeId
  }

  /**
   * Whether this node owns an objective — the single predicate the orchestrator
   * uses to decide what it is entitled to decide.
   *
   * Null owner means unpartitioned (pre-v4, or created before node identity
   * existed) and answers true, which is what keeps a single-node workspace
   * behaving exactly as it did.
   */
  ownsObjective(objectiveId: string): boolean {
    return ownsObjective(this.db, objectiveId, this.localNodeId)
  }

  /**
   * Work this node may actually pick up: ready, dependencies satisfied, and not
   * partitioned away to the peer.
   *
   * This is what the orchestrator should schedule from. Filtering by executor
   * here rather than at each call site is deliberate — a missed filter becomes a
   * cross-node write that the authority guard rejects, and that rejection lands
   * as a thrown error inside a background timer where nobody will read it.
   */
  executableTasks(): TaskRecord[] {
    return this.tasks({ status: ['ready'] }).filter((task) => this.mayExecute(task, this.localNodeId))
  }

  /** Escape hatch for advanced queries and tests. Prefer the typed getters. */
  raw(): Database {
    return this.db
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
    actorNode: row.actor_node == null ? undefined : String(row.actor_node),
    objectiveId: row.objective_id == null ? undefined : String(row.objective_id),
    taskId: row.task_id == null ? undefined : String(row.task_id),
    payload, at: String(row.at),
  }
}

/**
 * Read this workspace's node id, creating it on first use.
 *
 * The row is written outside a transaction wrapper because it happens in the
 * constructor, before any caller has a handle: an id is minted, inserted, and
 * read back in one statement so a crash mid-write cannot leave two ids behind
 * (`INSERT OR IGNORE` + `SELECT` is atomic enough here — SQLite serialises
 * writers, and the loser of a race simply reads the winner's id).
 *
 * `hostname()` is stored as a label only. It is never an identity: two
 * machines on a LAN routinely share a name, and the whole point of the id is
 * that it does not.
 */
function ensureLocalNode(db: Database, writable = true): string {
  const existing = db.query('SELECT id FROM nodes WHERE is_local = 1 LIMIT 1').get() as Row | null
  if (existing?.id) return String(existing.id)
  // A read-only handle that found no local node has nothing to report rather
  // than something to create. Returning empty makes the caller say so, instead of
  // writing through a connection opened specifically not to.
  if (!writable) return ''
  const id = `nd_${randomUUID().replaceAll('-', '')}`
  const at = new Date().toISOString()
  db.query(
    `INSERT OR IGNORE INTO nodes (id, name, kind, fingerprint, is_local, first_seen_at, last_seen_at)
     VALUES (?, ?, 'local', NULL, 1, ?, ?)`,
  ).run(id, hostname(), at, at)
  const row = db.query('SELECT id FROM nodes WHERE is_local = 1 LIMIT 1').get() as Row | null
  return row ? String(row.id) : id
}

/**
 * Prepare a payload for the durable log and the wire.
 *
 * Redaction is opt-IN by key: only the free-text fields a human or agent could
 * paste a credential into are secret-scrubbed. Everything else (ids, hashes,
 * globs, file paths, resource names) is length-bounded only — running the secret
 * regex over an identifier like `tsk_..._api` corrupts it (`sk_...` looks like a
 * key), which then collides two rows on one primary key.
 */
const FREE_TEXT_KEYS = new Set([
  'goal', 'instructions', 'instruction', 'body', 'detail', 'error', 'reason',
  'notes', 'note', 'title', 'focus', 'report', 'blockedReason', 'summary',
  'acceptanceCriteria', 'verificationCommands',
])
const LONG_TEXT_KEYS = new Set(['goal', 'instructions', 'instruction', 'body', 'detail', 'report'])

const MAX_ARRAY_ITEMS = 500
const MAX_NESTED_TEXT = 4_000
// `refs` and similar fields are declared shallow (see WorkspaceStore callers —
// e.g. `{ taskId, filePath, eventSeq }`) and reach here as parsed JSON from an
// RPC caller with zero shape validation, so this only needs to stop a
// pathological/adversarial depth from blowing the stack, not support real nesting.
const MAX_REDACT_DEPTH = 6

function boundText(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

/** A string's own key decides whether it is secret-scrubbed — see the module doc above `redactPayload`. */
function redactString(key: string, value: string, max: number): string {
  return FREE_TEXT_KEYS.has(key) ? boundText(redactSecrets(value), max) : boundText(value, max)
}

/**
 * Recurse into an array or plain-object field the same opt-in-by-key way the
 * top-level string case works. This must NOT run every string through
 * `redactSecrets` unconditionally: an ID-shaped value like `refs.taskId` (compared
 * with `===` elsewhere — see rpcOrchestration.ts) or a `dependsOn`/`files` entry
 * can incidentally match the secret patterns (e.g. `tsk_...` contains `sk_...`)
 * and get corrupted, exactly the failure the module doc warns about for the
 * string case. So a child value's redaction is still gated by its own key name;
 * only the bound (length/count) applies unconditionally.
 */
function redactNested(value: unknown, depth: number): unknown {
  if (depth > MAX_REDACT_DEPTH) return '[too-deep]'
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => (typeof item === 'string' ? boundText(item, MAX_NESTED_TEXT) : redactNested(item, depth + 1)))
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>).slice(0, MAX_ARRAY_ITEMS)) {
      out[key] = typeof child === 'string' ? redactString(key, child, MAX_NESTED_TEXT) : redactNested(child, depth + 1)
    }
    return out
  }
  return value
}

function redactPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === 'string') {
      const max = LONG_TEXT_KEYS.has(key) ? MAX_PAYLOAD_TEXT : 4_000
      out[key] = redactString(key, value, max)
    } else if (Array.isArray(value)) {
      out[key] = value.slice(0, MAX_ARRAY_ITEMS).map((item) => (typeof item === 'string' ? redactString(key, item, MAX_NESTED_TEXT) : redactNested(item, 1)))
    } else if (value && typeof value === 'object') {
      out[key] = redactNested(value, 1)
    } else {
      out[key] = value
    }
  }
  return out
}
