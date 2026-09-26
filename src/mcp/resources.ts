import { closeSync, existsSync, openSync, readSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { readActionLedger } from '../autonomy/audit.ts'
import { listRuns } from '../autonomy/journal.ts'
import { readLiftRuns } from '../evolve/lift.ts'
import { loadProjectInstructions, loadProjectMemory } from '../memory.ts'
import { listSessionIds } from '../sessionCatalog.ts'
import { ELIA_ROOT, stateDir } from '../statePaths.ts'
import { MCP_FEATURE_INVENTORY } from './featureInventory.ts'
import {
  PROVIDER_PRESET_NAMES,
  providerPresetBaseURL,
  providerPresetDefaultModel,
} from '../providers/registry.ts'
import { readUserConfigValues } from '../userConfig.ts'
import { redactArchiveValue, redactText, relativizeProjectPaths } from '../ui/redact.ts'
import { ELIA_MODES, type McpToolExecutionContext } from './serverTypes.ts'
import type { McpResourceContents, McpResourceDescriptor, McpResourceTemplateDescriptor } from './protocol.ts'

const RESOURCE_MIME_TYPE = 'application/json'
const MAX_RUNS = 50
const MAX_SESSIONS = 25
const MAX_LIVE_SESSIONS = 50
const MAX_ACTIONS = 500
const MAX_FEATURES = 100
const MAX_BENCH_ROWS = 100
const MAX_STRING_LENGTH = 20_000
const MAX_COLLECTION_LENGTH = 50
const MAX_TOTAL_TEXT_LENGTH = 48_000
const MAX_TAIL_BYTES = 4_000_000

const STATIC_RESOURCES: readonly McpResourceDescriptor[] = [
  {
    uri: 'elia://runs',
    name: 'elia_runs',
    title: 'Elia run history',
    description: 'Bounded, read-only summaries of recent autonomous runs.',
    mimeType: RESOURCE_MIME_TYPE,
  },
  {
    uri: 'elia://sessions',
    name: 'elia_sessions',
    title: 'Elia sessions',
    description: 'Bounded, read-only process-local session state and persisted session inventory.',
    mimeType: RESOURCE_MIME_TYPE,
  },
  {
    uri: 'elia://compounding',
    name: 'elia_compounding',
    title: 'Elia compounding status',
    description: 'Bounded, read-only evidence for the compounding pipeline.',
    mimeType: RESOURCE_MIME_TYPE,
  },
  {
    uri: 'elia://modes',
    name: 'elia_modes',
    title: 'Elia modes and tool policy',
    description: 'MCP modes and their approval, cost, capability, and idempotency policy.',
    mimeType: RESOURCE_MIME_TYPE,
  },
  {
    uri: 'elia://config',
    name: 'elia_config',
    title: 'Elia safe configuration',
    description: 'Non-secret runtime configuration only; credentials are never included.',
    mimeType: RESOURCE_MIME_TYPE,
  },
  {
    uri: 'elia://bench/latest',
    name: 'elia_bench_latest',
    title: 'Latest Elia benchmark',
    description: 'The latest bounded benchmark snapshot and recent benchmark trend.',
    mimeType: RESOURCE_MIME_TYPE,
  },
] as const

const RESOURCE_TEMPLATES: readonly McpResourceTemplateDescriptor[] = [
  {
    uriTemplate: 'elia://memory/{project}',
    name: 'elia_project_memory',
    title: 'Elia project memory',
    description: 'Project instructions and memory for the current project or a contained subdirectory.',
    mimeType: RESOURCE_MIME_TYPE,
  },
  {
    uriTemplate: 'elia://ledger/{run_id}',
    name: 'elia_run_ledger',
    title: 'Elia run action ledger',
    description: 'Bounded, redacted action-ledger records for one exact run identifier.',
    mimeType: RESOURCE_MIME_TYPE,
  },
] as const

const STATIC_RESOURCE_NAMES: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(STATIC_RESOURCES.map(resource => [resource.uri, resource.name])),
)

export const ELIA_RESOURCES = STATIC_RESOURCES
export const ELIA_RESOURCE_TEMPLATES = RESOURCE_TEMPLATES
export { ELIA_MODES }

type ParsedEliaUri =
  | { kind: 'static'; uri: `elia://${string}` }
  | { kind: 'memory'; project: string; root: string; uri: string }
  | { kind: 'ledger'; runId: string; uri: string }

interface BoundState {
  remaining: number
  truncated: boolean
}

function now(): string {
  return new Date().toISOString()
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(resolve(path))
  } catch {
    return resolve(path)
  }
}

function processBoundProjectRoot(): string {
  return canonicalPath(dirname(stateDir))
}

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate)
  return pathFromRoot === '' || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..' && !isAbsolute(pathFromRoot))
}

function decodeTemplateValue(value: string, label: string): string {
  if (value.length === 0 || value.length > 512) throw new Error(`Invalid ${label} value`)
  let decoded: string
  try {
    decoded = decodeURIComponent(value)
  } catch {
    throw new Error(`Invalid ${label} encoding`)
  }
  if (decoded.length === 0 || decoded.length > 512 || /[\u0000-\u001F\u007F]/.test(decoded)) {
    throw new Error(`Invalid ${label} value`)
  }
  return decoded
}

function resolveProjectUri(value: string, context: McpToolExecutionContext): { project: string; root: string } {
  const projectRoot = canonicalPath(context.cwd)
  if (value === 'current' || value === '.') return { project: '.', root: projectRoot }

  const normalized = value.replace(/\\/g, '/')
  if (isAbsolute(value) || /^[A-Za-z]:/.test(normalized) || normalized.split('/').some(part => part === '..')) {
    throw new Error('Project must be current or a contained project-relative path')
  }

  const requested = resolve(projectRoot, value)
  if (!isWithin(projectRoot, requested)) throw new Error('Project path is outside the active project')
  if (!existsSync(requested) || !statSync(requested).isDirectory()) throw new Error('Project path does not exist')

  const canonical = canonicalPath(requested)
  if (!isWithin(projectRoot, canonical)) throw new Error('Project path resolves outside the active project')
  const project = relative(projectRoot, canonical).split(sep).join('/') || '.'
  return { project, root: canonical }
}

function validateRunId(value: string): string {
  if (value.length > 128 || value === '.' || value === '..' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error('Invalid run identifier')
  }
  return value
}

function parseEliaUri(rawUri: string, context: McpToolExecutionContext): ParsedEliaUri {
  if (rawUri.length === 0 || rawUri.length > 2_048 || /[\u0000-\u001F\u007F]/.test(rawUri)) {
    throw new Error('Invalid resource URI')
  }

  let url: URL
  try {
    url = new URL(rawUri)
  } catch {
    throw new Error('Invalid resource URI')
  }

  if (url.protocol.toLowerCase() !== 'elia:' || url.search || url.hash || url.username || url.password || url.port) {
    throw new Error('Invalid Elia resource URI')
  }

  const host = url.hostname.toLowerCase()
  if (url.pathname === '') {
    const uri = `elia://${host}` as `elia://${string}`
    if (!STATIC_RESOURCE_NAMES[uri]) throw new Error('Unknown Elia resource')
    return { kind: 'static', uri }
  }
  if (host === 'bench' && url.pathname === '/latest') return { kind: 'static', uri: 'elia://bench/latest' }

  if (host === 'memory') {
    const encoded = url.pathname.slice(1)
    if (encoded.includes('/')) throw new Error('Project must occupy one URI-template segment')
    const projectValue = decodeTemplateValue(encoded, 'project')
    if (projectValue.includes('/') || projectValue.includes('\\')) throw new Error('Project must occupy one URI-template segment')
    const project = resolveProjectUri(projectValue, context)
    const projectUriValue = project.project === '.' ? 'current' : project.project
    return {
      kind: 'memory',
      project: project.project,
      root: project.root,
      uri: `elia://memory/${encodeURIComponent(projectUriValue)}`,
    }
  }

  if (host === 'ledger') {
    const encoded = url.pathname.slice(1)
    if (encoded.includes('/')) throw new Error('Run identifier must occupy one URI-template segment')
    const runId = validateRunId(decodeTemplateValue(encoded, 'run identifier'))
    return { kind: 'ledger', runId, uri: `elia://ledger/${encodeURIComponent(runId)}` }
  }

  throw new Error('Unknown Elia resource template')
}

function safeText(value: unknown, root: string, maxLength = MAX_STRING_LENGTH, key?: string): string {
  const redactedValue = redactArchiveValue(typeof value === 'string' ? value : String(value ?? ''), key)
  if (typeof redactedValue !== 'string') return '[REDACTED]'
  return redactText(relativizeProjectPaths(redactedValue, root), maxLength)
}

function boundValue(
  value: unknown,
  root: string,
  state: BoundState,
  key?: string,
  depth = 0,
): unknown {
  if (state.remaining <= 0) {
    state.truncated = true
    return '[truncated]'
  }
  if (depth > 8) {
    state.truncated = true
    return '[truncated:maximum-depth]'
  }

  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    const limit = Math.min(MAX_STRING_LENGTH, state.remaining)
    const bounded = safeText(value, root, limit, key)
    state.remaining = Math.max(0, state.remaining - bounded.length)
    if (bounded.length < String(value).length) state.truncated = true
    return bounded
  }
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) {
    const limit = Math.min(MAX_COLLECTION_LENGTH, value.length)
    if (value.length > limit) state.truncated = true
    return value.slice(0, limit).map(item => boundValue(item, root, state, key, depth + 1))
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    const limit = Math.min(MAX_COLLECTION_LENGTH, entries.length)
    if (entries.length > limit) state.truncated = true
    const result: Record<string, unknown> = {}
    for (const [entryKey, entryValue] of entries.slice(0, limit)) {
      if (entryValue === undefined || state.remaining <= 0) continue
      result[entryKey] = boundValue(entryValue, root, state, entryKey, depth + 1)
    }
    return result
  }
  return safeText(value, root, Math.min(1_000, state.remaining), key)
}

function boundedPayload(payload: unknown, root: string): unknown {
  const state: BoundState = { remaining: MAX_TOTAL_TEXT_LENGTH, truncated: false }
  const bounded = boundValue(payload, root, state)
  if (state.truncated && bounded && typeof bounded === 'object' && !Array.isArray(bounded)) {
    ;(bounded as Record<string, unknown>).truncated = true
  }
  return bounded
}

function jsonContents(uri: string, name: string, payload: unknown, root: string): McpResourceContents {
  return {
    uri,
    name,
    mimeType: RESOURCE_MIME_TYPE,
    text: JSON.stringify(boundedPayload(payload, root), null, 2),
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function readTailRecords(path: string, maxBytes = MAX_TAIL_BYTES, maxRecords = 2_000): Record<string, unknown>[] {
  try {
    const size = statSync(path).size
    const start = Math.max(0, size - maxBytes)
    const length = size - start
    const buffer = Buffer.alloc(length)
    const descriptor = openSync(path, 'r')
    let offset = 0
    try {
      while (offset < length) {
        const bytesRead = readSync(descriptor, buffer, offset, length - offset, start + offset)
        if (bytesRead <= 0) break
        offset += bytesRead
      }
    } finally {
      closeSync(descriptor)
    }

    let text = buffer.subarray(0, offset).toString('utf8')
    if (start > 0) {
      const firstNewline = text.indexOf('\n')
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : ''
    }
    return text
      .split(/\r?\n/u)
      .filter(Boolean)
      .slice(-maxRecords)
      .flatMap(line => {
        try {
          const record = asRecord(JSON.parse(line))
          return record ? [record] : []
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}

async function readRuns(context: McpToolExecutionContext): Promise<unknown> {
  const summaries = await listRuns(MAX_RUNS + 1)
  const selected = summaries.slice(0, MAX_RUNS)
  const root = canonicalPath(context.cwd)
  return {
    kind: 'elia-runs',
    generatedAt: now(),
    scope: root === processBoundProjectRoot() ? 'active-project' : 'server-process-project',
    count: selected.length,
    truncated: summaries.length > MAX_RUNS,
    runs: selected.map(summary => ({
      id: summary.runId,
      uri: `elia://ledger/${encodeURIComponent(summary.runId)}`,
      goal: safeText(summary.goal, root, 2_000),
      startedAt: new Date(summary.startedAt).toISOString(),
      updatedAt: new Date(summary.updatedAt).toISOString(),
      durationMs: Math.max(0, summary.updatedAt - summary.startedAt),
      checkpoints: summary.checkpoints,
      outcome: safeText(summary.outcome, root, 4_000),
      taskSessionId: summary.taskSessionId ?? null,
      recoveredNodes: summary.recoveredNodes ?? 0,
    })),
  }
}

function readSessions(context: McpToolExecutionContext): unknown {
  const root = canonicalPath(context.cwd)
  const directory = resolve(root, '.elia', 'sessions')
  const sessions = listSessionIds(directory).slice(0, MAX_SESSIONS)
  const liveSessions = context.sessionBus.list().slice(0, MAX_LIVE_SESSIONS)

  return {
    kind: 'elia-sessions',
    generatedAt: now(),
    scope: {
      processLocal: 'Current MCP process only; not a durable or cross-process session registry.',
      persisted: 'Session-file identifiers and modification times only; conversation bodies are not loaded.',
    },
    processLocal: {
      count: liveSessions.length,
      sessions: liveSessions.map(session => ({
        id: session.id,
        name: session.name,
        status: session.status,
        lastActivityAt: session.lastActivity,
        lastTask: session.lastTask === undefined ? null : safeText(session.lastTask, root, 1_000),
        activeAgents: session.activeAgents,
        queuedTasks: session.taskQueue.length,
        checkpoints: Array.from(session.checkpoints.keys()),
        dependencies: session.dependencies.map(dependency => ({
          session: String(dependency.on),
          checkpoint: dependency.checkpoint ?? null,
          satisfied: dependency.satisfied,
        })),
        projectLessons: session.memorySlice.lessons.length,
        projectNotes: session.memorySlice.projectNotes.length,
        localLessons: session.memorySlice.localLessons.length,
        localNotes: session.memorySlice.localNotes.length,
        worktreeConfigured: session.worktree !== undefined,
      })),
    },
    persisted: {
      count: sessions.length,
      sessions: sessions.map(session => ({
        id: session.id,
        updatedAt: new Date(session.mtime).toISOString(),
      })),
    },
  }
}

async function readProjectMemory(project: string, root: string, uri: string): Promise<McpResourceContents> {
  const [instructions, memory] = await Promise.all([
    loadProjectInstructions(root),
    loadProjectMemory(root),
  ])
  return jsonContents(uri, 'elia_project_memory', {
    kind: 'elia-project-memory',
    generatedAt: now(),
    project,
    source: {
      instructions: 'ELIA.md',
      memory: '.elia/memory.md',
    },
    instructions: instructions
      ? { present: true, content: safeText(instructions, root) }
      : { present: false, content: null },
    memory: memory
      ? { present: true, content: safeText(memory, root) }
      : { present: false, content: null },
  }, root)
}

function readJsonlTail(path: string, maxRecords: number): Record<string, unknown>[] {
  return readTailRecords(path, MAX_TAIL_BYTES, maxRecords)
}

function compoundingStages(records: {
  interactive: Record<string, unknown>[]
  autonomous: Record<string, unknown>[]
  evolution: Record<string, unknown>[]
  benchmarks: Record<string, unknown>[]
  lessonTrials: Record<string, unknown>[]
}): Array<Record<string, unknown>> {
  const trajectoryRows = [...records.interactive, ...records.autonomous]
  const checked = trajectoryRows.filter(row => {
    const verification = asRecord(row.verification)
    const regime = asString(row.regime)
    return verification?.passed === true && regime !== 'judgment'
  }).length
  const promoted = records.evolution.filter(row => row.promoted === true).length
  const completeBenchmarks = records.benchmarks.filter(row => row.complete === true)
  const latestBenchmark = completeBenchmarks.at(-1)
  const unmeasured = Array.isArray(latestBenchmark?.unmeasured) ? latestBenchmark.unmeasured.length : 0
  const benchmarkDimensions = Array.isArray(latestBenchmark?.dimensions) ? latestBenchmark.dimensions : []
  const passingDimensions = benchmarkDimensions.filter(row => asRecord(row)?.passed === true).length
  const passRate = benchmarkDimensions.length > 0 ? passingDimensions / benchmarkDimensions.length : 0
  const validTrials = records.lessonTrials.filter(row => {
    const stored = asRecord(row.stored)
    return stored !== undefined && asFiniteNumber(row.heldOutScore) !== undefined && asFiniteNumber(row.shippedAt) !== undefined
  }).length

  return [
    {
      index: 1,
      name: 'record',
      state: trajectoryRows.length > 0 ? 'working' : 'no evidence',
      detail: { rows: trajectoryRows.length },
    },
    {
      index: 2,
      name: 'check',
      state: trajectoryRows.length === 0 ? 'no evidence' : checked > 0 ? (checked / trajectoryRows.length >= 0.5 ? 'working' : 'partial') : 'blocked',
      detail: { checked, total: trajectoryRows.length },
    },
    {
      index: 3,
      name: 'learn',
      state: records.evolution.length > 0 ? (promoted > 0 ? 'working' : 'partial') : 'no evidence',
      detail: { generations: records.evolution.length, promoted },
    },
    {
      index: 4,
      name: 'validate',
      state: latestBenchmark === undefined
        ? 'no evidence'
        : unmeasured > 0
          ? 'blocked'
          : passRate >= 0.95
            ? 'partial'
            : 'working',
      detail: latestBenchmark === undefined
        ? { benchmarks: records.benchmarks.length }
        : { benchmarks: records.benchmarks.length, passRate, unmeasured },
    },
    {
      index: 5,
      name: 'ship',
      state: validTrials > 0 ? 'working' : records.lessonTrials.length > 0 ? 'partial' : 'no evidence',
      detail: { trials: records.lessonTrials.length, validTrials },
    },
    {
      index: 6,
      name: 'compound',
      state: promoted > 1 ? 'working' : promoted === 1 ? 'partial' : 'no evidence',
      detail: { promotedGenerations: promoted },
    },
  ]
}

async function readCompounding(context: McpToolExecutionContext): Promise<unknown> {
  const root = canonicalPath(context.cwd)
  if (root === processBoundProjectRoot()) {
    const { compoundingStatus } = await import('../compounding/status.ts')
    return {
      kind: 'elia-compounding',
      generatedAt: now(),
      scope: 'active-project',
      stages: compoundingStatus(),
    }
  }

  const stages = compoundingStages({
    interactive: readJsonlTail(resolve(root, '.elia', 'trajectories', 'interactive.ndjson'), 2_000),
    autonomous: readJsonlTail(resolve(root, '.elia', 'trajectories', 'autonomous.ndjson'), 2_000),
    evolution: readJsonlTail(resolve(ELIA_ROOT, '.evolution', 'ledger.jsonl'), 1_000),
    benchmarks: readJsonlTail(resolve(root, '.elia', 'bench', 'history.ndjson'), 500),
    lessonTrials: readJsonlTail(resolve(root, '.elia', 'lessons-efficacy.jsonl'), 1_000),
  })
  return {
    kind: 'elia-compounding',
    generatedAt: now(),
    scope: 'active-project',
    stages,
  }
}

function readLedger(runId: string, context: McpToolExecutionContext, uri: string): McpResourceContents {
  const processRuns = readActionLedger(runId)
  const root = canonicalPath(context.cwd)
  const usesProcessRoot = root === processBoundProjectRoot()
  const records: Record<string, unknown>[] = usesProcessRoot
    ? processRuns.map(record => ({ ...record }))
    : readJsonlTail(resolve(root, '.elia', 'runs', runId, 'actions.ndjson'), MAX_ACTIONS)

  const selected = records.slice(0, MAX_ACTIONS)
  return jsonContents(uri, 'elia_run_ledger', {
    kind: 'elia-run-ledger',
    generatedAt: now(),
    runId,
    scope: usesProcessRoot ? 'active-project' : 'active-project-fallback',
    count: selected.length,
    truncated: records.length > MAX_ACTIONS,
    actions: selected.map((record, index) => {
      const input = asRecord(record.input)
      const output = record.result ?? record.output
      return {
        sequence: asFiniteNumber(record.seq) ?? index + 1,
        tool: asString(record.tool) ?? 'unknown',
        at: record.at,
        actor: record.actor ?? null,
        role: record.role ?? null,
        input: input ?? {},
        result: output === undefined ? null : safeText(output, root, 4_000, 'result'),
        isError: record.isError ?? false,
      }
    }),
  }, root)
}

function readModes(context: McpToolExecutionContext): McpResourceContents {
  const tools = MCP_FEATURE_INVENTORY
    .slice(0, MAX_FEATURES)
    .map(spec => ({
      name: spec.name,
      category: spec.category,
      requiresApproval: spec.requiresApproval,
      supportedModes: [...spec.supportedModes],
      idempotent: spec.idempotent,
      costTier: spec.costTier,
      requiredCapabilities: [...(spec.requiredCapabilities ?? [])],
    }))

  return jsonContents('elia://modes', 'elia_modes', {
    kind: 'elia-modes',
    generatedAt: now(),
    currentMode: context.mode,
    modes: ELIA_MODES,
    policy: {
      approval: 'Approval-required tools remain unavailable until the exact action is approved.',
      sideEffects: 'Resource reads do not grant execution or approval for any mutating tool.',
      cost: 'Tools report their configured cost tier; runtime budget enforcement remains authoritative.',
    },
    tools,
    truncated: MCP_FEATURE_INVENTORY.length > MAX_FEATURES,
  }, context.cwd)
}

function providerConfiguration(root: string, customBaseUrl: string | undefined): Array<Record<string, unknown>> {
  return PROVIDER_PRESET_NAMES.map(provider => {
    const baseUrlValue = provider === 'custom'
      ? customBaseUrl ?? process.env.ELIA_BASE_URL ?? providerPresetBaseURL(provider)
      : providerPresetBaseURL(provider)
    const baseUrl = sanitizedBaseUrl(baseUrlValue)
    return {
      id: provider,
      defaultModel: providerPresetDefaultModel(provider) ?? null,
      baseUrl: baseUrl === undefined ? null : safeText(baseUrl, root, 2_000, 'baseUrl'),
    }
  })
}

function sanitizedBaseUrl(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return undefined
    return `${url.origin}${url.pathname}`.replace(/\/$/u, '')
  } catch {
    return undefined
  }
}

function readConfig(context: McpToolExecutionContext): McpResourceContents {
  const root = canonicalPath(context.cwd)
  const stored = readUserConfigValues()
  const selected: Record<string, string> = {}
  for (const key of [
    'ELIA_PROVIDER',
    'ELIA_MODEL',
    'ANTHROPIC_MODEL',
    'OPENAI_MODEL',
    'GOOGLE_MODEL',
    'OPENROUTER_MODEL',
    'OLLAMA_MODEL',
  ]) {
    const value = stored[key]
    if (!value) continue
    if (key === 'ELIA_PROVIDER' && !PROVIDER_PRESET_NAMES.includes(value.toLowerCase())) continue
    selected[key] = value
  }
  const baseUrl = sanitizedBaseUrl(stored.ELIA_BASE_URL)
  if (baseUrl) selected.ELIA_BASE_URL = baseUrl

  return jsonContents('elia://config', 'elia_config', {
    kind: 'elia-config',
    generatedAt: now(),
    scope: 'non-secret-only',
    selected: Object.fromEntries(Object.entries(selected).map(([key, value]) => [key, safeText(value, root, 2_000, key)])),
    environment: {
      noColor: process.env.NO_COLOR !== undefined,
      ci: process.env.CI !== undefined,
      nodeEnv: process.env.NODE_ENV === undefined ? null : safeText(process.env.NODE_ENV, root, 100),
    },
    providers: providerConfiguration(root, baseUrl),
  }, root)
}

function readBench(context: McpToolExecutionContext): McpResourceContents {
  const root = canonicalPath(context.cwd)
  const records = readJsonlTail(resolve(root, '.elia', 'bench', 'history.ndjson'), MAX_BENCH_ROWS)
  const selected = records.slice(-MAX_BENCH_ROWS)
  const latest = selected.at(-1) ?? null
  const liftRuns = readLiftRuns(resolve(root, '.elia', 'bench', 'lift.ndjson')).slice(-10)

  return jsonContents('elia://bench/latest', 'elia_bench_latest', {
    kind: 'elia-bench-latest',
    generatedAt: now(),
    scope: 'active-project',
    count: selected.length,
    truncated: records.length === MAX_BENCH_ROWS && selected.length === MAX_BENCH_ROWS,
    latest,
    recent: selected,
    latestLift: liftRuns.at(-1) ?? null,
  }, root)
}

export interface EliaResourceProvider {
  listResources(context: McpToolExecutionContext): readonly McpResourceDescriptor[]
  listResourceTemplates(context: McpToolExecutionContext): readonly McpResourceTemplateDescriptor[]
  readResource(uri: string, context: McpToolExecutionContext): Promise<McpResourceContents>
}

export function listEliaResources(_context: McpToolExecutionContext): readonly McpResourceDescriptor[] {
  return ELIA_RESOURCES
}

export function listEliaResourceTemplates(_context: McpToolExecutionContext): readonly McpResourceTemplateDescriptor[] {
  return ELIA_RESOURCE_TEMPLATES
}

export async function readEliaResource(uri: string, context: McpToolExecutionContext): Promise<McpResourceContents> {
  const parsed = parseEliaUri(uri, context)
  if (parsed.kind === 'static') {
    const payload = parsed.uri === 'elia://runs'
      ? await readRuns(context)
      : parsed.uri === 'elia://sessions'
        ? await readSessions(context)
        : parsed.uri === 'elia://compounding'
          ? await readCompounding(context)
          : parsed.uri === 'elia://modes'
            ? readModes(context)
            : parsed.uri === 'elia://config'
              ? readConfig(context)
              : readBench(context)
    return jsonContents(parsed.uri, STATIC_RESOURCE_NAMES[parsed.uri] ?? 'elia_resource', payload, canonicalPath(context.cwd))
  }
  if (parsed.kind === 'memory') return readProjectMemory(parsed.project, parsed.root, parsed.uri)
  return readLedger(parsed.runId, context, parsed.uri)
}

export function createResourceProvider(baseContext: McpToolExecutionContext): EliaResourceProvider {
  const context = (requestContext?: McpToolExecutionContext): McpToolExecutionContext => requestContext
    ? { ...baseContext, ...requestContext }
    : baseContext
  return {
    listResources: request => listEliaResources(context(request)),
    listResourceTemplates: request => listEliaResourceTemplates(context(request)),
    readResource: (uri, request) => readEliaResource(uri, context(request)),
  }
}

export const createResources = createResourceProvider
export const createMcpResources = createResourceProvider
export const createResourceHandlers = createResourceProvider
