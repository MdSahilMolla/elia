import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ToolEvent } from '../agentLoop.ts'
import type { CriticVerdict, Proposal } from './types.ts'
import { currentAgent } from './context.ts'
import { redactActionInput } from './governor.ts'
import { redactArchiveValue, redactSecrets } from '../ui/redact.ts'
import type { JournalEvent } from './journal.ts'
import type { GoalGraphSnapshot } from './goalGraph.ts'
import type { Usage } from '../providers/types.ts'
import type { CompletionAssessment } from './outcome.ts'
import { appendSecureFile, ensureSecureDirectory, writeSecureFile } from '../securePersistence.ts'
import { withFileLock } from '../fileLock.ts'
import { paths } from '../statePaths.ts'

export interface ActionLedgerRecord {
  at: number
  actor: string
  role: string
  runId?: string
  tool: string
  input: Record<string, unknown>
  result: string
  isError: boolean
  cached: boolean
  durationMs: number
  risk?: string
  decision?: string
  reason?: string
  intent?: string
  resources?: string[]
  reversible?: boolean
  actionId?: string
  idempotencyKey?: string
  replayed?: boolean
  failureClass?: string
  /** Run through an external agent's own sandbox, not elia's governor. */
  ungoverned?: boolean
}

export interface RunReceiptInput {
  runId: string
  goal: string
  outcome: string
  taskSessionId?: string
  proposal?: Proposal
  verdict?: CriticVerdict
  lessons?: string[]
  events: JournalEvent[]
  graph?: GoalGraphSnapshot
  usage?: Usage
  elapsedMs?: number
  maxWallClockMs?: number
  actionBudget?: { maxActions: number; consumed: number; exhausted: boolean; blockedByBudget: number }
  completion?: CompletionAssessment
  /**
   * Set only when the run did not reach its own ending — it threw, or its
   * process was killed. Without this a dead run left no receipt at all, and
   * `elia distill` could say nothing about it but "run never finished".
   */
  interruption?: { reason: string; error?: string; stack?: string; lastPhase?: string }
}

export function appendActionAudit(event: ToolEvent, runIdOverride?: string): void {
  const identity = currentAgent()
  const assessment = event.assessment
  // Secret VALUES ("a credential echoed by a tool run") are redacted, not just
  // key names: redactActionInput blanks credential-*keyed* inputs, then
  // redactArchiveValue value-scans every remaining string for token shapes, and
  // the result goes through redactSecrets before truncation instead of being
  // stored raw (up to 1200 chars).
  const result = redactSecrets(event.result)
  const record: ActionLedgerRecord = {
    at: Date.now(),
    actor: identity.name,
    role: identity.role,
    runId: runIdOverride ?? identity.runId,
    tool: event.name,
    input: redactArchiveValue(redactActionInput(event.name, event.input)) as Record<string, unknown>,
    result: result.length > 1200 ? `${result.slice(0, 1200)}…` : result,
    isError: event.isError,
    cached: event.cached,
    durationMs: event.durationMs,
    risk: assessment?.risk,
    decision: assessment?.decision,
    reason: assessment?.reason,
    intent: assessment?.intent,
    resources: assessment?.resources,
    reversible: assessment?.reversible,
    actionId: event.actionId,
    idempotencyKey: event.idempotencyKey,
    replayed: event.replayed,
    failureClass: event.failureClass,
    ungoverned: event.ungoverned,
  }

  const runId = runIdOverride ?? identity.runId
  const filePath = runId ? join(paths.runs, runId, 'actions.ndjson') : join(paths.state, 'action-ledger.ndjson')
  try {
    // Parallel fleet workers — and a second elia process on the same project —
    // append here concurrently. A large record is not guaranteed to land as one
    // atomic write, so two could interleave into a torn line. Serialize the
    // append under the same advisory lock the run journal uses; if the lock
    // can't be had quickly, append anyway (readActionLedger skips a torn line)
    // rather than stall the tool call being audited.
    withFileLock(`${filePath}.lock`, () => appendSecureFile(filePath, `${JSON.stringify(record)}\n`), {
      ttlMs: 10_000,
      timeoutMs: 2_000,
      proceedOnTimeout: true,
    })
  } catch {
    // Auditing is best effort and must never take down the task it describes.
  }
}

export function readActionLedger(runId: string): ActionLedgerRecord[] {
  const filePath = join(paths.runs, runId, 'actions.ndjson')
  try {
    return readFileSync(filePath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as ActionLedgerRecord]
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}

export function writeRunReceipt(input: RunReceiptInput): void {
  const actions = readActionLedger(input.runId)
  const receipt = {
    runId: input.runId,
    goal: input.goal,
    outcome: input.outcome,
    taskSessionId: input.taskSessionId,
    completion: input.completion,
    createdAt: actions[0]?.at ?? Date.now(),
    completedAt: Date.now(),
    elapsedMs: input.elapsedMs,
    maxWallClockMs: input.maxWallClockMs,
    actionBudget: input.actionBudget,
    interruption: input.interruption,
    usage: input.usage,
    proposal: input.proposal
      ? {
          goal: input.proposal.goal,
          steps: input.proposal.steps.map((step) => ({ id: step.id, title: step.title, role: step.role, files: step.files })),
          verification: input.proposal.verification,
          risks: input.proposal.risks,
          assumptions: input.proposal.assumptions,
          outOfScope: input.proposal.outOfScope,
          acceptanceCriteria: input.proposal.acceptanceCriteria ?? [],
          sideEffects: input.proposal.sideEffects ?? [],
          recovery: input.proposal.recovery ?? [],
        }
      : undefined,
    verification: input.events.filter((event) => event.kind === 'verify').map((event) => redactArchiveValue(event.data) as Record<string, unknown>),
    verdict: input.verdict,
    lessons: input.lessons ?? [],
    graph: input.graph
      ? {
          nodes: input.graph.nodes.map((node) => ({ id: node.id, parentId: node.parentId, role: node.role, depth: node.depth, status: node.status, attempts: node.attemptCount, evidenceIds: node.evidenceIds, lastError: node.lastError?.class })),
          pendingApprovals: input.graph.approvals.filter((approval) => approval.status === 'pending').length,
          recoveredNodes: input.graph.nodes.filter((node) => node.lastError?.message.includes('stale') || node.lastError?.message.includes('interruption')).length,
          activeLeases: input.graph.nodes.filter((node) => node.leaseExpiresAt && node.leaseExpiresAt > Date.now()).length + input.graph.actions.filter((action) => action.leaseExpiresAt && action.leaseExpiresAt > Date.now()).length,
          retryableActions: input.graph.actions.filter((action) => action.state === 'retryable').length,
          humanReviewActions: input.graph.actions.filter((action) => action.state === 'human-review').length,
          contractedActions: input.graph.actions.filter((action) => action.contract).length,
          preconditionFailures: input.graph.actions.filter((action) => action.precondition && !action.precondition.ok).map((action) => ({ id: action.id, tool: action.tool, failures: action.precondition?.failures ?? [], nextAction: action.precondition?.nextAction })),
          postconditionFailures: input.graph.actions.filter((action) => action.postcondition && !action.postcondition.ok).map((action) => ({ id: action.id, tool: action.tool, failures: action.postcondition?.failures ?? [], nextAction: action.postcondition?.nextAction })),
          takeoverActions: input.graph.actions.filter((action) => action.contract?.requiresUserTakeover).map((action) => ({ id: action.id, tool: action.tool, state: action.state, error: action.error?.message })),
          evidence: input.graph.evidence.map((evidence) => ({ id: evidence.id, kind: evidence.kind, passed: evidence.passed, summary: evidence.summary })),
        }
      : undefined,
    actions: {
      total: actions.length,
      byTool: countBy(actions, (action) => action.tool),
      byRisk: countBy(actions, (action) => action.risk ?? 'unknown'),
      blocked: actions.filter((action) => action.decision === 'block').length,
      failed: actions.filter((action) => action.isError).length,
      reversible: actions.filter((action) => action.reversible === true).length,
      irreversible: actions.filter((action) => action.reversible === false).length,
      replayed: actions.filter((action) => action.replayed === true).length,
      humanReview: actions.filter((action) => action.failureClass === 'human-review').length,
      retryable: actions.filter((action) => action.failureClass === 'retryable').length,
    },
    uncertainty: input.verdict?.issues.filter((issue) => issue.severity === 'minor').map((issue) => issue.detail) ?? [],
    operational: {
      elapsedMs: input.elapsedMs,
      maxWallClockMs: input.maxWallClockMs,
      usage: input.usage,
    },
    replay: {
      eventsFile: 'events.ndjson',
      actionsFile: 'actions.ndjson',
      checkpointsDirectory: 'checkpoints/',
    },
  }

  const dir = join(paths.runs, input.runId)
  try {
    ensureSecureDirectory(dir)
    writeSecureFile(join(dir, 'receipt.json'), JSON.stringify(receipt, null, 2))
    writeSecureFile(join(dir, 'receipt.md'), renderReceipt(receipt))
  } catch {
    // A missing receipt should not erase the actual run result.
  }
}

function countBy(actions: ActionLedgerRecord[], key: (action: ActionLedgerRecord) => string): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const action of actions) {
    const value = key(action)
    counts[value] = (counts[value] ?? 0) + 1
  }
  return counts
}

function renderReceipt(receipt: {
  runId: string
  goal: string
  outcome: string
  taskSessionId?: string
  verification: Record<string, unknown>[]
  uncertainty: string[]
  elapsedMs?: number
  maxWallClockMs?: number
  actionBudget?: { maxActions: number; consumed: number; exhausted: boolean; blockedByBudget: number }
  interruption?: { reason: string; error?: string; stack?: string; lastPhase?: string }
  actions: { total: number; failed: number; blocked: number; irreversible: number; replayed?: number; humanReview?: number; retryable?: number }
  graph?: { nodes: { id: string; status: string; attempts: number }[]; pendingApprovals: number; recoveredNodes?: number; activeLeases?: number; retryableActions?: number; humanReviewActions?: number; contractedActions?: number; preconditionFailures?: { id: string; tool: string; failures: string[]; nextAction?: string }[]; postconditionFailures?: { id: string; tool: string; failures: string[]; nextAction?: string }[]; takeoverActions?: { id: string; tool: string; state: string; error?: string }[] }
  completion?: CompletionAssessment
}): string {
  const verificationLines =
    receipt.verification.length > 0
      ? receipt.verification.map((item) => `- ${JSON.stringify(item)}`).join('\n')
      : '- No verification event was recorded.'
  const uncertaintyLines =
    receipt.uncertainty.length > 0
      ? receipt.uncertainty.map((item) => `- ${item}`).join('\n')
      : '- No minor review uncertainty was recorded.'

  return [
    '# Elia run receipt',
    '',
    `- **Run:** ${receipt.runId}`,
    `- **Outcome:** ${receipt.outcome}`,
    ...(receipt.interruption
      ? [
          `- **Interrupted:** ${receipt.interruption.reason}${receipt.interruption.lastPhase ? ` during the ${receipt.interruption.lastPhase} phase` : ''}`,
          ...(receipt.interruption.error ? [`- **Error:** ${receipt.interruption.error}`] : []),
        ]
      : []),
    ...(receipt.taskSessionId ? [`- **Task session:** ${receipt.taskSessionId}`] : []),
    ...(receipt.completion ? [`- **Completion state:** ${receipt.completion.state} (${receipt.completion.confidence} confidence)`, `- **Completion:** ${receipt.completion.summary}`, `- **Evidence:** ${receipt.completion.evidence.length > 0 ? receipt.completion.evidence.join('; ') : 'none'}`, `- **Blockers:** ${receipt.completion.blockers.length > 0 ? receipt.completion.blockers.join('; ') : 'none'}`, `- **Next actions:** ${receipt.completion.nextActions.join('; ')}`] : []),
    `- **Goal:** ${receipt.goal}`,
    `- **Elapsed:** ${receipt.elapsedMs === undefined ? 'unknown' : `${(receipt.elapsedMs / 1000).toFixed(1)}s`}${receipt.maxWallClockMs ? ` / budget ${(receipt.maxWallClockMs / 1000).toFixed(1)}s` : ''}`,
    `- **Actions:** ${receipt.actions.total} (${receipt.actions.failed} failed, ${receipt.actions.blocked} blocked)`,
    ...(receipt.actionBudget ? [`- **Action budget:** ${receipt.actionBudget.consumed}/${receipt.actionBudget.maxActions || 'unlimited'} consumed${receipt.actionBudget.exhausted ? ' (exhausted)' : ''}`] : []),
    `- **Irreversible actions:** ${receipt.actions.irreversible}`,
    `- **Replayed idempotent actions:** ${receipt.actions.replayed ?? 0}`,
    `- **Human-review actions:** ${receipt.actions.humanReview ?? 0}`,
    `- **Retryable actions:** ${receipt.actions.retryable ?? 0}`,
    ...(receipt.graph ? [`- **Pending approvals:** ${receipt.graph.pendingApprovals}`, `- **Graph nodes:** ${receipt.graph.nodes.filter((node) => node.status === 'completed').length}/${receipt.graph.nodes.length} completed`, `- **Recovered stale nodes:** ${receipt.graph.recoveredNodes ?? 0}`, `- **Active leases at receipt:** ${receipt.graph.activeLeases ?? 0}`, `- **Contracted actions:** ${receipt.graph.contractedActions ?? 0}`, `- **Contract precondition failures:** ${receipt.graph.preconditionFailures?.length ?? 0}`, `- **Contract postcondition failures:** ${receipt.graph.postconditionFailures?.length ?? 0}`, `- **User-takeover actions:** ${receipt.graph.takeoverActions?.length ?? 0}`] : []),
    '',
    '## What proves completion',
    '',
    verificationLines,
    '',
    '## Remaining uncertainty',
    '',
    uncertaintyLines,
    '',
    '## Replay',
    '',
    '- Event journal: `events.ndjson`',
    '- Redacted action ledger: `actions.ndjson`',
    '- Checkpoints: `checkpoints/`',
    '',
  ].join('\n')
}
