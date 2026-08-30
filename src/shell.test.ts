import { expect, test } from 'bun:test'
import { runShell } from './shell.ts'

test.if(process.platform === 'win32')('a cmd.exe builtin like mkdir runs even when PATH is broken', async () => {
  // The failure this guards: `Bun.spawn(['cmd', ...])` -> ENOENT when System32
  // is missing from PATH, which took out every shell command. runShell now
  // resolves cmd via %ComSpec%, so a stripped PATH still works.
  const original = process.env.PATH
  try {
    process.env.PATH = 'C:\\nonexistent'
    const dir = `elia-shell-test-${Date.now()}`
    const result = await runShell(`mkdir ${dir} && rmdir ${dir}`, 10_000, process.env.TEMP)
    expect(result.exitCode).toBe(0)
  } finally {
    process.env.PATH = original
  }
})

test('echo through the shell returns its output', async () => {
  const result = await runShell('echo elia-shell-ok', 10_000)
  expect(result.exitCode).toBe(0)
  expect(result.stdout).toContain('elia-shell-ok')
})

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

// 30k lines of an 11-byte payload is ~360KB on Windows ("xxxxxxxxxx\r\n") and
// ~330KB elsewhere ("xxxxxxxxxx\n") — unambiguously past MAX_SHELL_OUTPUT_LENGTH
// (200,000), so the "omitted" marker is guaranteed. The previous "yes x | head
// -n 100000" produced exactly 200,000 bytes on Linux, right on the boundary
// where `totalLength > limit` is false and no marker is appended.
//
// The explicit test timeout must stay well above the shell timeout passed to
// runShell: when they were both 5_000 the harness raced the command's own
// deadline and this test failed roughly half the time on Windows.
test('bounds large shell output', async () => {
  const command = process.platform === 'win32'
    ? 'for /L %i in (1,1,30000) do @echo xxxxxxxxxx'
    : 'yes xxxxxxxxxx | head -n 30000'
  const result = await runShell(command, 10_000)
  expect(result.stdout.length).toBeLessThanOrEqual(200_100)
  expect(result.stdout).toContain('characters omitted')
}, 30_000)
