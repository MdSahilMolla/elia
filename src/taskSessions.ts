import { mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { emitEvent, machineReadable } from './ui/runtime.ts'
import { redactText } from './ui/redact.ts'

export type TaskKind = 'browser' | 'code' | 'data' | 'finance' | 'production' | 'research' | 'communication' | 'automation' | 'pending'
export type TaskStatus = 'pending' | 'running' | 'paused' | 'waiting-input' | 'waiting-approval' | 'needs-review' | 'done' | 'failed'

export interface TaskSession {
  id: string
  kind: TaskKind
  title: string
  status: TaskStatus
  action: string
  detail: string
  createdAt: number
  updatedAt: number
  startedAt?: number
  finishedAt?: number
  stepsCompleted: number
  stepsTotal?: number
  /** Bounded progress signal from 0 to 1; it is evidence of activity, not proof of completion. */
  progress: number
  attempts: number
  lastHeartbeatAt?: number
  nextAction?: string
  blockedReason?: string
  acceptanceCriteria?: string[]
  verificationCommands?: string[]
  error?: string
  /** Parent task or lead session that owns this worker. */
  parentId?: string
  /** Hierarchical delegation depth, zero for a top-level task. */
  depth?: number
  /** Worker role responsible for this task. */
  role?: string
}

export type TaskSessionPatch = Partial<Pick<TaskSession, 'status' | 'action' | 'detail' | 'stepsCompleted' | 'stepsTotal' | 'progress' | 'attempts' | 'lastHeartbeatAt' | 'nextAction' | 'blockedReason' | 'acceptanceCriteria' | 'verificationCommands' | 'error'>>
export interface TaskSessionMeta {
  parentId?: string
  depth?: number
  role?: string
  acceptanceCriteria?: string[]
  verificationCommands?: string[]
}
export type TaskControlAction = 'pause' | 'resume' | 'cancel' | 'retry'
export interface TaskControls {
  pause?: () => void
  resume?: () => void
  cancel?: () => void
  retry?: () => void
}
export type TaskSessionListener = (sessions: TaskSession[]) => void

const TASKS_FILE = join(process.cwd(), '.elia', 'tasks.json')
const TASKS_SCHEMA_VERSION = 3
const STALE_TASK_HEARTBEAT_MS = 5 * 60_000

export class TaskSessionStore {
  private readonly records = new Map<string, TaskSession>()
  private readonly listeners = new Set<TaskSessionListener>()
  private readonly controls = new Map<string, TaskControls>()
  private writeQueued = false
  private persistencePath = TASKS_FILE

  async load(filePath = TASKS_FILE): Promise<void> {
    this.persistencePath = filePath
    const file = Bun.file(filePath)
    if (!(await file.exists())) return
    try {
      const parsed = (await file.json()) as TaskSession[] | { version?: number; tasks?: TaskSession[] }
      const records = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.tasks) ? parsed.tasks : []
      if (records.length === 0 && !Array.isArray(parsed) && !parsed?.tasks) return
      for (const item of records) {
        if (!item || typeof item.id !== 'string' || typeof item.title !== 'string') continue
        const lastHeartbeatAt = typeof item.lastHeartbeatAt === 'number' && Number.isFinite(item.lastHeartbeatAt)
          ? item.lastHeartbeatAt
          : typeof item.updatedAt === 'number' && Number.isFinite(item.updatedAt)
            ? item.updatedAt
            : undefined
        const stale = item.status === 'running' && lastHeartbeatAt !== undefined && Date.now() - lastHeartbeatAt > STALE_TASK_HEARTBEAT_MS
        const recoveredStatus: TaskStatus = stale ? 'needs-review' : item.status === 'running' || item.status === 'paused' || item.status === 'waiting-input' || item.status === 'waiting-approval' || item.status === 'needs-review' || item.status === 'done' || item.status === 'failed' ? item.status : 'pending'
        this.records.set(item.id, {
          id: item.id,
          kind: item.kind === 'browser' || item.kind === 'code' || item.kind === 'data' || item.kind === 'finance' || item.kind === 'production' || item.kind === 'research' || item.kind === 'communication' || item.kind === 'automation' ? item.kind : 'pending',
          title: item.title,
          status: recoveredStatus,
          action: stale ? 'Recovered interrupted task' : typeof item.action === 'string' ? item.action : '',
          detail: stale ? 'No heartbeat was recorded before the previous process stopped.' : typeof item.detail === 'string' ? item.detail : '',
          createdAt: Number.isFinite(item.createdAt) ? item.createdAt : Date.now(),
          updatedAt: Number.isFinite(item.updatedAt) ? item.updatedAt : Date.now(),
          startedAt: item.startedAt,
          finishedAt: item.finishedAt,
          stepsCompleted: Number.isFinite(item.stepsCompleted) ? item.stepsCompleted : 0,
          stepsTotal: Number.isFinite(item.stepsTotal) ? item.stepsTotal : undefined,
          progress: typeof item.progress === 'number' && Number.isFinite(item.progress) ? Math.max(0, Math.min(1, item.progress)) : 0,
          attempts: Number.isFinite(item.attempts) ? Math.max(0, item.attempts) : 0,
          lastHeartbeatAt: Number.isFinite(item.lastHeartbeatAt) ? item.lastHeartbeatAt : undefined,
          nextAction: stale ? 'Inspect the run receipt and resume only the incomplete work.' : typeof item.nextAction === 'string' ? redactText(item.nextAction, 500) : undefined,
          blockedReason: stale ? 'The previous process stopped without a fresh heartbeat.' : typeof item.blockedReason === 'string' ? redactText(item.blockedReason, 1000) : undefined,
          acceptanceCriteria: Array.isArray(item.acceptanceCriteria) ? item.acceptanceCriteria.filter((value): value is string => typeof value === 'string').slice(0, 20) : undefined,
          verificationCommands: Array.isArray(item.verificationCommands) ? item.verificationCommands.filter((value): value is string => typeof value === 'string').slice(0, 20) : undefined,
          error: stale ? 'Task was interrupted before completion.' : typeof item.error === 'string' ? redactText(item.error, 2000) : undefined,
          parentId: typeof item.parentId === 'string' ? item.parentId : undefined,
          depth: Number.isFinite(item.depth) ? item.depth : undefined,
          role: typeof item.role === 'string' ? item.role : undefined,
        })
      }
      // Loading is intentionally silent. Subscribers receive the complete loaded
      // snapshot when they subscribe, and CLI JSONL startup must remain stable.
    } catch {
      // Corrupt task history must not prevent Elia from starting. A new task will
      // overwrite the file with a valid snapshot on the next mutation.
    }
  }

  create(kind: TaskKind, title: string, detail = 'Queued', meta: TaskSessionMeta = {}): TaskSession {
    const now = Date.now()
    const record: TaskSession = {
      id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      kind,
      title: redactText(title.trim() || 'Untitled task', 160),
      status: 'pending',
      action: 'Queued',
      detail: redactText(detail, 1000),
      createdAt: now,
      updatedAt: now,
      stepsCompleted: 0,
      progress: 0,
      attempts: 0,
      parentId: meta.parentId,
      depth: meta.depth,
      role: meta.role,
      acceptanceCriteria: meta.acceptanceCriteria?.slice(0, 20),
      verificationCommands: meta.verificationCommands?.slice(0, 20),
    }
    this.records.set(record.id, record)
    this.emit()
    return { ...record }
  }

  update(id: string, patch: TaskSessionPatch): TaskSession | undefined {
    const record = this.records.get(id)
    if (!record) return undefined
    const wasRunning = record.status === 'running'
    const safePatch: TaskSessionPatch = { ...patch }
    if (patch.action !== undefined) safePatch.action = redactText(patch.action, 160)
    if (patch.detail !== undefined) safePatch.detail = redactText(patch.detail, 1000)
    if (patch.nextAction !== undefined) safePatch.nextAction = redactText(patch.nextAction, 500)
    if (patch.blockedReason !== undefined) safePatch.blockedReason = redactText(patch.blockedReason, 1000)
    if (patch.error !== undefined) safePatch.error = redactText(patch.error, 2000)
    if (patch.progress !== undefined) safePatch.progress = Math.max(0, Math.min(1, patch.progress))
    Object.assign(record, safePatch, { updatedAt: Date.now() })
    if (patch.status === 'running') {
      if (!record.startedAt) record.startedAt = Date.now()
      record.lastHeartbeatAt = Date.now()
      if (!wasRunning && patch.attempts === undefined) record.attempts += 1
    }
    if (patch.status === 'done') record.progress = 1
    if ((patch.status === 'done' || patch.status === 'failed') && !record.finishedAt) record.finishedAt = Date.now()
    this.emit()
    return { ...record }
  }

  get(id: string): TaskSession | undefined {
    const record = this.records.get(id)
    return record ? { ...record } : undefined
  }

  registerControls(id: string, controls: TaskControls): () => void {
    this.controls.set(id, controls)
    return () => this.controls.delete(id)
  }

  control(id: string, action: TaskControlAction): boolean {
    const handler = this.controls.get(id)?.[action]
    if (!handler) return false
    handler()
    return true
  }

  list(): TaskSession[] {
    return [...this.records.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((record) => ({ ...record }))
  }

  subscribe(listener: TaskSessionListener): () => void {
    this.listeners.add(listener)
    listener(this.list())
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    const snapshot = this.list()
    for (const listener of this.listeners) listener(snapshot)
    if (machineReadable) emitEvent('tasks_updated', { tasks: snapshot })
    this.persistSoon()
  }

  private persistSoon(): void {
    if (this.writeQueued) return
    this.writeQueued = true
    queueMicrotask(async () => {
      this.writeQueued = false
      try {
        mkdirSync(join(this.persistencePath, '..'), { recursive: true })
        const temporary = `${this.persistencePath}.tmp-${process.pid}`
        await Bun.write(temporary, JSON.stringify({ version: TASKS_SCHEMA_VERSION, tasks: this.list() }, null, 2))
        renameSync(temporary, this.persistencePath)
      } catch {
        // Persistence is best-effort. The live dashboard remains authoritative.
      }
    })
  }
}

export const taskSessions = new TaskSessionStore()

export function inferTaskKind(title: string, prompt: string): TaskKind {
  const text = `${title} ${prompt}`.toLowerCase()
  if (/\b(finance|financial|budget|forecast|runway|valuation|dcf|cash flow|unit economics|roi)\b/.test(text)) return 'finance'
  if (/\b(production|deploy|deployment|release|rollback|migration|observability|incident|slo|backup|ci\/cd|kubernetes|terraform)\b/.test(text)) return 'production'
  if (/\b(data science|dataset|csv|jsonl|cohort|funnel|regression|correlation|experiment|statistics|anomaly)\b/.test(text)) return 'data'
  if (/\b(research|literature|sources|citations|fact check|due diligence)\b/.test(text)) return 'research'
  if (/\b(email|calendar|message|recipient|communication|slack)\b/.test(text)) return 'communication'
  if (/\b(automation|workflow|webhook|schedule|synchroniz|integration|trigger)\b/.test(text)) return 'automation'
  if (/\b(browser|chrome|website|web page|navigate|click|form|online)\b/.test(text)) return 'browser'
  return 'code'
}
