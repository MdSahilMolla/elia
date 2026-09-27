import { createHash } from 'node:crypto'
import { redactSecrets } from '../../ui/redact.ts'
import { makeSessionName, type SessionBus, type SessionHandle, type SessionId } from '../../session/types.ts'
import type { JsonSchema, McpImportedContext, McpToolDefinition, McpToolExecutionContext } from '../serverTypes.ts'

export const IMPORT_TOOL_NAME = 'elia_import_context'

export const IMPORT_ROLES = ['user', 'assistant', 'system', 'tool'] as const
export type ImportRole = (typeof IMPORT_ROLES)[number]

export interface ImportedMessage {
  readonly role: ImportRole
  readonly content: string
}

export interface ImportLimits {
  readonly maxMessages: number
  readonly maxMessageChars: number
  readonly maxTotalChars: number
  readonly maxContexts: number
}

export const IMPORT_LIMITS: ImportLimits = {
  maxMessages: 200,
  maxMessageChars: 20_000,
  maxTotalChars: 400_000,
  maxContexts: 20,
}

export const DEFAULT_IMPORT_SESSION_NAME = 'mcp/import-context'

export const IMPORTED_CONTEXT_KEY = 'elia:imported-context'

export const IMPORT_CHECKPOINT = 'context-imported'

const TRUNCATION_MARKER = '… [truncated]'
const SUMMARY_CHARS = 400
const SOURCE_CHARS = 120
const NOTE_CHARS = 2_000
const ROLE_SET = new Set<string>(IMPORT_ROLES)

export interface ContextBridgeContext {
  readonly importedContexts: Map<string, McpImportedContext>
  readonly sessionBus: SessionBus
  readonly sessionName?: string
  readonly limits?: Partial<ImportLimits>
}

export interface ImportSummary {
  readonly importedId: string
  readonly sessionId: SessionId
  readonly sessionName: string
  readonly source: string
  readonly summary: string
  readonly messageCount: number
  readonly characters: number
  readonly roleCounts: Readonly<Record<ImportRole, number>>
  readonly redactedMessages: number
  readonly truncatedMessages: number
  readonly droppedMessages: number
  readonly reused: boolean
  readonly importedAt: number
  readonly taskStarted: false
  readonly nextStep: string
}

export interface ImportFailure {
  readonly ok: false
  readonly error: string
  readonly errorCode: 'invalid_input' | 'too_large'
  readonly detail?: string
}

export type ImportResult = ({ ok: true } & ImportSummary) | ImportFailure

export interface NormalizedImport {
  readonly messages: readonly ImportedMessage[]
  readonly roleCounts: Readonly<Record<ImportRole, number>>
  readonly redactedMessages: number
  readonly truncatedMessages: number
  readonly droppedMessages: number
  readonly characters: number
  readonly rawCharacters: number
}

export type ImportNormalization = ({ ok: true } & NormalizedImport) | ImportFailure

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function clampText(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}${TRUNCATION_MARKER}`
}

function digestOf(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function zeroRoleCounts(): Record<ImportRole, number> {
  return { user: 0, assistant: 0, system: 0, tool: 0 }
}

export function normalizeImportedMessages(input: unknown, limits: ImportLimits = IMPORT_LIMITS): ImportNormalization {
  if (!Array.isArray(input)) return { ok: false, error: 'messages must be an array', errorCode: 'invalid_input' }
  if (input.length === 0) return { ok: false, error: 'messages must contain at least one entry', errorCode: 'invalid_input' }
  if (input.length > limits.maxMessages) {
    return {
      ok: false,
      error: `conversation has ${input.length} messages, over the ${limits.maxMessages}-message limit`,
      errorCode: 'too_large',
      detail: 'import a bounded slice instead of the whole transcript',
    }
  }

  const messages: ImportedMessage[] = []
  const roleCounts = zeroRoleCounts()
  let redactedMessages = 0
  let truncatedMessages = 0
  let droppedMessages = 0
  let characters = 0
  let rawCharacters = 0

  for (const [index, entry] of input.entries()) {
    if (!isRecord(entry)) {
      return { ok: false, error: `messages[${index}] must be an object`, errorCode: 'invalid_input' }
    }
    const role = entry.role
    const content = entry.content
    if (typeof role !== 'string' || !ROLE_SET.has(role)) {
      return { ok: false, error: `messages[${index}].role must be one of ${IMPORT_ROLES.join(', ')}`, errorCode: 'invalid_input' }
    }
    if (typeof content !== 'string') {
      return { ok: false, error: `messages[${index}].content must be a string`, errorCode: 'invalid_input' }
    }
    const typedRole = role as ImportRole
    rawCharacters += content.length
    const trimmed = content.trim()
    if (trimmed.length === 0) {
      droppedMessages += 1
      continue
    }
    const bounded = clampText(trimmed, limits.maxMessageChars)
    if (bounded !== trimmed) truncatedMessages += 1
    const redacted = redactSecrets(bounded)
    if (redacted !== bounded) redactedMessages += 1
    characters += redacted.length
    if (characters > limits.maxTotalChars) {
      return {
        ok: false,
        error: `conversation exceeds the ${limits.maxTotalChars}-character limit`,
        errorCode: 'too_large',
        detail: `reached ${characters} characters after redaction`,
      }
    }
    roleCounts[typedRole] += 1
    messages.push(Object.freeze({ role: typedRole, content: redacted }))
  }

  if (messages.length === 0) {
    return { ok: false, error: 'every message was empty after trimming', errorCode: 'invalid_input' }
  }

  return { ok: true, messages, roleCounts, redactedMessages, truncatedMessages, droppedMessages, characters, rawCharacters }
}

export function renderImportedTranscript(messages: readonly ImportedMessage[]): string {
  return messages.map((message) => `${message.role}: ${message.content}`).join('\n\n')
}

export function summarizeImportedConversation(messages: readonly ImportedMessage[], provided?: string): string {
  const supplied = provided?.trim()
  if (supplied) return clampText(redactSecrets(supplied), SUMMARY_CHARS)
  const opening = messages.find((message) => message.role === 'user') ?? messages[0]
  if (!opening) return 'empty conversation'
  const firstLine = opening.content.split('\n').find((line) => line.trim().length > 0) ?? opening.content
  return clampText(firstLine, SUMMARY_CHARS)
}

function sessionNameFor(context: ContextBridgeContext): string {
  return context.sessionName ?? DEFAULT_IMPORT_SESSION_NAME
}

function limitsFor(context: ContextBridgeContext): ImportLimits {
  return { ...IMPORT_LIMITS, ...context.limits }
}

function findExisting(sessionBus: SessionBus, name: string): SessionHandle | undefined {
  return sessionBus.byName(makeSessionName(name))
}

function importSession(context: ContextBridgeContext): { handle: SessionHandle; created: boolean } {
  const name = sessionNameFor(context)
  const existing = findExisting(context.sessionBus, name)
  if (existing) return { handle: existing, created: false }
  const handle = context.sessionBus.create(makeSessionName(name))
  context.sessionBus.setStatus(handle.id, 'idle', 'holding imported context')
  return { handle, created: true }
}

function descriptorFor(summary: ImportSummary): Record<string, unknown> {
  return Object.freeze({
    id: summary.importedId,
    source: summary.source,
    summary: summary.summary,
    messageCount: summary.messageCount,
    characters: summary.characters,
    importedAt: summary.importedAt,
  })
}

function publishToSession(context: ContextBridgeContext, handle: SessionHandle, summary: ImportSummary): void {
  handle.sharedContext[IMPORTED_CONTEXT_KEY] = descriptorFor(summary)
  const note = clampText(
    `imported context ${summary.importedId} from ${summary.source}: ${summary.messageCount} messages, ${summary.characters} characters — ${summary.summary}`,
    NOTE_CHARS,
  )
  const memory = handle.memorySlice
  if (!memory.localNotes.includes(note)) memory.localNotes.push(note)
  context.sessionBus.update(handle.id, { lastTask: `imported context: ${summary.summary}` })
  context.sessionBus.noteCheckpoint(handle.id, IMPORT_CHECKPOINT, {
    importedId: summary.importedId,
    messageCount: summary.messageCount,
    characters: summary.characters,
  })
}

function evictOverflow(context: ContextBridgeContext, limits: ImportLimits, keepId: string): void {
  const store = context.importedContexts
  if (store.size <= limits.maxContexts) return
  const ordered = [...store.values()].sort((a, b) => a.importedAt - b.importedAt)
  for (const entry of ordered) {
    if (store.size <= limits.maxContexts) break
    if (entry.id === keepId) continue
    store.delete(entry.id)
  }
}

function existingByDigest(context: ContextBridgeContext, digest: string): McpImportedContext | undefined {
  for (const entry of context.importedContexts.values()) {
    if (entry.metadata?.digest === digest) return entry
  }
  return undefined
}

export function importConversation(
  input: Record<string, unknown>,
  context: ContextBridgeContext,
): ImportResult {
  const limits = limitsFor(context)
  const normalized = normalizeImportedMessages(input.messages, limits)
  if (!normalized.ok) return normalized

  const source = typeof input.source === 'string' && input.source.trim().length > 0
    ? clampText(redactSecrets(input.source.trim()), SOURCE_CHARS)
    : 'mcp'
  const providedSummary = typeof input.summary === 'string' ? input.summary : undefined
  const summary = summarizeImportedConversation(normalized.messages, providedSummary)
  const digest = digestOf(renderImportedTranscript(normalized.messages))
  const { handle } = importSession(context)

  const previous = existingByDigest(context, digest)
  if (previous) {
    const reused: ImportSummary = {
      importedId: previous.id,
      sessionId: handle.id,
      sessionName: handle.name,
      source: previous.source,
      summary: typeof previous.metadata?.summary === 'string' ? previous.metadata.summary : summary,
      messageCount: normalized.messages.length,
      characters: normalized.characters,
      roleCounts: normalized.roleCounts,
      redactedMessages: normalized.redactedMessages,
      truncatedMessages: normalized.truncatedMessages,
      droppedMessages: normalized.droppedMessages,
      reused: true,
      importedAt: previous.importedAt,
      taskStarted: false,
      nextStep: 'context already imported; ask for the work in a separate explicit tool call',
    }
    publishToSession(context, handle, reused)
    return { ok: true, ...reused }
  }

  const importedAt = Date.now()
  const id = `ctx-${digest.slice(0, 16)}`
  const snapshot: McpImportedContext = Object.freeze({
    id,
    source,
    content: renderImportedTranscript(normalized.messages),
    importedAt,
    mimeType: 'text/plain',
    metadata: Object.freeze({
      digest,
      summary,
      messageCount: normalized.messages.length,
      characters: normalized.characters,
      redactedMessages: normalized.redactedMessages,
      truncatedMessages: normalized.truncatedMessages,
      droppedMessages: normalized.droppedMessages,
      roleCounts: Object.freeze({ ...normalized.roleCounts }),
    }),
  })
  context.importedContexts.set(id, snapshot)
  evictOverflow(context, limits, id)

  const result: ImportSummary = {
    importedId: id,
    sessionId: handle.id,
    sessionName: handle.name,
    source,
    summary,
    messageCount: normalized.messages.length,
    characters: normalized.characters,
    roleCounts: normalized.roleCounts,
    redactedMessages: normalized.redactedMessages,
    truncatedMessages: normalized.truncatedMessages,
    droppedMessages: normalized.droppedMessages,
    reused: false,
    importedAt,
    taskStarted: false,
    nextStep: 'context imported; ask for the work in a separate explicit tool call',
  }
  publishToSession(context, handle, result)
  return { ok: true, ...result }
}

export function readImportedContext(context: ContextBridgeContext, sessionId: SessionId): McpImportedContext | undefined {
  const handle = context.sessionBus.get(sessionId)
  const descriptor = handle?.sharedContext[IMPORTED_CONTEXT_KEY]
  const id = isRecord(descriptor) && typeof descriptor.id === 'string' ? descriptor.id : undefined
  return id ? context.importedContexts.get(id) : undefined
}

export function readImportedTranscript(context: ContextBridgeContext, sessionId: SessionId): string | undefined {
  return readImportedContext(context, sessionId)?.content
}

const MESSAGE_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    role: { type: 'string', enum: [...IMPORT_ROLES], description: 'Who produced the message in the importing host.' },
    content: { type: 'string', description: 'The message text. Redacted before it is stored.' },
  },
  required: ['role', 'content'],
  additionalProperties: false,
}

const IMPORT_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    messages: {
      type: 'array',
      description: `The conversation to import, oldest first. At most ${IMPORT_LIMITS.maxMessages} messages.`,
      items: MESSAGE_SCHEMA,
      minItems: 1,
      maxItems: IMPORT_LIMITS.maxMessages,
    },
    source: { type: 'string', description: 'Where the conversation came from, e.g. the host app name.' },
    summary: { type: 'string', description: 'Optional one-line description of the conversation.' },
  },
  required: ['messages'],
  additionalProperties: false,
}

const IMPORT_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    importedId: { type: 'string', description: 'Id of the stored, redacted snapshot.' },
    sessionId: { type: 'string', description: 'The isolated session the import was published to.' },
    sessionName: { type: 'string' },
    source: { type: 'string' },
    summary: { type: 'string', description: 'One-line description of what was imported.' },
    messageCount: { type: 'integer' },
    characters: { type: 'integer' },
    roleCounts: { type: 'object' },
    redactedMessages: { type: 'integer', description: 'Messages whose text had credential-shaped content removed.' },
    truncatedMessages: { type: 'integer' },
    droppedMessages: { type: 'integer', description: 'Messages dropped as empty.' },
    reused: { type: 'boolean', description: 'True when identical content was already imported.' },
    importedAt: { type: 'integer' },
    taskStarted: { type: 'boolean', description: 'Always false: importing context never starts work.' },
    nextStep: { type: 'string' },
  },
  required: ['importedId', 'sessionId', 'summary', 'messageCount', 'characters', 'taskStarted'],
}

export function createContextBridgeTools(context: ContextBridgeContext): McpToolDefinition[] {
  return [
    {
      name: IMPORT_TOOL_NAME,
      description:
        'Import a conversation from another host as elia context. The transcript is size-bounded, redacted, stored immutably, and published to an isolated elia session for later turns. ' +
        'This never starts a run, never calls a model, and never performs the work — ask for that in a separate, explicit tool call.',
      category: 'CONFIG',
      inputSchema: IMPORT_INPUT_SCHEMA,
      outputSchema: IMPORT_OUTPUT_SCHEMA,
      requiresApproval: false,
      supportedModes: ['dev', 'research', 'data', 'finance', 'security', 'battmann', 'presentation', 'general'],
      idempotent: true,
      costTier: 'free',
      inventoryId: 'config.import.context',
      execute(input: Record<string, unknown>, _execution: McpToolExecutionContext): unknown {
        return importConversation(input, context)
      },
    },
  ]
}

export function createBridgeContext(sessionBus: SessionBus, overrides: Partial<ContextBridgeContext> = {}): ContextBridgeContext {
  return { importedContexts: new Map<string, McpImportedContext>(), sessionBus, ...overrides }
}
