import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { currentAgent } from '../autonomy/context.ts'
import { withFileLock } from '../fileLock.ts'
import { parseLocalJson } from '../localJson.ts'
import { fingerprintFrame, type Frame } from './frame.ts'
import type { ColumnType, Scalar } from './values.ts'

/**
 * The analysis workspace: every dataset, model, artifact, plan, and execution record of a
 * data-science session, persisted under `.elia/datascience/` in the working directory.
 * It is what lets "now re-run this for 2025 only" work across turns and sessions, and
 * what makes an analysis reproducible: each dataset version is a content-addressed
 * snapshot with its lineage, and each run writes an execution record.
 *
 * Source files are never modified. Loading a source takes a snapshot; transformations
 * produce new, versioned datasets that point back at their inputs.
 */

export const WORKSPACE_VERSION = 1
const MAX_SNAPSHOT_CELLS = 30_000_000

export interface SourceRecord {
  kind: 'file' | 'sqlite' | 'postgres' | 'mysql' | 'http' | 's3' | 'python' | 'inline' | 'sql-workspace'
  format?: string
  /** Workspace-relative path for files; never a credential. */
  path?: string
  url?: string
  table?: string
  query?: string
  sheet?: string
  /** Name of the environment variable that held the connection string — the value is never stored. */
  credentialEnv?: string
  bytes?: number
  sha256?: string
  loadedAt: string
  truncatedAt?: number
  options?: Record<string, unknown>
}

export interface Derivation {
  inputs: string[]
  operation: string
  steps: unknown[]
  runId: string
}

export interface DatasetEntry {
  name: string
  version: number
  createdAt: string
  kind: 'source' | 'derived'
  description?: string
  source?: SourceRecord
  derivation?: Derivation
  rows: number
  columns: string[]
  types: Record<string, ColumnType>
  fingerprint: string
  storage?: string
  grain?: string
  notes: string[]
}

export interface ModelEntry {
  name: string
  version: number
  createdAt: string
  task: string
  algorithm: string
  target?: string
  features: string[]
  dataset: string
  datasetFingerprint: string
  params: Record<string, unknown>
  metrics: Record<string, unknown>
  seed: number
  path: string
  runId: string
  status: 'candidate' | 'registered' | 'archived'
}

export interface ArtifactEntry {
  path: string
  kind: string
  sha256: string
  bytes: number
  createdAt: string
  runId: string
  description?: string
}

export interface PlanEntry {
  id: string
  createdAt: string
  objective: string
  questions: string[]
  problemType: string
  datasets: string[]
  methods: string[]
  validation: string[]
  deliverables: string[]
  assumptions: string[]
  status: 'active' | 'completed' | 'superseded'
}

export interface WorkspaceState {
  version: number
  createdAt: string
  datasets: DatasetEntry[]
  models: ModelEntry[]
  artifacts: ArtifactEntry[]
  plans: PlanEntry[]
}

export function datascienceRoot(cwd: string = currentAgent().cwd ?? process.cwd()): string {
  return join(cwd, '.elia', 'datascience')
}

const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/

export function assertDatasetName(name: unknown, field = 'name'): string {
  if (typeof name !== 'string' || !NAME.test(name)) throw new Error(`${field} must start with a letter and use only letters, digits, "_" or "-" (max 64): got ${JSON.stringify(name)}`)
  return name
}

export function parseRef(ref: string): { name: string; version?: number } {
  const match = /^([A-Za-z][A-Za-z0-9_-]{0,63})(?:@(\d+))?$/.exec(ref.trim())
  if (!match) throw new Error(`dataset reference must be "name" or "name@version", got ${JSON.stringify(ref)}`)
  return { name: match[1]!, ...(match[2] ? { version: Number(match[2]) } : {}) }
}

export function refOf(entry: { name: string; version: number }): string {
  return `${entry.name}@${entry.version}`
}

function emptyState(): WorkspaceState {
  return { version: WORKSPACE_VERSION, createdAt: new Date().toISOString(), datasets: [], models: [], artifacts: [], plans: [] }
}

function atomicWriteSync(path: string, content: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
  writeFileSync(tmp, content)
  renameSync(tmp, path)
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** In-process cache of frames by `name@version` so a dataset is parsed once per session. */
const frameCache = new Map<string, Frame>()

export class Workspace {
  readonly root: string
  readonly cwd: string

  constructor(cwd: string = currentAgent().cwd ?? process.cwd()) {
    this.cwd = cwd
    this.root = datascienceRoot(cwd)
  }

  private get statePath(): string {
    return join(this.root, 'workspace.json')
  }

  private get lockPath(): string {
    return join(this.root, 'workspace.lock')
  }

  read(): WorkspaceState {
    if (!existsSync(this.statePath)) return emptyState()
    const parsed = parseLocalJson(readFileSync(this.statePath, 'utf8'), this.statePath) as WorkspaceState
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.datasets)) throw new Error(`${this.statePath} is not a data-science workspace file`)
    parsed.models ??= []
    parsed.artifacts ??= []
    parsed.plans ??= []
    return parsed
  }

  /** Read-modify-write under the workspace lock so two elia processes cannot clobber each other. */
  update<T>(fn: (state: WorkspaceState) => T): T {
    mkdirSync(this.root, { recursive: true })
    return withFileLock(this.lockPath, () => {
      const state = this.read()
      const result = fn(state)
      atomicWriteSync(this.statePath, JSON.stringify(state, null, 2))
      return result
    })
  }

  relative(path: string): string {
    return relative(this.cwd, path).split('\\').join('/')
  }

  // ------------------------------------------------------------ datasets

  datasets(): DatasetEntry[] {
    return this.read().datasets
  }

  /** Latest version of each dataset name. */
  latestDatasets(): DatasetEntry[] {
    const latest = new Map<string, DatasetEntry>()
    for (const entry of this.datasets()) if ((latest.get(entry.name)?.version ?? 0) < entry.version) latest.set(entry.name, entry)
    return [...latest.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  resolve(ref: string): DatasetEntry {
    const { name, version } = parseRef(ref)
    const candidates = this.datasets().filter((entry) => entry.name === name)
    if (candidates.length === 0) {
      const known = this.latestDatasets().map((entry) => entry.name)
      throw new Error(`no dataset named "${name}" in this workspace.${known.length ? ` Known: ${known.join(', ')}.` : ' Load one first with ds_data action "load".'}`)
    }
    const entry = version === undefined ? candidates.reduce((a, b) => (a.version > b.version ? a : b)) : candidates.find((candidate) => candidate.version === version)
    if (!entry) throw new Error(`dataset "${name}" has no version ${version}; versions: ${candidates.map((c) => c.version).join(', ')}`)
    return entry
  }

  /** Registers a frame as a new dataset version, or returns the existing version when the content is identical. */
  registerDataset(input: { name: string; frame: Frame; kind: 'source' | 'derived'; source?: SourceRecord; derivation?: Derivation; description?: string; grain?: string; notes?: string[] }): { entry: DatasetEntry; reused: boolean } {
    assertDatasetName(input.name)
    const fingerprint = fingerprintFrame(input.frame)
    const cells = input.frame.rows.length * Math.max(1, input.frame.columns.length)
    const result = this.update((state) => {
      const versions = state.datasets.filter((entry) => entry.name === input.name)
      const same = versions.find((entry) => entry.fingerprint === fingerprint && entry.kind === input.kind && JSON.stringify(entry.derivation?.steps ?? null) === JSON.stringify(input.derivation?.steps ?? null))
      if (same) return { entry: same, reused: true }
      const version = versions.reduce((max, entry) => Math.max(max, entry.version), 0) + 1
      const storage = cells <= MAX_SNAPSHOT_CELLS ? `data/${input.name}.v${version}.json.gz` : undefined
      const entry: DatasetEntry = {
        name: input.name,
        version,
        createdAt: new Date().toISOString(),
        kind: input.kind,
        ...(input.description ? { description: input.description } : {}),
        ...(input.source ? { source: input.source } : {}),
        ...(input.derivation ? { derivation: input.derivation } : {}),
        rows: input.frame.rows.length,
        columns: input.frame.columns,
        types: input.frame.types,
        fingerprint,
        ...(storage ? { storage } : {}),
        ...(input.grain ? { grain: input.grain } : {}),
        notes: [...(input.notes ?? []), ...(storage ? [] : [`not snapshotted (${cells} cells exceeds ${MAX_SNAPSHOT_CELLS}); reloading re-reads the source and verifies its fingerprint`])],
      }
      state.datasets.push(entry)
      return { entry, reused: false }
    })
    if (!result.reused && result.entry.storage) this.writeSnapshot(result.entry.storage, input.frame)
    frameCache.set(`${this.root}|${refOf(result.entry)}`, input.frame)
    return result
  }

  setGrain(ref: string, grain: string): void {
    const target = this.resolve(ref)
    this.update((state) => {
      const entry = state.datasets.find((candidate) => candidate.name === target.name && candidate.version === target.version)
      if (entry) entry.grain = grain
    })
  }

  private writeSnapshot(storage: string, frame: Frame): void {
    const payload = JSON.stringify({ columns: frame.columns, types: frame.types, data: frame.rows.map((row) => frame.columns.map((name) => row[name] ?? null)) })
    atomicWriteSync(join(this.root, storage), gzipSync(payload))
  }

  /** Loads a dataset's frame: cache, then snapshot. Throws when neither exists (the caller may re-read the source). */
  frame(ref: string): { entry: DatasetEntry; frame: Frame } {
    const entry = this.resolve(ref)
    const key = refOf(entry)
    const cached = frameCache.get(`${this.root}|${key}`)
    if (cached) return { entry, frame: cached }
    if (!entry.storage) throw new Error(`dataset ${key} was not snapshotted; reload it from its source with ds_data load`)
    const path = join(this.root, entry.storage)
    if (!existsSync(path)) throw new Error(`the snapshot for ${key} is missing at ${this.relative(path)}; reload the source`)
    const parsed = parseLocalJson(gunzipSync(readFileSync(path)).toString('utf8'), path) as { columns: string[]; types: Record<string, ColumnType>; data: Scalar[][] }
    const frame: Frame = {
      columns: parsed.columns,
      types: parsed.types,
      rows: parsed.data.map((values) => Object.fromEntries(parsed.columns.map((name, index) => [name, values[index] ?? null]))),
    }
    if (fingerprintFrame(frame) !== entry.fingerprint) throw new Error(`the snapshot for ${key} does not match its recorded fingerprint — it was modified outside elia`)
    frameCache.set(`${this.root}|${key}`, frame)
    return { entry, frame }
  }

  /** Walks derivations back to sources: SOURCE → TRANSFORMATION → OUTPUT. */
  lineage(ref: string): Array<{ dataset: string; kind: string; operation?: string; inputs?: string[]; steps?: unknown[]; source?: SourceRecord; runId?: string }> {
    const seen = new Set<string>()
    const chain: Array<{ dataset: string; kind: string; operation?: string; inputs?: string[]; steps?: unknown[]; source?: SourceRecord; runId?: string }> = []
    const visit = (reference: string) => {
      const entry = this.resolve(reference)
      const key = refOf(entry)
      if (seen.has(key)) return
      seen.add(key)
      for (const input of entry.derivation?.inputs ?? []) visit(input)
      chain.push({ dataset: key, kind: entry.kind, ...(entry.derivation ? { operation: entry.derivation.operation, inputs: entry.derivation.inputs, steps: entry.derivation.steps, runId: entry.derivation.runId } : {}), ...(entry.source ? { source: entry.source } : {}) })
    }
    visit(ref)
    return chain
  }

  // ------------------------------------------------------------ models

  registerModel(entry: Omit<ModelEntry, 'version' | 'createdAt' | 'path' | 'status'>, artifact: unknown): ModelEntry {
    assertDatasetName(entry.name, 'model name')
    const saved = this.update((state) => {
      const version = state.models.filter((model) => model.name === entry.name).reduce((max, model) => Math.max(max, model.version), 0) + 1
      const path = `models/${entry.name}/v${version}.json`
      const model: ModelEntry = { ...entry, version, createdAt: new Date().toISOString(), path, status: 'candidate' }
      state.models.push(model)
      return model
    })
    atomicWriteSync(join(this.root, saved.path), JSON.stringify(artifact))
    return saved
  }

  resolveModel(ref: string): ModelEntry {
    const { name, version } = parseRef(ref)
    const candidates = this.read().models.filter((model) => model.name === name && model.status !== 'archived')
    if (candidates.length === 0) throw new Error(`no model named "${name}"; trained models: ${[...new Set(this.read().models.map((m) => m.name))].join(', ') || 'none'}`)
    const entry = version === undefined ? candidates.reduce((a, b) => (a.version > b.version ? a : b)) : candidates.find((model) => model.version === version)
    if (!entry) throw new Error(`model "${name}" has no version ${version}`)
    return entry
  }

  loadModelArtifact(entry: ModelEntry): unknown {
    const path = join(this.root, entry.path)
    return parseLocalJson(readFileSync(path, 'utf8'), path)
  }

  setModelStatus(ref: string, status: ModelEntry['status']): ModelEntry {
    const target = this.resolveModel(ref)
    return this.update((state) => {
      const model = state.models.find((candidate) => candidate.name === target.name && candidate.version === target.version)!
      if (status === 'registered') for (const other of state.models) if (other.name === model.name && other.status === 'registered') other.status = 'candidate'
      model.status = status
      return model
    })
  }

  // ------------------------------------------------------------ artifacts

  artifactPath(relativePath: string): string {
    return join(this.root, 'artifacts', relativePath)
  }

  /** Writes an artifact file and registers it with its hash. Returns the workspace-relative path. */
  writeArtifact(relativePath: string, content: string | Uint8Array, kind: string, runId: string, description?: string): ArtifactEntry {
    if (relativePath.includes('..') || relativePath.startsWith('/') || relativePath.includes('\\')) throw new Error('artifact paths must be simple relative paths')
    const absolute = this.artifactPath(relativePath)
    atomicWriteSync(absolute, content)
    return this.recordArtifact(absolute, kind, runId, description)
  }

  recordArtifact(absolute: string, kind: string, runId: string, description?: string): ArtifactEntry {
    const entry: ArtifactEntry = { path: this.relative(absolute), kind, sha256: sha256File(absolute), bytes: statSync(absolute).size, createdAt: new Date().toISOString(), runId, ...(description ? { description } : {}) }
    this.update((state) => {
      state.artifacts = state.artifacts.filter((artifact) => artifact.path !== entry.path)
      state.artifacts.push(entry)
    })
    return entry
  }

  /** Re-hashes every registered artifact: an artifact is only reported as delivered if its file still matches. */
  verifyArtifacts(): Array<ArtifactEntry & { status: 'ok' | 'missing' | 'modified' }> {
    return this.read().artifacts.map((artifact) => {
      const absolute = join(this.cwd, artifact.path)
      if (!existsSync(absolute)) return { ...artifact, status: 'missing' as const }
      return { ...artifact, status: sha256File(absolute) === artifact.sha256 ? ('ok' as const) : ('modified' as const) }
    })
  }

  // ------------------------------------------------------------ plans

  savePlan(plan: Omit<PlanEntry, 'id' | 'createdAt' | 'status'>): PlanEntry {
    return this.update((state) => {
      for (const existing of state.plans) if (existing.status === 'active') existing.status = 'superseded'
      const entry: PlanEntry = { ...plan, id: `plan-${Date.now().toString(36)}`, createdAt: new Date().toISOString(), status: 'active' }
      state.plans.push(entry)
      return entry
    })
  }

  activePlan(): PlanEntry | undefined {
    return this.read().plans.filter((plan) => plan.status === 'active').at(-1)
  }

  // ------------------------------------------------------------ records

  recordsDir(): string {
    return join(this.root, 'runs')
  }

  writeRecord(record: { id: string; startedAt: string }): string {
    const path = join(this.recordsDir(), `${record.startedAt.replace(/[-:]/g, '').replace(/\..*$/, '')}-${record.id}.json`)
    atomicWriteSync(path, JSON.stringify(record, null, 2))
    return this.relative(path)
  }

  listRecords(limit = 50): Array<{ file: string; record: Record<string, unknown> }> {
    const dir = this.recordsDir()
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter((file) => file.endsWith('.json'))
      .sort()
      .slice(-limit)
      .map((file) => {
        const path = join(dir, file)
        try {
          return { file: this.relative(path), record: parseLocalJson(readFileSync(path, 'utf8'), path) as Record<string, unknown> }
        } catch (error) {
          return { file: this.relative(path), record: { error: (error as Error).message } }
        }
      })
  }

  readRecord(id: string): Record<string, unknown> {
    const dir = this.recordsDir()
    const file = existsSync(dir) ? readdirSync(dir).find((name) => name.endsWith(`-${id}.json`)) : undefined
    if (!file) throw new Error(`no execution record with id ${id}`)
    const path = join(dir, file)
    return parseLocalJson(readFileSync(path, 'utf8'), path) as Record<string, unknown>
  }

  /** Scratch space for one job (Python runs, exports). */
  jobDir(id: string): string {
    const dir = join(this.root, 'jobs', id)
    mkdirSync(dir, { recursive: true })
    return dir
  }
}

/** Test seam: forget cached frames. */
export function clearFrameCache(): void {
  frameCache.clear()
}
