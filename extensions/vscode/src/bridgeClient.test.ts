import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

class FakeChild extends EventEmitter {
  stdin = { writable: true, write: () => true }
  stdout = new PassThrough()
  stderr = new PassThrough()
  killed = false
  kill(): void {
    this.killed = true
  }
}

let lastSpawn: { command: string; args: string[]; options: Record<string, unknown>; child: FakeChild } | undefined

mock.module('node:child_process', () => ({
  spawn: (command: string, args: string[], options: Record<string, unknown>) => {
    const child = new FakeChild()
    lastSpawn = { command, args, options, child }
    return child
  },
}))

let EliaBridgeClient: typeof import('./bridgeClient').EliaBridgeClient

beforeAll(async () => {
  // Deferred (not a top-level await) so the mock above is installed before
  // bridgeClient's own `import { spawn } from 'node:child_process'` resolves.
  ;({ EliaBridgeClient } = await import('./bridgeClient.js'))
})

describe('EliaBridgeClient', () => {
  test('launchCommand: bare cliPath uses a shell only on win32 (PATHEXT shim resolution)', () => {
    const client = new EliaBridgeClient({ workspaceRoot: '.', cliPath: 'elia', runtime: 'auto' })
    const launch = (client as any).launchCommand()
    expect(launch).toEqual({ command: 'elia', args: ['bridge', '--json'], isExplicitPath: false })
  })

  test('launchCommand: a .ts cliPath runs under bun/node directly, no shell needed', () => {
    const bunClient = new EliaBridgeClient({ workspaceRoot: '.', cliPath: 'bin/elia.ts', runtime: 'bun' })
    expect((bunClient as any).launchCommand()).toEqual({
      command: 'bun',
      args: ['bin/elia.ts', 'bridge', '--json'],
      isExplicitPath: true,
    })

    const nodeClient = new EliaBridgeClient({ workspaceRoot: '.', cliPath: 'bin/elia.ts', runtime: 'node' })
    expect((nodeClient as any).launchCommand()).toEqual({
      command: 'node',
      args: ['bin/elia.ts', 'bridge', '--json'],
      isExplicitPath: true,
    })
  })

  test('start() passes shell:true for a bare command only on win32', async () => {
    const client = new EliaBridgeClient({ workspaceRoot: '.', cliPath: 'elia', runtime: 'auto' })
    const started = client.start()
    lastSpawn?.child.emit('spawn')
    await started
    expect(lastSpawn?.options.shell).toBe(process.platform === 'win32')
  })

  test('start() rejects instead of hanging forever when spawn errors', async () => {
    const client = new EliaBridgeClient({ workspaceRoot: '.', cliPath: 'elia', runtime: 'auto' })
    const started = client.start()
    const failure = new Error('spawn ENOENT')
    queueMicrotask(() => lastSpawn?.child.emit('error', failure))
    await expect(started).rejects.toThrow('spawn ENOENT')
  })

  test('an unexpected exit resets `started` so the next start() re-spawns', async () => {
    const client = new EliaBridgeClient({ workspaceRoot: '.', cliPath: 'elia', runtime: 'auto' })
    const started = client.start()
    lastSpawn?.child.emit('spawn')
    await started
    const firstChild = lastSpawn?.child
    expect((client as any).started).toBeDefined()

    firstChild?.emit('exit', 1, null)
    expect((client as any).started).toBeUndefined()
    expect((client as any).child).toBeUndefined()

    // A subsequent start() must spawn a fresh process rather than reusing the
    // dead one's stale, already-resolved `started` promise.
    const restarted = client.start()
    lastSpawn?.child.emit('spawn')
    await restarted
    expect(lastSpawn?.child).not.toBe(firstChild)
  })
})
