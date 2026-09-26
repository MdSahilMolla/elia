/**
 * Task delegation for elia's parallel session orchestration. A task is injected append-only into the *target session's*
 * `taskQueue` — delegation never mutates, reorders or interrupts a running
 * plan step. The run loop reads the queue only at safe step boundaries via
 * `popNextTask` and reports outcome via `trackDelegation`.
 *
 * Three injection modes:
 *   - `after-step`  — quietly queue into the current session; runs once the
 *     current plan step index passes `queuedAfterStep` (0 = after the current
 *     step, non-interrupting).
 *   - `now`         — queue into the current session with `queuedAfterStep ===
 *     -1`; the runner bumps it to run next at the next safe ATOMIC boundary.
 *   - `new-session` — fork a new parallel session (`auto-<slugified goal>`)
 *     inheriting the parent's memory, and queue the task as its first job.
 */
import {
  makeSessionName,
  type DelegationMode,
  type DelegationRecord,
  type DelegationSource,
  type DelegationStatus,
  type SessionBus,
  type SessionHandle,
  type SessionId,
} from './types.ts'
import { getSessionBus } from './bus.ts'

export const SLUG_MAX = 48

/**
 * Turns a free-text goal into a filesystem/branch-friendly slug: lowercase,
 * runs of non-alphanumerics collapsed to a single dash, trimmed, capped at
 * SLUG_MAX chars. Anything that yields no alphanumerics becomes `task`.
 */
export function slugifyGoal(goal: string): string {
  const slug = goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, '')
  return slug.length > 0 ? slug : 'task'
}

let recordSeq = 0

function delegationId(source: DelegationSource): string {
  recordSeq += 1
  return `delegation-${source}-${Date.now().toString(36)}-${recordSeq.toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

function sessionLabel(bus: SessionBus, id: SessionId): string {
  return bus.get(id)?.name ?? id
}

export interface DelegateTaskOptions {
  goal: string
  /** The session to queue into (after-step/now) or fork from (new-session). */
  target?: SessionId
  mode: DelegationMode
  source?: DelegationSource
  bus?: SessionBus
  /** For after-step: how many further plan steps to wait through (0 = after the current step). */
  planStepCount?: number
  slugify?: (goal: string) => string
}

export interface DelegateTaskResult {
  record: DelegationRecord
  confirmation: string
  /** new-session mode only: the id of the spawned session. */
  spawned?: SessionId
}

export async function delegateTask(opts: DelegateTaskOptions): Promise<DelegateTaskResult> {
  const bus = opts.bus ?? getSessionBus()
  // Records written before /quickchat was retired carry 'quickchat'; it stays
  // the default so their ids keep one shape.
  const source = opts.source ?? 'quickchat'
  const slugify = opts.slugify ?? slugifyGoal

  if (!opts.goal || opts.goal.trim().length === 0) {
    throw new Error('delegateTask requires a non-empty `goal`')
  }

  if (opts.mode !== 'new-session') {
    const target = opts.target ?? bus.activeSession
    if (!target) {
      throw new Error(`Cannot queue ${opts.mode === 'now' ? '"now"' : 'a task'}: no active session to queue into.`)
    }
    const record: DelegationRecord = {
      id: delegationId(source),
      source,
      goal: opts.goal,
      targetSession: target,
      mode: opts.mode,
      status: 'queued',
      createdAt: Date.now(),
      queuedAfterStep: opts.mode === 'now' ? -1 : (opts.planStepCount ?? 0),
    }
    bus.pushTask(target, record)
    const confirmation =
      opts.mode === 'now'
        ? `Queued in session ${sessionLabel(bus, target)} after the current step`
        : `Queued in session ${sessionLabel(bus, target)} after step ${record.queuedAfterStep}`
    return { record, confirmation }
  }

  const slug = slugify(opts.goal)
  const name = makeSessionName(`auto-${slug}`)
  const handle = bus.create(name, { from: bus.activeSession ?? opts.target })
  const record: DelegationRecord = {
    id: delegationId(source),
    source,
    goal: opts.goal,
    targetSession: handle.id,
    mode: 'new-session',
    status: 'queued',
    createdAt: Date.now(),
    spawnedName: name,
  }
  bus.pushTask(handle.id, record)
  return { record, confirmation: `Spawned session auto-${slug}`, spawned: handle.id }
}

export interface PopNextTaskOptions {
  /**
   * Runner sets this when calling right after an atomic step (interior to a
   * plan step): only `now` records (queuedAfterStep === -1) are eligible.
   * False at a full plan-step boundary, where after-step heads may also pop.
   */
  interruptAfterStep?: boolean
  /**
   * 0-based index of the plan step about to run. An after-step record with
   * queuedAfterStep n pops only when planStepIndex >= n (n = 0 -> after the
   * current step). Records without queuedAfterStep (new-session tasks) run at
   * the first boundary.
   */
  planStepIndex?: number
  /** The registry owning `handle`. Optional only when the handle comes from the process singleton. */
  bus?: SessionBus
}

function busFor(handle: SessionHandle, preferred: SessionBus | undefined): SessionBus | undefined {
  if (preferred) return preferred
  const singleton = getSessionBus()
  return singleton.get(handle.id) === handle ? singleton : undefined
}

function activate(handle: SessionHandle, record: DelegationRecord, opts: PopNextTaskOptions): DelegationRecord {
  record.status = 'active'
  const nextQueue = handle.taskQueue.map((r) => (r.id === record.id ? record : r))
  const bus = busFor(handle, opts.bus)
  if (bus) bus.update(handle.id, { taskQueue: nextQueue })
  return record
}

/**
 * Runner-side reader. Call ONLY at a safe step boundary. Pops the first
 * `now` record whenever one is queued, otherwise the head of the queue once
 * its step boundary is reached. Marks the returned record `active` via
 * bus.update and touches nothing else — the plan and the queue order are
 * never reordered or spliced.
 */
export function popNextTask(handle: SessionHandle, opts: PopNextTaskOptions = {}): DelegationRecord | undefined {
  const queued = handle.taskQueue.filter((record) => record.status === 'queued')
  if (queued.length === 0) return undefined

  const nowRecord = queued.find((record) => record.queuedAfterStep === -1)
  if (nowRecord) return activate(handle, nowRecord, opts)

  const head = queued[0]!
  if (opts.interruptAfterStep) return undefined
  if (((opts.planStepIndex ?? 0) < (head.queuedAfterStep ?? 0))) return undefined
  return activate(handle, head, opts)
}

/** Locates a delegation record across every session in the registry. */
export function findRecord(bus: SessionBus, recordId: string): { handle: SessionHandle; index: number } | undefined {
  for (const handle of bus.list()) {
    const index = handle.taskQueue.findIndex((record) => record.id === recordId)
    if (index !== -1) return { handle, index }
  }
  return undefined
}

/**
 * Flipped a record's status (queued -> active -> done / cancelled / failed)
 * wherever it lives. Append-only and identity-preserving: the record object is
 * mutated in place (status only), so the queue keeps the same reference/order
 * and length; `bus.update` broadcasts the change to the registry.
 */
export function trackDelegation(recordId: string, bus: SessionBus, nextStatus: DelegationStatus): void {
  const found = findRecord(bus, recordId)
  if (!found) {
    throw new Error(`Unknown delegation record ${recordId} — cannot mark ${nextStatus}`)
  }
  const { handle, index } = found
  const record = handle.taskQueue[index]!
  record.status = nextStatus
  bus.update(handle.id, { taskQueue: [...handle.taskQueue] })
}

export interface DelegationStatusRow {
  sessionName: string
  tasks: DelegationRecord[]
}

export interface DelegationStatusOptions {
  /** Single status filter; default shows queued + active. */
  status?: DelegationStatus
}

const DEFAULT_STATUSES: ReadonlySet<DelegationStatus> = new Set(['queued', 'active'])

/**
 * Every session's delegated tasks (queued/active by default). Sessions with no
 * matching tasks are omitted.
 */
export function delegationStatus(bus?: SessionBus, opts: DelegationStatusOptions = {}): DelegationStatusRow[] {
  const registry = bus ?? getSessionBus()
  const wanted = opts.status === undefined ? DEFAULT_STATUSES : new Set<DelegationStatus>([opts.status])
  const rows: DelegationStatusRow[] = []
  for (const handle of registry.list()) {
    const tasks = handle.taskQueue.filter((record) => wanted.has(record.status))
    if (tasks.length === 0) continue
    rows.push({ sessionName: handle.name, tasks })
  }
  return rows
}

export interface DelegateFromQueueOptions {
  goal?: string
  mode?: DelegationMode
  target?: SessionId
  source?: DelegationSource
}

/**
 * Thin CLI-facing convenience: delegates one goal. Stays a one-liner by
 * design — the actual session runner is the integration workstream's, built on
 * `popNextTask` + `trackDelegation`.
 */
export async function delegateToFromQueue(bus: SessionBus, deps: DelegateFromQueueOptions = {}): Promise<void> {
  const goal = deps.goal?.trim()
  if (!goal) {
    throw new Error('delegateToFromQueue requires a non-empty `goal`')
  }
  await delegateTask({
    goal,
    mode: deps.mode ?? 'after-step',
    target: deps.target,
    source: deps.source ?? 'cli',
    bus,
  })
}