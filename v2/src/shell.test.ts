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

test('bounds large shell output', async () => {
  const command = process.platform === 'win32' ? 'for /L %i in (1,1,300000) do @echo x' : "yes x | head -n 300000"
  const result = await runShell(command, 5_000)
  expect(result.stdout.length).toBeLessThanOrEqual(200_100)
  expect(result.stdout).toContain('characters omitted')
})
