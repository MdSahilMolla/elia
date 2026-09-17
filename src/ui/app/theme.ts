// Semantic palette for the Ink REPL.
//
// Restraint is the design: most text is the terminal's *own* foreground (the
// `undefined` tokens), weight comes from bold and layout, and colour is spent
// only where it carries meaning — elia's gold on the one thing that moves
// (the working indicator), green/red on outcomes, one hue per mode, and quiet
// background bands that make a diff or your own message findable at a glance.
// A fixed off-white foreground is still never used: it vanished on light
// terminal themes.
//
// Three themes: `dark` (the default), `light`, and `ansi` — the terminal's
// 16 named colours, for consoles without 256/true colour or anyone who wants
// their own scheme to decide. `ELIA_THEME=dark|light|ansi` picks one; without
// it, a light background advertised through `COLORFGBG` picks `light`.
// `NO_COLOR` / `--no-color` drop colour entirely.
import { colorless } from '../runtime.ts'

export type ThemeName = 'dark' | 'light' | 'ansi'

export interface Palette {
  /** Emphasis without a hue: the terminal's own foreground. Pair with `bold`. */
  accent: string | undefined
  /** Tool names / targets — plain foreground, weight comes from layout. */
  toolName: string | undefined
  user: string | undefined
  text: string | undefined
  /** elia's own colour: the working spark and the wordmark. */
  brand: string | undefined
  /** The brighter band that sweeps across the working label. */
  brandShimmer: string | undefined
  /** A running tool's dot, between pulses. */
  brandDim: string | undefined
  success: string | undefined
  failure: string | undefined
  /** Non-fatal warnings and the context meter once it is getting full. */
  warning: string | undefined
  /** Secondary text: hints, stats, finished items. */
  muted: string | undefined
  /** Structure that should recede further than muted text: rules, gutters. */
  subtle: string | undefined
  /** Inline code and links — the one "look here" hue in prose. */
  code: string | undefined
  /** Kept for callers that still shade inline code; no background by default. */
  codeBg: string | undefined
  /** Plan mode — the prompt, its rules and its status label. */
  plan: string | undefined
  /** Auto-accept mode. */
  auto: string | undefined
  /** Approval prompts: the title and its rule. */
  permission: string | undefined
  /** The highlighted row in every menu — commands, pickers, approvals. */
  selection: string | undefined
  /** `!` shell mode. */
  bash: string | undefined
  /** The band behind a message you sent. Undefined: no band. */
  userBg: string | undefined
  /** Diff rows. Undefined backgrounds fall back to green/red text. */
  diffAddBg: string | undefined
  diffDelBg: string | undefined
  /** The changed words inside a changed row. */
  diffAddWordBg: string | undefined
  diffDelWordBg: string | undefined
  /** What the spark fades toward when nothing has arrived for a while. */
  stall: string | undefined
}

const DARK: Palette = {
  accent: undefined,
  toolName: undefined,
  user: undefined,
  text: undefined,
  brand: '#E8B452',
  brandShimmer: '#FFE7B0',
  brandDim: '#7A6440',
  success: '#6CC47A',
  failure: '#F26D6D',
  warning: '#F2A057',
  muted: '#8C8C8C',
  subtle: '#4C4C4C',
  code: '#7FC8E8',
  codeBg: undefined,
  plan: '#58B8B0',
  auto: '#B69CF6',
  permission: '#95AAF7',
  selection: '#95AAF7',
  bash: '#F08BBE',
  userBg: '#262626',
  diffAddBg: '#15321C',
  diffDelBg: '#3A181C',
  diffAddWordBg: '#236B35',
  diffDelWordBg: '#7C2C35',
  stall: '#E0645A',
}

const LIGHT: Palette = {
  accent: undefined,
  toolName: undefined,
  user: undefined,
  text: undefined,
  brand: '#B07A12',
  brandShimmer: '#E9B447',
  brandDim: '#D6BF91',
  success: '#2E8540',
  failure: '#C8343D',
  warning: '#C4610E',
  muted: '#6E6E6E',
  subtle: '#BDBDBD',
  code: '#0B7A9C',
  codeBg: undefined,
  plan: '#147A74',
  auto: '#6C45C4',
  permission: '#3A56CF',
  selection: '#3A56CF',
  bash: '#B8327A',
  userBg: '#EDEDED',
  diffAddBg: '#DDF4E2',
  diffDelBg: '#FBE2E4',
  diffAddWordBg: '#A8E2B6',
  diffDelWordBg: '#F4AEB5',
  stall: '#C8343D',
}

const ANSI: Palette = {
  accent: undefined,
  toolName: undefined,
  user: undefined,
  text: undefined,
  brand: 'yellow',
  brandShimmer: 'yellowBright',
  brandDim: 'gray',
  success: 'green',
  failure: 'red',
  warning: 'yellowBright',
  muted: 'gray',
  subtle: 'gray',
  code: 'cyan',
  codeBg: undefined,
  plan: 'cyan',
  auto: 'magenta',
  permission: 'blue',
  selection: 'blueBright',
  bash: 'magentaBright',
  userBg: undefined,
  diffAddBg: undefined,
  diffDelBg: undefined,
  diffAddWordBg: undefined,
  diffDelWordBg: undefined,
  stall: 'red',
}

const NONE = Object.fromEntries(Object.keys(DARK).map((key) => [key, undefined])) as unknown as Palette

const THEMES: Record<ThemeName, Palette> = { dark: DARK, light: LIGHT, ansi: ANSI }

/**
 * Terminals that can only show the 16 named colours. Everything else takes hex
 * values: truecolor terminals show them as-is and 256-colour ones get the
 * nearest match, which keeps these tones intact.
 */
function sixteenColorsOnly(env: Record<string, string | undefined>): boolean {
  if (/^(truecolor|24bit)$/i.test(env.COLORTERM ?? '')) return false
  return /^(linux|vt\d+|ansi|cons25|dumb)$/i.test(env.TERM ?? '')
}

/**
 * Which theme to draw with. An explicit `ELIA_THEME` wins; otherwise a
 * 16-colour console gets the named-colour theme (rather than hex values
 * squashed onto the nearest ANSI slot), and a light background advertised
 * through `COLORFGBG` ("0;15") picks `light`.
 */
export function resolveThemeName(env: Record<string, string | undefined> = process.env): ThemeName {
  const requested = (env.ELIA_THEME ?? '').trim().toLowerCase()
  if (requested === 'dark' || requested === 'light' || requested === 'ansi') return requested
  if (sixteenColorsOnly(env)) return 'ansi'
  const background = Number.parseInt((env.COLORFGBG ?? '').split(';').pop() ?? '', 10)
  if (background === 7 || background === 15) return 'light'
  return 'dark'
}

// Under `bun test` the palette stays fixed, so a suite run from a shell that
// happens to export NO_COLOR or ELIA_THEME asserts the same frames CI does.
const underTest = process.env.NODE_ENV === 'test'
const dropColor = colorless && !underTest

export let themeName: ThemeName = underTest ? 'dark' : resolveThemeName(process.env)

// One object for the whole session, switched in place by `setTheme`, so every
// module that imported it draws with the new colours on its next render.
const current: Palette = { ...(dropColor ? NONE : THEMES[themeName]) }
export const palette: Readonly<Palette> = current

/** True when the palette holds hex values that can be blended — the shimmer and the stall fade need that. */
export let blendable = !dropColor && themeName !== 'ansi'

const themeListeners = new Set<() => void>()

/**
 * Switch the palette for everything drawn from now on. What is already in
 * scrollback keeps the colours it was printed with. Without colour (NO_COLOR)
 * the name changes and nothing else does.
 */
export function setTheme(name: ThemeName): void {
  themeName = name
  Object.assign(current, dropColor ? NONE : THEMES[name])
  blendable = !dropColor && name !== 'ansi'
  for (const listener of themeListeners) listener()
}

export function onThemeChange(listener: () => void): () => void {
  themeListeners.add(listener)
  return () => themeListeners.delete(listener)
}

export const THEME_CHOICES: { name: ThemeName; detail: string }[] = [
  { name: 'dark', detail: 'for dark terminal backgrounds' },
  { name: 'light', detail: 'for light terminal backgrounds' },
  { name: 'ansi', detail: "your terminal's own 16 colours" },
]

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
  /** elia's mark — the wordmark, and the spark at its brightest. */
  brand: '✦',
  /** The closing line of a finished turn: the spark, settled. */
  receipt: '✧',
  /** Kept for compatibility — errors now lead with `error`, not a rail. */
  errorRail: '✗',
  /** Mode markers on the status row. */
  auto: '⏵⏵',
  plan: '⏸',
  /** The one structural line: around the prompt, and under a modal's title. */
  rule: '─',
} as const

/** Spinner frames shared with src/ui/stream.ts's tool spinner. */
export const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/**
 * elia's spark: a point that catches, flares into a star and settles — then
 * again. Played forward and back, so it breathes rather than loops.
 */
export const sparkFrames = ['·', '✧', '✦', '✶', '✷', '✸', '✷', '✶', '✦', '✧']
