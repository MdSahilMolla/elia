import { basename } from 'node:path'
import type { BrainItem } from './store.ts'

/**
 * Per-file knowledge cards: everything the brain has accumulated about one
 * path, across every session, composed into a few lines. Injected into the
 * system prompt when a turn is about to work on that file — so elia starts
 * with what past sessions learned instead of rediscovering it.
 *
 * Derived on demand from `loadBrainItems()`; nothing is stored.
 */

const MAX_LINES_PER_CARD = 6
const MAX_CHARS_PER_LINE = 240

export interface KnowledgeCard {
  path: string
  lines: string[]
}

function truncate(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length > MAX_CHARS_PER_LINE ? `${collapsed.slice(0, MAX_CHARS_PER_LINE - 1)}…` : collapsed
}

function concernsPath(item: BrainItem, path: string): boolean {
  const base = basename(path).toLowerCase()
  return item.paths.some((p) => p === path || basename(p).toLowerCase() === base)
}

/**
 * Builds the card for one path. Rationale first (the authoritative "why"),
 * then the most recent episodes that touched the file, then notes — capped so
 * a hot file can't flood the prompt.
 */
export function buildCard(items: BrainItem[], path: string): KnowledgeCard | undefined {
  const relevant = items.filter((item) => concernsPath(item, path))
  if (relevant.length === 0) return undefined

  const order: Record<BrainItem['kind'], number> = { rationale: 0, note: 1, episode: 2, lesson: 3 }
  const lines = relevant
    .slice()
    .sort((a, b) => (order[a.kind] - order[b.kind]) || (b.at - a.at))
    .slice(0, MAX_LINES_PER_CARD)
    .map((item) => `- ${truncate(item.render)}`)

  return { path, lines }
}

/** A system-prompt section for every active path that has a card. Empty string when none do. */
export function renderCards(items: BrainItem[], activePaths: string[]): string {
  const seen = new Set<string>()
  const cards: KnowledgeCard[] = []
  for (const path of activePaths) {
    const base = basename(path).toLowerCase()
    if (seen.has(base)) continue
    seen.add(base)
    const card = buildCard(items, path)
    if (card) cards.push(card)
  }
  if (cards.length === 0) return ''

  const blocks = cards.map((card) => `### ${card.path}\n${card.lines.join('\n')}`)
  return `\n\n## What elia already knows about the files in play (from earlier sessions — trust it before re-deriving)\n${blocks.join('\n\n')}`
}
