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
const { DEV_SYSTEM_PROMPT, config } = await import('../config.ts')
const { runAgentLoop } = await import('../agentLoop.ts')
const { allWorkerTools } = await import('../tools/registry.ts')
const { taskTool } = await import('../tools/task.ts')
const { totalTokens } = await import('../usage.ts')

try {
  const tools = [...allWorkerTools(), taskTool]
  const { createToolResultCache } = await import('../speculation/cache.ts')
  const { createPrefetcher } = await import('../speculation/prefetch.ts')
  const cache = createToolResultCache()

  // Empty unless `elia bench --lessons` asked for project memory (benchLessons.ts).
  const { benchLessonBlock } = await import('./benchLessons.ts')
  const lessonBlock = await benchLessonBlock(taskId, task.prompt)

  // The fixture's approval channel.
  //
  // Without one, every task ran under the default governor — unattended, no
  // approver — which refuses the whole critical band outright. A task that ends
  // in `git push` could then never pass, and the ledger recorded that as elia
  // failing rather than the policy declining. benchPolicy.ts is the narrowest
  // sanction that fixes it: git whose destination resolves inside this task's
  // own temporary repository, and nothing else.
  const { createActionGovernor, withActionGovernor } = await import('../autonomy/governor.ts')
  const { createBenchApproval } = await import('./benchPolicy.ts')
  const governor = createActionGovernor({
    mode: 'unattended',
    cwd: process.cwd(),
    approve: createBenchApproval(process.cwd()),
  })

  // What the agent did, step by step. The proposer is asked to diagnose the
  // failures, and a final directory plus one line of check output cannot say
  // where eighteen steps went. Written beside the task's repository, never in
  // it, so no check sees it; one line per event as it happens, so a run killed
  // at its timeout still leaves one. Redacted and clipped here, before anything
  // reaches the disk.
  const traceOut = process.env.ELIA_BENCH_TRACE_OUT
  const { redactText } = await import('../ui/redact.ts')
  const { appendFileSync } = await import('node:fs')
  let said = ''
  const trace = (event: Record<string, unknown>) => {
    if (!traceOut) return
    try {
      appendFileSync(traceOut, `${JSON.stringify(event)}\n`)
    } catch {
      // A lost trace costs the proposer a clue, not the task its result.
    }
  }
  const flushSaid = () => {
    if (said.trim()) trace({ say: redactText(said, 240) })
    said = ''
  }

  const result = await withActionGovernor(governor, () =>
    runAgentLoop({
      messages: [{ role: 'user', content: [{ type: 'text', text: task.prompt }] }],
      systemPrompt: `${DEV_SYSTEM_PROMPT}${lessonBlock}`,
      tools,
      useAnimation: false,
      verbose: false,
      cache,
      prefetcher: createPrefetcher({ tools, cache }),
      // A fixture-repo default; a task in a real repository asks for its own.
      maxSteps: task.maxSteps ?? 30,
      ...(traceOut
        ? {
            onText: (delta: string) => {
              said += delta
            },
            onTool: (event: import('../agentLoop.ts').ToolEvent) => {
              flushSaid()
              trace({
                tool: event.name,
                input: redactText(JSON.stringify(event.input), 240),
                ok: !event.isError,
                result: redactText(event.result, 240),
                ...(event.assessment && event.assessment.decision !== 'allow' ? { decision: event.assessment.decision } : {}),
              })
            },
          }
        : {}),
    }),
  )
  flushSaid()

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
