import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const made: string[] = []
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

// A run that throws never reaches `done()`, which is where its supervisor poll
// (every 250 ms) and its wall-clock timer are stopped, so those timers kept the
// process alive: run 2026-09-15-lot0-alkr printed its error and then never
// exited. Whether a process can end is only observable from outside it, so this
// takes a real child — started in a temp directory, where all of the run's
// state (`<cwd>/.elia`) lands.
test('a run that throws still lets the process exit, and leaves a receipt saying why', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'elia-run-exit-'))
  made.push(dir)
  const workspace = join(dir, 'ws')
  mkdirSync(workspace)
  const script = join(dir, 'child.ts')
  const configModule = pathToFileURL(join(import.meta.dir, '..', 'config.ts')).href
  const loopModule = pathToFileURL(join(import.meta.dir, 'loop.ts')).href

  writeFileSync(
    script,
    [
      `const { config } = await import(${JSON.stringify(configModule)})`,
      `const { runAutonomousTask } = await import(${JSON.stringify(loopModule)})`,
      `config.routingMode = 'selected'`,
      // A permanent error: nothing retries it, so the run throws out of planning.
      `config.provider = { async streamTurn() { throw new Error('invalid API key') } }`,
      `await runAutonomousTask({ goal: 'build a page', workspaceRoot: ${JSON.stringify(workspace)}, maxWallClockMs: 600000, learn: false })`,
      `  .then(() => console.log('RESOLVED'), (error) => console.log('THREW ' + error.message))`,
      // No process.exit: the process has to be able to end by itself.
    ].join('\n'),
  )

  const child = Bun.spawn([process.execPath, script], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
  const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(20_000).then(() => false)])
  if (!exited) child.kill()
  const stdout = await new Response(child.stdout).text()

  expect(stdout).toContain('THREW invalid API key')
  expect(exited).toBe(true)
  const run = readdirSync(join(dir, '.elia', 'runs')).find((entry) => !entry.endsWith('.ndjson'))!
  const receipt = JSON.parse(readFileSync(join(dir, '.elia', 'runs', run, 'receipt.json'), 'utf8'))
  expect(receipt.outcome).toBe('interrupted')
}, 40_000)
