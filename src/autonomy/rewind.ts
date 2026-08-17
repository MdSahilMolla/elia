import { listCheckpoints, readCheckpoint, readEvents, type StoredCheckpoint } from './journal.ts'
import { runAutonomousTask, type Approver, type AutonomousRunResult } from './loop.ts'

/**
 * Re-entering a finished run at an earlier decision, with a different decision.
 *
 * A transcript tells you what an agent did. It does not let you ask what would
 * have happened if the plan had been different — normally the only way to explore
 * that is to start over and pay for the whole run again, including the
 * investigation that was already correct. Because each phase checkpointed the
 * exact message array it began from, that investigation can be replayed for free
 * and only the decision re-taken.
 *
 * Forking is non-destructive: the original run's journal is untouched, and the
 * fork gets its own run id, so both remain inspectable and comparable.
 */

/** Checkpoint labels that hold a *planning* conversation, and can therefore be re-planned from. */
const FORKABLE_LABELS = ['before-orient', 'after-propose']

export interface RunStep {
  checkpointId: number
  label: string
  at: number
  messageCount: number
  forkable: boolean
}

export function runSteps(runId: string): RunStep[] {
  return listCheckpoints(runId).map((checkpoint) => ({
    checkpointId: checkpoint.id,
    label: checkpoint.label,
    at: checkpoint.at,
    messageCount: checkpoint.messages.length,
    forkable: isForkable(checkpoint.label),
  }))
}

export function isForkable(label: string): boolean {
  return FORKABLE_LABELS.some((forkable) => label.startsWith(forkable))
}

/** A timeline of the run, for `elia runs <id>`. */
export function renderRunTimeline(runId: string): string {
  const events = readEvents(runId)
  if (events.length === 0) return `No journal found for run ${runId}.`

  const start = events[0]!.at
  const lines = events
    .filter((event) => event.kind !== 'tool')
    .map((event) => {
      const seconds = ((event.at - start) / 1000).toFixed(1).padStart(6)
      return `  ${seconds}s  ${event.kind.padEnd(11)} ${summarize(event.kind, event.data)}`
    })

  const forkable = runSteps(runId).filter((step) => step.forkable)
  const footer =
    forkable.length > 0
      ? `\nForkable points:\n${forkable.map((step) => `  ${step.checkpointId}  ${step.label} (${step.messageCount} messages)`).join('\n')}\n\nFork one with:  elia fork ${runId} --at <n> --with "<what to do differently>"`
      : '\nNo forkable checkpoints in this run.'

  return `Run ${runId}\n\n${lines.join('\n')}\n${footer}`
}

export interface ForkOptions {
  runId: string
  checkpointId: number
  instruction: string
  approve: Approver
}

export type ForkResult = { ok: true; run: AutonomousRunResult } | { ok: false; error: string }

/**
 * Replays a run up to a checkpoint and continues from there with a new
 * instruction, as a new run.
 */
export async function forkRun(options: ForkOptions): Promise<ForkResult> {
  const checkpoint = readCheckpoint(options.runId, options.checkpointId)
  if (!checkpoint) {
    return { ok: false, error: `run ${options.runId} has no checkpoint ${options.checkpointId}` }
  }
  if (!isForkable(checkpoint.label)) {
    return {
      ok: false,
      error: `checkpoint ${options.checkpointId} ("${checkpoint.label}") is not a planning checkpoint, so there is no decision to retake there`,
    }
  }

  const goal = originalGoal(options.runId) ?? '(forked run)'
  const messages = [
    ...checkpoint.messages,
    {
      role: 'user' as const,
      content: [
        {
          type: 'text' as const,
          text: `We are re-planning from this point. Everything above is what you already established — do not re-investigate it.\n\nWhat to do differently:\n${options.instruction}\n\nSubmit a new proposal that reflects this.`,
        },
      ],
    },
  ]

  const run = await runAutonomousTask({
    goal: `${goal} (forked from ${options.runId}@${options.checkpointId}: ${options.instruction})`,
    approve: options.approve,
    resumeMessages: messages,
  })

  return { ok: true, run }
}

function originalGoal(runId: string): string | undefined {
  const start = readEvents(runId).find((event) => event.kind === 'run-start')
  return typeof start?.data.goal === 'string' ? start.data.goal : undefined
}

function summarize(kind: string, data: Record<string, unknown>): string {
  switch (kind) {
    case 'run-start':
      return truncate(String(data.goal ?? ''), 70)
    case 'phase':
      return String(data.phase ?? '')
    case 'proposal': {
      const proposal = data.proposal as { steps?: unknown[] } | undefined
      return `${proposal?.steps?.length ?? 0} steps`
    }
    case 'approval':
      return String(data.action ?? '')
    case 'step-start':
      return `${String(data.role ?? '')} ${truncate(String(data.title ?? ''), 50)}`
    case 'step-end':
      return `${data.ok ? 'ok' : 'failed'} ${String(data.worker ?? '')} (${String(data.steps ?? '?')} steps)`
    case 'verify':
      return data.passed ? 'passed' : 'failed'
    case 'verdict':
      return `${String(data.verdict ?? '')} — ${truncate(String(data.summary ?? ''), 50)}`
    case 'lesson':
      return `${(data.lessons as unknown[] | undefined)?.length ?? 0} kept`
    case 'checkpoint':
      return `${String(data.label ?? '')} (${String(data.messageCount ?? '?')} messages)`
    case 'run-end':
      return String(data.outcome ?? '')
    default:
      return ''
  }
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

export type { StoredCheckpoint }
