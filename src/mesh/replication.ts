/**
 * Event replication between the two nodes (M7).
 *
 * Design note §6.6: the *file* plane already has an authenticated link between
 * the two machines, with pinned certificates and one identity per machine. So
 * the control plane is not a second connection, a second keypair or a second
 * listener — workspace events ride that link as a relayed `control` frame. This
 * file owns the part that is Elia's: deciding what to send, and applying what
 * arrives.
 *
 * Two properties are load-bearing:
 *
 * - **Cursor, not state.** Each node remembers how far it has *sent* the peer.
 *   Nothing about the peer's knowledge is inferred from it, because the peer
 *   answers for itself.
 * - **Delivery is at-least-once; application is idempotent.** A batch lost to a
 *   restart is re-sent from the cursor, and `WorkspaceStore.applyRemote`
 *   deduplicates on the event `id`. Together these mean a dropped frame costs a
 *   retry and never a duplicate row.
 *
 * Process-local presence never crosses: `isReplicated` filters it out, because
 * "this WebSocket is open" is a fact about the sending process and forwarding it
 * would show the user a stranger as online.
 */

import { isReplicated } from '../workspace/authority.ts'
import type { PersistedEvent, ReplicatedEvent } from '../workspace/events.ts'
import type { WorkspaceStore } from '../workspace/store.ts'
import type { MeshControl } from './frames.ts'

/** Largest batch handed to the transport in one frame. */
export const REPLICATION_BATCH = 200

export interface ReplicationOptions {
  store: WorkspaceStore
  /** The peer node id this pump sends to; also the key for the send cursor. */
  peerNodeId: string
  /** Deliver one batch. Returning false means "not delivered"; it is retried. */
  send: (control: MeshControl) => boolean
  /** Test seams. */
  limit?: number
  intervalMs?: number
}

export interface ReplicationHandle {
  /** The cursor key this handle is keeping. */
  readonly peerNodeId: string
  /** Sends whatever the peer has not seen. Safe to call repeatedly. */
  flush(): boolean
  /** Applies a batch relayed from the peer. Returns how many events landed. */
  receive(control: MeshControl): number
  stop(): void
}

function toReplicated(event: PersistedEvent): ReplicatedEvent {
  const { seq: _seq, ...rest } = event
  return rest
}

/**
 * Whether an event is worth sending to the peer.
 *
 * Two filters:
 *
 * - Local events are facts about this process and mean nothing elsewhere.
 * - An event that **arrived from the peer** is never sent back. Without this the
 *   two nodes ping-pong: the owner sends an event, the follower applies it, and
 *   the follower then returns it, indefinitely.
 *
 * Arrival is recorded per event id, not inferred from `actorNode`. Inference
 * from `actorNode` looks equivalent and is not: a mirrored event keeps the
 * *origin* node's id, so it still reads as foreign here, while an event this node
 * wrote itself reads as local and would be suppressed — which is the exact
 * inverse of what should happen. The origin node is attribution for display, not
 * a send decision.
 */
export function shouldReplicate(event: PersistedEvent, arrivedFromPeer = false): boolean {
  if (arrivedFromPeer) return false
  return isReplicated(event.type)
}

/**
 * Start replicating to one peer.
 *
 * Deliberately one peer: the design excludes a third node, so a list would be a
 * structure with no second element to exercise.
 */
export function startReplication(options: ReplicationOptions): ReplicationHandle {
  const { store, peerNodeId, send } = options
  const limit = Math.max(1, options.limit ?? REPLICATION_BATCH)
  const intervalMs = Math.max(50, options.intervalMs ?? 1_000)
  let stopped = false
  let timer: ReturnType<typeof setInterval> | undefined = setInterval(() => { flush() }, intervalMs)
  // Nothing that ran before the peer was known should be counted as sent.
  timer.unref?.()

  function flush(): boolean {
    if (stopped) return false
    const cursor = store.replicationCursor(peerNodeId)
    const candidates = store.events({ sinceSeq: cursor, limit })
    if (candidates.length === 0) return true
    // Resolved in one query for the whole batch, then used to drop anything the
    // peer already sent us — see `shouldReplicate`.
    const arrived = store.inboundEventIds(candidates.map((event) => event.id))
    const pending = candidates.filter((event) => shouldReplicate(event, arrived.has(event.id)))
    if (pending.length === 0) {
      // Nothing to send, but the cursor must still move past the batch or the
      // same mirrored rows are re-read on every flush forever.
      store.setReplicationCursor(peerNodeId, candidates.at(-1)!.seq)
      return true
    }

    const events = pending.map(toReplicated)
    if (!send({ node: store.localNodeId, events })) return false
    // The cursor advances only over what was actually handed to the transport.
    // Advancing it before delivery would silently skip these events forever if
    // the sidecar were then restarted mid-write.
    store.setReplicationCursor(peerNodeId, pending.at(-1)!.seq)
    return true
  }

  /**
   * Apply a batch relayed from the peer.
   *
   * No "is this really mine?" filter is needed on the ids here — `applyRemote`
   * deduplicates on the event id, and an event this node genuinely wrote would
   * have been in the spine first, so the peer's copy is ignored as a duplicate.
   * That is the same guarantee for a stronger input: a peer cannot overwrite
   * this node's history by claiming its ids.
   */
  function receive(control: MeshControl): number {
    let applied = 0
    for (const event of control.events) {
      // Belt and braces: `applyRemote` would project a local event fine, but a
      // local event arriving from a peer means the peer is wrong about
      // something, and applying it would let the peer rewrite this node's state.
      if (store.applyRemote(event)) applied += 1
    }
    return applied
  }

  return {
    peerNodeId,
    flush,
    receive,
    stop() {
      stopped = true
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
    },
  }
}
