// The transcript store behind the Ink REPL. Split into two lists on purpose:
//
//  - `committed` holds finished turns. It only ever grows, so Ink's <Static>
//    can render each item exactly once and never touch it again — that is what
//    keeps a long session cheap and the scrollback stable.
//  - `live` holds the in-progress turn: the streaming assistant message, the
//    reasoning block, and the tool cards that are still running or just landed.
//    This region re-renders every frame.
//
// On turn end `commit()` moves everything from `live` into `committed` and the
// live region empties.
import type { ToolEvent } from '../../agentLoop.ts'
import type { ProviderActivity } from '../../providers/types.ts'
import { redactRecord, redactText } from '../redact.ts'

export interface UserItem {
  id: string
  kind: 'user'
  text: string
}
export interface AssistantItem {
  id: string
  kind: 'assistant'
  text: string
  streaming: boolean
}
export interface ThinkingItem {
  id: string
  kind: 'thinking'
  text: string
  streaming: boolean
}
export interface ToolItem {
  id: string
  kind: 'tool'
  name: string
  input: Record<string, unknown>
  status: 'running' | 'ok' | 'error' | 'cached'
  result?: string
  durationMs?: number
  parentId?: string
}
export interface NoticeItem {
  id: string
  kind: 'notice' | 'error' | 'shell'
  text: string
}

export type Item = UserItem | AssistantItem | ThinkingItem | ToolItem | NoticeItem

export interface Snapshot {
  committed: readonly Item[]
  live: readonly Item[]
  /** Completed user turns. */
  turn: number
  /** Bumped on every mutation — lets React bail out of renders cheaply. */
  version: number
}

export interface TranscriptStore {
  getSnapshot(): Snapshot
  subscribe(listener: () => void): () => void

  appendUser(text: string): void
  assistantDelta(delta: string): void
  thinkingDelta(delta: string): void
  toolStart(call: { id: string; name: string; input: Record<string, unknown>; parentId?: string }): void
  toolEnd(event: ToolEvent & { id?: string }): void
  activity(activity: ProviderActivity): void
  notice(text: string): void
  error(text: string): void
  shell(command: string, output: string): void

  /** Freeze the live region into scrollback and start a new turn. */
  commit(): void
  /** The most recent tool item across the whole session (for `/expand`). */
  lastTool(n?: number): ToolItem | undefined
  toolCount(): number
  /** Everything belonging to the in-progress turn — `committed` items flushed
   * mid-turn plus whatever is still `live`. Empty once `commit()` has run. */
  turnItems(): readonly Item[]
  toMarkdown(title?: string): string
  reset(): void
}

export function createTranscriptStore(): TranscriptStore {
  let committed: Item[] = []
  let live: Item[] = []
  // Index into `committed` where the current turn's items begin. `flushSettled`
  // moves live items into `committed` mid-turn, so "this turn's items" is
  // `committed.slice(turnBase)` followed by whatever is still `live`.
  let turnBase = 0
  let turn = 0
  let version = 0
  let idSeq = 0
  let snapshot: Snapshot = { committed, live, turn, version }
  const listeners = new Set<() => void>()

  const nextId = (): string => `i${++idSeq}`

  const changed = (): void => {
    flushSettled()
    version += 1
    snapshot = { committed, live, turn, version }
    for (const listener of listeners) listener()
  }

  const lastLive = (): Item | undefined => live[live.length - 1]

  // Ink re-renders the whole `live` region every frame and repaints it with a
  // blind cursor-up. Once that region grows past the viewport height the repaint
  // miscounts and the scrollback jumps / duplicates. So during a turn, keep
  // migrating everything that has *settled* — finished tool cards, paragraphs
  // that stopped streaming, notices — into `committed`, where <Static> prints it
  // once and never touches it again. Stops at the first item still in motion so
  // ordering is never broken; `commit()` at turn end just flushes the tail.
  const isSettled = (item: Item): boolean => {
    if (item.kind === 'tool') return item.status !== 'running'
    if (item.kind === 'assistant' || item.kind === 'thinking') return !item.streaming
    return true // user / notice / error / shell never change after being added
  }
  const flushSettled = (): void => {
    // Migrate the settled prefix, but always leave the final live item in place:
    // it may be a streaming paragraph still repainting, and keeping `live`
    // non-empty during a turn keeps `commit()`'s end-of-turn contract simple.
    let cut = 0
    while (cut < live.length - 1 && isSettled(live[cut]!)) cut += 1
    if (cut === 0) return
    committed = [...committed, ...live.slice(0, cut)]
    live = live.slice(cut)
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    appendUser(text) {
      if (live.length === 0) turnBase = committed.length
      live = [...live, { id: nextId(), kind: 'user', text }]
      changed()
    },

    assistantDelta(delta) {
      const last = lastLive()
      if (last?.kind === 'assistant' && last.streaming) {
        live = live.map((item) => (item === last ? { ...last, text: last.text + delta } : item))
      } else {
        live = [...live, { id: nextId(), kind: 'assistant', text: delta, streaming: true }]
      }
      changed()
    },

    thinkingDelta(delta) {
      const last = lastLive()
      if (last?.kind === 'thinking' && last.streaming) {
        live = live.map((item) => (item === last ? { ...last, text: last.text + delta } : item))
      } else {
        live = [...live, { id: nextId(), kind: 'thinking', text: delta, streaming: true }]
      }
      changed()
    },

    toolStart(call) {
      // A new tool call ends the assistant's current streaming paragraph.
      live = live.map((item) => (item.kind === 'assistant' || item.kind === 'thinking' ? { ...item, streaming: false } : item))
      live = [
        ...live,
        { id: call.id, kind: 'tool', name: call.name, input: redactRecord(call.input), status: 'running', parentId: call.parentId },
      ]
      changed()
    },

    toolEnd(event) {
      const status: ToolItem['status'] = event.isError ? 'error' : event.cached ? 'cached' : 'ok'
      let matched = false
      live = live.map((item) => {
        if (matched || item.kind !== 'tool') return item
        const isMatch = event.id ? item.id === event.id : item.name === event.name && item.status === 'running'
        if (!isMatch) return item
        matched = true
        return { ...item, status, result: event.result, durationMs: event.durationMs }
      })
      if (!matched) {
        live = [
          ...live,
          {
            id: event.id ?? nextId(),
            kind: 'tool',
            name: event.name,
            input: redactRecord(event.input),
            status,
            result: event.result,
            durationMs: event.durationMs,
          },
        ]
      }
      changed()
    },

    activity(activity) {
      const text = redactText(activity.detail ? `${activity.title}\n${activity.detail}` : activity.title, 2_000)
      // A repair loop emits the same warning on each attempt. Collapse an
      // immediately-repeated activity into one line with a ×N counter rather
      // than stacking identical rows in scrollback.
      const last = lastLive()
      if (last?.kind === 'notice') {
        const base = /^(.*?)(?:  ×\d+)?$/s.exec(last.text)?.[1]
        if (base === text) {
          const n = Number(/  ×(\d+)$/.exec(last.text)?.[1] ?? '1') + 1
          live = live.map((item) => (item === last ? { ...last, text: `${text}  ×${n}` } : item))
          changed()
          return
        }
      }
      live = [...live, { id: nextId(), kind: 'notice', text }]
      changed()
    },

    notice(text) {
      // A hammered key (Esc on a turn that won't stop) would otherwise print the
      // same line 20 times. Collapse an immediately-repeated notice into one
      // line with a ×N counter.
      const last = lastLive()
      if (last?.kind === 'notice') {
        const base = /^(.*?)(?:  ×\d+)?$/s.exec(last.text)?.[1]
        if (base === text) {
          const n = Number(/  ×(\d+)$/.exec(last.text)?.[1] ?? '1') + 1
          live = live.map((item) => (item === last ? { ...last, text: `${text}  ×${n}` } : item))
          changed()
          return
        }
      }
      live = [...live, { id: nextId(), kind: 'notice', text }]
      changed()
    },
    error(text) {
      live = [...live, { id: nextId(), kind: 'error', text }]
      changed()
    },
    shell(command, output) {
      live = [...live, { id: nextId(), kind: 'shell', text: `$ ${command}\n${output}` }]
      changed()
    },

    commit() {
      if (live.length === 0) return
      const frozen = live.map((item) =>
        item.kind === 'assistant' || item.kind === 'thinking' ? { ...item, streaming: false } : item,
      )
      committed = [...committed, ...frozen]
      live = []
      turn += 1
      changed()
    },

    lastTool(n) {
      const tools = [...committed, ...live].filter((item): item is ToolItem => item.kind === 'tool')
      return n === undefined ? tools[tools.length - 1] : tools[n]
    },
    turnItems: () => [...committed.slice(turnBase), ...live],
    toolCount() {
      return [...committed, ...live].filter((item) => item.kind === 'tool').length
    },

    toMarkdown(title) {
      const all = [...committed, ...live]
      const out: string[] = [`# ${title ?? 'elia session'}`, '']
      let renderedTurn = -1
      let seenUser = false
      for (const item of all) {
        if (item.kind === 'user') {
          renderedTurn += 1
          seenUser = true
          out.push(`## Turn ${renderedTurn + 1}`, '', '**You:**', '', item.text, '')
        } else if (item.kind === 'assistant') {
          out.push('**elia:**', '', item.text, '')
        } else if (item.kind === 'thinking') {
          out.push('<details><summary>Reasoning</summary>', '', item.text, '', '</details>', '')
        } else if (item.kind === 'tool') {
          out.push(
            `<details><summary>🔧 ${item.name} · ${item.status}</summary>`,
            '',
            '```',
            redactText(item.result ?? '(no output)', 8_000),
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
      if (!seenUser) out.push('_(no turns yet)_')
      return out.join('\n')
    },

    reset() {
      committed = []
      live = []
      turnBase = 0
      turn = 0
      idSeq = 0
      changed()
    },
  }
}
