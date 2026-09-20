// Practice without being asked.
//
// `elia evolve` is the loop that changes elia itself, and for a month it ran
// only when someone typed it — which was twice. This is what runs it instead:
// when the REPL goes idle (or closes) and there is something new to learn
// from, one generation starts in a detached background process, and the next
// session opens by saying what came of it.
//
// It stays out of the way by construction, not by a spending cap:
//   - one run at a time, across every elia process (a pid in the state file);
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
import { isProcessAlive } from '../fileLock.ts'
import { writeSecureFile } from '../securePersistence.ts'
import { EVOLUTION_DIR } from './ledger.ts'

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

export type AutoOutcome = 'promoted' | 'rejected' | 'blocked' | 'failed' | 'benchmarked'

export interface AutoImproveState {
  pid?: number
  startedAt?: number
  finishedAt?: number
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

/** Whether to start a practice run now, and if not, why not. Pure. */
export function shouldStartPractice(state: AutoImproveState, check: StartCheck): { start: boolean; reason: string } {
  const alive = check.alive ?? isProcessAlive
  if (check.enabled === false) return { start: false, reason: 'ELIA_AUTO_IMPROVE is off' }
  // A pid is only trusted for a while: Windows reuses them, and a run that
  // crashed without writing finishedAt must not hold the slot forever.
  const fresh = state.startedAt === undefined || check.now - state.startedAt < MAX_RUN_MS
  if (state.pid !== undefined && state.finishedAt === undefined && fresh && alive(state.pid)) return { start: false, reason: 'a practice run is already going' }
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
  const state = readAutoImproveState(statePath)
  writeAutoImproveState({ ...state, newTurns: (state.newTurns ?? 0) + 1 }, statePath)
}

/** Practice changes elia's own source, so it needs a checkout of it — not an installed package. */
export function canPractice(root = ELIA_ROOT): boolean {
  return existsSync(join(root, '.git')) && existsSync(join(root, 'bin', 'elia.ts'))
}

/**
 * Starts `elia evolve --auto` detached, so it keeps going after this session
 * closes. Returns false when the rules say not to (see `shouldStartPractice`).
 */
export async function maybeStartPractice(options: { now?: number; statePath?: string } = {}): Promise<boolean> {
  const statePath = options.statePath ?? AUTO_IMPROVE_STATE
  const state = readAutoImproveState(statePath)
  const now = options.now ?? Date.now()
  const decision = shouldStartPractice(state, { now, enabled: autoImproveEnabled() })
  if (!decision.start || !canPractice()) return false

  const entry = join(ELIA_ROOT, 'bin', 'elia.ts')
  let log: number | undefined
  try {
    mkdirSync(EVOLUTION_DIR, { recursive: true })
    log = openSync(AUTO_IMPROVE_LOG, 'a')
    const child = spawn(process.execPath, [entry, 'evolve', '--auto'], {
      // elia's own checkout, whatever project this session was in: the
      // benchmark history, reach map and evolve ledger all live there.
      cwd: ELIA_ROOT,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', log, log],
      env: { ...process.env, NO_COLOR: '1', ELIA_AUTO_IMPROVE_CHILD: '1' },
    })
    child.unref()
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

/** The line a session opens with after a practice run finished, once. Marks it reported. */
export function takePracticeReport(statePath = AUTO_IMPROVE_STATE): string | undefined {
  const state = readAutoImproveState(statePath)
  if (state.finishedAt === undefined || state.reported || !state.summary) return undefined
  writeAutoImproveState({ ...state, reported: true }, statePath)
  return state.summary
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
  const lines = ['practice — elia runs one evolve generation by itself when idle (ELIA_AUTO_IMPROVE=off to stop)']
  if (state.startedAt === undefined) lines.push('  never run yet')
  else if (state.finishedAt === undefined) lines.push(`  running since ${new Date(state.startedAt).toISOString().slice(0, 16).replace('T', ' ')}`)
  else lines.push(`  last: ${new Date(state.finishedAt).toISOString().slice(0, 16).replace('T', ' ')} — ${state.summary ?? state.outcome ?? 'finished'}`)
  const next = shouldStartPractice(state, check)
  lines.push(`  next: ${next.start ? 'will start the next time a session goes idle or closes' : `waiting — ${next.reason}`}`)
  return lines.join('\n')
}
