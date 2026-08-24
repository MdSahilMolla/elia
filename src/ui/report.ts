import { box } from './layout.ts'
import { bold, boldCyan, dim, gold, green, red } from './theme.ts'
import { emitEvent, machineReadable, quietOutput } from './runtime.ts'
import { redactText } from './redact.ts'

const PHASE_LABELS: Record<string, string> = {
  orient: 'Orienting',
  propose: 'Planning',
  execute: 'Working',
  verify: 'Verifying',
  reflect: 'Repairing',
  learn: 'Learning',
}

export function writePhase(phase: string, detail?: string): void {
  const label = PHASE_LABELS[phase] ?? phase
  if (machineReadable) {
    emitEvent('phase_started', { phase, label, detail: detail ? redactText(detail, 1000) : undefined })
    return
  }
  if (quietOutput) return
  process.stdout.write(`\n${bold(gold(`◆ ${label}`))}${detail ? ` ${dim(detail)}` : ''}\n`)
}

export function writeSubStep(text: string): void {
  if (machineReadable) {
    emitEvent('phase_detail', { message: redactText(text, 1000) })
    return
  }
  if (quietOutput) return
  process.stdout.write(`  ${dim(text)}\n`)
}

export function writePass(text: string): void {
  if (machineReadable) {
    emitEvent('check_passed', { message: redactText(text, 1000) })
    return
  }
  if (quietOutput) return
  process.stdout.write(`  ${green('✓')} ${text}\n`)
}

export function writeFail(text: string): void {
  if (machineReadable) {
    emitEvent('check_failed', { message: redactText(text, 1000) })
    return
  }
  process.stdout.write(`  ${red('✗')} ${text}\n`)
}

export function writeBlock(title: string, body: string): void {
  if (machineReadable) {
    emitEvent('report_block', { title: redactText(title, 200), body: redactText(body, 10000) })
    return
  }
  if (quietOutput) {
    process.stdout.write(`${body}\n`)
    return
  }
  process.stdout.write(`\n${box(body.split('\n'), { title })}\n`)
}

export function writeSummary(title: string, rows: [string, string][]): void {
  if (machineReadable) {
    emitEvent('run_summary', { title: redactText(title, 200), rows: rows.map(([label, value]) => ({ label, value: redactText(value, 2000) })) })
    return
  }
  if (quietOutput) {
    for (const [label, value] of rows) process.stdout.write(`${label}: ${value}\n`)
    return
  }
  const width = Math.max(...rows.map(([label]) => label.length), 0)
  const lines = rows.map(([label, value]) => `${dim(label.padEnd(width))}  ${value}`)
  process.stdout.write(`\n${box(lines, { title, borderColor: boldCyan })}\n`)
}
