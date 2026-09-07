import { afterAll, afterEach, expect, test } from 'bun:test'
import { resolveEliadPath, resolveJvmBridgeJar } from '../daemon/client.ts'
import { preflightStructuralCheck } from './parseCheck.ts'

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

test('fail-open: returns undefined when the daemon is off', async () => {
  process.env.ELIA_DAEMON = 'off'
  const broken = 'function f() {\n  return 1;\n'
  expect(await preflightStructuralCheck('a.ts', 'const x = 1\n', broken)).toBeUndefined()
})

test('skips file types the validator does not lex', async () => {
  process.env.ELIA_DAEMON = 'off'
  expect(await preflightStructuralCheck('notes.md', '# ok', '# [half a link](')).toBeUndefined()
})

const maybe = binary ? test : test.skip

maybe('blocks an edit that newly breaks structure', async () => {
  process.env.ELIA_ELIAD_SOCKET = socketName
  process.env.ELIA_DAEMON = 'auto'
  const { resetDaemonClientForTests } = await import('../daemon/client.ts')
  resetDaemonClientForTests()

  const before = 'export function f() {\n  return 1\n}\n'
  const after = 'export function f() {\n  return 1\n' // dropped the closing brace
  const message = await preflightStructuralCheck('src/x.ts', before, after)
  expect(message).toContain('was not written')
  expect(message).toContain("unclosed '{'")
}, 30_000)

maybe('allows an edit to an already-broken file', async () => {
  process.env.ELIA_ELIAD_SOCKET = socketName
  process.env.ELIA_DAEMON = 'auto'
  const { resetDaemonClientForTests } = await import('../daemon/client.ts')
  resetDaemonClientForTests()

  const before = 'function f() {\n  return 1\n' // already missing a brace
  const after = 'function f() {\n  return 2\n' // still missing it, but not our fault
  expect(await preflightStructuralCheck('src/x.ts', before, after)).toBeUndefined()
}, 30_000)

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

  // References a type we can't resolve without a classpath — that is a semantic
  // error, not a syntax one, so the edit must still be allowed.
  const after = 'import com.example.Thing;\npublic class C { Thing t; }'
  expect(await preflightStructuralCheck('C.java', 'public class C {}', after)).toBeUndefined()
}, 40_000)
