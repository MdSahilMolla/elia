import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ToolEvent } from '../agentLoop.ts'
import type { CriticVerdict, Proposal } from './types.ts'
import { currentAgent } from './context.ts'
import { redactActionInput } from './governor.ts'
import type { JournalEvent } from './journal.ts'

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
}

export interface RunReceiptInput {
  runId: string
  goal: string
  outcome: string
  proposal?: Proposal
  verdict?: CriticVerdict
  lessons?: string[]
  events: JournalEvent[]
}

export function appendActionAudit(event: ToolEvent, runIdOverride?: string): void {
  const identity = currentAgent()
  const assessment = event.assessment
  const record: ActionLedgerRecord = {
    at: Date.now(),
    actor: identity.name,
    role: identity.role,
    runId: runIdOverride ?? identity.runId,
    tool: event.name,
    input: redactActionInput(event.name, event.input),
    result: event.result.length > 1200 ? `${event.result.slice(0, 1200)}…` : event.result,
    isError: event.isError,
    cached: event.cached,
    durationMs: event.durationMs,
    risk: assessment?.risk,
    decision: assessment?.decision,
    reason: assessment?.reason,
    intent: assessment?.intent,
    resources: assessment?.resources,
    reversible: assessment?.reversible,
  }

  const runId = runIdOverride ?? identity.runId
  const filePath = runId ? join(process.cwd(), '.elia', 'runs', runId, 'actions.ndjson') : join(process.cwd(), '.elia', 'action-ledger.ndjson')
  try {
    mkdirSync(dirname(filePath), { recursive: true })
    appendFileSync(filePath, `${JSON.stringify(record)}\n`)
  } catch {
    // Auditing is best effort and must never take down the task it describes.
  }
}

export function readActionLedger(runId: string): ActionLedgerRecord[] {
  const filePath = join(process.cwd(), '.elia', 'runs', runId, 'actions.ndjson')
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
    createdAt: actions[0]?.at ?? Date.now(),
    completedAt: Date.now(),
    proposal: input.proposal
      ? {
          goal: input.proposal.goal,
          steps: input.proposal.steps.map((step) => ({ id: step.id, title: step.title, role: step.role, files: step.files })),
          verification: input.proposal.verification,
          risks: input.proposal.risks,
          assumptions: input.proposal.assumptions,
          outOfScope: input.proposal.outOfScope,
        }
      : undefined,
    verification: input.events.filter((event) => event.kind === 'verify').map((event) => event.data),
    verdict: input.verdict,
    lessons: input.lessons ?? [],
    actions: {
      total: actions.length,
      byTool: countBy(actions, (action) => action.tool),
      byRisk: countBy(actions, (action) => action.risk ?? 'unknown'),
      blocked: actions.filter((action) => action.decision === 'block').length,
      failed: actions.filter((action) => action.isError).length,
      reversible: actions.filter((action) => action.reversible === true).length,
      irreversible: actions.filter((action) => action.reversible === false).length,
    },
    uncertainty: input.verdict?.issues.filter((issue) => issue.severity === 'minor').map((issue) => issue.detail) ?? [],
    replay: {
      eventsFile: 'events.ndjson',
      actionsFile: 'actions.ndjson',
      checkpointsDirectory: 'checkpoints/',
    },
  }

  const dir = join(process.cwd(), '.elia', 'runs', input.runId)
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'receipt.json'), JSON.stringify(receipt, null, 2))
    writeFileSync(join(dir, 'receipt.md'), renderReceipt(receipt))
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
  verification: Record<string, unknown>[]
  uncertainty: string[]
  actions: { total: number; failed: number; blocked: number; irreversible: number }
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
    `- **Goal:** ${receipt.goal}`,
    `- **Actions:** ${receipt.actions.total} (${receipt.actions.failed} failed, ${receipt.actions.blocked} blocked)`,
    `- **Irreversible actions:** ${receipt.actions.irreversible}`,
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
