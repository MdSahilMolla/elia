// What the working indicator says. Pure, so the suite can pin it.
//
// The label answers "what is elia doing right now?" as specifically as it
// can: the tool that is running, then the phase an escalated run reported,
// then the plan step in progress, then whether the model is reasoning — and
// only when none of those is known, one word for the turn.

/** `5s`, `1m 5s`, `12m 30s`, `1h 2m` — precise while it matters, coarse once it doesn't. */
export function formatElapsed(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  return `${Math.floor(seconds / 3_600)}h ${Math.floor((seconds % 3_600) / 60)}m`
}

/** `817`, `1.2k`, `12k`, `1.4M`. */
export function formatTokens(count: number): string {
  const n = Math.max(0, Math.round(count))
  if (n < 1_000) return String(n)
  if (n < 10_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`
  if (n < 1_000_000) return `${Math.round(n / 1_000)}k`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

/**
 * Tokens in streamed text, estimated as the provider bills them — about four
 * characters each. Real usage only lands when a model call ends; this keeps the
 * counter moving until it does.
 */
export function streamedTokens(text: string): number {
  return charTokens(text.length)
}

/** The same estimate where only the size is known and not the text — a tool call's streamed arguments. */
export function charTokens(chars: number): number {
  return Math.max(0, chars) / 4
}

/**
 * The line that closes a longer turn: how long it took, what it changed, how
 * much the model wrote. `rollup` is toolSummary's `rollupLine` ("Edited 1
 * file, ran 2 commands · +3 −1"); `tokens` is output tokens, 0 when unknown.
 */
export function turnReceipt({ elapsedMs, rollup, tokens }: { elapsedMs: number; rollup: string; tokens: number }): string {
  const parts = [`Worked for ${formatElapsed(elapsedMs / 1000)}`]
  if (rollup) parts.push(rollup.charAt(0).toLowerCase() + rollup.slice(1))
  if (tokens > 0) parts.push(`↓ ${formatTokens(tokens)} tokens`)
  return parts.join(' · ')
}

/** A receipt is worth a line once a turn ran a while or did real work. */
export const RECEIPT_AFTER_MS = 10_000

// Verbs whose -ing form doubles the final consonant ("run" → "running").
const DOUBLES = new Set(['run', 'set', 'get', 'put', 'stop', 'plan', 'begin', 'cut', 'map', 'ship', 'drop', 'swap', 'wrap', 'split', 'commit', 'submit', 'scan', 'trim', 'skip', 'step', 'tap', 'grab', 'pin', 'log', 'tag', 'let', 'fit', 'rerun', 'refit'])
// Verbs ending in "e" that keep it ("see" → "seeing").
const KEEP_E = new Set(['see', 'be', 'free', 'agree', 'guarantee', 'dye', 'flee'])

/** "Fix the tests" → "Fixing the tests". Text that does not start with a plain verb is returned as-is. */
export function gerund(step: string): string {
  const text = step.trim().replace(/[.…:]+$/, '')
  const match = /^([A-Za-z]+)(\b.*)$/s.exec(text)
  if (!match) return text
  const word = match[1]!
  const lower = word.toLowerCase()
  // Already a gerund, or not a verb we can bend safely ("The…", "A…").
  if (lower.endsWith('ing') || /^(the|a|an|all|each|every|no|this|that|these|those|my|your|our|its)$/.test(lower)) return text
  let bent: string
  if (DOUBLES.has(lower)) bent = lower + lower.slice(-1) + 'ing'
  else if (lower.endsWith('ie')) bent = `${lower.slice(0, -2)}ying`
  else if (lower.endsWith('e') && !KEEP_E.has(lower) && lower.length > 2) bent = `${lower.slice(0, -1)}ing`
  else bent = `${lower}ing`
  const cased = word[0] === word[0]!.toUpperCase() ? bent[0]!.toUpperCase() + bent.slice(1) : bent
  return cased + match[2]
}

/** One word for a turn whose activity is not known yet. Stable for the whole turn. */
export const TURN_VERBS = [
  'Working',
  'Thinking it through',
  'Reasoning',
  'Weaving',
  'Sketching',
  'Tracing',
  'Mapping it out',
  'Assembling',
  'Composing',
  'Distilling',
  'Shaping',
  'Wiring',
  'Threading',
  'Kindling',
  'Calibrating',
  'Untangling',
  'Drafting',
  'Piecing it together',
  'Connecting the dots',
  'Lining things up',
]

export function turnVerb(seed: number): string {
  const index = Math.abs(Math.floor(seed)) % TURN_VERBS.length
  return TURN_VERBS[index]!
}

export interface WorkingState {
  /** Activity phrases of the tool calls running right now, oldest first. */
  runningTools: readonly string[]
  /** The latest phase or progress line a deeper layer reported. */
  activity?: string
  /** The plan step marked in progress. */
  planStep?: string
  /** The model is streaming reasoning right now. */
  thinking?: boolean
  /** The model is streaming its reply right now. */
  writing?: boolean
  /** The fallback word for this turn. */
  verb: string
}

/** The indicator's label, without the trailing ellipsis. */
export function workingLabel(state: WorkingState): string {
  const clean = (text: string | undefined): string => (text ?? '').trim().replace(/[.…]+$/, '')
  const tools = state.runningTools.map(clean).filter(Boolean)
  if (tools.length > 0) {
    const latest = tools[tools.length - 1]!
    return tools.length > 1 ? `${latest} · ${tools.length - 1} more running` : latest
  }
  const activity = clean(state.activity)
  if (activity) return activity
  if (state.thinking) return 'Thinking'
  const step = clean(state.planStep)
  if (step) return gerund(step)
  if (state.writing) return 'Writing'
  return state.verb
}

/** Shown under a long-running turn, one per turn, so they rotate. */
export const TIPS = [
  'Type while elia works — it answers right away, and passes any change of plan to the work',
  '/autopilot: no task needed — elia works out what this repo needs and does it',
  'shift+tab cycles manual → auto-accept → plan mode',
  'Mention a file with @, or run a shell command with !',
  'ctrl+o expands every tool result',
  '/rewind puts the workspace back to an earlier turn',
  '/model switches models without losing the conversation',
  '/lessons shows what elia has learned in this project',
  'ctrl+r searches your prompt history',
  '/compact frees context when a long session fills up',
  '/usage shows tokens, context and limits for this session',
  'esc stops the turn; anything you queued is kept',
  '/brain searches what elia remembers across sessions',
]

export function tipFor(turn: number): string {
  return TIPS[Math.abs(Math.floor(turn)) % TIPS.length]!
}

/** Tips are on unless ELIA_TIPS says otherwise. */
export function tipsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = (env.ELIA_TIPS ?? 'on').trim().toLowerCase()
  return !(raw === 'off' || raw === '0' || raw === 'false' || raw === 'no')
}

/** Reduced motion: no shimmer, a still spark, a clock that ticks once a second. */
export function reducedMotion(env: Record<string, string | undefined> = process.env): boolean {
  const raw = (env.ELIA_REDUCED_MOTION ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes'
}

// ------------------------------------------------------------------- checks

export type CheckState = 'queued' | 'running' | 'passed' | 'failed' | 'skipped'

/** One verification check on the working line: a short name and where it stands. */
export interface CheckChip {
  command: string
  label: string
  state: CheckState
}

const TEST_RUNNER = /\b(?:test|tests|jest|vitest|mocha|pytest|unittest|rspec|phpunit|ctest)\b/i
const TYPECHECK = /\b(?:tsc|typecheck|type-check|mypy|pyright|vue-tsc|svelte-check)\b/i
const BUILD = /\b(?:build|compile|make|javac|gradle|mvn)\b/i
const LINT = /\b(?:lint|eslint|ruff|clippy|flake8|biome|golangci-lint)\b/i

/**
 * What a check is called on the working line — what it proves, not how it
 * is spelled: `bunx tsc --noEmit` is "tsc", `npm run test:unit` is "tests".
 * Anything unrecognised keeps its program's name.
 */
export function checkLabel(command: string): string {
  const text = command.trim()
  const typecheck = TYPECHECK.exec(text)
  if (typecheck) return /tsc$/i.test(typecheck[0]) ? 'tsc' : 'types'
  if (/\bcargo\s+check\b|\bgo\s+vet\b/i.test(text)) return 'check'
  if (TEST_RUNNER.test(text)) return 'tests'
  if (LINT.test(text)) return 'lint'
  if (BUILD.test(text)) return 'build'
  const program = text.split(/\s+/).find((word) => !/^(?:npx|bunx|pnpm|yarn|npm|bun|run|exec|uv|poetry|python3?|-m)$/i.test(word)) ?? text
  const name = program.split(/[\\/]/).pop() ?? program
  return name.length > 12 ? `${name.slice(0, 11)}…` : name
}

/**
 * The chips after one check event. Queued events arrive as a burst before a
 * pass starts, so one for a command already on the line — or arriving after
 * every chip has left the queue — begins a new pass (a repair re-running the
 * gate), and the last pass's ticks no longer describe the code.
 */
export function applyCheckEvent(chips: readonly CheckChip[], event: { command: string; state: CheckState }): CheckChip[] {
  const index = chips.findIndex((chip) => chip.command === event.command)
  if (event.state === 'queued') {
    const fresh = index !== -1 || chips.every((chip) => chip.state !== 'queued')
    return [...(fresh ? [] : chips), { command: event.command, label: checkLabel(event.command), state: 'queued' }]
  }
  if (index === -1) return [...chips, { command: event.command, label: checkLabel(event.command), state: event.state }]
  return chips.map((chip, i) => (i === index ? { ...chip, state: event.state } : chip))
}
