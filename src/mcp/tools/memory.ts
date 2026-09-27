import { resolve } from 'node:path'
import { lessonKey, appendLessons, loadLessons } from '../../autonomy/lessons.ts'
import { lessonTrials, loadEfficacy, MIN_HELD_OUT } from '../../autonomy/lessonEfficacy.ts'
import { resolveWorkspacePath } from '../../autonomy/context.ts'
import { withFileLock } from '../../fileLock.ts'
import { appendNote, loadNotes } from '../../brain/notes.ts'
import { searchBrain } from '../../brain/search.ts'
import type { BrainItem } from '../../brain/store.ts'
import { loadLedger, listLedgerSessionIds } from '../../ledger.ts'
import { promoteLocalLessons } from '../../session/memorySlice.ts'
import { redactText, relativizeProjectPaths } from '../../ui/redact.ts'
import {
  ELIA_MODES,
  ToolCategory,
  type JsonSchema,
  type McpToolDefinition,
  type McpToolExecutionContext,
} from '../serverTypes.ts'

type ReadKind = 'all' | 'lessons' | 'notes' | 'sessions'
type WriteKind = 'lesson' | 'note'
type MemoryScope = 'session' | 'project'

type MemoryReadItem =
  | {
      kind: 'lesson'
      scope: 'project'
      id: string
      at: number
      text: string
      source?: string
      confidence?: number
    }
  | {
      kind: 'note'
      scope: 'project'
      id: string
      at: number
      text: string
      paths: string[]
      tags: string[]
    }
  | {
      kind: 'session_summary'
      scope: 'project'
      id: string
      sessionId: string
      turn: number
      at: number
      text: string
    }

interface ProjectStorePaths {
  root: string
  lessons: string
  notes: string
  efficacy: string
  sessions: string
}

interface SessionSummary {
  summary: string
  sessionId: string
  turn: number
}

const DEFAULT_READ_LIMIT = 20
const DEFAULT_SEARCH_LIMIT = 10
const MAX_LIMIT = 50
const MAX_CONTENT_LENGTH = 20_000
const MAX_QUERY_LENGTH = 2_000
const MAX_ITEM_TEXT = 4_000
const MAX_SEARCH_CANDIDATES = 200
const MAX_SESSION_FILES = 50

const readOutputSchema: JsonSchema = {
  type: 'object',
  properties: {
    scope: { type: 'string', const: 'project' },
    kind: { type: 'string', enum: ['all', 'lessons', 'notes', 'sessions'] },
    total: { type: 'integer', minimum: 0 },
    count: { type: 'integer', minimum: 0, maximum: MAX_LIMIT },
    items: { type: 'array', maxItems: MAX_LIMIT, items: { type: 'object' } },
    truncated: { type: 'boolean' },
  },
  required: ['scope', 'kind', 'total', 'count', 'items', 'truncated'],
  additionalProperties: false,
}

const writeOutputSchema: JsonSchema = {
  type: 'object',
  properties: {
    scope: { type: 'string', enum: ['session', 'project'] },
    kind: { type: 'string', enum: ['lesson', 'note'] },
    written: { type: 'boolean' },
    duplicate: { type: 'boolean' },
    id: { type: 'string' },
    sessionId: { type: 'string' },
  },
  required: ['scope', 'kind', 'written', 'duplicate'],
  additionalProperties: false,
}

const searchOutputSchema: JsonSchema = {
  type: 'object',
  properties: {
    scope: { type: 'string', const: 'project' },
    query: { type: 'string' },
    scoring: { type: 'string', const: 'lexical' },
    algorithm: { type: 'string', const: 'bm25_with_recency' },
    count: { type: 'integer', minimum: 0, maximum: MAX_LIMIT },
    results: {
      type: 'array',
      maxItems: MAX_LIMIT,
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['lesson', 'note', 'session_summary'] },
          scope: { type: 'string', const: 'project' },
          id: { type: 'string' },
          score: { type: 'number' },
          text: { type: 'string', maxLength: MAX_ITEM_TEXT },
        },
        required: ['kind', 'scope', 'id', 'score', 'text'],
        additionalProperties: false,
      },
    },
  },
  required: ['scope', 'query', 'scoring', 'algorithm', 'count', 'results'],
  additionalProperties: false,
}

const promoteOutputSchema: JsonSchema = {
  type: 'object',
  properties: {
    scope: { type: 'string', const: 'project' },
    sessionId: { type: 'string' },
    lesson: { type: 'string' },
    promoted: { type: 'boolean' },
    duplicate: { type: 'boolean' },
  },
  required: ['scope', 'sessionId', 'lesson', 'promoted', 'duplicate'],
  additionalProperties: false,
}

const trialOutputSchema: JsonSchema = {
  type: 'object',
  properties: {
    scope: { type: 'string', const: 'project' },
    lesson: { type: 'string' },
    status: { type: 'string', enum: ['helps', 'hurts', 'inconclusive'] },
    withLesson: { type: 'object' },
    withoutLesson: { type: 'object' },
    delta: { type: 'number', nullable: true },
    standardError: { type: 'number', nullable: true },
    requiredRunsPerArm: { type: 'integer' },
    reason: { type: 'string' },
  },
  required: ['scope', 'lesson', 'status'],
  additionalProperties: false,
}

function projectStores(context: McpToolExecutionContext): ProjectStorePaths {
  const rawRoot = context.cwd.trim()
  if (!rawRoot) throw new Error('memory tools require a project working directory')
  const root = resolve(rawRoot)
  const projectPath = (relativePath: string): string => resolveWorkspacePath(relativePath, root)
  return {
    root,
    lessons: projectPath('.elia/lessons.md'),
    notes: projectPath('.elia/brain/notes.jsonl'),
    efficacy: projectPath('.elia/lessons-efficacy.jsonl'),
    sessions: projectPath('.elia/sessions'),
  }
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function sameText(left: string, right: string): boolean {
  return normalizeText(left).toLowerCase() === normalizeText(right).toLowerCase()
}

function requiredText(input: Record<string, unknown>, key: string, maxLength: number): string {
  const value = input[key]
  if (typeof value !== 'string') throw new Error(`${key} must be a string`)
  const normalized = normalizeText(value)
  if (!normalized) throw new Error(`${key} must be non-empty`)
  if (normalized.length > maxLength) throw new Error(`${key} exceeds ${maxLength} characters`)
  return normalized
}

function optionalStringArray(input: Record<string, unknown>, key: string, maxItems = 20): string[] | undefined {
  const value = input[key]
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error(`${key} must be an array of strings`)
  if (value.length > maxItems) throw new Error(`${key} accepts at most ${maxItems} items`)
  return value.map((entry) => {
    if (typeof entry !== 'string') throw new Error(`${key} must be an array of strings`)
    const normalized = normalizeText(entry)
    if (!normalized) throw new Error(`${key} cannot contain empty strings`)
    if (normalized.length > 500) throw new Error(`${key} entries cannot exceed 500 characters`)
    return normalized
  })
}

function boundedLimit(input: Record<string, unknown>, fallback: number): number {
  const value = input.limit
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw new Error(`limit must be an integer from 1 to ${MAX_LIMIT}`)
  }
  return value
}

function readKind(input: Record<string, unknown>): ReadKind {
  const value = input.kind ?? 'all'
  if (value !== 'all' && value !== 'lessons' && value !== 'notes' && value !== 'sessions') {
    throw new Error('kind must be all, lessons, notes, or sessions')
  }
  return value
}

function writeKind(input: Record<string, unknown>): WriteKind {
  const value = input.kind
  if (value !== 'lesson' && value !== 'note') throw new Error('kind must be lesson or note')
  return value
}

function writeScope(input: Record<string, unknown>): MemoryScope {
  const value = input.scope
  if (value !== 'session' && value !== 'project') throw new Error('scope must be session or project')
  return value
}

function redacted(value: string, maxLength: number, root: string): string {
  return redactText(relativizeProjectPaths(value, root), maxLength)
}

function redactedStrings(values: readonly string[], maxItems: number, root: string): string[] {
  return values.slice(0, maxItems).map((value) => redacted(value, 500, root))
}

function activeMemory(context: McpToolExecutionContext) {
  const sessionId = context.sessionBus.activeSession
  if (!sessionId) throw new Error('session-scoped memory requires an active session')
  const handle = context.sessionBus.get(sessionId)
  if (!handle) throw new Error('the active session is no longer registered')
  return { sessionId, memory: handle.memorySlice }
}

function lessonEntries(paths: ProjectStorePaths): MemoryReadItem[] {
  return loadLessons(paths.lessons).filter((lesson) => normalizeText(lesson.text)).map((lesson) => ({
    kind: 'lesson',
    scope: 'project',
    id: lesson.key ?? lessonKey(lesson.text),
    at: lesson.at,
    text: redacted(lesson.text, MAX_ITEM_TEXT, paths.root),
    ...(lesson.source ? { source: redacted(lesson.source, 200, paths.root) } : {}),
    ...(typeof lesson.confidence === 'number' ? { confidence: lesson.confidence } : {}),
  }))
}

function noteEntries(paths: ProjectStorePaths): MemoryReadItem[] {
  return loadNotes(paths.notes).filter((note) => note.id && normalizeText(note.text)).map((note) => ({
    kind: 'note',
    scope: 'project',
    id: redacted(note.id, 200, paths.root),
    at: note.at,
    text: redacted(note.text, MAX_ITEM_TEXT, paths.root),
    paths: redactedStrings(note.paths, 20, paths.root),
    tags: redactedStrings(note.tags, 20, paths.root),
  }))
}

async function sessionEntries(paths: ProjectStorePaths, fileLimit = MAX_SESSION_FILES): Promise<MemoryReadItem[]> {
  const sessionIds = listLedgerSessionIds(paths.sessions)
    .sort((left, right) => right.localeCompare(left))
    .slice(0, fileLimit)
  const ledgers = await Promise.all(sessionIds.map(async (sessionId) => {
    try {
      return {
        sessionId,
        records: await loadLedger(sessionId, paths.sessions),
      }
    } catch {
      return { sessionId, records: [] }
    }
  }))
  return ledgers.flatMap(({ sessionId, records }) => records.flatMap((record) => {
    if (typeof record.id !== 'string' || typeof record.summary !== 'string' || !normalizeText(record.summary)) return []
    if (!Number.isFinite(record.at) || !Number.isFinite(record.turn)) return []
    return [{
      kind: 'session_summary' as const,
      scope: 'project' as const,
      id: redacted(`${sessionId}:${record.id}`, 300, paths.root),
      sessionId: redacted(sessionId, 200, paths.root),
      turn: record.turn,
      at: record.at,
      text: redacted(record.summary, MAX_ITEM_TEXT, paths.root),
    }]
  }))
}

async function readMemory(input: Record<string, unknown>, context: McpToolExecutionContext) {
  const kind = readKind(input)
  const limit = boundedLimit(input, DEFAULT_READ_LIMIT)
  const paths = projectStores(context)
  const entries: MemoryReadItem[] = []
  if (kind === 'all' || kind === 'lessons') entries.push(...lessonEntries(paths))
  if (kind === 'all' || kind === 'notes') entries.push(...noteEntries(paths))
  if (kind === 'all' || kind === 'sessions') entries.push(...await sessionEntries(paths))
  entries.sort((left, right) => right.at - left.at || right.id.localeCompare(left.id))
  const items = entries.slice(0, limit)
  return {
    scope: 'project' as const,
    kind,
    total: entries.length,
    count: items.length,
    items,
    truncated: entries.length > items.length,
  }
}

async function writeMemory(input: Record<string, unknown>, context: McpToolExecutionContext) {
  const kind = writeKind(input)
  const scope = writeScope(input)
  const content = requiredText(input, 'content', MAX_CONTENT_LENGTH)
  const notePaths = optionalStringArray(input, 'paths')
  const noteTags = optionalStringArray(input, 'tags')
  if (kind === 'lesson' && (notePaths !== undefined || noteTags !== undefined)) {
    throw new Error('paths and tags are only valid for notes')
  }
  if (scope === 'session' && (notePaths !== undefined || noteTags !== undefined)) {
    throw new Error('session notes accept content only')
  }
  const paths = projectStores(context)
  const governanceInput = {
    kind,
    scope,
    content: redacted(content, 1_000, paths.root),
    ...(notePaths ? { paths: redactedStrings(notePaths, 20, paths.root) } : {}),
    ...(noteTags ? { tags: redactedStrings(noteTags, 20, paths.root) } : {}),
  }
  if (scope === 'session') activeMemory(context)
  return context.governedMutation('memory_write', governanceInput, () => {
    if (scope === 'session') {
      const { sessionId, memory } = activeMemory(context)
      const values = kind === 'lesson' ? memory.localLessons : memory.localNotes
      const duplicate = values.some((value) => sameText(value, content))
      if (!duplicate) values.push(content)
      return { scope, kind, written: !duplicate, duplicate, sessionId: redacted(sessionId, 200, paths.root) }
    }
    if (kind === 'lesson') {
      return withFileLock(`${paths.lessons}.lock`, () => {
        const duplicate = loadLessons(paths.lessons).some((lesson) => sameText(lesson.text, content))
        if (!duplicate) appendLessons([{ text: content, source: 'mcp' }], paths.lessons, paths.lessons)
        const stored = loadLessons(paths.lessons).find((lesson) => sameText(lesson.text, content))
        if (!stored) throw new Error('project lesson write did not persist')
        return { scope, kind, written: !duplicate, duplicate, id: redacted(stored.key ?? lessonKey(stored.text), 200, paths.root) }
      })
    }
    return withFileLock(`${paths.notes}.lock`, () => {
      const existing = loadNotes(paths.notes).find((note) => sameText(note.text, content))
      const appended = existing
        ? undefined
        : appendNote({ text: content, ...(notePaths ? { paths: notePaths } : {}), ...(noteTags ? { tags: noteTags } : {}) }, paths.notes)
      const stored = loadNotes(paths.notes).find((note) => sameText(note.text, content))
      if (!stored) throw new Error('project note write did not persist')
      return { scope, kind, written: appended !== undefined, duplicate: appended === undefined, id: redacted(stored.id, 200, paths.root) }
    })
  })
}

function searchableItem(item: BrainItem, summaries: ReadonlyMap<string, SessionSummary>, root: string): MemoryReadItem | undefined {
  if (item.kind === 'lesson') {
    return {
      kind: 'lesson',
      scope: 'project',
      id: redacted(item.key, 300, root),
      at: item.at,
      text: redacted(item.text, MAX_ITEM_TEXT, root),
    }
  }
  if (item.kind === 'note') {
    return {
      kind: 'note',
      scope: 'project',
      id: redacted(item.key, 300, root),
      at: item.at,
      text: redacted(item.text, MAX_ITEM_TEXT, root),
      paths: [],
      tags: [],
    }
  }
  if (item.kind !== 'episode') return undefined
  const summary = summaries.get(item.key)
  if (!summary) return undefined
  return {
    kind: 'session_summary',
    scope: 'project',
    id: redacted(item.key, 300, root),
    sessionId: redacted(summary.sessionId, 200, root),
    turn: summary.turn,
    at: item.at,
    text: redacted(summary.summary, MAX_ITEM_TEXT, root),
  }
}

async function loadSearchSources(paths: ProjectStorePaths, sessionIds: readonly string[]) {
  const items: BrainItem[] = []
  for (const lesson of loadLessons(paths.lessons)) {
    if (!normalizeText(lesson.text)) continue
    items.push({
      kind: 'lesson',
      key: `lesson:${lessonKey(lesson.text)}`,
      text: lesson.text,
      render: `lesson: ${lesson.text}`,
      at: Number.isFinite(lesson.at) ? lesson.at : 0,
      paths: [],
      symbols: [],
    })
  }
  for (const note of loadNotes(paths.notes)) {
    if (!note.id || !normalizeText(note.text)) continue
    items.push({
      kind: 'note',
      key: `note:${note.id}`,
      text: [note.text, ...note.paths, ...note.tags].join(' '),
      render: `note: ${note.text}`,
      at: Number.isFinite(note.at) ? note.at : 0,
      paths: note.paths,
      symbols: [],
    })
  }
  const summaries = new Map<string, SessionSummary>()
  const ledgers = await Promise.all(sessionIds.map(async (sessionId) => {
    try {
      return { sessionId, records: await loadLedger(sessionId, paths.sessions) }
    } catch {
      return { sessionId, records: [] }
    }
  }))
  for (const { sessionId, records } of ledgers) {
    for (const record of records) {
      if (typeof record.id !== 'string' || typeof record.summary !== 'string' || !normalizeText(record.summary) || !Number.isFinite(record.at) || !Number.isFinite(record.turn)) continue
      const decisions = Array.isArray(record.decisions) ? record.decisions.filter((value): value is string => typeof value === 'string') : []
      const filesTouched = Array.isArray(record.filesTouched) ? record.filesTouched.filter((value): value is string => typeof value === 'string') : []
      const symbols = Array.isArray(record.symbols) ? record.symbols.filter((value): value is string => typeof value === 'string') : []
      const openThreads = Array.isArray(record.openThreads) ? record.openThreads.filter((value): value is string => typeof value === 'string') : []
      const key = `episode:${record.id}`
      items.push({
        kind: 'episode',
        key,
        text: [record.summary, ...decisions, ...filesTouched, ...symbols, ...openThreads].join(' '),
        render: `episode (turn ${record.turn}): ${record.summary}`,
        at: record.at,
        paths: filesTouched,
        symbols,
        sessionId,
      })
      summaries.set(key, { summary: record.summary, sessionId, turn: record.turn })
    }
  }
  return { items, summaries }
}

async function searchMemory(input: Record<string, unknown>, context: McpToolExecutionContext) {
  const query = requiredText(input, 'query', MAX_QUERY_LENGTH)
  const limit = boundedLimit(input, DEFAULT_SEARCH_LIMIT)
  const paths = projectStores(context)
  const sessionIds = listLedgerSessionIds(paths.sessions)
    .sort((left, right) => right.localeCompare(left))
    .slice(0, MAX_SESSION_FILES)
  const { items: loadedItems, summaries } = await loadSearchSources(paths, sessionIds)
  const allowedSessionIds = new Set(sessionIds)
  const seenKeys = new Set<string>()
  const items = loadedItems
    .filter((item) => item.kind === 'lesson' || item.kind === 'note' || (
      item.kind === 'episode' && item.sessionId !== undefined && allowedSessionIds.has(item.sessionId)
    ))
    .filter((item) => {
      if (seenKeys.has(item.key)) return false
      seenKeys.add(item.key)
      return true
    })
    .sort((left, right) => left.key.localeCompare(right.key))
  const byKey = new Map<string, MemoryReadItem>()
  for (const item of items) {
    const searchable = searchableItem(item, summaries, paths.root)
    if (searchable) byKey.set(item.key, searchable)
  }
  const rankingTime = items.reduce((latest, item) => Math.max(latest, item.at), 0)
  const hits = searchBrain(items, query, {
    kinds: ['episode', 'lesson', 'note'],
    limit: MAX_SEARCH_CANDIDATES,
    now: rankingTime,
  })
  const results = hits.flatMap((hit) => {
    const item = byKey.get(hit.item.key)
    if (!item || !Number.isFinite(hit.score)) return []
    return [{
      kind: item.kind,
      scope: item.scope,
      id: item.id,
      score: hit.score,
      text: item.text,
    }]
  }).slice(0, limit)
  return {
    scope: 'project' as const,
    query: redacted(query, MAX_QUERY_LENGTH, paths.root),
    scoring: 'lexical' as const,
    algorithm: 'bm25_with_recency' as const,
    count: results.length,
    results,
  }
}

async function promoteLesson(input: Record<string, unknown>, context: McpToolExecutionContext) {
  const lesson = requiredText(input, 'lesson', MAX_CONTENT_LENGTH)
  const paths = projectStores(context)
  const { sessionId, memory } = activeMemory(context)
  const local = memory.localLessons.find((value) => sameText(value, lesson))
  const projectLesson = loadLessons(paths.lessons).find((value) => sameText(value.text, lesson))
  if (!local && !projectLesson) throw new Error('lesson is not present in the active session or project')
  const governanceInput = { sessionId: redacted(sessionId, 200, paths.root), lesson: redacted(lesson, 1_000, paths.root) }
  return context.governedMutation('lesson_promote', governanceInput, () => withFileLock(`${paths.lessons}.lock`, () => {
    const currentLocal = memory.localLessons.find((value) => sameText(value, lesson))
    const currentProject = loadLessons(paths.lessons).find((value) => sameText(value.text, lesson))
    if (!currentLocal) {
      if (!currentProject) throw new Error('lesson is not present in the active session or project')
      return {
        scope: 'project' as const,
        sessionId: redacted(sessionId, 200, paths.root),
        lesson: redacted(currentProject.text, MAX_ITEM_TEXT, paths.root),
        promoted: false,
        duplicate: true,
      }
    }
    const alreadyInProject = Boolean(currentProject)
    if (!currentProject) appendLessons([{ text: currentLocal, source: 'mcp' }], paths.lessons, paths.lessons)
    const stored = loadLessons(paths.lessons).find((value) => sameText(value.text, currentLocal))
    if (!stored) throw new Error('project lesson promotion did not persist')
    try {
      promoteLocalLessons(memory, [currentLocal])
    } catch {
      throw new Error('session lesson was not promoted')
    }
    if (memory.localLessons.some((value) => sameText(value, currentLocal))) {
      throw new Error('session lesson was not promoted')
    }
    return {
      scope: 'project' as const,
      sessionId: redacted(sessionId, 200, paths.root),
      lesson: redacted(stored.text, MAX_ITEM_TEXT, paths.root),
      promoted: true,
      duplicate: alreadyInProject,
    }
  }))
}

async function trialLesson(input: Record<string, unknown>, context: McpToolExecutionContext) {
  const lesson = requiredText(input, 'lesson', MAX_CONTENT_LENGTH)
  const paths = projectStores(context)
  const stored = loadLessons(paths.lessons).find((value) => sameText(value.text, lesson))
  if (!stored) throw new Error('lesson is not present in this project')
  const key = stored.key || lessonKey(stored.text)
  const trial = lessonTrials(paths.efficacy).get(key)
  if (!trial) {
    const efficacy = loadEfficacy(paths.efficacy).get(key)
    const shownRuns = efficacy?.exposures ?? 0
    const shownRate = efficacy && shownRuns > 0 ? efficacy.cleanRuns / shownRuns : null
    return {
      scope: 'project' as const,
      lesson: redacted(stored.text, MAX_ITEM_TEXT, paths.root),
      status: 'inconclusive' as const,
      withLesson: { runs: shownRuns, rate: shownRate },
      withoutLesson: { runs: null, rate: null },
      delta: null,
      standardError: null,
      requiredRunsPerArm: MIN_HELD_OUT,
      reason: shownRuns < MIN_HELD_OUT
        ? `insufficient with-lesson evidence: ${shownRuns}/${MIN_HELD_OUT}`
        : 'insufficient randomized holdout evidence',
    }
  }
  return {
    scope: 'project' as const,
    lesson: redacted(stored.text, MAX_ITEM_TEXT, paths.root),
    status: trial.verdict === 'unclear' ? 'inconclusive' as const : trial.verdict,
    withLesson: { runs: trial.shown.runs, rate: trial.shown.clean / trial.shown.runs },
    withoutLesson: { runs: trial.heldOut.runs, rate: trial.heldOut.clean / trial.heldOut.runs },
    delta: trial.lift,
    standardError: trial.se,
    requiredRunsPerArm: MIN_HELD_OUT,
    ...(trial.verdict === 'unclear' ? { reason: 'measured effect is not distinguishable from zero' } : {}),
  }
}

export function createMemoryTools(context: McpToolExecutionContext): McpToolDefinition[] {
  const rawCwd = context.cwd.trim()
  if (!rawCwd) throw new Error('memory tools require a project working directory')
  const boundCwd = resolve(rawCwd)
  const boundContext: McpToolExecutionContext = {
    ...context,
    cwd: boundCwd,
    config: { ...context.config, cwd: boundCwd },
  }
  return [
    {
      name: 'elia_memory_read',
      description: 'Read bounded, secret-redacted project lessons, notes, and archived session summaries.',
      category: ToolCategory.MEMORY,
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['all', 'lessons', 'notes', 'sessions'], default: 'all' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_READ_LIMIT },
        },
        additionalProperties: false,
      },
      outputSchema: readOutputSchema,
      requiresApproval: false,
      supportedModes: ELIA_MODES,
      idempotent: true,
      costTier: 'free',
      inventoryId: 'memory.memory.read',
      execute: (input) => readMemory(input, boundContext),
    },
    {
      name: 'elia_memory_write',
      description: 'Write a bounded lesson or note to the active session or this project through governed mutation.',
      category: ToolCategory.MEMORY,
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['lesson', 'note'] },
          scope: { type: 'string', enum: ['session', 'project'] },
          content: { type: 'string', minLength: 1, maxLength: MAX_CONTENT_LENGTH },
          paths: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 500 } },
          tags: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 500 } },
        },
        required: ['kind', 'scope', 'content'],
        additionalProperties: false,
      },
      outputSchema: writeOutputSchema,
      requiresApproval: true,
      supportedModes: ELIA_MODES,
      idempotent: false,
      costTier: 'free',
      inventoryId: 'memory.memory.write',
      execute: (input) => writeMemory(input, boundContext),
    },
    {
      name: 'elia_memory_search',
      description: 'Search this project memory with deterministic lexical BM25 relevance and recency scoring.',
      category: ToolCategory.MEMORY,
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1, maxLength: MAX_QUERY_LENGTH },
          limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_SEARCH_LIMIT },
        },
        required: ['query'],
        additionalProperties: false,
      },
      outputSchema: searchOutputSchema,
      requiresApproval: false,
      supportedModes: ELIA_MODES,
      idempotent: true,
      costTier: 'cheap',
      inventoryId: 'memory.memory.search',
      execute: (input) => searchMemory(input, boundContext),
    },
    {
      name: 'elia_lesson_promote',
      description: 'Promote one matching active-session lesson into this project without global or cross-project writes.',
      category: ToolCategory.MEMORY,
      inputSchema: {
        type: 'object',
        properties: {
          lesson: { type: 'string', minLength: 1, maxLength: MAX_CONTENT_LENGTH },
        },
        required: ['lesson'],
        additionalProperties: false,
      },
      outputSchema: promoteOutputSchema,
      requiresApproval: true,
      supportedModes: ELIA_MODES,
      idempotent: false,
      costTier: 'cheap',
      inventoryId: 'memory.lesson.promote',
      execute: (input) => promoteLesson(input, boundContext),
    },
    {
      name: 'elia_lesson_trial',
      description: 'Report measured randomized with-lesson versus holdout efficacy for a project lesson.',
      category: ToolCategory.MEMORY,
      inputSchema: {
        type: 'object',
        properties: {
          lesson: { type: 'string', minLength: 1, maxLength: MAX_CONTENT_LENGTH },
        },
        required: ['lesson'],
        additionalProperties: false,
      },
      outputSchema: trialOutputSchema,
      requiresApproval: true,
      supportedModes: ELIA_MODES,
      idempotent: false,
      costTier: 'cheap',
      inventoryId: 'memory.lesson.trial',
      execute: (input) => trialLesson(input, boundContext),
    },
  ]
}
