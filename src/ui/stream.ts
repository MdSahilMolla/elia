const DIM = '\x1b[2m'
const CYAN = '\x1b[36m'
const YELLOW = '\x1b[33m'
const RED = '\x1b[31m'
const RESET = '\x1b[0m'

export function writeText(delta: string): void {
  process.stdout.write(delta)
}

export function endTextTurn(): void {
  process.stdout.write('\n')
}

export function writeToolCall(name: string, input: Record<string, unknown>): void {
  const summary = summarizeInput(input)
  process.stdout.write(`${DIM}${CYAN}→ ${name}${summary ? `(${summary})` : ''}${RESET}\n`)
}

export function writeToolResult(name: string, result: string, isError: boolean, cached = false): void {
  const color = isError ? RED : DIM
  const preview = result.length > 300 ? `${result.slice(0, 300)}…` : result
  // The bolt marks a result that was already waiting in the speculative cache, so
  // the speed-up is visible rather than invisible.
  const mark = isError ? '✗' : cached ? '⚡' : '✓'
  process.stdout.write(`${color}  ${mark} ${name}: ${preview.replace(/\n/g, ' ')}${RESET}\n`)
}

export function writeNotice(text: string): void {
  process.stdout.write(`${YELLOW}${text}${RESET}\n`)
}

export function writeUsageLine(text: string): void {
  process.stdout.write(`${DIM}${text}${RESET}\n`)
}

function summarizeInput(input: Record<string, unknown>): string {
  const entries = Object.entries(input)
  if (entries.length === 0) return ''
  return entries
    .map(([key, value]) => {
      const str = typeof value === 'string' ? value : JSON.stringify(value)
      const trimmed = str.length > 60 ? `${str.slice(0, 60)}…` : str
      return `${key}: ${trimmed}`
    })
    .join(', ')
}
