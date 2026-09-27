import { emitEvent } from '../ui/runtime.ts'
import { writeNotice } from '../ui/stream.ts'
import { ScheduleStore, type ScheduleRecord } from './scheduler.ts'
import type { runAutonomousTask as RunAutonomousTask } from './loop.ts'

export interface ScheduledDaemonOptions {
  scheduleFile?: string
  pollMs?: number
  once?: boolean
  signal?: AbortSignal
  /** How many due schedules one tick may run at once. Defaults to `defaultMaxConcurrentSchedules()`. */
  maxConcurrent?: number
  /** Test seam: replaces autonomy/loop.ts's runAutonomousTask. */
  runTask?: typeof RunAutonomousTask
}

const DEFAULT_POLL_MS = 30_000
const MIN_POLL_MS = 1_000
/** Mirrors fleet.ts's own DEFAULT_FLEET_CONCURRENCY/MAX_FLEET_CONCURRENCY split. */
const DEFAULT_MAX_CONCURRENT_SCHEDULES = 4
const MAX_MAX_CONCURRENT_SCHEDULES = 16

/**
 * How many due schedules a single tick may claim and run at once.
 * `ELIA_MAX_CONCURRENT_SCHEDULES` overrides it, clamped to [1, 16] — 1
 * restores the old single-flight behavior. Each schedule still runs as its
 * own independent `runAutonomousTask`, so this is bounded parallelism
 * across *different* goals, not extra concurrency inside any one of them.
 */
export function defaultMaxConcurrentSchedules(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(env.ELIA_MAX_CONCURRENT_SCHEDULES ?? '', 10)
  return Number.isFinite(raw) && raw >= 1 ? Math.min(raw, MAX_MAX_CONCURRENT_SCHEDULES) : DEFAULT_MAX_CONCURRENT_SCHEDULES
}

export async function runScheduledDaemon(options: ScheduledDaemonOptions = {}): Promise<void> {
  const store = ScheduleStore.open(options.scheduleFile)
  const pollMs = Math.max(MIN_POLL_MS, options.pollMs ?? DEFAULT_POLL_MS)
  const maxConcurrent = Math.max(1, Math.min(options.maxConcurrent ?? defaultMaxConcurrentSchedules(), MAX_MAX_CONCURRENT_SCHEDULES))

  const tick = async (): Promise<void> => {
    const recovered = store.recoverExpired()
    for (const schedule of recovered) {
      writeNotice(`Recovered expired schedule lease: ${schedule.title} (${schedule.id})`)
    }

    // Each schedule is claimed independently (ScheduleStore.claim() takes its
    // own cross-process lock per call), so running up to maxConcurrent of
    // them at once is safe: a second due schedule no longer waits out an
    // entire poll interval — commonly 30s — behind an unrelated first one.
    const due = store.due().slice(0, maxConcurrent)
    if (due.length === 0) {
      emitEvent('scheduler_idle', { due: 0 })
      return
    }

    await Promise.all(due.map((schedule) => runOneSchedule(schedule, store, options)))
  }

  await tick()
  if (options.once) return

  while (!options.signal?.aborted) {
    await waitForNextPoll(pollMs, options.signal)
    if (!options.signal?.aborted) await tick()
  }
}

async function runOneSchedule(next: ScheduleRecord, store: ScheduleStore, options: ScheduledDaemonOptions): Promise<void> {
  let claimed: ScheduleRecord
  try {
    claimed = store.claim(next.id)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    if (detail.includes('not due') || detail.includes('store is busy')) {
      emitEvent('scheduler_skipped', { scheduleId: next.id, reason: detail })
      return
    }
    throw error
  }
  emitEvent('scheduler_started', { scheduleId: claimed.id, title: claimed.title, goal: claimed.goal })
  writeNotice(`Running scheduled goal: ${claimed.title}`)
  try {
    const { autoApprove, runAutonomousTask } = await import('./loop.ts')
    const runTask = options.runTask ?? runAutonomousTask
    const result = await runTask({
      goal: claimed.goal,
      approve: autoApprove,
      mode: claimed.mode,
      profile: claimed.profile,
      maxWallClockMs: claimed.maxRunMs,
      maxActions: claimed.maxActions,
      governanceMode: 'unattended',
      polish: true,
      signal: options.signal,
    })
    store.complete(claimed.id, {
      runId: result.runId,
      outcome: result.outcome,
      error: result.outcome === 'completed' ? undefined : result.completion.blockers.join('; ') || result.completion.nextActions[0],
    })
    emitEvent('scheduler_finished', { scheduleId: claimed.id, runId: result.runId, outcome: result.outcome, completion: result.completion })
    writeNotice(`Scheduled goal finished: ${result.outcome} (${result.completion.state})`)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const runId = `scheduler-${Date.now().toString(36)}`
    store.complete(claimed.id, { runId, outcome: 'needs-attention', error: detail })
    emitEvent('scheduler_failed', { scheduleId: claimed.id, runId, error: detail })
    writeNotice(`Scheduled goal failed: ${detail}`)
  }
}

function waitForNextPoll(pollMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, pollMs)
    if (signal?.aborted) finish()
    else signal?.addEventListener('abort', finish, { once: true })
  })
}
