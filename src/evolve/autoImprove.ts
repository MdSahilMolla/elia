// Practice without being asked.
//
// `elia evolve` is the loop that changes elia itself, and for a month it ran
// only when someone typed it — which was twice. This is what runs it instead:
// when the REPL goes idle (or closes) and there is something new to learn
// from, a practice run starts in a detached background process, and the next
// session opens by saying what came of it.
//
// What the run does is the resource governor's call (compounding/resourceGovernor.ts): an evolve
// generation when the benchmark can tell a gain from noise, otherwise whatever
// moves that forward first — prove new benchmark tasks, build a tool for a
// repeated habit, audit the library. Always running a generation spent credit
// on a comparison the governor itself said could not certify anything.
//
// It stays out of the way by construction, not by a spending cap:
//   - one run at a time, across every elia process (a pid in the state file,
//     claimed under a cross-process file lock so two sessions can never both
//     decide to start in the same instant);
//   - a cooldown between runs, and a longer one after a provider says it is
//     out of credit or rate-limited, so the loop never eats the quota the
//     person's own work needs;
//   - a proven change lands on its own `evolve/…` branch, never in the
//     working tree (see engine.ts `promoteTo: 'branch'`).
//
// ELIA_AUTO_IMPROVE=off turns it off.
import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ELIA_ROOT } from '../config.ts'
import { isProcessAlive, withFileLock, withFileLockAsync } from '../fileLock.ts'
import { writeSecureFile } from '../securePersistence.ts'
import { EVOLUTION_DIR } from './ledger.ts'
import { measuringNow } from './measureSlot.ts'

export const AUTO_IMPROVE_STATE = join(EVOLUTION_DIR, 'auto-improve.json')
export const AUTO_IMPROVE_LOG = join(EVOLUTION_DIR, 'auto-improve.log')

/** Between two practice runs. One generation re-runs part of the benchmark; more often than this is churn, not learning. */
export const COOLDOWN_MS = 6 * 60 * 60_000
/** After a provider refused for credit or rate limits: long enough for a daily or hourly window to reset. */
export const BLOCKED_BACKOFF_MS = 12 * 60 * 60_000
/** New recorded turns needed before practising again — without new experience a rerun only re-rolls the same dice. */
export const MIN_NEW_TURNS = 5
/** Longer than any practice run takes; past it, a recorded pid is taken to be someone else's. */
export const MAX_RUN_MS = 8 * 60 * 60_000
/** How long the REPL must sit untouched before practice starts in the background. */
export const IDLE_MS = 10 * 60_000
/** How often a running practice run says it is still alive. */
export const HEARTBEAT_MS = 60_000
/**
 * Past this with no heartbeat, a run is taken to be dead even if something still
 * holds its pid. Generous enough that a long benchmark task, a paused machine or
 * a slow disk never looks like a crash.
 */
export const HEARTBEAT_STALE_MS = 15 * 60_000

/** `practised`: the resource governor chose something other than an evolve generation, and it ran (or nothing was worth running). */
export type AutoOutcome = 'promoted' | 'rejected' | 'blocked' | 'failed' | 'benchmarked' | 'practised'

export interface AutoImproveState {
  pid?: number
  startedAt?: number
  finishedAt?: number
  /**
   * Last time the running process said it was alive. A practice run is killed,
   * not stopped — `terminateProcessGroup` uses `taskkill /F`, a closing console
   * takes the tree with it, and neither can be caught — so the only honest way
   * to tell a working run from a dead one is that a working one keeps writing.
   */
  heartbeatAt?: number
  /** Turns finished in any project since the last run started — the new experience it would learn from. */
  newTurns?: number
  outcome?: AutoOutcome
  /** One line for the person: what was tried and what came of it. */
  summary?: string
  /** The branch a promotion was committed to. */
  branch?: string
  blockedUntil?: number
  /** Set once a session has shown the summary, so it is said exactly once. */
  reported?: boolean
}

export function autoImproveEnabled(env: Record<string, string | undefined> = process.env): boolean {
  // Off under `bun test` unless a test asks: a suite that opens and closes the
  // real REPL must never leave a real evolve run going in the background.
  const raw = (env.ELIA_AUTO_IMPROVE ?? (env.NODE_ENV === 'test' ? 'off' : 'on')).trim().toLowerCase()
  return !(raw === 'off' || raw === '0' || raw === 'false' || raw === 'no')
}

export function readAutoImproveState(path = AUTO_IMPROVE_STATE): AutoImproveState {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as AutoImproveState) : {}
  } catch {
    return {}
  }
}

export function writeAutoImproveState(state: AutoImproveState, path = AUTO_IMPROVE_STATE): void {
  try {
    mkdirSync(join(path, '..'), { recursive: true })
    writeSecureFile(path, `${JSON.stringify(state, null, 2)}\n`)
  } catch {
    // Practice is a background nicety; failing to record it must never break a session.
  }
}

export interface StartCheck {
  now: number
  enabled?: boolean
  alive?: (pid: number) => boolean
}

export type PracticePhase = 'never' | 'running' | 'crashed' | 'finished'

/**
 * What became of the last practice run. `crashed` is the case the loop was blind
 * to: a run that is neither still going nor finished wrote no outcome at all, so
 * before this it was reported as "running" forever and nobody was ever told the
 * practice had died. Pure.
 */
export function practicePhase(state: AutoImproveState, check: StartCheck): PracticePhase {
  const alive = check.alive ?? isProcessAlive
  if (state.startedAt === undefined) return 'never'
  if (state.finishedAt !== undefined) return 'finished'
  // No pid means no process to have died: a record from before this existed, or
  // a half-written one. Inventing a crash from it would report a failure that
  // never happened, so it is left alone.
  if (state.pid === undefined) return 'running'
  if (!alive(state.pid)) return 'crashed'
  // A pid is only trusted for a while: Windows reuses them, and a run that
  // crashed without writing finishedAt must not hold the slot forever.
  if (check.now - state.startedAt >= MAX_RUN_MS) return 'crashed'
  // Silence from a run that had been speaking: alive is someone else's process
  // on a reused pid, or a run wedged past any useful point. A run that never
  // beat at all predates the heartbeat and is judged on its pid alone.
  if (state.heartbeatAt !== undefined && check.now - state.heartbeatAt >= HEARTBEAT_STALE_MS) return 'crashed'
  return 'running'
}

/**
 * The state to persist when a crash is newly noticed, or undefined when there is
 * nothing to reap. Recording it is what stops the status lying and lets the next
 * session say the practice died — the log is named because a killed run's only
 * evidence is what it had already written there.
 */
export function reapCrashedRun(state: AutoImproveState, check: StartCheck): AutoImproveState | undefined {
  if (practicePhase(state, check) !== 'crashed') return undefined
  // How long it *worked*, from its last heartbeat — not how long it took someone
  // to notice, which is the wrong number and the larger one.
  const detail =
    state.heartbeatAt !== undefined && state.startedAt !== undefined
      ? `it ran for ${describeSpan(state.heartbeatAt - state.startedAt)} and then stopped without finishing`
      : 'it stopped without finishing and never said how far it got'
  return {
    ...state,
    finishedAt: check.now,
    outcome: 'failed',
    summary: practiceSummary('failed', detail),
    reported: false,
  }
}

function describeSpan(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  return minutes < 90 ? `${minutes} minute(s)` : `${Math.round(minutes / 60)} hour(s)`
}

/** Whether to start a practice run now, and if not, why not. Pure. */
export function shouldStartPractice(state: AutoImproveState, check: StartCheck): { start: boolean; reason: string } {
  if (check.enabled === false) return { start: false, reason: 'ELIA_AUTO_IMPROVE is off' }
  // Only a run with a pid holds the slot; a record with no process behind it
  // falls through to the cooldown like any other.
  if (state.pid !== undefined && practicePhase(state, check) === 'running') return { start: false, reason: 'a practice run is already going' }
  if (state.blockedUntil !== undefined && check.now < state.blockedUntil) return { start: false, reason: 'the provider was out of credit or rate-limited last time' }
  if (state.startedAt !== undefined && check.now - state.startedAt < COOLDOWN_MS) return { start: false, reason: 'practised recently' }
  if (state.startedAt !== undefined && (state.newTurns ?? 0) < MIN_NEW_TURNS) return { start: false, reason: `nothing new to learn from since the last run (${state.newTurns ?? 0} of ${MIN_NEW_TURNS} turns)` }
  return { start: true, reason: 'idle, with new experience to learn from' }
}

/** A provider refusal that more attempts cannot fix — credit, quota, rate limit, or tasks it could not measure because of them. */
export function looksBlocked(text: string): boolean {
  return /\b(?:402|429)\b|rate.?limit|quota|insufficient.?(?:credit|funds|balance)|out of credit|usage limit|could not measure|unmeasured|payment required/i.test(text)
}

/**
 * One finished turn, in any project: new experience for the next practice run.
 * Counted in the shared state file rather than read from a project's own
 * records, because practice runs in elia's own checkout and the work that
 * teaches it happens everywhere else.
 */
export function notePracticeTurn(statePath = AUTO_IMPROVE_STATE): void {
  // Locked read-modify-write: two sessions counting a turn at the same time
  // must each read the other's increment, or turns are silently lost. On a busy
  // lock, proceed anyway — a lost increment is preferable to a blocked session.
  try {
    withFileLock(`${statePath}.lock`, () => {
      const state = readAutoImproveState(statePath)
      writeAutoImproveState({ ...state, newTurns: (state.newTurns ?? 0) + 1 }, statePath)
    }, { proceedOnTimeout: true })
  } catch {
    // Counting is a background nicety; never break a session on a lock failure.
  }
}

/** Practice changes elia's own source, so it needs a checkout of it — not an installed package. */
export function canPractice(root = ELIA_ROOT): boolean {
  return existsSync(join(root, '.git')) && existsSync(join(root, 'bin', 'elia.ts'))
}

/**
 * A result-shaped stand-in for the spawned child, so tests can inject one
 * without ever launching a real `elia evolve` background process.
 */
export type PracticeSpawn = (command: string, args: readonly string[], options: {
  cwd: string
  detached: boolean
  windowsHide: boolean
  stdio: Array<'ignore' | number>
  env: NodeJS.ProcessEnv
}) => { pid?: number | undefined; unref?: () => void }

/** The real process spawner; tests substitute it for a fake. */
const defaultPracticeSpawn: PracticeSpawn = (command, args, options) => spawn(command, args, options)

/** Spawn the practice run and claim the slot, holding a state the caller read under the lock. */
function practiceClaim(state: AutoImproveState, entry: string, statePath: string, now: number, spawnPractice: PracticeSpawn): boolean {
  let log: number | undefined
  try {
    mkdirSync(EVOLUTION_DIR, { recursive: true })
    log = openSync(AUTO_IMPROVE_LOG, 'a')
    const child = spawnPractice(process.execPath, [entry, 'evolve', '--auto'], {
      // elia's own checkout, whatever project this session was in: the
      // benchmark history, reach map and evolve ledger all live there.
      cwd: ELIA_ROOT,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', log, log],
      env: { ...process.env, NO_COLOR: '1', ELIA_AUTO_IMPROVE_CHILD: '1' },
    })
    child.unref?.()
    if (child.pid === undefined) return false
    // Claimed here as well as by the child, so a second session opening in
    // the same second does not start another.
    writeAutoImproveState({ ...state, pid: child.pid, startedAt: now, finishedAt: undefined, newTurns: 0, reported: false }, statePath)
    return true
  } catch {
    return false
  } finally {
    if (log !== undefined) closeSync(log)
  }
}

/**
 * Starts `elia evolve --auto` detached, so it keeps going after this session
 * closes. Returns false when the rules say not to (see `shouldStartPractice`).
 *
 * The decide→spawn→claim critical section runs under `<statePath>.lock`, so two
 * sessions racing in the same instant cannot both read "no pid" and both start
 * a run: the second to the lock re-reads the claim and declines. A lock that is
 * busy past the timeout gives up as false — never starts a second run — which
 * is the whole point of holding the lock here.
 */
export async function maybeStartPractice(options: {
  now?: number
  statePath?: string
  lockTimeoutMs?: number
  spawn?: PracticeSpawn
} = {}): Promise<boolean> {
  const statePath = options.statePath ?? AUTO_IMPROVE_STATE
  const now = options.now ?? Date.now()
  // Cheap guards first; hold the lock only for the claim itself.
  if (!canPractice()) return false
  // A bench or evolve already measuring in elia's checkout: starting now would
  // only spawn a run that gives way at once (see measureSlot.ts), and spend the
  // cooldown on nothing.
  if (measuringNow(join(ELIA_ROOT, '.elia', 'bench', 'measuring.json'))) return false
  const entry = join(ELIA_ROOT, 'bin', 'elia.ts')
  try {
    return await withFileLockAsync(
      `${statePath}.lock`,
      async () => {
        // Re-read under the lock: a claim already written (our slot, or another
        // session's that beat us here) must be seen, never spread over by a
        // stale earlier read.
        const state = readAutoImproveState(statePath)
        const decision = shouldStartPractice(state, { now, enabled: autoImproveEnabled() })
        if (!decision.start) return false
        return practiceClaim(state, entry, statePath, now, options.spawn ?? defaultPracticeSpawn)
      },
      { timeoutMs: options.lockTimeoutMs },
    )
  } catch {
    return false
  }
}

/**
 * Notices a practice run that died without recording anything and writes the
 * crash down, so the status stops calling it "running" and the next session says
 * it happened. Returns the current state either way. Locked so a reap can never
 * race a claim that is mid-write.
 */
export function reapPractice(statePath = AUTO_IMPROVE_STATE, check?: Partial<StartCheck>): AutoImproveState {
  const now = check?.now ?? Date.now()
  try {
    return withFileLock(`${statePath}.lock`, () => {
      const state = readAutoImproveState(statePath)
      const reaped = reapCrashedRun(state, { now, alive: check?.alive })
      if (!reaped) return state
      writeAutoImproveState(reaped, statePath)
      return reaped
    })
  } catch {
    // A busy lock must not break the status line; read the best state we can.
    return readAutoImproveState(statePath)
  }
}

/** The line a session opens with after a practice run finished, once. Marks it reported. */
export function takePracticeReport(statePath = AUTO_IMPROVE_STATE): string | undefined {
  // One locked read-modify-write: reaping a crash and marking a summary reported
  // belong together, or the written `reported` flag could clobber a claim that
  // lands in between.
  try {
    return withFileLock(`${statePath}.lock`, () => {
      const raw = readAutoImproveState(statePath)
      const state = reapCrashedRun(raw, { now: Date.now() }) ?? raw
      if (state.finishedAt === undefined || state.reported || !state.summary) return undefined
      writeAutoImproveState({ ...state, reported: true }, statePath)
      return state.summary
    })
  } catch {
    return undefined
  }
}

/**
 * Keeps the state file saying "still alive" while a practice run works, and
 * returns the stop function. Without this a killed run is indistinguishable
 * from a working one until its pid is reused.
 */
export function startPracticeHeartbeat(statePath = AUTO_IMPROVE_STATE, everyMs = HEARTBEAT_MS): () => void {
  const beat = () => {
    try {
      withFileLock(`${statePath}.lock`, () => {
        const state = readAutoImproveState(statePath)
        // Only ours to touch: if another run claimed the slot, stop writing.
        if (state.pid !== process.pid || state.finishedAt !== undefined) return
        writeAutoImproveState({ ...state, heartbeatAt: Date.now() }, statePath)
      }, { proceedOnTimeout: true })
    } catch {
      // A beat is best effort; a busy lock skips a beat, it never stops a run.
    }
  }
  beat()
  const timer = setInterval(beat, everyMs)
  timer.unref?.()
  return () => clearInterval(timer)
}

/** What one governed practice run did: the round's choice, and the generation if the choice was `meta`. */
export interface GovernedPractice {
  ran?: { activity: string; label: string; detail: string }
  skipped: ReadonlyArray<{ activity: string; reason: string }>
  generation?: { verdict: string; hypothesis?: string; reason: string; branch?: string }
  stoppedReason?: string
}

/**
 * How a governed practice run is reported. An evolve generation keeps the
 * outcomes practice always had — promoted, rejected, blocked; any other
 * activity is `practised`, with what it did; a round where nothing was worth
 * running says so, and why, rather than inventing progress. Pure.
 */
export function governedOutcome(practice: GovernedPractice): { outcome: AutoOutcome; detail: string; branch?: string } {
  if (practice.ran?.activity === 'meta') {
    if (practice.stoppedReason) return { outcome: looksBlocked(practice.stoppedReason) ? 'blocked' : 'failed', detail: practice.stoppedReason }
    const record = practice.generation
    if (!record) return { outcome: 'failed', detail: 'no generation was recorded' }
    if (record.verdict === 'promoted') return { outcome: 'promoted', detail: `${record.hypothesis} (${record.reason})`, ...(record.branch ? { branch: record.branch } : {}) }
    return { outcome: looksBlocked(record.reason) ? 'blocked' : 'rejected', detail: `tried "${record.hypothesis || 'a change'}": ${record.reason}` }
  }
  if (practice.ran) return { outcome: 'practised', detail: `${practice.ran.label} — ${practice.ran.detail}` }
  const first = practice.skipped[0]
  return { outcome: 'practised', detail: `nothing was worth running${first ? ` (${first.activity}: ${first.reason})` : ''}` }
}

/**
 * The summary line for a finished run. A promotion says where the change is and
 * how to take it; everything else says plainly that nothing changed.
 */
export function practiceSummary(outcome: AutoOutcome, detail: string, branch?: string): string {
  switch (outcome) {
    case 'promoted':
      return `✦ elia improved itself while you were away — ${detail}. It is on branch ${branch}; take it with \`git merge ${branch}\``
    case 'benchmarked':
    case 'practised':
      return `elia practised while you were away: ${detail}`
    case 'rejected':
      return `elia practised while you were away and kept nothing — ${detail}`
    case 'blocked':
      return `elia tried to practise but the provider refused (${detail}); it will wait before trying again`
    case 'failed':
      return `elia's practice run failed: ${detail} (log: .evolution/auto-improve.log)`
  }
}

/** What `elia compounding` says about practice: the last run, and whether the next one would start now. */
export function renderPracticeStatus(state: AutoImproveState, check: StartCheck): string {
  const lines = ['practice — when idle, elia runs the one activity its resource governor ranks first: grow the benchmark, build a tool, audit, or an evolve generation (ELIA_AUTO_IMPROVE=off to stop)']
  const phase = practicePhase(state, check)
  const at = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ')
  if (phase === 'never') lines.push('  never run yet')
  else if (phase === 'running') lines.push(`  running since ${at(state.startedAt!)}`)
  else if (phase === 'crashed') lines.push(`  started ${at(state.startedAt!)} and stopped without finishing — see ${AUTO_IMPROVE_LOG}`)
  else lines.push(`  last: ${at(state.finishedAt!)} — ${state.summary ?? state.outcome ?? 'finished'}`)
  const next = shouldStartPractice(state, check)
  lines.push(`  next: ${next.start ? 'will start the next time a session goes idle or closes' : `waiting — ${next.reason}`}`)
  return lines.join('\n')
}
