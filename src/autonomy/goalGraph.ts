import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Proposal } from './types.ts'
import type { ActionRequest, GovernanceMode } from './governor.ts'
import type { ActionContract, ContractEvaluation } from './actionContract.ts'
import { canonicalizeCommandForIdentity } from './commandIdentity.ts'
import { ensureSecureDirectory, hardenSecureFile, writeSecureFile } from '../securePersistence.ts'
import { isProcessAlive, withFileLock } from '../fileLock.ts'
import { logSwallowedError } from '../diagnostics.ts'
import { userPreauthSecret } from './preauth.ts'
import { capacityRetryDelayMs, isCapacityError } from '../providerErrors.ts'

export const GOAL_GRAPH_VERSION = 2
export const EXECUTION_LEASE_TTL_MS = 120_000
const EXECUTION_OWNER = `${process.pid}:${randomUUID()}`

/**
 * How long an approved durable action stays valid before it must be
 * re-approved. Mirrors the preauth grant TTL (preauth.ts): generous enough to
 * cover a long run and any resumption within it, short enough that an approval
 * written today cannot silently cash out a much later resume.
 */
export const ACTION_APPROVAL_TTL_MS = 4 * 60 * 60_000

/** Whether the process that holds a node/action lease (`<pid>:<uuid>`) is still running. */
function leaseOwnerAlive(leaseOwner: string | undefined): boolean {
  if (!leaseOwner) return false
  const pid = Number.parseInt(leaseOwner.split(':')[0] ?? '', 10)
  return Number.isFinite(pid) && isProcessAlive(pid)
}

/** Grace past lease expiry before a lease held by a still-live worker is reclaimed. */
const LEASE_LIVE_OWNER_GRACE_MS = EXECUTION_LEASE_TTL_MS * 3

/**
 * A lease past its TTL but whose owner process (from a different elia process)
 * is still alive is not yet stale: it may be a worker that stalled past the
 * TTL, and reclaiming it now would run a second attempt alongside the first.
 * Only reclaim once the owner is gone, or a long grace elapses. EXECUTION_OWNER
 * is exempt from the grace — it names this process's own lease.
 */
function isLeaseGenuinelyStale(leaseOwner: string | undefined, expiresAt: number, now: number): boolean {
  if (expiresAt > now) return false
  if (leaseOwner && leaseOwner !== EXECUTION_OWNER && leaseOwnerAlive(leaseOwner)) {
    return now - expiresAt > LEASE_LIVE_OWNER_GRACE_MS
  }
  return true
}

/** Domain-separated key: the preauth secret also signs grants and the allow store, and a MAC from one must never verify as another. */
function approvalKey(): Buffer {
  return createHmac('sha256', userPreauthSecret()).update('elia.goal-graph.approval.v1').digest()
}

function approvalMac(runId: string, approval: ApprovalRecord): string {
  const data = JSON.stringify([runId, approval.kind, approval.subject, approval.mode ?? '', approval.status, approval.resolvedAt ?? '', approval.expiresAt ?? ''])
  return createHmac('sha256', approvalKey()).update(data).digest('hex')
}

function approvalMacValid(runId: string, approval: ApprovalRecord): boolean {
  if (typeof approval.mac !== 'string' || approval.mac.length === 0) return false
  const expected = Buffer.from(approvalMac(runId, approval))
  const actual = Buffer.from(approval.mac)
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false
  // Belt and braces: even a validly signed record never outlives the TTL it was granted under.
  if (approval.kind === 'action' && approval.status === 'approved') {
    if (approval.resolvedAt === undefined || approval.expiresAt === undefined || approval.expiresAt > approval.resolvedAt + ACTION_APPROVAL_TTL_MS) return false
  }
  return true
}

/**
 * Approvals read from disk are only honoured if this machine's secret signed
 * them. An 'approved' record that fails the check is downgraded to pending (the
 * person is asked again); the ids are returned so a resume can say so. Denials
 * are only ever more restrictive, so they need no proof.
 */
function sanitizeApprovals(snapshot: GoalGraphSnapshot): string[] {
  const untrusted: string[] = []
  if (!Array.isArray(snapshot.approvals)) return untrusted
  snapshot.approvals = snapshot.approvals.filter((item) => item !== null && typeof item === 'object')
  for (const approval of snapshot.approvals) {
    if (approval.status !== 'approved' || approvalMacValid(snapshot.runId, approval)) continue
    approval.status = 'pending'
    approval.resolvedAt = undefined
    approval.expiresAt = undefined
    approval.mac = undefined
    untrusted.push(approval.id)
  }
  return untrusted
}

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
  /**
   * For an action approval, the governor's intent for the refused action
   * (`shell.code-exec`, `deployment.production`, …) — what kind of effect it
   * would have had. `outstandingActions` reads it to tell an environment step
   * that a finished step no longer needs from an outward act nobody answered.
   */
  intent?: string
  at: number
  resolvedAt?: number
  /**
   * The governance mode ('supervised' | 'unattended') the approval was granted
   * under. A durable approval survives a goal-graph reopen for resumption, and
   * it must never apply to a run in a DIFFERENT mode: consent given to a
   * supervised session with a human at the terminal is not consent for an
   * unattended / scheduled execution. `isActionApproved` requires an exact
   * mode match.
   */
  mode?: GovernanceMode
  /**
   * When kind === 'action' and the approval was granted: the approval lapses
   * after this instant. A durable "yes" is time-bounded like a preauth grant —
   * an approval written today must not cash out a resume three weeks later.
   */
  expiresAt?: number
  /**
   * HMAC over this record's run, kind, subject, mode, status, resolvedAt and
   * expiresAt, keyed by the per-user secret outside the repo. Written only when
   * a decision is resolved. The goal-graph file sits in the model's workspace,
   * so an 'approved' record without a matching MAC is a forgery or a legacy
   * record and loads as pending.
   */
  mac?: string
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
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as GoalGraphSnapshot
    sanitizeApprovals(parsed)
    return parsed
  } catch (error) {
    // A corrupt file reads identically to "no goal graph was ever recorded"
    // to every caller (`elia runs <id>` printed the same "No durable goal
    // graph recorded" message either way) — hiding exactly the failure
    // whoever is reading this output is most likely trying to diagnose.
    logSwallowedError('goalGraph.readSnapshot', error, { path })
    return undefined
  }
}

export class GoalGraphStore {
  readonly path: string
  private readonly lockPath: string
  private snapshot: GoalGraphSnapshot
  private lastLeaseRecovery = { nodes: 0, actions: 0 }
  private mutating = 0
  /** Set when open quarantined a torn goal-graph.json instead of overwriting it. */
  openTornSnapshot?: { path: string }
  /** Ids of approvals found on disk as 'approved' without a valid MAC (forged, hand-edited or from an older version); they load as pending. */
  untrustedApprovals: string[] = []

  private constructor(private readonly options: GoalGraphOptions, snapshot: GoalGraphSnapshot) {
    this.path = join(options.dir, 'goal-graph.json')
    this.lockPath = `${this.path}.lock`
    this.snapshot = snapshot
  }

  /**
   * Runs a mutating operation under a cross-process lock, re-reading the
   * snapshot from disk first so a concurrent elia process (a resume, a second
   * `elia auto`, a fork) cannot have its node/action updates silently
   * overwritten by this process's whole-file `persist()`. Reentrant: a mutation
   * that calls another mutation does not re-lock or re-read.
   */
  private mutate<T>(fn: () => T): T {
    if (this.mutating > 0) return fn()
    return withFileLock(this.lockPath, () => {
      this.mutating++
      try {
        this.reloadFromDisk()
        return fn()
      } finally {
        this.mutating--
      }
    }, { ttlMs: EXECUTION_LEASE_TTL_MS })
  }

  private reloadFromDisk(): void {
    if (!existsSync(this.path)) return
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as GoalGraphSnapshot
      if ((parsed.version === 1 || parsed.version === GOAL_GRAPH_VERSION) && parsed.runId === this.options.runId) {
        const next = normalizeSnapshot(parsed, this.options)
        const untrusted = sanitizeApprovals(next)
        if (untrusted.length > 0) this.untrustedApprovals = [...new Set([...this.untrustedApprovals, ...untrusted])]
        this.refuseStateRegressions(next)
        this.snapshot = next
      }
    } catch {
      // A torn snapshot on disk: keep the in-memory one, which persist() will rewrite.
    }
  }

  /**
   * A file edit must not turn a refusal back into a runnable action. Only a
   * signed, still-valid approval (resolveApproval) may move an action out of
   * blocked/human-review; anything else the disk claims keeps the state this
   * process already holds. (A cold open has no earlier state to compare with,
   * but a 'planned' action alone confers nothing: it still meets the full
   * governor gate unless a MAC-verified approval exists.)
   */
  private refuseStateRegressions(next: GoalGraphSnapshot): void {
    const held = new Map(this.snapshot.actions.map((action) => [action.idempotencyKey, action]))
    for (const action of next.actions) {
      const before = held.get(action.idempotencyKey)
      if (!before || (before.state !== 'blocked' && before.state !== 'human-review')) continue
      if (action.state !== 'planned' && action.state !== 'retryable' && action.state !== 'completed') continue
      const approved = next.approvals.some((approval) => approval.kind === 'action' && approval.subject === action.idempotencyKey && approval.status === 'approved')
      if (approved) continue
      action.state = before.state
      action.error = before.error
    }
  }

  static open(options: GoalGraphOptions): GoalGraphStore {
    ensureSecureDirectory(options.dir)
    const path = join(options.dir, 'goal-graph.json')
    let openTornSnapshot: { path: string } | undefined
    if (existsSync(path)) {
      hardenSecureFile(path)
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as GoalGraphSnapshot
        if ((parsed.version === 1 || parsed.version === GOAL_GRAPH_VERSION) && parsed.runId === options.runId) {
          const normalized = normalizeSnapshot(parsed, options)
          const untrusted = sanitizeApprovals(normalized)
          const store = new GoalGraphStore(options, normalized)
          store.untrustedApprovals = untrusted
          const recovery = store.reconcileStaleLeases()
          store.lastLeaseRecovery = { nodes: recovery.nodes.length, actions: recovery.actions.length }
          return store
        }
      } catch (error) {
        // A torn graph is replaced by a fresh, valid snapshot — but that means
        // every completed step/action recorded in the corrupt file is silently
        // discarded and `elia resume` restarts from a bare root node. Log it
        // (real state loss, not the benign concurrent-write race that
        // `reloadFromDisk` handles) and quarantine the corrupt bytes: the
        // fresh-root persist() below would otherwise overwrite the only copy.
        logSwallowedError('goalGraph.open.tornSnapshot', error, { path, runId: options.runId })
        try {
          const quarantinePath = `${path}.corrupt-${Date.now()}`
          renameSync(path, quarantinePath)
          openTornSnapshot = { path: quarantinePath }
        } catch {
          // Quarantine is best-effort: a failed rename still falls through to a fresh root.
        }
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
    store.openTornSnapshot = openTornSnapshot
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
    this.mutate(() => {
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
    })
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
    return this.mutate(() => {
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
    })
  }

  startNode(id: string): GoalNode {
    return this.mutate(() => {
    const node = this.requireNode(id)
    if (node.status === 'running') {
      if (node.leaseExpiresAt && node.leaseExpiresAt > Date.now()) {
        if (node.leaseOwner !== EXECUTION_OWNER) throw new Error(`goal node ${id} is already leased by another execution`)
        return structuredClone(node)
      }
      // A lease that has technically expired but whose owner process is still
      // running gets a grace window — reclaiming it here would start a second
      // attempt while the original worker is still executing (issue #21).
      if (node.leaseOwner && node.leaseOwner !== EXECUTION_OWNER && leaseOwnerAlive(node.leaseOwner)
        && node.leaseExpiresAt && node.leaseExpiresAt > Date.now() - LEASE_LIVE_OWNER_GRACE_MS) {
        throw new Error(`goal node ${id} is still being executed by a live worker (${node.leaseOwner})`)
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
    })
  }

  heartbeatNode(id: string): GoalNode {
    return this.mutate(() => {
    const node = this.requireNode(id)
    if (node.status === 'running' && node.leaseOwner === EXECUTION_OWNER) {
      node.leaseExpiresAt = Date.now() + EXECUTION_LEASE_TTL_MS
      node.updatedAt = Date.now()
      this.persist()
    }
    return structuredClone(node)
    })
  }

  finishNode(id: string, result: { ok: boolean; report?: string; error?: unknown; evidence?: EvidenceRecord[] }): GoalNode {
    return this.mutate(() => {
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
    })
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
    return this.mutate(() => {
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
    })
  }

  failRun(error: unknown): void {
    this.mutate(() => {
    const root = this.requireNode(this.snapshot.rootId)
    root.status = 'failed'
    root.lastError = classifyFailure(error)
    root.updatedAt = Date.now()
    this.persist()
    })
  }

  requestApproval(kind: ApprovalRecord['kind'], subject: string, request?: Record<string, unknown>, reason?: string, mode?: GovernanceMode, intent?: string): ApprovalRecord {
    return this.mutate(() => {
    const existing = this.snapshot.approvals.find((approval) => approval.kind === kind && approval.subject === subject)
    if (existing) {
      if (kind === 'plan' && existing.status === 'denied') {
        existing.status = 'pending'
        existing.at = Date.now()
        existing.resolvedAt = undefined
        existing.expiresAt = undefined
        existing.reason = reason
        existing.request = request
        existing.mode = mode
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
      ...(intent ? { intent } : {}),
      at: Date.now(),
      mode,
    }
    this.snapshot.approvals.push(record)
    const root = this.requireNode(this.snapshot.rootId)
    root.status = 'waiting-approval'
    root.updatedAt = Date.now()
    this.persist()
    return structuredClone(record)
    })
  }

  resolveApproval(id: string, approved: boolean, reason?: string): ApprovalRecord {
    return this.mutate(() => {
    const record = this.snapshot.approvals.find((approval) => approval.id === id)
    if (!record) throw new Error(`unknown durable approval ${id}`)
    record.status = approved ? 'approved' : 'denied'
    record.reason = reason ?? record.reason
    record.resolvedAt = Date.now()
    if (record.kind === 'action') {
      // Time-bound the durable "yes" so a resumed run cannot cash out an
      // approval written long ago (or one written in a different mode — the
      // mode check in isActionApproved handles that half).
      if (approved) record.expiresAt = record.resolvedAt + ACTION_APPROVAL_TTL_MS
      const action = this.snapshot.actions.find((item) => item.idempotencyKey === record.subject)
      if (action) {
        action.state = approved ? 'planned' : 'blocked'
        action.error = approved ? undefined : classifyFailure(reason ?? 'action approval denied')
        action.updatedAt = Date.now()
      }
    }
    // The one place a real decision (a person, a preauth, autoApprove) is
    // recorded, so the one place a record is signed.
    record.mac = approvalMac(this.snapshot.runId, record)
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
    })
  }

  /**
   * What a resume is about to honour, as plain lines to print before it does:
   * the proposal, each verified approval still in force, and any record found
   * approved on disk without this machine's signature (which is asked again).
   */
  resumeNotice(): string[] {
    const lines: string[] = []
    const goal = this.snapshot.proposal?.goal
    if (goal) lines.push(`Resuming run ${this.snapshot.runId}: ${goal.replace(/\s+/g, ' ').slice(0, 200)}`)
    const now = Date.now()
    for (const approval of this.snapshot.approvals) {
      if (approval.status !== 'approved') continue
      if (approval.kind === 'action' && (approval.expiresAt ?? 0) <= now) continue
      lines.push(`Honouring ${approval.kind} approval (${approval.mode ?? 'any mode'}) for ${approval.subject.slice(0, 16)}${approval.expiresAt ? `, valid until ${new Date(approval.expiresAt).toISOString()}` : ''}`)
    }
    if (this.untrustedApprovals.length > 0) lines.push(`Ignoring ${this.untrustedApprovals.length} approval record(s) on disk that this machine did not sign; they will be asked for again.`)
    return lines
  }

  needsResumption(nodeId: string): boolean {
    // Mirrors `outstandingActions` so the executor cannot re-run a step whose
    // refusals or failures already settled when the step completed. Without
    // this, a completed step still carrying a `blocked`/`retryable`/`human-review`
    // action stayed in the pending wave and `startNode` re-ran the whole step.
    return this.snapshot.actions.some((action) => {
      if (action.nodeId !== nodeId) return false
      const owner = this.snapshot.nodes.find((node) => node.id === nodeId)
      const ownerCompleted = owner !== undefined && owner.id !== this.snapshot.rootId && owner.status === 'completed'
      if (action.state === 'planned' || action.state === 'running') return true
      if (action.state === 'human-review') {
        if (!ownerCompleted) return true
        return !LOCAL_ONLY_INTENTS.has(actionApproval(this.snapshot, action)?.intent ?? '')
      }
      if (action.state === 'retryable' || action.state === 'blocked') {
        // The same moot-if-the-step-finished rule as outstandingActions: a
        // refusal the worker routed around is settled once the step it
        // belonged to completed.
        return !ownerCompleted
      }
      // A `failed` action never asks for resumption. `startNode` reads this to
      // decide whether a failed or blocked step may run again without a person,
      // and nearly every failed step carries a failed action — counting it let
      // a fatal failure re-run on resume instead of stopping for review.
      return false
    })
  }

  pendingApprovals(): ApprovalRecord[] {
    return this.snapshot.approvals.filter((approval) => approval.status === 'pending').map((approval) => structuredClone(approval))
  }

  isActionApproved(request: ActionRequest, nodeId = this.snapshot.rootId, mode?: GovernanceMode): boolean {
    const subject = actionKey(this.snapshot.runId, nodeId, request)
    // Exact mode match (undefined when caller does not track it) AND unexpired:
    // a durable approval must never apply to a different governance mode, and
    // must never cash out past its time bound. Legacy approvals recorded
    // before either field existed fail closed here.
    return this.snapshot.approvals.some(
      (approval) =>
        approval.kind === 'action' &&
        approval.subject === subject &&
        approval.status === 'approved' &&
        (mode === undefined || approval.mode === mode) &&
        approval.expiresAt !== undefined &&
        approval.expiresAt > Date.now(),
    )
  }

  addEvidence(evidence: EvidenceRecord): EvidenceRecord {
    return this.mutate(() => {
    const existing = this.snapshot.evidence.find((item) => item.id === evidence.id)
    if (existing) return structuredClone(existing)
    this.snapshot.evidence.push({ ...evidence, data: structuredClone(evidence.data) })
    const node = this.snapshot.nodes.find((item) => item.id === evidence.nodeId)
    if (node && !node.evidenceIds.includes(evidence.id)) node.evidenceIds.push(evidence.id)
    this.snapshot.updatedAt = Date.now()
    this.persist()
    return structuredClone(evidence)
    })
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
    this.mutate(() => {
    if (!this.canCompleteGoal()) throw new Error('goal cannot complete: missing completed nodes, approval, verification, or review evidence')
    const root = this.requireNode(this.snapshot.rootId)
    root.status = 'completed'
    root.finishedAt = Date.now()
    root.updatedAt = Date.now()
    this.persist()
    })
  }

  reserveAction(request: ActionRequest, nodeId = this.snapshot.rootId): ActionReservation {
    return this.mutate(() => {
    const idempotencyKey = actionKey(this.snapshot.runId, nodeId, request)
    const existing = this.snapshot.actions.find((action) => action.idempotencyKey === idempotencyKey)
    if (existing) {
      if (existing.state === 'running' && existing.leaseExpiresAt && isLeaseGenuinelyStale(existing.leaseOwner, existing.leaseExpiresAt, Date.now())) {
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
    })
  }

  startAction(id: string, contract?: ActionContract, precondition?: ContractEvaluation): DurableActionRecord {
    return this.mutate(() => {
    const action = this.requireAction(id)
    if (action.state === 'running') {
      // A lease still in force may only be re-entered by the owner that took
      // it out — otherwise two workers would both be "executing" the same
      // durable action (issue #21 for actions). The node path in `startNode`
      // already refuses exactly this; the action path used to stamp over the
      // existing lease unconditionally, which a second caller (or a crashed
      // first caller that reserveAction had already handed an `execute`
      // decision) could ride back into a duplicate run.
      if (action.leaseOwner === EXECUTION_OWNER) {
        if (action.leaseExpiresAt && action.leaseExpiresAt > Date.now()) return structuredClone(action)
      } else if (action.leaseOwner && leaseOwnerAlive(action.leaseOwner)
        && action.leaseExpiresAt && action.leaseExpiresAt > Date.now() - LEASE_LIVE_OWNER_GRACE_MS) {
        throw new Error(`durable action ${id} is still being executed by a live owner (${action.leaseOwner})`)
      }
      // Stale lease from a dead or vanished owner: reclaim the slot the same
      // way reserveAction does, never launching a second attempt blindly.
      action.state = 'retryable'
      action.error = classifyFailure('stale action execution lease recovered')
      action.leaseOwner = undefined
      action.leaseExpiresAt = undefined
    }
    action.state = 'running'
    action.attempts += 1
    action.leaseOwner = EXECUTION_OWNER
    action.leaseExpiresAt = Date.now() + EXECUTION_LEASE_TTL_MS
    if (contract) action.contract = structuredClone(contract)
    if (precondition) action.precondition = structuredClone(precondition)
    action.updatedAt = Date.now()
    this.persist()
    return structuredClone(action)
    })
  }

  heartbeatAction(id: string): DurableActionRecord {
    return this.mutate(() => {
    const action = this.requireAction(id)
    if (action.state === 'running' && action.leaseOwner === EXECUTION_OWNER) {
      action.leaseExpiresAt = Date.now() + EXECUTION_LEASE_TTL_MS
      action.updatedAt = Date.now()
      this.persist()
    }
    return structuredClone(action)
    })
  }

  finishAction(id: string, result: { ok: boolean; result?: string; error?: unknown; postcondition?: ContractEvaluation }): DurableActionRecord {
    return this.mutate(() => {
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
    })
  }

  blockAction(id: string, failure: unknown, humanReview = false, precondition?: ContractEvaluation, postcondition?: ContractEvaluation, contract?: ActionContract): DurableActionRecord {
    return this.mutate(() => {
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
    })
  }

  leaseRecoverySummary(): { nodes: number; actions: number } {
    return { ...this.lastLeaseRecovery }
  }

  reconcileStaleLeases(now = Date.now()): { nodes: string[]; actions: string[] } {
    return this.mutate(() => {
    const nodes: string[] = []
    const actions: string[] = []
    for (const node of this.snapshot.nodes) {
      if (node.status === 'running' && node.leaseExpiresAt && isLeaseGenuinelyStale(node.leaseOwner, node.leaseExpiresAt, now)) {
        node.status = node.attemptCount < node.maxAttempts ? 'waiting-retry' : 'blocked'
        node.lastError = classifyFailure('stale execution lease recovered after process interruption')
        node.leaseOwner = undefined
        node.leaseExpiresAt = undefined
        node.updatedAt = now
        nodes.push(node.id)
      }
    }
    for (const action of this.snapshot.actions) {
      if (action.state === 'running' && action.leaseExpiresAt && isLeaseGenuinelyStale(action.leaseOwner, action.leaseExpiresAt, now)) {
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
    })
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

/**
 * Runs `fn` outside the run's goal graph, for everything it awaits.
 *
 * `runSubAgent` falls back to the ambient graph, and the durable ledger keys an
 * action on (run, node, tool, input) with no working directory — so several
 * attempts at one problem, each in its own checkout, would share one idempotency
 * namespace, and an identical write or install in the second would be replayed
 * from the first's record instead of run. Attempts in disposable worktrees are
 * not actions in the world; what is merged back is.
 */
export function withoutGoalGraph<T>(fn: () => Promise<T>): Promise<T> {
  return graphStorage.run(undefined as unknown as GoalGraphStore, fn)
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
  const nodeIds = new Set(snapshot.nodes.map((node) => node.id))
  return snapshot.actions.filter((action) => {
    if (action.state === 'completed') return false
    // An advisory worker — the assumption check, a reviewer — acts under a node
    // id of its own (`check:assumptions`, `review:critic#1`) that is not a node
    // of the goal, so nothing the goal delivers waits on what it did, whatever
    // became of it. Counting its refusals kept run 2026-09-15-cqd0-omdu at
    // needs-attention with every step done, its render check passing and its
    // review approving: the assumption scout had tried `dir /a` and a read
    // outside its workspace, unattended, five times.
    if (!nodeIds.has(action.nodeId) && action.nodeId !== snapshot.rootId) return false
    // `blocked` joins `failed` and `retryable` in the moot-if-the-step-finished
    // rule, for the same reason: a governor refusal or a failed precondition
    // that the worker then routed around is not outstanding work — the step it
    // belonged to completed. Counting them made the receipt list phantom
    // blockers ("20 durable action(s) remain unresolved") that no one could
    // act on, and pushed runs to `needs-attention` on work that was done. In
    // run 2026-09-13-l0av-rnq0, five of the twenty were exactly this.
    //
    // `human-review` means a person was asked to decide, and a step completing
    // around it does not answer them — when the question was about an outward
    // act. A refused deploy, push or send that a worker then "finished" without
    // is exactly the overclaim this ledger exists to stop. A refused *local*
    // environment step is different: `pip install -e .` would have changed only
    // this machine, it never ran, and the step that wanted it finished anyway.
    // Run 2026-09-23-krum-r1ir (a Python CLI) ended needs-attention with all 5
    // steps done, 23 tests green and review passed, held by three such installs.
    // Those stop counting once their step completes; `declinedLocalActions`
    // keeps them on the receipt. Anything else — including an approval recorded
    // before intents were, with none to read — stays outstanding.
    if (action.state === 'human-review') {
      const owner = snapshot.nodes.find((node) => node.id === action.nodeId)
      if (!owner || owner.id === snapshot.rootId || owner.status !== 'completed') return true
      return !LOCAL_ONLY_INTENTS.has(actionApproval(snapshot, action)?.intent ?? '')
    }
    if (action.state !== 'failed' && action.state !== 'retryable' && action.state !== 'blocked') return true
    const owner = snapshot.nodes.find((node) => node.id === action.nodeId)
    if (!owner || owner.id === snapshot.rootId) return false
    return owner.status !== 'completed'
  })
}

/**
 * Governor intents whose effect stays on this machine. Only a package install
 * (`shell.code-exec`): the governor matches it start-anchored and only after
 * rejecting shell control syntax, so nothing can ride along behind it. Not
 * `shell.composed` — `vercel --yes --prod 2>&1` is composed, and it deploys —
 * nor `shell.unknown`, which is whatever the governor could not name. An
 * allowlist, so any other intent, and any added later, stays outstanding.
 */
const LOCAL_ONLY_INTENTS = new Set(['shell.code-exec'])

function actionApproval(snapshot: GoalGraphSnapshot, action: DurableActionRecord): ApprovalRecord | undefined {
  return snapshot.approvals.find((approval) => approval.kind === 'action' && approval.subject === action.idempotencyKey)
}

/**
 * Local environment actions a person was asked about, that never ran, and that
 * their step finished without — no longer blocking (`outstandingActions`), but
 * still something the user may want to do themselves.
 */
export function declinedLocalActions(snapshot: GoalGraphSnapshot): ApprovalRecord[] {
  const outstanding = new Set(outstandingActions(snapshot).map((action) => action.idempotencyKey))
  return snapshot.actions
    .filter((action) => action.state === 'human-review' && !outstanding.has(action.idempotencyKey))
    .map((action) => actionApproval(snapshot, action))
    .filter((approval): approval is ApprovalRecord => approval?.status === 'pending')
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
    else if (isCapacityError(message)) retryAfter = capacityRetryDelayMs(message)
    return { class: reportClass, message: message.slice(0, 2000), at: Date.now(), retryAfter }
  }

  let failureClass: FailureClass = 'fatal'
  if (/blocked by elia|denied by the user|approval|unauthori[sz]ed|forbidden|captcha|login required/.test(lower)) failureClass = 'authorization'
  // Checked before the generic retryable branch below, because a capacity
  // failure has to reach `capacityRetryDelayMs` rather than the flat 1s that
  // branch would otherwise hand a message matching `timeout` or `exit code`.
  else if (isCapacityError(message)) {
    failureClass = 'retryable'
    retryAfter = capacityRetryDelayMs(message)
  } else if (/timeout|timed out|econnreset|econnrefused|network|\b5\d\d\b|temporar|retryable|exit code/.test(lower)) {
    failureClass = 'retryable'
    retryAfter = 1000
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

/**
 * Tools whose only effect is to hand a structured report back to the running
 * process — a review verdict, an acceptance check, a plan, a set of lessons.
 *
 * These must never be replayed from the durable action ledger. Replay exists to
 * stop a resumed run from repeating something that already happened in the
 * world (a push, a deploy, a write); it returns the recorded *result string*
 * without running the tool. For a reporting tool the result string is the
 * worthless half — `"Verdict recorded."` — and the half that matters is the
 * side effect of capturing the verdict, which replay skips entirely.
 *
 * The canonical list lives in `reportingTools.ts` (a leaf, importable by both
 * the governor and this module); it is re-exported here so every existing
 * import site keeps working unchanged.
 */
export { REPORTING_TOOLS, isReportingTool } from './reportingTools.ts'
