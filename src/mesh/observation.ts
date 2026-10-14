/**
 * The control-plane events one file-plane observation produces.
 *
 * Kept pure and separate from the server so the mapping can be asserted without
 * spawning a sidecar or opening a store, and so there is exactly one place that
 * decides how a file-plane fact is attributed on the event spine.
 *
 * A change the sidecar reports is a node-level fact, not a member's or an
 * agent's action, so every event is attributed to `system` with the originating
 * node id. The `FileChanged` payload is the persistable metadata from
 * `buildFileChangedPayload`; the diff body was withheld there and is
 * deliberately absent here, because the event log is durable, replicated and
 * audited.
 */

import type { WorkspaceEventInput } from '../workspace/events.ts'
import type { MeshFileChange } from './supervisor.ts'

/**
 * Whether a sidecar event is worth putting in front of someone.
 *
 * The sidecar narrates everything it does, including its own working: opening
 * watchers, starting a sync, each file it moves. Surfacing all of it turns the
 * server's output into a firehose that nobody reads, and then the two lines that
 * actually explain "the mesh is down" get scrolled away with the rest.
 *
 * So this keeps the lines that describe a change in the link or in the data, and
 * drops the ones that only confirm the sidecar is still running.
 */
export function isMeshEventNotice(kind: string): boolean {
  switch (kind) {
    case 'mesh':
    case 'connected':
    case 'disconnected':
    case 'sync-complete':
    case 'conflict':
    case 'error':
      return true
    default:
      return false
  }
}

export function meshObservationEvents(change: MeshFileChange): WorkspaceEventInput[] {
  const events: WorkspaceEventInput[] = [
    {
      type: 'FileChanged',
      actorKind: 'system',
      actorId: change.meta.originNode,
      payload: { ...change.meta },
    },
  ]
  // A preserved conflict is the whole reason the file plane is worth having, so
  // it is recorded as its own event rather than left implicit in a flag.
  if (change.conflict) {
    events.push({
      type: 'ConflictDetected',
      actorKind: 'system',
      actorId: change.meta.originNode,
      payload: { path: change.meta.path, keptPath: change.keptPath, reason: change.reason },
    })
  }
  return events
}
