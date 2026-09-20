import { afterEach, beforeEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { runAgentLoop, type RunAgentLoopResult, type ToolEvent } from '../../agentLoop.ts'
import { withAgentIdentity } from '../../autonomy/context.ts'
import { GoalGraphStore, withGoalGraph } from '../../autonomy/goalGraph.ts'
import { createActionGovernor, withActionGovernor, type ActionRequest } from '../../autonomy/governor.ts'
import { createVerdictTool } from '../../autonomy/verify.ts'
import { clearAllCaches } from '../../cacheRegistry.ts'
import type { ContentBlock, Provider, Usage } from '../../providers/types.ts'
import { requiredToolReminders } from '../../requiredTool.ts'
import { editFileTool } from '../../tools/editFile.ts'
import { previewTool } from '../../tools/preview.ts'
import { processTool, resetProcessesForTests } from '../../tools/processTool.ts'
import { readFileTool } from '../../tools/readFile.ts'
import { runCommandTool } from '../../tools/runCommand.ts'
import type { Tool } from '../../tools/types.ts'
import { writeFileTool } from '../../tools/writeFile.ts'
import { githubTool } from '../../tools/github.ts'
import { saveContribution, setContributionsPathForTests } from '../../github/contribute.ts'
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
  options: { maxSteps?: number; usage?: Usage; model?: string; approve?: (request: ActionRequest) => boolean; graph?: GoalGraphStore; tools?: Tool[] } = {},
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
  const inGraph = <T>(fn: () => Promise<T>): Promise<T> => (options.graph ? withGoalGraph(options.graph, fn) : fn())
  const result = await governed(() => inGraph(() => withAgentIdentity({ name: 'behaviour', role: 'lead', cwd: dir }, () =>
    runAgentLoop({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'do the task' }] }],
      systemPrompt: 'You are elia.',
      tools: options.tools ?? TOOLS,
      provider,
      providerName: 'scripted',
      model: options.model ?? 'scripted-behaviour',
      useAnimation: false,
      verbose: false,
      maxSteps: options.maxSteps ?? 20,
      onText: () => {},
      onTool: (event) => events.push(event),
    }),
  )))
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

test('a reviewer still reading when its budget runs low is told to submit, and the verdict it then submits is recorded', async () => {
  for (let i = 0; i < 12; i++) writeFileSync(join(dir, `part${i}.ts`), `export const part${i} = ${i}`)
  // Like critic#1 in runs 2026-09-10-754n-8z17 and 2026-09-12-zjga-se2f: reads
  // for as long as it is allowed to, and makes the structured call only when
  // told to. Once it has, it stops.
  let reads = 0
  const readsUntilTold: Provider = {
    async streamTurn({ messages }) {
      const submitted = messages.some((m) => m.role === 'assistant' && m.content.some((b) => b.type === 'tool_use' && b.name === 'submit_verdict'))
      const last = messages[messages.length - 1]
      const told = last?.role === 'user' && last.content.some((b) => b.type === 'text' && b.text.includes('call submit_verdict now'))
      const content: ContentBlock[] = submitted
        ? [{ type: 'text', text: 'Review submitted.' }]
        : told
          ? [{ type: 'tool_use', id: 'verdict', name: 'submit_verdict', input: { verdict: 'approve', summary: 'Every part is present and exported.' } }]
          : [{ type: 'tool_use', id: `read-${reads}`, name: 'read_file', input: { path: `part${reads++ % 12}.ts` } }]
      return { content, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }
    },
  }
  const review = async (remind: boolean) => {
    reads = 0
    const verdict = createVerdictTool()
    const reminders = remind ? requiredToolReminders('submit_verdict', 8) : undefined
    const result = await withAgentIdentity({ name: 'critic#1', role: 'critic', cwd: dir }, () =>
      runAgentLoop({
        messages: [{ role: 'user', content: [{ type: 'text', text: 'review the change' }] }],
        systemPrompt: 'You are a reviewer.',
        tools: [readFileTool, verdict.tool],
        provider: readsUntilTold,
        providerName: 'scripted',
        model: 'scripted-behaviour',
        useAnimation: false,
        verbose: false,
        maxSteps: 8,
        onText: () => {},
        onTool: (event) => reminders?.onTool(event),
        drainDirectives: reminders?.drain,
      }),
    )
    return { stopReason: result.stopReason, verdict: verdict.taken() }
  }

  // Without it: the budget runs out mid-read, the wrap-up tells it to stop
  // calling tools, and there is no verdict — the gate fails a review that never
  // happened, on a build that had already passed.
  const unreminded = await review(false)
  expect(unreminded.stopReason).toBe('step-budget')
  expect(unreminded.verdict).toBeUndefined()

  const reminded = await review(true)
  expect(reminded.verdict?.verdict).toBe('approve')
  expect(reminded.stopReason).toBe('complete')
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

test('inside an autonomous run, a file read after an edit is the edited file, not a replay of the first read', async () => {
  // Run 2026-09-16-87rg-29ia: the goal graph replayed identical calls from their
  // recorded result, so every re-read of src/index.ts returned the pre-fix file
  // and three reviewers kept flagging a bug that no longer existed.
  writeFileSync(join(dir, 'slug.ts'), 'export const sep = "-"\n')
  const graph = GoalGraphStore.open({ runId: 'observation-replay', goal: 'fix the separator', dir: join(dir, '.graph') })
  const { events } = await run(
    [
      call('read_file', { path: 'slug.ts' }),
      call('write_file', { path: 'slug.ts', content: 'export const sep = "_"\n' }),
      call('read_file', { path: 'slug.ts' }),
      done,
    ],
    { graph, approve: () => true },
  )
  const reads = events.filter((event) => event.name === 'read_file')
  expect(reads).toHaveLength(2)
  expect(reads[0]!.result).toContain('"-"')
  expect(reads[1]!.result).toContain('"_"')
  expect(reads[1]!.cached).toBe(false)
})

test('inside an autonomous run, a repeated test command runs again instead of replaying its old output', async () => {
  // The same replay handed a repair loop the first `bun test` result again after
  // the code under test had changed.
  writeFileSync(join(dir, 'value.ts'), 'export const value = 1\n')
  writeFileSync(
    join(dir, 'value.test.ts'),
    ["import { expect, test } from 'bun:test'", "import { value } from './value.ts'", "test('value is 2', () => expect(value).toBe(2))", ''].join('\n'),
  )
  const graph = GoalGraphStore.open({ runId: 'command-replay', goal: 'rerun a check', dir: join(dir, '.graph') })
  const { events } = await run(
    [
      call('run_command', { command: 'bun test' }),
      call('read_file', { path: 'value.ts' }),
      call('write_file', { path: 'value.ts', content: 'export const value = 2\n' }),
      call('run_command', { command: 'bun test' }),
      done,
    ],
    { graph, approve: () => true },
  )
  const runs = events.filter((event) => event.name === 'run_command')
  expect(runs[0]!.result).toMatch(/1 fail/)
  expect(runs[1]!.result).toMatch(/1 pass/)
  expect(runs[1]!.cached).toBe(false)
}, 60_000)

test('a refusal with nobody to ask is recorded as a policy block, not a decision waiting on a person', async () => {
  // Run 2026-09-16-co1c-79fr: three setup commands refused unattended, worked
  // around by the step, still left "3 approval(s) remain pending" and held the
  // run at needs-attention with its checks green and its review approving.
  const { pendingApprovals } = await import('../../autonomy/goalGraph.ts')
  const graph = GoalGraphStore.open({ runId: 'no-approver', goal: 'build without asking', dir: join(dir, '.graph') })
  const { events } = await run([call('run_command', { command: 'rm -rf dist' }), done], { graph })
  expect(events[0]!.isError).toBe(true)
  expect(events[0]!.result).toContain('nobody to ask')
  const snapshot = graph.state()
  expect(snapshot.actions.map((action) => action.state)).toEqual(['blocked'])
  expect(pendingApprovals(snapshot)).toEqual([])
})

test('an unattended run can remove a leftover file it was asked to, without a shell command', async () => {
  // Run 2026-09-16-fgbo-oq50: a reviewer asked for a duplicate test file to go,
  // `rm` was refused with nobody to ask, and the run failed on it.
  writeFileSync(join(dir, 'index.test.ts'), 'duplicate\n')
  writeFileSync(join(dir, '.env'), 'SECRET=1\n')
  const tools = await import('../../tools/deleteFile.ts')
  TOOLS.push(tools.deleteFileTool)
  try {
    const { events } = await run([
      call('delete_file', { path: 'index.test.ts' }),
      call('delete_file', { path: '.env' }),
      call('delete_file', { path: '../outside.txt' }),
      done,
    ])
    expect(events.map((event) => event.isError)).toEqual([false, true, true])
    expect(existsSync(join(dir, 'index.test.ts'))).toBe(false)
    expect(existsSync(join(dir, '.env'))).toBe(true)
  } finally {
    TOOLS.pop()
  }
})

// Seen live: "install ponytail skill", run from elia's repository root, found
// nothing and wrote src/skills/ponytail.ts and a new src/skills/index.ts — both
// "inside the workspace", because the workspace was elia. `dir` stands in for
// the checkout in these scenarios.

test("inside elia's own checkout, a change to elia's source is asked about first, named as elia's own", async () => {
  const { armSelfEditGuard, disarmSelfEditGuard, selfEditGuard } = await import('../../autonomy/selfEdit.ts')
  armSelfEditGuard(dir, false, dir)
  const asked: unknown[] = []
  const answers = [false, true]
  try {
    const { events } = await run(
      [
        call('write_file', { path: 'src/skills/ponytail.ts', content: 'export function ponytail() {}\n' }),
        call('write_file', { path: 'src/skills/real.ts', content: 'export {}\n' }),
        call('write_file', { path: 'workspace/app/index.html', content: '<h1>app</h1>\n' }),
        call('write_file', { path: 'src/skills/other.ts', content: 'export {}\n' }),
        done,
      ],
      {
        approve: (request) => {
          asked.push(request.input.path)
          return answers.shift() ?? false
        },
      },
    )
    // Asked for each elia file — declined, approved, declined — never for workspace/.
    expect(asked).toEqual(['src/skills/ponytail.ts', 'src/skills/real.ts', 'src/skills/other.ts'])
    expect(events.map((event) => event.isError)).toEqual([true, false, false, true])
    expect(existsSync(join(dir, 'src', 'skills', 'ponytail.ts'))).toBe(false)
    expect(existsSync(join(dir, 'src', 'skills', 'real.ts'))).toBe(true)
    expect(existsSync(join(dir, 'workspace', 'app', 'index.html'))).toBe(true)
    // A single yes opens that file, not the session.
    expect(selfEditGuard()?.allowed).toBe(false)
  } finally {
    disarmSelfEditGuard()
  }
})

test("inside elia's own checkout, 'don't ask again' opens elia's source for the rest of the session", async () => {
  const { armSelfEditGuard, disarmSelfEditGuard, selfEditGuard } = await import('../../autonomy/selfEdit.ts')
  const { assessAction } = await import('../../autonomy/governor.ts')
  armSelfEditGuard(dir, false, dir)
  try {
    const assessment = assessAction({ name: 'write_file', input: { path: 'src/a.ts', content: '' } }, dir)
    expect(assessment).toMatchObject({ intent: 'self_edit', risk: 'critical', decision: 'approve' })
    expect(assessment.reason).toContain("elia's OWN source")
    let asked = 0
    const provider = createScriptedProvider([
      call('write_file', { path: 'src/a.ts', content: 'export const a = 1\n' }),
      call('write_file', { path: 'src/b.ts', content: 'export const b = 1\n' }),
      done,
    ])
    const governor = createActionGovernor({
      mode: 'supervised',
      cwd: dir,
      approve: async () => {
        asked += 1
        return { approved: true, remember: 'session' }
      },
    })
    await withActionGovernor(governor, () => withAgentIdentity({ name: 'behaviour', role: 'lead', cwd: dir }, () =>
      runAgentLoop({
        messages: [{ role: 'user', content: [{ type: 'text', text: 'do the task' }] }],
        systemPrompt: 'You are elia.',
        tools: TOOLS,
        provider,
        providerName: 'scripted',
        model: 'scripted-behaviour',
        useAnimation: false,
        verbose: false,
        maxSteps: 10,
        onText: () => {},
        onTool: () => {},
      }),
    ))
    expect(asked).toBe(1)
    expect(selfEditGuard()?.allowed).toBe(true)
    expect(existsSync(join(dir, 'src', 'a.ts'))).toBe(true)
    expect(existsSync(join(dir, 'src', 'b.ts'))).toBe(true)
  } finally {
    disarmSelfEditGuard()
  }
})

test("inside elia's own checkout with nobody to ask, elia's source is refused and self-edit on lets it through", async () => {
  const { armSelfEditGuard, disarmSelfEditGuard, setSelfEditAllowed } = await import('../../autonomy/selfEdit.ts')
  writeFileSync(join(dir, 'package.json'), '{"name":"elia-ai"}\n')
  armSelfEditGuard(dir, false, dir)
  try {
    const closed = await run([
      call('write_file', { path: 'src/skills/ponytail.ts', content: 'export function ponytail() {}\n' }),
      call('read_file', { path: 'package.json' }),
      call('edit_file', { path: 'package.json', old_string: 'elia-ai', new_string: 'ponytail' }),
      call('write_file', { path: 'workspace/ponytail/index.html', content: '<h1>ponytail</h1>\n' }),
      call('write_file', { path: '.elia/notes.md', content: 'state\n' }),
      done,
    ])
    expect(closed.events.map((event) => [event.name, event.isError])).toEqual([
      ['write_file', true],
      ['read_file', false],
      ['edit_file', true],
      ['write_file', false],
      ['write_file', false],
    ])
    // The model is told why, and told to stop and ask rather than route around it.
    expect(closed.events[0]!.result).toContain("part of elia's own source")
    expect(closed.events[0]!.result).toContain('/self on')
    expect(existsSync(join(dir, 'src', 'skills', 'ponytail.ts'))).toBe(false)
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe('{"name":"elia-ai"}\n')
    expect(existsSync(join(dir, 'workspace', 'ponytail', 'index.html'))).toBe(true)

    setSelfEditAllowed(true)
    clearAllCaches()
    const open = await run([call('write_file', { path: 'src/skills/ponytail.ts', content: 'export {}\n' }), done])
    expect(open.events[0]).toMatchObject({ name: 'write_file', isError: false })
    expect(existsSync(join(dir, 'src', 'skills', 'ponytail.ts'))).toBe(true)
  } finally {
    disarmSelfEditGuard()
  }
})

// --- Working on a repository that is not this project -------------------------
//
// Real git, real repositories, real github tool: the only thing scripted is the
// model. These two scenarios are the 2026-09-20 session, replayed — a clone of
// someone else's project sitting inside elia's checkout, and a commit that
// swept it up under a message about the fix.

/** A git repo at `at` with one commit, and a second repo cloned inside it. */
function repoWithNestedClone(at: string, nested: string): void {
  const git = (args: string[], cwd = at) => spawnSync('git', ['-c', 'user.email=t@t.local', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8', windowsHide: true })
  const source = join(at, '..', `${basename(at)}-source`)
  mkdirSync(source, { recursive: true })
  writeFileSync(join(source, 'core.py'), 'def metavar():\n    return "TEXT"\n')
  git(['init', '-q', '-b', 'main', '.'], source)
  git(['add', '-A'], source)
  git(['commit', '-q', '-m', 'upstream'], source)

  writeFileSync(join(at, 'README.md'), '# the host project\n')
  git(['init', '-q', '-b', 'main', '.'])
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'host'])
  git(['clone', '-q', source, join(at, nested)])
}

function gitIn(cwd: string, args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
  return `${r.stdout ?? ''}`.trim()
}

test("a clone of another project inside the tree is never committed into this one as a gitlink", async () => {
  repoWithNestedClone(dir, 'click')
  const { events } = await run(
    [call('github', { action: 'commit', message: 'Fix issue #3652: add ellipsis for multiple=True', all: true }), done],
    { tools: [...TOOLS, githubTool] },
  )
  expect(events[0]).toMatchObject({ name: 'github', isError: false })
  expect(events[0]!.result).toContain('its own git repository, not part of this project')
  // The commit happened, and the clone is not in it.
  expect(gitIn(dir, ['show', '--stat', '--oneline', 'HEAD'])).not.toContain('click')
  expect(gitIn(dir, ['status', '--porcelain'])).toContain('click')
})

test('a sweeping commit in this project is refused while the work belongs to a contribution elsewhere', async () => {
  repoWithNestedClone(dir, 'click')
  const state = join(dir, 'contributions.json')
  setContributionsPathForTests(state)
  try {
    saveContribution({
      slug: 'pallets/click',
      forkSlug: 'octocat/click',
      dir: join(dir, 'click'),
      defaultBranch: 'main',
      branch: 'fix/issue-3652',
      status: 'branched',
      startedAt: Date.now(),
      updatedAt: Date.now(),
    })
    const before = gitIn(dir, ['rev-parse', 'HEAD'])
    const { events } = await run(
      [
        // The fix is made in the clone, which is where the bug is.
        call('read_file', { path: 'click/core.py' }),
        call('edit_file', { path: 'click/core.py', old_string: 'return "TEXT"', new_string: 'return "TEXT..."' }),
        // …and then committed in the wrong repository, the way it happened.
        call('github', { action: 'commit', message: 'Fix issue #3652: add ellipsis for multiple=True', all: true }),
        // Told what to do instead, the model commits inside the clone.
        call('github', { action: 'commit', dir: join(dir, 'click'), message: 'Show ... for a repeatable option', paths: ['core.py'] }),
        done,
      ],
      { tools: [...TOOLS, githubTool] },
    )
    expect(events[2]!.result).toContain('Refusing to commit everything')
    expect(events[2]!.result).toContain('pallets/click')
    // Nothing was committed here, and nothing was even staged.
    expect(gitIn(dir, ['rev-parse', 'HEAD'])).toBe(before)
    expect(gitIn(dir, ['diff', '--cached', '--name-only'])).toBe('')
    // And the next call landed in the clone, which is the repository the work was in.
    expect(events[3]!.result).toContain('in pallets/click')
    expect(events[3]!.result).toContain('Not contributed yet')
    expect(gitIn(join(dir, 'click'), ['log', '-1', '--pretty=%s'])).toBe('Show ... for a repeatable option')
  } finally {
    setContributionsPathForTests()
  }
})
