import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { resolveEliadPath } from '../daemon/client.ts'
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
  expect(message).toContain('structurally broken')
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
