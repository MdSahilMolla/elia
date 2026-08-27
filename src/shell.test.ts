import { expect, test } from 'bun:test'
import { runShell } from './shell.ts'

test('terminates timed-out shell work and returns timeout evidence', async () => {
  const result = await runShell(process.platform === 'win32' ? 'ping 127.0.0.1 -n 3 > nul' : 'sleep 0.2', 30)
  expect(result.timedOut).toBe(true)
  expect(result.elapsedMs).toBeLessThan(2_000)
})

test('cancels shell work cooperatively', async () => {
  const controller = new AbortController()
  const pending = runShell(process.platform === 'win32' ? 'ping 127.0.0.1 -n 3 > nul' : 'sleep 0.2', 2_000, undefined, controller.signal)
  await Bun.sleep(20)
  controller.abort()
  const result = await pending
  expect(result.stderr).toContain('cancelled')
})

// 100k lines is ~300KB on Windows ("x\r\n") and ~200KB elsewhere ("x\n"),
// comfortably past MAX_SHELL_OUTPUT_LENGTH (200,000) while generating far less
// work than the previous 300k — Windows `for /L` is slow enough that the old
// count regularly ran past the shell timeout.
//
// The explicit test timeout must stay well above the shell timeout passed to
// runShell: when they were both 5_000 the harness raced the command's own
// deadline and this test failed roughly half the time on Windows.
test('bounds large shell output', async () => {
  const command = process.platform === 'win32' ? 'for /L %i in (1,1,100000) do @echo x' : "yes x | head -n 100000"
  const result = await runShell(command, 10_000)
  expect(result.stdout.length).toBeLessThanOrEqual(200_100)
  expect(result.stdout).toContain('characters omitted')
}, 30_000)
