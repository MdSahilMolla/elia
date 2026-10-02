import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MESH_PROTOCOL_VERSION, type MeshControl } from './frames.ts'
import type { ReplicatedEvent } from '../workspace/events.ts'
import {
  decideMeshStart,
  meshRestartDelayMs,
  startMeshSupervisor,
  type MeshFileChange,
  type MeshRestart,
  type MeshSpawn,
  type MeshSupervisorOptions,
} from './supervisor.ts'

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'elia-mesh-sup-'))
}

/**
 * A fake sidecar process: it emits `lines` on stdout, then exits. `kill` ends
 * the stream so an aborted read does not hang, which is what the real
 * `terminateProcessGroup` achieves by signalling the process.
 */
function fakeProcess(lines: string[], exitCode = 0, written?: string[], keepAlive = false): Bun.Subprocess {
  const encoder = new TextEncoder()
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  let settleExit: ((code: number) => void) | undefined
  const exited = new Promise<number>((resolve) => { settleExit = resolve })
  const stdout = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
      for (const line of lines) c.enqueue(encoder.encode(`${line}\n`))
      // `keepAlive` models a sidecar that is still running: stdout stays open, so
      // the supervisor is still reading frames and stdin is still writable. The
      // real `terminateProcessGroup` on abort plays the part of `kill`.
      if (!keepAlive) {
        c.close()
        controller = undefined
        settleExit?.(exitCode)
      }
    },
  })
  const stderr = new ReadableStream<Uint8Array>({ start(c) { c.close() } })
  const stdin = written === undefined
    ? undefined
    : { write(chunk: string | Uint8Array) { written.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)); return chunk.length }, end() {} }
  return {
    stdout,
    stderr,
    ...(stdin === undefined ? {} : { stdin }),
    exited,
    pid: undefined,
    kill() {
      try {
        controller?.close()
        controller = undefined
      } catch {
        // already closed
      }
      settleExit?.(exitCode)
    },
  } as unknown as Bun.Subprocess
}

const READY = JSON.stringify({
  type: 'ready',
  protocol: MESH_PROTOCOL_VERSION,
  workspace_id: 'ws_1',
  peer_id: 'peer_a',
  role: 'host',
  root: '/proj',
  fingerprint: 'aa'.repeat(32),
  peers: [],
})

test('decideMeshStart refuses to start in every unconfigured case', () => {
  const paired = { present: true, peers: 1 }
  expect(decideMeshStart({ mode: 'off', binary: '/bin/mesh', pairing: paired })).toEqual({ start: false, reason: 'mode-off' })
  expect(decideMeshStart({ mode: 'auto', binary: undefined, pairing: paired })).toEqual({ start: false, reason: 'no-binary' })
  expect(decideMeshStart({ mode: 'auto', binary: '/bin/mesh', pairing: { present: false, peers: 0 } })).toEqual({ start: false, reason: 'no-workspace' })
  expect(decideMeshStart({ mode: 'auto', binary: '/bin/mesh', pairing: { present: true, peers: 0 } })).toEqual({ start: false, reason: 'not-paired' })
})

test('decideMeshStart starts a paired workspace, and always starts under require', () => {
  expect(decideMeshStart({ mode: 'auto', binary: '/bin/mesh', pairing: { present: true, peers: 1 } })).toEqual({ start: true, reason: 'paired' })
  expect(decideMeshStart({ mode: 'require', binary: '/bin/mesh', pairing: { present: true, peers: 0 } })).toEqual({ start: true, reason: 'required' })
})

test('restart backoff is capped exponential', () => {
  expect(meshRestartDelayMs(1)).toBe(500)
  expect(meshRestartDelayMs(2)).toBe(1000)
  expect(meshRestartDelayMs(3)).toBe(2000)
  expect(meshRestartDelayMs(20)).toBe(30_000)
  expect(meshRestartDelayMs(0)).toBe(500)
})

test('mode off never spawns and finishes immediately', async () => {
  let spawned = 0
  const handle = startMeshSupervisor({
    root: tmpRoot(),
    mode: 'off',
    meshPath: '/bin/mesh',
    pairing: { present: true, peers: 1 },
    spawn: () => {
      spawned += 1
      return fakeProcess([])
    },
  })
  await handle.done
  expect(spawned).toBe(0)
  expect(handle.decision).toEqual({ start: false, reason: 'mode-off' })
})

test('an unpaired workspace does not spawn under auto', async () => {
  const decisions: string[] = []
  let spawned = 0
  const handle = startMeshSupervisor({
    root: tmpRoot(),
    mode: 'auto',
    meshPath: '/bin/mesh',
    pairing: { present: true, peers: 0 },
    onDecision: (d) => decisions.push(d.reason),
    spawn: () => {
      spawned += 1
      return fakeProcess([])
    },
  })
  await handle.done
  expect(spawned).toBe(0)
  expect(decisions).toEqual(['not-paired'])
})

test('a paired workspace streams frames and maps changes through the withholding rule', async () => {
  const secret = JSON.stringify({
    type: 'change',
    change: { path: '.env', op: 'update', origin_node: 'peer_b', added: 5, removed: 2, patch: '@@ -1 +1 @@\n-SECRET=1\n+SECRET=2' },
  })
  const ordinary = JSON.stringify({
    type: 'change',
    change: { path: 'src/a.ts', op: 'update', origin_node: 'peer_b', added: 2, removed: 1, patch: '@@ -1 +1 @@\n-a\n+b' },
  })
  const invite = JSON.stringify({ type: 'invite', code: 'ABCD-EFGH', url: 'elia://join/ABCD-EFGH' })
  const event = JSON.stringify({ type: 'event', kind: 'info', message: 'watching' })

  const changes: MeshFileChange[] = []
  const invites: unknown[] = []
  const emits: string[] = []
  const controller = new AbortController()

  const handle = startMeshSupervisor({
    root: tmpRoot(),
    mode: 'require',
    meshPath: '/bin/mesh',
    pairing: { present: true, peers: 0 },
    signal: controller.signal,
    spawn: () =>
      fakeProcess([READY, invite, event, secret, ordinary], 0),
    sleep: async () => {
      controller.abort()
    },
    onInvite: (i) => invites.push(i.code),
    onFileChange: (c) => changes.push(c),
    onEvent: (e) => emits.push(e.kind),
  })
  await handle.done

  expect(invites).toEqual(['ABCD-EFGH'])
  expect(emits).toEqual(['info'])
  const env = changes.find((c) => c.incoming.path === '.env')
  const src = changes.find((c) => c.incoming.path === 'src/a.ts')
  // A sensitive path keeps its metadata but the diff is marked withheld.
  expect(env?.meta.diffWithheld).toBe(true)
  expect(env?.incoming.diff).toBe('@@ -1 +1 @@\n-SECRET=1\n+SECRET=2')
  expect(env?.meta.added).toBe(5)
  expect(src?.meta.diffWithheld).toBe(false)
})

test('a dying sidecar restarts on a capped exponential backoff until stopped', async () => {
  const restarts: MeshRestart[] = []
  const delays: number[] = []
  const controller = new AbortController()
  let spawned = 0

  const handle = startMeshSupervisor({
    root: tmpRoot(),
    mode: 'require',
    meshPath: '/bin/mesh',
    pairing: { present: true, peers: 1 },
    signal: controller.signal,
    spawn: () => {
      spawned += 1
      return fakeProcess([READY], 1)
    },
    sleep: async (ms) => {
      delays.push(ms)
      if (delays.length >= 3) controller.abort()
    },
    onRestart: (r) => restarts.push(r),
  })
  await handle.done

  expect(spawned).toBe(3)
  expect(delays).toEqual([500, 1000, 2000])
  expect(restarts.map((r) => r.attempt)).toEqual([1, 2, 3])
  expect(restarts[0]?.reason).toContain('exited with code 1')
})

/** A process that stays alive until killed, so an abort has something to kill. */
function liveProcess(onKill: () => void): Bun.Subprocess {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  const stdout = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
    },
  })
  const stderr = new ReadableStream<Uint8Array>({ start(c) { c.close() } })
  let resolveExit: (code: number) => void = () => {}
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve
  })
  return {
    stdout,
    stderr,
    exited,
    pid: undefined,
    kill() {
      onKill()
      try {
        controller?.close()
      } catch {
        // already closed
      }
      resolveExit(0)
    },
  } as unknown as Bun.Subprocess
}

test('stop() aborts an in-flight sidecar and resolves done', async () => {
  let killed = 0
  let spawned = 0

  const options: MeshSupervisorOptions = {
    root: tmpRoot(),
    mode: 'require',
    meshPath: '/bin/mesh',
    pairing: { present: true, peers: 1 },
    spawn: (() => {
      spawned += 1
      return liveProcess(() => {
        killed += 1
      })
    }) as MeshSpawn,
    // Abort-aware, because stop() during the backoff sleep is the same signal.
    sleep: (_ms, signal) =>
      new Promise<void>((resolve) => {
        if (signal?.aborted) return resolve()
        signal?.addEventListener('abort', () => resolve(), { once: true })
      }),
  }

  const handle = startMeshSupervisor(options)
  // Let the supervisor spawn the process and block reading its stream.
  await new Promise((resolve) => setTimeout(resolve, 20))
  handle.stop()
  await handle.done
  expect(spawned).toBe(1)
  expect(killed).toBeGreaterThan(0)
})

// --- control plane -----------------------------------------------------------

const CONTROL_EVENT: ReplicatedEvent = {
  id: 'evt_1',
  type: 'ObjectiveStatusChanged',
  actorKind: 'member',
  actorId: 'mbr_1',
  actorNode: 'nd_peer',
  objectiveId: 'obj_1',
  payload: { status: 'active' },
  at: '2026-03-01T12:00:00.000Z',
}

test('a relayed control batch is delivered to the owner', async () => {
  const controls: MeshControl[] = []
  const controller = new AbortController()
  const handle = startMeshSupervisor({
    root: tmpRoot(),
    mode: 'require',
    meshPath: '/bin/mesh',
    pairing: { present: true, peers: 1 },
    signal: controller.signal,
    onControl: (control) => {
      controls.push(control)
      controller.abort()
    },
    spawn: () => fakeProcess([JSON.stringify({ type: 'control', node: 'nd_peer', events: [CONTROL_EVENT] })]),
  })
  await handle.done
  expect(controls).toHaveLength(1)
  expect(controls[0]!.node).toBe('nd_peer')
  expect(controls[0]!.events[0]).toEqual(CONTROL_EVENT)
})

test('sendControl writes an encoded frame to the running sidecar', async () => {
  const written: string[] = []
  const controller = new AbortController()
  const handle = startMeshSupervisor({
    root: tmpRoot(),
    mode: 'require',
    meshPath: '/bin/mesh',
    pairing: { present: true, peers: 1 },
    signal: controller.signal,
    spawn: () => fakeProcess([READY], 0, written, true),
  })
  // The sidecar stays up, so its stdin is writable: the frame must land.
  expect(handle.sendControl({ node: 'nd_me', events: [{ ...CONTROL_EVENT, actorNode: 'nd_me' }] })).toBe(true)
  controller.abort()
  await handle.done
  const frame = JSON.parse(written.join('')) as { type: string; node: string; events: unknown[] }
  expect(frame.type).toBe('control')
  expect(frame.node).toBe('nd_me')
  expect(frame.events).toHaveLength(1)
})

test('sendControl reports failure instead of throwing when there is no sidecar', async () => {
  const handle = startMeshSupervisor({
    root: tmpRoot(),
    mode: 'off',
    meshPath: '/bin/mesh',
    pairing: { present: true, peers: 1 },
    spawn: () => fakeProcess([]),
  })
  expect(handle.sendControl({ events: [] })).toBe(false)
  await handle.done
})

// The host's address is not decoration. A member that has already paired returns
// to the address it was given once, so a host that re-binds a random port on
// every restart is a host that cannot be reached again — and the symptom is a
// member that reconnects forever without ever saying why.
test('a host sidecar is told how it is reached, and a member is not', async () => {
  const binary = '/bin/mesh'
  const argsFor = (role: 'host' | 'member') => {
    const args: string[] = []
    startMeshSupervisor({
      root: tmpRoot(),
      mode: 'require',
      meshPath: binary,
      pairing: { present: true, peers: 1, role },
      spawn: (argv) => {
        args.push(...argv)
        return fakeProcess([])
      },
    })
    return args
  }

  process.env.ELIA_RWS_LISTEN = '0.0.0.0:9777'
  process.env.ELIA_RWS_ADVERTISE = 'laptop.local'
  try {
    const host = argsFor('host')
    expect(host.slice(0, 2)).toEqual([binary, 'attach'])
    expect(host[host.indexOf('--listen') + 1]).toBe('0.0.0.0:9777')
    expect(host[host.indexOf('--advertise') + 1]).toBe('laptop.local')

    // A member reconnects to the address pairing recorded. Passing a second one
    // would only be something else to disagree with that record.
    expect(argsFor('member')).toEqual([binary, 'attach'])
  } finally {
    delete process.env.ELIA_RWS_LISTEN
    delete process.env.ELIA_RWS_ADVERTISE
  }
})
