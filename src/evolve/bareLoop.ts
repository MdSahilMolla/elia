import type { ChatMessage, ContentBlock, Provider, ToolDefinition, Usage } from '../providers/types.ts'
import { isCapacityError, isConnectionError, isTransientServerError } from '../providerErrors.ts'
import { ZERO_USAGE, addUsage } from '../usage.ts'

/**
 * The control arm of `elia bench --lift`: the same model, the same task, the
 * same check — and no harness.
 *
 * Every other comparison the benchmark makes is elia against elia: a candidate
 * tree against the live one. None of them can say whether the harness is worth
 * anything at all, and "does the whole system beat calling the model directly?"
 * is the one question a harness that claims to make a model better has to be
 * able to answer. Without it a 90% pass rate is uninterpretable — the model
 * might score 95% on its own.
 *
 * So this is deliberately the least a model needs to attempt a repository task
 * and nothing more: a shell, a way to write a file, a three-sentence prompt, a
 * plain loop. It is shaped after mini-swe-agent, the bash-only agent the
 * SWE-bench community uses as its reference baseline — with one addition that
 * elia's safety policy forces. mini-swe-agent writes files through the shell
 * inside a container; elia's unattended policy refuses shell writes (`sed -i`,
 * redirects, heredocs, `-e` interpreters) and lets file changes through its
 * file tools instead. A bash-only control arm under that policy cannot change
 * a single file, and the first live run showed exactly that: every task failed
 * on refusals, and the "lift" measured the policy. So the bare model gets one
 * whole-file `write_file`, confined to the task's repository — no read tool, no
 * edit tool, no diff. What it leaves out is exactly what elia claims
 * adds value — the system prompt and Value Core, the tool surface, lessons,
 * speculation, plan tracking, the loop's nudges, sub-agents, compaction. What
 * it keeps is what is not a claim about reasoning: the same step budget, the
 * same safety policy on every command, the same retry on a provider blip. A
 * baseline hobbled by infrastructure elia also has would flatter the harness,
 * and the number would mean less than nothing.
 *
 * Immutable to evolve candidates (sandbox.ts): a candidate that could weaken
 * the control arm could raise its lift without getting any better.
 */

export const BARE_SYSTEM_PROMPT =
  'You are a software engineer working in the repository in the current directory. You have two tools: bash, which runs a shell command there and returns its output, and write_file, which writes a whole file. Do the task you are given by changing the files directly; when you are finished, reply with a one-line summary and no tool call.'

export const BARE_BASH: ToolDefinition = {
  name: 'bash',
  description: 'Run a shell command in the repository and return its exit code, stdout and stderr.',
  input_schema: {
    type: 'object',
    properties: { command: { type: 'string', description: 'The command to run.' } },
    required: ['command'],
  },
}

export const BARE_WRITE: ToolDefinition = {
  name: 'write_file',
  description: 'Write a file in the repository, replacing its whole contents (or creating it).',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relative to the repository root.' },
      content: { type: 'string', description: 'The complete new contents of the file.' },
    },
    required: ['path', 'content'],
  },
}

export const BARE_TOOLS: ToolDefinition[] = [BARE_BASH, BARE_WRITE]

/** Characters of one command's output the model is shown — mini-swe-agent's limit, head and tail kept. */
export const BARE_OUTPUT_LIMIT = 10_000

/** Waits before retrying a provider call that failed for infrastructure reasons, not the model's. */
const RETRY_DELAYS_MS = [2_000, 8_000, 20_000]

export type BareEvent =
  | { say: string }
  | { start: string; id: string }
  | { tool: string; id: string; input: string; ok: boolean; result: string }

export interface BareLoopOptions {
  provider: Pick<Provider, 'streamTurn'>
  prompt: string
  cwd: string
  /** Model round-trips allowed — the task's own budget, the same one elia gets. */
  maxSteps: number
  /** Runs one command and returns what the model sees. Throws when the command was refused. */
  exec: (command: string) => Promise<string>
  /** Writes one whole file. Throws when the write was refused. */
  write: (path: string, content: string) => Promise<string>
  onEvent?: (event: BareEvent) => void
  signal?: AbortSignal
  /** Test seam. */
  retryDelaysMs?: number[]
  sleep?: (ms: number) => Promise<void>
}

export interface BareLoopResult {
  steps: number
  usage: Usage
  stopReason: 'completed' | 'step-budget'
}

export function clipOutput(text: string, limit = BARE_OUTPUT_LIMIT): string {
  if (text.length <= limit) return text
  const half = Math.floor(limit / 2)
  return `${text.slice(0, half)}\n… ${text.length - limit} characters elided …\n${text.slice(-half)}`
}

function retryable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return isTransientServerError(message) || isConnectionError(message) || isCapacityError(message)
}

/** What a tool call runs, or undefined when it names no tool the bare arm has. */
function invocation(call: Extract<ContentBlock, { type: 'tool_use' }>, options: BareLoopOptions): { shown: string; execute: () => Promise<string> } | undefined {
  if (call.name === BARE_BASH.name) {
    const command = typeof call.input.command === 'string' ? call.input.command : ''
    return command.trim() ? { shown: command, execute: () => options.exec(command) } : undefined
  }
  if (call.name === BARE_WRITE.name) {
    const path = typeof call.input.path === 'string' ? call.input.path : ''
    const content = typeof call.input.content === 'string' ? call.input.content : undefined
    return path.trim() && content !== undefined ? { shown: path, execute: () => options.write(path, content) } : undefined
  }
  return undefined
}

export async function runBareLoop(options: BareLoopOptions): Promise<BareLoopResult> {
  const delays = options.retryDelaysMs ?? RETRY_DELAYS_MS
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const messages: ChatMessage[] = [{ role: 'user', content: [{ type: 'text', text: options.prompt }] }]
  let usage = ZERO_USAGE

  for (let step = 1; step <= options.maxSteps; step++) {
    let said = ''
    let turn: { content: ContentBlock[]; usage: Usage } | undefined
    for (let attempt = 0; ; attempt++) {
      try {
        said = ''
        turn = await options.provider.streamTurn({
          cwd: options.cwd,
          system: BARE_SYSTEM_PROMPT,
          messages,
          tools: BARE_TOOLS,
          onText: (delta) => {
            said += delta
          },
          ...(options.signal ? { signal: options.signal } : {}),
        })
        break
      } catch (error) {
        if (attempt >= delays.length || !retryable(error) || options.signal?.aborted) throw error
        await sleep(delays[attempt]!)
      }
    }

    usage = addUsage(usage, turn.usage)
    if (said.trim()) options.onEvent?.({ say: said })
    messages.push({ role: 'assistant', content: turn.content })

    const calls = turn.content.filter((block): block is Extract<ContentBlock, { type: 'tool_use' }> => block.type === 'tool_use')
    if (calls.length === 0) return { steps: step, usage, stopReason: 'completed' }

    const results: ContentBlock[] = []
    for (const call of calls) {
      const run = invocation(call, options)
      if (!run) {
        results.push({ type: 'tool_result', tool_use_id: call.id, content: 'The tools are bash({command}) and write_file({path, content}).', is_error: true })
        continue
      }
      options.onEvent?.({ start: call.name, id: call.id })
      let output: string
      let ok = true
      try {
        output = await run.execute()
      } catch (error) {
        ok = false
        output = error instanceof Error ? error.message : String(error)
      }
      options.onEvent?.({ tool: call.name, id: call.id, input: run.shown, ok, result: output })
      results.push({ type: 'tool_result', tool_use_id: call.id, content: clipOutput(output), is_error: !ok })
    }
    messages.push({ role: 'user', content: results })
  }

  return { steps: options.maxSteps, usage, stopReason: 'step-budget' }
}
