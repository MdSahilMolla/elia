/**
 * Runs elia against ONE SWE-bench instance's problem_statement, in a child
 * process cwd'd into the instance's checked-out repo tree — the same
 * "fresh process, real cwd" reasoning as evolve/benchTask.ts: config.ts
 * bakes the working directory into the system prompt at import time, and an
 * instance that hangs takes down one task, not the whole harness run.
 *
 * Reads its problem statement from a JSON file left in the cwd rather than
 * an in-process task registry (unlike benchTask.ts's taskById) — a SWE-bench
 * instance is external data, not one of elia's own fixture tasks.
 *
 * Prints one line of JSON on stdout. Anything else on stdout is a bug.
 */

export {} // marks this file a module so top-level `await` (used below, after the argv/spec-file checks) is allowed

const SPEC_FILE = '.elia-swebench-task.json'

interface TaskSpec {
  problem_statement: string
  maxSteps?: number
}

interface TaskRunOutput {
  ok: boolean
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

const specFile = Bun.file(SPEC_FILE)
if (!(await specFile.exists())) {
  emit({ ok: false, steps: 0, elapsedMs: 0, totalTokens: 0, model: '', error: `${SPEC_FILE} not found in cwd` })
}
let spec: TaskSpec
try {
  spec = (await specFile.json()) as TaskSpec
} catch (err) {
  emit({ ok: false, steps: 0, elapsedMs: 0, totalTokens: 0, model: '', error: `could not parse ${SPEC_FILE}: ${err instanceof Error ? err.message : String(err)}` })
}
if (!spec!.problem_statement?.trim()) {
  emit({ ok: false, steps: 0, elapsedMs: 0, totalTokens: 0, model: '', error: 'task spec has no problem_statement' })
}

// Imported after the spec-file checks so a bad invocation doesn't need an API key.
const { DEV_SYSTEM_PROMPT, config } = await import('../../config.ts')
const { runAgentLoop } = await import('../../agentLoop.ts')
const { allWorkerTools } = await import('../../tools/registry.ts')
const { totalTokens } = await import('../../usage.ts')

try {
  const result = await runAgentLoop({
    messages: [{ role: 'user', content: [{ type: 'text', text: spec!.problem_statement }] }],
    systemPrompt: DEV_SYSTEM_PROMPT,
    tools: allWorkerTools(),
    useAnimation: false,
    verbose: false,
    maxSteps: spec!.maxSteps ?? 80,
  })
  emit({
    ok: true,
    steps: result.steps,
    elapsedMs: Date.now() - started,
    totalTokens: totalTokens(result.usage),
    model: config.model,
    stopReason: result.stopReason,
  })
} catch (err) {
  emit({ ok: false, steps: 0, elapsedMs: Date.now() - started, totalTokens: 0, model: config.model, error: err instanceof Error ? err.message : String(err) })
}
