/**
 * The resource-reservation ledger — the workspace's conflict-prevention core.
 *
 * Before the orchestrator hands a task to an agent it reserves that task's
 * declared files (as `path:<glob>` resources). A reservation is a lease: the
 * task's heartbeat renews it, completion releases it, and an expired one is
 * reclaimed. Two tasks whose file sets overlap can never hold exclusive
 * reservations at once, so they are never dispatched concurrently even if the
 * planner forgot the `dependsOn`.
 *
 * Glob overlap reuses the same normalisation `src/autonomy/fleet.ts` uses for
 * wave collision planning.
 */

import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import { LEASE_TTL_MS, type AssigneeKind, type ReservationRecord } from './types.ts'
import type { WorkspaceStore } from './store.ts'

function normalize(pathOrGlob: string): string {
  return posix.normalize(pathOrGlob.replace(/\\/g, '/')).replace(/^\.\//, '').replace(/\/+$/, '')
}

/** A conservative "could these two path patterns ever name the same file?" test. */
export function globsOverlap(a: string, b: string): boolean {
  const na = normalize(a)
  const nb = normalize(b)
  if (na === nb) return true
  const [shorter, longer] = na.length <= nb.length ? [na, nb] : [nb, na]
  const prefix = shorter.replace(/\*+.*$/, '').replace(/\/[^/]*$/, '')
  // A directory glob (`src/ui/**`) collides with anything beneath that directory.
  if ((shorter.includes('*') || longer.includes('*')) && prefix && longer.startsWith(prefix)) return true
  // A bare directory reservation collides with files inside it.
  return longer.startsWith(`${shorter}/`) || shorter.startsWith(`${longer}/`)
}

export function resourceFor(fileOrGlob: string): string {
  return `path:${normalize(fileOrGlob)}`
}

export interface ReservationConflict {
  resource: string
  heldBy: string
  taskId: string
}

/**
 * Try to reserve every resource a task needs. All-or-nothing: on the first
 * conflict nothing is acquired and the conflicts are returned so the caller can
 * leave the task `ready` and try again next tick.
 */
export function acquireForTask(
  store: WorkspaceStore,
  input: { taskId: string; objectiveId: string; holderKind: AssigneeKind; holderId: string; resources: string[]; now?: number },
): { acquired: string[] } | { conflicts: ReservationConflict[] } {
  const now = input.now ?? Date.now()
  const wanted = [...new Set(input.resources.map((resource) => (resource.startsWith('path:') || resource.startsWith('component:') || resource.startsWith('task:') ? resource : resourceFor(resource))))]
  if (wanted.length === 0) return { acquired: [] }

  // The conflict check and the inserts must be one atomic unit: otherwise two
  // overlapping dispatches can both read an empty conflict set and then both
  // reserve the same resource, putting two agents on the same files.
  return store.transact<{ acquired: string[] } | { conflicts: ReservationConflict[] }>(() => {
    const live = store.reservations(true).filter((reservation) => reservation.expiresAt > now)
    const conflicts: ReservationConflict[] = []
    for (const resource of wanted) {
      for (const held of live) {
        if (held.taskId === input.taskId) continue
        if (resourcesConflict(resource, held.resource)) {
          conflicts.push({ resource, heldBy: held.holderId, taskId: held.taskId })
        }
      }
    }
    if (conflicts.length > 0) return { conflicts }

    const acquired: string[] = []
    for (const resource of wanted) {
      const id = `rsv_${randomUUID().replaceAll('-', '').slice(0, 20)}`
      store.append({
        type: 'ReservationAcquired',
        actorKind: input.holderKind,
        actorId: input.holderId,
        objectiveId: input.objectiveId,
        taskId: input.taskId,
        payload: { id, resource, mode: 'exclusive', holderKind: input.holderKind, holderId: input.holderId, acquiredAt: now, expiresAt: now + LEASE_TTL_MS },
      })
      acquired.push(id)
    }
    return { acquired }
  })
}

function resourcesConflict(a: string, b: string): boolean {
  if (a === b) return true
  const [aKind, aVal] = split(a)
  const [bKind, bVal] = split(b)
  if (aKind !== bKind) return false
  if (aKind === 'path') return globsOverlap(aVal, bVal)
  return aVal === bVal
}

function split(resource: string): [string, string] {
  const index = resource.indexOf(':')
  return index === -1 ? ['path', resource] : [resource.slice(0, index), resource.slice(index + 1)]
}

/** Renew every live reservation a task holds (called from the task heartbeat). */
export function renewForTask(store: WorkspaceStore, taskId: string, now = Date.now()): number {
  const held = store.reservations(true).filter((reservation) => reservation.taskId === taskId)
  for (const reservation of held) {
    store.append({
      type: 'ReservationRenewed',
      actorKind: 'system',
      actorId: 'orchestrator',
      taskId,
      payload: { id: reservation.id, expiresAt: now + LEASE_TTL_MS },
    })
  }
  return held.length
}

/** Release every reservation a task holds (completion, failure, cancellation). */
export function releaseForTask(store: WorkspaceStore, taskId: string, actorId = 'orchestrator'): string[] {
  const held = store.reservations(true).filter((reservation) => reservation.taskId === taskId)
  for (const reservation of held) {
    store.append({
      type: 'ReservationReleased',
      actorKind: 'system',
      actorId,
      taskId,
      payload: { id: reservation.id },
    })
  }
  return held.map((reservation) => reservation.id)
}

/** Free reservations whose lease has expired. */
export function reconcileReservations(store: WorkspaceStore, now = Date.now()): ReservationRecord[] {
  const expired = store.reservations(true).filter((reservation) => reservation.expiresAt <= now)
  for (const reservation of expired) {
    store.append({ type: 'ReservationExpired', actorKind: 'system', actorId: 'lease-reconciler', taskId: reservation.taskId, payload: { id: reservation.id } })
  }
  return expired
}
