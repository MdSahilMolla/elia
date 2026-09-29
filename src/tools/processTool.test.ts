import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withAgentIdentity, type AgentIdentity } from '../autonomy/context.ts'
import { isInteractiveSessionCommand } from '../shell.ts'
import { processTool, resetProcessesForTests } from './processTool.ts'

let dir: string | undefined

afterEach(() => {
  resetProcessesForTests()
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

function run(input: Record<string, unknown>, identity: Partial<AgentIdentity> = {}): Promise<string> {
  dir ??= realpathSync(mkdtempSync(join(tmpdir(), 'elia-proc-')))
  return withAgentIdentity({ name: 'test', role: 'lead', cwd: dir, ...identity }, () => processTool.execute(input))
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
  await expect(run({ action: 'send', payload: 'bt' })).rejects.toThrow('requires the id')
  await expect(run({ action: 'send', id: ' ' })).rejects.toThrow('requires the id')
  await expect(run({ action: 'restart' })).rejects.toThrow('action must be one of')
})

// A wiring slip — an action that works but is not in the enum, or vice versa —
// is invisible until a model reads the schema and picks something else.
test('the action enum names every action the tool accepts', () => {
  const properties = (processTool.input_schema as { properties: Record<string, { enum?: string[]; type?: string }> }).properties
  expect(properties.action?.enum).toEqual(['start', 'logs', 'stop', 'list', 'send'])
  expect(properties.payload?.type).toBe('string')
})

/**
 * A line-oriented read-eval-print loop, run under the same script runtime as
 * the test itself — the same shape as `gdb` waiting for `bt`. Reads a line from
 * stdin and echoes it back, which is the minimum a `send` has to deliver: bytes
 * arriving at the child's stdin, not just bytes accepted.
 */
const ECHO_LOOP = [
  'let buffer = ""',
  'process.stdin.setEncoding("utf8")',
  'process.stdin.on("data", (chunk) => {',
  '  buffer += chunk',
  '  let index = buffer.indexOf("\\n")',
  '  while (index !== -1) {',
  '    process.stdout.write(`echo: ${buffer.slice(0, index).trim()}\\n`)',
  '    buffer = buffer.slice(index + 1)',
  '    index = buffer.indexOf("\\n")',
  '  }',
  '})',
].join('\n')

function scriptCommand(name: string, body: string): string {
  dir ??= realpathSync(mkdtempSync(join(tmpdir(), 'elia-proc-')))
  const script = join(dir, name)
  writeFileSync(script, body)
  return `${JSON.stringify(process.execPath)} run ${JSON.stringify(script)}`
}

const echoLoopCommand = (): string => scriptCommand('echo-loop.js', ECHO_LOOP)

test('send writes a line to a live process and the process receives it', async () => {
  const started = await run({ action: 'start', command: echoLoopCommand() })
  expect(started).toContain('started')
  const id = idOf(started)

  const sent = await run({ action: 'send', id, payload: 'bt' })
  expect(sent).toContain('bt')

  // The write is asynchronous from the child's point of view; poll briefly
  // rather than assume the echo has landed by the time send returns.
  let logs = ''
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await Bun.sleep(50)
    logs = await run({ action: 'logs', id })
    if (logs.includes('echo: bt')) break
  }
  expect(logs).toContain('echo: bt')
}, 30_000)

test('send to an unknown id is refused with the ids that do exist', async () => {
  await run({ action: 'start', command: LONG_RUNNING })
  await expect(run({ action: 'send', id: 'proc_nope', payload: 'bt' })).rejects.toThrow('No process with id')
}, 30_000)

// A process that has already exited is a fact about the run, and the exit code
// is the useful part of it — the caller asked to type into a dead debugger.
test('send after exit reports the exit code instead of throwing', async () => {
  const id = idOf(await run({ action: 'start', command: scriptCommand('exit-three.js', 'process.exit(3)') }))
  for (let attempt = 0; attempt < 40 && !(await run({ action: 'logs', id })).includes('exited 3'); attempt += 1) await Bun.sleep(50)

  const sent = await run({ action: 'send', id, payload: 'bt' })
  expect(sent).toContain('already exited with code 3')
  expect(sent).toContain('nothing was written')
}, 30_000)

// A newline in a payload is a second command line to the child's shell — the
// same escalation governor.ts guards against for a run_command string. One
// payload is one input line, and anything else is refused rather than
// reinterpreted.
test('a payload that could split into several commands is refused', async () => {
  const id = idOf(await run({ action: 'start', command: echoLoopCommand() }))
  for (const payload of ['bt\nrun', 'bt\r\nquit', `run${String.fromCharCode(0)}rm`]) {
    await expect(run({ action: 'send', id, payload })).rejects.toThrow('payload must be a single line')
  }
  await expect(run({ action: 'send', id, payload: 42 })).rejects.toThrow('send requires a payload string')
}, 30_000)

test('a debugger or REPL is not a bounded build, but its batch form is', () => {
  for (const command of [
    'gdb ./app',
    '/usr/bin/gdb --args ./app arg1',
    'gdb-multiarch ./app',
    'rust-gdb ./target/debug/app',
    'lldb ./app',
    'lldb-server ./app',
    'gdbserver :2345 ./app',
    'rdb ./app',
    'pdb app.py',
    'python -m pdb app.py',
    'python3 -m pdb',
    'nc -l 9000',
    'netcat --listen 9000',
    'ncat -lvp 9000',
    'nc -lvnp 9000',
    'socat - tcp:localhost:9000',
    'socat tcp:localhost:9000 -',
    'gdb ./app && echo done',
  ]) {
    expect(isInteractiveSessionCommand(command)).toBe(true)
  }

  // Scripted debugging is a normal command: it runs and exits, so holding it
  // to exit-zero is correct, and refusing it in run_command would be a lie.
  for (const command of [
    'gdb -batch -x cmds.gdb ./app',
    'gdb --batch ./app',
    'gdb -batch -l ./libs -x cmds.gdb ./app',
    'lldb -b -o "bt" ./app',
    'lldb --one-line "bt" ./app',
    // A one-shot copy, a port scan and a timed connect all exit; only a
    // listener stays up.
    'nc example.com 80',
    'nc -z example.com 443',
    'nc -w 3 example.com 22',
    // A socat transfer is a one-shot copy; only a bare `-` (its stdio
    // address) makes it a session.
    'socat a b',
    'socat -u /dev/null,file:/tmp/in file:/tmp/out',
    // Installing or building with a debugger in the name is not debugging.
    'pip install pdb',
    'apt-get install gdb',
    'cargo build',
  ]) {
    expect(isInteractiveSessionCommand(command)).toBe(false)
  }
})

test('aborting the agent signal terminates a process this session started', async () => {
  const controller = new AbortController()
  const id = idOf(await run({ action: 'start', command: LONG_RUNNING }, { signal: controller.signal }))
  expect(id).not.toBe('')
  expect(await run({ action: 'list' })).toContain('running for')

  controller.abort()

  let listing = ''
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await Bun.sleep(100)
    listing = await run({ action: 'list' })
    if (listing.includes('exited')) break
  }
  expect(listing).toContain('exited')
  expect(listing).not.toContain('running for')
}, 30_000)
