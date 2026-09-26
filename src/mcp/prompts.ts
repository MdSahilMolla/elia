import { isAbsolute, relative, resolve, sep } from 'node:path'
import { redactArchiveValue, redactText, relativizeProjectPaths } from '../ui/redact.ts'
import type { McpPromptDescriptor, McpPromptGetResult } from './protocol.ts'
import { ELIA_MODES, type McpRunState, type McpToolExecutionContext } from './serverTypes.ts'

const MAX_ARGUMENT_LENGTH = 12_000
const MAX_TOTAL_ARGUMENT_LENGTH = 32_000
const MAX_CONTEXT_LENGTH = 8_000
const MAX_PROMPT_LENGTH = 40_000
const MAX_RECENT_RUNS = 10
const MAX_LESSONS = 8

const PROMPTS: readonly McpPromptDescriptor[] = [
  {
    name: 'elia_task_prompt',
    title: 'Plan an Elia task',
    description: 'Frames a bounded task plan and separates planning from approval and execution.',
    arguments: [
      { name: 'goal', description: 'Concrete outcome to plan.', required: true },
      { name: 'context', description: 'Relevant context or constraints.', required: false },
      { name: 'constraints', description: 'Boundaries that the plan must preserve.', required: false },
      { name: 'deliverable', description: 'Expected final artifact or report.', required: false },
    ],
  },
  {
    name: 'elia_research_prompt',
    title: 'Frame an Elia research request',
    description: 'Frames a bounded, evidence-seeking research request without starting research.',
    arguments: [
      { name: 'question', description: 'Research question to answer.', required: true },
      { name: 'scope', description: 'Boundaries, geography, or domain to cover.', required: false },
      { name: 'sources', description: 'Preferred source types or named sources.', required: false },
      { name: 'timeframe', description: 'Date range or freshness requirement.', required: false },
    ],
  },
  {
    name: 'elia_audit_prompt',
    title: 'Frame an Elia audit',
    description: 'Frames a read-only audit with evidence requirements and no implied remediation.',
    arguments: [
      { name: 'target', description: 'Code, artifact, run, process, or control to audit.', required: true },
      { name: 'focus', description: 'Risk, control, or quality dimension to prioritize.', required: false },
      { name: 'evidence', description: 'Evidence that must be inspected.', required: false },
      { name: 'severity', description: 'Requested reporting standard or threshold.', required: false },
    ],
  },
  {
    name: 'elia_evolve_prompt',
    title: 'Frame an Elia evolution request',
    description: 'Frames a bounded self-improvement hypothesis while withholding execution and promotion approval.',
    arguments: [
      { name: 'objective', description: 'Improvement outcome to investigate.', required: true },
      { name: 'baseline', description: 'Current behavior or measurement baseline.', required: false },
      { name: 'constraints', description: 'Boundaries for candidate generation and validation.', required: false },
      { name: 'benchmark', description: 'Required benchmark or promotion evidence.', required: false },
    ],
  },
  {
    name: 'elia_morning_brief_prompt',
    title: 'Create an Elia morning brief',
    description: 'Creates a bounded read-only briefing request from current mode, memory, and run state.',
    arguments: [
      { name: 'project', description: 'Project label or contained project-relative path.', required: false },
      { name: 'window', description: 'Time window to summarize.', required: false },
      { name: 'focus', description: 'Optional area to prioritize.', required: false },
    ],
  },
] as const

export const ELIA_PROMPTS = PROMPTS

function canonicalRoot(context: McpToolExecutionContext): string {
  return resolve(context.cwd)
}

function withinRoot(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate)
  return relativePath === '' || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
}

function projectLabel(context: McpToolExecutionContext, value: string | undefined): string {
  if (!value || value === '.' || value === 'current') return '.'
  const root = canonicalRoot(context)
  const candidate = resolve(root, value)
  if (withinRoot(root, candidate)) {
    return relative(root, candidate).split(sep).join('/') || '.'
  }
  return '[external-project-omitted]'
}

function safeArgument(value: unknown, root: string, key: string): string {
  if (typeof value !== 'string') throw new Error(`Prompt argument ${key} must be a string`)
  const redacted = redactArchiveValue(value, key)
  if (typeof redacted !== 'string') return '[REDACTED]'
  const bounded = redactText(relativizeProjectPaths(redacted, root), MAX_ARGUMENT_LENGTH)
  return bounded.length < redacted.length ? `${bounded}\n[argument truncated]` : bounded
}

function argument(
  arguments_: Record<string, string>,
  names: readonly string[],
  required: boolean,
  root: string,
): string | undefined {
  let totalLength = 0
  for (const value of Object.values(arguments_)) totalLength += value.length
  if (totalLength > MAX_TOTAL_ARGUMENT_LENGTH) throw new Error('Prompt arguments exceed the allowed size')

  for (const name of names) {
    const value = arguments_[name]
    if (value === undefined) continue
    const normalized = safeArgument(value, root, name).trim()
    if (!normalized) continue
    return normalized
  }
  if (required) throw new Error(`Prompt argument ${names[0]} is required`)
  return undefined
}

function optionalSection(label: string, value: string | undefined): string[] {
  return value ? [`${label}:`, value] : []
}

function recentRuns(context: McpToolExecutionContext): McpRunState[] {
  return Array.from(context.runStates.values())
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_RECENT_RUNS)
}

function runSummary(context: McpToolExecutionContext): string[] {
  const runs = recentRuns(context)
  if (runs.length === 0) return []
  const root = canonicalRoot(context)
  return [
    'Current process run states:',
    ...runs.map(run => `- ${run.runId}: ${run.status}; mode=${run.mode ?? context.mode}; updated=${new Date(run.updatedAt).toISOString()}${run.error ? `; error=${safeArgument(run.error, root, 'error')}` : ''}`),
  ]
}

function projectContext(context: McpToolExecutionContext): string[] {
  const root = canonicalRoot(context)
  const sections: string[] = []
  if (context.memory?.project) {
    sections.push('Loaded project context:', safeArgument(context.memory.project, root, 'project memory').slice(0, MAX_CONTEXT_LENGTH))
  }
  if (context.lessons && context.lessons.length > 0) {
    sections.push('Loaded lessons:')
    sections.push(...context.lessons.slice(0, MAX_LESSONS).map(lesson => `- ${safeArgument(lesson, root, 'lesson').slice(0, 2_000)}`))
  }
  return sections
}

function runtimeSummary(context: McpToolExecutionContext): string[] {
  return [
    `Active mode: ${context.mode}`,
    `Available modes: ${ELIA_MODES.join(', ')}`,
    `Configured approval policy: ${context.config.approvalMode}`,
    `Per-session cost limit: ${context.config.costLimitPerSessionUsd === null ? 'unset' : `$${context.config.costLimitPerSessionUsd.toFixed(4)}`}`,
  ]
}

function guardrails(context: McpToolExecutionContext): string[] {
  return [
    'Safety boundary:',
    '- This prompt is a request, not authorization and not evidence that an action ran.',
    '- Use read-only MCP resources for evidence and distinguish observed facts from assumptions.',
    '- Do not claim a mutation, external side effect, approval, or provider action without runtime evidence.',
    `- Respect the ${context.mode} mode, required capabilities, cost limits, and approval policy.`,
    '- Request exact approval before any approval-required or irreversible action.',
  ]
}

function boundedPromptText(sections: readonly (string | string[])[]): string {
  const text = sections.flatMap(section => Array.isArray(section) ? section : [section]).join('\n').trim()
  if (text.length <= MAX_PROMPT_LENGTH) return text
  return `${text.slice(0, MAX_PROMPT_LENGTH - 32)}\n[prompt truncated]`
}

function promptResult(description: string, sections: readonly (string | string[])[]): McpPromptGetResult {
  const guardedSections: (string | string[])[] = [
    'Execution boundary: this prompt is not authorization and does not prove that any action ran.',
    ...sections,
  ]
  return {
    description,
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: boundedPromptText(guardedSections),
      },
    }],
  }
}

function taskPrompt(context: McpToolExecutionContext, arguments_: Record<string, string>): McpPromptGetResult {
  const root = canonicalRoot(context)
  const goal = argument(arguments_, ['goal', 'task', 'objective'], true, root)
  const taskContext = argument(arguments_, ['context'], false, root)
  const constraints = argument(arguments_, ['constraints', 'limitations'], false, root)
  const deliverable = argument(arguments_, ['deliverable', 'output'], false, root)
  return promptResult('Bounded Elia task planning request', [
    'Plan the following Elia task. Do not begin execution merely because this prompt exists.',
    ...optionalSection('Goal', goal),
    ...optionalSection('Task context', taskContext),
    ...optionalSection('Constraints', constraints),
    ...optionalSection('Deliverable', deliverable),
    'Required response:',
    '- Return a concise plan, assumptions, evidence needed, verification steps, and explicit approval boundaries.',
    '- Separate completed observations from proposed next actions.',
    ...runtimeSummary(context),
    ...projectContext(context),
    ...runSummary(context),
    ...guardrails(context),
  ])
}

function researchPrompt(context: McpToolExecutionContext, arguments_: Record<string, string>): McpPromptGetResult {
  const root = canonicalRoot(context)
  const question = argument(arguments_, ['question', 'topic', 'goal'], true, root)
  const scope = argument(arguments_, ['scope', 'context'], false, root)
  const sources = argument(arguments_, ['sources', 'source_requirements'], false, root)
  const timeframe = argument(arguments_, ['timeframe', 'time_range', 'date_range'], false, root)
  return promptResult('Bounded Elia research request', [
    'Frame the following research request. This prompt does not start research or fetch sources.',
    ...optionalSection('Question', question),
    ...optionalSection('Scope', scope),
    ...optionalSection('Source requirements', sources),
    ...optionalSection('Timeframe', timeframe),
    'Required response:',
    '- Define the question, evidence standard, likely source mix, exclusions, and stop conditions.',
    '- Prefer primary and current sources; label inaccessible, stale, or unverified evidence.',
    '- Keep external actions and any subsequent tool calls distinct from this planning step.',
    ...runtimeSummary(context),
    ...projectContext(context),
    ...guardrails(context),
  ])
}

function auditPrompt(context: McpToolExecutionContext, arguments_: Record<string, string>): McpPromptGetResult {
  const root = canonicalRoot(context)
  const target = argument(arguments_, ['target', 'scope', 'subject'], true, root)
  const focus = argument(arguments_, ['focus', 'risk'], false, root)
  const evidence = argument(arguments_, ['evidence', 'sources'], false, root)
  const severity = argument(arguments_, ['severity', 'threshold', 'standard'], false, root)
  return promptResult('Read-only Elia audit request', [
    'Perform a read-only audit of the target only after this prompt is accepted by the caller.',
    ...optionalSection('Target', target),
    ...optionalSection('Focus', focus),
    ...optionalSection('Required evidence', evidence),
    ...optionalSection('Severity standard', severity),
    'Required response:',
    '- State scope and limitations, then report findings ordered by severity with concrete evidence.',
    '- Distinguish confirmed findings from hypotheses and include verification gaps.',
    '- Recommend remediation separately; do not modify files, state, accounts, or external systems.',
    ...runtimeSummary(context),
    ...projectContext(context),
    ...runSummary(context),
    ...guardrails(context),
  ])
}

function evolvePrompt(context: McpToolExecutionContext, arguments_: Record<string, string>): McpPromptGetResult {
  const root = canonicalRoot(context)
  const objective = argument(arguments_, ['objective', 'goal', 'target'], true, root)
  const baseline = argument(arguments_, ['baseline', 'current_state'], false, root)
  const constraints = argument(arguments_, ['constraints', 'boundaries'], false, root)
  const benchmark = argument(arguments_, ['benchmark', 'validation', 'success_metric'], false, root)
  return promptResult('Bounded Elia evolution hypothesis', [
    'Frame a self-improvement hypothesis. Do not call evolution, promotion, or mutation tools from this prompt alone.',
    ...optionalSection('Objective', objective),
    ...optionalSection('Baseline', baseline),
    ...optionalSection('Constraints', constraints),
    ...optionalSection('Required benchmark or promotion evidence', benchmark),
    'Required response:',
    '- Define one falsifiable hypothesis, baseline, candidate boundary, rollback condition, and evaluation plan.',
    '- Require measured evidence before promotion and identify every approval-gated step.',
    '- Do not describe the candidate as improved until benchmark evidence exists.',
    ...runtimeSummary(context),
    ...projectContext(context),
    ...guardrails(context),
  ])
}

function morningBriefPrompt(context: McpToolExecutionContext, arguments_: Record<string, string>): McpPromptGetResult {
  const root = canonicalRoot(context)
  const project = argument(arguments_, ['project', 'scope'], false, root)
  const window = argument(arguments_, ['window', 'timeframe', 'time_range'], false, root)
  const focus = argument(arguments_, ['focus', 'priorities'], false, root)
  const importedCount = context.importedContexts.size
  return promptResult('Read-only Elia morning briefing request', [
    'Prepare a morning brief from available evidence. This prompt does not create a run or change state.',
    ...optionalSection('Project', project === undefined ? undefined : projectLabel(context, project)),
    ...optionalSection('Window', window),
    ...optionalSection('Focus', focus),
    'Required response:',
    '- Lead with active goals, blocked or failed work, recent outcomes, and the next useful decision.',
    '- Cite the Elia resource or runtime evidence behind each material claim.',
    '- Keep missing evidence and stale information explicit; do not invent progress.',
    `- Imported context records available in this process: ${importedCount}.`,
    ...runtimeSummary(context),
    ...projectContext(context),
    ...runSummary(context),
    ...guardrails(context),
  ])
}

export function listEliaPrompts(_context: McpToolExecutionContext): readonly McpPromptDescriptor[] {
  return ELIA_PROMPTS
}

export function getEliaPrompt(
  name: string,
  arguments_: Record<string, string>,
  context: McpToolExecutionContext,
): McpPromptGetResult {
  switch (name) {
    case 'elia_task_prompt':
      return taskPrompt(context, arguments_)
    case 'elia_research_prompt':
      return researchPrompt(context, arguments_)
    case 'elia_audit_prompt':
      return auditPrompt(context, arguments_)
    case 'elia_evolve_prompt':
      return evolvePrompt(context, arguments_)
    case 'elia_morning_brief_prompt':
      return morningBriefPrompt(context, arguments_)
    default:
      throw new Error(`Unknown Elia prompt: ${name}`)
  }
}

export interface EliaPromptProvider {
  listPrompts(context: McpToolExecutionContext): readonly McpPromptDescriptor[]
  getPrompt(name: string, arguments_: Record<string, string>, context: McpToolExecutionContext): McpPromptGetResult
}

export function createPromptProvider(baseContext: McpToolExecutionContext): EliaPromptProvider {
  const context = (requestContext?: McpToolExecutionContext): McpToolExecutionContext => requestContext
    ? { ...baseContext, ...requestContext }
    : baseContext
  return {
    listPrompts: request => listEliaPrompts(context(request)),
    getPrompt: (name, arguments_, request) => getEliaPrompt(name, arguments_, context(request)),
  }
}

export const createPrompts = createPromptProvider
export const createMcpPrompts = createPromptProvider
export const createPromptHandlers = createPromptProvider
