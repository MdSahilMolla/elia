// An ordered, typed record of the current interactive session — every user
// line, assistant reply, tool call, and notice. The REPL prints and forgets, so
// this is the one place the full text of a turn survives: `/expand` reprints a
// tool result the screen truncated, `/export` writes the whole conversation to
// Markdown, `/cost` walks the turn boundaries.
//
// index.ts records user turns and local shell output; the shared agent loop
// records model output, provider activity, and tools for the lead and its children.
import type { ToolEvent, ConversationMessage } from '../agentLoop.ts'
import { AsyncLocalStorage } from 'node:async_hooks'
import { redactArchiveValue, redactSecrets, redactText } from './redact.ts'

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
  actor?: string
  decision?: string
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
  recordTool(event: ToolEvent, actor?: string): void
  notice(text: string): void
  error(text: string): void
  shell(command: string, output: string): void
  /** Advances the turn counter; call once per completed user turn. */
  endTurn(): void
  /** The most recent tool item, or the nth (0-indexed) tool item when `n` is given. */
  tool(n?: number): TranscriptToolItem | undefined
  toolCount(): number
  clear(): void
  snapshot(): TranscriptSnapshot
  restore(snapshot: TranscriptSnapshot): void
  toMarkdown(title?: string): string
}

export interface TranscriptSnapshot {
  items: TranscriptItem[]
  turns: number
}

export function isTranscriptSnapshot(value: unknown): value is TranscriptSnapshot {
  if (!value || typeof value !== 'object') return false
  const snapshot = value as TranscriptSnapshot
  return Number.isInteger(snapshot.turns) && snapshot.turns >= 0 && Array.isArray(snapshot.items)
    && snapshot.items.every((item) => item && Number.isInteger(item.id) && Number.isInteger(item.turn)
      && (item.kind === 'tool'
        ? typeof item.name === 'string' && typeof item.result === 'string' && !!item.input && typeof item.input === 'object'
          && ['ok', 'error', 'cached'].includes(item.status) && typeof item.durationMs === 'number'
        : ['user', 'assistant', 'thinking', 'notice', 'error', 'shell'].includes(item.kind) && typeof item.text === 'string'))
}

// The same recording follows child agents across awaits without mixing separate sessions.
const recording = new AsyncLocalStorage<Transcript>()
export const activeSessionTranscript = (): Transcript | undefined => recording.getStore()
export function withSessionTranscript<T>(transcript: Transcript, work: () => Promise<T>): Promise<T> {
  return recording.run(transcript, work)
}

/** Older sessions can recover the messages they retained, but cannot recreate discarded history. */
export function transcriptFromMessages(messages: ConversationMessage[]): TranscriptSnapshot {
  const transcript = createTranscript()
  const calls = new Map<string, { name: string; input: Record<string, unknown> }>()
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'text') {
        if (message.role === 'user') transcript.appendUser(block.text)
        else transcript.appendAssistant(block.text)
      } else if (block.type === 'tool_use') calls.set(block.id, block)
      else if (block.type === 'tool_result') {
        const call = calls.get(block.tool_use_id)
        transcript.recordTool({ name: call?.name ?? 'unknown', input: call?.input ?? {}, result: block.content, isError: block.is_error, cached: false, durationMs: 0 })
      }
    }
    if (message.role === 'assistant' && !message.content.some((block) => block.type === 'tool_use')) transcript.endTurn()
  }
  return transcript.snapshot()
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
    recordTool(event, actor) {
      push({
        kind: 'tool',
        id: nextId++,
        turn,
        name: event.name,
        input: redactArchiveValue(event.input) as Record<string, unknown>,
        status: event.isError ? 'error' : event.cached ? 'cached' : 'ok',
        result: event.result,
        durationMs: event.durationMs,
        actor,
        decision: event.assessment?.decision,
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
    snapshot() {
      return {
        turns: turn,
        items: list.filter((item) => item.kind !== 'thinking').map((item) => item.kind === 'tool'
          ? { ...item, input: redactArchiveValue(item.input) as Record<string, unknown>, result: redactSecrets(item.result) }
          : { ...item, text: redactSecrets(item.text) }),
      }
    },
    restore(snapshot) {
      if (!isTranscriptSnapshot(snapshot)) throw new Error('Invalid saved session transcript.')
      list.splice(0, list.length, ...structuredClone(snapshot.items))
      nextId = list.reduce((max, item) => Math.max(max, item.id + 1), 1)
      turn = snapshot.turns
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
            JSON.stringify(redactArchiveValue(item.input), null, 2),
            '',
            redactSecrets(item.result),
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
      return redactSecrets(out.join('\n'))
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
