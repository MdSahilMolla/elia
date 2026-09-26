/**
 * The run-loop wiring that makes the session bus real: a small, dependency-light
 * task-runner driver plus the cross-session cost-tagging seam.
 *
 * This module owns the *integration* of the parallel-session feature:
 *   - `runSessionPlusTaskRunner` drives one session's loop and demonstrates
 *     non-interrupting delegation: a CLI task queued into the session
 *     is popped at a plan-step boundary (via `popNextTask` in delegation.ts),
 *     marked active, executed, then tracked `done` — it never mutates an
 *     in-flight plan step and never blocks the session that queues into another.
 *   - `withSessionCostTracking` tags every LLM/usage recording emitted inside an
 *     async unit with the owning `SessionId`, so the status bar and cost views
 *     can attribute spend per session without threading a context argument
 *     through `recordUsage`/`setProcessProvenance` call sites.
 *   - `wireCrossSessionDependencies` boots the dependent-session runners once
 *     their upstreams satisfy (the E2E bootstrap).
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { popNextTask, trackDelegation } from './delegation.ts'
import type { DelegationRecord, SessionBus, SessionHandle, SessionId } from './types.ts'

/**
 * Ambient session id for cost attribution.
 *
 * The mechanism is deliberately read-only for the existing call sites: nothing
 * in usage.ts / ledger.ts / provenance.ts / subagent.ts is changed to get the
 * tag. Instead, a unit that wants its LLM spend attributed to a session wraps
 * itself in `withSessionCostTracking`; deeper frames — `recordUsage(usage,
 * model)` in subagent.ts, `setProcessProvenance({ sessionId, ... })` in
 * provenance.ts, ledger archive writes — can consult `currentSessionIdForCost()`
 * and opt the value in. Outside a wrapping scope the value is `undefined`, which
 * is exactly today's untagged behaviour, so unwrapped production paths are
 * unchanged.
 */
const sessionCostStorage = new AsyncLocalStorage<SessionId>()

/** The session id a cost/usage recording is currently attributed to, if any. */
export function currentSessionIdForCost(): SessionId | undefined {
  return sessionCostStorage.getStore()
}

/** Runs `fn` with `sessionId` as its ambient cost tag; restores the outer tag on return. */
export function withSessionCostTracking<T>(fn: () => Promise<T>, sessionId: SessionId): Promise<T> {
  return sessionCostStorage.run(sessionId, fn)
}

export interface SessionRunnerOptions {
  /** The registry that owns `handleId`. */
  bus: SessionBus
  /**
   * Executes one delegated task. Injected so the runner is LLM-free and
   * unit-testable; a real deployment swaps in a sub-agent executor. The runner
   * already marks the record `active` and later `done` via `trackDelegation`.
   */
  runTask: (record: DelegationRecord) => void | Promise<void>
  /**
   * Simulated main-plan step budget: how many empty step boundaries the runner
   * executes before declaring the session `done`. `undefined` runs until
   * `signal` aborts (a continuously working session).
   */
  steps?: number
  /** Poll interval for dependency and queue re-checks, in ms. Default 50. */
  pollMs?: number
  /** Cooperative cancellation. `steps` is the bounded alternative. */
  signal?: AbortSignal
}

/**
 * Drives one session's run loop.
 *
 * Loop contract per iteration:
 *   1. unsatified dependencies → `blocked` and wait (re-reading via `bus.get`),
 *      so a session never starts work before the upstream it depends on fires;
 *   2. otherwise `running`, then at the *plan-step boundary*: `popNextTask`.
 *      When a queued delegation pops, it is marked `active` (activeAgents +1),
 *      executed, and tracked `done` — the delegation landed append-only while
 *      the planner was between steps, so it never interrupts the running step;
 *   3. an empty boundary advances the simulated plan step
 *      (`lastActivity`/`lastTask` refresh) or, with a bounded `steps` budget,
 *      completes the session.
 */
export async function runSessionPlusTaskRunner(handleId: string, opts: SessionRunnerOptions): Promise<void> {
  const { bus, runTask, steps, pollMs = 50, signal } = opts
  let planStep = 0
  while (signal?.aborted !== true) {
    const handle = bus.resolve(handleId) ?? bus.get(handleId as SessionId)
    if (!handle) return

    const waitingOn = handle.dependencies.filter((dependency) => !dependency.satisfied)
    if (waitingOn.length > 0) {
      bus.setStatus(handle.id, 'blocked', `waiting on ${waitingOn.map((dependency) => dependency.on).join(', ')}`)
      await Bun.sleep(pollMs)
      continue
    }

    if (handle.status !== 'running') bus.setStatus(handle.id, 'running')

    const record = popNextTask(handle, { planStepIndex: planStep })
    if (record) {
      // popNextTask already flipped the record to 'active' (append-only).
      handle.lastActivity = Date.now()
      handle.lastTask = `delegated: ${record.goal}`
      handle.activeAgents += 1
      try {
        await runTask(record)
      } finally {
        handle.activeAgents = Math.max(0, handle.activeAgents - 1)
        trackDelegation(record.id, bus, 'done')
        handle.lastActivity = Date.now()
        handle.lastTask = `done: ${record.goal}`
      }
      continue
    }

    if (steps !== undefined && planStep >= steps) {
      bus.setStatus(handle.id, 'done')
      return
    }
    planStep += 1
    handle.lastActivity = Date.now()
    handle.lastTask = `step ${planStep}`
    await Bun.sleep(pollMs)
  }
}

export interface SessionWiring {
  /** Stops future arming and aborts the runners the wiring started. */
  dispose(): void
  /** Resolves once every runner the wiring started has exited. */
  drain(): Promise<void>
}

const NOOP_TASK: (record: DelegationRecord) => void = () => {}

/**
 * Bootstrap used by the E2E and the CLI: keeps one task runner armed per
 * dependency-tracked session. A dependent session's runner parks in `blocked`
 * (its own loop polls the registry) and proceeds the instant the upstream fires
 * its checkpoint or reaches `done` — no per-session scheduler and no event
 * coordination needed. Sessions without dependencies are left to their caller
 * (the CLI interactive path drives those explicitly).
 */
export function wireCrossSessionDependencies(
  bus: SessionBus,
  opts: Partial<Pick<SessionRunnerOptions, 'runTask' | 'pollMs' | 'steps'>> = {},
): SessionWiring {
  const started = new Set<SessionId>()
  const controller = new AbortController()
  const runners: Promise<void>[] = []
  const maybeStart = (handle: SessionHandle): void => {
    if (started.has(handle.id) || handle.dependencies.length === 0) return
    started.add(handle.id)
    runners.push(
      runSessionPlusTaskRunner(handle.id, {
        bus,
        runTask: opts.runTask ?? NOOP_TASK,
        pollMs: opts.pollMs,
        steps: opts.steps,
        signal: controller.signal,
      }).catch(() => {}),
    )
  }
  for (const handle of bus.list()) maybeStart(handle)
  const unsubscribe = bus.on(() => {
    for (const handle of bus.list()) maybeStart(handle)
  })
  return {
    dispose(): void {
      controller.abort()
      unsubscribe()
    },
    drain(): Promise<void> {
      return Promise.all(runners).then(() => undefined)
    },
  }
}