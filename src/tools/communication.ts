import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { paths } from '../config.ts'
import type { Tool } from './types.ts'
import { readBoundedOutput, terminateProcessGroup } from '../shell.ts'

export type CommunicationChannel = 'email' | 'message' | 'calendar' | 'slack' | 'sms' | 'custom'
type CommunicationStatus = 'draft' | 'awaiting_approval' | 'sending' | 'sent' | 'verified' | 'send_failed' | 'cancelled'
type CommunicationAction = 'status' | 'draft' | 'inspect' | 'list' | 'send' | 'verify' | 'cancel'

interface CommunicationRequest {
  action: CommunicationAction
  draftId?: string
  channel?: CommunicationChannel
  recipient?: string
  cc?: string[]
  bcc?: string[]
  subject?: string
  body?: string
  attachments?: string[]
  replyTo?: string
  scheduledFor?: string
  confirmationToken?: string
}

interface PendingApproval {
  token: string
  fingerprint: string
  expiresAt: number
}

interface CommunicationDraft {
  id: string
  channel: CommunicationChannel
  recipient: string
  cc: string[]
  bcc: string[]
  subject?: string
  body: string
  attachments: string[]
  replyTo?: string
  scheduledFor?: string
  status: CommunicationStatus
  createdAt: string
  updatedAt: string
  sentAt?: string
  verifiedAt?: string
  externalId?: string
  error?: string
  pendingApproval?: PendingApproval
}

interface CommunicationResult {
  ok?: boolean
  result?: unknown
  output?: unknown
  error?: string
  externalId?: string
  [key: string]: unknown
}

const COMMUNICATION_DIR = join(paths.state, 'communications')
const COMMUNICATION_DEADLINE_MS = 45_000
const MAX_COMMUNICATION_OUTPUT_LENGTH = 200_000
const APPROVAL_TTL_MS = 5 * 60_000
const MAX_BODY_LENGTH = 100_000
const MAX_RECIPIENT_LENGTH = 2_000
const MAX_LIST_LENGTH = 50

export const communicationTool: Tool = {
  name: 'communication',
  description:
    'Manage real-world communication as a durable draft-first workflow. Draft and inspect email, messages, calendar invitations, Slack updates, SMS, or custom communications; verify recipients and content; request exact approval immediately before sending; then use a configured communication connector or trusted bridge and record a delivery receipt. Never claim delivery without a connector response or verification result.',
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['status', 'draft', 'inspect', 'list', 'send', 'verify', 'cancel'], description: 'Communication workflow action' },
      draftId: { type: 'string', description: 'Durable draft id for inspect, send, verify, or cancel' },
      channel: { type: 'string', enum: ['email', 'message', 'calendar', 'slack', 'sms', 'custom'] },
      recipient: { type: 'string', description: 'Exact destination or recipient; draft only, never infer an address' },
      cc: { type: 'array', items: { type: 'string' }, description: 'Optional carbon-copy recipients' },
      bcc: { type: 'array', items: { type: 'string' }, description: 'Optional blind-copy recipients' },
      subject: { type: 'string', description: 'Subject or short title' },
      body: { type: 'string', description: 'Message body or calendar description' },
      attachments: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative or connector-supported attachment references' },
      replyTo: { type: 'string', description: 'Optional thread or message reference to reply to' },
      scheduledFor: { type: 'string', description: 'Optional ISO-8601 delivery time; the connector must support scheduling' },
      confirmationToken: { type: 'string', description: 'Exact token returned by a previous send request for the unchanged draft' },
    },
    required: ['action'],
  },
  async execute(input) {
    const request = validateCommunicationRequest(input)
    if (request.action === 'status') return communicationStatus()
    if (request.action === 'draft') return createDraft(request)
    if (request.action === 'list') return listDrafts()

    const draft = loadDraft(request.draftId)
    if (!draft) throw new Error(`communication draft not found: ${request.draftId ?? '(missing draftId)'}`)

    if (request.action === 'inspect') return renderDraft(draft)
    if (request.action === 'cancel') return cancelDraft(draft)
    if (request.action === 'send') return sendDraft(draft, request.confirmationToken)
    return verifyDraft(draft)
  },
}

export function validateCommunicationRequest(input: Record<string, unknown>): CommunicationRequest {
  const action = input.action
  if (typeof action !== 'string' || !['status', 'draft', 'inspect', 'list', 'send', 'verify', 'cancel'].includes(action)) {
    throw new Error('action must be one of status, draft, inspect, list, send, verify, or cancel')
  }

  const request: CommunicationRequest = { action: action as CommunicationAction }
  if (input.draftId !== undefined) {
    if (typeof input.draftId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(input.draftId)) throw new Error('draftId must be a durable communication draft id')
    request.draftId = input.draftId
  }
  if (input.channel !== undefined) {
    if (!['email', 'message', 'calendar', 'slack', 'sms', 'custom'].includes(String(input.channel))) throw new Error('channel must be email, message, calendar, slack, sms, or custom')
    request.channel = input.channel as CommunicationChannel
  }
  for (const key of ['recipient', 'subject', 'body', 'replyTo', 'scheduledFor', 'confirmationToken'] as const) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== 'string' || input[key].length === 0) throw new Error(`${key} must be a non-empty string`)
      request[key] = input[key]
    }
  }
  if (request.recipient && request.recipient.length > MAX_RECIPIENT_LENGTH) throw new Error(`recipient exceeds ${MAX_RECIPIENT_LENGTH} characters`)
  if (request.body && request.body.length > MAX_BODY_LENGTH) throw new Error(`body exceeds ${MAX_BODY_LENGTH} characters`)
  for (const key of ['cc', 'bcc', 'attachments'] as const) {
    if (input[key] !== undefined) {
      if (!Array.isArray(input[key]) || input[key].length > MAX_LIST_LENGTH || input[key].some((item) => typeof item !== 'string' || item.length === 0)) throw new Error(`${key} must be an array of at most ${MAX_LIST_LENGTH} non-empty strings`)
      request[key] = [...input[key]] as string[]
    }
  }
  if (action === 'draft' && (!request.channel || !request.recipient || !request.body)) throw new Error('draft requires channel, recipient, and body')
  if (['inspect', 'send', 'verify', 'cancel'].includes(action) && !request.draftId) throw new Error(`${action} requires draftId`)
  return request
}

function communicationStatus(): string {
  const bridge = Boolean(process.env.ELIA_COMMUNICATION_BRIDGE_COMMAND?.trim())
  const mcp = Boolean(process.env.ELIA_COMMUNICATION_MCP_SERVER?.trim())
  return JSON.stringify({
    draftStorage: COMMUNICATION_DIR,
    drafting: 'available locally',
    sending: bridge || mcp ? 'adapter configured' : 'not configured',
    deliveryVerification: bridge || mcp ? 'adapter configured' : 'not configured',
    adapter: bridge ? 'trusted bridge' : mcp ? 'MCP server' : 'none',
    supportedChannels: ['email', 'message', 'calendar', 'slack', 'sms', 'custom'],
    approval: 'exact five-minute token required before send',
  }, null, 2)
}

function createDraft(request: CommunicationRequest): string {
  const now = new Date().toISOString()
  const draft: CommunicationDraft = {
    id: `comm_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`,
    channel: request.channel!,
    recipient: request.recipient!,
    cc: request.cc ?? [],
    bcc: request.bcc ?? [],
    ...(request.subject ? { subject: request.subject } : {}),
    body: request.body!,
    attachments: request.attachments ?? [],
    ...(request.replyTo ? { replyTo: request.replyTo } : {}),
    ...(request.scheduledFor ? { scheduledFor: request.scheduledFor } : {}),
    status: 'draft',
    createdAt: now,
    updatedAt: now,
  }
  saveDraft(draft)
  return `Draft ${draft.id} created for ${draft.channel} to ${draft.recipient}. It is not scheduled or sent. Use communication inspect with draftId=${draft.id} before requesting send approval.`
}

function listDrafts(): string {
  ensureDirectory()
  const drafts = readdirSync(COMMUNICATION_DIR).filter((file) => file.endsWith('.json')).flatMap((file) => {
    try {
      return [JSON.parse(readFileSync(join(COMMUNICATION_DIR, file), 'utf8')) as CommunicationDraft]
    } catch {
      return []
    }
  })
  if (drafts.length === 0) return 'No communication drafts exist.'
  return drafts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((draft) => `${draft.id} · ${draft.status} · ${draft.channel} · ${draft.recipient} · ${draft.updatedAt}`).join('\n')
}

function renderDraft(draft: CommunicationDraft): string {
  return JSON.stringify({
    id: draft.id,
    channel: draft.channel,
    recipient: draft.recipient,
    cc: draft.cc,
    bcc: draft.bcc,
    subject: draft.subject,
    body: draft.body,
    attachments: draft.attachments,
    replyTo: draft.replyTo,
    scheduledFor: draft.scheduledFor,
    status: draft.status,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
    sentAt: draft.sentAt,
    verifiedAt: draft.verifiedAt,
    externalId: draft.externalId,
    error: draft.error,
  }, null, 2)
}

async function sendDraft(draft: CommunicationDraft, confirmationToken?: string): Promise<string> {
  if (draft.status === 'sent' || draft.status === 'verified') return `Draft ${draft.id} was already sent${draft.externalId ? ` with external id ${draft.externalId}` : ''}. Verify it again if delivery evidence is needed.`
  if (draft.status === 'cancelled') return `Draft ${draft.id} is cancelled and cannot be sent.`
  if (!hasCommunicationAdapter()) return `Cannot send draft ${draft.id}: no communication connector is configured. Configure ELIA_COMMUNICATION_BRIDGE_COMMAND or ELIA_COMMUNICATION_MCP_SERVER, then inspect the unchanged draft again.`

  const fingerprint = draftFingerprint(draft)
  const approvalValid = Boolean(confirmationToken && draft.pendingApproval && draft.pendingApproval.expiresAt > Date.now() && draft.pendingApproval.token === confirmationToken && draft.pendingApproval.fingerprint === fingerprint)
  if (!approvalValid) {
    if (!draft.pendingApproval || draft.pendingApproval.expiresAt <= Date.now() || draft.pendingApproval.fingerprint !== fingerprint) {
      draft.pendingApproval = { token: `communication_approval_${crypto.randomUUID()}`, fingerprint, expiresAt: Date.now() + APPROVAL_TTL_MS }
    }
    draft.status = 'awaiting_approval'
    draft.updatedAt = new Date().toISOString()
    saveDraft(draft)
    return `Approval required before sending draft ${draft.id}. Verify recipient, channel, subject, body, attachments, and timing, then retry the unchanged draft with confirmationToken=${draft.pendingApproval.token}. The token expires in five minutes and is invalid if the draft changes.`
  }

  draft.status = 'sending'
  draft.updatedAt = new Date().toISOString()
  draft.pendingApproval = undefined
  saveDraft(draft)
  try {
    const result = await callCommunicationAdapter({ action: 'send', draft })
    const externalId = typeof result.externalId === 'string' ? result.externalId : extractExternalId(result)
    draft.status = 'sent'
    draft.sentAt = new Date().toISOString()
    draft.updatedAt = draft.sentAt
    if (externalId) draft.externalId = externalId
    saveDraft(draft)
    return `Draft ${draft.id} sent through ${draft.channel}. The connector accepted the request${externalId ? ` with external id ${externalId}` : ''}. Run communication verify with draftId=${draft.id} for delivery evidence.`
  } catch (error) {
    draft.status = 'send_failed'
    draft.error = error instanceof Error ? error.message.slice(0, 2000) : String(error).slice(0, 2000)
    draft.updatedAt = new Date().toISOString()
    saveDraft(draft)
    return `Draft ${draft.id} was not confirmed as sent: ${draft.error}. Do not blindly retry; inspect the connector or verify the external system first.`
  }
}

async function verifyDraft(draft: CommunicationDraft): Promise<string> {
  if (!draft.externalId && draft.status !== 'sent' && draft.status !== 'verified') return `Draft ${draft.id} has no send receipt to verify; current status is ${draft.status}.`
  try {
    const result = await callCommunicationAdapter({ action: 'verify', draft })
    draft.status = 'verified'
    draft.verifiedAt = new Date().toISOString()
    draft.updatedAt = draft.verifiedAt
    saveDraft(draft)
    return `Delivery verification succeeded for draft ${draft.id}: ${JSON.stringify(result.result ?? result.output ?? result)}`
  } catch (error) {
    return `Delivery verification did not succeed for draft ${draft.id}: ${error instanceof Error ? error.message : String(error)}. The send receipt remains preserved.`
  }
}

function cancelDraft(draft: CommunicationDraft): string {
  if (draft.status === 'sent' || draft.status === 'verified') return `Draft ${draft.id} was already sent and cannot be cancelled by Elia.`
  draft.status = 'cancelled'
  draft.pendingApproval = undefined
  draft.updatedAt = new Date().toISOString()
  saveDraft(draft)
  return `Draft ${draft.id} cancelled. No external action was attempted.`
}

function loadDraft(id: string | undefined): CommunicationDraft | undefined {
  if (!id) return undefined
  const path = join(COMMUNICATION_DIR, `${id}.json`)
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as CommunicationDraft
  } catch {
    return undefined
  }
}

function saveDraft(draft: CommunicationDraft): void {
  ensureDirectory()
  const path = join(COMMUNICATION_DIR, `${draft.id}.json`)
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temp, JSON.stringify(draft, null, 2))
  renameSync(temp, path)
}

function ensureDirectory(): void {
  mkdirSync(COMMUNICATION_DIR, { recursive: true })
}

function draftFingerprint(draft: CommunicationDraft): string {
  return JSON.stringify({ id: draft.id, channel: draft.channel, recipient: draft.recipient, cc: draft.cc, bcc: draft.bcc, subject: draft.subject, body: draft.body, attachments: draft.attachments, replyTo: draft.replyTo, scheduledFor: draft.scheduledFor })
}

function hasCommunicationAdapter(): boolean {
  return Boolean(process.env.ELIA_COMMUNICATION_BRIDGE_COMMAND?.trim() || process.env.ELIA_COMMUNICATION_MCP_SERVER?.trim())
}

async function callCommunicationAdapter(payload: { action: 'send' | 'verify'; draft: CommunicationDraft }): Promise<CommunicationResult> {
  const command = process.env.ELIA_COMMUNICATION_BRIDGE_COMMAND?.trim()
  if (command) return callProcessAdapter(command, payload)
  const server = process.env.ELIA_COMMUNICATION_MCP_SERVER?.trim()
  if (server) {
    const toolName = process.env[`ELIA_COMMUNICATION_${payload.action.toUpperCase()}_TOOL`] ?? `communication_${payload.action}`
    return callMcpAdapter(server, toolName, payload)
  }
  throw new Error('no communication adapter is configured')
}

async function callMcpAdapter(server: string, toolName: string, payload: unknown): Promise<CommunicationResult> {
  const proc = Bun.spawn(['manus-mcp-cli', '-s', server, 'tool', 'call', toolName, '-i', JSON.stringify(payload)], { stdout: 'pipe', stderr: 'pipe', detached: true })
  return collectAdapterProcess(proc)
}

async function callProcessAdapter(command: string, payload: unknown): Promise<CommunicationResult> {
  const shellArgs = process.platform === 'win32' ? ['cmd', '/c', command] : ['sh', '-c', command]
  const proc = Bun.spawn(shellArgs, { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', ...(process.platform === 'win32' ? {} : { detached: true }) })
  proc.stdin.write(`${JSON.stringify(payload)}\n`)
  proc.stdin.end()
  return collectAdapterProcess(proc)
}

async function collectAdapterProcess(proc: Bun.Subprocess): Promise<CommunicationResult> {
  const timer = setTimeout(() => terminateProcessGroup(proc), COMMUNICATION_DEADLINE_MS)
  let completed = false
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readBoundedOutput(proc.stdout as ReadableStream<Uint8Array>, MAX_COMMUNICATION_OUTPUT_LENGTH),
      readBoundedOutput(proc.stderr as ReadableStream<Uint8Array>, MAX_COMMUNICATION_OUTPUT_LENGTH),
      proc.exited,
    ])
    if (exitCode !== 0) throw new Error(`communication adapter exited with code ${exitCode}${stderr.trim() ? `: ${stderr.trim()}` : ''}`)
    const raw = stdout.trim()
    if (!raw) return { ok: true, result: 'adapter returned no response' }
    const lastLine = raw.split('\n').at(-1) ?? raw
    try {
      const result = JSON.parse(lastLine) as CommunicationResult
      if (result.ok === false || result.error) throw new Error(result.error ?? 'communication adapter reported failure')
      completed = true
      return result
    } catch (error) {
      if (error instanceof Error && error.message !== 'Unexpected end of JSON input' && !error.message.startsWith('Unexpected token')) throw error
      completed = true
      return { ok: true, result: raw }
    }
  } finally {
    clearTimeout(timer)
    if (!completed) terminateProcessGroup(proc)
  }
}

function extractExternalId(result: CommunicationResult): string | undefined {
  const payload = (result.result ?? result.output ?? result) as Record<string, unknown>
  for (const key of ['externalId', 'messageId', 'id', 'eventId']) {
    if (typeof payload[key] === 'string') return payload[key]
  }
  return undefined
}

