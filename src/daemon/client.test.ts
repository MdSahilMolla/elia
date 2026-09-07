import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import {
  DaemonUnavailable,
  daemonClient,
  daemonEnabled,
  daemonMode,
  resolveEliadPath,
  resetDaemonClientForTests,
  socketPath,
} from './client.ts'
import { PROTOCOL_VERSION } from './types.ts'
import { runShell } from '../shell.ts'

const binary = resolveEliadPath()
const scratch = mkdtempSync(join(tmpdir(), 'eliad-test-'))
// A socket name unique to this run so we never collide with a real daemon.
const socketName = `elia-eliad-test-${process.pid}`
const socketAddr = process.platform === 'win32' ? socketName : join(scratch, 'd.sock')

const originalEnv = { ...process.env }

beforeEach(() => {
  process.env.ELIA_ELIAD_SOCKET = socketAddr
  process.env.ELIA_DAEMON = 'auto'
  resetDaemonClientForTests()
})

afterEach(() => {
  process.env = { ...originalEnv }
})

afterAll(async () => {
  if (binary) {
    // Ask the scratch daemon to exit, then wipe the socket dir.
    try {
      process.env.ELIA_ELIAD_SOCKET = socketAddr
      Bun.spawnSync([binary, 'stop'])
    } catch {
      // already gone
    }
  }
  rmSync(scratch, { recursive: true, force: true })
})

test('daemonMode reads ELIA_DAEMON', () => {
  process.env.ELIA_DAEMON = 'off'
  expect(daemonMode()).toBe('off')
  expect(daemonEnabled()).toBe(false)
  process.env.ELIA_DAEMON = 'require'
  expect(daemonMode()).toBe('require')
  process.env.ELIA_DAEMON = 'nonsense'
  expect(daemonMode()).toBe('off')
})

test('socketPath honours the override', () => {
  process.env.ELIA_ELIAD_SOCKET = socketAddr
  const p = socketPath()
  if (process.platform === 'win32') expect(p).toBe(`\\\\.\\pipe\\${socketName}`)
  else expect(p).toBe(socketAddr)
})

test('disabled mode throws DaemonUnavailable', async () => {
  process.env.ELIA_DAEMON = 'off'
  resetDaemonClientForTests()
  const { daemonShellExec } = await import('./client.ts')
  await expect(daemonShellExec({ command: 'echo x', cwd: process.cwd(), timeoutMs: 5_000 })).rejects.toThrow(
    DaemonUnavailable,
  )
})

const maybe = binary ? test : test.skip

maybe('spawns eliad and runs a command end to end', async () => {
  const info = await daemonClient().info()
  expect(info.protocol).toBe(PROTOCOL_VERSION)
  expect(info.pid).toBeGreaterThan(0)

  const { daemonShellExec } = await import('./client.ts')
  const res = await daemonShellExec({
    command: process.platform === 'win32' ? 'echo daemon-roundtrip' : 'echo daemon-roundtrip',
    cwd: process.cwd(),
    timeoutMs: 20_000,
  })
  expect(res.exit_code).toBe(0)
  expect(res.stdout).toContain('daemon-roundtrip')
}, 30_000)

maybe('runShell routes through the daemon when ELIA_DAEMON=auto', async () => {
  const r = await runShell('echo via-runshell', 20_000, process.cwd())
  expect(r.exitCode).toBe(0)
  expect(r.stdout).toContain('via-runshell')
}, 30_000)

maybe('a non-zero exit is a normal result, not an error', async () => {
  const bad = process.platform === 'win32' ? 'cmd /c exit 5' : '(exit 5)'
  const r = await runShell(bad, 20_000, process.cwd())
  expect(r.exitCode).toBe(5)
}, 30_000)
