import { expect, test } from 'bun:test'

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, 'src/index.ts', ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ELIA_ROUTING_MODE: 'selected',
      ELIA_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: 'test-anthropic-key',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout, stderr }
}

test('native CLI emits parseable JSONL for argument errors', async () => {
  const result = await runCli(['auto', '--json'])
  expect(result.code).toBe(1)
  const events = result.stdout.trim().split('\n').map((line) => JSON.parse(line) as { type: string })
  expect(events.map((event) => event.type)).toEqual(['cli_started', 'error'])
  expect(result.stdout).not.toContain('\x1b[')
})

test('plain mode emits no ANSI escape sequences', async () => {
  const result = await runCli(['skills', 'path', '--plain'])
  expect(result.code).toBe(0)
  expect(result.stdout).not.toContain('\x1b[')
  expect(result.stdout).toContain('Project skills:')
})
