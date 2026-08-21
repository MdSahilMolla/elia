import type { Tool } from './types.ts'
import { runSubAgent } from '../subagent.ts'
import { roleMenu } from '../autonomy/roles.ts'
import { isRoleName, ROLE_NAMES } from '../autonomy/types.ts'
import { inferTaskKind, taskSessions } from '../taskSessions.ts'

let dispatched = 0

export const taskTool: Tool = {
  name: 'task',
  description: `Launch an autonomous sub-agent to complete one independent, self-contained task. The sub-agent has its own context and cannot ask for clarification, so give it a fully self-contained prompt with all the context it needs. Call this tool multiple times in the same turn to run several sub-agents in parallel when the tasks are genuinely independent — that is the main way to make a big job finish quickly.

Pick the role that matches the work:
${roleMenu()}

Scouts run on a faster, cheaper model and cannot modify anything, so prefer a handful of parallel scouts for investigation and reserve builders for the actual changes. Returns the sub-agent's final report.`,
  input_schema: {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'Short (3-6 word) label for this task, shown in the terminal log' },
      role: {
        type: 'string',
        enum: ROLE_NAMES,
        description: 'Which kind of worker to use (default: builder)',
      },
      prompt: { type: 'string', description: 'Full, self-contained instructions for the sub-agent' },
    },
    required: ['description', 'prompt'],
  },
  async execute(input) {
    const prompt = input.prompt as string
    const role = isRoleName(input.role) ? input.role : 'builder'
    dispatched += 1
    const description = typeof input.description === 'string' ? input.description : `${role} task`
    const session = taskSessions.create(inferTaskKind(description, prompt), description, 'Waiting for a worker')
    taskSessions.update(session.id, { status: 'running', action: 'Starting worker', detail: `Role: ${role}` })

    try {
      const result = await runSubAgent({
        prompt,
        role,
        name: `${role}#${dispatched}`,
        onTool: (event) => {
          taskSessions.update(session.id, {
            status: 'running',
            action: event.isError ? `Retrying after ${event.name}` : event.name,
            detail: event.isError ? event.result : `step ${event.name} completed`,
            stepsCompleted: (taskSessions.get(session.id)?.stepsCompleted ?? 0) + 1,
          })
        },
      })
      const header = result.ok
        ? `[${result.role} finished in ${(result.elapsedMs / 1000).toFixed(1)}s, ${result.steps} steps]`
        : `[${result.role} stopped early after ${result.steps} steps — treat this report as incomplete]`
      taskSessions.update(session.id, {
        status: result.ok ? 'done' : 'failed',
        action: result.ok ? 'Finished' : 'Stopped early',
        detail: result.report.slice(0, 240),
        error: result.ok ? undefined : 'Worker stopped before completing its assigned task',
      })
      return `${header}\nTask session: ${session.id}\n${result.report}`
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      taskSessions.update(session.id, { status: 'failed', action: 'Failed', detail, error: detail })
      throw error
    }
  },
}
