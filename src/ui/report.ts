import { bold, dim, gold, green, red, boldCyan } from './theme.ts'
import { box } from './layout.ts'

const PHASE_LABELS: Record<string, string> = {
  orient: 'Orienting',
  propose: 'Planning',
  execute: 'Working',
  verify: 'Verifying',
  reflect: 'Repairing',
  learn: 'Learning',
}

/** A phase heading, so a long autonomous run reads as a sequence of moves rather than a wall of tool calls. */
export function writePhase(phase: string, detail?: string): void {
  const label = PHASE_LABELS[phase] ?? phase
  process.stdout.write(`\n${bold(gold(`◆ ${label}`))}${detail ? ` ${dim(detail)}` : ''}\n`)
}

export function writeSubStep(text: string): void {
  process.stdout.write(`  ${dim(text)}\n`)
}

export function writePass(text: string): void {
  process.stdout.write(`  ${green('✓')} ${text}\n`)
}

export function writeFail(text: string): void {
  process.stdout.write(`  ${red('✗')} ${text}\n`)
}

/** A titled panel for a chunk of prose or diagnostic output the user should notice as a unit — a review, an issue list — rather than read as more streamed activity. */
export function writeBlock(title: string, body: string): void {
  process.stdout.write(`\n${box(body.split('\n'), { title })}\n`)
}

/** The closing panel for a finished run — its own bordered block so it reads as a summary, not the tail end of the activity log above it. */
export function writeSummary(title: string, rows: [string, string][]): void {
  const width = Math.max(...rows.map(([label]) => label.length), 0)
  const lines = rows.map(([label, value]) => `${dim(label.padEnd(width))}  ${value}`)
  process.stdout.write(`\n${box(lines, { title, borderColor: boldCyan })}\n`)
}
