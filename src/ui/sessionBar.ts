import { terminalWidth, visibleWidth } from './layout.ts'
import type { SessionStatus } from '../session/types.ts'

export interface SessionBarItem {
  name: string
  status: SessionStatus
  lastTask?: string
}

/**
 * One single-width mark per status. `running` and `waiting-input` used to share
 * `●`, so a session that needed you looked exactly like one that was busy, and
 * `blocked` was `⚠` — East-Asian-ambiguous, two columns wide in some consoles,
 * which throws the whole row's width math off.
 */
export function statusGlyph(status: SessionStatus): '●' | '○' | '?' | '!' | '✓' | '✗' {
  switch (status) {
    case 'running':
      return '●'
    case 'waiting-input':
      return '?'
    case 'idle':
      return '○'
    case 'blocked':
      return '!'
    case 'done':
      return '✓'
    case 'errored':
      return '✗'
  }
}

/** What separates two chips — the same `·` the status row uses. */
export const CHIP_SEPARATOR = ' · '
/** A chip is `<mark> <name>`: the mark and its space cost two columns. */
const CHIP_OVERHEAD = 2

export interface SessionChip {
  name: string
  status: SessionStatus
}

function fixedWidthFor(chipCount: number): number {
  return CHIP_OVERHEAD * chipCount + (chipCount > 0 ? (chipCount - 1) * CHIP_SEPARATOR.length : 0)
}

function truncatedName(name: string, cap: number): string {
  const chars = Array.from(name)
  const kept = chars.slice(-Math.max(0, cap)).join('')
  return cap <= 0 ? '…' : cap >= chars.length ? name : `…${kept}`
}

/**
 * The chips that fit on one row `maxWidth` wide: sessions from the end are
 * dropped first, then every name is shortened (from the front, keeping the
 * distinctive tail) by the same cap until the row fits.
 */
export function layoutSessionBar(sessions: SessionBarItem[], maxWidth: number = terminalWidth()): SessionChip[] {
  if (sessions.length === 0) return []
  let kept = sessions.map((session) => ({ name: session.name, status: session.status }))
  while (kept.length > 1 && fixedWidthFor(kept.length) + kept.length > maxWidth) {
    kept = kept.slice(0, -1)
  }

  const widths = kept.map((chip) => visibleWidth(chip.name))
  const availableForNames = Math.max(0, maxWidth - fixedWidthFor(kept.length))
  if (widths.reduce((sum, width) => sum + width, 0) <= availableForNames) return kept

  const fits = (cap: number): boolean => {
    let width = 0
    for (let i = 0; i < kept.length; i += 1) {
      width += widths[i]! <= cap ? widths[i]! : visibleWidth(truncatedName(kept[i]!.name, cap))
    }
    return width <= availableForNames
  }
  let lo = 0
  let hi = Math.max(...widths, 1)
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (fits(mid)) lo = mid
    else hi = mid - 1
  }
  return kept.map((chip, i) => (widths[i]! > lo ? { ...chip, name: truncatedName(chip.name, lo) } : chip))
}

/** The bar as plain text — `elia sessions` prints this; the Ink bar colours the same layout. */
export function renderSessionBar(sessions: SessionBarItem[], maxWidth: number = terminalWidth()): string {
  return layoutSessionBar(sessions, maxWidth)
    .map((chip) => `${statusGlyph(chip.status)} ${chip.name}`)
    .join(CHIP_SEPARATOR)
}
