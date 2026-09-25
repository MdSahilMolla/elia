/**
 * Runs ONE benchmark task on the bare model — the control arm of
 * `elia bench --lift` (bareLoop.ts says what "bare" keeps and leaves out).
 *
 * The same contract as benchTask.ts, so fitness.ts can run either with the same
 * setup, timeout, retry and check: the cwd is the task's temporary repository,
 * and a single line of JSON goes to stdout. Anything else on stdout is a bug.
 *
 * Every command and every write goes through the same unattended governor and
 * bench approval the elia arm runs under. That is safety, not help — a refusal is the same
 * refusal on both arms — and a control arm with an ungated shell would be the
 * one part of the benchmark able to reach outside its fixture.
 */
import { taskById } from './suite.ts'

const [taskId] = process.argv.slice(2)

interface TaskRunOutput {
  ok: boolean
  taskId: string
  steps: number
  elapsedMs: number
  totalTokens: number
  model: string
  stopReason?: string
  error?: string
}

function emit(output: TaskRunOutput): never {
  process.stdout.write(`${JSON.stringify(output)}\n`)
  process.exit(output.ok ? 0 : 1)
}

const started = Date.now()

if (!taskId) {
  emit({ ok: false, taskId: '(none)', steps: 0, elapsedMs: 0, totalTokens: 0, model: '', error: 'no task id given' })
}

const task = taskById(taskId)
if (!task) {
  emit({ ok: false, taskId, steps: 0, elapsedMs: 0, totalTokens: 0, model: '', error: `unknown task "${taskId}"` })
}

// Imported after the argv checks so a bad invocation doesn't need an API key.
const { config } = await import('../config.ts')
const { runBareLoop } = await import('./bareLoop.ts')
const { totalTokens } = await import('../usage.ts')

try {
  const { createActionGovernor } = await import('../autonomy/governor.ts')
  const { createBenchApproval } = await import('./benchPolicy.ts')
  const { commandMayReadSensitiveData } = await import('../autonomy/sensitivePaths.ts')
  const { defaultTimeoutForCommand } = await import('../tools/runCommand.ts')
  const { runShell } = await import('../shell.ts')
  const cwd = process.cwd()
  const governor = createActionGovernor({ mode: 'unattended', cwd, approve: createBenchApproval(cwd) })

  const { appendFileSync, mkdirSync, writeFileSync } = await import('node:fs')
  const { dirname, isAbsolute, relative, resolve } = await import('node:path')
  const write = async (path: string, content: string): Promise<string> => {
    const gate = await governor.check({ name: 'write_file', input: { path, content } })
    if (!gate.allowed) throw new Error(gate.message ?? 'refused by the safety policy')
    const target = resolve(cwd, path)
    const inside = relative(cwd, target)
    if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) throw new Error('refused: write_file only writes files inside the repository')
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
    return `wrote ${inside} (${content.split('\n').length} lines)`
  }

  const exec = async (command: string): Promise<string> => {
    const gate = await governor.check({ name: 'run_command', input: { command } })
    if (!gate.allowed) throw new Error(gate.message ?? 'refused by the safety policy')
    if (commandMayReadSensitiveData(command)) throw new Error('refused: the command would read a protected sensitive path')
    const result = await runShell(command, defaultTimeoutForCommand(command), cwd)
    // Plain output, without the failure hints formatShellResult adds: those are
    // elia's, and this arm is measuring the model without them.
    return [
      result.timedOut ? `timed out after ${result.elapsedMs}ms (killed)` : `exit code: ${result.exitCode}`,
      result.stdout ? `stdout:\n${result.stdout}` : '',
      result.stderr ? `stderr:\n${result.stderr}` : '',
    ]
      .filter(Boolean)
      .join('\n')
  }

  // The same trace file benchTask.ts writes, so a failing bare attempt can be
  // read the same way. Redacted and clipped before it reaches the disk.
  const traceOut = process.env.ELIA_BENCH_TRACE_OUT
  const { redactText } = await import('../ui/redact.ts')
  const trace = (event: Record<string, unknown>) => {
    if (!traceOut) return
    try {
      appendFileSync(traceOut, `${JSON.stringify({ ...event, at: Date.now() })}\n`)
    } catch {
      // A lost trace costs a clue, not the task its result.
    }
  }

  const result = await runBareLoop({
    provider: config.provider,
    prompt: task.prompt,
    cwd,
    maxSteps: task.maxSteps ?? 30,
    exec,
    write,
    onEvent: (event) => {
      if ('say' in event) trace({ say: redactText(event.say, 240) })
      else if ('start' in event) trace({ start: event.start, id: event.id })
      else trace({ id: event.id, tool: event.tool, input: redactText(event.input, 240), ok: event.ok, result: redactText(event.result, 240) })
    },
  })

  emit({
    ok: true,
    taskId,
    steps: result.steps,
    elapsedMs: Date.now() - started,
    totalTokens: totalTokens(result.usage),
    model: config.model,
    stopReason: result.stopReason,
  })
} catch (err) {
  emit({
    ok: false,
    taskId,
    steps: 0,
    elapsedMs: Date.now() - started,
    totalTokens: 0,
    model: config.model,
    error: err instanceof Error ? err.message : String(err),
  })
}
