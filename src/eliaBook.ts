import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ConversationMessage } from './agentLoop.ts'
import { ensureSecureDirectory, hardenSecureFile, writeSecureFile } from './securePersistence.ts'
import { redactArchiveValue, redactSecrets } from './ui/redact.ts'
import { createTranscript, type TranscriptSnapshot } from './ui/transcript.ts'
import { resolveWorkspacePath } from './autonomy/context.ts'
import type { SlashOutcome } from './ui/app/App.tsx'

const BOOK_SCHEMA_VERSION = 1
const SAFE_BOOK_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/
const SAFE_RUN_ID = /^[a-z0-9][a-z0-9_-]{0,99}$/i
const MAX_TEXT = 20_000

export interface EliaBookStep {
  id: string
  title: string
  role: string
  instructions: string
  files: string[]
  dependsOn: string[]
}

export interface EliaBookProcedure {
  goal: string
  understanding: string
  assumptions: string[]
  steps: EliaBookStep[]
  risks: string[]
  verification: string[]
  outOfScope: string[]
  acceptanceCriteria: string[]
  sideEffects: string[]
  recovery: string[]
}

export interface EliaBookEvidence {
  sourceKind: 'autonomous-run' | 'interactive-session'
  sourceRunId?: string
  sourceSessionId?: string
  outcome: string
  verified: boolean
  elapsedMs?: number
  totalTokens?: number
  actionCount: number
  failedActions: number
  blockedActions: number
  summary: string
  successes: string[]
  failures: string[]
  lessons: string[]
  recordingFiles: string[]
}

export interface EliaBookVersion {
  version: number
  createdAt: string
  procedure: EliaBookProcedure
  evidence: EliaBookEvidence
  improvement: string
}

export interface EliaBook {
  schemaVersion: 1
  id: string
  title: string
  status: 'recorded' | 'draft' | 'verified'
  createdAt: string
  updatedAt: string
  activeVersion: number
  versions: EliaBookVersion[]
}

export interface EliaBookCommandResult {
  text: string
  submitText?: string
}

export interface EliaBookSessionSnapshot {
  sessionId: string
  messages: ConversationMessage[]
  transcriptMarkdown: string
  recording?: TranscriptSnapshot
  checkpoints: { turn: number; at: number; label: string; files: string[] }[]
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; turns: number; elapsedMs: number }
  providerLabel: string
  model: string
  mode: string
}

export const ELIA_BOOK_MENU_OPTIONS = [
  { label: 'Save this session', detail: 'capture this conversation, actions, files, evidence, and insights', value: 'save' },
  { label: 'Saved Elia Books', detail: 'browse and reuse saved session playbooks', value: 'saved' },
] as const

/** Shared menu logic keeps saving tied to the session at the moment it is selected. */
export function eliaBookMenu(argument: string, getSession: () => EliaBookSessionSnapshot, cwd = process.cwd()): SlashOutcome {
  const done = (text: string): SlashOutcome => ({ handled: true, text })
  const saved = (): SlashOutcome => {
    const books = listEliaBooks(cwd)
    if (!books.length) return done('No saved Elia Books yet. Choose Save this session after completing some work.')
    return { handled: true, picker: {
      title: `Saved Elia Books (${books.length})`, searchable: books.length > 8,
      options: books.map((book) => ({ label: book.title, detail: `${book.id} · ${book.status} · v${book.activeVersion}`, value: book.id })),
      onSelect: (id) => {
        if (!id) return
        const book = books.find((item) => item.id === id)
        return done(book ? `${renderEliaBook(book)}\nRun it with: /eliabook run ${book.id}` : `No Elia Book found for "${id}".`)
      },
    } }
  }
  if (!argument.trim()) return { handled: true, picker: {
    title: 'Elia Book', options: [...ELIA_BOOK_MENU_OPTIONS],
    onSelect: (value) => value === 'save' ? done(handleEliaBookCommand('save', cwd, getSession()).text) : value === 'saved' ? saved() : undefined,
  } }
  if (['saved', 'list'].includes(argument.trim().toLowerCase())) return saved()
  return { handled: true, ...handleEliaBookCommand(argument, cwd, argument.trim().split(/\s+/)[0]?.toLowerCase() === 'save' ? getSession() : undefined) }
}

function booksDir(cwd: string): string {
  return resolveWorkspacePath(join('.elia', 'books'), cwd)
}

function runDir(cwd: string, runId: string): string {
  return join(cwd, '.elia', 'runs', runId)
}

function recordingDir(cwd: string, bookId: string, version: number): string {
  return join(booksDir(cwd), bookId, `v${version}`)
}

function cleanText(value: unknown, max = MAX_TEXT): string {
  if (typeof value !== 'string') return ''
  const redacted = redactSecrets(value).trim()
  return redacted.length > max ? `${redacted.slice(0, max - 1)}…` : redacted
}

function cleanStrings(value: unknown, limit = 32): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const text = cleanText(item, 2_000)
    return text ? [text] : []
  }).slice(0, limit)
}

function assertBookId(id: string): void {
  if (!SAFE_BOOK_ID.test(id)) throw new Error('Elia Book id must be 1-64 lowercase letters, numbers, or hyphens.')
}

function assertRunId(id: string): void {
  if (!SAFE_RUN_ID.test(id)) throw new Error('Invalid autonomous run id.')
}

function assertSessionId(id: string): void {
  if (!SAFE_RUN_ID.test(id)) throw new Error('Invalid interactive session id.')
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '') || 'elia-book'
}

function uniqueBookId(preferred: string, cwd: string): string {
  const base = slugify(preferred)
  if (!existsSync(join(booksDir(cwd), `${base}.json`))) return base
  for (let index = 2; index < 1_000; index++) {
    const suffix = `-${index}`
    const candidate = `${base.slice(0, 64 - suffix.length).replace(/-+$/g, '')}${suffix}`
    if (!existsSync(join(booksDir(cwd), `${candidate}.json`))) return candidate
  }
  throw new Error(`Could not allocate an Elia Book id for "${preferred}".`)
}

function readJson(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined
  hardenSecureFile(path)
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

function proposalFromRun(cwd: string, runId: string, goal: string): EliaBookProcedure {
  const eventsPath = join(runDir(cwd, runId), 'events.ndjson')
  let proposal: Record<string, unknown> | undefined
  if (existsSync(eventsPath)) {
    hardenSecureFile(eventsPath)
    for (const line of readFileSync(eventsPath, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const event = JSON.parse(line) as { kind?: unknown; data?: { proposal?: unknown } }
        const candidate = event.kind === 'proposal' ? event.data?.proposal : undefined
        if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) proposal = candidate as Record<string, unknown>
      } catch {
        // An interrupted run may leave one torn line; earlier events remain usable.
      }
    }
  }

  const steps = Array.isArray(proposal?.steps)
    ? proposal.steps.flatMap((raw, index): EliaBookStep[] => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
        const step = raw as Record<string, unknown>
        return [{
          id: cleanText(step.id, 100) || `step-${index + 1}`,
          title: cleanText(step.title, 300) || `Step ${index + 1}`,
          role: cleanText(step.role, 80) || 'builder',
          instructions: cleanText(step.instructions) || cleanText(step.title, 2_000),
          files: cleanStrings(step.files, 100),
          dependsOn: cleanStrings(step.dependsOn, 32),
        }]
      }).slice(0, 32)
    : []

  return {
    goal: cleanText(proposal?.goal) || cleanText(goal),
    understanding: cleanText(proposal?.understanding),
    assumptions: cleanStrings(proposal?.assumptions),
    steps: steps.length > 0 ? steps : [{ id: 'execute', title: 'Complete the recorded goal', role: 'builder', instructions: cleanText(goal), files: [], dependsOn: [] }],
    risks: cleanStrings(proposal?.risks),
    verification: cleanStrings(proposal?.verification, 16),
    outOfScope: cleanStrings(proposal?.outOfScope),
    acceptanceCriteria: cleanStrings(proposal?.acceptanceCriteria),
    sideEffects: cleanStrings(proposal?.sideEffects),
    recovery: cleanStrings(proposal?.recovery),
  }
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function runEvidence(cwd: string, runId: string): { evidence: EliaBookEvidence; procedure: EliaBookProcedure } {
  assertRunId(runId)
  const dir = runDir(cwd, runId)
  const eventsPath = join(dir, 'events.ndjson')
  if (!existsSync(eventsPath)) throw new Error(`No autonomous run found for ${runId}.`)

  const receipt = readJson(join(dir, 'receipt.json')) ?? {}
  const events = readFileSync(eventsPath, 'utf8').split('\n').flatMap((line) => {
    try {
      return line.trim() ? [JSON.parse(line) as { kind?: string; data?: Record<string, unknown> }] : []
    } catch {
      return []
    }
  })
  const start = events.find((event) => event.kind === 'run-start')
  const end = [...events].reverse().find((event) => event.kind === 'run-end')
  const goal = cleanText(receipt.goal) || cleanText(start?.data?.goal) || '(unknown goal)'
  const outcome = cleanText(receipt.outcome, 100) || cleanText(end?.data?.outcome, 100) || 'incomplete'
  const completion = receipt.completion && typeof receipt.completion === 'object' && !Array.isArray(receipt.completion)
    ? receipt.completion as Record<string, unknown>
    : {}
  const actions = receipt.actions && typeof receipt.actions === 'object' && !Array.isArray(receipt.actions)
    ? receipt.actions as Record<string, unknown>
    : {}
  const usage = receipt.usage && typeof receipt.usage === 'object' && !Array.isArray(receipt.usage)
    ? receipt.usage as Record<string, unknown>
    : {}
  const lessons = cleanStrings(receipt.lessons)
  const blockers = cleanStrings(completion.blockers)
  const completionState = cleanText(completion.state, 100)
  const verified = outcome === 'completed' && completionState === 'verified' && blockers.length === 0
  const totalTokens = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']
    .map((key) => number(usage[key]) ?? 0)
    .reduce((sum, value) => sum + value, 0)
  const verificationCount = Array.isArray(receipt.verification) ? receipt.verification.length : events.filter((event) => event.kind === 'verify').length
  const recordingFiles = ['events.ndjson', 'actions.ndjson', 'receipt.json', 'receipt.md', 'goal-graph.json', 'checkpoints']
    .filter((name) => existsSync(join(dir, name)))
    .map((name) => `.elia/runs/${runId}/${name}`)

  return {
    procedure: proposalFromRun(cwd, runId, goal),
    evidence: {
      sourceKind: 'autonomous-run',
      sourceRunId: runId,
      outcome,
      verified,
      elapsedMs: number(receipt.elapsedMs),
      totalTokens: totalTokens > 0 ? totalTokens : undefined,
      actionCount: number(actions.total) ?? 0,
      failedActions: number(actions.failed) ?? 0,
      blockedActions: number(actions.blocked) ?? 0,
      summary: cleanText(completion.summary, 2_000) || `Run ended as ${outcome}.`,
      successes: [
        ...(verified ? ['Evidence-backed completion was verified.'] : []),
        ...(verificationCount > 0 ? [`${verificationCount} verification record(s) were captured.`] : []),
        ...lessons.map((lesson) => `Learned: ${lesson}`),
      ],
      failures: blockers.length > 0 ? blockers : outcome === 'completed' ? [] : [`Run outcome: ${outcome}.`],
      lessons,
      recordingFiles,
    },
  }
}

function isEliaBook(value: unknown): value is EliaBook {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const book = value as Partial<EliaBook>
  return book.schemaVersion === BOOK_SCHEMA_VERSION
    && typeof book.id === 'string'
    && SAFE_BOOK_ID.test(book.id)
    && typeof book.title === 'string'
    && (book.status === 'recorded' || book.status === 'draft' || book.status === 'verified')
    && Number.isInteger(book.activeVersion)
    && Array.isArray(book.versions)
    && book.versions.length > 0
}

function saveBook(book: EliaBook, cwd: string): void {
  const dir = booksDir(cwd)
  ensureSecureDirectory(dir)
  writeSecureFile(join(dir, `${book.id}.json`), JSON.stringify(book, null, 2))
  writeSecureFile(join(dir, `${book.id}.md`), renderEliaBook(book))
}

export function readEliaBook(id: string, cwd = process.cwd()): EliaBook | undefined {
  assertBookId(id)
  const path = join(booksDir(cwd), `${id}.json`)
  const value = readJson(path)
  return isEliaBook(value) ? value : undefined
}

export function listEliaBooks(cwd = process.cwd()): EliaBook[] {
  const dir = booksDir(cwd)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .flatMap((name) => {
      try {
        const book = readEliaBook(name.slice(0, -'.json'.length), cwd)
        return book ? [book] : []
      } catch {
        return []
      }
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export function createEliaBookFromRun(runId: string, requestedId?: string, cwd = process.cwd()): EliaBook {
  const snapshot = runEvidence(cwd, runId)
  const id = requestedId ? requestedId.toLowerCase() : uniqueBookId(snapshot.procedure.goal, cwd)
  assertBookId(id)
  if (readEliaBook(id, cwd)) throw new Error(`Elia Book "${id}" already exists.`)
  const now = new Date().toISOString()
  const book: EliaBook = {
    schemaVersion: BOOK_SCHEMA_VERSION,
    id,
    title: cleanText(snapshot.procedure.goal, 160),
    status: snapshot.evidence.verified ? 'verified' : 'draft',
    createdAt: now,
    updatedAt: now,
    activeVersion: 1,
    versions: [{ version: 1, createdAt: now, ...snapshot, improvement: `Created from autonomous run ${runId}.` }],
  }
  saveBook(book, cwd)
  return book
}

function textBlocks(message: ConversationMessage): string[] {
  return message.content.flatMap((block) => block.type === 'text' && block.text.trim() ? [cleanText(block.text, 5_000)] : [])
}

function sessionProcedure(snapshot: EliaBookSessionSnapshot): { procedure: EliaBookProcedure; evidence: EliaBookEvidence } {
  const userPrompts = snapshot.recording ? snapshot.recording.items.flatMap((item) => item.kind === 'user' ? [cleanText(item.text, 5_000)] : []) : snapshot.messages
    .filter((message) => message.role === 'user')
    .flatMap(textBlocks)
    .filter((text) => text.length > 0)
  const shellItems = snapshot.recording?.items.filter((item) => item.kind === 'shell') ?? []
  if (userPrompts.length === 0 && shellItems.length === 0) throw new Error('This session has no conversation or shell activity to save yet.')

  const recordedTools = snapshot.recording?.items.filter((item) => item.kind === 'tool')
  const toolUses = recordedTools ?? snapshot.messages.flatMap((message) => message.content.flatMap((block) => block.type === 'tool_use' ? [block] : []))
  const toolResults = recordedTools?.map((item) => ({ content: item.result, is_error: item.status === 'error' }))
    ?? snapshot.messages.flatMap((message) => message.content.flatMap((block) => block.type === 'tool_result' ? [block] : []))
  const assistantReplies = snapshot.recording ? snapshot.recording.items.flatMap((item) => item.kind === 'assistant' ? [item.text] : [])
    : snapshot.messages.filter((message) => message.role === 'assistant').flatMap(textBlocks)
  const failedResults = toolResults.filter((block) => block.is_error)
  const touchedFiles = [...new Set(snapshot.checkpoints.flatMap((checkpoint) => checkpoint.files))]
  const commands = toolUses.flatMap((block) => {
    if (block.name !== 'run_command') return []
    const command = typeof block.input.command === 'string' ? block.input.command : typeof block.input.cmd === 'string' ? block.input.cmd : ''
    return /(?:test|typecheck|lint|build|check)/i.test(command) ? [cleanText(command, 2_000)] : []
  })
  const title = cleanText(userPrompts[0], 160) || `Shell session ${snapshot.sessionId}`
  const steps = userPrompts.slice(0, 32).map((prompt, index): EliaBookStep => ({
    id: `turn-${index + 1}`,
    title: cleanText(prompt.split(/\r?\n/, 1)[0], 120) || `Session turn ${index + 1}`,
    role: 'builder',
    instructions: prompt,
    files: index === Math.min(userPrompts.length, 32) - 1 ? touchedFiles.slice(0, 100) : [],
    dependsOn: index > 0 ? [`turn-${index}`] : [],
  }))

  return {
    procedure: {
      goal: title,
      understanding: `Reusable procedure captured from interactive session ${snapshot.sessionId}. Re-orient every step against the current workspace before reuse.`,
      assumptions: [],
      steps,
      risks: failedResults.slice(0, 16).map((block) => cleanText(block.content, 500)),
      verification: [...new Set(commands)].slice(0, 16),
      outOfScope: [],
      acceptanceCriteria: [],
      sideEffects: [],
      recovery: touchedFiles.length > 0 ? ['Use the current session checkpoints or version control before reverting workspace changes.'] : [],
    },
    evidence: {
      sourceKind: 'interactive-session',
      sourceSessionId: snapshot.sessionId,
      outcome: 'recorded-session',
      verified: false,
      elapsedMs: snapshot.usage.elapsedMs,
      totalTokens: snapshot.usage.inputTokens + snapshot.usage.outputTokens + snapshot.usage.cacheReadTokens + snapshot.usage.cacheWriteTokens,
      actionCount: toolUses.length,
      failedActions: failedResults.length,
      blockedActions: recordedTools?.filter((item) => item.decision === 'block').length ?? 0,
      summary: `Captured ${snapshot.usage.turns || userPrompts.length} turn(s), ${toolUses.length} tool action(s), ${snapshot.checkpoints.length} checkpoint(s), and ${touchedFiles.length} touched file path(s).`,
      successes: [
        `${userPrompts.length} reusable session instruction(s) were captured.`,
        ...(assistantReplies.length > 0 ? [`Recorded result: ${cleanText(assistantReplies.at(-1), 500)}`] : []),
        ...([...new Set(toolUses.map((block) => block.name))].length > 0
          ? [`Tools used: ${[...new Set(toolUses.map((block) => block.name))].join(', ')}.`]
          : []),
      ],
      failures: failedResults.slice(0, 16).map((block) => cleanText(block.content, 500)),
      lessons: [],
      recordingFiles: [],
    },
  }
}

function saveSessionRecording(book: EliaBook, snapshot: EliaBookSessionSnapshot, cwd: string): void {
  const version = activeVersion(book)
  const dir = recordingDir(cwd, book.id, version.version)
  const relativeDir = `.elia/books/${book.id}/v${version.version}`
  const manifest = {
    schemaVersion: 1,
    bookId: book.id,
    version: version.version,
    savedAt: version.createdAt,
    sessionId: snapshot.sessionId,
    mode: snapshot.mode,
    providerLabel: snapshot.providerLabel,
    model: snapshot.model,
    usage: snapshot.usage,
    checkpoints: snapshot.checkpoints,
    touchedFiles: [...new Set(snapshot.checkpoints.flatMap((checkpoint) => checkpoint.files))],
    recordingScope: 'Observable activity up to the save point. Tool outputs may be limited by their source. Credentials and private reasoning are excluded. Workspace files are referenced, not backed up.',
  }
  ensureSecureDirectory(dir)
  const observableMessages = snapshot.messages.map((message) => ({ ...message, content: message.content.flatMap((block) => {
    if (block.type === 'thinking' || block.type === 'redacted_thinking') return []
    return [block.type === 'tool_use' ? { ...block, input: redactArchiveValue(block.input) } : block]
  }) }))
  writeSecureFile(join(dir, 'session.json'), redactSecrets(JSON.stringify({ id: snapshot.sessionId, messages: observableMessages }, null, 2)))
  writeSecureFile(join(dir, 'transcript.md'), redactSecrets(snapshot.transcriptMarkdown))
  writeSecureFile(join(dir, 'manifest.json'), redactSecrets(JSON.stringify(manifest, null, 2)))
  version.evidence.recordingFiles = [`${relativeDir}/session.json`, `${relativeDir}/transcript.md`, `${relativeDir}/manifest.json`]
  if (snapshot.recording) {
    const transcript = createTranscript()
    transcript.restore(snapshot.recording)
    writeSecureFile(join(dir, 'transcript.json'), JSON.stringify(transcript.snapshot(), null, 2))
    writeSecureFile(join(dir, 'transcript.md'), transcript.toMarkdown(book.title))
    version.evidence.recordingFiles.push(`${relativeDir}/transcript.json`)
  }
}

export function createEliaBookFromSession(snapshot: EliaBookSessionSnapshot, requestedId?: string, cwd = process.cwd()): EliaBook {
  assertSessionId(snapshot.sessionId)
  const captured = sessionProcedure(snapshot)
  const id = requestedId ? requestedId.toLowerCase() : uniqueBookId(captured.procedure.goal, cwd)
  assertBookId(id)
  if (existsSync(join(booksDir(cwd), `${id}.json`)) || existsSync(join(booksDir(cwd), id))) throw new Error(`Elia Book "${id}" already exists.`)
  const now = new Date().toISOString()
  const book: EliaBook = {
    schemaVersion: BOOK_SCHEMA_VERSION,
    id,
    title: captured.procedure.goal,
    status: 'recorded',
    createdAt: now,
    updatedAt: now,
    activeVersion: 1,
    versions: [{ version: 1, createdAt: now, ...captured, improvement: `Saved from interactive session ${snapshot.sessionId}.` }],
  }
  saveSessionRecording(book, snapshot, cwd)
  saveBook(book, cwd)
  return book
}

function activeVersion(book: EliaBook): EliaBookVersion {
  return book.versions.find((version) => version.version === book.activeVersion) ?? book.versions.at(-1)!
}

function evidenceSource(evidence: EliaBookEvidence): string {
  return evidence.sourceKind === 'interactive-session'
    ? `session ${evidence.sourceSessionId ?? 'unknown'}`
    : `run ${evidence.sourceRunId ?? 'unknown'}`
}

function measurableImprovements(previous: EliaBookEvidence, candidate: EliaBookEvidence): string[] {
  const improvements: string[] = []
  if (!previous.verified && candidate.verified) improvements.push('completion became verified')
  if (candidate.failedActions < previous.failedActions) improvements.push(`failed actions ${previous.failedActions} → ${candidate.failedActions}`)
  if (candidate.blockedActions < previous.blockedActions) improvements.push(`blocked actions ${previous.blockedActions} → ${candidate.blockedActions}`)
  if (candidate.actionCount < previous.actionCount) improvements.push(`actions ${previous.actionCount} → ${candidate.actionCount}`)
  if (candidate.totalTokens !== undefined && previous.totalTokens !== undefined && candidate.totalTokens < previous.totalTokens) improvements.push(`tokens ${previous.totalTokens} → ${candidate.totalTokens}`)
  if (candidate.elapsedMs !== undefined && previous.elapsedMs !== undefined && candidate.elapsedMs < previous.elapsedMs) improvements.push(`elapsed ${previous.elapsedMs}ms → ${candidate.elapsedMs}ms`)
  return improvements
}

export function improveEliaBook(id: string, runId: string, cwd = process.cwd()): EliaBook {
  const book = readEliaBook(id, cwd)
  if (!book) throw new Error(`No Elia Book found for "${id}".`)
  if (book.versions.some((version) => version.evidence.sourceRunId === runId)) throw new Error(`Run ${runId} is already recorded in Elia Book "${id}".`)
  const candidate = runEvidence(cwd, runId)
  if (!candidate.evidence.verified) throw new Error(`Run ${runId} is not evidence-backed verified completion, so it cannot improve this Book.`)

  const previous = activeVersion(book).evidence
  if (candidate.evidence.failedActions > previous.failedActions || candidate.evidence.blockedActions > previous.blockedActions) {
    throw new Error(`Run ${runId} regressed action quality, so the current Book remains active.`)
  }
  const improvements = measurableImprovements(previous, candidate.evidence)
  if (improvements.length === 0) throw new Error(`Run ${runId} is verified but not measurably better than the active Book version.`)

  const version = Math.max(...book.versions.map((item) => item.version)) + 1
  const now = new Date().toISOString()
  book.versions.push({ version, createdAt: now, ...candidate, improvement: improvements.join('; ') })
  book.activeVersion = version
  book.status = 'verified'
  book.updatedAt = now
  saveBook(book, cwd)
  return book
}

export function rollbackEliaBook(id: string, cwd = process.cwd()): EliaBook {
  const book = readEliaBook(id, cwd)
  if (!book) throw new Error(`No Elia Book found for "${id}".`)
  const previous = book.versions.filter((version) => version.version < book.activeVersion).at(-1)
  if (!previous) throw new Error(`Elia Book "${id}" has no earlier version to restore.`)
  book.activeVersion = previous.version
  book.status = previous.evidence.verified ? 'verified' : previous.evidence.sourceKind === 'interactive-session' ? 'recorded' : 'draft'
  book.updatedAt = new Date().toISOString()
  saveBook(book, cwd)
  return book
}

export function renderEliaBook(book: EliaBook): string {
  const current = activeVersion(book)
  const evidence = current.evidence
  const procedure = current.procedure
  const lines = [
    `# ${book.title}`,
    '',
    `- **Elia Book:** ${book.id}`,
    `- **Status:** ${book.status}`,
    `- **Active version:** ${book.activeVersion} of ${book.versions.length}`,
    `- **Source:** ${evidenceSource(evidence)}`,
    `- **Outcome:** ${evidence.outcome}`,
    `- **Actions:** ${evidence.actionCount} (${evidence.failedActions} failed, ${evidence.blockedActions} blocked)`,
    ...(evidence.elapsedMs !== undefined ? [`- **Elapsed:** ${(evidence.elapsedMs / 1000).toFixed(1)}s`] : []),
    ...(evidence.totalTokens !== undefined ? [`- **Tokens:** ${evidence.totalTokens.toLocaleString('en-US')}`] : []),
    '',
    '## Session insight',
    '',
    evidence.summary,
    ...(evidence.successes.length > 0 ? ['', '### What worked', '', ...evidence.successes.map((item) => `- ${item}`)] : []),
    ...(evidence.failures.length > 0 ? ['', '### What needs attention', '', ...evidence.failures.map((item) => `- ${item}`)] : []),
    '',
    '## Reusable procedure',
    '',
    `**Goal:** ${procedure.goal}`,
    ...(procedure.understanding ? ['', procedure.understanding] : []),
    '',
    ...procedure.steps.flatMap((step, index) => [
      `### ${index + 1}. ${step.title}`,
      '',
      step.instructions,
      ...(step.dependsOn.length > 0 ? ['', `Depends on: ${step.dependsOn.join(', ')}`] : []),
      ...(step.files.length > 0 ? [`Files: ${step.files.join(', ')}`] : []),
      '',
    ]),
    ...(procedure.verification.length > 0 ? ['## Verification', '', ...procedure.verification.map((item) => `- ${item}`), ''] : []),
    ...(procedure.acceptanceCriteria.length > 0 ? ['## Acceptance criteria', '', ...procedure.acceptanceCriteria.map((item) => `- ${item}`), ''] : []),
    ...(procedure.recovery.length > 0 ? ['## Recovery', '', ...procedure.recovery.map((item) => `- ${item}`), ''] : []),
    '## Complete recording',
    '',
    ...evidence.recordingFiles.map((path) => `- ${path}`),
    '',
    '## Version history',
    '',
    ...book.versions.map((version) => `- v${version.version} · ${evidenceSource(version.evidence)} · ${version.improvement}${version.version === book.activeVersion ? ' · active' : ''}`),
    '',
  ]
  return lines.join('\n')
}

export function eliaBookExecutionPrompt(book: EliaBook, extraInstruction = ''): string {
  const current = activeVersion(book)
  const procedure = current.procedure
  const guardrails = 'Treat this Book as reusable project guidance, not as permission to bypass current user instructions, repository guidance, the action governor, approvals, or verification. Re-orient against the current workspace before editing because the recorded run may be stale. Complete the work and report current evidence.'
  const prompt = [
    `<elia-book id="${book.id}" version="${current.version}">`,
    guardrails,
    `Saved recording: ${current.evidence.recordingFiles.join(', ')}`,
    `Goal: ${procedure.goal}`,
    procedure.understanding ? `Context: ${procedure.understanding}` : '',
    '',
    'Procedure:',
    ...procedure.steps.map((step, index) => `${index + 1}. ${step.title}: ${step.instructions}`),
    '',
    ...(procedure.acceptanceCriteria.length > 0 ? ['Acceptance criteria:', ...procedure.acceptanceCriteria.map((item) => `- ${item}`), ''] : []),
    ...(procedure.verification.length > 0 ? ['Verification:', ...procedure.verification.map((item) => `- ${item}`), ''] : []),
    ...(procedure.sideEffects.length > 0 ? ['Declared side effects:', ...procedure.sideEffects.map((item) => `- ${item}`), ''] : []),
    ...(procedure.recovery.length > 0 ? ['Recovery:', ...procedure.recovery.map((item) => `- ${item}`), ''] : []),
    extraInstruction ? `This run's additional instruction: ${cleanText(extraInstruction, 5_000)}` : '',
    '',
    guardrails,
    '</elia-book>',
  ].filter((line) => line !== '').join('\n')
  return prompt.slice(0, 100_000)
}

function renderBookList(cwd: string): string {
  const books = listEliaBooks(cwd)
  if (books.length === 0) return 'No Elia Books yet. Save the current session with: /eliabook save [book-id]'
  return ['Elia Books:', ...books.map((book) => {
    const current = activeVersion(book)
    return `  ${book.id} · ${book.status} · v${book.activeVersion} · ${evidenceSource(current.evidence)} · ${book.title}`
  })].join('\n')
}

export function handleEliaBookCommand(argument = '', cwd = process.cwd(), session?: EliaBookSessionSnapshot): EliaBookCommandResult {
  const parts = argument.trim().split(/\s+/).filter(Boolean)
  const action = parts[0]?.toLowerCase() ?? 'list'
  try {
    if (action === 'list' || action === 'saved') return { text: renderBookList(cwd) }
    if (action === 'help') return { text: eliaBookUsage() }
    if (action === 'save') {
      if (!session) return { text: 'Saving this session is available inside an active Elia terminal session.' }
      const book = createEliaBookFromSession(session, parts[1], cwd)
      return { text: `Saved this session as Elia Book "${book.id}".\nPlaybook: .elia/books/${book.id}.md\nRecording: .elia/books/${book.id}/v1/` }
    }
    if (action === 'create') {
      const runId = parts[1]
      if (!runId) return { text: 'Usage: /eliabook create <run-id> [book-id]' }
      const book = createEliaBookFromRun(runId, parts[2], cwd)
      return { text: `Created Elia Book "${book.id}" from run ${runId} (${book.status}, v1).\nSaved: .elia/books/${book.id}.md` }
    }
    if (action === 'show' || action === 'inspect') {
      const id = parts[1]
      if (!id) return { text: 'Usage: /eliabook show <book-id>' }
      const book = readEliaBook(id, cwd)
      return { text: book ? renderEliaBook(book) : `No Elia Book found for "${id}".` }
    }
    if (action === 'run') {
      const id = parts[1]
      if (!id) return { text: 'Usage: /eliabook run <book-id> [additional instruction]' }
      const book = readEliaBook(id, cwd)
      if (!book) return { text: `No Elia Book found for "${id}".` }
      return { text: `Running Elia Book "${id}" v${book.activeVersion}.`, submitText: eliaBookExecutionPrompt(book, parts.slice(2).join(' ')) }
    }
    if (action === 'improve') {
      const [id, runId] = parts.slice(1)
      if (!id || !runId) return { text: 'Usage: /eliabook improve <book-id> <verified-run-id>' }
      const book = improveEliaBook(id, runId, cwd)
      return { text: `Promoted Elia Book "${id}" to v${book.activeVersion} from verified run ${runId}. Use /eliabook rollback ${id} to restore the previous version.` }
    }
    if (action === 'rollback') {
      const id = parts[1]
      if (!id) return { text: 'Usage: /eliabook rollback <book-id>' }
      const book = rollbackEliaBook(id, cwd)
      return { text: `Rolled Elia Book "${id}" back to v${book.activeVersion}.` }
    }
    return { text: `Unknown Elia Book action "${action}".\n${eliaBookUsage()}` }
  } catch (error) {
    return { text: `Elia Book: ${error instanceof Error ? error.message : String(error)}` }
  }
}

export function eliaBookUsage(): string {
  return [
    '/eliabook                         Open Save this session / Saved Elia Books',
    '/eliabook save [id]               Save the complete current session as a Book',
    '/eliabook saved                   List saved session playbooks',
    '/eliabook create <run-id> [id]   Create from a complete autonomous-run recording',
    '/eliabook show <id>              Show session insight, procedure, evidence, and versions',
    '/eliabook run <id> [instruction] Run the active procedure in this session',
    '/eliabook improve <id> <run-id>  Promote a measurably better verified run as a new version',
    '/eliabook rollback <id>          Restore the previous version',
  ].join('\n')
}
