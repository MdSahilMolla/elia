import { boldGold, colorEnabled, dim, dimCyan, gold, green, raw, red } from './theme.ts'
import { emitEvent, interactiveTerminal, machineReadable, quietOutput } from './runtime.ts'
import { redactRecord, redactText } from './redact.ts'
import { createMarkdownStream, type MarkdownStream } from './markdown.ts'
import { registerShutdownCleanup } from './shutdown.ts'

const REPLY_MARKER = `${boldGold('●')} `

let inThinkingBlock = false
let replyStarted = false
let toolBlockOpen = false
let markdownStream: MarkdownStream | undefined
let quietReply = ''

// While a batch of tool calls is in flight, a single spinner line tracks how
// many are still running and for how long — replacing the old silence between
// "→ tool(...)" appearing and its result landing, which read as a hang on
// anything slower than instant (a multi-second shell command, a slow fetch).
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const SPINNER_FRAME_MS = 80

let pendingTools = 0
let batchStartedAt = 0
let spinnerFrame = 0
let spinnerVisible = false
let spinnerTimer: ReturnType<typeof setInterval> | undefined
let unregisterSpinnerShutdown: (() => void) | undefined

function spinnerLine(): string {
  const elapsed = ((Date.now() - batchStartedAt) / 1000).toFixed(1)
  const frame = SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length] ?? '⠋'
  const label = pendingTools === 1 ? 'tool' : 'tools'
  return `  ${dimCyan(frame)} ${dim(`running ${pendingTools} ${label}… (${elapsed}s)`)}`
}

function showSpinner(): void {
  if (!interactiveTerminal || spinnerVisible || pendingTools === 0) return
  spinnerVisible = true
  process.stdout.write(`${spinnerLine()}\n`)
  unregisterSpinnerShutdown = registerShutdownCleanup(hideSpinner)
  spinnerTimer = setInterval(() => {
    spinnerFrame += 1
    process.stdout.write(`\x1b[1A\x1b[2K${spinnerLine()}\n`)
  }, SPINNER_FRAME_MS)
}

function hideSpinner(): void {
  if (!spinnerVisible) return
  spinnerVisible = false
  if (spinnerTimer) clearInterval(spinnerTimer)
  spinnerTimer = undefined
  unregisterSpinnerShutdown?.()
  unregisterSpinnerShutdown = undefined
  process.stdout.write('\x1b[1A\x1b[2K')
}

function closeThinkingBlock(): void {
  if (!inThinkingBlock) return
  inThinkingBlock = false
  if (machineReadable) {
    emitEvent('thinking_end')
    return
  }
  if (quietOutput) return
  process.stdout.write(colorEnabled ? `${raw.reset}\n\n` : '\n\n')
}

/** Streams visible reasoning separately from the final answer. */
export function writeThinking(delta: string): void {
  if (machineReadable) {
    emitEvent('thinking_delta', { text: delta })
    return
  }
  if (quietOutput) return
  if (!inThinkingBlock) {
    inThinkingBlock = true
    if (colorEnabled) process.stdout.write(`${raw.dim}${raw.italic}`)
  }
  process.stdout.write(delta)
}

export function writeText(delta: string): void {
  closeThinkingBlock()
  if (machineReadable) {
    emitEvent('assistant_delta', { text: delta })
    return
  }
  if (quietOutput) {
    quietReply += delta
    return
  }
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
  if (machineReadable) {
    emitEvent('assistant_end')
    return
  }
  if (quietOutput) {
    if (quietReply.trim()) process.stdout.write(`${quietReply.trimEnd()}\n`)
    quietReply = ''
    return
  }
  if (markdownStream) {
    process.stdout.write(markdownStream.flush())
    markdownStream = undefined
  }
  process.stdout.write('\n')
  replyStarted = false
}

export function writeToolCall(name: string, input: Record<string, unknown>): void {
  closeThinkingBlock()
  const safeInput = redactRecord(input)
  if (machineReadable) {
    emitEvent('tool_started', { name, input: safeInput })
    return
  }
  if (quietOutput) return
  hideSpinner()
  if (!toolBlockOpen) {
    toolBlockOpen = true
    process.stdout.write('\n')
  }
  const summary = summarizeInput(safeInput)
  process.stdout.write(`  ${gold('●')} ${dimCyan(`${name}${summary ? `(${summary})` : ''}`)}\n`)
  if (pendingTools === 0) batchStartedAt = Date.now()
  pendingTools += 1
  spinnerFrame = 0
  showSpinner()
}

export function writeToolResult(name: string, result: string, isError: boolean, cached = false, durationMs?: number): void {
  const safeResult = redactText(result, 300)
  if (machineReadable) {
    emitEvent('tool_finished', { name, ok: !isError, cached, result: safeResult, durationMs })
    return
  }
  if (quietOutput) return
  hideSpinner()
  pendingTools = Math.max(0, pendingTools - 1)
  const mark = isError ? '✗' : cached ? '⚡' : '✓'
  const timing = cached || durationMs === undefined || durationMs < 200 ? '' : ` (${(durationMs / 1000).toFixed(1)}s)`
  const coloredMark = isError ? red(mark) : cached ? mark : green(mark)
  // The name is kept (not just the result) because a concurrent batch can have
  // several calls in flight at once — dropping it would make an out-of-order
  // result untraceable to its call. Claude Code can omit it because it never
  // interleaves two pending results; Elia's real concurrency means it can.
  // On success the terminal gets a tool-aware one-line digest instead of a raw
  // dump; on error the full (capped) text stays, since that's what you need to
  // actually debug the failure — the model still sees the untouched `result`
  // either way, this only changes what's echoed to the screen.
  const display = isError ? safeResult : summarizeResult(name, result)
  const rest = dim(`${name}${timing} ${display}`)
  process.stdout.write(`    ${dim('⎿')} ${coloredMark} ${rest}\n`)
  spinnerFrame = 0
  showSpinner()
}

/** Informational status — session state, mode changes, and usage hints. */
export function writeNotice(text: string): void {
  if (machineReadable) {
    emitEvent('notice', { message: redactText(text, 1000) })
    return
  }
  if (quietOutput) return
  process.stdout.write(`${gold(text)}\n`)
}

/** A failure the user needs to notice. Human diagnostics go to stderr. */
export function writeError(text: string): void {
  if (machineReadable) {
    emitEvent('error', { message: redactText(text, 2000) })
    return
  }
  process.stderr.write(`${red(text)}\n`)
}

export function writeUsageLine(text: string): void {
  if (machineReadable) {
    emitEvent('usage', { message: redactText(text, 1000) })
    return
  }
  if (quietOutput) return
  process.stdout.write(`${dim(text)}\n`)
}

// Config/plumbing fields that are almost always the default and rarely what
// the person watching the transcript needs to see — dropping them turns
// `run_command(command: bun test, cwd: D:\elia, timeoutMs: 120000)` into
// `run_command(bun test)`, which is what actually happened.
const LOW_SIGNAL_KEYS = new Set(['cwd', 'timeoutMs', 'startupTimeoutMs'])

function summarizeInput(input: Record<string, unknown>): string {
  const entries = Object.entries(input).filter(([key]) => !LOW_SIGNAL_KEYS.has(key))

  const render = (value: unknown): string => {
    let str: string
    try {
      str = typeof value === 'string' ? value : JSON.stringify(value)
    } catch {
      str = '[unserializable]'
    }
    return redactText(str ?? '', 60)
  }

  // A single remaining argument (the overwhelmingly common case — a command,
  // a path, a pattern) reads better bare than under a repeated key label.
  if (entries.length === 1) return render(entries[0]![1])

  return entries.map(([key, value]) => `${key}: ${render(value)}`).join(', ')
}

function lastNonEmptyLine(text: string): string {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const trimmed = lines[i]!.trim()
    if (trimmed.length > 0) return trimmed
  }
  return ''
}

/** `run_command`'s raw text is "exit code: N\nstdout:\n...\nstderr:\n..." — the
 * status plus whatever the process printed last (commonly its own summary
 * line, e.g. a test runner's pass/fail count) says more than the first 300
 * characters of a build log ever would. */
function summarizeShellResult(result: string): string {
  const lines = result.split('\n')
  const status = lines[0] ?? ''
  const body = lines.slice(1).filter((line) => line !== 'stdout:' && line !== 'stderr:').join('\n')
  const tail = lastNonEmptyLine(body)
  return tail ? `${status} — ${tail}` : status
}

function summarizeFileList(result: string): string {
  if (result === 'No files matched.') return result
  const files = result.split('\n').filter(Boolean)
  const preview = files.slice(0, 3).join(', ')
  return files.length > 3 ? `${files.length} files (${preview}, …)` : `${files.length} file${files.length === 1 ? '' : 's'} (${preview})`
}

/** Counts true matches (":line:") separately from ripgrep's "-line-" context lines. */
function summarizeGrep(result: string): string {
  if (result.startsWith('No matches found')) return result
  const matches = result.split('\n').filter((line) => /:\d+:/.test(line))
  const files = new Set(matches.map((line) => line.split(/:\d+:/)[0]))
  return `${matches.length} match${matches.length === 1 ? '' : 'es'} in ${files.size} file${files.size === 1 ? '' : 's'}`
}

function summarizeReadFile(result: string): string {
  const lineCount = result.split('\n').filter((line) => /^\d+\t/.test(line)).length
  const more = result.match(/\[(\d+) more line/)
  return more ? `${lineCount} lines shown, ${more[1]} more` : `${lineCount} line${lineCount === 1 ? '' : 's'}`
}

const RESULT_SUMMARIZERS: Record<string, (result: string) => string> = {
  run_command: summarizeShellResult,
  list_files: summarizeFileList,
  grep: summarizeGrep,
  read_file: summarizeReadFile,
}

export function summarizeResult(name: string, result: string): string {
  const summarize = RESULT_SUMMARIZERS[name]
  const summary = summarize ? summarize(result) : result
  return redactText(summary, 200)
}
