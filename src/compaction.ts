import type { ChatMessage, ContentBlock } from './providers/types.ts'
import { archiveEpisode } from './ledger.ts'
import { formatTokenCount } from './usage.ts'
import { gold } from './ui/theme.ts'
import { compactionThresholdFor } from './contextWindow.ts'

/**
 * Auto-compacts a long-running conversation so a growing `--continue` session
 * (or a very long single run) doesn't keep re-attending an ever-larger history
 * forever and doesn't eventually blow the provider's context window. Prompt
 * caching already makes an unchanged prefix cheap to *re-send*; it does not
 * make the history smaller or finite. Compaction is the fix for the ceiling
 * caching doesn't touch.
 */

/** Rough chars-per-token; good enough for a trigger threshold, not for billing. */
const CHARS_PER_TOKEN_ESTIMATE = 4
/**
 * Fallback trigger for callers that cannot say which model is in use.
 *
 * Kept as the historical constant so nothing silently gets a *smaller* working
 * window than it had; callers that know the model should pass its own budget
 * from `contextWindow.ts` instead, which is larger wherever the model can
 * actually hold more.
 */
export const COMPACTION_TOKEN_THRESHOLD = compactionThresholdFor('')
/** Always keep at least this many of the most recent messages verbatim. */
const KEEP_RECENT_MESSAGES = 12

export function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0
  for (const message of messages) {
    for (const block of message.content) chars += blockChars(block)
  }
  return Math.ceil(chars / CHARS_PER_TOKEN_ESTIMATE)
}

function blockChars(block: ContentBlock): number {
  switch (block.type) {
    case 'text':
      return block.text.length
    case 'thinking':
      return block.text.length
    case 'redacted_thinking':
      return block.data.length
    case 'tool_use':
      return block.name.length + JSON.stringify(block.input).length
    case 'tool_result':
      return block.content.length
  }
}

/**
 * Finds the latest message at or before `beforeIndex` that safely starts a
 * fresh turn — a plain user text message with no tool_result blocks. Cutting
 * anywhere else would strand a tool_use without its result a few messages
 * later, which every provider in this codebase rejects outright. Returns
 * undefined if no safe boundary exists in range (e.g. one very long turn with
 * no intervening plain user message).
 */
export function findSafeCutIndex(messages: ChatMessage[], beforeIndex: number): number | undefined {
  for (let i = Math.min(beforeIndex, messages.length - 1); i >= 1; i--) {
    const message = messages[i]!
    if (message.role === 'user' && message.content.every((block) => block.type === 'text')) return i
  }
  return undefined
}

function foldSummaryIn(messages: ChatMessage[], cutIndex: number, archivedCount: number, summary: string): boolean {
  const boundary = messages[cutIndex]
  if (!boundary) return false
  // Fold the summary into the cut point's own message rather than inserting a
  // new standalone one — Anthropic-family APIs expect strict user/assistant
  // alternation, and a synthetic user message next to a real one would violate it.
  const summaryBlock: ContentBlock = {
    type: 'text',
    text: `## Summary of earlier conversation (auto-compacted, ${archivedCount} messages)\n${summary}`,
  }
  messages.splice(0, cutIndex + 1, { role: 'user', content: [summaryBlock, ...boundary.content] })
  return true
}

/**
 * Compacts `messages` in place if they've grown past the threshold. Blocks on
 * the archive model call — kept for callers that want the whole thing done
 * before they continue; the agent loop uses {@link beginCompaction} instead so
 * the archive doesn't stall a turn.
 */
export async function maybeCompact(messages: ChatMessage[]): Promise<boolean> {
  const pending = beginCompaction(messages)
  if (!pending) return false
  return pending.flush(messages)
}

export interface PendingCompaction {
  /** True once the background archive has finished — successfully or not. */
  readonly settled: boolean
  /**
   * If the archive is done and produced a summary, fold it into `messages` and
   * return true. Still running, or failed/empty: return false. Idempotent.
   */
  apply(messages: ChatMessage[]): boolean
  /** Await the archive, then apply it. For end-of-turn, off the latency path. */
  flush(messages: ChatMessage[]): Promise<boolean>
}

/**
 * Starts compaction in the background when the history is over threshold, and
 * hands back a handle to fold the summary in once it is ready. The archive is a
 * full (fast-tier) model call; running it inline stalled the first step of every
 * turn in a long `--continue` session. Prompt caching already makes re-sending
 * the un-compacted history cheap for one more turn, so the fix is to overlap the
 * archive with that turn instead of blocking on it.
 *
 * `cutIndex` stays valid for the life of the handle: the loop only ever appends
 * past it, never rewrites the stable prefix the archive covers.
 */
export function beginCompaction(messages: ChatMessage[], threshold = COMPACTION_TOKEN_THRESHOLD): PendingCompaction | undefined {
  if (messages.length <= KEEP_RECENT_MESSAGES) return undefined
  if (estimateTokens(messages) < threshold) return undefined

  const cutIndex = findSafeCutIndex(messages, messages.length - KEEP_RECENT_MESSAGES)
  if (cutIndex === undefined || cutIndex === 0) return undefined

  const toArchive = messages.slice(0, cutIndex)
  const archivedCount = toArchive.length

  // archiveEpisode both returns the prose fold-in AND, when a session is active
  // (see ledger.ts), persists the full structured episode to disk — so what
  // leaves the live window is never actually gone, just no longer taking up
  // prompt space. That's the difference between this and a shrink-and-forget
  // compactor.
  let settledSummary: string | undefined
  let settled = false
  let applied = false
  const promise = archiveEpisode(toArchive)
    .then((summary) => {
      settledSummary = summary ?? undefined
    })
    .catch(() => {
      settledSummary = undefined
    })
    .finally(() => {
      settled = true
    })

  const apply = (msgs: ChatMessage[]): boolean => {
    if (applied || !settled || !settledSummary) return false
    applied = foldSummaryIn(msgs, cutIndex, archivedCount, settledSummary)
    return applied
  }

  return {
    get settled() {
      return settled
    },
    apply,
    async flush(msgs) {
      await promise
      return apply(msgs)
    },
  }
}

/**
 * A terminal status line showing how much of the live window is in use, and —
 * once at least one episode has been archived — that the bound doesn't mean
 * anything is actually lost. Deliberately only claims "effectively ∞" once
 * there's real archived history to point to, never as a standing promise.
 */
export function renderContextStatus(messages: ChatMessage[], archivedEpisodes: number, threshold = COMPACTION_TOKEN_THRESHOLD): string {
  const used = estimateTokens(messages)
  const pct = Math.min(100, Math.round((used / threshold) * 100))
  const base = `context: ${formatTokenCount(used)} / ${formatTokenCount(threshold)} tokens (${pct}%)`

  if (archivedEpisodes === 0) return base
  const episodeWord = archivedEpisodes === 1 ? 'episode' : 'episodes'
  return `${base} · ${archivedEpisodes} ${episodeWord} archived, recallable — effectively ${gold('∞')}`
}
