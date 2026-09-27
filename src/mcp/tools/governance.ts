import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { updatePolicy } from '../../autonomy/policyUpdate.ts'
import { loadPolicy } from '../../autonomy/policy.ts'
import { answerWhileWorking, buildLivePrompt, LIVE_TIMEOUT_MS, type LiveContext } from '../../live/liveReply.ts'
import { makeSessionId, makeSessionName, type MemorySlice, type SessionHandle } from '../../session/types.ts'
import { addUsage, estimateCostUsd, totalTokens, ZERO_USAGE } from '../../usage.ts'
import type { Usage } from '../../providers/types.ts'
import { redactSecrets, relativizeProjectPaths } from '../../ui/redact.ts'
import { MCP_FEATURE_BY_NAME } from '../featureInventory.ts'
import {
  defineMcpTool,
  type JsonSchema,
  type McpFeatureMetadata,
  type McpToolDefinition,
  type McpToolExecutionContext,
} from '../serverTypes.ts'

type RecordValue = Record<string, unknown>
type ToolHandler = (input: RecordValue, context: McpToolExecutionContext) => unknown | Promise<unknown>
type ToolMetadata = Omit<McpToolDefinition, 'execute'>

interface FileRead {
  text?: string
  bytes?: number
  error?: string
}

interface RecordFile extends FileRead {
  record?: RecordValue
}

interface NdjsonRead extends FileRead {
  records: RecordValue[]
  invalidLines: number
  recordsDropped: number
}

interface ReceiptRead extends FileRead {
  record?: RecordValue
}

interface UsageRead {
  usage?: Usage
  error?: string
}

interface RunData {
  runId: string
  exists: boolean
  receipt: ReceiptRead
  events: NdjsonRead
  actions: NdjsonRead
  warnings: string[]
}

interface RunSummary {
  runId: string
  goal: string
  outcome: string
  status: string
  startedAt: number | null
  completedAt: number | null
  elapsedMs: number | null
  checkpoints: number
  events: number
  actionCount: number
  failedActions: number
  blockedActions: number
  receiptAvailable: boolean
  usage?: Usage
  model?: string
  rawModel?: string
}

interface ActionSummary {
  total: number
  failed: number
  blocked: number
  irreversible: number
  replayed: number
  byTool: RecordValue
  byRisk: RecordValue
}

interface PathEvidence {
  paths: string[]
  sources: string[]
}

interface ContextRunOptions {
  runsRoot: string
  cwd: string
}

const MAX_SCAN_RUNS = 1_000
const MAX_RECEIPT_BYTES = 1_000_000
const MAX_EVENT_BYTES = 2_000_000
const MAX_ACTION_BYTES = 2_000_000
const MAX_POLICY_BYTES = 256_000
const MAX_RECEIPT_RECORDS = 1_000
const MAX_ACTION_RECORDS = 2_000
const MAX_RETURNED_ACTIONS = 500
const MAX_RETURNED_EVENTS = 500
const MAX_RECEIPT_CHANGES = 100
const MAX_FILE_PATHS = 500
const MAX_QUESTION_LENGTH = 2_000
const MAX_ANSWER_LENGTH = 8_000
const MAX_SAFE_STRING = 2_000
const MAX_SAFE_DEPTH = 8
const MAX_SAFE_ARRAY = 100
const MAX_SAFE_KEYS = 100
const MAX_WARNINGS = 200
const DEFAULT_RUN_LIMIT = 20
const MAX_RUN_LIMIT = 100
const DEFAULT_COST_LIMIT = 50
const MAX_COST_LIMIT = 200
const MIN_QUICK_ASK_TIMEOUT_MS = 1_000
const MAX_QUICK_ASK_TIMEOUT_MS = LIVE_TIMEOUT_MS
const DEFAULT_QUICK_ASK_TIMEOUT_MS = 30_000
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/
const SENSITIVE_KEY = /(api[_-]?key|token|secret|password|passwd|authorization|cookie|private[_-]?key|access[_-]?key|client[_-]?secret|webhook|credential)/i
const WRITE_TOOL = /(^|[._-])(write|edit|patch|delete|create|rename|move)([._-]|$)/i
const FILE_KEY = /^(path|file|filePath|file_path|target|targetPath|target_path|source|sourcePath|source_path|destination|destinationPath|destination_path)$/

const RUN_LIST_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: MAX_RUN_LIMIT, default: DEFAULT_RUN_LIMIT },
    status: { type: 'string', minLength: 1, maxLength: 100 },
    include_incomplete: { type: 'boolean', default: true },
    includeIncomplete: { type: 'boolean', default: true },
  },
  additionalProperties: false,
}

const RUN_RECEIPT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    run_id: { type: 'string', minLength: 1, maxLength: 160 },
    runId: { type: 'string', minLength: 1, maxLength: 160 },
    include_details: { type: 'boolean', default: true },
    includeDetails: { type: 'boolean', default: true },
    include_actions: { type: 'boolean', default: false },
    includeActions: { type: 'boolean', default: false },
    include_events: { type: 'boolean', default: false },
    includeEvents: { type: 'boolean', default: false },
  },
  required: ['run_id'],
  additionalProperties: false,
}

const RUN_DIFF_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    from_run_id: { type: 'string', minLength: 1, maxLength: 160 },
    fromRunId: { type: 'string', minLength: 1, maxLength: 160 },
    to_run_id: { type: 'string', minLength: 1, maxLength: 160 },
    toRunId: { type: 'string', minLength: 1, maxLength: 160 },
    base_run_id: { type: 'string', minLength: 1, maxLength: 160 },
    baseRunId: { type: 'string', minLength: 1, maxLength: 160 },
    compare_run_id: { type: 'string', minLength: 1, maxLength: 160 },
    compareRunId: { type: 'string', minLength: 1, maxLength: 160 },
    include_actions: { type: 'boolean', default: true },
    includeActions: { type: 'boolean', default: true },
    max_actions: { type: 'integer', minimum: 1, maximum: MAX_RETURNED_ACTIONS, default: 200 },
    maxActions: { type: 'integer', minimum: 1, maximum: MAX_RETURNED_ACTIONS, default: 200 },
  },
  additionalProperties: false,
}

const COST_REPORT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    run_id: { type: 'string', minLength: 1, maxLength: 160 },
    runId: { type: 'string', minLength: 1, maxLength: 160 },
    model: { type: 'string', minLength: 1, maxLength: 200 },
    limit: { type: 'integer', minimum: 1, maximum: MAX_COST_LIMIT, default: DEFAULT_COST_LIMIT },
  },
  additionalProperties: false,
}

const POLICY_READ_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
}

const POLICY_UPDATE_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    changes: {
      anyOf: [
        { type: 'object', additionalProperties: true },
        { type: 'array', items: { type: 'object', additionalProperties: true }, maxItems: 200 },
      ],
    },
    reason: { type: 'string', minLength: 1, maxLength: 2_000 },
  },
  required: ['changes', 'reason'],
  additionalProperties: false,
}

const QUICK_ASK_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    session_ref: { type: 'string', minLength: 1, maxLength: 200 },
    sessionRef: { type: 'string', minLength: 1, maxLength: 200 },
    session: { type: 'string', minLength: 1, maxLength: 200 },
    session_id: { type: 'string', minLength: 1, maxLength: 200 },
    sessionId: { type: 'string', minLength: 1, maxLength: 200 },
    question: { type: 'string', minLength: 1, maxLength: MAX_QUESTION_LENGTH },
    message: { type: 'string', minLength: 1, maxLength: MAX_QUESTION_LENGTH },
    prompt: { type: 'string', minLength: 1, maxLength: MAX_QUESTION_LENGTH },
    timeout_ms: { type: 'integer', minimum: MIN_QUICK_ASK_TIMEOUT_MS, maximum: MAX_QUICK_ASK_TIMEOUT_MS, default: DEFAULT_QUICK_ASK_TIMEOUT_MS },
    timeoutMs: { type: 'integer', minimum: MIN_QUICK_ASK_TIMEOUT_MS, maximum: MAX_QUICK_ASK_TIMEOUT_MS, default: DEFAULT_QUICK_ASK_TIMEOUT_MS },
  },
  additionalProperties: false,
}

const JSON_OUTPUT_SCHEMA: JsonSchema = { type: 'object', additionalProperties: true }

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function assertLive(context: McpToolExecutionContext, tool: string): void {
  if (context.signal?.aborted === true) throw new Error(`${tool}: the request was cancelled before it completed.`)
}

function aliasValues(input: RecordValue, keys: readonly string[]): Array<{ key: string; value: unknown }> {
  return keys.filter((key) => input[key] !== undefined).map((key) => ({ key, value: input[key] }))
}

function optionalString(input: RecordValue, keys: readonly string[], tool: string, maxLength: number): string | undefined {
  const found = aliasValues(input, keys)
  if (found.length === 0) return undefined
  if (found.some((entry) => typeof entry.value !== 'string' || (entry.value as string).trim().length === 0 || (entry.value as string).length > maxLength)) {
    throw new Error(`${tool}: ${keys.map((key) => `"${key}"`).join(' or ')} must be a non-empty string of at most ${maxLength} characters.`)
  }
  const strings = found.map((entry) => (entry.value as string).trim())
  if (new Set(strings).size > 1) throw new Error(`${tool}: conflicting values were supplied for ${keys.join(' and ')}.`)
  return strings[0]
}

function requireString(input: RecordValue, keys: readonly string[], tool: string, maxLength: number): string {
  const value = optionalString(input, keys, tool, maxLength)
  if (value === undefined) {
    throw new Error(`${tool}: ${keys.map((key) => `"${key}"`).join(' or ')} is required and must be a non-empty string of at most ${maxLength} characters.`)
  }
  return value
}

function optionalBoolean(input: RecordValue, keys: readonly string[], defaultValue: boolean, tool: string): boolean {
  const [first, ...rest] = aliasValues(input, keys)
  if (first === undefined) return defaultValue
  if (typeof first.value !== 'boolean' || rest.some((entry) => typeof entry.value !== 'boolean')) {
    throw new Error(`${tool}: ${keys.map((key) => `"${key}"`).join(' or ')} must be true or false.`)
  }
  if (new Set([first, ...rest].map((entry) => entry.value)).size > 1) throw new Error(`${tool}: conflicting values were supplied for ${keys.join(' and ')}.`)
  return first.value
}

function optionalInteger(input: RecordValue, keys: readonly string[], defaultValue: number, minimum: number, maximum: number, tool: string): number {
  const [first, ...rest] = aliasValues(input, keys)
  if (first === undefined) return defaultValue
  if (typeof first.value !== 'number' || !Number.isInteger(first.value) || first.value < minimum || first.value > maximum
    || rest.some((entry) => typeof entry.value !== 'number' || !Number.isInteger(entry.value) || entry.value < minimum || entry.value > maximum)) {
    throw new Error(`${tool}: ${keys.map((key) => `"${key}"`).join(' or ')} must be an integer from ${minimum} to ${maximum}.`)
  }
  if (new Set([first, ...rest].map((entry) => entry.value)).size > 1) throw new Error(`${tool}: conflicting values were supplied for ${keys.join(' and ')}.`)
  return first.value
}

function validateRunId(value: string, tool: string): string {
  if (!RUN_ID_PATTERN.test(value) || value === '.' || value === '..') {
    throw new Error(`${tool}: run_id contains unsupported characters or is too long.`)
  }
  return value
}

function runsRoot(cwd: string): string {
  return resolve(cwd, '.elia', 'runs')
}

function insideRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function projectStateDirectory(cwd: string, child?: string): { path?: string; error?: string } {
  try {
    const project = realpathSync.native(resolve(cwd))
    const requestedState = resolve(cwd, '.elia')
    let state = join(project, '.elia')
    if (existsSync(requestedState)) {
      const stateStat = lstatSync(requestedState)
      if (!stateStat.isDirectory() || stateStat.isSymbolicLink()) return { error: 'The project .elia state directory must be a regular, non-symlink directory.' }
      state = realpathSync.native(requestedState)
    }
    if (!insideRoot(project, state)) return { error: 'The project .elia state directory resolves outside the project.' }
    if (child === undefined) return { path: state }
    const requestedChild = join(state, child)
    let resolvedChild = requestedChild
    if (existsSync(requestedChild)) {
      const childStat = lstatSync(requestedChild)
      if (!childStat.isDirectory() || childStat.isSymbolicLink()) return { error: `The project .elia/${child} state directory must be a regular, non-symlink directory.` }
      resolvedChild = realpathSync.native(requestedChild)
    }
    if (!insideRoot(state, resolvedChild)) return { error: `The project .elia/${child} state directory resolves outside the project.` }
    return { path: resolvedChild }
  } catch {
    return { error: 'The project state directory could not be resolved.' }
  }
}

function projectRelative(cwd: string, path: string): string {
  const rel = relative(cwd, path)
  if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) return rel.replaceAll('\\', '/')
  return relativizeProjectPaths(path, cwd)
}

function redactText(value: string, maxLength: number, cwd: string): string {
  const localized = relativizeProjectPaths(value, cwd)
  const redacted = redactSecrets(localized).replace(/\s+/g, ' ').trim()
  return redacted.length > maxLength ? `${redacted.slice(0, Math.max(0, maxLength - 1))}…` : redacted
}

function safeWarnings(warnings: readonly string[], cwd: string): string[] {
  const redacted = warnings.map((warning) => redactText(warning, MAX_SAFE_STRING, cwd))
  if (redacted.length <= MAX_WARNINGS) return redacted
  return [...redacted.slice(0, MAX_WARNINGS), `${redacted.length - MAX_WARNINGS} additional warnings omitted`]
}

function publicRunSummary(summary: RunSummary, cwd: string): RecordValue {
  const view = {
    run_id: summary.runId,
    goal: summary.goal,
    outcome: summary.outcome,
    status: summary.status,
    started_at: summary.startedAt,
    completed_at: summary.completedAt,
    elapsed_ms: summary.elapsedMs,
    checkpoints: summary.checkpoints,
    events: summary.events,
    action_count: summary.actionCount,
    failed_actions: summary.failedActions,
    blocked_actions: summary.blockedActions,
    receipt_available: summary.receiptAvailable,
    usage: summary.usage,
    model: summary.model,
  }
  const safe = safeValue(view, cwd)
  return isRecord(safe) ? safe : {}
}

function safeValue(value: unknown, cwd: string, depth = 0, key?: string): unknown {
  if (key !== undefined && SENSITIVE_KEY.test(key)) return '[REDACTED]'
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : '[UNSAFE_NUMBER]'
  if (typeof value === 'string') return redactText(value, MAX_SAFE_STRING, cwd)
  if (typeof value === 'bigint') return value.toString()
  if (depth >= MAX_SAFE_DEPTH) return '[TRUNCATED]'
  if (Array.isArray(value)) return value.slice(0, MAX_SAFE_ARRAY).map((item) => safeValue(item, cwd, depth + 1))
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).slice(0, MAX_SAFE_KEYS).map(([childKey, childValue]) => [childKey, safeValue(childValue, cwd, depth + 1, childKey)]))
  }
  return undefined
}

function readRegularFile(path: string, maxBytes: number): FileRead {
  try {
    const file = lstatSync(path)
    if (!file.isFile() || file.isSymbolicLink()) return { error: `${path} is not a regular, non-symlink file.` }
    if (file.size > maxBytes) return { bytes: file.size, error: `${path} exceeds the ${maxBytes}-byte read limit.` }
    const text = readFileSync(path, 'utf8')
    if (Buffer.byteLength(text, 'utf8') > maxBytes) return { bytes: Buffer.byteLength(text, 'utf8'), error: `${path} exceeded the read limit while being read.` }
    return { text, bytes: Buffer.byteLength(text, 'utf8') }
  } catch (error) {
    return { error: errorMessage(error) }
  }
}

function readJsonRecord(path: string, maxBytes: number): RecordFile {
  const file = readRegularFile(path, maxBytes)
  if (file.text === undefined) return file
  try {
    const parsed: unknown = JSON.parse(file.text)
    if (!isRecord(parsed)) return { ...file, error: `${path} must contain a JSON object.` }
    return { ...file, record: parsed }
  } catch (error) {
    return { ...file, error: `${path} is not valid JSON: ${errorMessage(error)}` }
  }
}

function readNdjson(path: string, maxBytes: number, maxRecords: number): NdjsonRead {
  const file = readRegularFile(path, maxBytes)
  if (file.text === undefined) return { ...file, records: [], invalidLines: 0, recordsDropped: 0 }
  const records: RecordValue[] = []
  let invalidLines = 0
  for (const line of file.text.split('\n')) {
    if (line.trim().length === 0) continue
    if (records.length >= maxRecords) continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (isRecord(parsed)) records.push(parsed)
      else invalidLines += 1
    } catch {
      invalidLines += 1
    }
  }
  const nonEmptyLines = file.text.split('\n').filter((line) => line.trim().length > 0).length
  return { ...file, records, invalidLines, recordsDropped: Math.max(0, nonEmptyLines - records.length - invalidLines) }
}

function safeRunFile(options: ContextRunOptions, runId: string, name: string): { path?: string; error?: string } {
  const root = options.runsRoot
  if (!existsSync(root)) return { error: 'The project run store does not exist.' }
  try {
    const realProject = realpathSync.native(resolve(options.cwd))
    const realRoot = realpathSync.native(root)
    if (!insideRoot(realProject, realRoot)) return { error: 'The project run store resolves outside the project.' }
    const runPath = join(realRoot, runId)
    if (!existsSync(runPath)) return { error: `Run ${runId} does not exist.` }
    const runStat = lstatSync(runPath)
    if (!runStat.isDirectory() || runStat.isSymbolicLink()) return { error: `Run ${runId} is not a regular, non-symlink directory.` }
    const realRunPath = realpathSync.native(runPath)
    if (!insideRoot(realRoot, realRunPath)) return { error: `Run ${runId} resolves outside the project run store.` }
    const candidate = join(realRunPath, name)
    const candidateStat = lstatSync(candidate)
    if (!candidateStat.isFile() || candidateStat.isSymbolicLink()) return { error: `Run artifact ${name} is not a regular, non-symlink file.` }
    const realCandidate = realpathSync.native(candidate)
    if (!insideRoot(realRoot, realCandidate)) return { error: `Run artifact ${name} resolves outside the project run store.` }
    return { path: realCandidate }
  } catch {
    return { error: `Run ${runId} artifact ${name} could not be read safely.` }
  }
}

function readRunData(cwd: string, runId: string, includeActions = true): RunData {
  validateRunId(runId, 'run data')
  const root = projectStateDirectory(cwd, 'runs')
  const options: ContextRunOptions = { cwd, runsRoot: root.path ?? runsRoot(cwd) }
  const exists = root.path !== undefined && existsSync(join(root.path, runId))
  const receiptPath = safeRunFile(options, runId, 'receipt.json')
  const eventsPath = safeRunFile(options, runId, 'events.ndjson')
  const actionsPath = safeRunFile(options, runId, 'actions.ndjson')
  const receipt: ReceiptRead = receiptPath.path
    ? readJsonRecord(receiptPath.path, MAX_RECEIPT_BYTES)
    : { error: root.error ?? receiptPath.error ?? `Run ${runId} has no receipt.json.` }
  const events = eventsPath.path
    ? readNdjson(eventsPath.path, MAX_EVENT_BYTES, MAX_RECEIPT_RECORDS)
    : { records: [], invalidLines: 0, recordsDropped: 0, error: root.error ?? eventsPath.error ?? `Run ${runId} has no events.ndjson.` }
  const actions = includeActions && actionsPath.path
    ? readNdjson(actionsPath.path, MAX_ACTION_BYTES, MAX_ACTION_RECORDS)
    : { records: [], invalidLines: 0, recordsDropped: 0, error: includeActions ? root.error ?? actionsPath.error ?? `Run ${runId} has no actions.ndjson.` : undefined }
  const warnings = [receipt.error, events.error, actions.error].filter((warning): warning is string => warning !== undefined)
  return { runId, exists, receipt, events, actions, warnings }
}

function recordNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function recordString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function readUsage(value: unknown): UsageRead {
  if (value === undefined) return {}
  if (!isRecord(value)) return { error: 'Receipt usage is not an object.' }
  const fields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const
  const usage = {} as Usage
  for (const field of fields) {
    const raw = value[field]
    if (raw === undefined) {
      Object.assign(usage, { [field]: 0 })
      continue
    }
    if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) return { error: `Receipt usage.${field} is invalid.` }
    Object.assign(usage, { [field]: raw })
  }
  if (value.cacheWrite1hTokens !== undefined) {
    if (typeof value.cacheWrite1hTokens !== 'number' || !Number.isSafeInteger(value.cacheWrite1hTokens) || value.cacheWrite1hTokens < 0) return { error: 'Receipt usage.cacheWrite1hTokens is invalid.' }
    usage.cacheWrite1hTokens = value.cacheWrite1hTokens
  }
  return { usage }
}

function receiptUsage(record: RecordValue | undefined): UsageRead {
  if (record === undefined) return {}
  const operational = isRecord(record.operational) ? record.operational : undefined
  return readUsage(record.usage ?? operational?.usage)
}

function receiptModel(record: RecordValue | undefined): string | undefined {
  if (record === undefined) return undefined
  const operational = isRecord(record.operational) ? record.operational : undefined
  const metadata = isRecord(record.metadata) ? record.metadata : undefined
  return recordString(record.model)
    ?? recordString(record.modelId)
    ?? recordString(operational?.model)
    ?? recordString(metadata?.model)
}

function countBy(records: RecordValue[], key: (record: RecordValue) => string): RecordValue {
  const counts: RecordValue = {}
  for (const record of records) {
    const value = key(record)
    counts[value] = typeof counts[value] === 'number' ? (counts[value] as number) + 1 : 1
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)))
}

function actionSummary(records: RecordValue[]): ActionSummary {
  return {
    total: records.length,
    failed: records.filter((record) => record.isError === true).length,
    blocked: records.filter((record) => record.decision === 'block').length,
    irreversible: records.filter((record) => record.reversible === false).length,
    replayed: records.filter((record) => record.replayed === true).length,
    byTool: countBy(records, (record) => recordString(record.tool) ?? 'unknown'),
    byRisk: countBy(records, (record) => recordString(record.risk) ?? 'unknown'),
  }
}

function summarizeRun(data: RunData, cwd: string): RunSummary {
  const receipt = data.receipt.record
  const start = data.events.records.find((event) => event.kind === 'run-start')
  const end = [...data.events.records].reverse().find((event) => event.kind === 'run-end')
  const startData = isRecord(start?.data) ? start.data : undefined
  const endData = isRecord(end?.data) ? end.data : undefined
  const outcome = recordString(receipt?.outcome) ?? recordString(endData?.outcome) ?? 'incomplete'
  const usageRead = receiptUsage(receipt)
  if (usageRead.error !== undefined) data.warnings.push(usageRead.error)
  const model = receiptModel(receipt)
  return {
    runId: data.runId,
    goal: redactText(recordString(receipt?.goal) ?? recordString(startData?.goal) ?? '(unknown goal)', MAX_SAFE_STRING, cwd),
    outcome: redactText(outcome, 200, cwd),
    status: end === undefined ? 'incomplete' : redactText(outcome, 200, cwd),
    startedAt: recordNumber(receipt?.createdAt) ?? recordNumber(start?.at) ?? null,
    completedAt: recordNumber(receipt?.completedAt) ?? recordNumber(end?.at) ?? null,
    elapsedMs: recordNumber(receipt?.elapsedMs) ?? recordNumber(receipt?.operational && isRecord(receipt.operational) ? receipt.operational.elapsedMs : undefined) ?? null,
    checkpoints: data.events.records.filter((event) => event.kind === 'checkpoint').length,
    events: data.events.records.length,
    actionCount: data.actions.records.length,
    failedActions: data.actions.records.filter((record) => record.isError === true).length,
    blockedActions: data.actions.records.filter((record) => record.decision === 'block').length,
    receiptAvailable: receipt !== undefined,
    usage: usageRead.usage,
    model: model === undefined ? undefined : redactText(model, 200, cwd),
    rawModel: model,
  }
}

function listRunIds(cwd: string): { ids: string[]; scanned: number; truncated: boolean; error?: string } {
  const resolved = projectStateDirectory(cwd, 'runs')
  if (resolved.path === undefined) return { ids: [], scanned: 0, truncated: false, error: resolved.error ?? `Run store ${projectRelative(cwd, runsRoot(cwd))} does not exist.` }
  try {
    const names = readdirSync(resolved.path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && RUN_ID_PATTERN.test(entry.name) && entry.name !== '.' && entry.name !== '..')
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left))
    return { ids: names.slice(0, MAX_SCAN_RUNS), scanned: names.length, truncated: names.length > MAX_SCAN_RUNS }
  } catch {
    return { ids: [], scanned: 0, truncated: false, error: 'The project run store could not be listed safely.' }
  }
}

function actionView(record: RecordValue, cwd: string): RecordValue {
  return {
    at: recordNumber(record.at) ?? null,
    actor: redactText(recordString(record.actor) ?? 'unknown', 200, cwd),
    role: redactText(recordString(record.role) ?? 'unknown', 200, cwd),
    tool: redactText(recordString(record.tool) ?? 'unknown', 200, cwd),
    input: safeValue(record.input, cwd),
    result: redactText(recordString(record.result) ?? '', 800, cwd),
    is_error: record.isError === true,
    decision: recordString(record.decision) ?? null,
    risk: recordString(record.risk) ?? null,
    intent: recordString(record.intent) ?? null,
    resources: Array.isArray(record.resources) ? record.resources.slice(0, 50).map((item) => redactText(recordString(item) ?? '', 500, cwd)) : [],
    duration_ms: recordNumber(record.durationMs) ?? null,
  }
}

function eventView(record: RecordValue, cwd: string): RecordValue {
  return {
    seq: recordNumber(record.seq) ?? null,
    at: recordNumber(record.at) ?? null,
    kind: redactText(recordString(record.kind) ?? 'unknown', 100, cwd),
    data: safeValue(record.data, cwd),
  }
}

function listRuns(input: RecordValue, context: McpToolExecutionContext): RecordValue {
  assertLive(context, 'elia_runs_list')
  const limit = optionalInteger(input, ['limit'], DEFAULT_RUN_LIMIT, 1, MAX_RUN_LIMIT, 'elia_runs_list')
  const status = optionalString(input, ['status'], 'elia_runs_list', 100)
  const includeIncomplete = optionalBoolean(input, ['include_incomplete', 'includeIncomplete'], true, 'elia_runs_list')
  const listed = listRunIds(context.cwd)
  const summaries: RunSummary[] = []
  for (const runId of listed.ids) {
    const summary = summarizeRun(readRunData(context.cwd, runId, false), context.cwd)
    if (status !== undefined && summary.status.toLowerCase() !== status.toLowerCase() && summary.outcome.toLowerCase() !== status.toLowerCase()) continue
    if (!includeIncomplete && summary.status === 'incomplete') continue
    summaries.push(summary)
  }
  summaries.sort((left, right) => (right.startedAt ?? 0) - (left.startedAt ?? 0) || right.runId.localeCompare(left.runId))
  const runs = summaries.slice(0, limit).map((summary) => publicRunSummary(summary, context.cwd))
  return {
    ok: true,
    scope: 'project',
    runs,
    returned: runs.length,
    matched: summaries.length,
    scanned: listed.scanned,
    truncated: listed.truncated || summaries.length > runs.length,
    warnings: safeWarnings(listed.error === undefined ? [] : [listed.error], context.cwd),
  }
}

function readReceipt(input: RecordValue, context: McpToolExecutionContext): RecordValue {
  assertLive(context, 'elia_run_receipt')
  const runId = validateRunId(requireString(input, ['run_id', 'runId'], 'elia_run_receipt', 160), 'elia_run_receipt')
  const includeDetails = optionalBoolean(input, ['include_details', 'includeDetails'], true, 'elia_run_receipt')
  const includeActions = optionalBoolean(input, ['include_actions', 'includeActions'], false, 'elia_run_receipt')
  const includeEvents = optionalBoolean(input, ['include_events', 'includeEvents'], false, 'elia_run_receipt')
  const data = readRunData(context.cwd, runId, includeActions)
  const summary = summarizeRun(data, context.cwd)
  return {
    ok: true,
    scope: 'project',
    run: publicRunSummary(summary, context.cwd),
    available: data.receipt.record !== undefined,
    receipt: includeDetails && data.receipt.record !== undefined ? safeValue(data.receipt.record, context.cwd) : null,
    actions: includeActions ? data.actions.records.slice(0, MAX_RETURNED_ACTIONS).map((record) => actionView(record, context.cwd)) : [],
    events: includeEvents ? data.events.records.slice(0, MAX_RETURNED_EVENTS).map((record) => eventView(record, context.cwd)) : [],
    artifacts: {
      receipt: data.receipt.record === undefined ? null : `.elia/runs/${runId}/receipt.json`,
      events: data.events.records.length > 0 ? `.elia/runs/${runId}/events.ndjson` : null,
      actions: data.actions.records.length > 0 ? `.elia/runs/${runId}/actions.ndjson` : null,
    },
    warnings: safeWarnings(data.warnings, context.cwd),
  }
}

function collectPaths(value: unknown, paths: Set<string>, cwd: string, depth = 0): void {
  if (depth > 4 || paths.size >= MAX_FILE_PATHS) return
  if (typeof value === 'string') {
    const normalized = relativizeProjectPaths(value, cwd).replaceAll('\\', '/')
    if (normalized.length > 0 && normalized.length <= 1_000) paths.add(normalized)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPaths(item, paths, cwd, depth + 1)
    return
  }
  if (!isRecord(value)) return
  for (const [key, child] of Object.entries(value)) {
    if (FILE_KEY.test(key) && (typeof child === 'string' || Array.isArray(child))) collectPaths(child, paths, cwd, depth + 1)
  }
}

function pathEvidence(data: RunData, cwd: string): PathEvidence {
  const paths = new Set<string>()
  const sources = new Set<string>()
  const proposal = isRecord(data.receipt.record?.proposal) ? data.receipt.record.proposal : undefined
  if (proposal !== undefined && Array.isArray(proposal.steps)) {
    for (const step of proposal.steps) {
      if (!isRecord(step) || !Array.isArray(step.files)) continue
      collectPaths(step.files, paths, cwd)
      sources.add('receipt proposal declarations')
    }
  }
  for (const event of data.events.records) {
    if (event.kind !== 'variants' || !isRecord(event.data)) continue
    collectPaths(event.data.mergedFiles, paths, cwd)
    sources.add('variant journal merge records')
  }
  for (const action of data.actions.records) {
    const tool = recordString(action.tool) ?? ''
    if (!WRITE_TOOL.test(tool) || !isRecord(action.input)) continue
    collectPaths(action.input, paths, cwd)
    sources.add('write action ledger entries')
  }
  return { paths: [...paths].sort(), sources: [...sources].sort() }
}

function setDifference(left: Set<string>, right: Set<string>): string[] {
  return [...left].filter((value) => !right.has(value)).sort()
}

function intersection(left: Set<string>, right: Set<string>): string[] {
  return [...left].filter((value) => right.has(value)).sort()
}

function compareCountMaps(left: RecordValue, right: RecordValue): Array<{ key: string; from: number; to: number; delta: number }> {
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()
  return keys.map((key) => {
    const from = typeof left[key] === 'number' ? left[key] as number : 0
    const to = typeof right[key] === 'number' ? right[key] as number : 0
    return { key, from, to, delta: to - from }
  })
}

function metricDiff(from: RunSummary, to: RunSummary): RecordValue {
  const usageFields: Array<keyof Usage> = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'cacheWrite1hTokens']
  const usage: RecordValue = {}
  for (const field of usageFields) {
    const before = from.usage?.[field] ?? 0
    const after = to.usage?.[field] ?? 0
    usage[field] = { from: before, to: after, delta: after - before }
  }
  return {
    elapsed_ms: { from: from.elapsedMs, to: to.elapsedMs, delta: from.elapsedMs === null || to.elapsedMs === null ? null : to.elapsedMs - from.elapsedMs },
    actions: { from: from.actionCount, to: to.actionCount, delta: to.actionCount - from.actionCount },
    failed_actions: { from: from.failedActions, to: to.failedActions, delta: to.failedActions - from.failedActions },
    blocked_actions: { from: from.blockedActions, to: to.blockedActions, delta: to.blockedActions - from.blockedActions },
    events: { from: from.events, to: to.events, delta: to.events - from.events },
    checkpoints: { from: from.checkpoints, to: to.checkpoints, delta: to.checkpoints - from.checkpoints },
    tokens: { from: from.usage === undefined ? null : totalTokens(from.usage), to: to.usage === undefined ? null : totalTokens(to.usage) },
    usage,
  }
}

function receiptChanges(from: RecordValue | undefined, to: RecordValue | undefined, cwd: string): RecordValue[] {
  if (from === undefined || to === undefined) return []
  const ignored = new Set(['createdAt', 'completedAt'])
  const keys = [...new Set([...Object.keys(from), ...Object.keys(to)])].filter((key) => !ignored.has(key)).sort()
  const changes: RecordValue[] = []
  for (const key of keys) {
    if (changes.length >= MAX_RECEIPT_CHANGES) break
    const before = safeValue(from[key], cwd, 0, key)
    const after = safeValue(to[key], cwd, 0, key)
    if (JSON.stringify(before) === JSON.stringify(after)) continue
    changes.push({
      field: key,
      from: from[key] === undefined ? null : before,
      to: to[key] === undefined ? null : after,
      kind: from[key] === undefined ? 'added' : to[key] === undefined ? 'removed' : 'changed',
    })
  }
  return changes
}

function comparisonRefs(input: RecordValue, tool: string): { from: string; to: string } {
  const from = optionalString(input, ['from_run_id', 'fromRunId', 'from', 'base_run_id', 'baseRunId', 'base'], tool, 160)
  const to = optionalString(input, ['to_run_id', 'toRunId', 'to', 'compare_run_id', 'compareRunId', 'compare'], tool, 160)
  if (from === undefined || to === undefined) throw new Error(`${tool}: from_run_id and to_run_id are required.`)
  return { from: validateRunId(from, tool), to: validateRunId(to, tool) }
}

function diffRuns(input: RecordValue, context: McpToolExecutionContext): RecordValue {
  assertLive(context, 'elia_run_diff')
  const refs = comparisonRefs(input, 'elia_run_diff')
  const includeActions = optionalBoolean(input, ['include_actions', 'includeActions'], true, 'elia_run_diff')
  const maxActions = optionalInteger(input, ['max_actions', 'maxActions'], 200, 1, MAX_RETURNED_ACTIONS, 'elia_run_diff')
  const fromData = readRunData(context.cwd, refs.from, includeActions)
  const toData = readRunData(context.cwd, refs.to, includeActions)
  const from = summarizeRun(fromData, context.cwd)
  const to = summarizeRun(toData, context.cwd)
  const fromPaths = new Set(pathEvidence(fromData, context.cwd).paths)
  const toPaths = new Set(pathEvidence(toData, context.cwd).paths)
  const fromActionSummary = actionSummary(fromData.actions.records)
  const toActionSummary = actionSummary(toData.actions.records)
  const fromPhases = countBy(fromData.events.records.filter((event) => event.kind === 'phase'), (event) => isRecord(event.data) ? recordString(event.data.phase) ?? 'unknown' : 'unknown')
  const toPhases = countBy(toData.events.records.filter((event) => event.kind === 'phase'), (event) => isRecord(event.data) ? recordString(event.data.phase) ?? 'unknown' : 'unknown')
  return {
    ok: true,
    scope: 'project',
    from_run_id: refs.from,
    to_run_id: refs.to,
    from_run: publicRunSummary(from, context.cwd),
    to_run: publicRunSummary(to, context.cwd),
    metrics: metricDiff(from, to),
    receipt_changes: receiptChanges(fromData.receipt.record, toData.receipt.record, context.cwd),
    tool_counts: compareCountMaps(fromActionSummary.byTool, toActionSummary.byTool),
    phase_counts: compareCountMaps(fromPhases, toPhases),
    file_activity: {
      from_only: setDifference(fromPaths, toPaths),
      to_only: setDifference(toPaths, fromPaths),
      common: intersection(fromPaths, toPaths),
      sources: [...new Set([...pathEvidence(fromData, context.cwd).sources, ...pathEvidence(toData, context.cwd).sources])].sort(),
    },
    actions: includeActions
      ? {
          from: fromData.actions.records.slice(0, maxActions).map((record) => actionView(record, context.cwd)),
          to: toData.actions.records.slice(0, maxActions).map((record) => actionView(record, context.cwd)),
          from_truncated: fromData.actions.records.length > maxActions,
          to_truncated: toData.actions.records.length > maxActions,
        }
      : null,
    evidence: {
      receipts: [fromData.receipt.record !== undefined, toData.receipt.record !== undefined],
      journals: [fromData.events.records.length, toData.events.records.length],
      action_ledgers: [fromData.actions.records.length, toData.actions.records.length],
      source_patch_available: false,
      limitation: 'Run receipts and journals do not persist base/end commits or source snapshots, so this reports recorded run and file activity rather than fabricating a historical source patch.',
    },
    warnings: safeWarnings([...fromData.warnings, ...toData.warnings], context.cwd),
  }
}

function costRow(data: RunData, summary: RunSummary, explicitModel: string | undefined, cwd: string): RecordValue {
  const model = explicitModel ?? summary.rawModel
  const costUsd = summary.usage === undefined || model === undefined ? undefined : estimateCostUsd(model, summary.usage, cwd)
  return {
    run_id: data.runId,
    model: model === undefined ? null : redactText(model, 200, cwd),
    usage: summary.usage,
    total_tokens: summary.usage === undefined ? null : totalTokens(summary.usage),
    cost_usd: costUsd ?? null,
    cost_known: costUsd !== undefined,
    receipt_available: summary.receiptAvailable,
  }
}

function costReport(input: RecordValue, context: McpToolExecutionContext): RecordValue {
  assertLive(context, 'elia_cost_report')
  const requestedRun = optionalString(input, ['run_id', 'runId'], 'elia_cost_report', 160)
  const explicitModel = optionalString(input, ['model'], 'elia_cost_report', 200)
  const limit = optionalInteger(input, ['limit'], DEFAULT_COST_LIMIT, 1, MAX_COST_LIMIT, 'elia_cost_report')
  const listed = listRunIds(context.cwd)
  const ids = requestedRun === undefined ? listed.ids.slice(0, limit) : [validateRunId(requestedRun, 'elia_cost_report')]
  if (ids.length === 0) return { ok: true, scope: 'project', runs: [], totals: { usage: ZERO_USAGE, total_tokens: 0, cost_usd: null, cost_known: false }, warnings: safeWarnings(listed.error === undefined ? [] : [listed.error], context.cwd) }
  const rows: RecordValue[] = []
  const warnings = listed.error === undefined ? [] : [listed.error]
  let total = ZERO_USAGE
  let allUsagePriced = true
  let knownCost = 0
  for (const runId of ids) {
    const data = readRunData(context.cwd, runId, false)
    const summary = summarizeRun(data, context.cwd)
    warnings.push(...data.warnings.map((warning) => `${runId}: ${warning}`))
    if (summary.usage !== undefined) total = addUsage(total, summary.usage)
    const row = costRow(data, summary, explicitModel, context.cwd)
    rows.push(row)
    if (summary.usage === undefined) {
      allUsagePriced = false
      warnings.push(`${runId}: receipt has no valid usage totals.`)
      continue
    }
    if (row.cost_known === true && typeof row.cost_usd === 'number') knownCost += row.cost_usd
    else {
      allUsagePriced = false
      warnings.push(`${runId}: cost is unknown for the recorded model and usage.`)
    }
  }
  const costUsd = allUsagePriced ? knownCost : null
  return {
    ok: true,
    scope: 'project',
    model: explicitModel === undefined ? null : redactText(explicitModel, 200, context.cwd),
    basis: explicitModel === undefined ? 'receipt-recorded model where available' : 'operator-supplied model applied to receipt aggregate usage',
    estimate_only: true,
    runs: rows,
    totals: {
      usage: total,
      total_tokens: totalTokens(total),
      cost_usd: costUsd,
      cost_known: costUsd !== null,
      partial_known_cost_usd: allUsagePriced ? null : knownCost,
    },
    warnings: safeWarnings(warnings, context.cwd),
  }
}

function readPolicyFile(cwd: string): { exists: boolean; path: string } {
  const state = projectStateDirectory(cwd)
  if (state.path === undefined) throw new Error(`elia_policy_read: ${state.error ?? 'the project state directory is unavailable.'}`)
  const path = join(state.path, 'policy.json')
  if (!existsSync(path)) return { exists: false, path }
  const file = lstatSync(path)
  if (!file.isFile() || file.isSymbolicLink()) throw new Error('elia_policy_read: .elia/policy.json must be a regular, non-symlink file.')
  if (file.size > MAX_POLICY_BYTES) throw new Error(`elia_policy_read: .elia/policy.json exceeds the ${MAX_POLICY_BYTES}-byte limit.`)
  return { exists: true, path }
}

function readPolicy(context: McpToolExecutionContext): RecordValue {
  assertLive(context, 'elia_policy_read')
  const file = readPolicyFile(context.cwd)
  const effective = loadPolicy(context.cwd) ?? { denyTools: [], denyIntents: [], denyCommandPatterns: [], requireApprovalAtOrAbove: 'critical' as const }
  return {
    ok: true,
    scope: 'project',
    path: '.elia/policy.json',
    exists: file.exists,
    effective: safeValue(effective, context.cwd),
    monotonic: true,
  }
}

function updatePolicyTool(input: RecordValue, context: McpToolExecutionContext): Promise<unknown> {
  assertLive(context, 'elia_policy_update')
  if (input.changes === undefined) throw new Error('elia_policy_update: "changes" is required.')
  const reason = requireString(input, ['reason'], 'elia_policy_update', 2_000)
  if (input.approved !== undefined || input.actor !== undefined || input.approval !== undefined) {
    throw new Error('elia_policy_update: approval is decided by the elia governor and cannot be supplied by the client.')
  }
  return context.governedMutation('policy_update', { reason: redactText(reason, 500, context.cwd) }, () => updatePolicy({
    changes: input.changes,
    reason,
    approved: true,
    actor: 'elia-governor',
    cwd: context.cwd,
    persist: true,
  })).then(
    (result) => safeValue(result, context.cwd),
    (error) => { throw new Error(redactText(errorMessage(error), 2_000, context.cwd)) },
  )
}

function redactMemory(memory: MemorySlice, cwd: string): MemorySlice {
  const bounded = (entries: readonly string[]): string[] => entries.slice(0, 30).map((entry) => redactText(entry, 500, cwd))
  return {
    lessons: bounded(memory.lessons),
    projectNotes: bounded(memory.projectNotes),
    localLessons: bounded(memory.localLessons),
    localNotes: bounded(memory.localNotes),
  }
}

function sanitizedSession(session: SessionHandle, cwd: string): SessionHandle {
  const sharedContext = safeValue(session.sharedContext, cwd)
  return {
    id: makeSessionId(session.id),
    name: makeSessionName(redactText(session.name, 200, cwd) || 'session'),
    status: session.status,
    taskQueue: [],
    memorySlice: redactMemory(session.memorySlice, cwd),
    lastActivity: session.lastActivity,
    activeAgents: session.activeAgents,
    sharedContext: isRecord(sharedContext) ? sharedContext : {},
    dependencies: session.dependencies.slice(0, 50).map((dependency) => ({ ...dependency })),
    checkpoints: new Map(),
    ...(session.lastTask === undefined ? {} : { lastTask: redactText(session.lastTask, 500, cwd) }),
  }
}

/**
 * The live lane's view of a bus session. /quickchat, which this tool first
 * wrapped, was retired for the live lane; a bus session has no running turn
 * the lane could watch, so the view is the session's last task and status, and
 * the lane's read-only tools cover the rest.
 */
function quickAskView(session: SessionHandle, cwd: string): LiveContext {
  return {
    request: session.lastTask ?? '',
    elapsedMs: Math.max(0, Date.now() - session.lastActivity),
    status: `session ${session.status}`,
    runningTools: [],
    plan: [],
    recentTools: [],
    assistantSoFar: '',
    steering: [],
    conversation: [],
    exchanges: [],
    cwd,
  }
}

async function quickAsk(input: RecordValue, context: McpToolExecutionContext): Promise<RecordValue> {
  assertLive(context, 'elia_quick_ask')
  const requestedRef = optionalString(input, ['session_ref', 'sessionRef', 'session', 'session_id', 'sessionId'], 'elia_quick_ask', 200)
  const questionValue = optionalString(input, ['question', 'message', 'prompt'], 'elia_quick_ask', MAX_QUESTION_LENGTH)
  if (questionValue === undefined) throw new Error('elia_quick_ask: "question" is required.')
  const timeoutMs = optionalInteger(input, ['timeout_ms', 'timeoutMs'], DEFAULT_QUICK_ASK_TIMEOUT_MS, MIN_QUICK_ASK_TIMEOUT_MS, MAX_QUICK_ASK_TIMEOUT_MS, 'elia_quick_ask')
  const sessionRef = requestedRef ?? context.sessionBus.activeSession
  if (sessionRef === undefined) throw new Error('elia_quick_ask: no session was specified and this MCP server has no active session.')
  const original = context.sessionBus.resolve(sessionRef)
  if (original === undefined) throw new Error(`elia_quick_ask: unknown session "${redactText(sessionRef, 200, context.cwd)}".`)
  const safeSession = sanitizedSession(original, context.cwd)
  const question = redactText(questionValue, MAX_QUESTION_LENGTH, context.cwd)
  const view = quickAskView(safeSession, context.cwd)
  context.emit({ type: 'progress', tool: 'elia_quick_ask', status: 'starting', message: 'Asking the read-only live lane.' })
  let answer: string
  let direction: string | undefined
  let failed = false
  try {
    const reply = await answerWhileWorking(view, question, { timeoutMs })
    answer = redactText(reply.answer, MAX_ANSWER_LENGTH, context.cwd)
    direction = reply.steer === undefined ? undefined : redactText(reply.steer, 500, context.cwd)
  } catch (error) {
    failed = true
    answer = redactText(`quick ask failed: ${errorMessage(error)}`, MAX_ANSWER_LENGTH, context.cwd)
  }
  assertLive(context, 'elia_quick_ask')
  context.emit({ type: 'progress', tool: 'elia_quick_ask', status: failed ? 'failed' : 'completed', message: failed ? 'The bounded quick question did not complete.' : 'The bounded quick question completed.' })
  const memory = safeSession.memorySlice
  return {
    ok: !failed,
    scope: 'session-bus',
    session: { id: redactText(safeSession.id, 200, context.cwd), name: safeSession.name, status: safeSession.status },
    question,
    answer,
    // The lane is read-only: a direction it heard is reported, never applied.
    // Queuing work into a session is elia_session_inject, which is governed.
    ...(direction === undefined ? {} : { direction, direction_applied: false }),
    tier: process.env.ELIA_LIVE_TIER?.trim().toLowerCase() === 'deep' ? 'deep' : 'fast',
    timeout_ms: timeoutMs,
    context: {
      estimated_tokens: Math.ceil(buildLivePrompt(view, question).length / 4),
      plan_steps: 0,
      memory_items: memory.lessons.length + memory.projectNotes.length + memory.localLessons.length + memory.localNotes.length,
      shared_context_included: false,
    },
  }
}

function metadata(name: string, inputSchema: JsonSchema, outputSchema: JsonSchema = JSON_OUTPUT_SCHEMA): ToolMetadata {
  const feature: McpFeatureMetadata | undefined = MCP_FEATURE_BY_NAME.get(name)
  if (feature === undefined) throw new Error(`Missing MCP feature metadata for ${name}.`)
  return { ...feature, inputSchema, outputSchema }
}

function defineTool(base: McpToolExecutionContext, toolMetadata: ToolMetadata, handler: ToolHandler): McpToolDefinition {
  return defineMcpTool({
    ...toolMetadata,
    execute: (input, call) => handler(input, { ...base, ...call }),
  })
}

export function createGovernanceTools(context: McpToolExecutionContext): McpToolDefinition[] {
  return [
    defineTool(context, metadata('elia_runs_list', RUN_LIST_SCHEMA), listRuns),
    defineTool(context, metadata('elia_run_receipt', RUN_RECEIPT_SCHEMA), readReceipt),
    defineTool(context, metadata('elia_run_diff', RUN_DIFF_SCHEMA), diffRuns),
    defineTool(context, metadata('elia_cost_report', COST_REPORT_SCHEMA), costReport),
    defineTool(context, metadata('elia_policy_read', POLICY_READ_SCHEMA), () => readPolicy(context)),
    defineTool(context, metadata('elia_policy_update', POLICY_UPDATE_SCHEMA), updatePolicyTool),
    defineTool(context, metadata('elia_quick_ask', QUICK_ASK_SCHEMA), quickAsk),
  ]
}
