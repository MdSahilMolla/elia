import { emitEvent } from '../ui/runtime.ts'
import { writeNotice } from '../ui/stream.ts'
import { ScheduleStore } from './scheduler.ts'

export interface ScheduledDaemonOptions {
  scheduleFile?: string
  pollMs?: number
  once?: boolean
  signal?: AbortSignal
}

const DEFAULT_POLL_MS = 30_000
const MIN_POLL_MS = 1_000

export async function runScheduledDaemon(options: ScheduledDaemonOptions = {}): Promise<void> {
  const store = ScheduleStore.open(options.scheduleFile)
  const pollMs = Math.max(MIN_POLL_MS, options.pollMs ?? DEFAULT_POLL_MS)
  const tick = async (): Promise<void> => {
    const recovered = store.recoverExpired()
    for (const schedule of recovered) {
      writeNotice(`Recovered expired schedule lease: ${schedule.title} (${schedule.id})`)
    }

    // Keep the worker single-flight. Parallel background actions make duplicate
    // external side effects much harder to reason about and recover safely.
    const next = store.due().at(0)
    if (!next) {
      emitEvent('scheduler_idle', { due: 0 })
      return
    }

    let claimed
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
      const result = await runAutonomousTask({
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

  await tick()
  if (options.once) return

  while (!options.signal?.aborted) {
    await waitForNextPoll(pollMs, options.signal)
    if (!options.signal?.aborted) await tick()
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
