import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { emitEvent, machineReadable } from './ui/runtime.ts'
import { redactText } from './ui/redact.ts'

export type TaskKind = 'browser' | 'code' | 'pending'
export type TaskStatus = 'pending' | 'running' | 'paused' | 'done' | 'failed'

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
  error?: string
}

export type TaskSessionPatch = Partial<Pick<TaskSession, 'status' | 'action' | 'detail' | 'stepsCompleted' | 'stepsTotal' | 'error'>>
export type TaskControlAction = 'pause' | 'resume' | 'cancel' | 'retry'
export interface TaskControls {
  pause?: () => void
  resume?: () => void
  cancel?: () => void
  retry?: () => void
}
export type TaskSessionListener = (sessions: TaskSession[]) => void

const TASKS_FILE = join(process.cwd(), '.elia', 'tasks.json')

export class TaskSessionStore {
  private readonly records = new Map<string, TaskSession>()
  private readonly listeners = new Set<TaskSessionListener>()
  private readonly controls = new Map<string, TaskControls>()
  private writeQueued = false

  async load(filePath = TASKS_FILE): Promise<void> {
    const file = Bun.file(filePath)
    if (!(await file.exists())) return
    try {
      const parsed = (await file.json()) as TaskSession[]
      if (!Array.isArray(parsed)) return
      for (const item of parsed) {
        if (!item || typeof item.id !== 'string' || typeof item.title !== 'string') continue
        this.records.set(item.id, {
          id: item.id,
          kind: item.kind === 'browser' || item.kind === 'code' ? item.kind : 'pending',
          title: item.title,
          status: item.status === 'running' || item.status === 'paused' || item.status === 'done' || item.status === 'failed' ? item.status : 'pending',
          action: typeof item.action === 'string' ? item.action : '',
          detail: typeof item.detail === 'string' ? item.detail : '',
          createdAt: Number.isFinite(item.createdAt) ? item.createdAt : Date.now(),
          updatedAt: Number.isFinite(item.updatedAt) ? item.updatedAt : Date.now(),
          startedAt: item.startedAt,
          finishedAt: item.finishedAt,
          stepsCompleted: Number.isFinite(item.stepsCompleted) ? item.stepsCompleted : 0,
          stepsTotal: Number.isFinite(item.stepsTotal) ? item.stepsTotal : undefined,
          error: typeof item.error === 'string' ? item.error : undefined,
        })
      }
      this.emit()
    } catch {
      // Corrupt task history must not prevent Elia from starting. A new task will
      // overwrite the file with a valid snapshot on the next mutation.
    }
  }

  create(kind: TaskKind, title: string, detail = 'Queued'): TaskSession {
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
    }
    this.records.set(record.id, record)
    this.emit()
    return { ...record }
  }

  update(id: string, patch: TaskSessionPatch): TaskSession | undefined {
    const record = this.records.get(id)
    if (!record) return undefined
    const safePatch: TaskSessionPatch = { ...patch }
    if (patch.action !== undefined) safePatch.action = redactText(patch.action, 160)
    if (patch.detail !== undefined) safePatch.detail = redactText(patch.detail, 1000)
    if (patch.error !== undefined) safePatch.error = redactText(patch.error, 2000)
    Object.assign(record, safePatch, { updatedAt: Date.now() })
    if (patch.status === 'running' && !record.startedAt) record.startedAt = Date.now()
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
        mkdirSync(join(process.cwd(), '.elia'), { recursive: true })
        await Bun.write(TASKS_FILE, JSON.stringify(this.list(), null, 2))
      } catch {
        // Persistence is best-effort. The live dashboard remains authoritative.
      }
    })
  }
}

export const taskSessions = new TaskSessionStore()

export function inferTaskKind(title: string, prompt: string): TaskKind {
  const text = `${title} ${prompt}`.toLowerCase()
  if (/\b(browser|chrome|website|web page|navigate|click|form|online)\b/.test(text)) return 'browser'
  return 'code'
}
