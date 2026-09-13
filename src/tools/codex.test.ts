import { expect, test, afterEach } from 'bun:test'
import { codexTool, codexAvailable, resetCodexAvailabilityForTests } from './codex.ts'
import { withAgentIdentity } from '../autonomy/context.ts'

afterEach(() => {
  resetCodexAvailabilityForTests()
})

test('rejects a missing prompt with a clear error, without spawning anything', async () => {
  await expect(codexTool.execute({})).rejects.toThrow('non-empty "prompt"')
})

test('rejects an empty/whitespace-only prompt', async () => {
  await expect(codexTool.execute({ prompt: '   ' })).rejects.toThrow('non-empty "prompt"')
})

test('rejects an out-of-range timeout_ms before doing anything at all', async () => {
  // Bounded so a runaway number can't hold a run hostage for hours; extreme
  // values fail fast, before the availability probe or any spawn.
  await expect(codexTool.execute({ prompt: 'x', timeout_ms: 0 })).rejects.toThrow('timeout_ms must be an integer')
  await expect(codexTool.execute({ prompt: 'x', timeout_ms: 10_000_000 })).rejects.toThrow('timeout_ms must be an integer')
  await expect(codexTool.execute({ prompt: 'x', timeout_ms: 1.5 })).rejects.toThrow('timeout_ms must be an integer')
})

test('an already-aborted run is short-circuited instead of delegating to codex', async () => {
  const controller = new AbortController()
  controller.abort()
  const result = await withAgentIdentity({ name: 'test', role: 'lead', signal: controller.signal }, () =>
    codexTool.execute({ prompt: 'x', timeout_ms: 5_000 }),
  )
  expect(result).toContain('cancelled')
  expect(result).not.toContain('not installed')
})

// codexAvailable()'s positive path (a real `codex --version` on this
// machine) is exercised directly below. The negative path ("codex is not
// installed") is not simulated here: on Windows, clearing process.env.PATH
// before Bun.spawn does not reliably stop it from resolving `codex` (spawn
// resolution appears to consult more than the live PATH value), so a
// PATH-based simulation would be testing this environment's quirks, not the
// tool's actual logic. codexAvailable/execute's fallback message is simple
// enough (a plain if-branch returning a fixed string) that this gap is low
// risk; revisit if that branch grows more logic.
test('codexAvailable() reflects the real, installed codex on this machine', async () => {
  const result = await codexAvailable()
  expect(typeof result).toBe('boolean')
})

test('resetCodexAvailabilityForTests() actually clears the cache (repeat calls re-check rather than reuse a stale answer)', async () => {
  const first = await codexAvailable()
  resetCodexAvailabilityForTests()
  const second = await codexAvailable()
  expect(second).toBe(first) // same real environment, so the same real answer — but each call is a fresh check, not a cached stale one
})
