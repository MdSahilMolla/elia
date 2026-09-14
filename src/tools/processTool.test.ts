import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withAgentIdentity } from '../autonomy/context.ts'
import { processTool, resetProcessesForTests } from './processTool.ts'

let dir: string | undefined

afterEach(() => {
  resetProcessesForTests()
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

function run(input: Record<string, unknown>): Promise<string> {
  dir ??= realpathSync(mkdtempSync(join(tmpdir(), 'elia-proc-')))
  return withAgentIdentity({ name: 'test', role: 'lead', cwd: dir }, () => processTool.execute(input))
}

/** The id out of a `start` result line, so later calls can address the process. */
function idOf(result: string): string {
  const id = /\bproc_[0-9a-f]+/.exec(result)?.[0]
  if (!id) throw new Error(`no process id in: ${result}`)
  return id
}

/** A command that prints and then stays alive, in whichever shell this platform uses. */
const LONG_RUNNING = process.platform === 'win32'
  ? 'echo listening on 4173 && ping -n 30 127.0.0.1 > nul'
  : 'echo listening on 4173 && sleep 30'

test('start returns immediately for a process that never exits, and logs shows its output', async () => {
  const started = await run({ action: 'start', command: LONG_RUNNING })
  expect(started).toContain('started')
  const id = idOf(started)

  const logs = await run({ action: 'logs', id })
  expect(logs).toContain('running for')
  expect(logs).toContain('listening on 4173')
}, 30_000)

test('a command that dies on startup is reported as not running, not as started', async () => {
  // The preview bug in another costume: announcing success for something that
  // is not up. A bad command fails immediately and must be reported that way.
  const result = await run({ action: 'start', command: 'definitely-not-a-real-binary-xyz --version' })
  expect(result).toContain('exited immediately')
  expect(result).toContain('it is not running')
  expect(result).not.toContain('started:')
}, 30_000)

test('stop terminates a running process and list reflects it', async () => {
  const id = idOf(await run({ action: 'start', command: LONG_RUNNING }))
  expect(await run({ action: 'list' })).toContain('running for')

  const stopped = await run({ action: 'stop', id })
  expect(stopped).toMatch(/stopped|terminate signal/)

  // Stopping twice is not an error; it reports what already happened.
  const again = await run({ action: 'stop', id })
  expect(again).toMatch(/already exited|terminate signal/)
}, 30_000)

test('logs can be filtered and bounded', async () => {
  const id = idOf(await run({ action: 'start', command: LONG_RUNNING }))
  const matched = await run({ action: 'logs', id, filter: 'listening' })
  expect(matched).toContain('listening on 4173')

  const missed = await run({ action: 'logs', id, filter: 'a-string-that-is-not-there' })
  expect(missed).toContain('no lines matching')
}, 30_000)

test('an unknown id is refused with the ids that do exist', async () => {
  await run({ action: 'start', command: LONG_RUNNING })
  await expect(run({ action: 'logs', id: 'proc_nope' })).rejects.toThrow('No process with id')
}, 30_000)

test('list says so plainly when nothing has been started', async () => {
  expect(await run({ action: 'list' })).toContain('No processes have been started')
})

test('start and the id-taking actions validate their input', async () => {
  await expect(run({ action: 'start' })).rejects.toThrow('non-empty command')
  await expect(run({ action: 'logs' })).rejects.toThrow('requires the id')
  await expect(run({ action: 'stop' })).rejects.toThrow('requires the id')
  await expect(run({ action: 'restart' })).rejects.toThrow('action must be one of')
})
