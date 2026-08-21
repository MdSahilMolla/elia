// Single source of truth for terminal styling. Every other ui/*.ts file used to
// redefine its own ANSI escape codes independently, which let the palette drift
// (gold vs. yellow for the same meaning) and meant color codes got written even
// when stdout wasn't a real terminal — corrupting piped/redirected output.
// Everything routes through `paint()` so both
// problems are fixed in one place.
import { plainOutput } from './runtime.ts'

const CODES = {
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  reverse: '\x1b[7m',
  reset: '\x1b[0m',
  mono: '\x1b[97;40m', // bright white on black, for the banner artwork
  gold: '\x1b[33m', // brand accent: spinners, phase headers, the prompt glyph
  cyan: '\x1b[36m', // tool names, informational detail
  green: '\x1b[32m', // success
  red: '\x1b[31m', // errors, failures
} as const

export type ColorName = keyof typeof CODES

/** True when ANSI escapes should be emitted at all: a real TTY, and the user hasn't opted out. */
export const colorEnabled = process.env.NODE_ENV !== 'test' && Boolean(process.stdout.isTTY) && !plainOutput

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g

/** Strips ANSI escapes so a decorated string's *visible* length can be measured (cursor math, padding). */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '')
}

function paint(code: string, text: string): string {
  return colorEnabled ? `${code}${text}${CODES.reset}` : text
}

export const bold = (text: string): string => paint(CODES.bold, text)
export const dim = (text: string): string => paint(CODES.dim, text)
export const italic = (text: string): string => paint(CODES.dim + CODES.italic, text)
export const reverse = (text: string): string => paint(CODES.reverse, text)
export const gold = (text: string): string => paint(CODES.gold, text)
export const cyan = (text: string): string => paint(CODES.cyan, text)
export const green = (text: string): string => paint(CODES.green, text)
export const red = (text: string): string => paint(CODES.red, text)
export const boldGold = (text: string): string => paint(CODES.bold + CODES.gold, text)
export const boldCyan = (text: string): string => paint(CODES.bold + CODES.cyan, text)
export const dimCyan = (text: string): string => paint(CODES.dim + CODES.cyan, text)

/** Raw code, for callers that stream deltas and need to open/close a style across many writes. */
export const raw = CODES
