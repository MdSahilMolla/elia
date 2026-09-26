import { redactSecrets } from '../../ui/redact.ts'
import type { McpProgressStatus, McpRunStatus } from '../serverTypes.ts'

export const PROGRESS_EVENT_TYPES = [
  'step_started',
  'step_completed',
  'approval_needed',
  'verification_result',
  'review_finding',
  'run_completed',
] as const

export type ProgressEventType = (typeof PROGRESS_EVENT_TYPES)[number]

export type StepOutcome = 'completed' | 'failed'
export type RunOutcome = 'completed' | 'failed' | 'cancelled'
export type ApprovalKind = 'plan' | 'action' | 'resume'
export type FindingSeverity = 'blocker' | 'major' | 'minor'

export interface StepStartedEvent {
  type: 'step_started'
  runId: string
  sessionId?: string
  at: number
  seq: number
  status: Extract<McpProgressStatus, 'starting'>
  stepId: string
  index: number
  total?: number
  title: string
  tool?: string
  message?: string
}

export interface StepCompletedEvent {
  type: 'step_completed'
  runId: string
  sessionId?: string
  at: number
  seq: number
  status: Extract<McpProgressStatus, 'completed' | 'failed'>
  stepId: string
  index: number
  total?: number
  title?: string
  ok: boolean
  durationMs?: number
  summary?: string
  error?: string
}

export interface ApprovalNeededEvent {
  type: 'approval_needed'
  runId: string
  sessionId?: string
  at: number
  seq: number
  status: Extract<McpProgressStatus, 'progress'>
  approvalId: string
  kind: ApprovalKind
  subject: string
  intent?: string
  request?: Readonly<Record<string, unknown>>
  awaitingApproval: true
  message?: string
}

export interface VerificationResultEvent {
  type: 'verification_result'
  runId: string
  sessionId?: string
  at: number
  seq: number
  status: Extract<McpProgressStatus, 'completed' | 'failed'>
  passed: boolean
  commands: readonly string[]
  blocked?: string
  unverified?: string
  durationMs?: number
  message?: string
}

export interface ReviewFindingEvent {
  type: 'review_finding'
  runId: string
  sessionId?: string
  at: number
  seq: number
  status: Extract<McpProgressStatus, 'progress'>
  severity: FindingSeverity
  detail: string
  file?: string
  line?: number
  verdict?: 'approve' | 'revise'
  message?: string
}

export interface RunCompletedEvent {
  type: 'run_completed'
  runId: string
  sessionId?: string
  at: number
  seq: number
  status: Extract<McpProgressStatus, 'completed' | 'failed' | 'cancelled'>
  ok: boolean
  outcome?: string
  error?: string
  costUsd?: number
  durationMs?: number
  result?: unknown
  message?: string
}

export type ProgressEvent =
  | StepStartedEvent
  | StepCompletedEvent
  | ApprovalNeededEvent
  | VerificationResultEvent
  | ReviewFindingEvent
  | RunCompletedEvent

export interface StepStatus {
  stepId: string
  index: number
  total?: number
  title: string
  status: 'running' | StepOutcome
  startedAt: number
  completedAt?: number
  durationMs?: number
  error?: string
}

export interface PendingApproval {
  approvalId: string
  kind: ApprovalKind
  subject: string
  intent?: string
  requestedAt: number
}

export interface VerificationRecord {
  passed: boolean
  at: number
  commands: readonly string[]
  blocked?: string
  unverified?: string
}

export interface FindingRecord {
  severity: FindingSeverity
  detail: string
  file?: string
  at: number
}

export interface RunStatusSnapshot {
  runId: string
  status: McpRunStatus
  startedAt: number
  updatedAt: number
  completedAt?: number
  sessionId?: string
  lastSeq: number
  eventCount: number
  eventCounts: Readonly<Record<ProgressEventType, number>>
  currentStep?: StepStatus
  steps: readonly StepStatus[]
  pendingApproval?: PendingApproval
  lastVerification?: VerificationRecord
  verificationPassed?: boolean
  lastFinding?: FindingRecord
  findingCounts: Readonly<Record<FindingSeverity, number>>
  outcome?: string
  error?: string
  costUsd?: number
  truncated: boolean
}

export interface ProgressSequenceOptions {
  readonly runId: string
  readonly sessionId?: string
  readonly startedAt?: number
  readonly now?: () => number
  readonly onEvent?: (event: ProgressEvent) => void
  readonly maxEvents?: number
}

export interface ProgressSequence {
  readonly runId: string
  readonly sessionId: string | undefined
  readonly events: readonly ProgressEvent[]
  readonly truncated: boolean
  stepStarted(input: StepStartedInput): StepStartedEvent
  stepCompleted(input: StepCompletedInput): StepCompletedEvent
  approvalNeeded(input: ApprovalNeededInput): ApprovalNeededEvent
  verificationResult(input: VerificationResultInput): VerificationResultEvent
  reviewFinding(input: ReviewFindingInput): ReviewFindingEvent
  runCompleted(input: RunCompletedInput): RunCompletedEvent
  since(seq: number): readonly ProgressEvent[]
  status(): RunStatusSnapshot
  frames(since?: number): string[]
  jsonLines(since?: number): string[]
}

export interface StepStartedInput {
  stepId: string
  index: number
  title: string
  total?: number
  tool?: string
  message?: string
  at?: number
  sessionId?: string
}

export interface StepCompletedInput {
  stepId: string
  index: number
  title?: string
  total?: number
  ok: boolean
  durationMs?: number
  summary?: string
  error?: string
  at?: number
  sessionId?: string
}

export interface ApprovalNeededInput {
  approvalId: string
  kind: ApprovalKind
  subject: string
  intent?: string
  request?: Readonly<Record<string, unknown>>
  message?: string
  at?: number
  sessionId?: string
}

export interface VerificationResultInput {
  passed: boolean
  commands: readonly string[]
  blocked?: string
  unverified?: string
  durationMs?: number
  message?: string
  at?: number
  sessionId?: string
}

export interface ReviewFindingInput {
  severity: FindingSeverity
  detail: string
  file?: string
  line?: number
  verdict?: 'approve' | 'revise'
  message?: string
  at?: number
  sessionId?: string
}

export interface RunCompletedInput {
  ok: boolean
  status?: RunOutcome
  outcome?: string
  error?: string
  costUsd?: number
  durationMs?: number
  result?: unknown
  message?: string
  at?: number
  sessionId?: string
}

export interface ProgressRegistry {
  sequence(options: ProgressSequenceOptions): ProgressSequence
  get(runId: string): ProgressSequence | undefined
  status(runId: string): RunStatusSnapshot | undefined
  delete(runId: string): boolean
  size(): number
  clear(): void
}

export const DEFAULT_MAX_EVENTS = 1_000
export const DEFAULT_MAX_EVENT_CHARS = 32_000
export const DEFAULT_MAX_TRACKED_STEPS = 200
export const DEFAULT_MAX_TRACKED_FINDINGS = 200

function zeroEventCounts(): Record<ProgressEventType, number> {
  return {
    step_started: 0,
    step_completed: 0,
    approval_needed: 0,
    verification_result: 0,
    review_finding: 0,
    run_completed: 0,
  }
}

function zeroFindingCounts(): Record<FindingSeverity, number> {
  return { blocker: 0, major: 0, minor: 0 }
}

export function serializeProgressEvent(event: ProgressEvent, maxChars = DEFAULT_MAX_EVENT_CHARS): string {
  const seen = new WeakSet<object>()
  const replacer = (_key: string, value: unknown): unknown => {
    if (typeof value === 'string') return redactSecrets(value)
    if (typeof value === 'bigint') return value.toString(10)
    if (typeof value === 'number') return Number.isFinite(value) ? value : null
    if (typeof value === 'function' || typeof value === 'symbol') return undefined
    if (value instanceof Error) return { name: value.name, message: redactSecrets(value.message) }
    if (value instanceof Map) return [...value.entries()]
    if (value instanceof Set) return [...value.values()]
    if (value instanceof Date) return value.toISOString()
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return '[circular]'
      seen.add(value)
    }
    return value
  }
  try {
    const json = JSON.stringify(event, replacer) ?? 'null'
    return json.length <= maxChars ? json : `${json.slice(0, maxChars - 24)}…{"truncated":true}`
  } catch {
    try {
      return JSON.stringify({ type: event.type, runId: event.runId, seq: event.seq, at: event.at, serializationError: true })
    } catch {
      return '{"type":"unknown","serializationError":true}'
    }
  }
}

export function progressEventFrame(event: ProgressEvent, maxChars = DEFAULT_MAX_EVENT_CHARS): string {
  return `id: ${event.seq}\nevent: ${event.type}\ndata: ${serializeProgressEvent(event, maxChars)}\n\n`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function runStatusPayload(snapshot: RunStatusSnapshot): Record<string, unknown> {
  return {
    runId: snapshot.runId,
    status: snapshot.status,
    startedAt: snapshot.startedAt,
    updatedAt: snapshot.updatedAt,
    completedAt: snapshot.completedAt,
    sessionId: snapshot.sessionId,
    lastSeq: snapshot.lastSeq,
    eventCount: snapshot.eventCount,
    eventCounts: { ...snapshot.eventCounts },
    currentStep: snapshot.currentStep ? { ...snapshot.currentStep } : undefined,
    steps: snapshot.steps.map((step) => ({ ...step })),
    pendingApproval: snapshot.pendingApproval ? { ...snapshot.pendingApproval } : undefined,
    lastVerification: snapshot.lastVerification ? { ...snapshot.lastVerification } : undefined,
    verificationPassed: snapshot.verificationPassed,
    lastFinding: snapshot.lastFinding ? { ...snapshot.lastFinding } : undefined,
    findingCounts: { ...snapshot.findingCounts },
    outcome: snapshot.outcome,
    error: snapshot.error,
    costUsd: snapshot.costUsd,
    truncated: snapshot.truncated,
  }
}

function emptyStatus(runId: string, startedAt: number): RunStatusSnapshot {
  return {
    runId,
    status: 'queued',
    startedAt,
    updatedAt: startedAt,
    lastSeq: 0,
    eventCount: 0,
    eventCounts: zeroEventCounts(),
    steps: [],
    findingCounts: zeroFindingCounts(),
    truncated: false,
  }
}

export function projectRunStatus(
  runId: string,
  events: readonly ProgressEvent[],
  options: { startedAt: number; truncated: boolean },
): RunStatusSnapshot {
  const snapshot = emptyStatus(runId, options.startedAt)
  const eventCounts = zeroEventCounts()
  const findingCounts = zeroFindingCounts()
  const stepById = new Map<string, StepStatus>()
  const steps: StepStatus[] = []
  const findings: FindingRecord[] = []
  let currentStep: StepStatus | undefined
  let pendingApproval: PendingApproval | undefined
  let lastVerification: VerificationRecord | undefined
  let latestFinding: FindingRecord | undefined
  let status: McpRunStatus = events.length > 0 ? 'running' : 'queued'

  for (const event of events) {
    eventCounts[event.type] += 1
    snapshot.eventCount += 1
    snapshot.lastSeq = event.seq
    snapshot.updatedAt = event.at
    if (event.sessionId) snapshot.sessionId = event.sessionId

    switch (event.type) {
      case 'step_started': {
        const step: StepStatus = {
          stepId: event.stepId,
          index: event.index,
          total: event.total,
          title: event.title,
          status: 'running',
          startedAt: event.at,
        }
        stepById.set(event.stepId, step)
        steps.push(step)
        currentStep = step
        status = 'running'
        pendingApproval = undefined
        break
      }
      case 'step_completed': {
        const existing = stepById.get(event.stepId)
        const step: StepStatus = existing
          ? { ...existing, title: event.title ?? existing.title, total: event.total ?? existing.total, status: event.ok ? 'completed' : 'failed', completedAt: event.at, durationMs: event.durationMs, error: event.error }
          : {
              stepId: event.stepId,
              index: event.index,
              total: event.total,
              title: event.title ?? event.stepId,
              status: event.ok ? 'completed' : 'failed',
              startedAt: event.at,
              completedAt: event.at,
              durationMs: event.durationMs,
              error: event.error,
            }
        const position = existing ? steps.indexOf(existing) : -1
        if (position >= 0) steps[position] = step
        else {
          stepById.set(event.stepId, step)
          steps.push(step)
        }
        currentStep = undefined
        status = 'running'
        pendingApproval = undefined
        break
      }
      case 'approval_needed': {
        pendingApproval = {
          approvalId: event.approvalId,
          kind: event.kind,
          subject: event.subject,
          intent: event.intent,
          requestedAt: event.at,
        }
        status = 'waiting'
        break
      }
      case 'verification_result': {
        lastVerification = {
          passed: event.passed,
          at: event.at,
          commands: [...event.commands],
          blocked: event.blocked,
          unverified: event.unverified,
        }
        break
      }
      case 'review_finding': {
        const finding: FindingRecord = { severity: event.severity, detail: event.detail, file: event.file, at: event.at }
        findings.push(finding)
        latestFinding = finding
        findingCounts[event.severity] += 1
        break
      }
      case 'run_completed': {
        status = event.status
        currentStep = undefined
        pendingApproval = undefined
        snapshot.completedAt = event.at
        snapshot.outcome = event.outcome
        snapshot.error = event.error
        snapshot.costUsd = event.costUsd ?? snapshot.costUsd
        break
      }
    }
  }

  const boundedSteps = steps.length > DEFAULT_MAX_TRACKED_STEPS ? steps.slice(-DEFAULT_MAX_TRACKED_STEPS) : steps
  const latest = findings.length > DEFAULT_MAX_TRACKED_FINDINGS ? findings[findings.length - 1] : latestFinding

  return {
    ...snapshot,
    status,
    currentStep,
    steps: boundedSteps,
    pendingApproval,
    lastVerification,
    verificationPassed: lastVerification?.passed,
    lastFinding: latest,
    eventCounts,
    findingCounts,
    truncated: options.truncated,
  }
}

export function createProgressSequence(options: ProgressSequenceOptions): ProgressSequence {
  const clock = options.now ?? Date.now
  const startedAt = options.startedAt ?? clock()
  const maxEvents = Math.max(1, options.maxEvents ?? DEFAULT_MAX_EVENTS)
  const log: ProgressEvent[] = []
  let seq = 0
  let dropped = 0
  let finished = false

  const append = <T extends ProgressEvent>(event: T): T => {
    if (finished) throw new Error(`run ${options.runId} is already complete; refusing to append ${event.type}`)
    if (log.length >= maxEvents) {
      log.shift()
      dropped += 1
    }
    log.push(event)
    options.onEvent?.(event)
    return event
  }

  const base = (type: ProgressEventType, at: number | undefined, sessionId: string | undefined): { type: ProgressEventType; runId: string; sessionId?: string; at: number; seq: number } => {
    seq += 1
    const stamped: { type: ProgressEventType; runId: string; sessionId?: string; at: number; seq: number } = {
      type,
      runId: options.runId,
      at: at ?? clock(),
      seq,
    }
    const session = sessionId ?? options.sessionId
    if (session) stamped.sessionId = session
    return stamped
  }

  const sequence: ProgressSequence = {
    runId: options.runId,
    sessionId: options.sessionId,
    get events(): readonly ProgressEvent[] {
      return log
    },
    get truncated(): boolean {
      return dropped > 0
    },
    stepStarted(input) {
      const stamped = base('step_started', input.at, input.sessionId)
      const event: StepStartedEvent = { ...stamped, type: 'step_started', status: 'starting', stepId: input.stepId, index: input.index, title: input.title }
      if (input.total !== undefined) event.total = input.total
      if (input.tool !== undefined) event.tool = input.tool
      if (input.message !== undefined) event.message = input.message
      return append(event)
    },
    stepCompleted(input) {
      const stamped = base('step_completed', input.at, input.sessionId)
      const event: StepCompletedEvent = {
        ...stamped,
        type: 'step_completed',
        status: input.ok ? 'completed' : 'failed',
        stepId: input.stepId,
        index: input.index,
        ok: input.ok,
      }
      if (input.total !== undefined) event.total = input.total
      if (input.title !== undefined) event.title = input.title
      if (input.durationMs !== undefined) event.durationMs = input.durationMs
      if (input.summary !== undefined) event.summary = input.summary
      if (input.error !== undefined) event.error = input.error
      return append(event)
    },
    approvalNeeded(input) {
      const stamped = base('approval_needed', input.at, input.sessionId)
      const event: ApprovalNeededEvent = {
        ...stamped,
        type: 'approval_needed',
        status: 'progress',
        approvalId: input.approvalId,
        kind: input.kind,
        subject: input.subject,
        awaitingApproval: true,
      }
      if (input.intent !== undefined) event.intent = input.intent
      if (input.request !== undefined) event.request = input.request
      if (input.message !== undefined) event.message = input.message
      return append(event)
    },
    verificationResult(input) {
      const stamped = base('verification_result', input.at, input.sessionId)
      const event: VerificationResultEvent = {
        ...stamped,
        type: 'verification_result',
        status: input.passed ? 'completed' : 'failed',
        passed: input.passed,
        commands: [...input.commands],
      }
      if (input.blocked !== undefined) event.blocked = input.blocked
      if (input.unverified !== undefined) event.unverified = input.unverified
      if (input.durationMs !== undefined) event.durationMs = input.durationMs
      if (input.message !== undefined) event.message = input.message
      return append(event)
    },
    reviewFinding(input) {
      const stamped = base('review_finding', input.at, input.sessionId)
      const event: ReviewFindingEvent = {
        ...stamped,
        type: 'review_finding',
        status: 'progress',
        severity: input.severity,
        detail: input.detail,
      }
      if (input.file !== undefined) event.file = input.file
      if (input.line !== undefined) event.line = input.line
      if (input.verdict !== undefined) event.verdict = input.verdict
      if (input.message !== undefined) event.message = input.message
      return append(event)
    },
    runCompleted(input) {
      const stamped = base('run_completed', input.at, input.sessionId)
      const status: RunOutcome = input.status ?? (input.ok ? 'completed' : 'failed')
      const event: RunCompletedEvent = { ...stamped, type: 'run_completed', status, ok: input.ok }
      if (input.outcome !== undefined) event.outcome = input.outcome
      if (input.error !== undefined) event.error = input.error
      if (input.costUsd !== undefined) event.costUsd = input.costUsd
      if (input.durationMs !== undefined) event.durationMs = input.durationMs
      if (input.result !== undefined) event.result = input.result
      if (input.message !== undefined) event.message = input.message
      const appended = append(event)
      finished = true
      return appended
    },
    since(from) {
      return from <= 0 ? [...log] : log.filter((event) => event.seq > from)
    },
    status() {
      return projectRunStatus(options.runId, log, { startedAt, truncated: dropped > 0 })
    },
    frames(from) {
      return sequence.since(from ?? 0).map((event) => progressEventFrame(event))
    },
    jsonLines(from) {
      return sequence.since(from ?? 0).map((event) => `${serializeProgressEvent(event)}\n`)
    },
  }

  return sequence
}

export function createProgressRegistry(): ProgressRegistry {
  const sequences = new Map<string, ProgressSequence>()
  return {
    sequence(options) {
      const existing = sequences.get(options.runId)
      if (existing) return existing
      const created = createProgressSequence(options)
      sequences.set(options.runId, created)
      return created
    },
    get(runId) {
      return sequences.get(runId)
    },
    status(runId) {
      return sequences.get(runId)?.status()
    },
    delete(runId) {
      return sequences.delete(runId)
    },
    size() {
      return sequences.size
    },
    clear() {
      sequences.clear()
    },
  }
}

export function progressNotification(event: ProgressEvent, options: { progressToken?: string | number; total?: number } = {}): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    runId: event.runId,
    type: event.type,
    seq: event.seq,
    at: event.at,
    status: event.status,
  }
  if (event.sessionId) payload.sessionId = event.sessionId
  if (options.progressToken !== undefined) payload.progressToken = options.progressToken
  const total = 'total' in event && typeof event.total === 'number' ? event.total : options.total
  if (total !== undefined) payload.total = total
  if ('index' in event) payload.progress = event.index
  if (event.type === 'approval_needed') payload.awaitingApproval = true
  if (event.type === 'verification_result') payload.passed = event.passed
  if (event.type === 'review_finding') payload.severity = event.severity
  if ('request' in event && isRecord(event.request)) payload.request = event.request
  return payload
}
