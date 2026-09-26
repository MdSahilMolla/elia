import { existsSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { withFileLock } from '../../fileLock.ts'
import { buildQuickchatContext, estimateTokens } from '../../quickchat/context-builder.ts'
import { withRepoLock } from '../../repoLock.ts'
import { promoteLocalLessons } from '../../session/memorySlice.ts'
import { delegateTask } from '../../session/delegation.ts'
import { computeSessionSyncDiff, syncSessions, type SyncDecision } from '../../session/sync.ts'
import {
  makeSessionName,
  SESSION_STATUSES,
  type ContextDrop,
  type DelegationRecord,
  type MemorySlice,
  type SessionBus,
  type SessionDependency,
  type SessionHandle,
  type SessionId,
  type SessionStatus,
  type SyncChoice,
} from '../../session/types.ts'
import { redactRecord, redactSecrets, redactText } from '../../ui/redact.ts'
import {
  ELIA_MODES,
  ToolCategory,
  defineMcpTool,
  type EliaMode,
  type JsonSchema,
  type McpToolDefinition,
  type McpToolExecutionContext,
} from '../serverTypes.ts'

type ToolHandler = (input: Record<string, unknown>, context: McpToolExecutionContext) => unknown | Promise<unknown>
type ToolMetadata = Omit<McpToolDefinition, 'execute'>

const SESSION_SYNC_CHOICES: readonly SyncChoice[] = ['a', 'b', 'both', 'drop']
const ALL_MODES: readonly EliaMode[] = ELIA_MODES
const MAX_NAME_LENGTH = 64
const MAX_DROP_NAME_LENGTH = 64
const MAX_INJECTED_GOAL_LENGTH = 2_000
const MAX_PROMOTED_LESSONS = 50
const MAX_DECISIONS = 200
const MAX_QUEUE_ENTRIES = 50
const MAX_INBOX_ENTRIES = 10
const MAX_CATALOG_ENTRIES = 5
const MAX_PAYLOAD_PREVIEW = 400
const MAX_ERROR_LENGTH = 1_000
const TERMINAL_STATUSES: ReadonlySet<SessionStatus> = new Set<SessionStatus>(['done', 'errored'])
const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled', 'aborted'])
const PROCESS_LOCAL_SCOPE_NOTE =
  'These are the sessions this MCP server process initialized, held in its process-local session bus. ' +
  'A session created by another elia process or by the elia CLI is not visible here; only the durable ' +
  'conversation catalog (a separate kind of record) is read from disk.'
const SUBSCRIBER_SCOPE_NOTE =
  'Counts the context-drop subscriptions this MCP server process registered on its own process-local session bus.'
const CLEAN_FORK_NOTE =
  'The memory slice was copied for this session: private local lessons/notes are separate arrays and the shared ' +
  'project-level arrays are frozen read-only references.'
const CONTEXT_NOTE =
  'A bounded read-only snapshot of the session handle: it reads no files and includes only what the session bus ' +
  'already recorded. Plan steps, modified files and sub-agent outputs are empty unless the owning runner tracks them.'
const NO_CONTROLLER_NOTE =
  "This build has no per-session AbortController registry, so no controller could be signalled directly. Runs this " +
  'server recorded for the session are marked cancelled in its run registry, and a runner that owns its own ' +
  'AbortSignal stops when it observes that state.'

const DROP_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
const SESSION_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\-/ ]*$/
const PATH_ESCAPE = /(^|[\\/])\.\.([\\/]|$)/

interface SessionWorktreeHelpers {
  createSessionWorktree: (name: string, sourceRoot?: string, baseDir?: string) => Promise<string>
  removeSessionWorktree: (path: string | undefined, sourceRoot?: string) => Promise<void>
}

interface ProjectStatePaths {
  state: string
  lessons: string
  worktrees: string
}

interface CapacitySnapshot {
  activeSessions: number
  registeredSessions: number
  maxConcurrentSessions: number
  remainingSlots: number
}

interface MemoryCounts {
  lessons: number
  projectNotes: number
  localLessons: number
  localNotes: number
}

interface MemoryView {
  lessons: string[]
  projectNotes: string[]
  localLessons: string[]
  localNotes: string[]
}

interface QueueCounts {
  total: number
  queued: number
  active: number
  done: number
  cancelled: number
  failed: number
}

interface QueueEntry {
  id: string
  goal: string
  mode: string
  status: string
  createdAt: number
  error: string | null
}

interface FailedTask {
  id: string
  goal: string
  error: string
  createdAt: number
}

interface BlockedDependency {
  on: string
  checkpoint: string | null
  upstreamStatus: string
  resolvable: boolean
}

interface DropSubscriptionRecord {
  id: string
  name: string
  target: SessionId
  received: number
  createdAt: number
  release: () => void
}

interface ReceivedDrop {
  id: string
  name: string
  fromSession: string
  emittedAt: number
  payload: unknown
}

interface SubscriberCounts {
  forTarget: number
  forName: number
  total: number
  scope: string
}

interface PromotionOutcome {
  requested: number
  promoted: number
  writtenTo: string | null
  skipped: Array<{ lesson: string; reason: string }>
}

interface RunCancellation {
  activeRuns: number
  cancelledRuns: number
  note: string
}

const subscriptions = new Map<string, DropSubscriptionRecord>()
const dropInbox = new Map<SessionId, ReceivedDrop[]>()
let subscriptionSequence = 0

function defineTool(base: McpToolExecutionContext, metadata: ToolMetadata, handler: ToolHandler): McpToolDefinition {
  return defineMcpTool({
    ...metadata,
    execute: (input, call) => handler(input, { ...base, ...call }),
  })
}

function objectSchema(properties: Record<string, JsonSchema>, required: readonly string[] = []): JsonSchema {
  return { type: 'object', properties, required, additionalProperties: false }
}

function nullable(schema: JsonSchema): JsonSchema {
  return { anyOf: [schema, { type: 'null' }] }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function assertLive(context: McpToolExecutionContext, tool: string): void {
  if (context.signal?.aborted === true) {
    throw new Error(`${tool}: the request was cancelled before it completed.`)
  }
}

function projectStatePaths(context: McpToolExecutionContext): ProjectStatePaths {
  const state = join(resolve(context.cwd), '.elia')
  return {
    state,
    lessons: join(state, 'lessons.md'),
    worktrees: join(state, 'session-worktrees'),
  }
}

function resolveSessionWorktree(context: McpToolExecutionContext, candidate: string, tool: string): string {
  const root = projectStatePaths(context).worktrees
  const target = resolve(candidate)
  const rel = relative(root, target)
  if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`${tool}: the recorded worktree is outside this project's session-worktrees directory and was not removed.`)
  }
  return target
}

function requireString(input: Record<string, unknown>, key: string, tool: string): string {
  const value = input[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${tool}: "${key}" is required and must be a non-empty string.`)
  }
  return value
}

function optionalString(input: Record<string, unknown>, key: string, tool: string): string | undefined {
  const value = input[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${tool}: "${key}" must be a non-empty string when provided.`)
  }
  return value
}

function optionalBoolean(input: Record<string, unknown>, key: string, tool: string): boolean | undefined {
  const value = input[key]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') {
    throw new Error(`${tool}: "${key}" must be true or false when provided.`)
  }
  return value
}

function optionalInteger(input: Record<string, unknown>, key: string, tool: string, min: number, max: number): number | undefined {
  const value = input[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${tool}: "${key}" must be an integer from ${min} to ${max} when provided.`)
  }
  return value
}

function readStringArray(input: Record<string, unknown>, key: string, tool: string, max: number): string[] {
  const value = input[key]
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw new Error(`${tool}: "${key}" must be an array of strings when provided.`)
  }
  if (value.length > max) {
    throw new Error(`${tool}: "${key}" accepts at most ${max} entries (received ${value.length}).`)
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      throw new Error(`${tool}: "${key}[${index}]" must be a non-empty string.`)
    }
    return entry
  })
}

function readObjectArray(input: Record<string, unknown>, key: string, tool: string, max: number): Record<string, unknown>[] {
  const value = input[key]
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw new Error(`${tool}: "${key}" must be an array of objects when provided.`)
  }
  if (value.length > max) {
    throw new Error(`${tool}: "${key}" accepts at most ${max} entries (received ${value.length}).`)
  }
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`${tool}: "${key}[${index}]" must be an object.`)
    }
    return entry as Record<string, unknown>
  })
}

function requireStringField(entry: Record<string, unknown>, key: string, tool: string): string {
  const value = entry[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${tool}: "${key}" must be a non-empty string.`)
  }
  return value
}

function sessionName(raw: string, tool: string): string {
  const name = raw.trim()
  if (name.length > MAX_NAME_LENGTH) {
    throw new Error(`${tool}: a session name must be at most ${MAX_NAME_LENGTH} characters.`)
  }
  if (PATH_ESCAPE.test(name) || !SESSION_NAME_PATTERN.test(name)) {
    throw new Error(
      `${tool}: "${raw}" is not a usable session name. Use letters, digits and . _ - / or spaces, and no ".." path segments.`,
    )
  }
  return name
}

function dropName(raw: string, tool: string): string {
  const name = raw.trim()
  if (name.length > MAX_DROP_NAME_LENGTH) {
    throw new Error(`${tool}: a context-drop name must be at most ${MAX_DROP_NAME_LENGTH} characters.`)
  }
  if (!DROP_NAME_PATTERN.test(name)) {
    throw new Error(`${tool}: "${raw}" is not a usable context-drop name. Use letters, digits and . _ : - characters.`)
  }
  return name
}

function capacityLimit(context: McpToolExecutionContext, tool: string): number {
  const configured = context.config.maxConcurrentSessions
  if (typeof configured !== 'number' || !Number.isInteger(configured) || configured < 1) {
    throw new Error(
      `${tool}: config.maxConcurrentSessions is not a positive integer (received ${String(configured)}); refusing to change session state.`,
    )
  }
  return configured
}

function capacitySnapshot(context: McpToolExecutionContext): CapacitySnapshot {
  const maxConcurrentSessions = capacityLimit(context, 'elia_session_capacity')
  const sessions = context.sessionBus.list()
  const activeSessions = sessions.filter((handle) => !TERMINAL_STATUSES.has(handle.status)).length
  return {
    activeSessions,
    registeredSessions: sessions.length,
    maxConcurrentSessions,
    remainingSlots: Math.max(0, maxConcurrentSessions - activeSessions),
  }
}

function assertCapacityAvailable(context: McpToolExecutionContext, tool: string): CapacitySnapshot {
  const capacity = capacitySnapshot(context)
  if (capacity.remainingSlots < 1) {
    const names = context.sessionBus
      .list()
      .filter((handle) => !TERMINAL_STATUSES.has(handle.status))
      .map((handle) => `${handle.name} (${handle.id})`)
      .join(', ')
    throw new Error(
      `${tool}: this server already has ${capacity.activeSessions} active session(s), which is the configured maximum ` +
        `(maxConcurrentSessions=${capacity.maxConcurrentSessions}). Finish or kill one first: ${names || 'none listed'}.`,
    )
  }
  return capacity
}

function resolveHandle(context: McpToolExecutionContext, ref: string, tool: string): SessionHandle {
  const bus = context.sessionBus
  const handle = bus.resolve(ref)
  if (handle) return handle
  const sessions = bus.list()
  const sameName = sessions.filter((candidate) => candidate.name === ref)
  if (sameName.length > 1) {
    throw new Error(
      `${tool}: the session name "${ref}" is ambiguous (${sameName.length} sessions: ${sameName.map((entry) => entry.id).join(', ')}). Use the session id instead.`,
    )
  }
  const known = sessions.length === 0 ? 'none' : sessions.map((entry) => `${entry.name} (${entry.id})`).join(', ')
  throw new Error(
    `${tool}: unknown session "${ref}". ${PROCESS_LOCAL_SCOPE_NOTE} Sessions known here: ${known}.`,
  )
}

function resolveTarget(context: McpToolExecutionContext, ref: string | undefined, tool: string): SessionHandle {
  if (ref !== undefined) return resolveHandle(context, ref, tool)
  const active = context.sessionBus.activeSession
  if (active === undefined) {
    throw new Error(`${tool}: no session was named and this server has no active session.`)
  }
  const handle = context.sessionBus.get(active) ?? resolveHandle(context, active, tool)
  return handle
}

function memoryCounts(slice: MemorySlice): MemoryCounts {
  return {
    lessons: slice.lessons.length,
    projectNotes: slice.projectNotes.length,
    localLessons: slice.localLessons.length,
    localNotes: slice.localNotes.length,
  }
}

function queueCounts(handle: SessionHandle): QueueCounts {
  const counts: QueueCounts = { total: handle.taskQueue.length, queued: 0, active: 0, done: 0, cancelled: 0, failed: 0 }
  for (const record of handle.taskQueue) {
    if (record.status === 'queued') counts.queued += 1
    else if (record.status === 'active') counts.active += 1
    else if (record.status === 'done') counts.done += 1
    else if (record.status === 'cancelled') counts.cancelled += 1
    else if (record.status === 'failed') counts.failed += 1
  }
  return counts
}

function queueEntry(record: DelegationRecord): QueueEntry {
  return {
    id: record.id,
    goal: redactText(record.goal, 300),
    mode: record.mode,
    status: record.status,
    createdAt: record.createdAt,
    error: record.error === undefined ? null : redactSecrets(record.error).slice(0, MAX_ERROR_LENGTH),
  }
}

function failedTasks(handle: SessionHandle): FailedTask[] {
  return handle.taskQueue
    .filter((record) => record.status === 'failed')
    .map((record) => ({
      id: record.id,
      goal: redactText(record.goal, 300),
      error:
        record.error === undefined
          ? 'no error text was recorded for this task'
          : redactSecrets(record.error).slice(0, MAX_ERROR_LENGTH),
      createdAt: record.createdAt,
    }))
}

function blockedDependencies(context: McpToolExecutionContext, handle: SessionHandle): BlockedDependency[] {
  return handle.dependencies
    .filter((dependency) => !dependency.satisfied)
    .map((dependency) => {
      const upstream = context.sessionBus.get(dependency.on)
      return {
        on: dependency.on,
        checkpoint: dependency.checkpoint ?? null,
        upstreamStatus: upstream?.status ?? 'not-in-this-registry',
        resolvable: upstream !== undefined,
      }
    })
}

function statusBlockers(context: McpToolExecutionContext, handle: SessionHandle): string[] {
  const blockers: string[] = []
  for (const dependency of blockedDependencies(context, handle)) {
    const checkpoint = dependency.checkpoint === null ? '' : ` checkpoint "${dependency.checkpoint}"`
    blockers.push(
      dependency.resolvable
        ? `waiting on session ${dependency.on}${checkpoint} (currently ${dependency.upstreamStatus})`
        : `waiting on session ${dependency.on}${checkpoint}, which is not in this server's registry and can never be satisfied here`,
    )
  }
  if (handle.status === 'blocked' && blockers.length === 0) {
    blockers.push('the session is blocked and the bus recorded no reason for it')
  }
  if (handle.worktree !== undefined && !existsSync(handle.worktree)) {
    blockers.push(`the recorded worktree ${handle.worktree} is not on disk; isolation is not in effect`)
  }
  return blockers
}

function worktreeInfo(handle: SessionHandle): { path: string; exists: boolean } | null {
  if (handle.worktree === undefined) return null
  return { path: handle.worktree, exists: existsSync(handle.worktree) }
}

function isolatedCopy(value: unknown): unknown {
  if (value === undefined || value === null) return value
  try {
    return structuredClone(value)
  } catch {
    try {
      return JSON.parse(JSON.stringify(value)) as unknown
    } catch {
      return String(value)
    }
  }
}

function redactedMemory(slice: MemorySlice): MemoryView {
  return {
    lessons: slice.lessons.map((entry) => redactText(entry, 300)),
    projectNotes: slice.projectNotes.map((entry) => redactText(entry, 300)),
    localLessons: slice.localLessons.map((entry) => redactText(entry, 300)),
    localNotes: slice.localNotes.map((entry) => redactText(entry, 300)),
  }
}

function isolatedMemoryVerified(parent: MemorySlice | undefined, child: MemorySlice): boolean {
  if (parent === undefined) return true
  return (
    child !== parent &&
    child.localLessons !== parent.localLessons &&
    child.localNotes !== parent.localNotes &&
    Object.isFrozen(child.lessons) &&
    Object.isFrozen(child.projectNotes)
  )
}

function appendInbox(target: SessionId, drop: ContextDrop): void {
  const stored: ReceivedDrop = {
    id: drop.id,
    name: drop.name,
    fromSession: drop.fromSession,
    emittedAt: drop.emittedAt,
    payload: isolatedCopy(drop.payload),
  }
  const existing = dropInbox.get(target) ?? []
  existing.push(stored)
  if (existing.length > MAX_INBOX_ENTRIES) existing.splice(0, existing.length - MAX_INBOX_ENTRIES)
  dropInbox.set(target, existing)
}

function inboxFor(target: SessionId): { total: number; drops: ReceivedDrop[] } {
  const entries = dropInbox.get(target) ?? []
  return {
    total: entries.length,
    drops: entries.map((entry) => ({
      id: entry.id,
      name: entry.name,
      fromSession: entry.fromSession,
      emittedAt: entry.emittedAt,
      payload: isolatedCopy(entry.payload),
    })),
  }
}

function subscriptionsFor(target?: SessionId, name?: string): DropSubscriptionRecord[] {
  return [...subscriptions.values()].filter(
    (record) => (target === undefined || record.target === target) && (name === undefined || record.name === name),
  )
}

function subscriberCounts(target?: SessionId, name?: string): SubscriberCounts {
  return {
    forTarget: target === undefined ? 0 : subscriptionsFor(target).length,
    forName: name === undefined ? 0 : subscriptionsFor(undefined, name).length,
    total: subscriptionsFor().length,
    scope: SUBSCRIBER_SCOPE_NOTE,
  }
}

function createSubscription(context: McpToolExecutionContext, target: SessionId, name: string): {
  id: string
  name: string
  target: string
  targetName: string
  createdAt: number
  received: number
} {
  subscriptionSequence += 1
  const id = `drop-sub-${subscriptionSequence}`
  const createdAt = Date.now()
  const handle = context.sessionBus.get(target)
  const unsubscribe = context.sessionBus.subscribeDrop(target, name, (drop) => {
    const record = subscriptions.get(id)
    if (record) record.received += 1
    appendInbox(target, drop)
  })
  subscriptions.set(id, {
    id,
    name,
    target,
    received: 0,
    createdAt,
    release: () => {
      unsubscribe()
      subscriptions.delete(id)
    },
  })
  return { id, name, target, targetName: handle?.name ?? target, createdAt, received: 0 }
}

function releaseSubscription(id: string, tool: string): { id: string; name: string; target: string; remainingForTarget: number } {
  const record = subscriptions.get(id)
  if (!record) {
    const known = subscriptionsFor()
    throw new Error(
      `${tool}: unknown context-drop subscription "${id}". Subscriptions held by this server: ${
        known.length === 0 ? 'none' : known.map((entry) => `${entry.id} (${entry.name} -> ${entry.target})`).join(', ')
      }.`,
    )
  }
  const { name, target } = record
  record.release()
  return { id, name, target, remainingForTarget: subscriptionsFor(target).length }
}

function releaseSubscriptionsFor(target: SessionId): number {
  const held = subscriptionsFor(target)
  for (const record of held) record.release()
  return held.length
}

function sessionSubscriptionNames(target: SessionId): Array<{ id: string; name: string; received: number }> {
  return subscriptionsFor(target).map((record) => ({ id: record.id, name: record.name, received: record.received }))
}

function cancelSessionRuns(context: McpToolExecutionContext, sessionId: SessionId, tool: string): RunCancellation {
  let activeRuns = 0
  let cancelledRuns = 0
  const now = Date.now()
  for (const [runId, state] of context.runStates) {
    if (state.sessionId !== sessionId) continue
    if (TERMINAL_RUN_STATUSES.has(state.status)) continue
    activeRuns += 1
    context.runStates.set(runId, { ...state, status: 'cancelled', updatedAt: now, completedAt: now })
    cancelledRuns += 1
    context.emit({
      type: 'session:killed',
      runId,
      sessionId,
      tool,
      status: 'cancelled',
      at: now,
      message: `run ${runId} was marked cancelled because session ${sessionId} was killed`,
    })
  }
  return { activeRuns, cancelledRuns, note: NO_CONTROLLER_NOTE }
}

async function loadWorktreeHelpers(tool: string): Promise<SessionWorktreeHelpers> {
  try {
    const mod = (await import('../../cli/parallelSessions.ts')) as Partial<SessionWorktreeHelpers>
    if (typeof mod.createSessionWorktree !== 'function' || typeof mod.removeSessionWorktree !== 'function') {
      throw new Error('createSessionWorktree/removeSessionWorktree were not exported by src/cli/parallelSessions.ts.')
    }
    return { createSessionWorktree: mod.createSessionWorktree, removeSessionWorktree: mod.removeSessionWorktree }
  } catch (error) {
    throw new Error(`${tool}: the safe session-worktree helpers are unavailable in this build: ${message(error)}`)
  }
}

async function promoteSessionLessons(handle: SessionHandle, chosen: string[], lessonPath: string): Promise<PromotionOutcome> {
  if (chosen.length === 0) {
    return { requested: 0, promoted: 0, writtenTo: null, skipped: [] }
  }
  let appendLessons: ((texts: string[], path?: string, globalPath?: string) => void) | undefined
  let loadLessons: ((path?: string) => Array<{ text: string }>) | undefined
  try {
    const mod = (await import('../../autonomy/lessons.ts')) as {
      appendLessons?: (texts: string[], path?: string, globalPath?: string) => void
      loadLessons?: (path?: string) => Array<{ text: string }>
    }
    appendLessons = mod.appendLessons
    loadLessons = mod.loadLessons
  } catch (error) {
    return {
      requested: chosen.length,
      promoted: 0,
      writtenTo: null,
      skipped: chosen.map((lesson) => ({ lesson: redactText(lesson, 200), reason: `the lesson store is unavailable: ${message(error)}` })),
    }
  }
  if (typeof appendLessons !== 'function') {
    return {
      requested: chosen.length,
      promoted: 0,
      writtenTo: null,
      skipped: chosen.map((lesson) => ({ lesson: redactText(lesson, 200), reason: 'the lesson store did not export appendLessons in this build' })),
    }
  }

  const before = [...handle.memorySlice.localLessons]
  let promoted: string[]
  try {
    promoted = promoteLocalLessons(handle.memorySlice, chosen)
  } catch (error) {
    return {
      requested: chosen.length,
      promoted: 0,
      writtenTo: null,
      skipped: chosen.map((lesson) => ({ lesson: redactText(lesson, 200), reason: message(error) })),
    }
  }
  try {
    withFileLock(`${lessonPath}.lock`, () => {
      appendLessons?.(promoted, lessonPath, lessonPath)
      if (typeof loadLessons === 'function') {
        const stored = new Set(loadLessons(lessonPath).map((entry) => entry.text.replace(/\s+/g, ' ').trim().toLowerCase()))
        const missing = promoted.filter((lesson) => !stored.has(lesson.replace(/\s+/g, ' ').trim().toLowerCase()))
        if (missing.length > 0) {
          throw new Error(`the lesson store did not persist: ${missing.length} selected lesson(s) are absent`)
        }
      }
    })
  } catch (error) {
    handle.memorySlice.localLessons = before
    return {
      requested: chosen.length,
      promoted: 0,
      writtenTo: null,
      skipped: promoted.map((lesson) => ({ lesson: redactText(lesson, 200), reason: `the lesson store refused the write, so nothing was promoted: ${message(error)}` })),
    }
  }
  return { requested: chosen.length, promoted: promoted.length, writtenTo: lessonPath, skipped: [] }
}

function readDependencies(input: Record<string, unknown>, context: McpToolExecutionContext, tool: string): SessionDependency[] {
  return readObjectArray(input, 'dependsOn', tool, 20).map((entry, index) => {
    const ref = requireStringField(entry, 'session', tool)
    const upstream = resolveHandle(context, ref, tool)
    const checkpoint = entry['checkpoint']
    if (checkpoint !== undefined && (typeof checkpoint !== 'string' || checkpoint.trim().length === 0)) {
      throw new Error(`${tool}: "dependsOn[${index}].checkpoint" must be a non-empty string when provided.`)
    }
    return { on: upstream.id, ...(typeof checkpoint === 'string' ? { checkpoint } : {}), satisfied: false }
  })
}

function readDecisions(input: Record<string, unknown>, tool: string): SyncDecision[] {
  return readObjectArray(input, 'decisions', tool, MAX_DECISIONS).map((entry, index) => {
    const key = requireStringField(entry, 'key', tool)
    const choice = entry['choice']
    if (typeof choice !== 'string' || !SESSION_SYNC_CHOICES.includes(choice as SyncChoice)) {
      throw new Error(`${tool}: "decisions[${index}].choice" must be one of a, b, both, drop.`)
    }
    return { key, choice: choice as SyncChoice }
  })
}

function localMemory(slice: MemorySlice): { localLessons: string[]; localNotes: string[] } {
  return { localLessons: [...slice.localLessons], localNotes: [...slice.localNotes] }
}

function sameMemory(a: { localLessons: string[]; localNotes: string[] }, b: { localLessons: string[]; localNotes: string[] }): boolean {
  return (
    a.localLessons.length === b.localLessons.length &&
    a.localNotes.length === b.localNotes.length &&
    a.localLessons.every((entry, index) => entry === b.localLessons[index]) &&
    a.localNotes.every((entry, index) => entry === b.localNotes[index])
  )
}

function resolveInsideCwd(cwd: string, candidate: string, tool: string): string {
  const target = isAbsolute(candidate) ? resolve(candidate) : resolve(cwd, candidate)
  const rel = relative(resolve(cwd), target)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`${tool}: "${candidate}" is outside this server's working directory (${cwd}); it was not read.`)
  }
  return target
}

async function catalogSummary(cwd: string, requested: boolean): Promise<Record<string, unknown>> {
  if (!requested) {
    return { requested: false, available: false, note: 'the durable conversation catalog was not requested.' }
  }
  try {
    const mod = (await import('../../sessionCatalog.ts')) as { listSessionIds?: (dir?: string) => Array<{ id: string; mtime: number }> }
    if (typeof mod.listSessionIds !== 'function') {
      return { requested: true, available: false, note: 'the durable conversation catalog did not export listSessionIds in this build.' }
    }
    const ids = mod.listSessionIds(join(cwd, '.elia', 'sessions'))
    return {
      requested: true,
      available: true,
      savedConversations: ids.length,
      newest: ids.slice(0, MAX_CATALOG_ENTRIES).map((entry) => ({ id: entry.id, updatedAt: Math.round(entry.mtime) })),
      note: 'Saved conversation transcripts found on disk in this project directory, newest first. These are conversations, not parallel work sessions, and are read from the filesystem rather than from this process.',
    }
  } catch (error) {
    return { requested: true, available: false, note: `the durable conversation catalog could not be read: ${message(error)}` }
  }
}

async function loadContextDropModule(tool: string): Promise<{
  publishDrop: (input: { name: string; payload: unknown; fromSession: SessionId; bus: SessionBus }) => ContextDrop
  loadDropPayload: (path: string) => Promise<unknown>
}> {
  try {
    const mod = (await import('../../session/contextDrop.ts')) as {
      publishDrop?: (input: { name: string; payload: unknown; fromSession: SessionId; bus: SessionBus }) => ContextDrop
      loadDropPayload?: (path: string) => Promise<unknown>
    }
    if (typeof mod.publishDrop !== 'function' || typeof mod.loadDropPayload !== 'function') {
      throw new Error('publishDrop/loadDropPayload were not exported by src/session/contextDrop.ts.')
    }
    return { publishDrop: mod.publishDrop, loadDropPayload: mod.loadDropPayload }
  } catch (error) {
    throw new Error(`${tool}: context drops are not available in this build: ${message(error)}`)
  }
}

const SESSION_REF_PROPERTY: JsonSchema = {
  type: 'string',
  description: 'A live session id, or a session name that is unique in this server.',
}

const SESSION_IDENTITY_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    status: { type: 'string', enum: SESSION_STATUSES },
  },
  required: ['id', 'name', 'status'],
}

const MEMORY_COUNTS_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    lessons: { type: 'integer' },
    projectNotes: { type: 'integer' },
    localLessons: { type: 'integer' },
    localNotes: { type: 'integer' },
  },
  required: ['lessons', 'projectNotes', 'localLessons', 'localNotes'],
}

const CAPACITY_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    activeSessions: { type: 'integer' },
    registeredSessions: { type: 'integer' },
    maxConcurrentSessions: { type: 'integer' },
    remainingSlots: { type: 'integer' },
  },
  required: ['activeSessions', 'registeredSessions', 'maxConcurrentSessions', 'remainingSlots'],
}

const QUEUE_COUNTS_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    total: { type: 'integer' },
    queued: { type: 'integer' },
    active: { type: 'integer' },
    done: { type: 'integer' },
    cancelled: { type: 'integer' },
    failed: { type: 'integer' },
  },
  required: ['total', 'queued', 'active', 'done', 'cancelled', 'failed'],
}

const SUBSCRIBERS_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    forTarget: { type: 'integer' },
    forName: { type: 'integer' },
    total: { type: 'integer' },
    scope: { type: 'string' },
  },
  required: ['forTarget', 'forName', 'total', 'scope'],
}

function metadata(name: string, description: string, options: Partial<ToolMetadata>): ToolMetadata {
  return {
    name,
    description,
    category: ToolCategory.SESSION,
    inputSchema: objectSchema({}),
    outputSchema: { type: 'object' },
    requiresApproval: false,
    supportedModes: ALL_MODES,
    idempotent: false,
    costTier: 'free',
    inventoryId: name.replace(/^elia_/, '').replace(/_/g, '.'),
    ...options,
  }
}

function createTool(base: McpToolExecutionContext): McpToolDefinition {
  const tool = 'elia_session_create'
  return defineTool(base, metadata(tool, 'Create a new parallel work session on this server. The session gets its own isolated memory slice and, by default, a real isolated git worktree created through elia\'s safe worktree helper (no shell writes). The number of live sessions is capped by config.maxConcurrentSessions. Pass forkFrom to inherit a parent session\'s memory, and dependsOn to park the new session blocked until named upstream sessions finish. Sessions live in this process\'s session bus only; they are not visible to other elia processes.', {
    requiresApproval: true,
    inputSchema: objectSchema(
      {
        name: { type: 'string', description: 'A short human-readable session name, e.g. "feat/rate-limit". Names must be unique here so they stay addressable.' },
        forkFrom: { ...SESSION_REF_PROPERTY, description: 'Fork the memory slice of this session. Its private local lessons/notes are copied; shared project memory stays read-only.' },
        worktree: { type: 'boolean', description: 'Create an isolated git worktree for the session. Defaults to true. When defaulted and creation fails, the session is still created without isolation and the failure is reported as a blocker; when explicitly true and it fails, nothing is created.' },
        dependsOn: {
          type: 'array',
          description: 'Upstream sessions this one waits on. While a dependency is unsatisfied the session is created in status "blocked".',
          items: {
            type: 'object',
            properties: {
              session: SESSION_REF_PROPERTY,
              checkpoint: { type: 'string', description: 'A named upstream checkpoint that satisfies this dependency. Without it the upstream reaching "done" satisfies it.' },
            },
            required: ['session'],
            additionalProperties: false,
          },
        },
        lastTask: { type: 'string', description: 'An initial one-line task label for the status bar.' },
        sharedContext: { description: 'Cross-session context this session chooses to expose. It is copied, never shared by reference.' },
      },
      ['name'],
    ),
    outputSchema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        session: {
          type: 'object',
          properties: {
            ...SESSION_IDENTITY_SCHEMA.properties,
            created: { type: 'string', enum: ['root', 'forked'] },
            forkedFrom: nullable({ type: 'string' }),
            worktree: nullable({
              type: 'object',
              properties: { path: { type: 'string' }, exists: { type: 'boolean' } },
            }),
            memory: {
              type: 'object',
              properties: {
                ...MEMORY_COUNTS_SCHEMA.properties,
                isolated: { type: 'boolean' },
                sharedProjectMemory: { type: 'boolean' },
              },
            },
            dependencies: { type: 'array', items: { type: 'object' } },
            lastTask: nullable({ type: 'string' }),
            lastActivity: { type: 'integer' },
          },
        },
        capacity: CAPACITY_SCHEMA,
        blockers: { type: 'array', items: { type: 'string' } },
        notes: { type: 'array', items: { type: 'string' } },
      },
      required: ['ok', 'session', 'capacity', 'blockers', 'notes'],
    },
  }), async (input, context) => {
    assertLive(context, tool)
    const name = sessionName(requireString(input, 'name', tool), tool)
    const bus = context.sessionBus
    assertCapacityAvailable(context, tool)

    const existing = bus.byName(makeSessionName(name))
    if (existing) {
      throw new Error(
        `${tool}: a session named "${name}" already exists (${existing.id}). Names must stay unique in this registry or they stop resolving; kill it first or choose another name.`,
      )
    }

    const forkRef = optionalString(input, 'forkFrom', tool)
    const parent = forkRef === undefined ? undefined : resolveHandle(context, forkRef, tool)
    const dependencies = readDependencies(input, context, tool)
    const worktreeRequested = optionalBoolean(input, 'worktree', tool) ?? true
    const worktreeExplicit = input['worktree'] !== undefined
    const lastTask = optionalString(input, 'lastTask', tool)
    const sharedContext = input['sharedContext']
    if (sharedContext !== undefined && (typeof sharedContext !== 'object' || sharedContext === null || Array.isArray(sharedContext))) {
      throw new Error(`${tool}: "sharedContext" must be an object when provided.`)
    }
    if (dependencies.some((dependency) => parent !== undefined && dependency.on === parent.id)) {
      throw new Error(`${tool}: a session cannot depend on the session it forks from.`)
    }
    if (parent !== undefined && parent.id === bus.activeSession) bus.setActiveSession(parent.id)

    context.emit({ type: 'session:create', tool, status: 'progress', at: Date.now(), message: `creating session "${name}"` })

    const created = await context.governedMutation(
      tool,
      redactRecord({ name, forkFrom: parent?.id, worktree: worktreeRequested, dependsOn: dependencies, lastTask }),
      async () => {
        const handle = bus.create(makeSessionName(name), {
          ...(parent ? { from: parent.id } : {}),
          dependencies,
          ...(typeof sharedContext === 'object' && sharedContext !== null && !Array.isArray(sharedContext)
            ? { sharedContext: isolatedCopy(sharedContext) as Record<string, unknown> }
            : {}),
          ...(lastTask === undefined ? {} : { lastTask }),
        })

        const blockers: string[] = []
        let worktree: string | undefined
        if (worktreeRequested) {
          try {
            const helpers = await loadWorktreeHelpers(tool)
            worktree = await withRepoLock(() => helpers.createSessionWorktree(name, context.cwd, projectStatePaths(context).state))
          } catch (error) {
            if (worktreeExplicit) {
              bus.kill(handle.id)
              throw error
            }
            blockers.push(
              `no worktree was created (${message(error)}). The session is registered without filesystem isolation; ` +
                'do not claim this session is isolated on disk.',
            )
          }
        }
        if (worktree !== undefined) bus.update(handle.id, { worktree })
        if (!handle.dependencies.some((dependency) => !dependency.satisfied)) bus.setStatus(handle.id, 'running')
        return { id: handle.id, worktree, blockers }
      },
    )

    const handle = bus.get(created.id)
    if (!handle) {
      throw new Error(`${tool}: the session was not registered after the governed mutation, so nothing was created.`)
    }

    context.emit({
      type: 'session:created',
      sessionId: handle.id,
      tool,
      status: 'completed',
      at: Date.now(),
      message: `session "${handle.name}" created`,
    })

    const notes: string[] = [PROCESS_LOCAL_SCOPE_NOTE]
    if (parent) notes.push(CLEAN_FORK_NOTE)
    else notes.push('This is a root session: its project-level memory starts empty.')
    if (created.worktree === undefined && worktreeRequested) notes.push('No worktree path is attached to this session.')
    if (handle.dependencies.some((dependency) => !dependency.satisfied)) {
      notes.push('The session starts blocked and resumes when its dependencies are satisfied by the bus.')
    }

    return {
      ok: true,
      session: {
        id: handle.id,
        name: handle.name,
        status: handle.status,
        created: parent ? 'forked' : 'root',
        forkedFrom: parent ? parent.id : null,
        worktree: worktreeInfo(handle),
        memory: {
          ...memoryCounts(handle.memorySlice),
          isolated: isolatedMemoryVerified(parent?.memorySlice, handle.memorySlice),
          sharedProjectMemory: true,
        },
        dependencies: handle.dependencies.map((dependency) => ({
          on: dependency.on,
          checkpoint: dependency.checkpoint ?? null,
          satisfied: dependency.satisfied,
        })),
        lastTask: handle.lastTask ?? null,
        lastActivity: handle.lastActivity,
      },
       capacity: capacitySnapshot(context),

      blockers: created.blockers,
      notes,
    }
  })
}

function listTool(base: McpToolExecutionContext): McpToolDefinition {
  const tool = 'elia_session_list'
  return defineTool(base, metadata(tool, 'List the parallel work sessions this MCP server process initialized, with their real status, queue depth, blockers and worktree state. Also reports how many of them may still be created under config.maxConcurrentSessions. Sessions created by other processes are not visible: the session bus is process-local. With includeCatalog, the durable saved-conversation catalog for this project directory is reported separately as conversations.', {
    idempotent: true,
    inputSchema: objectSchema({
      status: { type: 'string', enum: SESSION_STATUSES, description: 'Only return sessions in this status.' },
      limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Maximum number of sessions to return, newest activity first. Defaults to 50.' },
      includeCatalog: { type: 'boolean', description: 'Also read the durable saved-conversation catalog from this project directory. Defaults to true. These are conversations, not work sessions.' },
    }),
    outputSchema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        scope: { type: 'object', properties: { sessions: { type: 'string' }, note: { type: 'string' } } },
        capacity: CAPACITY_SCHEMA,
        sessions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              ...SESSION_IDENTITY_SCHEMA.properties,
              lastTask: { type: 'string' },
              activeAgents: { type: 'integer' },
              worktree: nullable({ type: 'object', properties: { path: { type: 'string' }, exists: { type: 'boolean' } } }),
              queue: QUEUE_COUNTS_SCHEMA,
              memory: MEMORY_COUNTS_SCHEMA,
              lastActivity: { type: 'integer' },
              ageMs: { type: 'integer' },
              blockedOn: { type: 'array', items: { type: 'string' } },
            },
          },
        },
        returned: { type: 'integer' },
        catalog: { type: 'object' },
        notes: { type: 'array', items: { type: 'string' } },
      },
      required: ['ok', 'scope', 'capacity', 'sessions', 'returned', 'notes'],
    },
  }), async (input, context) => {
    assertLive(context, tool)
    const status = optionalString(input, 'status', tool)
    if (status !== undefined && !(SESSION_STATUSES as readonly string[]).includes(status)) {
      throw new Error(`${tool}: "status" must be one of ${SESSION_STATUSES.join(', ')}.`)
    }
    const limit = optionalInteger(input, 'limit', tool, 1, 200) ?? 50
    const includeCatalog = optionalBoolean(input, 'includeCatalog', tool) ?? true

    const now = Date.now()
    const sessions = context.sessionBus
      .list()
      .filter((handle) => status === undefined || handle.status === status)
      .sort((a, b) => b.lastActivity - a.lastActivity)
      .slice(0, limit)
      .map((handle) => ({
        id: handle.id,
        name: handle.name,
        status: handle.status,
        ...(handle.lastTask === undefined ? {} : { lastTask: redactText(handle.lastTask, 200) }),
        activeAgents: handle.activeAgents,
        worktree: worktreeInfo(handle),
        queue: queueCounts(handle),
        memory: memoryCounts(handle.memorySlice),
        lastActivity: handle.lastActivity,
        ageMs: Math.max(0, now - handle.lastActivity),
        blockedOn: blockedDependencies(context, handle).map((dependency) => dependency.on),
      }))

    return {
      ok: true,
      scope: { sessions: 'this-server-process', note: PROCESS_LOCAL_SCOPE_NOTE },
      capacity: capacitySnapshot(context),
      sessions,
      returned: sessions.length,
      catalog: await catalogSummary(context.cwd, includeCatalog),
      notes: [
        `Slots are counted against non-terminal sessions; maxConcurrentSessions=${context.config.maxConcurrentSessions}.`,
        'Sessions with status "done" or "errored" stay listed but no longer hold a slot.',
      ],
    }
  })
}

function statusTool(base: McpToolExecutionContext): McpToolDefinition {
  const tool = 'elia_session_status'
  return defineTool(base, metadata(tool, 'Report the real state of one live session: status, current task label, active sub-agent count, queue contents, unsatisfied dependencies as concrete blockers, the errors its failed tasks actually recorded, whether its worktree is still on disk, and the context-drop subscriptions it holds. Every string is secret-redacted. Use elia_session_context for the bounded read-only snapshot instead.', {
    idempotent: true,
    inputSchema: objectSchema(
      {
        session: SESSION_REF_PROPERTY,
        includeQueue: { type: 'boolean', description: 'Include the task queue entries, newest last. Defaults to true.' },
      },
      ['session'],
    ),
    outputSchema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        session: {
          type: 'object',
          properties: {
            ...SESSION_IDENTITY_SCHEMA.properties,
            lastTask: nullable({ type: 'string' }),
            activeAgents: { type: 'integer' },
            worktree: nullable({
              type: 'object',
              properties: { path: { type: 'string' }, exists: { type: 'boolean' } },
            }),
            queue: QUEUE_COUNTS_SCHEMA,
            memory: MEMORY_COUNTS_SCHEMA,
            blockedOn: { type: 'array', items: { type: 'object' } },
            checkpoints: { type: 'array', items: { type: 'object' } },
            lastActivity: { type: 'integer' },
            ageMs: { type: 'integer' },
          },
        },
        queue: { type: 'array', items: { type: 'object' } },
        blockers: { type: 'array', items: { type: 'string' } },
        errors: { type: 'array', items: { type: 'object' } },
        subscriptions: { type: 'array', items: { type: 'object' } },
        notes: { type: 'array', items: { type: 'string' } },
      },
      required: ['ok', 'session', 'blockers', 'errors'],
    },
  }), async (input, context) => {
    assertLive(context, tool)
    const handle = resolveHandle(context, requireString(input, 'session', tool), tool)
    const includeQueue = optionalBoolean(input, 'includeQueue', tool) ?? true
    const now = Date.now()

    return {
      ok: true,
      session: {
        id: handle.id,
        name: handle.name,
        status: handle.status,
        lastTask: handle.lastTask === undefined ? null : redactText(handle.lastTask, 300),
        activeAgents: handle.activeAgents,
        worktree: worktreeInfo(handle),
        queue: queueCounts(handle),
        memory: memoryCounts(handle.memorySlice),
        blockedOn: blockedDependencies(context, handle),
        checkpoints: [...handle.checkpoints.values()].map((checkpoint) => ({
          name: checkpoint.name,
          emittedAt: checkpoint.emittedAt ?? null,
        })),
        lastActivity: handle.lastActivity,
        ageMs: Math.max(0, now - handle.lastActivity),
      },
      ...(includeQueue
        ? { queue: handle.taskQueue.slice(-MAX_QUEUE_ENTRIES).map(queueEntry) }
        : {}),
      blockers: statusBlockers(context, handle),
      errors: failedTasks(handle),
      subscriptions: sessionSubscriptionNames(handle.id),
      notes: [
        PROCESS_LOCAL_SCOPE_NOTE,
        'Only errors a task actually recorded are listed; an empty list means the bus holds no failure text, not that the session never failed.',
      ],
    }
  })
}

function contextTool(base: McpToolExecutionContext): McpToolDefinition {
  const tool = 'elia_session_context'
  return defineTool(base, metadata(tool, 'Build a bounded, read-only snapshot of one live session: current task label, the errors its failed tasks recorded, and its memory slice (shared project memory plus this session\'s private scratch), plus the task queue and any context drops this server delivered to it. This is a context block, not a user message: nothing about the session is changed, and no file is read.', {
    idempotent: true,
    inputSchema: objectSchema(
      {
        session: SESSION_REF_PROPERTY,
        includeQueue: { type: 'boolean', description: 'Include the task queue goals, newest last. Defaults to true.' },
        includeDrops: { type: 'boolean', description: 'Include context drops delivered to this session. Defaults to true.' },
        memoryLimit: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximum memory entries per array in the snapshot. Defaults to 20.' },
      },
      ['session'],
    ),
    outputSchema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        session: SESSION_IDENTITY_SCHEMA,
        context: {
          type: 'object',
          properties: {
            currentTask: nullable({ type: 'string' }),
            memorySlice: { type: 'object', properties: { lessons: { type: 'array', items: { type: 'string' } }, projectNotes: { type: 'array', items: { type: 'string' } }, localLessons: { type: 'array', items: { type: 'string' } }, localNotes: { type: 'array', items: { type: 'string' } } } },
            currentErrors: { type: 'array', items: { type: 'string' } },
            estimatedTokens: { type: 'integer' },
            memoryCounts: MEMORY_COUNTS_SCHEMA,
          },
          required: ['currentTask', 'memorySlice', 'currentErrors', 'estimatedTokens'],
        },
        queue: { type: 'array', items: { type: 'object' } },
        contextDrops: { type: 'object', properties: { total: { type: 'integer' }, drops: { type: 'array', items: { type: 'object' } } } },
        notes: { type: 'array', items: { type: 'string' } },
      },
      required: ['ok', 'session', 'context', 'notes'],
    },
  }), async (input, context) => {
    assertLive(context, tool)
    const handle = resolveHandle(context, requireString(input, 'session', tool), tool)
    const includeQueue = optionalBoolean(input, 'includeQueue', tool) ?? true
    const includeDrops = optionalBoolean(input, 'includeDrops', tool) ?? true
    const memoryLimit = optionalInteger(input, 'memoryLimit', tool, 1, 50) ?? 20

    const snapshot = buildQuickchatContext(handle, {
      currentErrors: failedTasks(handle).map((failure) => failure.error),
    })
    const memory = redactedMemory(snapshot.memorySlice)
    const bounded = {
      lessons: memory.lessons.slice(0, memoryLimit),
      projectNotes: memory.projectNotes.slice(0, memoryLimit),
      localLessons: memory.localLessons.slice(0, memoryLimit),
      localNotes: memory.localNotes.slice(0, memoryLimit),
    }
    const inbox = includeDrops ? inboxFor(handle.id) : { total: 0, drops: [] }
    const counts = memoryCounts(snapshot.memorySlice)

    return {
      ok: true,
      session: { id: handle.id, name: handle.name, status: handle.status },
      context: {
        currentTask: snapshot.currentTask === undefined ? null : redactText(snapshot.currentTask, 300),
        memorySlice: bounded,
        currentErrors: snapshot.currentErrors,
        estimatedTokens: estimateTokens(JSON.stringify(bounded)),
        memoryCounts: counts,
      },
      ...(includeQueue ? { queue: handle.taskQueue.slice(-MAX_QUEUE_ENTRIES).map(queueEntry) } : {}),
      contextDrops: inbox,
      notes: [
        CONTEXT_NOTE,
        `Memory arrays are capped at ${memoryLimit} entries; counts are the uncapped totals.`,
        'The snapshot is a copy: nothing here shares an array with the live session.',
        'Shared project memory is read-only by contract; only localLessons and localNotes are this session\'s private scratch.',
      ],
    }
  })
}

function injectTool(base: McpToolExecutionContext): McpToolDefinition {
  const tool = 'elia_session_inject'
  return defineTool(base, metadata(tool, 'Queue one atomic task into a live session. The task is appended to the session\'s task queue and runs at the next safe step boundary the session\'s runner reaches; it never interrupts or reorders the step already running. The reply carries the record id and the deterministic queued position (its place in the append-only queue, how many queued tasks are ahead of it, and whether it is already the active task).', {
    requiresApproval: true,
    inputSchema: objectSchema(
      {
        session: { ...SESSION_REF_PROPERTY, description: 'Target session. Defaults to this server\'s active session.' },
        goal: { type: 'string', description: 'The task to queue, as one instruction for the session to execute.' },
        mode: { type: 'string', enum: ['now', 'after-step'], description: '"now" runs at the next atomic step boundary; "after-step" waits for the current plan step. Defaults to "now".' },
        planStepCount: { type: 'integer', minimum: 0, maximum: 10_000, description: 'For after-step: how many further plan steps to wait through. 0 means after the current step.' },
      },
      ['goal'],
    ),
    outputSchema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        session: SESSION_IDENTITY_SCHEMA,
        record: { type: 'object', properties: { id: { type: 'string' }, mode: { type: 'string' }, status: { type: 'string' }, createdAt: { type: 'integer' }, goal: { type: 'string' } } },
        queued: {
          type: 'object',
          properties: {
            position: { type: 'integer' },
            pendingAhead: { type: 'integer' },
            runsAfter: { type: 'string' },
            activeTask: nullable({ type: 'string' }),
            queueLength: { type: 'integer' },
          },
          required: ['position', 'pendingAhead', 'runsAfter', 'activeTask', 'queueLength'],
        },
        confirmation: { type: 'string' },
        notes: { type: 'array', items: { type: 'string' } },
      },
      required: ['ok', 'session', 'record', 'queued', 'confirmation'],
    },
  }), async (input, context) => {
    assertLive(context, tool)
    const ref = optionalString(input, 'session', tool)
    const target = resolveTarget(context, ref, tool)
    const goal = requireString(input, 'goal', tool)
    if (goal.length > MAX_INJECTED_GOAL_LENGTH) {
      throw new Error(`${tool}: "goal" must be at most ${MAX_INJECTED_GOAL_LENGTH} characters.`)
    }
    const mode = optionalString(input, 'mode', tool) ?? 'now'
    if (mode !== 'now' && mode !== 'after-step') {
      throw new Error(`${tool}: "mode" must be "now" or "after-step".`)
    }
    const planStepCount = optionalInteger(input, 'planStepCount', tool, 0, 10_000)
    const bus = context.sessionBus

    const queued = await context.governedMutation(
      tool,
      redactRecord({ session: target.id, goal, mode, planStepCount }),
      async () => {
        const result = await delegateTask({
          bus,
          target: target.id,
          source: 'cli',
          goal,
          mode,
          ...(planStepCount === undefined ? {} : { planStepCount }),
        })
        const handle = bus.get(target.id) ?? target
        const index = handle.taskQueue.findIndex((record) => record.id === result.record.id)
        const record = index === -1 ? undefined : handle.taskQueue[index]
        const pendingAhead = index === -1 ? 0 : handle.taskQueue.slice(0, index).filter((entry) => entry.status === 'queued').length
        const active = handle.taskQueue.find((entry) => entry.status === 'active')
        return {
          record: result.record,
          confirmation: result.confirmation,
          position: {
            position: index === -1 ? handle.taskQueue.length : index + 1,
            pendingAhead,
            runsAfter:
              record === undefined
                ? 'unknown'
                : record.mode === 'now' || record.queuedAfterStep === -1
                  ? 'next-atomic-step-boundary'
                  : `plan-step-${record.queuedAfterStep ?? 0}`,
            activeTask: active === undefined ? null : redactText(active.goal, 200),
            queueLength: handle.taskQueue.length,
          },
        }
      },
    )

    const handle = bus.get(target.id)
    if (!handle || !handle.taskQueue.some((entry) => entry.id === queued.record.id)) {
      throw new Error(`${tool}: the task was not appended to session ${target.id}, so nothing was queued.`)
    }

    context.emit({
      type: 'session:task-queued',
      sessionId: target.id,
      tool,
      status: 'completed',
      at: Date.now(),
      message: `queued task ${queued.record.id} at position ${queued.position.position}`,
    })

    return {
      ok: true,
      session: { id: handle.id, name: handle.name, status: handle.status },
      record: {
        id: queued.record.id,
        mode: queued.record.mode,
        status: queued.record.status,
        createdAt: queued.record.createdAt,
        goal: redactText(queued.record.goal, 300),
      },
      queued: queued.position,
      confirmation: queued.confirmation,
      notes: [
        'The queue is append-only: the position is where the record sits now and is not renegotiated by later injections.',
        'Nothing runs until this session\'s own runner reaches a safe step boundary; a session with no runner keeps the task queued.',
      ],
    }
  })
}

function syncTool(base: McpToolExecutionContext): McpToolDefinition {
  const tool = 'elia_session_sync'
  return defineTool(base, metadata(tool, 'Sync the private memory of two live sessions using elia\'s existing conflict detection. Entries present on only one side merge silently; an entry that differs cosmetically (case or spacing) between the two sides is a conflict that must be decided. Without a decision for every conflict, nothing is written — the report comes back with the conflicts and the sessions are left untouched. Project-level shared memory is never modified. Use dryRun to see the diff with no write at all.', {
    requiresApproval: true,
    costTier: 'cheap',
    inputSchema: objectSchema(
      {
        a: SESSION_REF_PROPERTY,
        b: SESSION_REF_PROPERTY,
        decisions: {
          type: 'array',
          description: 'One decision per conflict key: keep "a" (first session), "b" (second session), "both", or "drop". Every conflict must be decided or nothing is merged.',
          items: {
            type: 'object',
            properties: { key: { type: 'string' }, choice: { type: 'string', enum: SESSION_SYNC_CHOICES } },
            required: ['key', 'choice'],
            additionalProperties: false,
          },
        },
        dryRun: { type: 'boolean', description: 'Compute and return the diff without writing anything to either session. Defaults to false.' },
      },
      ['a', 'b'],
    ),
    outputSchema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        a: SESSION_IDENTITY_SCHEMA,
        b: SESSION_IDENTITY_SCHEMA,
        dryRun: { type: 'boolean' },
        merged: { type: 'boolean' },
        changedSessions: { type: 'array', items: { type: 'string' } },
        report: {
          type: 'object',
          properties: {
            aOnly: { type: 'array', items: { type: 'string' } },
            bOnly: { type: 'array', items: { type: 'string' } },
            conflicts: { type: 'array', items: { type: 'object' } },
            resolved: { type: 'array', items: { type: 'object' } },
          },
        },
        unresolvedConflicts: { type: 'array', items: { type: 'object' } },
        notes: { type: 'array', items: { type: 'string' } },
      },
      required: ['ok', 'a', 'b', 'dryRun', 'merged', 'changedSessions', 'report', 'unresolvedConflicts'],
    },
  }), async (input, context) => {
    assertLive(context, tool)
    const bus = context.sessionBus
    const handleA = resolveHandle(context, requireString(input, 'a', tool), tool)
    const handleB = resolveHandle(context, requireString(input, 'b', tool), tool)
    if (handleA.id === handleB.id) {
      throw new Error(`${tool}: "a" and "b" resolve to the same session (${handleA.id}); syncing a session with itself changes nothing.`)
    }
    const dryRun = optionalBoolean(input, 'dryRun', tool) ?? false
    const decisions = readDecisions(input, tool)
    const beforeA = localMemory(handleA.memorySlice)
    const beforeB = localMemory(handleB.memorySlice)
    const diff = computeSessionSyncDiff(handleA.memorySlice, handleB.memorySlice)

    const pair = {
      a: { id: handleA.id, name: handleA.name, status: handleA.status },
      b: { id: handleB.id, name: handleB.name, status: handleB.status },
    }
    const redacted = (items: string[]): string[] => items.map((item) => redactText(item, 300))
    const diffView = {
      aOnly: redacted(diff.aOnly),
      bOnly: redacted(diff.bOnly),
      conflicts: diff.conflicts.map((conflict) => ({
        key: conflict.key,
        a: conflict.a === undefined ? null : redactText(conflict.a, 300),
        b: conflict.b === undefined ? null : redactText(conflict.b, 300),
      })),
      resolved: [] as Array<{ key: string; choice: string }>,
    }

    if (dryRun) {
      return {
        ok: true,
        ...pair,
        dryRun: true,
        merged: false,
        changedSessions: [],
        report: diffView,
        unresolvedConflicts: diffView.conflicts,
        notes: [
          'Dry run: the diff was computed and nothing was written to either session.',
          diff.conflicts.length === 0
            ? 'No conflicts: a real sync would merge the one-sided entries without asking.'
            : `${diff.conflicts.length} conflict(s) need a decision for each key before anything can be merged.`,
        ],
      }
    }

    const report = await context.governedMutation(
      tool,
      redactRecord({ a: handleA.id, b: handleB.id, decisions, dryRun }),
      () => syncSessions(handleA.id, handleB.id, bus, decisions.length > 0 ? async () => decisions : undefined),
    )

    const afterA = bus.get(handleA.id)
    const afterB = bus.get(handleB.id)
    if (!afterA || !afterB) {
      throw new Error(`${tool}: one of the sessions disappeared during the merge, so the result cannot be reported.`)
    }
    const changed = [
      ...(sameMemory(beforeA, localMemory(afterA.memorySlice)) ? [] : [afterA.id]),
      ...(sameMemory(beforeB, localMemory(afterB.memorySlice)) ? [] : [afterB.id]),
    ]
    const resolvedKeys = new Set(report.resolved.map((entry) => entry.key))
    const unresolved = diff.conflicts.filter((conflict) => !resolvedKeys.has(conflict.key))
    const merged = unresolved.length === 0

    return {
      ok: true,
      ...pair,
      dryRun: false,
      merged,
      changedSessions: changed,
      report: {
        aOnly: redacted(report.diff.aOnly),
        bOnly: redacted(report.diff.bOnly),
        conflicts: diffView.conflicts,
        resolved: report.resolved.map((entry) => ({ key: entry.key, choice: entry.choice })),
      },
      unresolvedConflicts: unresolved.map((conflict) => ({
        key: conflict.key,
        a: conflict.a === undefined ? null : redactText(conflict.a, 300),
        b: conflict.b === undefined ? null : redactText(conflict.b, 300),
      })),
      notes: [
        merged
          ? changed.length === 0
            ? 'Both sessions already agreed; nothing needed writing.'
            : `Merged into: ${changed.join(', ')}.`
          : `${unresolved.length} conflict(s) were left unresolved, so elia refused to write either side. Decide every conflict key and sync again.`,
        'Only the private local memory of each session is synced; shared project-level memory is never touched.',
      ],
    }
  })
}

function killTool(base: McpToolExecutionContext): McpToolDefinition {
  const tool = 'elia_session_kill'
  return defineTool(base, metadata(tool, 'Kill a live session: it is removed from this server\'s session bus, its context-drop subscriptions are released, runs this server recorded for it are marked cancelled, and its isolated worktree directory is deleted through elia\'s safe worktree helper unless removeWorktree is false. Optionally promote chosen local lessons into the durable project lesson store first, using the session\'s own memory-slice promotion, and report exactly how many were promoted or skipped. The worktree removal is destructive and, like every mutation here, goes through governed approval.', {
    requiresApproval: true,
    idempotent: true,
    inputSchema: objectSchema(
      {
        session: SESSION_REF_PROPERTY,
        removeWorktree: { type: 'boolean', description: 'Delete the session\'s worktree directory. Defaults to true. Uncommitted work inside it goes with it.' },
        promoteLessons: {
          type: 'array',
          description: 'Local lessons to move into the durable project lesson store before the session goes away. Every entry must already be in the session\'s localLessons or nothing is promoted.',
          items: { type: 'string' },
        },
      },
      ['session'],
    ),
    outputSchema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        removed: { type: 'object', properties: { sessions: { type: 'integer' }, session: SESSION_IDENTITY_SCHEMA } },
        worktree: {
          type: 'object',
          properties: {
            path: nullable({ type: 'string' }),
            requested: { type: 'boolean' },
            removed: { type: 'boolean' },
            note: { type: 'string' },
          },
          required: ['path', 'requested', 'removed', 'note'],
        },
        promotedLessons: { type: 'object' },
        controllers: { type: 'object', properties: { activeRuns: { type: 'integer' }, cancelledRuns: { type: 'integer' }, note: { type: 'string' } } },
        subscriptions: { type: 'object', properties: { released: { type: 'integer' }, remaining: { type: 'integer' } } },
        capacity: CAPACITY_SCHEMA,
        notes: { type: 'array', items: { type: 'string' } },
      },
      required: ['ok', 'removed', 'worktree', 'promotedLessons', 'controllers', 'subscriptions'],
    },
  }), async (input, context) => {
    assertLive(context, tool)
    const handle = resolveHandle(context, requireString(input, 'session', tool), tool)
    const removeWorktree = optionalBoolean(input, 'removeWorktree', tool) ?? true
    const chosen = readStringArray(input, 'promoteLessons', tool, MAX_PROMOTED_LESSONS)
    const worktreePath = handle.worktree === undefined ? undefined : resolveSessionWorktree(context, handle.worktree, tool)
    const helpers = worktreePath !== undefined && removeWorktree ? await loadWorktreeHelpers(tool) : undefined
    const bus = context.sessionBus
    const removedAt = Date.now()

    context.emit({ type: 'session:kill', sessionId: handle.id, tool, status: 'progress', at: removedAt, message: `killing session "${handle.name}"` })

    const outcome = await context.governedMutation(
      tool,
      redactRecord({ session: handle.id, removeWorktree, promoteLessons: chosen }),
      async () => {
        const promotion = await promoteSessionLessons(handle, chosen, projectStatePaths(context).lessons)
        const runs = cancelSessionRuns(context, handle.id, tool)
        const released = releaseSubscriptionsFor(handle.id)
        bus.kill(handle.id)
        let worktree: { path: string | null; requested: boolean; removed: boolean; note: string } =
          worktreePath === undefined
            ? { path: null, requested: false, removed: false, note: 'the session had no worktree' }
            : {
                path: worktreePath,
                requested: removeWorktree,
                removed: false,
                note: removeWorktree ? 'pending' : 'left on disk because removeWorktree was false',
              }
        if (worktreePath !== undefined && removeWorktree && helpers) {
          await helpers.removeSessionWorktree(worktreePath, context.cwd)
          const stillThere = existsSync(worktreePath)
          worktree = {
            path: worktreePath,
            requested: true,
            removed: !stillThere,
            note: stillThere
              ? 'the directory still exists after the removal attempt; remove it by hand'
              : 'deleted, and the repository worktree list was pruned',
          }
        }
        return { promotion, runs, released, worktree }
      },
    )

    if (bus.get(handle.id)) {
      throw new Error(`${tool}: session ${handle.id} is still registered after the governed kill, so nothing was removed.`)
    }

    context.emit({ type: 'session:killed', sessionId: handle.id, tool, status: 'completed', at: Date.now(), message: `session "${handle.name}" killed` })

    return {
      ok: true,
      removed: { sessions: 1, session: { id: handle.id, name: handle.name, status: handle.status } },
      worktree: outcome.worktree,
      promotedLessons: outcome.promotion,
      controllers: outcome.runs,
      subscriptions: { released: outcome.released, remaining: subscriptionsFor().length },
      capacity: capacitySnapshot(context),
      notes: [
        'Exactly one session was removed from this server\'s registry; other processes are unaffected.',
        outcome.promotion.requested > 0 && outcome.promotion.promoted === 0
          ? 'No lesson was promoted, and the session\'s local memory was left unchanged.'
          : `Promoted ${outcome.promotion.promoted} of ${outcome.promotion.requested} requested lesson(s)${outcome.promotion.writtenTo ? ` into ${outcome.promotion.writtenTo}` : ''}.`,
      ],
    }
  })
}

function dropTool(base: McpToolExecutionContext): McpToolDefinition {
  const tool = 'elia_context_drop'
  return defineTool(base, metadata(tool, 'Publish a named context drop from a live session. Subscribers on this server receive it as a context block that informs their work without interrupting it, and the bus emits its cross-session sync event. The reply reports the drop id and the real subscriber count — how many subscriptions this server holds for that drop name, and how many of them were actually called by this publish.', {
    requiresApproval: true,
    idempotent: true,
    inputSchema: objectSchema(
      {
        name: { type: 'string', description: 'The drop name subscribers listen for.' },
        fromSession: { ...SESSION_REF_PROPERTY, description: 'The session publishing the drop. Defaults to this server\'s active session.' },
        payload: { description: 'The payload to publish, inline. Any JSON value.' },
        payloadPath: { type: 'string', description: 'Read the payload from a file inside this server\'s working directory instead. .json files are parsed, anything else is published as raw text. Ignored when "payload" is also given.' },
      },
      ['name'],
    ),
    outputSchema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        drop: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            fromSession: { type: 'string' },
            fromSessionName: { type: 'string' },
            emittedAt: { type: 'integer' },
            payloadKind: { type: 'string' },
            payloadPreview: nullable({ type: 'string' }),
          },
          required: ['id', 'name', 'fromSession', 'emittedAt'],
        },
        subscribers: { type: 'object', properties: { registered: { type: 'integer' }, delivered: { type: 'integer' }, scope: { type: 'string' } } },
        notes: { type: 'array', items: { type: 'string' } },
      },
      required: ['ok', 'drop', 'subscribers'],
    },
  }), async (input, context) => {
    assertLive(context, tool)
    const name = dropName(requireString(input, 'name', tool), tool)
    const fromRef = optionalString(input, 'fromSession', tool)
    const source = resolveTarget(context, fromRef, tool)
    const payloadPath = optionalString(input, 'payloadPath', tool)
    if (payloadPath !== undefined && input['payload'] !== undefined) {
      throw new Error(`${tool}: give either "payload" or "payloadPath", not both.`)
    }
    const { publishDrop, loadDropPayload } = await loadContextDropModule(tool)
    const before = subscriptionsFor(undefined, name).reduce((total, record) => total + record.received, 0)

    const drop = await context.governedMutation(
      tool,
      redactRecord({ name, fromSession: source.id, payloadPath }),
      async () => {
        const payload =
          payloadPath === undefined
            ? isolatedCopy(input['payload'])
            : await loadDropPayload(resolveInsideCwd(context.cwd, payloadPath, tool))
        return publishDrop({ name, payload, fromSession: source.id, bus: context.sessionBus })
      },
    )

    const after = subscriptionsFor(undefined, name).reduce((total, record) => total + record.received, 0)
    const payloadText =
      typeof drop.payload === 'string'
        ? drop.payload
        : (() => {
            try {
              const encoded = JSON.stringify(drop.payload)
              return encoded === undefined ? String(drop.payload) : encoded
            } catch {
              return String(drop.payload)
            }
          })()

    context.emit({
      type: 'context_drop',
      sessionId: drop.fromSession,
      tool,
      status: 'completed',
      at: Date.now(),
      message: `context drop "${drop.name}" published`,
    })

    return {
      ok: true,
      drop: {
        id: drop.id,
        name: drop.name,
        fromSession: drop.fromSession,
        fromSessionName: source.name,
        emittedAt: drop.emittedAt,
        payloadKind: drop.payload === undefined ? 'absent' : Array.isArray(drop.payload) ? 'array' : typeof drop.payload,
        payloadPreview: drop.payload === undefined ? null : redactText(payloadText, MAX_PAYLOAD_PREVIEW),
      },
      subscribers: {
        registered: subscriptionsFor(undefined, name).length,
        delivered: after - before,
        scope: SUBSCRIBER_SCOPE_NOTE,
      },
      notes: [
        'A drop is delivered as a context block to subscribers; it never becomes a new user message in a session.',
        'Only subscriptions held by this server process can receive it.',
      ],
    }
  })
}

function subscribeTool(base: McpToolExecutionContext): McpToolDefinition {
  const tool = 'elia_context_subscribe'
  return defineTool(base, metadata(tool, 'Subscribe a live session to a named context drop, or release a subscription this server holds. Each matching drop is delivered into the target session as a context block and kept in a bounded inbox that elia_session_context can read. The reply reports the real subscriber count for the target session and for the drop name, counted from the subscriptions this process actually registered.', {
        requiresApproval: false,
        idempotent: true,
        inputSchema: objectSchema(
      {
        name: { type: 'string', description: 'The drop name to listen for.' },
        session: { ...SESSION_REF_PROPERTY, description: 'The subscribing session. Defaults to this server\'s active session.' },
        unsubscribe: { type: 'boolean', description: 'Release an existing subscription instead of creating one. Requires subscriptionId. Defaults to false.' },
        subscriptionId: { type: 'string', description: 'The subscription to release when unsubscribe is true.' },
      },
      ['name'],
    ),
    outputSchema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        subscription: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            target: { type: 'string' },
            targetName: { type: 'string' },
            createdAt: { type: 'integer' },
            received: { type: 'integer' },
          },
        },
        released: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, target: { type: 'string' }, remainingForTarget: { type: 'integer' } } },
        subscribers: SUBSCRIBERS_SCHEMA,
        notes: { type: 'array', items: { type: 'string' } },
      },
      required: ['ok', 'subscribers'],
    },
  }), async (input, context) => {
    assertLive(context, tool)
    const name = dropName(requireString(input, 'name', tool), tool)
    const unsubscribe = optionalBoolean(input, 'unsubscribe', tool) ?? false

    if (unsubscribe) {
      const id = requireString(input, 'subscriptionId', tool)
      const released = await context.governedMutation(
        tool,
        redactRecord({ name, subscriptionId: id, unsubscribe }),
        () => releaseSubscription(id, tool),
      )
      const target = context.sessionBus.get(released.target as SessionId)
      return {
        ok: true,
        released: { id: released.id, name: released.name, target: released.target, remainingForTarget: released.remainingForTarget },
        subscribers: subscriberCounts(target?.id),
        notes: ['The subscription was released; this server will no longer receive that drop for the session.'],
      }
    }

    const ref = optionalString(input, 'session', tool)
    const target = resolveTarget(context, ref, tool)
    if (input['subscriptionId'] !== undefined) {
      throw new Error(`${tool}: "subscriptionId" is only used with unsubscribe: true.`)
    }

    const created = await context.governedMutation(
      tool,
      redactRecord({ name, session: target.id }),
      () => createSubscription(context, target.id, name),
    )

    context.emit({
      type: 'context_subscribed',
      sessionId: target.id,
      tool,
      status: 'completed',
      at: Date.now(),
      message: `subscribed to context drop "${name}"`,
    })

    return {
      ok: true,
      subscription: created,
      subscribers: subscriberCounts(target.id, name),
      notes: [
        'The subscription lives as long as this server process or until it is released, or until the session is killed.',
        'Delivered drops are copied into a bounded inbox (newest 10) that elia_session_context exposes; the publisher\'s objects are never shared by reference.',
      ],
    }
  })
}

export function createSessionTools(context: McpToolExecutionContext): McpToolDefinition[] {
  return [
    createTool(context),
    listTool(context),
    statusTool(context),
    contextTool(context),
    injectTool(context),
    syncTool(context),
    killTool(context),
    dropTool(context),
    subscribeTool(context),
  ]
}
