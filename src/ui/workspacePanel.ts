import { activeTodoList } from '../autonomy/todoList.ts'
import { listArtifacts } from '../autonomy/artifactReader.ts'
import { listKnownSessions } from '../sessionRegistry.ts'
import { taskSessions } from '../taskSessions.ts'
import type { AgentMode } from '../agent.ts'
import { dim, cyan, gold } from './theme.ts'
import { frame, terminalWidth, visibleWidth } from './layout.ts'

export interface WorkspacePanelInput {
  sessionId: string
  mode: AgentMode
  providerLabel: string
  model: string
}

/**
 * `/status` for the Ink REPL: the same facts as the panel below, as plain
 * aligned rows. The panel's two drawn frames broke apart inside Ink — its
 * colour codes counted as width, so on a narrow terminal the borders wrapped.
 */
export function renderWorkspaceStatus(input: WorkspacePanelInput): string {
  const otherSessions = listKnownSessions().filter((session) => session.sessionId !== input.sessionId)
  const todo = activeTodoList()
  const planText = todo.render()
  const steps = planText === '(todo list is empty)' ? [] : planText.split('\n').filter((line) => line.trim())
  const agents = taskSessions.list().filter((task) => task.role && task.role !== 'lead')
  const running = agents.filter((task) => task.status === 'running' || task.status === 'pending')
  const artifacts = listArtifacts()
  const row = (label: string, value: string) => `${label.padEnd(10)}${value}`
  return [
    `elia · ${input.mode}`,
    row('model', `${input.providerLabel} · ${input.model}`),
    row('session', `${input.sessionId}${otherSessions.length > 0 ? ` · ${otherSessions.length} other session${otherSessions.length === 1 ? '' : 's'} (/sessions)` : ''}`),
    row('plan', steps.length > 0 ? `${steps.length} step${steps.length === 1 ? '' : 's'}` : 'none yet — shift+tab switches to plan mode'),
    ...steps.slice(0, 5).map((line) => `${' '.repeat(10)}${line.trim()}`),
    row('workers', agents.length === 0 ? 'none this session' : `${running.length} running · ${agents.length} this session`),
    row('artifacts', artifacts.length === 0 ? 'none saved' : artifacts.slice(0, 3).map((artifact) => artifact.name).join(', ') + (artifacts.length > 3 ? ` · ${artifacts.length - 3} more` : '')),
  ].join('\n')
}

/** Renders the normal readline workspace as a bounded two-column snapshot. */
export function renderWorkspacePanel(input: WorkspacePanelInput): string {
  const width = terminalWidth(96)
  const innerBudget = Math.max(20, width - 11)
  const rightWidth = Math.max(14, Math.floor(innerBudget * 0.36))
  const leftWidth = Math.max(14, innerBudget - rightWidth)
  const left = frame(leftWidth, { title: `elia · ${input.mode}`, borderColor: gold })
  const right = frame(rightWidth, { title: 'Workspace', borderColor: cyan })

  const otherSessions = listKnownSessions().filter((session) => session.sessionId !== input.sessionId)
  const plan = activeTodoList().render()
  const planLines = plan === '(todo list is empty)' ? ['No working plan yet · /plan <goal>'] : plan.split('\n').slice(0, 3)
  const agents = taskSessions.list().filter((task) => task.role && task.role !== 'lead').slice(0, 3)
  const artifacts = listArtifacts().slice(0, 3)

  const leftLines = [
    `${dim('provider')}  ${input.providerLabel}`,
    `${dim('model')}     ${input.model}`,
    `${dim('session')}   ${input.sessionId}`,
    `${dim('chat')}      active · ${otherSessions.length} other session${otherSessions.length === 1 ? '' : 's'}`,
    '',
    dim('Type a prompt, / for commands, or exit to quit.'),
  ].map((line) => truncate(line, leftWidth))

  const rightLines = [
    cyan('CHATS'),
    `> ${truncate(input.sessionId, rightWidth - 4)} · active`,
    otherSessions.length > 0 ? `  ${otherSessions.length} other session${otherSessions.length === 1 ? '' : 's'} · /sessions` : '  No other chats yet',
    '',
    cyan('PLAN'),
    ...planLines.map((line) => `  ${line}`),
    '',
    cyan('SUBAGENTS'),
    ...(agents.length > 0 ? agents.map((task) => {
      const route = task.providerName && task.model ? ` · ${task.providerName}/${task.model}` : ''
      const wave = task.wave ? ` · wave ${task.wave}` : ''
      return `  ${task.status} · ${task.role}${route}${wave}: ${task.title}`
    }) : ['  No subagents yet']),
    '',
    cyan('ARTIFACTS'),
    ...(artifacts.length > 0 ? artifacts.map((artifact) => `  ${artifact.name}`) : ['  No saved plan artifacts']),
  ].map((line) => truncate(line, rightWidth))

  const height = Math.max(leftLines.length, rightLines.length)
  const output = [left.top, right.top]
  for (let index = 0; index < height; index += 1) {
    output.push(left.line(leftLines[index] ?? ''), right.line(rightLines[index] ?? ''))
  }
  output.push(left.bottom, right.bottom)

  const rows: string[] = []
  for (let index = 0; index < output.length; index += 2) rows.push(`${output[index] ?? ''}   ${output[index + 1] ?? ''}`)
  return rows.join('\n')
}

function truncate(text: string, max: number): string {
  return visibleWidth(text) > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text
}
