import type { ChatMessage, ContentBlock } from './providers/types.ts'

/**
 * Keeps the conversation that is re-sent on every model call from carrying
 * what the model no longer needs. Measured over 58 saved sessions (2026-09-30):
 * tool results were 1.78M characters, 70% of them more than 16 messages old
 * and still re-sent on every later step; `write_file` results alone were 416k,
 * because a created file came back to the model as a diff of the content it had
 * just written; and write_file inputs kept every file's full text in the
 * history long after it was on disk.
 *
 * Only what is sent to the model changes. The conversation elia keeps, the
 * saved session, the compaction archive, the terminal, the action ledger and
 * the transcript all keep the full text.
 */

/** Opens every note elia leaves where it left something out. */
const ELIDED = '[elia: '

/**
 * The model's copy of a tool result, before the size bound. A newly created
 * file's add-only diff repeats, line for line, the `content` the model wrote in
 * the same call; the model gets the summary line (path, line counts, where it
 * landed) and any diagnostics. The terminal still shows the diff.
 */
export function modelViewOfResult(name: string, result: string, isError: boolean): string {
  if (isError || name !== 'write_file' || !result.startsWith('Created ')) return result
  return result.replace(/\n```diff\n[\s\S]*?\n```/, '')
}

/**
 * Tools whose output can be had again by re-running them (the file is still on
 * disk, the command can run again, the page can be fetched again). Only these
 * are shortened once old; a sub-agent's report or a recorded decision is not
 * reproducible and is never touched.
 */
const REPRODUCIBLE_TOOLS = new Set([
  'read_file', 'grep', 'list_files', 'find_symbol', 'run_command', 'run_program', 'process', 'web_search', 'web_fetch',
  'paper', 'knowledge', 'browser', 'write_file', 'edit_file', 'project_profile', 'environment', 'lsp_refactor', 'github', 'database',
])

export interface HistoryTrimOptions {
  /** Tool rounds (assistant messages that called tools) at the end kept whole. */
  keepRounds?: number
  /** Results longer than this, once old, are cut to their two ends. */
  maxOldResultChars?: number
  /** How much of an old result is kept, split between its start and its end. */
  keepChars?: number
  /**
   * Trim only when at least this many characters would be saved. Every trim
   * rewrites an early part of the conversation, which a provider that caches
   * the prefix has to read again at full price; batching keeps that rare.
   */
  minSavingChars?: number
}

const DEFAULTS: Required<HistoryTrimOptions> = { keepRounds: 6, maxOldResultChars: 2_500, keepChars: 1_200, minSavingChars: 12_000 }

/** What the model is sent in place of one block: a result's text, or a write_file call's content. */
type Trim = { kind: 'result' | 'input'; text: string }

export interface HistoryTrimmer {
  /**
   * Decides what else to leave out, given the conversation as it stands. New
   * cuts are taken only as a batch worth `minSavingChars`; earlier ones stay
   * decided, so what is sent changes rarely. Returns the characters the new
   * cuts save (0 when it waited).
   */
  update(messages: ChatMessage[]): number
  /** The conversation to send the model: `messages` with the decided cuts applied. `messages` is not changed. */
  view(messages: ChatMessage[]): ChatMessage[]
}

/**
 * Leaves old, reproducible content out of what the model is sent. The
 * conversation itself is never changed: the saved session, a resumed one, and
 * the compaction archive all keep every result in full.
 *
 * Three cuts, all outside the last `keepRounds` tool rounds:
 * - a read_file result that a later identical read_file (or a write_file of
 *   the same path) replaced: the later one is what is true;
 * - any other long reproducible result: cut to its two ends, with a note
 *   saying how to get the rest;
 * - write_file `content` already on disk: replaced by a note.
 */
export function createHistoryTrimmer(options: HistoryTrimOptions = {}): HistoryTrimmer {
  const opts = { ...DEFAULTS, ...options }
  // Keyed by tool_use id, which survives compaction folding earlier messages away.
  const trims = new Map<string, Trim>()
  const key = (kind: Trim['kind'], id: string) => `${kind}:${id}`

  const update = (messages: ChatMessage[]): number => {
    // Where the protected tail begins: the keepRounds-th tool-calling assistant message from the end.
    let rounds = 0
    let tailStart = messages.length
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]!
      if (message.role === 'assistant' && message.content.some((block) => block.type === 'tool_use')) {
        rounds += 1
        tailStart = index
        if (rounds >= opts.keepRounds) break
      }
    }
    if (rounds < opts.keepRounds) return 0

    const calls = new Map<string, { name: string; input: Record<string, unknown>; at: number }>()
    const succeeded = new Set<string>()
    messages.forEach((message, at) => {
      for (const block of message.content) {
        if (block.type === 'tool_use') calls.set(block.id, { name: block.name, input: block.input, at })
        else if (block.type === 'tool_result' && !block.is_error) succeeded.add(block.tool_use_id)
      }
    })

    // For each path, the last message index at which it was read with the same input, or rewritten whole.
    const readKey = (input: Record<string, unknown>) => JSON.stringify([input.path, input.offset ?? null, input.limit ?? null])
    const lastRead = new Map<string, number>()
    const lastWrite = new Map<string, number>()
    for (const [id, { name, input, at }] of calls) {
      if (typeof input.path !== 'string') continue
      if (name === 'read_file') lastRead.set(readKey(input), Math.max(lastRead.get(readKey(input)) ?? -1, at))
      if (name === 'write_file' && succeeded.has(id)) lastWrite.set(input.path, Math.max(lastWrite.get(input.path) ?? -1, at))
    }

    const shortened = (content: string, call: { name: string; input: Record<string, unknown> }, at: number, isError: boolean): string | undefined => {
      const path = typeof call.input.path === 'string' ? call.input.path : undefined
      if (call.name === 'read_file' && path && !isError) {
        const reread = (lastRead.get(readKey(call.input)) ?? -1) > at
        const rewritten = (lastWrite.get(path) ?? -1) > at
        if (reread || rewritten) return `${ELIDED}this earlier read of ${path} was replaced by a later ${reread ? 'read' : 'write'} of it; ${content.length} characters left out]`
      }
      if (content.length <= opts.maxOldResultChars) return undefined
      // Both ends: a command's errors and summary are at its end, a search's best hits at its start.
      const half = Math.floor(opts.keepChars / 2)
      const omitted = content.length - 2 * half
      return `${content.slice(0, half)}\n${ELIDED}${omitted} characters from the middle of this older ${call.name} result were left out to keep the conversation small; run it again if you need them]\n${content.slice(-half)}`
    }

    const pending = new Map<string, Trim>()
    let saving = 0
    for (let at = 0; at < tailStart; at += 1) {
      for (const block of messages[at]!.content) {
        // Only a write that landed: a failed one's content is nowhere else.
        if (block.type === 'tool_use' && block.name === 'write_file' && typeof block.input.content === 'string' && succeeded.has(block.id)) {
          const content = block.input.content
          if (content.length <= opts.maxOldResultChars || trims.has(key('input', block.id))) continue
          const text = `${ELIDED}${content.length} characters written to ${String(block.input.path)} left out of the history; the file is on disk, read_file it if you need it]`
          pending.set(key('input', block.id), { kind: 'input', text })
          saving += content.length - text.length
          continue
        }
        if (block.type !== 'tool_result' || trims.has(key('result', block.tool_use_id))) continue
        const call = calls.get(block.tool_use_id)
        if (!call || !REPRODUCIBLE_TOOLS.has(call.name)) continue
        const text = shortened(block.content, call, at, block.is_error)
        if (text === undefined || text.length >= block.content.length) continue
        pending.set(key('result', block.tool_use_id), { kind: 'result', text })
        saving += block.content.length - text.length
      }
    }
    if (saving < opts.minSavingChars) return 0
    for (const [id, trim] of pending) trims.set(id, trim)
    return saving
  }

  const view = (messages: ChatMessage[]): ChatMessage[] => {
    if (trims.size === 0) return messages
    return messages.map((message) => {
      let changed = false
      const content = message.content.map((block): ContentBlock => {
        if (block.type === 'tool_result') {
          const trim = trims.get(key('result', block.tool_use_id))
          if (trim) { changed = true; return { ...block, content: trim.text } }
        } else if (block.type === 'tool_use') {
          const trim = trims.get(key('input', block.id))
          if (trim) { changed = true; return { ...block, input: { ...block.input, content: trim.text } } }
        }
        return block
      })
      return changed ? { ...message, content } : message
    })
  }

  return { update, view }
}

/**
 * The trimmer for one conversation. The same array is handed to every turn of
 * a session, so its cuts carry over from turn to turn and what is sent stays
 * the same prefix instead of being re-decided each turn.
 */
const trimmers = new WeakMap<ChatMessage[], HistoryTrimmer>()
export function historyTrimmerFor(messages: ChatMessage[], options?: HistoryTrimOptions): HistoryTrimmer {
  let trimmer = trimmers.get(messages)
  if (!trimmer) trimmers.set(messages, (trimmer = createHistoryTrimmer(options)))
  return trimmer
}

/**
 * Whether to trim history for a provider. Same rule as lazy tools: not for
 * Anthropic by default, whose cached history is re-read at a tenth of the price
 * and would be re-written on every trim. `ELIA_TRIM_HISTORY=on|off` overrides.
 */
export function historyTrimEnabled(providerKind: string | undefined, env: Record<string, string | undefined> = process.env): boolean {
  const setting = env.ELIA_TRIM_HISTORY?.trim().toLowerCase()
  if (setting === 'off' || setting === '0' || setting === 'false') return false
  if (setting === 'on' || setting === '1' || setting === 'true') return true
  return providerKind !== 'anthropic'
}
