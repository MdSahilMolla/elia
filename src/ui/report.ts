const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const GOLD = '\x1b[33m'
const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const CYAN = '\x1b[36m'
const RESET = '\x1b[0m'

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
  process.stdout.write(`\n${BOLD}${GOLD}◆ ${label}${RESET}${detail ? ` ${DIM}${detail}${RESET}` : ''}\n`)
}

export function writeSubStep(text: string): void {
  process.stdout.write(`  ${DIM}${text}${RESET}\n`)
}

export function writePass(text: string): void {
  process.stdout.write(`  ${GREEN}✓${RESET} ${text}\n`)
}

export function writeFail(text: string): void {
  process.stdout.write(`  ${RED}✗${RESET} ${text}\n`)
}

export function writeBlock(title: string, body: string): void {
  process.stdout.write(`\n${BOLD}${title}${RESET}\n${body}\n`)
}

export function writeSummary(title: string, rows: [string, string][]): void {
  const width = Math.max(...rows.map(([label]) => label.length), 0)
  process.stdout.write(`\n${BOLD}${CYAN}${title}${RESET}\n`)
  for (const [label, value] of rows) {
    process.stdout.write(`  ${DIM}${label.padEnd(width)}${RESET}  ${value}\n`)
  }
  process.stdout.write('\n')
}
