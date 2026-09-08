import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Proposal } from './types.ts'
import type { ActionRequest } from './governor.ts'
import type { ActionContract, ContractEvaluation } from './actionContract.ts'
import { canonicalizeCommandForIdentity } from './commandIdentity.ts'
import { ensureSecureDirectory, hardenSecureFile, writeSecureFile } from '../securePersistence.ts'

export const GOAL_GRAPH_VERSION = 2
export const EXECUTION_LEASE_TTL_MS = 120_000
const EXECUTION_OWNER = `${process.pid}:${crypto.randomUUID()}`

export type GoalNodeKind = 'goal' | 'step' | 'delegation'
export type GoalNodeStatus = 'pending' | 'ready' | 'running' | 'waiting-approval' | 'waiting-retry' | 'completed' | 'failed' | 'blocked'
export type EvidenceKind = 'approval' | 'verification' | 'review' | 'action' | 'checkpoint' | 'observation'
export type ActionState = 'planned' | 'running' | 'completed' | 'retryable' | 'blocked' | 'human-review' | 'failed'
export type FailureClass = 'retryable' | 'authorization' | 'environment' | 'human-review' | 'fatal'

export interface GoalNode {
  id: string
  kind: GoalNodeKind
  title: string
  role?: string
  instructions?: string
  files: string[]
  dependsOn: string[]
  /** Parent step or delegation node for hierarchical execution. */
  parentId?: string
  /** Zero for top-level steps; positive for delegated children. */
  depth?: number
  acceptanceCriteria?: string[]
  verificationCommands?: string[]
  sideEffects?: string[]
  status: GoalNodeStatus
  attemptCount: number
  maxAttempts: number
  idempotencyKey: string
  evidenceIds: string[]
  createdAt: number
  updatedAt: number
  startedAt?: number
  finishedAt?: number
  leaseOwner?: string
  leaseExpiresAt?: number
  lastError?: FailureRecord
}

export interface EvidenceRecord {
  id: string
  nodeId: string
  kind: EvidenceKind
  passed: boolean
  summary: string
  data: Record<string, unknown>
  at: number
}

export interface ApprovalRecord {
  id: string
  kind: 'plan' | 'action' | 'resume'
  subject: string
  status: 'pending' | 'approved' | 'denied'
  request?: Record<string, unknown>
  reason?: string
  at: number
  resolvedAt?: number
}

export interface FailureRecord {
  class: FailureClass
  message: string
  at: number
  retryAfter?: number
}

export interface DurableActionRecord {
  id: string
  nodeId: string
  idempotencyKey: string
  tool: string
  inputDigest: string
  state: ActionState
  attempts: number
  result?: string
  error?: FailureRecord
  createdAt: number
  updatedAt: number
  leaseOwner?: string
  leaseExpiresAt?: number
  contract?: ActionContract
  precondition?: ContractEvaluation
  postcondition?: ContractEvaluation
}

export interface GoalGraphSnapshot {
  version: number
  runId: string
  goal: string
  rootId: string
  verificationCommands: string[]
  proposal?: Proposal
  nodes: GoalNode[]
  actions: DurableActionRecord[]
  evidence: EvidenceRecord[]
  approvals: ApprovalRecord[]
  updatedAt: number
}

export interface ActionReservation {
  action: DurableActionRecord
  decision: 'execute' | 'replay' | 'blocked' | 'human-review'
}

export interface GoalGraphOptions {
  runId: string
  goal: string
  dir: string
}

export function readGoalGraphSnapshot(dir: string): GoalGraphSnapshot | undefined {
  const path = join(dir, 'goal-graph.json')
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as GoalGraphSnapshot
  } catch {
    return undefined
  }
}

export class GoalGraphStore {
  readonly path: string
  private snapshot: GoalGraphSnapshot
  private lastLeaseRecovery = { nodes: 0, actions: 0 }

  private constructor(private readonly options: GoalGraphOptions, snapshot: GoalGraphSnapshot) {
    this.path = join(options.dir, 'goal-graph.json')
    this.snapshot = snapshot
  }

  static open(options: GoalGraphOptions): GoalGraphStore {
    ensureSecureDirectory(options.dir)
    const path = join(options.dir, 'goal-graph.json')
    if (existsSync(path)) {
      hardenSecureFile(path)
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as GoalGraphSnapshot
        if ((parsed.version === 1 || parsed.version === GOAL_GRAPH_VERSION) && parsed.runId === options.runId) {
          const store = new GoalGraphStore(options, normalizeSnapshot(parsed, options))
          const recovery = store.reconcileStaleLeases()
          store.lastLeaseRecovery = { nodes: recovery.nodes.length, actions: recovery.actions.length }
          return store
        }
      } catch {
        // A torn graph is replaced by a fresh, valid snapshot. The journal remains authoritative.
      }
    }

    const now = Date.now()
    const rootId = 'goal:root'
    const store = new GoalGraphStore(options, {
      version: GOAL_GRAPH_VERSION,
      runId: options.runId,
      goal: options.goal,
      rootId,
      verificationCommands: [],
      proposal: undefined,
      nodes: [{
        id: rootId,
        kind: 'goal',
        title: options.goal,
        files: [],
        dependsOn: [],
        status: 'running',
        attemptCount: 1,
        maxAttempts: 1,
        idempotencyKey: stableKey(options.runId, rootId),
        evidenceIds: [],
        createdAt: now,
        updatedAt: now,
        startedAt: now,
      }],
      actions: [],
      evidence: [],
      approvals: [],
      updatedAt: now,
    })
    store.persist()
    return store
  }

  state(): GoalGraphSnapshot {
    return structuredClone(this.snapshot)
  }

  node(id: string): GoalNode | undefined {
    const node = this.snapshot.nodes.find((item) => item.id === id)
    return node ? structuredClone(node) : undefined
  }

  nodes(): GoalNode[] {
    return this.snapshot.nodes.map((node) => structuredClone(node))
  }

  seedProposal(proposal: Proposal): void {
    this.snapshot.goal = proposal.goal
    this.snapshot.proposal = structuredClone(proposal)
    this.snapshot.verificationCommands = [...proposal.verification]
    const now = Date.now()
    const existing = new Map(this.snapshot.nodes.map((node) => [node.id, node]))
    const root = existing.get(this.snapshot.rootId)
    if (root) {
      root.title = proposal.goal
      root.updatedAt = now
    }

    for (const step of proposal.steps) {
      const id = `step:${step.id}`
      const node = existing.get(id) ?? {
        id,
        kind: 'step' as const,
        title: step.title,
        role: step.role,
        instructions: step.instructions,
        files: [...step.files],
        dependsOn: step.dependsOn.map((dependency) => `step:${dependency}`),
        status: 'pending' as const,
        attemptCount: 0,
        maxAttempts: 2,
        idempotencyKey: stableKey(this.snapshot.runId, id),
        evidenceIds: [],
        createdAt: now,
        updatedAt: now,
      }
      node.title = step.title
      node.role = step.role
      node.instructions = step.instructions
      node.files = [...step.files]
      node.dependsOn = step.dependsOn.map((dependency) => `step:${dependency}`)
      node.updatedAt = now
      if (!existing.has(id)) {
        existing.set(id, node)
        this.snapshot.nodes.push(node)
      }
    }
    this.refreshReadyStates()
    this.persist()
  }

  readyNodes(): GoalNode[] {
    this.refreshReadyStates()
    return this.snapshot.nodes.filter((node) => node.kind === 'step' && node.status === 'ready').map((node) => structuredClone(node))
  }

  registerDelegationNode(input: {
    parentId: string
    id: string
    title: string
    role: string
    instructions: string
    files?: string[]
    dependsOn?: string[]
    depth: number
    acceptanceCriteria?: string[]
    verificationCommands?: string[]
    sideEffects?: string[]
  }): GoalNode {
    const id = `${input.parentId}/child:${input.id}`
    const existing = this.snapshot.nodes.find((node) => node.id === id)
    if (existing) return structuredClone(existing)
    const now = Date.now()
    const node: GoalNode = {
      id,
      kind: 'delegation',
      title: input.title,
      role: input.role,
      instructions: input.instructions,
      files: [...(input.files ?? [])],
      dependsOn: (input.dependsOn ?? []).map((dependency) => `${input.parentId}/child:${dependency}`),
      parentId: input.parentId,
      depth: input.depth,
      acceptanceCriteria: [...(input.acceptanceCriteria ?? [])],
      verificationCommands: [...(input.verificationCommands ?? [])],
      sideEffects: [...(input.sideEffects ?? [])],
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 2,
      idempotencyKey: stableKey(this.snapshot.runId, id),
      evidenceIds: [],
      createdAt: now,
      updatedAt: now,
    }
    this.snapshot.nodes.push(node)
    this.refreshReadyStates()
    this.persist()
    return structuredClone(node)
  }

  startNode(id: string): GoalNode {
    const node = this.requireNode(id)
    if (node.status === 'running') {
      if (node.leaseExpiresAt && node.leaseExpiresAt > Date.now()) {
        if (node.leaseOwner !== EXECUTION_OWNER) throw new Error(`goal node ${id} is already leased by another execution`)
        return structuredClone(node)
      }
      node.status = 'waiting-retry'
      node.lastError = classifyFailure('stale execution lease recovered')
      node.leaseOwner = undefined
      node.leaseExpiresAt = undefined
    }
    if (node.status === 'completed' && !this.needsResumption(id)) return structuredClone(node)
    if (node.status === 'blocked' || node.status === 'failed') {
      if (node.lastError?.class !== 'retryable' && !this.needsResumption(id)) throw new Error(`goal node ${id} requires human review before it can resume`)
    }
    if (!this.dependenciesComplete(node)) throw new Error(`goal node ${id} is not ready: dependencies are incomplete`)
    node.status = 'running'
    node.attemptCount += 1
    node.startedAt ??= Date.now()
    node.leaseOwner = EXECUTION_OWNER
    node.leaseExpiresAt = Date.now() + EXECUTION_LEASE_TTL_MS
    node.updatedAt = Date.now()
    this.persist()
    return structuredClone(node)
  }

  heartbeatNode(id: string): GoalNode {
    const node = this.requireNode(id)
    if (node.status === 'running' && node.leaseOwner === EXECUTION_OWNER) {
      node.leaseExpiresAt = Date.now() + EXECUTION_LEASE_TTL_MS
      node.updatedAt = Date.now()
      this.persist()
    }
    return structuredClone(node)
  }

  finishNode(id: string, result: { ok: boolean; report?: string; error?: unknown; evidence?: EvidenceRecord[] }): GoalNode {
    const node = this.requireNode(id)
    const now = Date.now()
    if (result.evidence) for (const evidence of result.evidence) this.addEvidence(evidence)
    node.updatedAt = now
    node.finishedAt = result.ok ? now : undefined
    node.leaseOwner = undefined
    node.leaseExpiresAt = undefined
    if (result.ok) {
      node.status = 'completed'
      node.lastError = undefined
    } else {
      // A real error classifies on its own text; falling back to the worker's
      // prose report, its wording carries no verdict (source: 'report').
      const failure = result.error
        ? classifyFailure(result.error)
        : classifyFailure(result.report ?? 'node failed', { source: 'report' })
      node.lastError = failure
      node.status = failure.class === 'retryable' && node.attemptCount < node.maxAttempts ? 'waiting-retry' : failure.class === 'authorization' || failure.class === 'human-review' ? 'blocked' : 'failed'
    }
    this.refreshReadyStates()
    this.persist()
    return structuredClone(node)
  }

  /**
   * Puts a step that just failed back in line for one more attempt.
   *
   * A failed step blocks every step that depends on it, so a single failure
   * near the root of a plan voids the whole thing — the run then reaches
   * verification with none of its planned work done. Most first failures are
   * recoverable once the worker can see what went wrong, so the wave executor
   * reopens them here rather than reaching into node state itself. Returns
   * false when the node has no attempts left, has already completed, or is
   * still running, so the caller can fall through to the ordinary cascade.
   */
  reopenNode(id: string, reason: string): boolean {
    const node = this.requireNode(id)
    if (node.status === 'completed' || node.status === 'running') return false
    if (node.attemptCount >= node.maxAttempts) return false
    if (!this.dependenciesComplete(node)) return false
    node.status = 'waiting-retry'
    node.lastError = { ...classifyFailure(reason), class: 'retryable' }
    node.finishedAt = undefined
    node.updatedAt = Date.now()
    this.refreshReadyStates()
    this.persist()
    return true
  }

  failRun(error: unknown): void {
    const root = this.requireNode(this.snapshot.rootId)
    root.status = 'failed'
    root.lastError = classifyFailure(error)
    root.updatedAt = Date.now()
    this.persist()
  }

  requestApproval(kind: ApprovalRecord['kind'], subject: string, request?: Record<string, unknown>, reason?: string): ApprovalRecord {
    const existing = this.snapshot.approvals.find((approval) => approval.kind === kind && approval.subject === subject)
    if (existing) {
      if (kind === 'plan' && existing.status === 'denied') {
        existing.status = 'pending'
        existing.at = Date.now()
        existing.resolvedAt = undefined
        existing.reason = reason
        existing.request = request
        this.persist()
      }
      return structuredClone(existing)
    }
    const record: ApprovalRecord = {
      id: `approval:${kind}:${stableKey(this.snapshot.runId, subject).slice(0, 16)}`,
      kind,
      subject,
      status: 'pending',
      request,
      reason,
      at: Date.now(),
    }
    this.snapshot.approvals.push(record)
    const root = this.requireNode(this.snapshot.rootId)
    root.status = 'waiting-approval'
    root.updatedAt = Date.now()
    this.persist()
    return structuredClone(record)
  }

  resolveApproval(id: string, approved: boolean, reason?: string): ApprovalRecord {
    const record = this.snapshot.approvals.find((approval) => approval.id === id)
    if (!record) throw new Error(`unknown durable approval ${id}`)
    record.status = approved ? 'approved' : 'denied'
    record.reason = reason ?? record.reason
    record.resolvedAt = Date.now()
    if (record.kind === 'action') {
      const action = this.snapshot.actions.find((item) => item.idempotencyKey === record.subject)
      if (action) {
        action.state = approved ? 'planned' : 'blocked'
        action.error = approved ? undefined : classifyFailure(reason ?? 'action approval denied')
        action.updatedAt = Date.now()
      }
    }
    const root = this.requireNode(this.snapshot.rootId)
    root.status = approved ? 'running' : 'blocked'
    root.updatedAt = Date.now()
    if (approved) this.addEvidence({
      id: `evidence:${record.id}`,
      nodeId: this.snapshot.rootId,
      kind: 'approval',
      passed: true,
      summary: `${record.kind} approval granted for ${record.subject}`,
      data: { approvalId: record.id },
      at: Date.now(),
    })
    this.persist()
    return structuredClone(record)
  }

  needsResumption(nodeId: string): boolean {
    return this.snapshot.actions.some((action) => action.nodeId === nodeId && ['planned', 'running', 'retryable', 'blocked', 'human-review'].includes(action.state))
  }

  pendingApprovals(): ApprovalRecord[] {
    return this.snapshot.approvals.filter((approval) => approval.status === 'pending').map((approval) => structuredClone(approval))
  }

  isActionApproved(request: ActionRequest, nodeId = this.snapshot.rootId): boolean {
    const subject = actionKey(this.snapshot.runId, nodeId, request)
    return this.snapshot.approvals.some((approval) => approval.kind === 'action' && approval.subject === subject && approval.status === 'approved')
  }

  addEvidence(evidence: EvidenceRecord): EvidenceRecord {
    const existing = this.snapshot.evidence.find((item) => item.id === evidence.id)
    if (existing) return structuredClone(existing)
    this.snapshot.evidence.push({ ...evidence, data: structuredClone(evidence.data) })
    const node = this.snapshot.nodes.find((item) => item.id === evidence.nodeId)
    if (node && !node.evidenceIds.includes(evidence.id)) node.evidenceIds.push(evidence.id)
    this.snapshot.updatedAt = Date.now()
    this.persist()
    return structuredClone(evidence)
  }

  recordVerification(passed: boolean, data: Record<string, unknown>): EvidenceRecord {
    return this.addEvidence({
      id: `evidence:verification:${this.snapshot.evidence.filter((item) => item.kind === 'verification').length + 1}`,
      nodeId: this.snapshot.rootId,
      kind: 'verification',
      passed,
      summary: passed ? 'Verification commands passed' : 'Verification commands failed',
      data,
      at: Date.now(),
    })
  }

  recordReview(passed: boolean, data: Record<string, unknown>): EvidenceRecord {
    return this.addEvidence({
      id: `evidence:review:${this.snapshot.evidence.filter((item) => item.kind === 'review').length + 1}`,
      nodeId: this.snapshot.rootId,
      kind: 'review',
      passed,
      summary: passed ? 'Structured review passed' : 'Structured review found blocking issues',
      data,
      at: Date.now(),
    })
  }

  canCompleteGoal(): boolean {
    const workNodes = this.snapshot.nodes.filter((node) => node.kind === 'step' || node.kind === 'delegation')
    const verification = this.snapshot.evidence.some((evidence) => evidence.kind === 'verification' && evidence.passed)
    const review = this.snapshot.evidence.some((evidence) => evidence.kind === 'review' && evidence.passed)
    const approval = this.snapshot.approvals.some((item) => item.kind === 'plan' && item.status === 'approved')
    const actionsResolved = outstandingActions(this.snapshot).length === 0
    return workNodes.length > 0 && workNodes.every((node) => node.status === 'completed') && actionsResolved && verification && review && approval
  }

  completeGoal(): void {
    if (!this.canCompleteGoal()) throw new Error('goal cannot complete: missing completed nodes, approval, verification, or review evidence')
    const root = this.requireNode(this.snapshot.rootId)
    root.status = 'completed'
    root.finishedAt = Date.now()
    root.updatedAt = Date.now()
    this.persist()
  }

  reserveAction(request: ActionRequest, nodeId = this.snapshot.rootId): ActionReservation {
    const idempotencyKey = actionKey(this.snapshot.runId, nodeId, request)
    const existing = this.snapshot.actions.find((action) => action.idempotencyKey === idempotencyKey)
    if (existing) {
      if (existing.state === 'running' && existing.leaseExpiresAt && existing.leaseExpiresAt <= Date.now()) {
        existing.state = 'retryable'
        existing.error = classifyFailure('stale action execution lease recovered')
        existing.leaseOwner = undefined
        existing.leaseExpiresAt = undefined
        existing.updatedAt = Date.now()
        this.persist()
      }
      if (existing.state === 'completed') return { action: structuredClone(existing), decision: 'replay' }
      if (existing.state === 'blocked') return { action: structuredClone(existing), decision: 'blocked' }
      if (existing.state === 'human-review' || existing.state === 'running') return { action: structuredClone(existing), decision: 'human-review' }
      if (existing.state === 'retryable' || existing.state === 'planned') return { action: structuredClone(existing), decision: 'execute' }
      return { action: structuredClone(existing), decision: 'blocked' }
    }

    const action: DurableActionRecord = {
      id: `action:${idempotencyKey.slice(0, 20)}`,
      nodeId,
      idempotencyKey,
      tool: request.name,
      inputDigest: digest(request.input),
      state: 'planned',
      attempts: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    this.snapshot.actions.push(action)
    this.persist()
    return { action: structuredClone(action), decision: 'execute' }
  }

  startAction(id: string, contract?: ActionContract, precondition?: ContractEvaluation): DurableActionRecord {
    const action = this.requireAction(id)
    action.state = 'running'
    action.attempts += 1
    action.leaseOwner = EXECUTION_OWNER
    action.leaseExpiresAt = Date.now() + EXECUTION_LEASE_TTL_MS
    if (contract) action.contract = structuredClone(contract)
    if (precondition) action.precondition = structuredClone(precondition)
    action.updatedAt = Date.now()
    this.persist()
    return structuredClone(action)
  }

  heartbeatAction(id: string): DurableActionRecord {
    const action = this.requireAction(id)
    if (action.state === 'running' && action.leaseOwner === EXECUTION_OWNER) {
      action.leaseExpiresAt = Date.now() + EXECUTION_LEASE_TTL_MS
      action.updatedAt = Date.now()
      this.persist()
    }
    return structuredClone(action)
  }

  finishAction(id: string, result: { ok: boolean; result?: string; error?: unknown; postcondition?: ContractEvaluation }): DurableActionRecord {
    const action = this.requireAction(id)
    action.updatedAt = Date.now()
    action.leaseOwner = undefined
    action.leaseExpiresAt = undefined
    if (result.postcondition) action.postcondition = structuredClone(result.postcondition)
    if (result.ok) {
      action.state = 'completed'
      action.result = result.result ?? ''
      action.error = undefined
    } else {
      const failure = classifyFailure(result.error ?? result.result ?? 'action failed')
      action.state = failure.class === 'retryable' ? 'retryable' : failure.class === 'authorization' || failure.class === 'human-review' ? 'human-review' : 'failed'
      action.error = failure
    }
    this.persist()
    return structuredClone(action)
  }

  blockAction(id: string, failure: unknown, humanReview = false, precondition?: ContractEvaluation, postcondition?: ContractEvaluation, contract?: ActionContract): DurableActionRecord {
    const action = this.requireAction(id)
    const record = classifyFailure(failure)
    action.state = humanReview ? 'human-review' : 'blocked'
    action.error = record
    if (contract) action.contract = structuredClone(contract)
    if (precondition) action.precondition = structuredClone(precondition)
    if (postcondition) action.postcondition = structuredClone(postcondition)
    action.leaseOwner = undefined
    action.leaseExpiresAt = undefined
    action.updatedAt = Date.now()
    this.persist()
    return structuredClone(action)
  }

  leaseRecoverySummary(): { nodes: number; actions: number } {
    return { ...this.lastLeaseRecovery }
  }

  reconcileStaleLeases(now = Date.now()): { nodes: string[]; actions: string[] } {
    const nodes: string[] = []
    const actions: string[] = []
    for (const node of this.snapshot.nodes) {
      if (node.status === 'running' && node.leaseExpiresAt && node.leaseExpiresAt <= now) {
        node.status = node.attemptCount < node.maxAttempts ? 'waiting-retry' : 'blocked'
        node.lastError = classifyFailure('stale execution lease recovered after process interruption')
        node.leaseOwner = undefined
        node.leaseExpiresAt = undefined
        node.updatedAt = now
        nodes.push(node.id)
      }
    }
    for (const action of this.snapshot.actions) {
      if (action.state === 'running' && action.leaseExpiresAt && action.leaseExpiresAt <= now) {
        action.state = action.attempts < 2 ? 'retryable' : 'human-review'
        action.error = classifyFailure('stale action execution lease recovered after process interruption')
        action.leaseOwner = undefined
        action.leaseExpiresAt = undefined
        action.updatedAt = now
        actions.push(action.id)
      }
    }
    if (nodes.length > 0 || actions.length > 0) {
      this.refreshReadyStates()
      this.persist()
    }
    return { nodes, actions }
  }

  private requireNode(id: string): GoalNode {
    const node = this.snapshot.nodes.find((item) => item.id === id)
    if (!node) throw new Error(`unknown goal node ${id}`)
    return node
  }

  private requireAction(id: string): DurableActionRecord {
    const action = this.snapshot.actions.find((item) => item.id === id)
    if (!action) throw new Error(`unknown durable action ${id}`)
    return action
  }

  private dependenciesComplete(node: GoalNode): boolean {
    return node.dependsOn.every((dependency) => this.snapshot.nodes.find((item) => item.id === dependency)?.status === 'completed')
  }

  private refreshReadyStates(): void {
    for (const node of this.snapshot.nodes) {
      if (node.kind !== 'goal' && node.status === 'pending' && this.dependenciesComplete(node)) node.status = 'ready'
    }
    this.snapshot.updatedAt = Date.now()
  }

  private persist(): void {
    ensureSecureDirectory(this.options.dir)
    writeSecureFile(this.path, JSON.stringify(this.snapshot, null, 2))
  }
}

const graphStorage = new AsyncLocalStorage<GoalGraphStore>()
const nodeStorage = new AsyncLocalStorage<string | undefined>()

export function withGoalGraph<T>(graph: GoalGraphStore, fn: () => Promise<T>): Promise<T> {
  return graphStorage.run(graph, fn)
}

export function activeGoalGraph(): GoalGraphStore | undefined {
  return graphStorage.getStore()
}

export function withGoalNode<T>(nodeId: string | undefined, fn: () => Promise<T>): Promise<T> {
  return nodeStorage.run(nodeId, fn)
}

export function activeGoalNode(): string | undefined {
  return nodeStorage.getStore()
}

export function stableKey(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\u001f')).digest('hex')
}

export function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

export function actionKey(runId: string, nodeId: string, request: ActionRequest): string {
  const identityInput = request.name === 'run_command' && typeof request.input.command === 'string'
    ? { ...request.input, command: canonicalizeCommandForIdentity(request.input.command) }
    : request.input
  return stableKey(runId, nodeId, request.name, canonicalJson(identityInput))
}

/**
 * The actions that still represent an outstanding obligation.
 *
 * An action is one *attempt*; the step is the unit of work. An `edit_file`
 * whose `old_string` matched three places fails, the worker varies the call,
 * and the step completes — nothing is owed. Counting that failed attempt
 * against the run meant no run that ever had to try something twice could
 * report success, which is every real run: a run with 4 of 4 steps done,
 * verification green and review passed still came back `needs-attention`
 * because eight intermediate tool calls had failed along the way.
 *
 * So a mechanical failure — `failed` or `retryable`, the attempt itself went
 * wrong — is settled once the step it belonged to completed: the work happened
 * anyway, by some other route.
 *
 * Nothing else is. `planned` and `running` mean nobody ever learned the
 * outcome, and unknown is not settled. `blocked` and `human-review` mean the
 * governor decided a person should look at this, and a step completing by
 * another route does not discharge that — the person still has not looked.
 *
 * Actions owned by the root are judged by the verification and review evidence
 * in `canCompleteGoal`, not here — the root's completion is the very thing
 * being decided.
 */
export function outstandingActions(snapshot: GoalGraphSnapshot): DurableActionRecord[] {
  return snapshot.actions.filter((action) => {
    if (action.state === 'completed') return false
    if (action.state !== 'failed' && action.state !== 'retryable') return true
    const owner = snapshot.nodes.find((node) => node.id === action.nodeId)
    if (!owner || owner.id === snapshot.rootId) return false
    return owner.status !== 'completed'
  })
}

/**
 * Approvals still genuinely waiting on a person. An approval requested for an
 * action that is no longer outstanding is moot — the work it guarded either got
 * done another way or belongs to a step that finished.
 */
export function pendingApprovals(snapshot: GoalGraphSnapshot): ApprovalRecord[] {
  const outstanding = new Set(outstandingActions(snapshot).map((action) => action.idempotencyKey))
  return snapshot.approvals.filter((approval) => {
    if (approval.status !== 'pending') return false
    if (approval.kind !== 'action') return true
    return outstanding.has(approval.subject)
  })
}

/**
 * `source` says what the text is:
 *  - `'error'` (default): an exception message, an exit-code failure, an elia
 *    policy string. Every marker applies — this text is machine-generated.
 *  - `'report'`: a worker sub-agent's prose summary of why a step didn't finish.
 *    Prose words carry no verdict — a report saying the user must set a secret
 *    "manually", or that a reviewer found an attacker could gain "unauthorized"
 *    access, is not an authorization failure or a human-review gate. Only elia's
 *    own unambiguous strings and hard machine signals classify; everything else
 *    is `retryable`, so the wave executor's retry pass gets a shot at it instead
 *    of the node being permanently blocked on a turn of phrase.
 */
export function classifyFailure(error: unknown, opts: { source?: 'error' | 'report' } = {}): FailureRecord {
  const message = error instanceof Error ? error.message : String(error)
  const lower = message.toLowerCase()
  const fromReport = opts.source === 'report'
  let retryAfter: number | undefined

  // A worker's prose report: only hard machine signals and elia's own gate
  // strings classify. Anything else is retryable — the retry pass, not a
  // permanent block, handles a step that merely "didn't finish".
  if (fromReport) {
    let reportClass: FailureClass = 'retryable'
    if (/blocked by elia|denied by the user|action approval (?:denied|required)/.test(lower)) reportClass = 'authorization'
    else if (/rate limit|\b429\b|quota exceeded|too many requests/.test(lower)) retryAfter = 30_000
    return { class: reportClass, message: message.slice(0, 2000), at: Date.now(), retryAfter }
  }

  let failureClass: FailureClass = 'fatal'
  if (/blocked by elia|denied by the user|approval|unauthori[sz]ed|forbidden|captcha|login required/.test(lower)) failureClass = 'authorization'
  else if (/timeout|timed out|econnreset|econnrefused|network|rate limit|\b429\b|\b5\d\d\b|temporar|retryable|exit code/.test(lower)) {
    failureClass = 'retryable'
    // A rate limit is the one retryable failure that retrying immediately
    // cannot possibly fix — it is a statement about the next N seconds, not
    // about the request. A run once burned all five of its step retries
    // re-hitting the same 429 within milliseconds.
    retryAfter = /rate limit|\b429\b|quota exceeded|too many requests/.test(lower) ? 30_000 : 1000
  } else if (/enoent|no such file|not found|missing|executable|provider unavailable|configuration|invalid environment/.test(lower)) failureClass = 'environment'
  else if (/conflict|ambiguous|unknown whether|partially|manual|human|irreversible/.test(lower)) failureClass = 'human-review'
  return { class: failureClass, message: message.slice(0, 2000), at: Date.now(), retryAfter }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`
}

function normalizeSnapshot(snapshot: GoalGraphSnapshot, options: GoalGraphOptions): GoalGraphSnapshot {
  return {
    version: GOAL_GRAPH_VERSION,
    runId: options.runId,
    goal: snapshot.goal || options.goal,
    rootId: snapshot.rootId || 'goal:root',
    verificationCommands: Array.isArray(snapshot.verificationCommands) ? snapshot.verificationCommands : [],
    proposal: snapshot.proposal,
    nodes: Array.isArray(snapshot.nodes) ? snapshot.nodes : [],
    actions: Array.isArray(snapshot.actions) ? snapshot.actions : [],
    evidence: Array.isArray(snapshot.evidence) ? snapshot.evidence : [],
    approvals: Array.isArray(snapshot.approvals) ? snapshot.approvals : [],
    updatedAt: Number.isFinite(snapshot.updatedAt) ? snapshot.updatedAt : Date.now(),
  }
}
