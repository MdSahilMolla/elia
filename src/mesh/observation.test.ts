import { describe, expect, it, test } from 'bun:test'
import { isMeshEventNotice, meshObservationEvents } from './observation.ts'
import type { MeshFileChange } from './supervisor.ts'

function change(overrides: Partial<MeshFileChange['meta']> & Partial<Pick<MeshFileChange, 'conflict' | 'keptPath' | 'reason'>> = {}): MeshFileChange {
  const { conflict, keptPath, reason, ...metaOverrides } = overrides
  const meta = {
    path: 'src/a.ts',
    op: 'write' as const,
    originNode: 'peer_b',
    oldSha: 'old',
    newSha: 'new',
    added: 2,
    removed: 1,
    size: 20,
    diffWithheld: false,
    ...metaOverrides,
  }
  return {
    meta,
    incoming: { ...meta },
    conflict: conflict ?? false,
    ...(keptPath !== undefined ? { keptPath } : {}),
    ...(reason !== undefined ? { reason } : {}),
  }
}

test('an ordinary change records one system-attributed FileChanged', () => {
  const events = meshObservationEvents(change())
  expect(events).toHaveLength(1)
  expect(events[0]?.type).toBe('FileChanged')
  expect(events[0]?.actorKind).toBe('system')
  expect(events[0]?.actorId).toBe('peer_b')
  expect(events[0]?.payload).toEqual({
    path: 'src/a.ts', op: 'write', originNode: 'peer_b', oldSha: 'old', newSha: 'new',
    added: 2, removed: 1, size: 20, diffWithheld: false,
  })
})

test('a preserved conflict records a ConflictDetected alongside the change', () => {
  const events = meshObservationEvents(change({ conflict: true, keptPath: 'src/a.ts.conflict-1', reason: 'both sides edited' }))
  expect(events.map((e) => e.type)).toEqual(['FileChanged', 'ConflictDetected'])
  expect(events[1]?.payload).toEqual({ path: 'src/a.ts', keptPath: 'src/a.ts.conflict-1', reason: 'both sides edited' })
})

test('a withheld path stays withheld on the event payload', () => {
  const events = meshObservationEvents(change({ path: '.env', diffWithheld: true }))
  expect(events[0]?.payload?.['diffWithheld']).toBe(true)
  // Nothing on the payload can carry the diff body; the shape is fixed scalars.
  expect(events[0]?.payload?.['diff']).toBeUndefined()
})

describe('isMeshEventNotice', () => {
  it('surfaces link and data changes but not the sidecar narrating itself', () => {
    // These are the lines that explain "the mesh is down" or "my edit did not
    // arrive", which is why they are kept.
    for (const kind of ['mesh', 'connected', 'disconnected', 'sync-complete', 'conflict', 'error']) {
      expect(isMeshEventNotice(kind)).toBe(true)
    }
    // These only confirm the sidecar is still working. A sync in progress over a
    // large tree emits hundreds; a watcher opening emits one per directory.
    for (const kind of ['info', 'sync-start', 'sync-progress', 'patch', 'watcher']) {
      expect(isMeshEventNotice(kind)).toBe(false)
    }
    expect(isMeshEventNotice('')).toBe(false)
  })
})
