import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TaskOutcome } from '../evolve/fitness.ts'
import { prefixIn } from '../evolve/measureTree.ts'
import { CHARS_PER_TOKEN, prefixChars, type PrefixSizes } from './probe.ts'
import { MEASURE_SD, TOKEN_MARGIN, normalCdf, winProbability, type Belief, type Calibration, type SurfaceKind } from './kernel.ts'
import { isTextOnlyEdit } from './text.ts'

/**
 * The twin: an executable model of elia's own harness that says, before any
 * benchmark task runs, what a diff can and cannot do.
 *
 * What makes it a model rather than a heuristic is that its core is exact. A
 * task's tokens are, to within a few percent, `steps × (what every call sends
 * first + what the conversation has accumulated)`: on the 19 built-in tasks
 * the fixed part alone — 113 steps × 3 attempts × ~17k tokens — is 94% of the
 * 6.3M tokens the suite costs. So an edit to the system prompt or a tool
 * definition has a predictable effect: `Δtokens = Σ steps × attempts × Δprefix`,
 * arithmetic on text the twin can read from the candidate tree without a model.
 * An edit to logic has no such formula — a changed loop may take more steps or
 * fewer — so it is priced as a gamble, wide, and left to the benchmark.
 *
 * The twin's predictions are beliefs with an sd, committed to the receipt
 * ledger before measurement and scored after it (kernel.ts), and the twin's own
 * coefficient and its confidence are read back from that ledger.
 */

/** Files that only change what a benchmark task runs when they change the prompt. */
export type FileKind = 'test' | 'docs' | 'text' | 'logic' | 'dormant'

/**
 * Code a benchmark task loads but does not run. `reach.ts` records what is
 * loaded, and nearly every task loads nearly everything — `roles.ts` is
 * imported by every task through `subagent.ts` — so "loaded" cannot tell a
 * diff that matters from one that cannot. These two are the exceptions the
 * benchmark's own harness states outright (evolve/engine.ts EXECUTED_SECTION):
 * a task runs one agent loop, never `elia auto`'s planner, and reaches a
 * sub-agent's role prompt only if the agent chooses to call the `task` tool.
 * Generations 15 and 16 each spent a full sweep — 13M and 10M tokens — on a
 * builder-prompt edit in `roles.ts`, which no task ran.
 */
export const DORMANT_FOR_BENCH = ['src/autonomy/loop.ts', 'src/autonomy/roles.ts', 'src/subagent.ts']

export function kindOf(file: ChangedFile): FileKind {
  const path = file.path.replace(/\\/g, '/')
  if (/\.test\.[cm]?[jt]sx?$/.test(path)) return 'test'
  if (/\.(md|mdx|txt)$/i.test(path) || path.startsWith('docs/')) return 'docs'
  const textOnly = file.before !== undefined && file.after !== undefined && isTextOnlyEdit(file.before, file.after)
  if (DORMANT_FOR_BENCH.includes(path)) return 'dormant'
  return textOnly ? 'text' : 'logic'
}

export interface ChangedFile {
  path: string
  /** Undefined for a file the diff adds. */
  before?: string
  /** Undefined for a file the diff deletes. */
  after?: string
}

type BaselineRow = Pick<TaskOutcome, 'taskId' | 'steps' | 'totalTokens'> & Partial<Pick<TaskOutcome, 'attempts' | 'unmeasured'>>

export interface EffectInput {
  changed: ChangedFile[]
  live: PrefixSizes | undefined
  candidate: PrefixSizes | undefined
  baseline: readonly BaselineRow[]
  calibration: Calibration
}

export interface Effect {
  surface: SurfaceKind
  /** Uncalibrated θ: the arithmetic alone. */
  raw: number
  belief: Belief
  /** Change in what every call sends first, in tokens. Undefined when a prefix could not be read. */
  prefixDelta: number | undefined
  /** Model calls the arithmetic multiplies that change by: Σ steps × attempts. */
  calls: number
  /** Baseline tokens the effect is a fraction of. */
  baselineTokens: number
  kinds: Array<{ path: string; kind: FileKind }>
}

/** How unsure the twin is about θ for each kind of diff, before the ledger has a say. */
const PRIOR_SD: Record<SurfaceKind, number> = { inert: 0.005, prefix: 0.03, mixed: 0.1, other: 0.15 }

export function predictEffect(input: EffectInput): Effect {
  const kinds = input.changed.map((file) => ({ path: file.path, kind: kindOf(file) }))
  const hasLogic = kinds.some((entry) => entry.kind === 'logic')
  const measured = input.baseline.filter((row) => !row.unmeasured)
  const calls = measured.reduce((sum, row) => sum + (row.attempts ?? 1) * row.steps, 0)
  const baselineTokens = measured.reduce((sum, row) => sum + row.totalTokens, 0)

  const prefixDelta =
    input.live && input.candidate ? (prefixChars(input.candidate) - prefixChars(input.live)) / CHARS_PER_TOKEN : undefined
  const changedPrefix = prefixDelta !== undefined && Math.abs(prefixDelta) >= 1

  // Only a test, a document, or code no task runs can leave every score alone.
  // Reworded text that never reaches the prompt still changes what the model is
  // told — a tool's result, an error message — so it is not inert, just unpriced.
  const runtime = kinds.some((entry) => entry.kind === 'text' || entry.kind === 'logic')
  const surface: SurfaceKind =
    prefixDelta === undefined
      ? 'other'
      : !runtime
        ? changedPrefix
          ? 'prefix'
          : 'inert'
        : !hasLogic && changedPrefix
          ? 'prefix'
          : hasLogic && changedPrefix
            ? 'mixed'
            : 'other'

  const raw = baselineTokens > 0 && changedPrefix ? Math.log(Math.max(1e-6, 1 + (calls * prefixDelta!) / baselineTokens)) : 0
  const sd = Math.max(0.005, PRIOR_SD[surface] * input.calibration.sdScale)
  return { surface, raw, belief: { mean: raw * input.calibration.k, sd }, prefixDelta, calls, baselineTokens, kinds }
}

export interface ScreenOptions {
  /** A task the diff can reach fails today, so a correctness win is not ruled out. */
  failingReachable: boolean
  /** Least chance of a measured win that justifies paying for one. */
  minWin?: number
  /** Largest growth of the fixed prompt worth a gamble on fewer steps, as a fraction of total tokens. */
  maxAddition?: number
}

export interface Screen {
  proceed: boolean
  /** True when the reason to stop is that the benchmark cannot see the change, not that it looks bad. */
  unmeasurable: boolean
  reason: string
  winProbability: number
  effect: Effect
}

/** The z at which a standard normal has cumulative probability `p`. Bisection on the CDF: slow enough not to matter, and correct by construction. */
function zFor(p: number): number {
  let lo = -8
  let hi = 8
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    if (normalCdf(mid) < p) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

function percent(value: number): string {
  return `${(value * 100).toFixed(value !== 0 && Math.abs(value) < 0.1 ? 1 : 0)}%`
}

/**
 * Whether a candidate is worth paying to measure.
 *
 * It stops a candidate only where stopping is certain to be right: when no
 * benchmark task can see the change, when the change is an exactly-priced
 * saving too small to clear the gate, and when it adds text to every call with
 * nothing failing to be fixed in exchange. Everything else proceeds, because
 * the twin cannot see what a changed loop will do and says so instead of
 * guessing.
 */
export function screenEffect(effect: Effect, options: ScreenOptions): Screen {
  const minWin = options.minWin ?? 0.6
  const maxAddition = options.maxAddition ?? 0.1
  const p = winProbability(effect.belief)
  const stop = (reason: string, unmeasurable = false): Screen => ({ proceed: false, unmeasurable, reason, winProbability: p, effect })

  if (effect.surface === 'inert') {
    const listed = effect.kinds.map((entry) => `${entry.path} (${describeKind(entry.kind)})`).join(', ') || 'no file'
    return stop(
      `could not be measured: this diff cannot move a benchmark score — ${listed}. Tests and documents are not run by a task, and neither is code a task loads but never executes. Add a benchmark task that exercises it before proposing it again.`,
      true,
    )
  }

  if (effect.surface === 'prefix' && !options.failingReachable) {
    const sd = Math.hypot(effect.belief.sd, MEASURE_SD)
    if (effect.belief.mean < 0 && p < minWin) {
      // The mean that would make a win as likely as `minWin`, and what removing
      // that much means per call: invert θ = k·ln(1 + calls·Δ ÷ baseline) for Δ.
      const needed = Math.log(1 - TOKEN_MARGIN) - zFor(minWin) * sd
      const k = effect.raw !== 0 ? effect.belief.mean / effect.raw : 1
      const targetDelta = effect.calls > 0 ? ((Math.exp(needed / k) - 1) * effect.baselineTokens) / effect.calls : 0
      const more = Math.max(0, Math.ceil((effect.prefixDelta ?? 0) - targetDelta))
      return stop(
        `predicted saving ${percent(1 - Math.exp(effect.belief.mean))} from ${Math.round(-(effect.prefixDelta ?? 0))} fewer tokens on every call — the gate needs ${percent(TOKEN_MARGIN)} clear of about ±${percent(2 * MEASURE_SD)} run-to-run noise, so a win here is ${percent(p)} likely; cut about ${more} more tokens per call to make it worth measuring`,
      )
    }
    if (effect.belief.mean >= Math.log(1 + maxAddition)) {
      return stop(
        `adds ${Math.round(effect.prefixDelta ?? 0)} tokens to every call (${percent(Math.exp(effect.belief.mean) - 1)} of everything the suite spends) and nothing this touches is failing: it would have to remove more than that in steps to win, and no wording change does`,
      )
    }
  }

  return { proceed: true, unmeasurable: false, reason: `worth measuring: ${surfaceLine(effect, p)}`, winProbability: p, effect }
}

export function describeKind(kind: FileKind): string {
  return { test: 'a test', docs: 'a document', text: 'wording', logic: 'logic', dormant: 'code no benchmark task runs' }[kind]
}

export function surfaceLine(effect: Effect, p = winProbability(effect.belief)): string {
  const shift = effect.prefixDelta === undefined ? 'prompt size unreadable' : `${effect.prefixDelta >= 0 ? '+' : ''}${Math.round(effect.prefixDelta)} tokens on every call`
  return `${effect.surface} edit, ${shift}, predicted ${percent(Math.exp(effect.belief.mean) - 1)} tokens (±${percent(effect.belief.sd)}), ${percent(p)} chance of a measured win`
}

function readIfPresent(root: string, path: string): string | undefined {
  try {
    const full = join(root, path)
    return existsSync(full) ? readFileSync(full, 'utf8') : undefined
  } catch {
    return undefined
  }
}

/** The diff as the twin reads it: each changed file as it is in the live tree and in the candidate's. */
export function readChangedFiles(liveRoot: string, candidateRoot: string, paths: readonly string[]): ChangedFile[] {
  return paths.map((path): ChangedFile => {
    const before = readIfPresent(liveRoot, path)
    const after = readIfPresent(candidateRoot, path)
    return { path, ...(before === undefined ? {} : { before }), ...(after === undefined ? {} : { after }) }
  })
}

/** `ELIA_TWIN=off` skips the screen and measures everything, the control arm for what the twin saves. */
export function twinEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.ELIA_TWIN ?? '').trim().toLowerCase() !== 'off'
}

export interface AssessOptions {
  liveRoot: string
  candidateRoot: string
  /** Repo-relative files the diff changed. */
  changed: string[]
  baseline: readonly BaselineRow[]
  calibration: Calibration
  failingReachable: boolean
  signal?: AbortSignal
  /** Injection seam for tests. */
  prefix?: (root: string) => Promise<PrefixSizes | undefined>
}

/** Reads both trees and answers what the diff does and whether it is worth measuring. */
export async function assess(options: AssessOptions): Promise<Screen> {
  const measurePrefix = options.prefix ?? ((root: string) => prefixIn(root, options.signal))
  const [live, candidate] = await Promise.all([measurePrefix(options.liveRoot), measurePrefix(options.candidateRoot)])
  const changed = readChangedFiles(options.liveRoot, options.candidateRoot, options.changed)
  const effect = predictEffect({ changed, live, candidate, baseline: options.baseline, calibration: options.calibration })
  return screenEffect(effect, { failingReachable: options.failingReachable })
}
