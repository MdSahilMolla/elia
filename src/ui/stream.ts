import { boldGold, colorEnabled, dim, dimCyan, gold, raw, red } from './theme.ts'
import { emitEvent, machineReadable, quietOutput } from './runtime.ts'
import { redactRecord, redactText } from './redact.ts'
import { createMarkdownStream, type MarkdownStream } from './markdown.ts'

const REPLY_MARKER = `${boldGold('●')} `

let inThinkingBlock = false
let replyStarted = false
let toolBlockOpen = false
let markdownStream: MarkdownStream | undefined
let quietReply = ''

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
  if (!toolBlockOpen) {
    toolBlockOpen = true
    process.stdout.write('\n')
  }
  const summary = summarizeInput(safeInput)
  process.stdout.write(`  ${dimCyan(`→ ${name}${summary ? `(${summary})` : ''}`)}\n`)
}

export function writeToolResult(name: string, result: string, isError: boolean, cached = false): void {
  const safeResult = redactText(result, 300)
  if (machineReadable) {
    emitEvent('tool_finished', { name, ok: !isError, cached, result: safeResult })
    return
  }
  if (quietOutput) return
  const mark = isError ? '✗' : cached ? '⚡' : '✓'
  const text = `    ${mark} ${name}: ${safeResult}`
  process.stdout.write(`${isError ? red(text) : dim(text)}\n`)
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

function summarizeInput(input: Record<string, unknown>): string {
  return Object.entries(input)
    .map(([key, value]) => {
      let str: string
      try {
        str = typeof value === 'string' ? value : JSON.stringify(value)
      } catch {
        str = '[unserializable]'
      }
      const trimmed = redactText(str ?? '', 60)
      return `${key}: ${trimmed}`
    })
    .join(', ')
}
