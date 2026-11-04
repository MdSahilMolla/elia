import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveWorkspacePath } from './context.ts'
import { ensureSecureDirectory, hardenSecureFile, writeSecureFile } from '../securePersistence.ts'
import { withFileLock } from '../fileLock.ts'
import { redactText } from '../ui/redact.ts'
import { resolveOutcomeProbes } from './groundTruth.ts'
import type { OutcomeContract } from './types.ts'

export const OUTCOME_SCHEMA_VERSION = 1
export const MAX_OUTCOMES = 2_000
const DEFAULT_FILE = join(process.cwd(), '.elia', 'outcomes.json')
const STORE_LOCK_TTL_MS = 5 * 60_000

export type OutcomeProbe =
  | { kind: 'file-exists'; path: string }
  | { kind: 'file-contains'; path: string; text: string }

export type OutcomeStatus = 'pending' | 'verified' | 'failed' | 'inconclusive'

export interface OutcomeRecord {
  id: string
  title: string
  runId?: string
  createdAt: number
  dueAt: number
  status: OutcomeStatus
  probe: OutcomeProbe
  attempts: number
  checkedAt?: number
  evidence?: string[]
  failure?: string
}

interface Snapshot {
  version: number
  outcomes: OutcomeRecord[]
}

function safeText(value: unknown, fallback: string, max: number): string {
  return redactText(typeof value === 'string' && value.trim() ? value.trim() : fallback, max)
}

function parseProbe(raw: unknown): OutcomeProbe | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const value = raw as Record<string, unknown>
  if (value.kind === 'file-exists' && typeof value.path === 'string' && value.path.length > 0) return { kind: 'file-exists', path: value.path }
  if (value.kind === 'file-contains' && typeof value.path === 'string' && value.path.length > 0 && typeof value.text === 'string' && value.text.length > 0) {
    return { kind: 'file-contains', path: value.path, text: value.text }
  }
  return undefined
}

function normalize(raw: unknown): OutcomeRecord | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const value = raw as Record<string, unknown>
  const probe = parseProbe(value.probe)
  if (typeof value.id !== 'string' || !value.id || !probe) return undefined
  const status: OutcomeStatus = value.status === 'verified' || value.status === 'failed' || value.status === 'inconclusive' ? value.status : 'pending'
  return {
    id: value.id,
    title: safeText(value.title, 'Outcome check', 160),
    ...(typeof value.runId === 'string' && value.runId ? { runId: value.runId } : {}),
    createdAt: Number.isFinite(value.createdAt) ? Number(value.createdAt) : Date.now(),
    dueAt: Number.isFinite(value.dueAt) ? Number(value.dueAt) : Date.now(),
    status,
    probe,
    attempts: Number.isFinite(value.attempts) ? Math.max(0, Math.floor(Number(value.attempts))) : 0,
    ...(Number.isFinite(value.checkedAt) ? { checkedAt: Number(value.checkedAt) } : {}),
    ...(Array.isArray(value.evidence) ? { evidence: value.evidence.filter((item): item is string => typeof item === 'string').slice(0, 20).map((item) => redactText(item, 500)) } : {}),
    ...(typeof value.failure === 'string' ? { failure: redactText(value.failure, 2_000) } : {}),
  }
}

export function parseOutcomeDelay(value: string): number {
  const match = /^(\d+(?:\.\d+)?)(s|m|h|d)$/i.exec(value.trim())
  if (!match) throw new Error('outcome delay must look like 60s, 15m, 2h, or 1d')
  const amount = Number.parseFloat(match[1]!)
  const multiplier = match[2]!.toLowerCase() === 's' ? 1_000 : match[2]!.toLowerCase() === 'm' ? 60_000 : match[2]!.toLowerCase() === 'h' ? 3_600_000 : 86_400_000
  const delay = Math.round(amount * multiplier)
  if (!Number.isFinite(delay) || delay < 1_000 || delay > 30 * 86_400_000) throw new Error('outcome delay must be between 1s and 30d')
  return delay
}

export function formatOutcomeDelay(delayMs: number): string {
  if (delayMs % 86_400_000 === 0) return `${delayMs / 86_400_000}d`
  if (delayMs % 3_600_000 === 0) return `${delayMs / 3_600_000}h`
  if (delayMs % 60_000 === 0) return `${delayMs / 60_000}m`
  return `${delayMs / 1_000}s`
}

export class OutcomeStore {
  private readonly records = new Map<string, OutcomeRecord>()

  private constructor(private readonly path: string, private readonly cwd = process.cwd()) {}

  static open(path = DEFAULT_FILE, cwd = process.cwd()): OutcomeStore {
    const store = new OutcomeStore(path, cwd)
    if (!existsSync(path)) return store
    hardenSecureFile(path)
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<Snapshot>
      for (const raw of Array.isArray(parsed.outcomes) ? parsed.outcomes : []) {
        const record = normalize(raw)
        if (record) store.records.set(record.id, record)
      }
    } catch {
      // A malformed state file must not prevent the CLI from starting.
    }
    return store
  }

  list(): OutcomeRecord[] {
    return [...this.records.values()].sort((a, b) => a.dueAt - b.dueAt).map((record) => structuredClone(record))
  }

  get(id: string): OutcomeRecord | undefined {
    const record = this.records.get(id)
    return record ? structuredClone(record) : undefined
  }

  add(input: { title: string; delayMs: number; probe: OutcomeProbe; runId?: string; now?: number }): OutcomeRecord {
    return this.withExclusiveLock(() => {
      this.reload()
      if (this.records.size >= MAX_OUTCOMES) throw new Error(`cannot track more than ${MAX_OUTCOMES} outcome checks`)
      const now = input.now ?? Date.now()
      const path = this.validatePath(input.probe.path)
      const probe: OutcomeProbe = input.probe.kind === 'file-exists'
        ? { kind: 'file-exists', path }
        : { kind: 'file-contains', path, text: redactText(input.probe.text, 4_000) }
      const record: OutcomeRecord = {
        id: `outcome-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        title: safeText(input.title, 'Outcome check', 160),
        ...(input.runId ? { runId: safeText(input.runId, '', 160) } : {}),
        createdAt: now,
        dueAt: now + input.delayMs,
        status: 'pending',
        probe,
        attempts: 0,
      }
      this.records.set(record.id, record)
      this.persist()
      return structuredClone(record)
    })
  }

  checkDue(now = Date.now()): OutcomeRecord[] {
    const checked = this.checkDueLocked(now)
    // A decided probe is ground truth for the run that registered it: score the
    // confidence that run claimed against what the world now shows.
    resolveOutcomeProbes(checked)
    return checked
  }

  private checkDueLocked(now: number): OutcomeRecord[] {
    return this.withExclusiveLock(() => {
      this.reload()
      const checked: OutcomeRecord[] = []
      for (const record of this.records.values()) {
        if (record.status !== 'pending' || record.dueAt > now) continue
        record.attempts += 1
        record.checkedAt = now
        const result = this.evaluate(record.probe)
        record.status = result.status
        record.evidence = result.evidence
        record.failure = result.failure
        checked.push(structuredClone(record))
      }
      if (checked.length > 0) this.persist()
      return checked
    })
  }

  private evaluate(probe: OutcomeProbe): { status: OutcomeStatus; evidence: string[]; failure?: string } {
    let target: string
    try {
      target = this.validatePath(probe.path)
    } catch (error) {
      return { status: 'inconclusive', evidence: [], failure: error instanceof Error ? error.message : String(error) }
    }
    if (!existsSync(target)) return { status: 'failed', evidence: [`checked ${target}`], failure: `expected file does not exist: ${probe.path}` }
    if (probe.kind === 'file-exists') return { status: 'verified', evidence: [`file exists: ${target}`] }
    try {
      const content = readFileSync(target, 'utf8')
      if (content.includes(probe.text)) return { status: 'verified', evidence: [`file contains expected text: ${probe.text}`] }
      return { status: 'failed', evidence: [`checked ${target}`], failure: `file does not contain expected text: ${probe.text}` }
    } catch (error) {
      return { status: 'inconclusive', evidence: [`could not read ${target}`], failure: error instanceof Error ? error.message : String(error) }
    }
  }

  private validatePath(raw: string): string {
    return resolveWorkspacePath(raw, this.cwd)
  }

  private reload(): void {
    const fresh = OutcomeStore.open(this.path, this.cwd)
    this.records.clear()
    for (const record of fresh.list()) this.records.set(record.id, record)
  }

  private persist(): void {
    ensureSecureDirectory(join(this.path, '..'))
    writeSecureFile(this.path, JSON.stringify({ version: OUTCOME_SCHEMA_VERSION, outcomes: this.list() }, null, 2))
  }

  private withExclusiveLock<T>(fn: () => T): T {
    ensureSecureDirectory(join(this.path, '..'))
    return withFileLock(`${this.path}.lock`, fn, { ttlMs: STORE_LOCK_TTL_MS })
  }
}

/** Register proposal contracts without granting them arbitrary execution power. */
export function registerOutcomeContracts(input: { contracts?: OutcomeContract[]; workspaceRoot: string; runId: string; now?: number }): { records: OutcomeRecord[]; errors: string[] } {
  const contracts = input.contracts ?? []
  if (contracts.length === 0) return { records: [], errors: [] }
  const store = OutcomeStore.open(join(input.workspaceRoot, '.elia', 'outcomes.json'), input.workspaceRoot)
  const records: OutcomeRecord[] = []
  const errors: string[] = []
  for (const contract of contracts) {
    try {
      records.push(store.add({ title: contract.title, delayMs: parseOutcomeDelay(contract.after), probe: contract.probe, runId: input.runId, now: input.now }))
    } catch (error) {
      errors.push(`${contract.title}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { records, errors }
}
