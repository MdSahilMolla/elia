import { terminalWidth, visibleWidth } from './layout.ts'
import type { SessionStatus } from '../session/types.ts'

export interface SessionBarItem {
  name: string
  status: SessionStatus
  lastTask?: string
}

export function statusGlyph(status: SessionStatus): '●' | '○' | '⚠' | '✓' | '✗' {
  switch (status) {
    case 'running':
    case 'waiting-input':
      return '●'
    case 'idle':
      return '○'
    case 'blocked':
      return '⚠'
    case 'done':
      return '✓'
    case 'errored':
      return '✗'
  }
}

const CHIP_OVERHEAD = 4
const CHIP_SEPARATOR = ' '

function buildChips(names: string[], glyphs: string[]): string {
  return names.map((name, i) => `[${name} ${glyphs[i]}]`).join(CHIP_SEPARATOR)
}

function fixedWidthFor(chipCount: number): number {
  return CHIP_OVERHEAD * chipCount + (chipCount > 0 ? chipCount - 1 : 0)
}

function truncatedName(name: string, cap: number): string {
  const chars = Array.from(name)
  const kept = chars.slice(-Math.max(0, cap)).join('')
  return cap <= 0 ? '…' : cap >= chars.length ? name : `…${kept}`
}

export function renderSessionBar(sessions: SessionBarItem[], maxWidth: number = terminalWidth()): string {
  if (sessions.length === 0) return ''
  const items = sessions.map((s) => ({ name: s.name, glyph: statusGlyph(s.status) }))
  let kept = items
  while (kept.length > 1 && fixedWidthFor(kept.length) + kept.length > maxWidth) {
    kept = kept.slice(0, -1)
  }
  if (kept.length === 0) return ''

  const names = kept.map((item) => item.name)
  const glyphs = kept.map((item) => item.glyph)
  const widths = names.map((name) => visibleWidth(name))
  const totalNameWidth = widths.reduce((sum, width) => sum + width, 0)
  const availableForNames = Math.max(0, maxWidth - fixedWidthFor(kept.length))
  if (totalNameWidth <= availableForNames) {
    return buildChips(names, glyphs)
  }

  const maxNameWidth = Math.max(...widths, 1)
  const fits = (cap: number): boolean => {
    let width = 0
    for (let i = 0; i < names.length; i += 1) {
      const nameWidth = widths[i]!
      if (nameWidth <= cap) {
        width += nameWidth
      } else {
        width += 1 + visibleWidth(truncatedName(names[i]!, cap))
      }
    }
    return width <= availableForNames
  }

  let lo = 0
  let hi = maxNameWidth
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (fits(mid)) lo = mid
    else hi = mid - 1
  }
  const cap = lo
  const trimmed = names.map((name, i) => (widths[i]! > cap ? truncatedName(name, cap) : name))
  return buildChips(trimmed, glyphs)
}