/**
 * Shared session contract for elia's parallel multi-session orchestration
 * (`elia sessions …`).
 *
 * This module is the coordination boundary between independent workstreams.
 * It is deliberately dependency-free (no imports of other elia modules) so any
 * agent can build against it without dragging in work-in-progress code.
 *
 * Construction rules:
 *   - A `SessionId`/`SessionName` can only be produced by `makeSessionId()` /
 *     `makeSessionName()` (or by widening a value) — the unique-symbol brands
 *     stop two modules from silently passing unrelated strings to each other.
 *   - Session handles and memory slices must never be shared by reference
 *     between sessions. Anything passed to another session must be copied or
 *     read-only (see MemorySlice, frozen lesson arrays).
 */

export interface SessionIdBrand {
  readonly __sessionId: unique symbol
}
export interface SessionNameBrand {
  readonly __sessionName: unique symbol
}

export type SessionId = string & SessionIdBrand
export type SessionName = string & SessionNameBrand

/** Branded session id. Ids are machine-unique, opaque and short. */
export function makeSessionId(raw: string = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`): SessionId {
  return raw as SessionId
}

/**
 * Branded human-friendly session name (e.g. `feat/rate-limit`).
 * Names may be a branch-like label; they are not required to be unique, but
 * `SessionBus.resolve` refuses ambiguous name lookups.
 */
export function makeSessionName(raw: string): SessionName {
  return raw as SessionName
}

export const SESSION_STATUSES = ['idle', 'running', 'waiting-input', 'blocked', 'done', 'errored'] as const
export type SessionStatus = (typeof SESSION_STATUSES)[number]

export const SessionStatusEnum: Record<'IDLE' | 'RUNNING' | 'WAITING_INPUT' | 'BLOCKED' | 'DONE' | 'ERRORED', SessionStatus> = {
  IDLE: 'idle',
  RUNNING: 'running',
  WAITING_INPUT: 'waiting-input',
  BLOCKED: 'blocked',
  DONE: 'done',
  ERRORED: 'errored',
}

export function isSessionStatus(value: unknown): value is SessionStatus {
  return typeof value === 'string' && (SESSION_STATUSES as readonly string[]).includes(value)
}

/**
 * The memory a session sees on fork:
 *   - project-level lessons and notes are shared read-only (frozen arrays; the
 *     project lesson store is never mutated by a session),
 *   - local scratch (localLessons/localNotes) is private and mutable per session.
 */
export interface MemorySlice {
  /** Project-level lesson strings — read-only by contract; do not mutate. */
  lessons: readonly string[]
  /** Project-level notes (the durable "second brain") — read-only by contract. */
  projectNotes: readonly string[]
  /** Session-local scratch lessons, private to this session. */
  localLessons: string[]
  /** Session-local scratch notes, private to this session. */
  localNotes: string[]
}

/**
 * A named checkpoint a dependency can wait on. A dependency is satisfied when
 * the upstream session reaches DONE, or emits the named checkpoint (via
 * `SessionBus.noteCheckpoint`), whichever the upstream declares first.
 */
export interface SessionCheckpoint {
  /** Short checkpoint id, e.g. `auth-schema-finalized`. */
  name: string
  /** Emitted upstream only once; later emissions are no-ops. */
  emittedAt?: number
  data?: unknown
}

export interface SessionDependency {
  /** The upstream session this session waits on. */
  on: SessionId
  /** Named checkpoint within the upstream that must fire first, else its DONE. */
  checkpoint?: string
  satisfied: boolean
}

export const DELEGATION_MODES = ['after-step', 'now', 'new-session'] as const
export type DelegationMode = (typeof DELEGATION_MODES)[number]

export type DelegationSource = 'quickchat' | 'cli'
export type DelegationStatus = 'queued' | 'active' | 'done' | 'cancelled' | 'failed'

/**
 * A task queued into a session by the CLI (older records: by /quickchat, now
 * retired — mid-turn messages are answered by the live lane). Delegation injects
 * into the target's queue append-only — it never mutates a running plan step:
 * the runner pops the head of the queue at a safe step boundary.
 */
export interface DelegationRecord {
  id: string
  source: DelegationSource
  goal: string
  targetSession: SessionId
  mode: DelegationMode
  status: DelegationStatus
  createdAt: number
  /** For after-step mode: the plan step index the task lands after. */
  queuedAfterStep?: number
  /** For new-session mode: the spawned session's name (auto-slugified goal). */
  spawnedName?: SessionName
  error?: string
}

/**
 * A structured "context drop" published by one session that other sessions can
 * subscribe to. A drop is injected into a subscriber as a context block, not
 * as a new user message, so it never interrupts the subscriber's ongoing task.
 */
export interface ContextDrop {
  id: string
  name: string
  fromSession: SessionId
  payload: unknown
  emittedAt: number
}

export interface SessionHandle {
  id: SessionId
  name: SessionName
  status: SessionStatus
  /** Absolute path of this session's isolated git worktree, when one exists. */
  worktree?: string
  /** Append-only task queue; DelegationRecords land here. */
  taskQueue: DelegationRecord[]
  memorySlice: MemorySlice
  lastActivity: number
  /** Number of sub-agents currently running inside this session. */
  activeAgents: number
  /** Cross-session context the session chose to expose (never auto-copied). */
  sharedContext: Record<string, unknown>
  dependencies: SessionDependency[]
  /** Named checkpoints this session has emitted, by name. */
  checkpoints: Map<string, SessionCheckpoint>
  /** Short one-line current/previous step label for the status bar. */
  lastTask?: string
}

export type CreateHandleOptions = Partial<
  Pick<SessionHandle, 'worktree' | 'lastTask' | 'dependencies' | 'sharedContext'>
> & { from?: SessionId }

export type SessionEvent =
  | { type: 'session:started'; sessionId: SessionId; name: SessionName }
  | { type: 'session:completed'; sessionId: SessionId }
  | { type: 'session:blocked'; sessionId: SessionId; reason: string }
  | { type: 'session:errored'; sessionId: SessionId; error: string }
  | { type: 'cross:context-sync'; sessionId: SessionId; drop: ContextDrop }

/**
 * The central session registry. `bus.ts` implements this; consumers code
 * against this interface so they never depend on the concrete store.
 */
export interface SessionBus {
  /** The session the current process/terminal is focused on. */
  activeSession: SessionId | undefined
  setActiveSession(id: SessionId | undefined): void

  /** Starts a new isolated session (id allocated here), from a parent if given (memory forked). */
  create(name: SessionName, opts?: CreateHandleOptions): SessionHandle
  /** Forks an isolated child session inherit most of `from`'s memory slice. */
  fork(from: SessionId, name: SessionName): SessionHandle
  get(id: SessionId): SessionHandle | undefined
  byName(name: SessionName): SessionHandle | undefined
  /** Resolves bare `id|name` text — an ambiguous name resolves to undefined. */
  resolve(ref: string): SessionHandle | undefined
  list(): SessionHandle[]
  update(id: SessionId, patch: Partial<Omit<SessionHandle, 'id'>>): void
  setStatus(id: SessionId, status: SessionStatus, reason?: string): void
  /** Appends a delegation to a session's queue (append-only). */
  pushTask(id: SessionId, record: DelegationRecord): void
  /** Registers a named checkpoint and emits session:blocked-state change events as dependencies clear. */
  noteCheckpoint(id: SessionId, name: string, data?: unknown): void
  /** Emits a context drop to every subscriber and the cross:context-sync event. */
  emitDrop(drop: ContextDrop): void
  /** Subscribe target session to a drop name; returns an unsubscribe function. */
  subscribeDrop(target: SessionId, dropName: string, cb: (drop: ContextDrop) => void): () => void
  emit(event: SessionEvent): void
  /** Returns an unsubscribe function. */
  on(listener: (event: SessionEvent) => void): () => void
  /** Removes a session from the registry (terminal state, emits session:completed). */
  kill(id: SessionId): void
}

/**
 * Declared module-level accessor every cross-module caller uses.
 * Implemented by `bus.ts`. A singleton per process keeps one registry for the
 * status bar and the CLI.
 */
export declare function getSessionBus(): SessionBus

/**
 * Cross-session memory-slice sync, implemented in `sync.ts`.
 * A diff between two sessions' memory slices/project notes plus any conflicts
 * where both changed the same lesson/note differently.
 */
export interface SyncDiff {
  /** Keys present only in A. */
  aOnly: string[]
  /** Keys present only in B. */
  bOnly: string[]
  /** Keys both changed differently; the merger must present these. */
  conflicts: SyncConflict[]
}

export type SyncChoice = 'a' | 'b' | 'both' | 'drop'

export interface SyncConflict {
  key: string
  a?: string
  b?: string
  chosen?: SyncChoice
}

export interface SyncReport {
  diff: SyncDiff
  /** Keyed by conflict key for the merge result. */
  resolved: Array<{ key: string; choice: SyncChoice }>
}

/**
 * Filesystem scoping for session-isolated work. `scope.ts` implements
 * `withSessionScope`; the autonomy governor consults it so file writes from a
 * session agent are confined to that session's worktree.
 */
export interface SessionScope {
  sessionId: SessionId
  worktree: string | undefined
}