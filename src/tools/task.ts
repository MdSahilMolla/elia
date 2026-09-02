import type { Tool } from './types.ts'
import { runSubAgent } from '../subagent.ts'
import { roleMenu } from '../autonomy/roles.ts'
import { isRoleName, ROLE_NAMES } from '../autonomy/types.ts'
import { inferTaskKind, taskSessions } from '../taskSessions.ts'
import { currentAgent } from '../autonomy/context.ts'
import { activeActionGovernor } from '../autonomy/governor.ts'
import { runVerification } from '../autonomy/verify.ts'
import { roleConfig } from '../config.ts'
import { role as roleDefinition } from '../autonomy/roles.ts'

let dispatched = 0

export const taskTool: Tool = {
  name: 'task',
  description: `Launch an autonomous sub-agent to complete one independent, self-contained task. The sub-agent has its own context and cannot ask for clarification, so give it a fully self-contained prompt with all the context it needs. Call this tool multiple times in the same turn to run several sub-agents in parallel when the tasks are genuinely independent — that is the main way to make a big job finish quickly.

Pick the role that matches the work:
${roleMenu()}

Scouts run on a faster, cheaper model and cannot modify anything, so prefer a handful of parallel scouts for investigation and reserve builders for the actual changes. Coding leads such as \`frontend\`, \`backend\`, and \`builder\` receive one additional bounded \`delegate_tasks\` capability: they can fan out up to four focused child assignments, but child workers cannot delegate again. Returns the sub-agent's final report.`,
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
      acceptanceCriteria: { type: 'array', description: 'Observable conditions that must be true before the worker can report completion' },
      verificationCommands: { type: 'array', description: 'Commands or checks the worker must run and report' },
    },
    required: ['description', 'prompt'],
  },
  async execute(input) {
    if (typeof input.prompt !== 'string' || input.prompt.trim().length === 0) throw new Error('prompt must be a non-empty string')
    if (input.prompt.length > 200_000) throw new Error('prompt exceeds 200000 characters')
    if (input.description !== undefined && (typeof input.description !== 'string' || input.description.trim().length === 0)) throw new Error('description must be a non-empty string when provided')
    const prompt = input.prompt
    const role = isRoleName(input.role) ? input.role : 'builder'
    dispatched += 1
    const description = typeof input.description === 'string' ? input.description.trim().slice(0, 160) : `${role} task`
    const acceptanceCriteria = Array.isArray(input.acceptanceCriteria) ? input.acceptanceCriteria.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).map((value) => value.trim().slice(0, 4_000)).slice(0, 20) : undefined
    const verificationCommands = Array.isArray(input.verificationCommands) ? input.verificationCommands.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).map((value) => value.trim().slice(0, 4_000)).slice(0, 20) : undefined
    const route = roleConfig(role, roleDefinition(role).tier)
    const session = taskSessions.create(inferTaskKind(description, prompt), description, 'Waiting for a worker', {
      role,
      depth: 0,
      providerName: route.providerName,
      model: route.model,
      wave: 1,
      acceptanceCriteria,
      verificationCommands,
    })
    taskSessions.update(session.id, { status: 'running', action: 'Starting worker', detail: `Role: ${role}`, nextAction: 'Worker is orienting and will report evidence' })

    try {
      const contract = [
        acceptanceCriteria?.length ? `## Acceptance criteria\n${acceptanceCriteria.map((criterion) => `- ${criterion}`).join('\n')}` : undefined,
        verificationCommands?.length ? `## Verification commands\n${verificationCommands.map((command) => `- ${command}`).join('\n')}` : undefined,
      ].filter(Boolean).join('\n\n')
      let result = await runSubAgent({
        prompt: contract ? `${prompt}\n\n${contract}` : prompt,
        role,
        name: `${role}#${dispatched}`,
        signal: currentAgent().signal,
        onTool: (event) => {
            const current = taskSessions.get(session.id)
            const stepsCompleted = (current?.stepsCompleted ?? 0) + 1
            taskSessions.update(session.id, {
              status: 'running',
              action: event.isError ? `Retrying after ${event.name}` : event.name,
              detail: event.isError ? event.result : `step ${event.name} completed`,
              stepsCompleted,
              nextAction: event.isError ? 'Diagnose the failed tool call and retry safely' : 'Continue until acceptance evidence is complete',
            })
        },
      })
      let verificationPassed: boolean | undefined
      let verificationReport = ''
      if (result.ok && verificationCommands?.length) {
        const verification = await runVerification(verificationCommands, currentAgent().cwd ?? process.cwd(), currentAgent().signal, activeActionGovernor())
        verificationPassed = verification.passed
        verificationReport = verification.passed
          ? `Verification passed: ${verificationCommands.join(' && ')}`
          : `Verification failed:\n${verification.results.map((check) => `${check.command}: ${check.timedOut ? 'timed out' : `exit ${check.exitCode}`}`).join('\n')}`
        result = { ...result, ok: verification.passed, report: `${result.report}\n\n${verificationReport}` }
      }
      const needsReview = !result.ok && verificationPassed === false
      const header = result.ok
        ? `[${result.role} finished and verified in ${(result.elapsedMs / 1000).toFixed(1)}s, ${result.steps} steps]`
        : `[${result.role} ${needsReview ? 'needs review after failed verification' : `stopped early after ${result.steps} steps`} — treat this report as incomplete]`
      taskSessions.update(session.id, {
        status: result.ok ? 'done' : needsReview ? 'needs-review' : 'failed',
        action: result.ok ? 'Finished and verified' : needsReview ? 'Verification needs review' : 'Stopped early',
        detail: result.report.slice(0, 1000),
        stepsCompleted: result.steps,
        stepsTotal: result.steps,
        progress: result.ok ? 1 : Math.min(0.95, result.steps > 0 ? 0.5 : 0),
        nextAction: result.ok ? undefined : needsReview ? 'Inspect the failed verification output and retry the incomplete task.' : 'Review the worker report and retry with corrected context',
        blockedReason: needsReview ? verificationReport : undefined,
        error: result.ok ? undefined : result.report.slice(0, 2000),
      })
      return `${header}\nTask session: ${session.id}\n${result.report}`
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      taskSessions.update(session.id, { status: 'failed', action: 'Failed', detail, blockedReason: 'Worker execution raised an error', nextAction: 'Inspect the error, check environment prerequisites, and retry if safe', error: detail })
      throw error
    }
  },
}
