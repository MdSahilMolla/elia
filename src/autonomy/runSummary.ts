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
