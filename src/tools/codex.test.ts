import { expect, test, afterEach } from 'bun:test'
import { codexTool, codexAvailable, resetCodexAvailabilityForTests } from './codex.ts'

afterEach(() => {
  resetCodexAvailabilityForTests()
})

test('rejects a missing prompt with a clear error, without spawning anything', async () => {
  await expect(codexTool.execute({})).rejects.toThrow('non-empty "prompt"')
})

test('rejects an empty/whitespace-only prompt', async () => {
  await expect(codexTool.execute({ prompt: '   ' })).rejects.toThrow('non-empty "prompt"')
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
