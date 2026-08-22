import { raw, colorEnabled, boldGold, dim, dimCyan, red, gold } from './theme.ts'
import { createMarkdownStream, type MarkdownStream } from './markdown.ts'

/** The marker printed once at the start of each assistant reply, so it reads as a
 *  distinct block in scrollback instead of running straight on from the user's own
 *  input or the previous turn's tool activity. Gold ties it to elia's brand color,
 *  used consistently for the banner, spinner, and phase headers. */
const REPLY_MARKER = `${boldGold('●')} `

// Whether a thinking block is currently open on stdout. Module-level rather
// than threaded through the callers (agentLoop, agent.ts) because every call
// site that might follow reasoning with real output — text, a tool call — has
// to close it the same way, and a shared writer is the one place that can
// enforce that without every caller remembering to do it themselves.
let inThinkingBlock = false
// Whether this turn's reply marker has been printed yet — reset at the end of
// every turn so the next reply gets its own marker.
let replyStarted = false
// Whether a tool-call block is already open for this batch — only the first
// call in a batch opens with a blank line, so parallel calls stay grouped as
// one visual unit instead of each getting its own gap.
let toolBlockOpen = false
// Renders the reply's markdown (bold, tables, headers) as it streams — see markdown.ts.
// Live for the duration of one reply; recreated per turn so state never leaks across replies.
let markdownStream: MarkdownStream | undefined

function closeThinkingBlock(): void {
  if (!inThinkingBlock) return
  inThinkingBlock = false
  process.stdout.write(colorEnabled ? `${raw.reset}\n\n` : '\n\n')
}

/** Streams the model's visible reasoning, dim+italic so it reads as distinct from its final answer. */
export function writeThinking(delta: string): void {
  if (!inThinkingBlock) {
    inThinkingBlock = true
    if (colorEnabled) process.stdout.write(`${raw.dim}${raw.italic}`)
  }
  process.stdout.write(delta)
}

export function writeText(delta: string): void {
  closeThinkingBlock()
  if (!replyStarted) {
    replyStarted = true
    toolBlockOpen = false
    markdownStream = createMarkdownStream()
    process.stdout.write(REPLY_MARKER)
  }
  process.stdout.write(markdownStream!.push(delta))
}

export function endTextTurn(): void {
  closeThinkingBlock()
  if (markdownStream) {
    process.stdout.write(markdownStream.flush())
    markdownStream = undefined
  }
  process.stdout.write('\n')
  replyStarted = false
}

export function writeToolCall(name: string, input: Record<string, unknown>): void {
  closeThinkingBlock()
  if (!toolBlockOpen) {
    toolBlockOpen = true
    process.stdout.write('\n')
  }
  const summary = summarizeInput(input)
  process.stdout.write(`  ${dimCyan(`→ ${name}${summary ? `(${summary})` : ''}`)}\n`)
}

export function writeToolResult(name: string, result: string, isError: boolean, cached = false): void {
  const preview = result.length > 300 ? `${result.slice(0, 300)}…` : result
  const line = `${preview.replace(/\n/g, ' ')}`
  // The bolt marks a result that was already waiting in the speculative cache, so
  // the speed-up is visible rather than invisible.
  const mark = isError ? '✗' : cached ? '⚡' : '✓'
  const text = `    ${mark} ${name}: ${line}`
  process.stdout.write(`${isError ? red(text) : dim(text)}\n`)
}

/** Informational status — session state, mode changes, usage hints. Not an error. */
export function writeNotice(text: string): void {
  process.stdout.write(`${gold(text)}\n`)
}

/** A failure the user needs to notice — paired with a non-zero exit code, or an unrecoverable turn error. */
export function writeError(text: string): void {
  process.stdout.write(`${red(text)}\n`)
}

export function writeUsageLine(text: string): void {
  process.stdout.write(`${dim(text)}\n`)
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
