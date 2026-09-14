import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAgentLoop, type RunAgentLoopResult, type ToolEvent } from '../../agentLoop.ts'
import { withAgentIdentity } from '../../autonomy/context.ts'
import { createActionGovernor, withActionGovernor, type ActionRequest } from '../../autonomy/governor.ts'
import { clearAllCaches } from '../../cacheRegistry.ts'
import type { Usage } from '../../providers/types.ts'
import { editFileTool } from '../../tools/editFile.ts'
import { previewTool } from '../../tools/preview.ts'
import { processTool, resetProcessesForTests } from '../../tools/processTool.ts'
import { readFileTool } from '../../tools/readFile.ts'
import { runCommandTool } from '../../tools/runCommand.ts'
import type { Tool } from '../../tools/types.ts'
import { writeFileTool } from '../../tools/writeFile.ts'
import { createScriptedProvider, type ScriptedTurn } from '../latency/scriptedProvider.ts'

/**
 * Agent behaviour, end to end.
 *
 * Unit tests prove the parts work. They do not prove the agent does: 2,378 of
 * them passed while elia was broken — every `run_command` mis-quoted on Windows,
 * `preview` announcing 404s as opened, every verification verdict wrong. What
 * was missing was a test that drives the *real* loop, with the *real* tools,
 * against a real directory, and checks what actually happened.
 *
 * The scripted provider already did the hard part — it is deterministic, needs
 * no network or key, and plugs straight into `runAgentLoop` — but it was only
 * ever pointed at wall-clock timing. Here it scripts what a model does, and each
 * scenario asserts on the outcome: the file on disk, the tool result the model
 * was handed, the reason the loop stopped. Every scenario is a behaviour that
 * has broken before, or that a fix in this repository exists to guarantee.
 */

const TOOLS: Tool[] = [readFileTool, writeFileTool, editFileTool, previewTool, processTool, runCommandTool]

let dir: string

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'elia-behaviour-')))
  clearAllCaches()
})

afterEach(() => {
  resetProcessesForTests()
  delete process.env.ELIA_MAX_SPEND_USD
  delete process.env.ELIA_NO_BROWSER_LAUNCH
  rmSync(dir, { recursive: true, force: true })
})

interface Run {
  result: RunAgentLoopResult
  events: ToolEvent[]
  calls: number
}

/** Drive the real loop with a scripted model, inside `dir`, and record everything the tools did. */
async function run(
  turns: ScriptedTurn[],
  options: { maxSteps?: number; usage?: Usage; model?: string; approve?: (request: ActionRequest) => boolean } = {},
): Promise<Run> {
  const provider = createScriptedProvider(turns, options.usage ? { usage: options.usage } : {})
  const events: ToolEvent[] = []
  // With no `approve`, the default governor applies: unattended, nobody to ask
  // — the strictest posture. With one, this is a supervised session and the
  // callback is the operator answering the approval prompt.
  const approve = options.approve
  const governed = <T>(fn: () => Promise<T>): Promise<T> =>
    approve
      ? withActionGovernor(createActionGovernor({ mode: 'supervised', cwd: dir, approve: async (_assessment, request) => approve(request) }), fn)
      : fn()
  const result = await governed(() => withAgentIdentity({ name: 'behaviour', role: 'lead', cwd: dir }, () =>
    runAgentLoop({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'do the task' }] }],
      systemPrompt: 'You are elia.',
      tools: TOOLS,
      provider,
      providerName: 'scripted',
      model: options.model ?? 'scripted-behaviour',
      useAnimation: false,
      verbose: false,
      maxSteps: options.maxSteps ?? 20,
      onText: () => {},
      onTool: (event) => events.push(event),
    }),
  ))
  return { result, events, calls: provider.calls }
}

const call = (name: string, input: Record<string, unknown>): ScriptedTurn => ({ toolCalls: [{ name, input }] })
const done: ScriptedTurn = { text: 'Done.' }

// --- The work actually happens ------------------------------------------------

test('a file the model writes exists on disk with exactly that content', async () => {
  const { result, events } = await run([
    call('write_file', { path: 'notes.md', content: '# Findings\n\nThe cache is cold on first run.\n' }),
    done,
  ])
  expect(result.stopReason).toBe('complete')
  expect(events[0]).toMatchObject({ name: 'write_file', isError: false })
  expect(readFileSync(join(dir, 'notes.md'), 'utf8')).toBe('# Findings\n\nThe cache is cold on first run.\n')
})

test('an edit the model makes is applied to the real file, not just reported', async () => {
  writeFileSync(join(dir, 'config.ts'), 'export const retries = 1\n')
  const { events } = await run([
    call('read_file', { path: 'config.ts' }),
    call('edit_file', { path: 'config.ts', old_string: 'retries = 1', new_string: 'retries = 3' }),
    done,
  ])
  expect(events.map((event) => [event.name, event.isError])).toEqual([['read_file', false], ['edit_file', false]])
  expect(readFileSync(join(dir, 'config.ts'), 'utf8')).toBe('export const retries = 3\n')
})

test('a failing tool call does not end the turn — the model is handed the error and its retry runs', async () => {
  const { result, events } = await run([
    call('read_file', { path: 'does-not-exist.ts' }),
    call('write_file', { path: 'does-not-exist.ts', content: 'export {}\n' }),
    done,
  ])
  expect(result.stopReason).toBe('complete')
  expect(events[0]).toMatchObject({ name: 'read_file', isError: true })
  // The error is what the model sees, so it has to say what went wrong.
  expect(events[0]!.result.length).toBeGreaterThan(0)
  expect(events[1]).toMatchObject({ name: 'write_file', isError: false })
  expect(existsSync(join(dir, 'does-not-exist.ts'))).toBe(true)
})

// --- Nothing is reported as working when it is not ----------------------------

test('preview of a URL nothing is serving comes back to the model as an error, not as "opened"', async () => {
  // Round 4: a guessed dev-server port was announced to the user as a live
  // preview link. The model must be told it failed, so it cannot pass it on.
  const { result, events } = await run([call('preview', { url: 'http://127.0.0.1:9/' }), done])
  expect(result.stopReason).toBe('complete')
  expect(events[0]).toMatchObject({ name: 'preview', isError: true })
  expect(events[0]!.result).toContain('Nothing is serving')
  expect(events[0]!.result).not.toMatch(/^Opened/)
}, 30_000)

test('preview of a page that exists is served, checked, and reported with its real URL', async () => {
  writeFileSync(join(dir, 'index.html'), '<!doctype html><h1>Birds of the Western Ghats</h1><p>A field guide.</p>')
  process.env.ELIA_NO_BROWSER_LAUNCH = '1'
  const { events } = await run([call('preview', { path: 'index.html' }), done])
  expect(events[0]).toMatchObject({ name: 'preview', isError: false })
  expect(events[0]!.result).toMatch(/http:\/\/127\.0\.0\.1:\d+\/index\.html/)
}, 30_000)

test('a long-running process started by the model keeps running and its output can be read back', async () => {
  // run_command could only ever time out on a server; this is what replaced it.
  // A plain program with arguments — no shell syntax — so it is judged on what
  // it runs, the way an ordinary dev-server command is.
  const command = process.platform === 'win32' ? 'ping -n 30 127.0.0.1' : 'ping -c 30 127.0.0.1'
  // A supervised session: the operator is asked, says yes, and only then does
  // anything start. Starting a process leaves something running after the call
  // returns, so it must never skip that question.
  const asked: string[] = []
  const operatorSaysYes = (request: ActionRequest): boolean => {
    asked.push(`${request.name} ${String(request.input.action)} ${String(request.input.command)}`)
    return true
  }
  const started = await run([call('process', { action: 'start', command }), done], { approve: operatorSaysYes })
  expect(asked).toEqual([`process start ${command}`])
  expect(started.events[0]).toMatchObject({ name: 'process', isError: false })
  const id = /\bproc_[0-9a-f]+/.exec(started.events[0]!.result)?.[0]
  expect(id).toBeDefined()

  // Reading logs changes nothing, so it needs no approval at all.
  const logs = await run([call('process', { action: 'logs', id }), done], { approve: operatorSaysYes })
  expect(asked).toHaveLength(1)
  expect(logs.events[0]!.result).toContain('running for')
  expect(logs.events[0]!.result).toContain('127.0.0.1')
}, 30_000)

test('an unattended run will not start a chained shell command in the background', async () => {
  // `process start` launches a shell command exactly as run_command does, so it
  // must be governed exactly as run_command is. With no terminal attached there
  // is nobody to approve `a && b`, which can reach far beyond what its first
  // token suggests — so it is refused, and the model is told why.
  const { events } = await run([call('process', { action: 'start', command: 'echo ok && curl https://example.com' }), done])
  expect(events[0]).toMatchObject({ name: 'process', isError: true })
  expect(events[0]!.result).toContain('blocked')
  expect(events[0]!.assessment?.risk).toBe('critical')
})

// --- The loop stops when it should, and says why ------------------------------

test('a model that never stops calling tools is halted by the step budget', async () => {
  const forever = Array.from({ length: 40 }, (_, i) => call('write_file', { path: `f${i}.txt`, content: 'x' }))
  const { result } = await run(forever, { maxSteps: 4 })
  expect(result.stopReason).toBe('step-budget')
  // Not one tool call past the budget ran.
  expect(existsSync(join(dir, 'f10.txt'))).toBe(false)
})

/** Enough per call on a priced model that a $1 ceiling is crossed on the first step. */
const EXPENSIVE: Usage = { inputTokens: 10_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 }

test('the spending ceiling halts the loop before it spends more', async () => {
  process.env.ELIA_MAX_SPEND_USD = '1'
  const writes = Array.from({ length: 10 }, (_, i) => call('write_file', { path: `w${i}.txt`, content: 'x' }))
  const { result } = await run(writes, { usage: EXPENSIVE, model: 'mercury-2.5' })
  expect(result.stopReason).toBe('spend-budget')
  // It stopped early — the run did not get anywhere near the end of its script.
  expect(existsSync(join(dir, 'w9.txt'))).toBe(false)
})

test('spend is priced against the model the loop is actually running, not the globally selected one', async () => {
  // A sub-agent on another tier passes its own `model`. Priced against the
  // selected model instead, a cheap sub-agent would hit the ceiling early and a
  // dear one would blow straight past it. An unpriced model cannot be measured,
  // so the ceiling must stand down rather than silently price it as something else.
  process.env.ELIA_MAX_SPEND_USD = '1'
  const writes = Array.from({ length: 3 }, (_, i) => call('write_file', { path: `u${i}.txt`, content: 'x' }))
  const { result } = await run([...writes, done], { usage: EXPENSIVE, model: 'a-model-with-no-pricing-entry' })
  expect(result.stopReason).toBe('complete')
  expect(existsSync(join(dir, 'u2.txt'))).toBe(true)
})

// --- Commands reach the shell intact, and failures read as failures ---------

test('a shell command carrying double quotes runs correctly on this platform', async () => {
  // The recorded round-4 failure: Windows `"`-quoting broke *every*
  // run_command, and the whole suite stayed green because nothing ran a command
  // through the loop. A unit test of the quoting helper asserts the argv it
  // builds; only executing it proves the shell agreed.
  const { events } = await run([call('run_command', { command: 'echo "hello there"' }), done], { approve: () => true })
  expect(events[0]).toMatchObject({ name: 'run_command', isError: false })
  expect(events[0]!.result).toContain('exit code: 0')
  // Whether the quotes survive into the output is the shell's business, not
  // elia's — cmd.exe's `echo` prints them, POSIX `sh` strips them. What this
  // guards is that the command reached a shell intact and ran, which is exactly
  // what the Windows quoting bug broke.
  expect(events[0]!.result).toContain('hello there')
}, 30_000)

test('a command the shell cannot run is reported as a failure, not as output', async () => {
  const { events } = await run([call('run_command', { command: 'definitely-not-a-real-binary-xyz' }), done], { approve: () => true })
  expect(events[0]!.name).toBe('run_command')
  // Either surfaced as a tool error or as a non-zero exit in the result; what
  // matters is that it is not handed back looking like success.
  expect(events[0]!.isError || /not recognized|not found|exit code [1-9]/i.test(events[0]!.result)).toBe(true)
}, 30_000)

test('a process that dies on startup is reported as not running', async () => {
  // preview's bug in another costume: announcing that something is up when it
  // is not. `start` waits briefly and reports the death rather than an id.
  const { events } = await run(
    [call('process', { action: 'start', command: 'definitely-not-a-real-binary-xyz' }), done],
    { approve: () => true },
  )
  expect(events[0]!.result).toContain('it is not running')
  expect(events[0]!.result).not.toContain('started:')
}, 30_000)
