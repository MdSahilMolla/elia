import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { canonicalizeCommandForIdentity } from '../autonomy/commandIdentity.ts'
import { withFileLock } from '../fileLock.ts'
import { ensureSecureDirectory, writeSecureFile } from '../securePersistence.ts'
import { paths } from '../statePaths.ts'

/**
 * The world model elia carries in every run.
 *
 * An agent acts on a world it can only see through tool results. Everything it
 * believes about that world — which files it has changed, whether the tests
 * passed and against which version of the code, how likely a command is to
 * work here — lives in a conversation that is truncated, compacted and
 * summarised, and in a model that is sure of things it read forty steps ago.
 * elia already keeps fragments of the world in separate places (the files read
 * this session, the checkpoint tracker, the redundant-read counter, the
 * project's detected checks). This is the one model they are all views of:
 *
 *   state      what is true of the tree right now, kept by the runtime rather
 *              than remembered by the model, so it survives compaction;
 *   predict    before each action, how likely it is to work, from what has
 *              happened in *this* project and what the state says;
 *   observe    after it, how surprising the result was, and the update;
 *   persist    what a project's commands do, carried across sessions.
 *
 * It is the runtime half of the world model in `twin.ts`, which predicts what a
 * change to elia's own source does to what it costs. The two share a discipline:
 * a prediction is committed before the result and scored after, so the model's
 * accuracy is a measured number (`brierSkill`) and not a claim.
 *
 * Deliberately weak in three ways. It makes no model calls. It never blocks or
 * rewrites an action — it only tells the model something true it may not be
 * holding — and says nothing unless there is something to say. And it adds no
 * tool: a tool definition is sent on every call, and this exists to make runs
 * cheaper.
 */

export type CheckKind = 'test' | 'typecheck' | 'lint' | 'build'
export type CommandKind = CheckKind | 'install' | 'git-read' | 'git-write' | 'other'

const CHECK_PATTERNS: Array<[CheckKind, RegExp]> = [
  ['test', /\b(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?test\b|\bbun\s+test\b|\b(?:vitest|jest|mocha|pytest|phpunit|rspec|ctest)\b|\bcargo\s+test\b|\bgo\s+test\b|\bdotnet\s+test\b|\bmvn\b.*\btest\b|\bgradlew?\b.*\btest\b|\bmake\s+(?:test|check)\b/],
  ['typecheck', /\btsc\b(?!\s+-b)|\btypecheck\b|\bmypy\b|\bpyright\b|\bcargo\s+check\b|\bgo\s+vet\b/],
  ['build', /\b(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?build\b|\bcargo\s+build\b|\bgo\s+build\b|^make(?:\s+(?:build|all))?\s*$|\bvite\s+build\b|\bwebpack\b|\btsc\s+-b\b/],
  ['lint', /\b(?:eslint|oxlint|biome|ruff|flake8|pylint|clippy|golangci-lint|rubocop|stylelint)\b|\blint\b/],
]

/** What kind of thing a shell command is. A compound command takes the strongest kind it contains. */
export function classifyCommand(command: string): CommandKind {
  const text = command.trim()
  for (const [kind, pattern] of CHECK_PATTERNS) if (pattern.test(text)) return kind
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:install|add|i)\b|\bpip3?\s+install\b|\bcargo\s+add\b/.test(text)) return 'install'
  if (/^git\s+(?:status|diff|log|show|branch|rev-parse|ls-files|blame|remote)\b/.test(text)) return 'git-read'
  if (/^git\s+(?:add|commit|checkout|switch|merge|rebase|reset|stash|pull|push|restore|cherry-pick|apply)\b/.test(text)) return 'git-write'
  return 'other'
}

const isCheck = (kind: CommandKind): kind is CheckKind => kind === 'test' || kind === 'typecheck' || kind === 'lint' || kind === 'build'

/** The tools that change a file at a known path, and only that one. */
const FILE_WRITERS = new Set(['edit_file', 'write_file', 'delete_file'])

/** How likely each kind of action is to fail in a project we know nothing about yet. */
const DEFAULT_P_FAIL: Record<string, number> = {
  read_file: 0.08,
  edit_file: 0.2,
  write_file: 0.05,
  delete_file: 0.1,
  grep: 0.05,
  list_files: 0.05,
  'run_command:test': 0.5,
  'run_command:typecheck': 0.4,
  'run_command:lint': 0.35,
  'run_command:build': 0.3,
  'run_command:install': 0.2,
  'run_command:git-read': 0.05,
  'run_command:git-write': 0.15,
  'run_command:other': 0.25,
  task: 0.2,
}
const FALLBACK_P_FAIL = 0.15

/** Observations of one kind of action before this project's own record outweighs the default. */
const PRIOR_STRENGTH = 4

export interface Count {
  ok: number
  fail: number
  /** Milliseconds spent across every run of this kind of action: what it costs here, measured. */
  ms?: number
  /** Times an identical call against an unchanged tree was repeated, and how often it answered differently: flakiness, measured. */
  repeats?: number
  flips?: number
}

/** What a project's history has taught the model, carried across sessions. */
export interface Priors {
  version: 1
  keys: Record<string, Count>
  /** Every prediction ever scored: the sums Brier is read from. */
  calibration: { n: number; brier: number; failures: number; bits: number }
  /** Notes the model has told the agent, by kind. */
  notes: { repeat: number; streak: number }
  updatedAt: number
}

export const emptyPriors = (): Priors => ({ version: 1, keys: {}, calibration: { n: 0, brier: 0, failures: 0, bits: 0 }, notes: { repeat: 0, streak: 0 }, updatedAt: 0 })

export function runtimePriorsPath(): string {
  return join(paths.state, 'world', 'runtime.json')
}

export function readPriors(path = runtimePriorsPath()): Priors {
  try {
    if (!existsSync(path)) return emptyPriors()
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<Priors>
    if (parsed.version !== 1 || typeof parsed.keys !== 'object' || parsed.keys === null) return emptyPriors()
    return { ...emptyPriors(), ...parsed, keys: parsed.keys, calibration: { ...emptyPriors().calibration, ...parsed.calibration }, notes: { ...emptyPriors().notes, ...parsed.notes } }
  } catch {
    return emptyPriors()
  }
}

/** Counts past which both sides are halved, so a project that changed is learned afresh instead of averaged with its past. */
const COUNT_CEILING = 60

export function pFailFrom(key: string, tool: string, priors: Priors): number {
  const prior = DEFAULT_P_FAIL[key] ?? DEFAULT_P_FAIL[tool] ?? FALLBACK_P_FAIL
  const seen = priors.keys[key]
  if (!seen) return prior
  // A Beta prior worth `PRIOR_STRENGTH` observations, updated by this project's own.
  return (seen.fail + prior * PRIOR_STRENGTH) / (seen.ok + seen.fail + PRIOR_STRENGTH)
}

export interface Call {
  name: string
  input: Record<string, unknown>
  /** The loop's own answer to "does this only look?" (`isObservation`). */
  observation: boolean
}

export interface Prediction {
  key: string
  callKey: string
  kind: CommandKind | undefined
  pFail: number
  basis: 'repeat' | 'history' | 'default' | 'file'
  /** The earlier identical call, when the tree has not changed since it. */
  repeatOf?: CallRecord
  /** Whether a successful run of this call changes the tree. */
  mutates: boolean
  /** Whether it changes the tree in ways nothing here can name (a shell command, a sub-agent). */
  opaque: boolean
  path?: string
}

export interface CallRecord {
  step: number
  version: number
  failed: boolean
  head: string
}

export interface CheckFact {
  kind: CheckKind
  command: string
  passed: boolean
  version: number
  step: number
  summary: string
}

export interface Surprise {
  step: number
  key: string
  pFail: number
  failed: boolean
  bits: number
}

const pathOf = (input: Record<string, unknown>): string | undefined => (typeof input.path === 'string' && input.path ? input.path : undefined)

function commandOf(call: Call): string | undefined {
  return call.name === 'run_command' && typeof call.input.command === 'string' ? call.input.command : undefined
}

/** The first line of a failing result that says what failed, clipped. */
export function failureSummary(result: string): string {
  const lines = result.split('\n').map((line) => line.trim()).filter(Boolean)
  const hit = lines.find((line) => /\b(?:fail(?:ed|ure|s)?|error|✗|✘|expected|assert)/i.test(line)) ?? lines[0] ?? ''
  return hit.length > 110 ? `${hit.slice(0, 107)}...` : hit
}

/** Recent outcomes weighed for a run of surprises: this many calls, this many of them surprising. */
const STREAK_WINDOW = 6
const STREAK_SURPRISES = 3
/** Bits of surprise that count as "the picture of the project was wrong here": an outcome it gave under 1 chance in 4. */
const SURPRISING_BITS = 2
/** Steps to stay quiet after a streak note. */
const STREAK_COOLDOWN = 8

export interface WorldOptions {
  priors?: Priors
  /** Where to save what was learned. Undefined means the model learns for this run only. */
  savePath?: string
  cwd?: string
}

export class World {
  version = 0
  step = 0
  readonly files = new Map<string, { readAt?: number; wroteAt?: number }>()
  readonly checks = new Map<CheckKind, CheckFact>()
  readonly calls = new Map<string, CallRecord>()
  readonly surprises: Surprise[] = []
  private readonly priors: Priors
  private readonly savePath: string | undefined
  private readonly cwd: string
  /** What this run learned, added to what is on disk when it saves — never a copy of it. */
  private delta = { keys: {} as Record<string, Count>, calibration: { n: 0, brier: 0, failures: 0, bits: 0 }, notes: { repeat: 0, streak: 0 } }
  private predictions: Prediction[] = []
  private recent: boolean[] = []
  private quietUntil = 0
  private readonly repeats = new Map<string, number>()

  constructor(options: WorldOptions = {}) {
    this.priors = options.priors ?? emptyPriors()
    this.savePath = options.savePath
    this.cwd = options.cwd ?? process.cwd()
  }

  private absolute(path: string): string {
    return resolve(this.cwd, path).replace(/\\/g, '/')
  }

  /** The prediction for one call, before it runs. Pure: it changes nothing. */
  predict(call: Call, ignoreRepeat = false): Prediction {
    const command = commandOf(call)
    const kind = command === undefined ? undefined : classifyCommand(command)
    const key = call.name === 'run_command' ? `run_command:${kind}` : call.name
    const path = pathOf(call.input)
    const identity = command === undefined ? JSON.stringify(call.input) : canonicalizeCommandForIdentity(command)
    const callKey = `${call.name}\u0000${identity}`

    const writer = FILE_WRITERS.has(call.name) && path !== undefined
    // A check reads the source and writes only its own output; `git status`
    // reads. Neither changes what the agent has been editing, whatever the
    // loop's classifier says about a shell command it cannot see into.
    const inert = kind !== undefined && (isCheck(kind) || kind === 'git-read')
    const opaque = !call.observation && !writer && !inert
    const mutates = writer || opaque

    // Asking again about something that was answered against this very tree: the
    // answer is the same one, for anything that only looks or is a check.
    const previous = this.calls.get(callKey)
    const deterministic = call.observation || (kind !== undefined && isCheck(kind))
    if (!ignoreRepeat && previous && previous.version === this.version && deterministic) {
      return { key, callKey, kind, pFail: previous.failed ? 0.95 : 0.05, basis: 'repeat', repeatOf: previous, mutates, opaque, ...(path ? { path } : {}) }
    }

    // Editing a file this run has not looked at is the classic way an edit fails.
    if (call.name === 'edit_file' && path !== undefined) {
      const known = this.files.get(this.absolute(path))
      if (known?.readAt === undefined && known?.wroteAt === undefined) return { key, callKey, kind, pFail: Math.max(0.4, pFailFrom(key, call.name, this.priors)), basis: 'file', mutates, opaque, path }
    }

    const seen = this.priors.keys[key]
    return { key, callKey, kind, pFail: pFailFrom(key, call.name, this.priors), basis: seen && seen.ok + seen.fail >= PRIOR_STRENGTH ? 'history' : 'default', mutates, opaque, ...(path ? { path } : {}) }
  }

  /** Predict every call in a batch before any of them runs. */
  beforeBatch(calls: readonly Call[]): void {
    const first = calls.map((call) => this.predict(call))
    // Calls in a batch run at once, so when one changes the tree there is no
    // saying whether another saw it: a repeat cannot be claimed inside it.
    this.predictions = first.some((prediction) => prediction.mutates) ? calls.map((call) => this.predict(call, true)) : first
  }

  /**
   * Fold in a finished batch: what happened against what was predicted. Returns
   * something the agent should be told, or nothing — which is almost always.
   */
  afterBatch(calls: readonly Call[], outcomes: ReadonlyArray<{ isError: boolean; result: string } | undefined>, durations: ReadonlyArray<number> = []): string | undefined {
    const notes: string[] = []
    for (const [index, call] of calls.entries()) {
      const outcome = outcomes[index]
      const prediction = this.predictions[index]
      if (!outcome || !prediction) continue
      const note = this.observe(call, prediction, outcome, durations[index] ?? 0)
      if (note) notes.push(note)
    }
    this.predictions = []
    const streak = this.surpriseStreak()
    if (notes.length === 0 && streak) notes.push(streak)
    return notes[0]
  }

  private observe(call: Call, prediction: Prediction, outcome: { isError: boolean; result: string }, durationMs: number): string | undefined {
    this.step += 1
    const failed = outcome.isError
    const p = failed ? prediction.pFail : 1 - prediction.pFail
    const bits = -Math.log2(Math.max(p, 1e-3))

    // Scored against what was committed before the call, whichever way it went.
    const cal = this.delta.calibration
    cal.n += 1
    cal.brier += (prediction.pFail - (failed ? 1 : 0)) ** 2
    cal.failures += failed ? 1 : 0
    cal.bits += bits
    const counts = (this.delta.keys[prediction.key] ??= { ok: 0, fail: 0 })
    if (failed) counts.fail += 1
    else counts.ok += 1
    if (durationMs > 0) counts.ms = (counts.ms ?? 0) + durationMs
    // The same call against the same tree, asked again: an answer that changed is a flake.
    if (prediction.repeatOf) {
      counts.repeats = (counts.repeats ?? 0) + 1
      if (prediction.repeatOf.failed !== failed) counts.flips = (counts.flips ?? 0) + 1
    }
    // In-run learning too, so the second `bun test` is predicted better than the first.
    const live = (this.priors.keys[prediction.key] ??= { ok: 0, fail: 0 })
    if (failed) live.fail += 1
    else live.ok += 1

    const surprising = bits >= SURPRISING_BITS
    this.recent = [...this.recent, surprising && failed].slice(-STREAK_WINDOW)
    if (surprising) {
      this.surprises.push({ step: this.step, key: prediction.key, pFail: prediction.pFail, failed, bits })
      if (this.surprises.length > 50) this.surprises.shift()
    }

    // The tree: what this call changed, and what is now known about it.
    const path = prediction.path === undefined ? undefined : this.absolute(prediction.path)
    if (call.name === 'read_file' && path && !failed) this.files.set(path, { ...this.files.get(path), readAt: this.version })
    if (prediction.mutates && (prediction.opaque || !failed)) {
      this.version += 1
      if (path && FILE_WRITERS.has(call.name) && !failed) this.files.set(path, { ...this.files.get(path), wroteAt: this.version })
    }

    const command = commandOf(call)
    if (prediction.kind && isCheck(prediction.kind) && command !== undefined) {
      this.checks.set(prediction.kind, { kind: prediction.kind, command, passed: !failed, version: this.version, step: this.step, summary: failed ? failureSummary(outcome.result) : '' })
    }
    const previous = prediction.repeatOf
    this.calls.set(prediction.callKey, { step: this.step, version: this.version, failed, head: failed ? failureSummary(outcome.result) : '' })

    // The same failing check, against a tree nothing has touched: the loop every
    // stuck agent is in. Said once it has happened, and louder the third time.
    if (previous && previous.failed && failed && prediction.repeatOf?.version === this.version) {
      const times = (this.repeats.get(prediction.callKey) ?? 0) + 1
      this.repeats.set(prediction.callKey, times)
      this.delta.notes.repeat += 1
      const label = command ?? call.name
      return (
        `[elia world model] \`${label.length > 80 ? `${label.slice(0, 77)}...` : label}\` ran at step ${previous.step} with nothing in the tree changed since, and failed then too` +
        `${previous.head ? ` (${previous.head})` : ''}. Same code, same result${times >= 2 ? `; this is identical run ${times + 1}` : ''}. Change the code, or run something different, before running it again.`
      )
    }
    return undefined
  }

  /** A run of failures the picture of the project did not expect: a sign the picture is stale. */
  private surpriseStreak(): string | undefined {
    if (this.step < this.quietUntil) return undefined
    if (this.recent.filter(Boolean).length < STREAK_SURPRISES) return undefined
    this.quietUntil = this.step + STREAK_COOLDOWN
    this.recent = []
    this.delta.notes.streak += 1
    return (
      `[elia world model] ${STREAK_SURPRISES} of your last ${STREAK_WINDOW} actions failed that this project's record says usually work. ` +
      `That is a sign what you believe about the current state is out of date. Re-read the actual state (the file, \`git status\`, the config) before the next edit.`
    )
  }

  /**
   * The state the runtime holds, as text — for the moment the conversation that
   * carried it is compacted away. Undefined until there is something to say.
   */
  snapshot(): string | undefined {
    const written = [...this.files.entries()].filter(([, fact]) => fact.wroteAt !== undefined).map(([path]) => this.relative(path))
    const checks = [...this.checks.values()]
    if (written.length === 0 && checks.length === 0) return undefined
    const lines = ['[elia world state — kept by the runtime, so it is true even where the conversation was compacted]']
    if (written.length > 0) lines.push(`- changed this run: ${written.slice(0, 12).join(', ')}${written.length > 12 ? ` and ${written.length - 12} more` : ''}`)
    for (const check of checks) {
      const since = this.version - check.version
      lines.push(
        `- ${check.kind}: ${check.passed ? 'passed' : 'FAILED'} at step ${check.step} (\`${check.command.length > 60 ? `${check.command.slice(0, 57)}...` : check.command}\`)${check.passed ? '' : check.summary ? ` — ${check.summary}` : ''}${since > 0 ? `; ${since} change${since === 1 ? '' : 's'} since, so this may no longer hold` : '; nothing has changed since'}`,
      )
    }
    return lines.join('\n')
  }

  private relative(path: string): string {
    const root = this.cwd.replace(/\\/g, '/').replace(/\/$/, '')
    return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path
  }

  /** Adds what this run learned to what is already on disk. Never throws: a lost update costs one run's worth of learning. */
  save(): void {
    if (!this.savePath || this.delta.calibration.n === 0) return
    const target = this.savePath
    try {
      ensureSecureDirectory(dirname(target))
      withFileLock(`${target}.lock`, () => {
        const disk = readPriors(target)
        for (const [key, add] of Object.entries(this.delta.keys)) {
          const count = (disk.keys[key] ??= { ok: 0, fail: 0 })
          count.ok += add.ok
          count.fail += add.fail
          if (add.ms) count.ms = (count.ms ?? 0) + add.ms
          if (add.repeats) count.repeats = (count.repeats ?? 0) + add.repeats
          if (add.flips) count.flips = (count.flips ?? 0) + add.flips
          if (count.ok + count.fail > COUNT_CEILING) {
            for (const field of ['ok', 'fail', 'ms', 'repeats', 'flips'] as const) if (count[field] !== undefined) count[field] = Math.round(count[field]! / 2)
          }
        }
        const cal = disk.calibration
        cal.n += this.delta.calibration.n
        cal.brier += this.delta.calibration.brier
        cal.failures += this.delta.calibration.failures
        cal.bits += this.delta.calibration.bits
        disk.notes.repeat += this.delta.notes.repeat
        disk.notes.streak += this.delta.notes.streak
        disk.updatedAt = Date.now()
        writeSecureFile(target, `${JSON.stringify(disk)}\n`)
      })
      // Written once: a loop that finishes through two paths must not count twice.
      this.delta.keys = {}
      this.delta.calibration = { n: 0, brier: 0, failures: 0, bits: 0 }
      this.delta.notes = { repeat: 0, streak: 0 }
    } catch {
      // See above.
    }
  }
}

/** `ELIA_WORLD=off` removes the runtime model entirely: the control arm for what it does. */
export function worldEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.ELIA_WORLD ?? '').trim().toLowerCase() !== 'off'
}

/**
 * The model for one run. It learns from this project's record on disk and adds
 * to it, unless `ELIA_WORLD_PERSIST=off` (benchmark tasks set it: a task's temp
 * repository is not a project, and must not grow files the task did not make).
 */
export function createWorld(cwd = process.cwd(), env: Record<string, string | undefined> = process.env): World | undefined {
  if (!worldEnabled(env)) return undefined
  const persist = (env.ELIA_WORLD_PERSIST ?? '').trim().toLowerCase() !== 'off'
  const path = runtimePriorsPath()
  return new World({ cwd, ...(persist ? { priors: readPriors(path), savePath: path } : {}) })
}

export interface RuntimeStatus {
  predictions: number
  brier: number | undefined
  /** Brier score of always predicting this project's own failure rate: what the model must beat to be worth anything. */
  baseline: number | undefined
  failureRate: number | undefined
  /** How much better than the baseline, as a fraction of it. Positive means the predictions carry information. */
  skill: number | undefined
  meanSurpriseBits: number | undefined
  learned: Array<{ key: string; runs: number; failRate: number }>
  notes: { repeat: number; streak: number }
}

/** Fewer scored predictions than this and the skill number is noise. */
export const MIN_SCORED = 30

export function runtimeStatus(priors: Priors): RuntimeStatus {
  const { n, brier, failures, bits } = priors.calibration
  const rate = n > 0 ? failures / n : undefined
  const baseline = rate === undefined ? undefined : rate * (1 - rate)
  const measured = n > 0 ? brier / n : undefined
  return {
    predictions: n,
    brier: measured,
    baseline,
    failureRate: rate,
    skill: measured !== undefined && baseline !== undefined && baseline > 0 && n >= MIN_SCORED ? 1 - measured / baseline : undefined,
    meanSurpriseBits: n > 0 ? bits / n : undefined,
    learned: Object.entries(priors.keys)
      .map(([key, count]) => ({ key, runs: count.ok + count.fail, failRate: (count.ok + count.fail) > 0 ? count.fail / (count.ok + count.fail) : 0 }))
      .filter((entry) => entry.runs >= 3)
      .sort((a, b) => b.runs - a.runs)
      .slice(0, 6),
    notes: priors.notes,
  }
}

export function renderRuntime(status: RuntimeStatus): string {
  if (status.predictions === 0) return "  runtime: no run has been modelled in this project yet — every run from now on predicts each action before taking it and is scored on the outcome"
  const pct = (value: number) => `${Math.round(value * 100)}%`
  const lines = [`  runtime: ${status.predictions} action(s) predicted before they ran, ${pct(status.failureRate ?? 0)} of them failed`]
  if (status.skill === undefined) lines.push(`    accuracy: not enough yet — needs ${MIN_SCORED} scored predictions, has ${status.predictions}`)
  else {
    lines.push(
      `    accuracy: Brier ${status.brier!.toFixed(3)} against ${status.baseline!.toFixed(3)} for always guessing this project's own failure rate — ${status.skill >= 0 ? `${pct(status.skill)} better` : `${pct(-status.skill)} WORSE, so its predictions are not informative here`}`,
    )
  }
  if (status.learned.length > 0) lines.push(`    learned here: ${status.learned.map((entry) => `${entry.key.replace('run_command:', '')} fails ${pct(entry.failRate)} of ${entry.runs}`).join(', ')}`)
  if (status.notes.repeat + status.notes.streak > 0) lines.push(`    told the agent: ${status.notes.repeat} identical failing re-run(s), ${status.notes.streak} stale-picture warning(s)`)
  return lines.join('\n')
}
