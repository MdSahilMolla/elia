import type { ChatMessage, ContentBlock } from './providers/types.ts'
import { archiveEpisode } from './ledger.ts'
import { formatTokenCount } from './usage.ts'
import { gold } from './ui/theme.ts'

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
/** Compact once the tracked history crosses this many estimated tokens. Conservative on purpose — elia is multi-provider, and some configurable models have far smaller context windows than the big frontier ones. */
export const COMPACTION_TOKEN_THRESHOLD = 30_000
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

/**
 * Compacts `messages` in place if they've grown past the threshold, folding a
 * summary of everything before a safe cut point into that cut point's own
 * message rather than inserting a new standalone one — Anthropic-family APIs
 * expect strict user/assistant alternation, and a synthetic user message
 * sitting next to a real one would violate that. Returns whether it fired.
 */
export async function maybeCompact(messages: ChatMessage[]): Promise<boolean> {
  if (messages.length <= KEEP_RECENT_MESSAGES) return false
  if (estimateTokens(messages) < COMPACTION_TOKEN_THRESHOLD) return false

  const cutIndex = findSafeCutIndex(messages, messages.length - KEEP_RECENT_MESSAGES)
  if (cutIndex === undefined || cutIndex === 0) return false

  const toArchive = messages.slice(0, cutIndex)
  // archiveEpisode both returns the prose fold-in below AND, when a session is
  // active (see ledger.ts), persists the full structured episode to disk — so
  // what leaves the live window here is never actually gone, just no longer
  // taking up prompt space. That's the difference between this and a plain
  // shrink-and-forget compactor.
  const summary = await archiveEpisode(toArchive)
  if (!summary) return false

  const boundary = messages[cutIndex]!
  const summaryBlock: ContentBlock = {
    type: 'text',
    text: `## Summary of earlier conversation (auto-compacted, ${toArchive.length} messages)\n${summary}`,
  }

  messages.splice(0, cutIndex + 1, { role: 'user', content: [summaryBlock, ...boundary.content] })
  return true
}

/**
 * A terminal status line showing how much of the live window is in use, and —
 * once at least one episode has been archived — that the bound doesn't mean
 * anything is actually lost. Deliberately only claims "effectively ∞" once
 * there's real archived history to point to, never as a standing promise.
 */
export function renderContextStatus(messages: ChatMessage[], archivedEpisodes: number): string {
  const used = estimateTokens(messages)
  const pct = Math.min(100, Math.round((used / COMPACTION_TOKEN_THRESHOLD) * 100))
  const base = `context: ${formatTokenCount(used)} / ${formatTokenCount(COMPACTION_TOKEN_THRESHOLD)} tokens (${pct}%)`

  if (archivedEpisodes === 0) return base
  const episodeWord = archivedEpisodes === 1 ? 'episode' : 'episodes'
  return `${base} · ${archivedEpisodes} ${episodeWord} archived, recallable — effectively ${gold('∞')}`
}
