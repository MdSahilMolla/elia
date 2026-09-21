import { redactText } from '../ui/redact.ts'
import { formatElapsed } from '../usage.ts'
import type { AutonomousRunResult } from './loop.ts'

/**
 * The message threaded back into the interactive session right after an
 * `elia auto` escalation finishes.
 *
 * A bare `[autonomous run: needs-attention] <goal> · N actions · Nm` told the
 * next interactive turn nothing about where the work actually landed. Seen
 * live: the user's plain "ok" right after a run like that had no file paths
 * to go on and rebuilt the whole deliverable from scratch at a different path
 * (`workspace/car-game.html`) while the plan's own `workspace/car-game/index.html`
 * — which worked — sat untouched. Naming the files here gives that next turn
 * something to check before it decides to start over.
 */
const RECEIPT_HEAD: Record<AutonomousRunResult['outcome'], string> = {
  completed: '✓ Done',
  'needs-attention': '! Needs attention',
  rejected: 'Plan not approved',
  'no-proposal': '! No plan came out of this run',
  aborted: 'Stopped',
}

/**
 * What the *person* sees when an escalated run ends. `formatAutonomousRunSummary`
 * is written for the next model turn — it carries an instruction ("check what is
 * already there…") that reads as nonsense on screen. This is the same outcome in
 * a line and a file list.
 */
export function formatAutonomousRunReceipt(goal: string, result: AutonomousRunResult): string {
  // A plan that never ran touched nothing — listing its intended files (and
  // "0/4 steps") read as if something had been built.
  const ran = result.outcome === 'completed' || result.outcome === 'needs-attention'
  const touchedFiles = ran ? [...new Set(result.proposal?.steps.flatMap((step) => step.files) ?? [])] : []
  const steps = ran && result.completion.totalSteps > 0 ? ` · ${result.completion.completedSteps}/${result.completion.totalSteps} steps` : ''
  const head = `${RECEIPT_HEAD[result.outcome] ?? result.outcome} — ${redactText(result.proposal?.goal ?? goal, 120)}${steps} · ${formatElapsed(result.elapsedMs)}`
  if (touchedFiles.length === 0) return head
  const shown = touchedFiles.slice(0, 6).join(', ')
  return `${head}\n  ${shown}${touchedFiles.length > 6 ? ` +${touchedFiles.length - 6} more` : ''}`
}

/**
 * What the next model turn is told when an escalated run *threw* — a provider
 * outage, a context overflow, an abort partway through.
 *
 * `formatAutonomousRunSummary` only ever runs when the pipeline returns, so a
 * crashed run appended nothing to the conversation at all. What the next turn
 * then saw was the build request followed by elia's own planning and no
 * outcome, which reads exactly like a build already in progress — so it carried
 * on building in an ordinary reply, with no approved plan, no verification, no
 * acceptance criteria, and writing into the session's working directory instead
 * of the run's own workspace.
 *
 * Seen live, session mubbhz5c-tnp9i0: the run died at the proposal gate having
 * touched nothing, and the very next turn wrote 11 unverified pages into the
 * repository root.
 */
export function formatAutonomousRunCrash(goal: string, error: unknown): string {
  const reason = redactText(error instanceof Error ? error.message : String(error), 200)
  return `[autonomous run: failed to run] ${redactText(goal, 200)} · ${reason}\n`
    + 'The governed build did not start: no plan was approved and nothing was written.\n'
    + 'Do not carry this build on in an ordinary reply — a plain turn has no approved plan, no verification '
    + 'and no acceptance criteria, and writes into the session working directory rather than the run workspace. '
    + 'Say that the run failed and let the person decide whether to start it again.'
}

export function formatAutonomousRunSummary(goal: string, result: AutonomousRunResult): string {
  const touchedFiles = [...new Set(result.proposal?.steps.flatMap((step) => step.files) ?? [])]
  const filesLine = touchedFiles.length === 0 ? '' : (
    `\nFiles this run created or touched (${result.completion.completedSteps}/${result.completion.totalSteps} steps completed): ${touchedFiles.join(', ')}`
    + (result.outcome === 'completed' ? '' : '\nBefore doing anything else for this goal, check what is already there — do not start a fresh implementation from scratch.')
  )
  return `[autonomous run: ${result.outcome}] ${redactText(result.proposal?.goal ?? goal, 200)} · `
    + `${result.actionBudget?.consumed ?? 0} actions · ${formatElapsed(result.elapsedMs)}`
    + filesLine
    + (result.lessons.length > 0 ? `\nLessons captured: ${result.lessons.join('; ')}` : '')
}
