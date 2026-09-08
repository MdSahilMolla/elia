import { afterAll, afterEach, expect, test } from 'bun:test'
import { resolveEliadPath, resolveJvmBridgeJar } from '../daemon/client.ts'
import { nativeAvailable } from './ffi.ts'
import { lastStructuralBackend, preflightStructuralCheck } from './parseCheck.ts'

const binary = resolveEliadPath()
const socketName = `elia-eliad-preflight-${process.pid}-${Date.now().toString(36)}`
const originalEnv = { ...process.env }

afterEach(() => {
  process.env = { ...originalEnv }
})

afterAll(() => {
  if (binary) {
    try {
      Bun.spawnSync([binary, 'stop'], { env: { ...process.env, ELIA_ELIAD_SOCKET: socketName } })
    } catch {
      // already gone
    }
  }
})

// The in-process library is the default path now: the structural pre-flight runs
// for every edit with ELIA_DAEMON unset. These tests need it built
// (`cargo build -p elia-native --release`); they skip cleanly otherwise so a
// pure-TS checkout still goes green.
const withNative = nativeAvailable() ? test : test.skip

withNative('blocks an edit that newly breaks structure — no daemon', async () => {
  process.env.ELIA_DAEMON = 'off'
  const before = 'export function f() {\n  return 1\n}\n'
  const after = 'export function f() {\n  return 1\n' // dropped the closing brace
  const message = await preflightStructuralCheck('src/x.ts', before, after)
  expect(message).toContain('was not written')
  expect(message).toContain("unclosed '{'")
  expect(lastStructuralBackend()).toBe('native')
})

withNative('allows an edit to an already-broken file', async () => {
  process.env.ELIA_DAEMON = 'off'
  const before = 'function f() {\n  return 1\n' // already missing a brace
  const after = 'function f() {\n  return 2\n' // still missing it, but not our fault
  expect(await preflightStructuralCheck('src/x.ts', before, after)).toBeUndefined()
})

withNative('allows a clean edit', async () => {
  process.env.ELIA_DAEMON = 'off'
  const before = 'const a = 1\n'
  const after = 'const a = 1\nconst b = [2, 3]\n'
  expect(await preflightStructuralCheck('src/x.ts', before, after)).toBeUndefined()
})

test('skips file types the validator does not lex', async () => {
  process.env.ELIA_DAEMON = 'off'
  expect(await preflightStructuralCheck('notes.md', '# ok', '# [half a link](')).toBeUndefined()
})

test('respects ELIA_NO_NATIVE + ELIA_DAEMON=off: fail-open, no check', async () => {
  process.env.ELIA_DAEMON = 'off'
  process.env.ELIA_NO_NATIVE = '1'
  const { resetNativeForTests } = await import('./ffi.ts')
  resetNativeForTests()
  const broken = 'function f() {\n  return 1;\n'
  expect(await preflightStructuralCheck('a.ts', 'const x = 1\n', broken)).toBeUndefined()
  resetNativeForTests()
})

const withJvm = binary && resolveJvmBridgeJar() ? test : test.skip

withJvm('blocks a Java edit with a real syntax error', async () => {
  process.env.ELIA_ELIAD_SOCKET = socketName
  process.env.ELIA_DAEMON = 'auto'
  const { resetDaemonClientForTests } = await import('../daemon/client.ts')
  resetDaemonClientForTests()

  const before = 'public class C { int x = 1; }'
  const after = 'public class C { int x = ; }'
  const message = await preflightStructuralCheck('C.java', before, after)
  expect(message).toContain('broken')
}, 40_000)

withJvm('ignores unresolved-import noise (no classpath) in Java', async () => {
  process.env.ELIA_ELIAD_SOCKET = socketName
  process.env.ELIA_DAEMON = 'auto'
  const { resetDaemonClientForTests } = await import('../daemon/client.ts')
  resetDaemonClientForTests()

  const after = 'import com.example.Thing;\npublic class C { Thing t; }'
  expect(await preflightStructuralCheck('C.java', 'public class C {}', after)).toBeUndefined()
}, 40_000)

test('Java pre-flight is skipped when the daemon is off', async () => {
  process.env.ELIA_DAEMON = 'off'
  const after = 'public class C { int x = ; }'
  expect(await preflightStructuralCheck('C.java', 'public class C {}', after)).toBeUndefined()
})
