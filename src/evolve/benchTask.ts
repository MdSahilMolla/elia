/**
 * Runs ONE benchmark task, in a child process, with the cwd already set to the
 * task's temporary repository.
 *
 * A child process rather than an in-process call, for three reasons that all
 * matter to a fitness function: `config.ts` bakes the working directory into the
 * system prompt at import time, so only a fresh process gives the agent an honest
 * view of where it is; tasks can then run in parallel without fighting over
 * `process.chdir`; and a candidate version of elia that hangs or crashes takes
 * down one task instead of the whole evaluation.
 *
 * Critically, the parent invokes this file *from the candidate's own source tree*.
 * So a mutated elia is measured by running the mutated code — its own loop, its
 * own prompt, its own tools. That is what makes the improvement loop closed.
 *
 * Prints a single line of JSON on stdout. Anything else on stdout is a bug.
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
  cacheStats?: { speculated: number; hits: number; misses: number }
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
const { SYSTEM_PROMPT, config } = await import('../config.ts')
const { runAgentLoop } = await import('../agentLoop.ts')
const { allWorkerTools } = await import('../tools/registry.ts')
const { taskTool } = await import('../tools/task.ts')
const { totalTokens } = await import('../usage.ts')

try {
  const tools = [...allWorkerTools(), taskTool]
  const { createToolResultCache } = await import('../speculation/cache.ts')
  const { createPrefetcher } = await import('../speculation/prefetch.ts')
  const cache = createToolResultCache()

  const result = await runAgentLoop({
    messages: [{ role: 'user', content: [{ type: 'text', text: task.prompt }] }],
    systemPrompt: SYSTEM_PROMPT,
    tools,
    useAnimation: false,
    verbose: false,
    cache,
    prefetcher: createPrefetcher({ tools, cache }),
    maxSteps: 30,
  })

  emit({
    ok: true,
    taskId,
    steps: result.steps,
    elapsedMs: Date.now() - started,
    totalTokens: totalTokens(result.usage),
    model: config.model,
    stopReason: result.stopReason,
    cacheStats: result.cacheStats,
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
