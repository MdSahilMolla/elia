import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { redactText } from '../ui/redact.ts'
import type { AutonomyProfile, AutonomousRunResult } from './loop.ts'

export const SCHEDULE_SCHEMA_VERSION = 1
export const MIN_SCHEDULE_INTERVAL_MS = 60_000
export const MAX_SCHEDULE_INTERVAL_MS = 30 * 24 * 60 * 60_000
export const MAX_SCHEDULE_ACTIONS = 10_000
const DEFAULT_FILE = join(process.cwd(), '.elia', 'schedules.json')
const LEASE_BUFFER_MS = 60_000
const STORE_LOCK_TTL_MS = 5 * 60_000

export type ScheduleStatus = 'active' | 'running' | 'paused'

export interface ScheduleRecord {
  id: string
  title: string
  goal: string
  intervalMs: number
  nextRunAt: number
  status: ScheduleStatus
  profile: AutonomyProfile
  maxRunMs?: number
  maxActions?: number
  createdAt: number
  updatedAt: number
  runCount: number
  failureCount: number
  lastRunId?: string
  lastOutcome?: AutonomousRunResult['outcome']
  lastError?: string
  leaseExpiresAt?: number
}

interface ScheduleSnapshot {
  version: number
  schedules: ScheduleRecord[]
}

export function parseScheduleInterval(value: string): number {
  const match = /^(\d+(?:\.\d+)?)(s|m|h|d)$/i.exec(value.trim())
  if (!match) throw new Error('schedule interval must look like 60s, 15m, 2h, or 1d')
  const amount = Number.parseFloat(match[1]!)
  const unit = match[2]!.toLowerCase()
  const multiplier = unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 60 * 60_000 : 24 * 60 * 60_000
  const intervalMs = Math.round(amount * multiplier)
  if (!Number.isFinite(intervalMs) || intervalMs < MIN_SCHEDULE_INTERVAL_MS || intervalMs > MAX_SCHEDULE_INTERVAL_MS) {
    throw new Error(`schedule interval must be between 60s and 30d, got "${value}"`)
  }
  return intervalMs
}

export function formatScheduleInterval(intervalMs: number): string {
  if (intervalMs % (24 * 60 * 60_000) === 0) return `${intervalMs / (24 * 60 * 60_000)}d`
  if (intervalMs % (60 * 60_000) === 0) return `${intervalMs / (60 * 60_000)}h`
  if (intervalMs % 60_000 === 0) return `${intervalMs / 60_000}m`
  return `${intervalMs / 1000}s`
}

export class ScheduleStore {
  private readonly records = new Map<string, ScheduleRecord>()

  private constructor(private readonly path: string) {}

  static open(path = DEFAULT_FILE, recoverExpired = true): ScheduleStore {
    const store = new ScheduleStore(path)
    if (!existsSync(path)) return store
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ScheduleSnapshot>
      for (const raw of Array.isArray(parsed.schedules) ? parsed.schedules : []) {
        if (!raw || typeof raw.id !== 'string' || typeof raw.goal !== 'string') continue
        const persistedIntervalMs = typeof raw.intervalMs === 'number' && Number.isFinite(raw.intervalMs) ? raw.intervalMs : 0
        const intervalMs = persistedIntervalMs ? Math.max(MIN_SCHEDULE_INTERVAL_MS, Math.min(MAX_SCHEDULE_INTERVAL_MS, persistedIntervalMs)) : 0
        if (!intervalMs) continue
        store.records.set(raw.id, {
          id: raw.id,
          title: redactText(typeof raw.title === 'string' ? raw.title : raw.goal, 160),
          goal: redactText(raw.goal, 4000),
          intervalMs,
          nextRunAt: Number.isFinite(raw.nextRunAt) ? raw.nextRunAt : Date.now() + intervalMs,
          status: raw.status === 'paused' || raw.status === 'running' ? raw.status : 'active',
          profile: raw.profile === 'fast' || raw.profile === 'thorough' ? raw.profile : 'balanced',
          maxRunMs: typeof raw.maxRunMs === 'number' && Number.isFinite(raw.maxRunMs) ? Math.max(1, Math.min(24 * 60 * 60_000, raw.maxRunMs)) : undefined,
          maxActions: typeof raw.maxActions === 'number' && Number.isFinite(raw.maxActions) && raw.maxActions > 0 ? Math.max(1, Math.min(MAX_SCHEDULE_ACTIONS, Math.floor(raw.maxActions))) : undefined,
          createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
          updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now(),
          runCount: Number.isFinite(raw.runCount) ? Math.max(0, raw.runCount) : 0,
          failureCount: Number.isFinite(raw.failureCount) ? Math.max(0, raw.failureCount) : 0,
          lastRunId: typeof raw.lastRunId === 'string' ? raw.lastRunId : undefined,
          lastOutcome: typeof raw.lastOutcome === 'string' ? raw.lastOutcome as AutonomousRunResult['outcome'] : undefined,
          lastError: typeof raw.lastError === 'string' ? redactText(raw.lastError, 2000) : undefined,
          leaseExpiresAt: Number.isFinite(raw.leaseExpiresAt) ? raw.leaseExpiresAt : undefined,
        })
      }
    } catch {
      // Corrupt schedules are ignored so they cannot prevent Elia from starting.
    }
    if (recoverExpired) store.recoverExpired()
    return store
  }

  list(): ScheduleRecord[] {
    return [...this.records.values()].sort((a, b) => a.nextRunAt - b.nextRunAt).map((record) => structuredClone(record))
  }

  create(input: { title: string; goal: string; intervalMs: number; profile?: AutonomyProfile; maxRunMs?: number; maxActions?: number; now?: number }): ScheduleRecord {
    return this.withExclusiveLock(() => {
      this.reloadFromDisk()
      const now = input.now ?? Date.now()
      if (!Number.isInteger(input.intervalMs) || input.intervalMs < MIN_SCHEDULE_INTERVAL_MS || input.intervalMs > MAX_SCHEDULE_INTERVAL_MS) {
        throw new Error('schedule interval must be between 60s and 30d')
      }
      if (input.maxActions !== undefined && (!Number.isInteger(input.maxActions) || input.maxActions < 1 || input.maxActions > MAX_SCHEDULE_ACTIONS)) {
        throw new Error(`schedule max-actions must be an integer between 1 and ${MAX_SCHEDULE_ACTIONS}`)
      }
      const record: ScheduleRecord = {
        id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        title: redactText(input.title.trim() || 'Autonomous task', 160),
        goal: redactText(input.goal.trim(), 4000),
        intervalMs: input.intervalMs,
        nextRunAt: now + input.intervalMs,
        status: 'active',
        profile: input.profile ?? 'balanced',
        maxRunMs: input.maxRunMs === undefined ? undefined : Math.max(1, Math.min(24 * 60 * 60_000, input.maxRunMs)),
        maxActions: input.maxActions,
        createdAt: now,
        updatedAt: now,
        runCount: 0,
        failureCount: 0,
      }
      if (!record.goal) throw new Error('scheduled goal cannot be empty')
      this.records.set(record.id, record)
      this.persist()
      return structuredClone(record)
    })
  }

  pause(id: string): ScheduleRecord {
    return this.withExclusiveLock(() => {
      this.reloadFromDisk()
      const record = this.require(id)
      record.status = 'paused'
      record.leaseExpiresAt = undefined
      record.updatedAt = Date.now()
      this.persist()
      return structuredClone(record)
    })
  }

  resume(id: string, now = Date.now()): ScheduleRecord {
    return this.withExclusiveLock(() => {
      this.reloadFromDisk()
      const record = this.require(id)
      record.status = 'active'
      record.nextRunAt = Math.min(record.nextRunAt, now)
      record.leaseExpiresAt = undefined
      record.updatedAt = now
      this.persist()
      return structuredClone(record)
    })
  }

  remove(id: string): void {
    this.withExclusiveLock(() => {
      this.reloadFromDisk()
      if (!this.records.delete(id)) throw new Error(`unknown schedule ${id}`)
      this.persist()
    })
  }

  due(now = Date.now()): ScheduleRecord[] {
    return this.list().filter((record) => record.status === 'active' && record.nextRunAt <= now)
  }

  claim(id: string, now = Date.now()): ScheduleRecord {
    return this.withExclusiveLock(() => {
      // A second daemon may have loaded an older in-memory snapshot. Reload after
      // acquiring the lock so a completed or already-running schedule cannot be
      // claimed twice by separate processes.
      this.reloadFromDisk()
      const record = this.require(id)
      if (record.status !== 'active' || record.nextRunAt > now) throw new Error(`schedule ${id} is not due`)
      record.status = 'running'
      record.leaseExpiresAt = now + (record.maxRunMs ?? 30 * 60_000) + LEASE_BUFFER_MS
      record.updatedAt = now
      this.persist()
      return structuredClone(record)
    })
  }

  complete(id: string, result: Pick<AutonomousRunResult, 'runId' | 'outcome'> & { error?: string }, now = Date.now()): ScheduleRecord {
    return this.withExclusiveLock(() => {
      this.reloadFromDisk()
      const record = this.require(id)
      record.status = 'active'
      record.nextRunAt = now + record.intervalMs
      record.updatedAt = now
      record.runCount += 1
      record.lastRunId = result.runId
      record.lastOutcome = result.outcome
      record.lastError = result.error ? redactText(result.error, 2000) : undefined
      record.failureCount += result.outcome === 'completed' ? 0 : 1
      record.leaseExpiresAt = undefined
      this.persist()
      return structuredClone(record)
    })
  }

  recoverExpired(now = Date.now()): ScheduleRecord[] {
    return this.withExclusiveLock(() => {
      this.reloadFromDisk()
      const recovered: ScheduleRecord[] = []
      for (const record of this.records.values()) {
        if (record.status === 'running' && record.leaseExpiresAt !== undefined && record.leaseExpiresAt <= now) {
          record.status = 'active'
          record.nextRunAt = now
          record.updatedAt = now
          record.failureCount += 1
          record.lastError = 'scheduler lease expired; the previous run may have been interrupted'
          record.leaseExpiresAt = undefined
          recovered.push(structuredClone(record))
        }
      }
      if (recovered.length > 0) this.persist()
      return recovered
    })
  }

  private reloadFromDisk(): void {
    const fresh = ScheduleStore.open(this.path, false)
    this.records.clear()
    for (const record of fresh.list()) this.records.set(record.id, record)
  }

  private require(id: string): ScheduleRecord {
    const record = this.records.get(id)
    if (!record) throw new Error(`unknown schedule ${id}`)
    return record
  }

  private withExclusiveLock<T>(fn: () => T): T {
    const lockPath = `${this.path}.lock`
    mkdirSync(join(this.path, '..'), { recursive: true })
    try {
      mkdirSync(lockPath)
    } catch {
      try {
        if (statSync(lockPath).mtimeMs + STORE_LOCK_TTL_MS < Date.now()) rmSync(lockPath, { recursive: true, force: true })
      } catch {
        // A concurrent process may be creating or removing the lock.
      }
      try {
        mkdirSync(lockPath)
      } catch {
        throw new Error('schedule store is busy; another daemon is claiming work')
      }
    }
    try {
      return fn()
    } finally {
      rmSync(lockPath, { recursive: true, force: true })
    }
  }

  private persist(): void {
    mkdirSync(join(this.path, '..'), { recursive: true })
    const temporary = `${this.path}.tmp-${process.pid}`
    writeFileSync(temporary, JSON.stringify({ version: SCHEDULE_SCHEMA_VERSION, schedules: this.list() }, null, 2))
    renameSync(temporary, this.path)
  }
}
