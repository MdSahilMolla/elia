import { expect, test } from 'bun:test'

process.env.ANTHROPIC_API_KEY ??= 'test-key-for-reason-verify-abort-test'

const { commandVerifier } = await import('./verify.ts')
const { tmpdir } = await import('node:os')

const candidate = { id: 'a', approach: 'only', text: '', cwd: tmpdir() }

/**
 * The check is the part of a search that takes the time, and it was the one part
 * Esc could not reach: `solve` got the turn's signal and stopped scheduling new
 * attempts, but `commandVerifier` called `runShell` without the signal argument,
 * so the command already running ran to completion. On a project whose test
 * command takes minutes — elia's own is ~200s — that is the whole turn, and all
 * the REPL could say was "a running command may not be interruptible".
 */
test('an aborted turn interrupts the check command instead of waiting it out', async () => {
  const controller = new AbortController()
  const verifier = commandVerifier({
    id: 'slow',
    command: 'bun -e "await Bun.sleep(30000)"',
    timeoutMs: 60_000,
    signal: controller.signal,
  })

  const startedAt = Date.now()
  setTimeout(() => controller.abort(), 500)
  const verdict = await verifier.run(candidate)
  const elapsed = Date.now() - startedAt

  // The command sleeps 30s and the verifier would allow 60s. Returning in a
  // fraction of that is only possible if the signal reached the spawn.
  expect(elapsed).toBeLessThan(15_000)
  expect(verdict.passed).toBe(false)
}, 40_000)

test('an unaborted check still runs to completion and reports its exit code', async () => {
  // The guard against "fixing" interruption by making every check fail.
  const verifier = commandVerifier({ id: 'quick', command: 'bun -e "process.exit(0)"', timeoutMs: 30_000 })
  const verdict = await verifier.run(candidate)
  expect(verdict.passed).toBe(true)
}, 30_000)
