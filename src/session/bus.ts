import { forkMemorySlice } from './memorySlice.ts'
import {
  makeSessionId,
  type ContextDrop,
  type CreateHandleOptions,
  type DelegationRecord,
  type SessionBus,
  type SessionDependency,
  type SessionEvent,
  type SessionHandle,
  type SessionId,
  type SessionName,
  type SessionStatus,
} from './types.ts'

interface DropSubscription {
  target: SessionId
  cb: (drop: ContextDrop) => void
}

/**
 * The in-process session registry. One `SessionBus` instance keeps every
 * session the CLI / sync layer know about; `createSessionBus`
 * builds a fresh registry for tests so no state bleeds between suites.
 */
export function createSessionBus(): SessionBus {
  const registry = new Map<SessionId, SessionHandle>()
  const listeners = new Set<(event: SessionEvent) => void>()
  const dropSubscriptions = new Map<string, Set<DropSubscription>>()
  let activeId: SessionId | undefined

  const requireSession = (id: SessionId): SessionHandle => {
    const handle = registry.get(id)
    if (!handle) throw new Error(`unknown session ${id}`)
    return handle
  }

  const emit = (event: SessionEvent): void => {
    for (const listener of listeners) listener(event)
  }

  /** A dependency is satisfied when its upstream is DONE or its checkpoint fired. */
  const dependencySatisfied = (upstream: SessionHandle, dependency: SessionDependency): boolean => {
    if (upstream.status === 'done') return true
    return dependency.checkpoint !== undefined && upstream.checkpoints.has(dependency.checkpoint)
  }

  const allSatisfied = (handle: SessionHandle): boolean => handle.dependencies.every((dependency) => dependency.satisfied)

  const create = (name: SessionName, opts: CreateHandleOptions = {}): SessionHandle => {
    const id = makeSessionId()
    const parent = opts.from !== undefined ? registry.get(opts.from) : undefined
    const dependencies = (opts.dependencies ?? []).map((dependency) => {
      if (dependency.satisfied) return dependency
      const upstream = registry.get(dependency.on)
      if (upstream && dependencySatisfied(upstream, dependency)) return { ...dependency, satisfied: true }
      return dependency
    })
    const handle: SessionHandle = {
      id,
      name,
      status: dependencies.length > 0 && !dependencies.every((dependency) => dependency.satisfied)
        ? 'blocked'
        : 'running',
      worktree: opts.worktree,
      taskQueue: [],
      memorySlice: forkMemorySlice(parent?.memorySlice),
      lastActivity: Date.now(),
      activeAgents: 0,
      sharedContext: opts.sharedContext ? { ...opts.sharedContext } : {},
      dependencies,
      checkpoints: new Map(),
    }
    if (opts.lastTask !== undefined) handle.lastTask = opts.lastTask
    registry.set(id, handle)
    emit({ type: 'session:started', sessionId: id, name })
    return handle
  }

  const reevaluateDependents = (upstreamId: SessionId): void => {
    for (const handle of registry.values()) {
      if (!handle.dependencies.some((dependency) => dependency.on === upstreamId)) continue
      let changed = false
      for (const dependency of handle.dependencies) {
        if (dependency.satisfied) continue
        const upstream = registry.get(dependency.on)
        if (upstream && dependencySatisfied(upstream, dependency)) {
          dependency.satisfied = true
          changed = true
        }
      }
      if (changed && handle.status === 'blocked' && allSatisfied(handle)) {
        setStatus(handle.id, 'running', 'dependencies satisfied')
      }
    }
  }

  const setStatus = (id: SessionId, status: SessionStatus, reason?: string): void => {
    const handle = requireSession(id)
    const previous = handle.status
    handle.status = status
    handle.lastActivity = Date.now()
    if (status === 'blocked') {
      emit({ type: 'session:blocked', sessionId: id, reason: reason ?? 'unknown' })
    } else if (status === 'errored') {
      emit({ type: 'session:errored', sessionId: id, error: reason ?? 'unknown' })
    } else if (status === 'done' && previous !== 'done') {
      emit({ type: 'session:completed', sessionId: id })
    }
    if (status === 'done') reevaluateDependents(id)
  }

  return {
    get activeSession(): SessionId | undefined {
      return activeId
    },
    setActiveSession(id: SessionId | undefined): void {
      activeId = id
    },

    create,

    fork(from: SessionId, name: SessionName): SessionHandle {
      return create(name, { from })
    },

    get(id: SessionId): SessionHandle | undefined {
      return registry.get(id)
    },

    byName(name: SessionName): SessionHandle | undefined {
      const matches = [...registry.values()].filter((handle) => handle.name === name)
      return matches.length === 1 ? matches[0] : undefined
    },

    resolve(ref: string): SessionHandle | undefined {
      const byId = registry.get(ref as SessionId)
      if (byId) return byId
      const matches = [...registry.values()].filter((handle) => handle.name === ref)
      return matches.length === 1 ? matches[0] : undefined
    },

    list(): SessionHandle[] {
      return [...registry.values()]
    },

    update(id: SessionId, patch: Partial<Omit<SessionHandle, 'id'>>): void {
      const handle = requireSession(id)
      handle.lastActivity = Date.now()
      Object.assign(handle, patch)
      handle.id = id
    },

    setStatus,

    pushTask(id: SessionId, record: DelegationRecord): void {
      const handle = requireSession(id)
      handle.taskQueue.push(record)
      handle.lastActivity = Date.now()
    },

    noteCheckpoint(id: SessionId, name: string, data?: unknown): void {
      const handle = requireSession(id)
      if (handle.checkpoints.has(name)) return
      handle.checkpoints.set(name, { name, emittedAt: Date.now(), data })
      handle.lastActivity = Date.now()
      reevaluateDependents(id)
    },

    emitDrop(drop: ContextDrop): void {
      for (const subscription of dropSubscriptions.get(drop.name) ?? []) subscription.cb(drop)
      emit({ type: 'cross:context-sync', sessionId: drop.fromSession, drop })
    },

    subscribeDrop(target: SessionId, dropName: string, cb: (drop: ContextDrop) => void): () => void {
      const subscription: DropSubscription = { target, cb }
      const subscriptions = dropSubscriptions.get(dropName) ?? new Set<DropSubscription>()
      subscriptions.add(subscription)
      dropSubscriptions.set(dropName, subscriptions)
      return () => {
        subscriptions.delete(subscription)
        if (subscriptions.size === 0) dropSubscriptions.delete(dropName)
      }
    },

    emit,

    on(listener: (event: SessionEvent) => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    kill(id: SessionId): void {
      if (!registry.has(id)) return
      registry.delete(id)
      emit({ type: 'session:completed', sessionId: id })
    },
  }
}

let singleton: SessionBus | undefined

/** The process-wide session registry. One instance keeps the status bar and the CLI in sync. */
export function getSessionBus(): SessionBus {
  return (singleton ??= createSessionBus())
}