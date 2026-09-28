import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { currentAgent } from '../autonomy/context.ts'
import { withFileLock } from '../fileLock.ts'
import { parseLocalJson } from '../localJson.ts'
import type { Flag, PlannedStage, Scale } from './lifecycles.ts'
import type { OrgRoleId, Origin, ReviewKind, SignoffGate } from './org.ts'

/**
 * The organization's record: every initiative, the stage it is in, and the evidence,
 * reviews, decisions, risks, and artifacts attached to it — persisted under
 * `.elia/sysintel/` in the working directory, with an append-only journal of every change.
 *
 * It is written only through the si_* tools and the `elia si` operator commands. The
 * governor refuses direct file edits here, because a gate is only worth something if
 * the evidence behind it was produced by the engine, not typed into a JSON file.
 */

export const STORE_VERSION = 1

export interface Actor {
  name: string
  /** The elia worker role, `lead`, or `operator` for a person at the terminal. */
  role: string
}

export type StageStatus = 'pending' | 'active' | 'done'

export interface StageState extends PlannedStage {
  status: StageStatus
  enteredAt?: string
  completedAt?: string
  visits: number
  /** Requirements carried in from earlier stages by a re-triage, with where they came from. */
  carried?: boolean
}

export interface ArtifactRecord {
  id: string
  kind: string
  version: number
  title: string
  /** Relative to the working directory. */
  path: string
  sha256: string
  valid: boolean
  errors: string[]
  warnings: string[]
  stage: string
  by: Actor
  at: string
  exportedTo?: string[]
}

export type EvidenceKind = 'note' | 'link' | 'check' | 'commit' | 'branch' | 'signoff'

export interface Evidence {
  id: string
  kind: EvidenceKind
  stage: string
  summary: string
  by: Actor
  at: string
  command?: string
  exitCode?: number
  passed?: boolean
  noTests?: boolean
  timedOut?: boolean
  elapsedMs?: number
  output?: string
  /** Working-tree fingerprint at the time (checks and sign-offs). */
  tree?: string
  sha?: string
  branch?: string
  isDefaultBranch?: boolean
  /** For commits: made after the initiative began (not already in the history it started from). */
  newCommit?: boolean
  url?: string
  gate?: SignoffGate
  via?: 'governor-approval' | 'operator-cli'
}

export type Verdict = 'approve' | 'changes-requested' | 'reject'

export interface ReviewRecord {
  id: string
  kind: ReviewKind
  verdict: Verdict
  summary: string
  findings: string[]
  hat: OrgRoleId
  by: Actor
  /** True only when someone other than the author gave it: a qualified reviewer worker, or the operator. */
  independent: boolean
  subject: { type: 'tree' | 'artifact' | 'untracked'; ref: string }
  stage: string
  at: string
}

export interface Decision {
  id: string
  title: string
  decision: string
  alternatives: string[]
  consequences: string
  stage: string
  by: Actor
  at: string
}

export type Level = 'low' | 'medium' | 'high'

export interface Risk {
  id: string
  title: string
  likelihood: Level
  impact: Level
  mitigation: string
  owner: OrgRoleId
  status: 'open' | 'mitigated' | 'accepted' | 'closed'
  by: Actor
  at: string
  updatedAt: string
}

export interface WorkItem {
  id: string
  title: string
  owner: OrgRoleId
  priority: 'P0' | 'P1' | 'P2' | 'P3'
  estimate?: string
  dependsOn: string[]
  acceptance: string[]
  status: 'todo' | 'in-progress' | 'done' | 'dropped'
  note?: string
  updatedAt: string
}

export type InitiativeStatus = 'active' | 'blocked' | 'done' | 'abandoned'

export interface Initiative {
  version: number
  id: string
  title: string
  problem: string
  origin: Origin
  lifecycle: string
  /** The team that owns it (see TEAMS in org.ts). */
  team?: string
  scale: Scale
  flags: Flag[]
  triage: string[]
  status: InitiativeStatus
  blockedReason?: string
  stages: StageState[]
  current?: string
  /** The committed tree when the work began (.elia excluded), to tell whether anything has changed since. */
  baseTree?: string
  /** The commit checked out when the work began; commits already in its history are not new work. */
  baseHead?: string
  artifacts: ArtifactRecord[]
  evidence: Evidence[]
  reviews: ReviewRecord[]
  decisions: Decision[]
  risks: Risk[]
  items: WorkItem[]
  dependsOn: string[]
  parent?: string
  relation?: 'followup' | 'handoff'
  children: string[]
  iterations: number
  outcome?: string
  by: Actor
  createdAt: string
  updatedAt: string
  completedAt?: string
}

export interface JournalEntry {
  at: string
  initiative: string
  event: string
  by: Actor
  detail?: string
}

export function sysintelRoot(cwd: string = currentAgent().cwd ?? process.cwd()): string {
  return join(cwd, '.elia', 'sysintel')
}

export function actor(): Actor {
  const agent = currentAgent()
  return { name: agent.name, role: agent.role }
}

export const OPERATOR: Actor = { name: 'operator', role: 'operator' }

export function newId(prefix: string): string {
  return `${prefix}-${randomUUID().replace(/-/g, '').slice(0, 8)}`
}

export function sha256(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex')
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
  writeFileSync(tmp, content)
  renameSync(tmp, path)
}

const ID = /^SI-(\d{1,6})$/

export function assertInitiativeId(value: unknown, field = 'id'): string {
  if (typeof value !== 'string' || !ID.test(value.trim().toUpperCase())) throw new Error(`${field} must be an initiative id like "SI-3", got ${JSON.stringify(value)}`)
  return value.trim().toUpperCase()
}

export class SysintelStore {
  readonly root: string
  readonly cwd: string

  constructor(cwd: string = currentAgent().cwd ?? process.cwd()) {
    this.cwd = cwd
    this.root = sysintelRoot(cwd)
  }

  private get lockPath(): string {
    return join(this.root, 'store.lock')
  }

  private initiativePath(id: string): string {
    return join(this.root, 'initiatives', `${id}.json`)
  }

  get journalPath(): string {
    return join(this.root, 'journal.jsonl')
  }

  artifactDir(id: string): string {
    return join(this.root, 'artifacts', id)
  }

  relative(path: string): string {
    return relative(this.cwd, path).split('\\').join('/')
  }

  ids(): string[] {
    const dir = join(this.root, 'initiatives')
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .map((name) => /^(SI-\d+)\.json$/.exec(name)?.[1])
      .filter((id): id is string => id !== undefined)
      .sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)))
  }

  exists(id: string): boolean {
    return existsSync(this.initiativePath(id))
  }

  read(id: string): Initiative {
    const key = assertInitiativeId(id)
    const path = this.initiativePath(key)
    if (!existsSync(path)) throw new Error(`no initiative ${key} — list them with si_work list`)
    const parsed = parseLocalJson(readFileSync(path, 'utf8'), path) as Initiative
    if (!parsed || typeof parsed !== 'object' || parsed.id !== key || !Array.isArray(parsed.stages)) throw new Error(`${path} is not a System Intelligence initiative`)
    return parsed
  }

  list(): Initiative[] {
    return this.ids().map((id) => this.read(id))
  }

  /** Creates the next SI-n under the lock. */
  create(build: (id: string) => Initiative): Initiative {
    mkdirSync(this.root, { recursive: true })
    return withFileLock(this.lockPath, () => {
      const next = this.ids().reduce((max, id) => Math.max(max, Number(id.slice(3))), 0) + 1
      const initiative = build(`SI-${next}`)
      atomicWrite(this.initiativePath(initiative.id), JSON.stringify(initiative, null, 2))
      this.appendJournal({ at: initiative.createdAt, initiative: initiative.id, event: 'intake', by: initiative.by, detail: `${initiative.lifecycle} · ${initiative.scale} · ${initiative.title}` })
      return initiative
    })
  }

  /** Read-modify-write one initiative under the lock; the callback's journal lines are written with it. */
  update<T>(id: string, fn: (initiative: Initiative, journal: (event: string, detail?: string) => void) => T, by: Actor = actor()): T {
    mkdirSync(this.root, { recursive: true })
    return withFileLock(this.lockPath, () => {
      const initiative = this.read(id)
      const entries: JournalEntry[] = []
      const now = new Date().toISOString()
      const result = fn(initiative, (event, detail) => entries.push({ at: now, initiative: initiative.id, event, by, detail }))
      initiative.updatedAt = now
      atomicWrite(this.initiativePath(initiative.id), JSON.stringify(initiative, null, 2))
      for (const entry of entries) this.appendJournal(entry)
      return result
    })
  }

  /** Writes an artifact version's file and returns its path; recording it is the caller's update. */
  writeArtifactFile(id: string, kind: string, version: number, content: string): string {
    const path = join(this.artifactDir(id), `${kind}-v${version}.md`)
    atomicWrite(path, content)
    return path
  }

  readArtifactFile(record: ArtifactRecord): string | undefined {
    const path = join(this.cwd, record.path)
    return existsSync(path) ? readFileSync(path, 'utf8') : undefined
  }

  /** Whether an artifact file still has the bytes that were recorded. */
  artifactIntact(record: ArtifactRecord): 'ok' | 'missing' | 'changed' {
    const content = this.readArtifactFile(record)
    if (content === undefined) return 'missing'
    return sha256(content) === record.sha256 ? 'ok' : 'changed'
  }

  appendJournal(entry: JournalEntry): void {
    mkdirSync(this.root, { recursive: true })
    appendFileSync(this.journalPath, `${JSON.stringify(entry)}\n`)
  }

  journal(limit = 200): JournalEntry[] {
    if (!existsSync(this.journalPath)) return []
    const lines = readFileSync(this.journalPath, 'utf8').split('\n').filter(Boolean)
    const entries: JournalEntry[] = []
    for (const line of lines.slice(-limit)) {
      try {
        entries.push(JSON.parse(line) as JournalEntry)
      } catch {
        // A torn final line from a crash mid-append is skipped, not fatal.
      }
    }
    return entries
  }
}
