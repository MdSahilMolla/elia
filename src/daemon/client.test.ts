import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import {
  DaemonUnavailable,
  daemonClient,
  daemonEnabled,
  daemonMode,
  resolveEliadPath,
  resolveJvmBridgeJar,
  resetDaemonClientForTests,
  socketPath,
} from './client.ts'
import { PROTOCOL_VERSION } from './types.ts'
import { runShell } from '../shell.ts'

const binary = resolveEliadPath()
const scratch = mkdtempSync(join(tmpdir(), 'eliad-test-'))

/**
 * Read the records appended to the diagnostics log past `offset` and return the
 * first one with `scope`. Polls because the write is best-effort and happens on
 * a later microtask than the call that triggered it.
 */
async function waitForRecord(
  path: string,
  offset: number,
  scope: string,
  timeoutMs = 5_000,
): Promise<{ message: string; context?: Record<string, unknown> } | undefined> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const appended = readFileSync(path, 'utf8').slice(offset)
      for (const line of appended.split('\n')) {
        if (!line.trim()) continue
        const record = JSON.parse(line)
        if (record.scope === scope) return record
      }
    } catch {
      // not written yet
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return undefined
}
// A socket name unique to this run so we never collide with a real daemon or a
// leftover one from an earlier run (Windows reuses pids).
const runId = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
const socketName = `elia-eliad-test-${runId}`
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

test('resolveEliadPath prefers the release build over a newer debug build', () => {
  const { existsSync } = require('node:fs') as typeof import('node:fs')
  const { ELIA_ROOT } = require('../statePaths.ts') as typeof import('../statePaths.ts')
  const exe = process.platform === 'win32' ? 'eliad.exe' : 'eliad'
  const release = join(ELIA_ROOT, 'target', 'release', exe)
  const debug = join(ELIA_ROOT, 'target', 'debug', exe)
  if (!existsSync(release) || !existsSync(debug)) return // only meaningful when both are built
  delete process.env.ELIA_ELIAD_PATH
  delete process.env.ELIA_ELIAD_PROFILE
  expect(resolveEliadPath()).toBe(release)
  process.env.ELIA_ELIAD_PROFILE = 'debug'
  expect(resolveEliadPath()).toBe(debug)
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

test('a bare Windows pipe-name override maps a backslash to "-", as the daemon does', () => {
  if (process.platform !== 'win32') return
  process.env.ELIA_ELIAD_SOCKET = 'foo\\bar'
  expect(socketPath()).toBe('\\\\.\\pipe\\foo-bar')
  process.env.ELIA_ELIAD_SOCKET = '\\\\.\\pipe\\full'
  expect(socketPath()).toBe('\\\\.\\pipe\\full')
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

maybe('aborting the signal abandons an in-flight daemon command promptly', async () => {
  // The regression: the abort listener used to be wired only *after* the
  // response was awaited, so Esc during a long command did nothing until it
  // finished on its own.
  const controller = new AbortController()
  const sleep = process.platform === 'win32'
    ? 'powershell -NoProfile -Command "Start-Sleep -Seconds 30"'
    : 'sleep 30'
  const started = Date.now()
  setTimeout(() => controller.abort(), 300)
  const r = await runShell(sleep, 30_000, process.cwd(), controller.signal)
  expect(Date.now() - started).toBeLessThan(10_000)
  expect(r.stderr).toContain('cancelled by operator')
}, 20_000)

maybe('parse.check flags a structurally broken edit', async () => {
  const { daemonParseCheck } = await import('./client.ts')
  const clean = await daemonParseCheck({ source: 'export const x = { a: 1 }\n', path: 'x.ts' })
  expect(clean.ok).toBe(true)

  const broken = await daemonParseCheck({ source: 'function f() {\n  return 1;\n', path: 'x.ts' })
  expect(broken.ok).toBe(false)
  expect(broken.errors[0]?.message).toBe("unclosed '{'")
}, 30_000)

const withJvm = binary && resolveJvmBridgeJar() ? test : test.skip

test('a cancel that never reaches the daemon is recorded, not discarded', async () => {
  // #1271: `cancel()` returns void, so a lost `shell.cancel` had nowhere to go.
  // The abort that triggered it had already rejected the local waiter, which made
  // the CLI stop waiting and look correct while the daemon-side worker kept
  // running to its own `timeout_ms` — a cancelled `bun run server` that never
  // stopped, with no record that the cancel was lost. This pins the record.
  //
  // No daemon is needed: `send` rejects deterministically with `not connected`
  // when there is no socket, which is exactly the "cancel never landed" case.
  //
  // The log is redirected to a temp file because the default path is derived from
  // the cwd captured when statePaths.ts was first imported, and several suites
  // chdir into temp directories — so under a full-suite run the default can
  // resolve somewhere a later test deletes, and every write is best-effort.
  const logPath = join(mkdtempSync(join(tmpdir(), 'elia-diag-')), 'diagnostics.ndjson')
  process.env.ELIA_DIAGNOSTICS_PATH = logPath
  const before = 0
  const target = 987_654_321

  // A client with no live socket: daemon mode off, so nothing dials or spawns.
  process.env.ELIA_DAEMON = 'off'
  resetDaemonClientForTests()
  daemonClient().cancel(target)

  try {
    const record = await waitForRecord(logPath, before, 'daemon.client.cancel')
    expect(record).toBeDefined()
    expect(record!.context!.target).toBe(target)
    expect(record!.message).toContain('not connected')
  } finally {
    delete process.env.ELIA_DIAGNOSTICS_PATH
  }
}, 20_000)

maybe('mcp.ensure keeps a stdio server resident and mcp.call proxies to it', async () => {
  process.env.ELIA_ELIAD_SOCKET = socketAddr
  process.env.ELIA_DAEMON = 'auto'
  resetDaemonClientForTests()

  const echoServer = join(import.meta.dir, '..', 'mcp', 'fixtures', 'echoServer.ts')
  const config = { name: 'echofix', command: process.execPath, args: ['run', echoServer], env: {} }

  const { daemonEnsureMcp, daemonCallMcp } = await import('../mcp/daemonBridge.ts')
  const ensured = await daemonEnsureMcp([config])
  expect(ensured.failed).toEqual([])
  expect(ensured.tools.map((t) => t.name).sort()).toEqual(['echo', 'explode'])
  expect(ensured.tools[0]?.server).toBe('echofix')

  // A second ensure with the same config is a no-op — the server stays up.
  const again = await daemonEnsureMcp([config])
  expect(again.tools.length).toBe(2)

  const result = await daemonCallMcp('echofix', 'echo', { text: 'through-the-daemon' })
  expect(result.isError).toBeFalsy()
  expect(result.content?.[0]?.text).toContain('through-the-daemon')
}, 40_000)

withJvm('jvm.check type-checks a Java edit via elia-jvm-bridge', async () => {
  const { daemonJvmCheck } = await import('./client.ts')
  const clean = await daemonJvmCheck({ source: 'public class Ok { int x = 1; }', path: 'Ok.java' })
  expect(clean.ok).toBe(true)

  const broken = await daemonJvmCheck({ source: 'public class Bad { int x = ; }', path: 'Bad.java' })
  expect(broken.ok).toBe(false)
  expect(broken.errors[0]?.severity).toBe('error')
}, 40_000)
