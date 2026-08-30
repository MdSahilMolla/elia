// An ordered, typed record of the current interactive session — every user
// line, assistant reply, tool call, and notice. The REPL prints and forgets, so
// this is the one place the full text of a turn survives: `/expand` reprints a
// tool result the screen truncated, `/export` writes the whole conversation to
// Markdown, `/cost` walks the turn boundaries.
//
// Kept deliberately small and framework-free. It is fed from index.ts's
// `runCheckpointedTurn` (which already receives every `onTool` event plus the
// turn boundaries) — not from stream.ts — so there is exactly one writer and no
// risk of double-recording.
import type { ToolEvent } from '../agentLoop.ts'
import { redactRecord, redactText } from './redact.ts'

export interface TranscriptUserItem {
  kind: 'user'
  id: number
  turn: number
  text: string
}

export interface TranscriptAssistantItem {
  kind: 'assistant'
  id: number
  turn: number
  text: string
}

export interface TranscriptThinkingItem {
  kind: 'thinking'
  id: number
  turn: number
  text: string
}

export interface TranscriptToolItem {
  kind: 'tool'
  id: number
  turn: number
  name: string
  input: Record<string, unknown>
  status: 'ok' | 'error' | 'cached'
  result: string
  durationMs: number
}

export interface TranscriptNoticeItem {
  kind: 'notice' | 'error' | 'shell'
  id: number
  turn: number
  text: string
}

export type TranscriptItem =
  | TranscriptUserItem
  | TranscriptAssistantItem
  | TranscriptThinkingItem
  | TranscriptToolItem
  | TranscriptNoticeItem

export interface Transcript {
  items(): readonly TranscriptItem[]
  /** Number of completed user turns so far. */
  turns(): number
  appendUser(text: string): void
  appendAssistant(text: string): void
  appendThinking(text: string): void
  recordTool(event: ToolEvent): void
  notice(text: string): void
  error(text: string): void
  shell(command: string, output: string): void
  /** Advances the turn counter; call once per completed user turn. */
  endTurn(): void
  /** The most recent tool item, or the nth (0-indexed) tool item when `n` is given. */
  tool(n?: number): TranscriptToolItem | undefined
  toolCount(): number
  clear(): void
  toMarkdown(title?: string): string
}

export function createTranscript(): Transcript {
  const list: TranscriptItem[] = []
  let nextId = 1
  let turn = 0

  const push = (item: TranscriptItem): void => {
    list.push(item)
  }

  return {
    items: () => list,
    turns: () => turn,
    appendUser(text) {
      push({ kind: 'user', id: nextId++, turn, text })
    },
    appendAssistant(text) {
      if (text.trim()) push({ kind: 'assistant', id: nextId++, turn, text })
    },
    appendThinking(text) {
      if (text.trim()) push({ kind: 'thinking', id: nextId++, turn, text })
    },
    recordTool(event) {
      push({
        kind: 'tool',
        id: nextId++,
        turn,
        name: event.name,
        input: redactRecord(event.input),
        status: event.isError ? 'error' : event.cached ? 'cached' : 'ok',
        result: event.result,
        durationMs: event.durationMs,
      })
    },
    notice(text) {
      push({ kind: 'notice', id: nextId++, turn, text })
    },
    error(text) {
      push({ kind: 'error', id: nextId++, turn, text })
    },
    shell(command, output) {
      push({ kind: 'shell', id: nextId++, turn, text: `$ ${command}\n${output}` })
    },
    endTurn() {
      turn += 1
    },
    tool(n) {
      const tools = list.filter((item): item is TranscriptToolItem => item.kind === 'tool')
      return n === undefined ? tools.at(-1) : tools[n]
    },
    toolCount() {
      return list.filter((item) => item.kind === 'tool').length
    },
    clear() {
      list.length = 0
      nextId = 1
      turn = 0
    },
    toMarkdown(title) {
      const out: string[] = [`# ${title ?? 'elia session'}`, '']
      let currentTurn = -1
      for (const item of list) {
        if (item.turn !== currentTurn && (item.kind === 'user' || item.kind === 'assistant')) {
          currentTurn = item.turn
        }
        if (item.kind === 'user') {
          out.push(`## Turn ${item.turn + 1}`, '', `**You:**`, '', item.text, '')
        } else if (item.kind === 'assistant') {
          out.push(`**elia:**`, '', item.text, '')
        } else if (item.kind === 'thinking') {
          out.push('<details><summary>Reasoning</summary>', '', item.text, '', '</details>', '')
        } else if (item.kind === 'tool') {
          const summary = summarizeInputForMarkdown(item.input)
          out.push(
            `<details><summary>🔧 ${item.name}${summary ? `(${summary})` : ''} · ${item.status}</summary>`,
            '',
            '```',
            redactText(item.result, 8_000),
            '```',
            '',
            '</details>',
            '',
          )
        } else if (item.kind === 'shell') {
          out.push('```console', item.text, '```', '')
        } else {
          out.push(`> ${item.kind === 'error' ? '⚠️ ' : ''}${item.text}`, '')
        }
      }
      return out.join('\n')
    },
  }
}

function summarizeInputForMarkdown(input: Record<string, unknown>): string {
  const entries = Object.entries(input).filter(([key]) => key !== 'cwd' && key !== 'timeoutMs')
  if (entries.length === 0) return ''
  const render = (value: unknown): string => {
    const str = typeof value === 'string' ? value : JSON.stringify(value)
    return redactText(str ?? '', 80)
  }
  if (entries.length === 1) return render(entries[0]![1])
  return entries.map(([key, value]) => `${key}: ${render(value)}`).join(', ')
}

/** The process-wide transcript for the active interactive session. */
export const sessionTranscript: Transcript = createTranscript()
