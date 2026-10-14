import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
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
  socketTokenPath,
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

// The daemon (Rust) resolves its home with `dirs::home_dir()`; the client used
// to read `process.env.HOME`, which is a POSIX convention and is typically unset
// on Windows. When it was unset the client looked for a token under `./.elia`
// while the daemon wrote it into the real profile, so every daemon test failed
// with "token file never appeared" even though the daemon was healthy. These
// assert the client never depends on `$HOME`, so the drift cannot come back.
test('socketTokenPath does not depend on the HOME env var', () => {
  const saved = process.env.HOME
  const savedXdg = process.env.XDG_RUNTIME_DIR
  try {
    // Pin $XDG_RUNTIME_DIR off so the token resolves under ~/.elia; this test is
    // about the HOME behaviour, and a runtime dir in the ambient env would send
    // the path down the XDG branch and mask it.
    delete process.env.XDG_RUNTIME_DIR
    delete process.env.HOME
    const withoutHome = socketTokenPath()
    process.env.HOME = join(tmpdir(), 'some-other-home')
    const withBogusHome = socketTokenPath()
    // A different (or absent) $HOME must not move the token: the daemon would
    // never write there, so the client would wait forever for a token.
    expect(withBogusHome).toBe(withoutHome)
    // Nor may it collapse to a path relative to the cwd, which is the exact
    // failure mode `.\.elia` produced on a real Windows box.
    expect(isAbsolute(withoutHome)).toBe(true)
    // `token_path()` names the file `elia-eliad-<user>.token` on Windows and
    // `eliad-<user>.token` elsewhere (see the sibling test); match the platform.
    const tokenName = process.platform === 'win32' ? `elia-eliad-${userTag()}.token` : `eliad-${userTag()}.token`
    expect(withoutHome.endsWith(join('.elia', tokenName))).toBe(true)
  } finally {
    if (saved === undefined) delete process.env.HOME
    else process.env.HOME = saved
    if (savedXdg === undefined) delete process.env.XDG_RUNTIME_DIR
    else process.env.XDG_RUNTIME_DIR = savedXdg
  }
})

test('socketTokenPath is unique per user and mirrors the Rust token_path rules', () => {
  const path = socketTokenPath()
  // `socket.rs`'s `token_path()` names the file `elia-eliad-<user>.token` on
  // Windows and `eliad-<user>.token` elsewhere; the two differ on purpose.
  const expectedName = process.platform === 'win32' ? `elia-eliad-${userTag()}.token` : `eliad-${userTag()}.token`
  expect(basename(path)).toBe(expectedName)
  // It must live in a real home directory, never the repo cwd. `$XDG_RUNTIME_DIR`
  // supersedes `~/.elia` on unix (that is `token_path()`'s own precedence).
  if (process.platform !== 'win32' && process.env.XDG_RUNTIME_DIR) {
    expect(dirname(path)).toBe(process.env.XDG_RUNTIME_DIR)
  } else {
    expect(basename(dirname(path))).toBe('.elia')
  }
  expect(isAbsolute(path)).toBe(true)
})

test('the socket and token share one directory, and XDG_RUNTIME_DIR is used verbatim', () => {
  // `socket_dir()` in socket.rs returns `$XDG_RUNTIME_DIR` with no extra segment
  // and falls back to `~/.elia`. A stray `elia/` segment here silently sends the
  // client to a directory the daemon never binds, so the dir is pinned exactly.
  // Asserted through the token path on every platform: on Windows the socket is
  // a named pipe, but the token is still a file under the same rules, and
  // socketPath() is checked too where it is file-based.
  const saved = process.env.XDG_RUNTIME_DIR
  const savedSocket = process.env.ELIA_ELIAD_SOCKET
  try {
    // `beforeEach` sets ELIA_ELIAD_SOCKET, which socketPath() honours before any
    // directory rule. Clear it so socketPath() actually exercises socket_dir().
    delete process.env.ELIA_ELIAD_SOCKET
    if (process.platform === 'win32') {
      // Windows uses a named pipe; only the token path is file-based there.
      expect(basename(dirname(socketTokenPath()))).toBe('.elia')
    } else {
      const runtime = join(tmpdir(), 'xdg-pin')
      process.env.XDG_RUNTIME_DIR = runtime
      expect(dirname(socketPath())).toBe(runtime)
      expect(dirname(socketTokenPath())).toBe(runtime)
    }

    delete process.env.XDG_RUNTIME_DIR
    expect(dirname(socketTokenPath())).toBe(join(homedir(), '.elia'))
    if (process.platform !== 'win32') {
      expect(dirname(socketPath())).toBe(join(homedir(), '.elia'))
    }
  } finally {
    if (saved === undefined) delete process.env.XDG_RUNTIME_DIR
    else process.env.XDG_RUNTIME_DIR = saved
    if (savedSocket === undefined) delete process.env.ELIA_ELIAD_SOCKET
    else process.env.ELIA_ELIAD_SOCKET = savedSocket
  }
})

// Mirrors how the rest of the codebase resolves a home directory: via
// `os.homedir()`. Duplicated here rather than exported so the test pins the
// same derivation the production code uses.
function userTag(): string {
  const raw = process.env.USER || process.env.USERNAME || 'default'
  return (raw.match(/[A-Za-z0-9_-]/g) ?? []).join('').slice(0, 32) || 'default'
}
