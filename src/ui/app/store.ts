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
import { stripVTControlCharacters } from 'node:util'
import type { ToolEvent } from '../../agentLoop.ts'
import type { ProviderActivity } from '../../providers/types.ts'
import { redactRecord, redactSecrets, redactText, relativizeProjectPaths } from '../redact.ts'
import { isExploreTool } from './toolSummary.ts'
import { FLARE_MS } from './motion.ts'

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
  /**
   * A later paragraph of the same reply. Long answers are committed to
   * scrollback a finished paragraph at a time (see `stableCut`), so the part
   * still streaming stays small; continuations carry no leading `●`.
   */
  continuation?: boolean
}
export interface ThinkingItem {
  id: string
  kind: 'thinking'
  text: string
  streaming: boolean
  continuation?: boolean
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
  /** When the call finished — its dot lands bright and settles from here. */
  endedAt?: number
}
/** A run of consecutive read-only lookups, rendered as one line. */
export interface GroupItem {
  id: string
  kind: 'group'
  tools: ToolItem[]
}
export interface NoticeItem {
  id: string
  /** `receipt`: the line that closes a turn — "Worked for 25s · edited 1 file". */
  kind: 'notice' | 'error' | 'shell' | 'receipt'
  text: string
  /** When a lesson landed (`✦ learned: …`) — its mark flares once from here. */
  at?: number
  /** `receipt` only: how the turn ended, when it did not simply finish. */
  ending?: 'stopped' | 'failed'
}
/** The session header, printed once at the top of scrollback. */
export interface HeaderItem {
  id: string
  kind: 'header'
  version: string
  /** e.g. "dev mode". */
  greeting: string
  /** The working directory, `~`-relative when it can be. */
  location?: string
  lessons?: number
  /** Of those, how many a randomized trial has proven to help — or to hurt. */
  lessonsHelp?: number
  lessonsHurt?: number
  /** "mercury-2.5 · Mercury" — what answers in this session. */
  model?: string
}

export type Item = UserItem | AssistantItem | ThinkingItem | ToolItem | GroupItem | NoticeItem | HeaderItem

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

  header(info: Omit<HeaderItem, 'id' | 'kind'>): void
  appendUser(text: string): void
  assistantDelta(delta: string): void
  thinkingDelta(delta: string): void
  toolStart(call: { id: string; name: string; input: Record<string, unknown>; parentId?: string }): void
  toolEnd(event: ToolEvent & { id?: string }): void
  activity(activity: ProviderActivity): void
  notice(text: string): void
  /** The line that closes a turn — marked by how the turn ended. */
  receipt(text: string, ending?: 'done' | 'stopped' | 'failed'): void
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

/** Every tool call in `items`, with grouped lookups flattened back out. */
export function toolsOf(items: readonly Item[]): ToolItem[] {
  return items.flatMap((item) => (item.kind === 'tool' ? [item] : item.kind === 'group' ? item.tools : []))
}

const FENCE_LINE = /^\s{0,3}(?:`{3,}|~{3,})/

/**
 * Where a streaming reply can be cut so the part before it never changes
 * again: just past the last blank line that sits outside a code fence and has
 * real text after it. -1 when there is no such point yet.
 *
 * Ink repaints the whole live region every frame with a blind cursor-up; once
 * one streaming answer grows taller than the terminal that repaint lands in the
 * wrong place and duplicates the frame into scrollback. Committing finished
 * paragraphs as they complete keeps the live part to the paragraph in flight.
 */
export function stableCut(text: string): number {
  const lines = text.split('\n')
  let offset = 0
  let inFence = false
  const candidates: number[] = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!
    if (FENCE_LINE.test(line)) inFence = !inFence
    offset += line.length + 1
    if (!inFence && line.trim() === '' && i > 0 && i < lines.length - 1) candidates.push(offset)
  }
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const cut = candidates[i]!
    if (cut < text.length && text.slice(cut).trim() && text.slice(0, cut).trim()) return cut
  }
  return -1
}

/** Reasoning has no paragraph structure to speak of — any finished line is final. */
function thinkingCut(text: string): number {
  const at = text.lastIndexOf('\n')
  if (at <= 0 || !text.slice(at + 1).trim() || !text.slice(0, at).trim()) return -1
  return at + 1
}

/** Activity text keeps its line structure — a plan or a check list flattened into one run-on line is unreadable. */
/** A lesson elia just committed to memory — the one notice that flares. */
export function isLearnedLine(text: string): boolean {
  return text.startsWith('✦ learned:')
}

/** How much longer the newest flare in `items` has to run — the turn holds its close for it. */
export function flareHoldMs(items: readonly Item[], now = Date.now()): number {
  let hold = 0
  for (const item of items) {
    if (item.kind === 'notice' && item.at !== undefined) hold = Math.max(hold, item.at + FLARE_MS - now)
  }
  return Math.max(0, hold)
}

function activityText(activity: ProviderActivity): string {
  const raw = activity.detail ? `${activity.title}\n${activity.detail}` : activity.title
  const text = redactSecrets(relativizeProjectPaths(raw)).replace(/\r\n?/g, '\n').trim()
  const lines = text.split('\n').map((line) => line.trimEnd())
  const kept = lines.slice(0, 12)
  if (lines.length > kept.length) kept.push(`… ${lines.length - kept.length} more lines`)
  const joined = kept.join('\n')
  return statusMarked(activity, joined.length > 2_000 ? `${joined.slice(0, 1_999)}…` : joined)
}

/**
 * A warning or a failure keeps its meaning once it is a transcript line. The
 * status used to be dropped here, so "this turn stopped — /rewind 3 undoes it"
 * and "Verification failed (repair 1/2)" arrived as the same grey as
 * "Orienting". A leading mark is what the note renderer colours (`!` warning,
 * `✗` failure); `⚠` becomes `!` because it is double-width in some consoles.
 */
function statusMarked(activity: ProviderActivity, text: string): string {
  const leading = text.replace(/^⚠\s*/, '! ')
  if (/^[✓✗◐!▸]\s/.test(leading)) return leading
  if (activity.status === 'failed') return `✗ ${leading}`
  if (activity.status === 'warning' || activity.kind === 'warning') return `! ${leading}`
  return leading
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
  // `activity()`'s own repeat tracker, independent of `lastLive()`. A repair
  // loop interleaves a verification pass/fail line between review attempts,
  // so by the time the same verdict repeats, the earlier occurrence is almost
  // always no longer the live tail — flushSettled already swept it into
  // `committed`, which <Static> never re-renders. `lastLive()`-based
  // coalescing (below) only catches truly back-to-back repeats; this catches
  // the rest by printing a short pointer instead of the full block again.
  // Keyed by exact text (not just "the previous activity") so two different
  // messages that keep alternating — a verdict and a check-result line, say —
  // each get their own count instead of resetting each other.
  const RECENT_ACTIVITY_CAP = 8
  const recentActivityCounts = new Map<string, { count: number; pointerId?: string }>()
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
    if (item.kind === 'group') return item.tools.every((tool) => tool.status !== 'running')
    if (item.kind === 'assistant' || item.kind === 'thinking') return !item.streaming
    // A lesson's flare is still playing: printing it into scrollback now would
    // freeze it mid-frame.
    if (item.kind === 'notice' && item.at !== undefined) return Date.now() - item.at >= FLARE_MS
    return true // user / notice / error / shell / header never change after being added
  }
  const flushSettled = (): void => {
    // Migrate the settled prefix, but always leave the final live item in place:
    // it may be a streaming paragraph still repainting (or a lookup group that
    // the next call may still join), and keeping `live` non-empty during a turn
    // keeps `commit()`'s end-of-turn contract simple.
    let cut = 0
    while (cut < live.length - 1 && isSettled(live[cut]!)) cut += 1
    if (cut === 0) return
    committed = [...committed, ...live.slice(0, cut)]
    live = live.slice(cut)
  }

  /** Append a tool item — into the open lookup group when it is one. */
  const addTool = (tool: ToolItem): void => {
    const last = lastLive()
    if (isExploreTool(tool.name) && !tool.parentId) {
      if (last?.kind === 'group') {
        live = live.map((item) => (item === last ? { ...last, tools: [...last.tools, tool] } : item))
        return
      }
      live = [...live, { id: `g-${tool.id}`, kind: 'group', tools: [tool] }]
      return
    }
    live = [...live, tool]
  }

  /** Stream `delta` into the trailing item of `kind`, committing finished text as it goes. */
  const streamInto = (kind: 'assistant' | 'thinking', delta: string, cutAt: (text: string) => number): void => {
    const last = lastLive()
    if (last?.kind === kind && last.streaming) {
      const text = last.text + delta
      const cut = cutAt(text)
      if (cut > 0) {
        // The finished head settles (and flushes to <Static>); the tail keeps streaming.
        const head = { ...last, text: text.slice(0, cut).replace(/\s+$/, ''), streaming: false }
        const tail = { id: nextId(), kind, text: text.slice(cut), streaming: true, continuation: true } as Item
        live = [...live.slice(0, -1), head, tail]
      } else {
        live = live.map((item) => (item === last ? { ...last, text } : item))
      }
    } else {
      live = [...live, { id: nextId(), kind, text: delta, streaming: true } as Item]
    }
    changed()
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    header(info) {
      committed = [...committed, { id: nextId(), kind: 'header', ...info }]
      changed()
    },

    appendUser(text) {
      if (live.length === 0) turnBase = committed.length
      live = [...live, { id: nextId(), kind: 'user', text }]
      changed()
    },

    // An empty delta carries no content, and appending an item for one is not
    // harmless: it shatters the transcript. A stream that interleaves empty
    // `content` chunks between reasoning chunks (mercury-2.5 does) added an
    // empty assistant item between every reasoning token — each rendering as a
    // bare `● ` bullet, and each displacing the streaming thinking item from
    // the tail, so the *next* reasoning token could no longer append to it and
    // started a new `✻` block instead. The result was one word per line, down
    // the whole screen. Providers vary in how much of this they emit, so the
    // guard belongs here, where every provider passes through, rather than only
    // in the one known to do it.
    assistantDelta(delta) {
      if (delta.length === 0) return
      streamInto('assistant', delta, stableCut)
    },

    thinkingDelta(delta) {
      if (delta.length === 0) return
      streamInto('thinking', delta, thinkingCut)
    },

    toolStart(call) {
      // A new tool call ends the assistant's current streaming paragraph.
      live = live.map((item) => (item.kind === 'assistant' || item.kind === 'thinking' ? { ...item, streaming: false } : item))
      addTool({ id: call.id, kind: 'tool', name: call.name, input: redactRecord(call.input), status: 'running', parentId: call.parentId })
      changed()
    },

    toolEnd(event) {
      const status: ToolItem['status'] = event.isError ? 'error' : event.cached ? 'cached' : 'ok'
      // Redact once here, at ingestion — the same place `input` already gets
      // `redactRecord`'d — rather than in every render path that reads
      // `tool.result` (ShellBody, DiffBody, the expanded generic-result
      // branch…). `redactSecrets` (not `redactText`) so multiline diffs/shell
      // output keep their formatting and full length; only credential-shaped
      // substrings get replaced.
      const safeResult = redactSecrets(event.result)
      const isMatch = (item: ToolItem): boolean =>
        event.id ? item.id === event.id : item.name === event.name && item.status === 'running'
      const endedAt = Date.now()
      const finish = (item: ToolItem): ToolItem => ({ ...item, status, result: safeResult, durationMs: event.durationMs, endedAt })
      let matched = false
      live = live.map((item) => {
        if (matched) return item
        if (item.kind === 'tool' && isMatch(item)) {
          matched = true
          return finish(item)
        }
        if (item.kind === 'group') {
          const index = item.tools.findIndex(isMatch)
          if (index >= 0) {
            matched = true
            return { ...item, tools: item.tools.map((tool, i) => (i === index ? finish(tool) : tool)) }
          }
        }
        return item
      })
      if (!matched) {
        addTool({
          id: event.id ?? nextId(),
          kind: 'tool',
          name: event.name,
          input: redactRecord(event.input),
          status,
          result: safeResult,
          durationMs: event.durationMs,
        })
      }
      changed()
    },

    activity(activity) {
      const text = activityText(activity)
      // A repair loop emits the same warning on each attempt. Collapse an
      // immediately-repeated activity into one line with a ×N counter rather
      // than stacking identical rows in scrollback.
      const last = lastLive()
      if (last?.kind === 'notice') {
        const base = /^(.*?)(?:  ×\d+)?$/s.exec(last.text)?.[1]
        if (base === text) {
          const n = Number(/  ×(\d+)$/.exec(last.text)?.[1] ?? '1') + 1
          live = live.map((item) => (item === last ? { ...last, text: `${text}  ×${n}` } : item))
          // `last` is the line being counted, so it is also the one a later
          // out-of-order repeat should rewrite rather than duplicate.
          recentActivityCounts.set(text, { count: n, pointerId: last.id })
          changed()
          return
        }
      }
      // Not back-to-back, but still the same activity repeating (see comment
      // on `recentActivityCounts` above) — point at the earlier occurrence
      // instead of printing the full block again.
      //
      // The pointer has to be written *once* and then kept quiet. Appending a
      // fresh one per repeat is what turned a repeating phase into pages of
      // near-identical scrollback: the back-to-back check above compares
      // against the raw `text`, but a pointer line carries a
      // "  (same as before · ×N)" suffix, so it never matches its own output
      // and every repeat appended another line. Two alternating statuses
      // produced twelve lines where two were meant.
      const seen = recentActivityCounts.get(text)
      if (seen !== undefined) {
        const n = seen.count + 1
        const firstLine = text.split('\n')[0]!
        const pointerText = `${firstLine}  (same as before · ×${n})`
        // Still on screen: rewrite it in place so the count stays truthful.
        const pointer = seen.pointerId === undefined
          ? undefined
          : live.find((item) => item.id === seen.pointerId && item.kind === 'notice')
        if (pointer) {
          recentActivityCounts.set(text, { ...seen, count: n })
          live = live.map((item) => (item === pointer ? { ...item, text: pointerText } : item))
          changed()
          return
        }
        // Already flushed into <Static>, which never re-renders — so it cannot
        // be corrected, and printing another copy only repeats what the
        // operator has already read. Keep counting silently; the live status
        // line is what shows that the phase is still going.
        if (seen.pointerId !== undefined) {
          recentActivityCounts.set(text, { ...seen, count: n })
          return
        }
        const id = nextId()
        recentActivityCounts.set(text, { count: n, pointerId: id })
        live = [...live, { id, kind: 'notice', text: pointerText }]
        changed()
        return
      }
      recentActivityCounts.set(text, { count: 1 })
      if (recentActivityCounts.size > RECENT_ACTIVITY_CAP) {
        const oldest = recentActivityCounts.keys().next().value
        if (oldest !== undefined) recentActivityCounts.delete(oldest)
      }
      live = [...live, isLearnedLine(text) ? { id: nextId(), kind: 'notice', text, at: Date.now() } : { id: nextId(), kind: 'notice', text }]
      changed()
    },

    notice(raw) {
      // Notices are plain text; the note renderer colours them. Slash commands
      // built for the readline REPL still hand over `theme.ts` colour codes,
      // which Ink cannot see through — the wrapper counted them as visible
      // columns, so a coloured line wrapped early and broke on narrow terminals.
      const text = stripVTControlCharacters(raw)
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
    receipt(text, ending = 'done') {
      live = [...live, ending === 'done' ? { id: nextId(), kind: 'receipt', text } : { id: nextId(), kind: 'receipt', text, ending }]
      changed()
    },
    error(text) {
      // The `✗` mark already says "error"; a leading "Error:" only repeats it.
      // Redacted at ingestion like every other item — provider errors can echo
      // request details back.
      live = [...live, { id: nextId(), kind: 'error', text: redactSecrets(text.replace(/^(?:Error:\s*)+/, '')) }]
      changed()
    },
    shell(command, output) {
      // `!<command>` shell-escape output — redact at ingestion, same as tool
      // results above, so the transcript item is already safe wherever it's
      // rendered (TranscriptItem's `case 'shell'`, `/export`'s toMarkdown()).
      live = [...live, { id: nextId(), kind: 'shell', text: redactSecrets(`$ ${command}\n${output}`) }]
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
      recentActivityCounts.clear()
      changed()
    },

    lastTool(n) {
      const tools = toolsOf([...committed, ...live])
      return n === undefined ? tools[tools.length - 1] : tools[n]
    },
    turnItems: () => [...committed.slice(turnBase), ...live],
    toolCount() {
      return toolsOf([...committed, ...live]).length
    },

    toMarkdown(title) {
      const all = [...committed, ...live]
      const out: string[] = [`# ${title ?? 'elia session'}`, '']
      let renderedTurn = -1
      let seenUser = false
      const pushTool = (item: ToolItem) =>
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
      for (const item of all) {
        if (item.kind === 'header') continue
        if (item.kind === 'user') {
          renderedTurn += 1
          seenUser = true
          out.push(`## Turn ${renderedTurn + 1}`, '', '**You:**', '', item.text, '')
        } else if (item.kind === 'assistant') {
          if (item.continuation) out.push(item.text, '')
          else out.push('**elia:**', '', item.text, '')
        } else if (item.kind === 'thinking') {
          out.push('<details><summary>Reasoning</summary>', '', item.text, '', '</details>', '')
        } else if (item.kind === 'tool') {
          pushTool(item)
        } else if (item.kind === 'group') {
          for (const tool of item.tools) pushTool(tool)
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
      recentActivityCounts.clear()
      changed()
    },
  }
}
