// Semantic palette for the Ink REPL — deliberately near-monochrome.
//
// Text that needs weight uses the terminal's *own* foreground (undefined here)
// plus bold, never a hard-coded off-white: a fixed `#c8ccc6` accent vanished on
// light terminal themes. Named ANSI colours are reserved for meaning — green
// success, red failure, yellow warning, cyan code — because terminals remap
// those to fit their theme. `NO_COLOR` / `--no-color` drop colour entirely.
import { colorless } from '../runtime.ts'

// Under `bun test` the palette stays fixed, so a suite run from a shell that
// happens to export NO_COLOR asserts the same frames CI does.
const dropColor = colorless && process.env.NODE_ENV !== 'test'
const tone = <T extends string>(color: T): T | undefined => (dropColor ? undefined : color)

export const palette = {
  /** Emphasis without a hue: the terminal's own foreground. Pair with `bold`. */
  accent: undefined as string | undefined,
  /** Tool names / targets — plain foreground, weight comes from layout. */
  toolName: undefined as string | undefined,
  success: tone('green'),
  failure: tone('red'),
  /** Non-fatal warnings and the context meter once it is getting full. */
  warning: tone('yellow'),
  /** Secondary text: hints, stats, finished items. */
  muted: tone('gray'),
  user: undefined as string | undefined,
  text: undefined as string | undefined,
  /** Inline code and links — the one "look here" hue. */
  code: tone('cyan'),
  /** Kept for callers that still shade inline code; no background by default. */
  codeBg: undefined as string | undefined,
} as const

export const glyphs = {
  /** The input prompt, and the marker on each message you sent. */
  user: '❯',
  /** Every assistant message and tool call starts with one dot. */
  bullet: '●',
  ok: '✓',
  error: '✗',
  warn: '!',
  running: '◐',
  pending: '□',
  /** Continuation under a tool call: its result, summary, or diff. */
  branch: '⎿',
  thinking: '✻',
  skill: '✦',
  /** Everything elia commits to durable memory — a lesson, a verified workflow, a rationale. */
  learn: '✦',
  /** Kept for compatibility — errors now lead with `error`, not a rail. */
  errorRail: '✗',
} as const

/** Spinner frames shared with src/ui/stream.ts's tool spinner. */
export const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
