/**
 * `elia workspace watch` — a compact live view of the collaborative workspace,
 * rendered from the same event stream the server pushes to every client. Pure
 * `renderWorkspaceBoard` for testability; the CLI drives the redraw loop.
 */

import { box, table, terminalWidth } from './layout.ts'
import { bold, cyan, dim, gold, green, red } from './theme.ts'
import type { WorkspaceStatusResult } from '../workspace/protocol.ts'
import type { PersistedEvent } from '../workspace/events.ts'
import type { AgentRecord, TaskRecord, ObjectiveRecord } from '../workspace/types.ts'

export interface WorkspaceBoardState {
  status: WorkspaceStatusResult
  objectives: ObjectiveRecord[]
  tasks: TaskRecord[]
  agents: AgentRecord[]
  feed: PersistedEvent[]
}

const AGENT_COLOR: Record<string, (s: string) => string> = {
  idle: dim, working: green, planning: cyan, reviewing: cyan, assigned: cyan,
  waiting: gold, blocked: red, failed: red, 'needs-human': red, paused: gold, cancelled: dim, completed: green,
}

const TASK_ORDER: TaskRecord['status'][] = ['in-progress', 'assigned', 'in-review', 'changes-requested', 'ready', 'blocked', 'pending', 'failed', 'done', 'cancelled']

export function renderWorkspaceBoard(state: WorkspaceBoardState, plain = false): string[] {
  const width = Math.max(48, terminalWidth(100))
  const paint = plain ? { bold: (s: string) => s, dim: (s: string) => s, color: (_: string, s: string) => s } : {
    bold, dim, color: (status: string, s: string) => (AGENT_COLOR[status] ?? ((x: string) => x))(s),
  }
  const lines: string[] = []

  const ws = state.status.workspace
  lines.push(paint.bold(`  ${ws?.name ?? 'workspace'}`) + paint.dim(`   seq ${state.status.latestSeq}`))
  const online = state.status.presence.map((p) => `${p.name}${p.focus ? ` (${p.focus})` : ''}`).join(', ')
  lines.push(paint.dim(`  online: ${online || 'nobody'}`))
  if (state.status.pendingApprovals > 0) lines.push(plain ? `  ! ${state.status.pendingApprovals} pending approval(s)` : red(`  ! ${state.status.pendingApprovals} pending approval(s)`))
  lines.push('')

  // Agents
  if (state.agents.length) {
    lines.push(paint.bold('  agents'))
    for (const line of table(
      [{ header: 'name' }, { header: 'role' }, { header: 'status' }, { header: 'task' }],
      state.agents.map((a) => {
        const task = a.currentTaskId ? state.tasks.find((t) => t.id === a.currentTaskId) : undefined
        return [a.name, a.role, paint.color(a.status, a.status), task?.title ?? '']
      }),
    )) lines.push(`  ${line}`)
    lines.push('')
  }

  // Tasks per active objective
  for (const objective of state.objectives.filter((o) => o.status === 'active' || o.status === 'blocked')) {
    const tasks = state.tasks.filter((t) => t.objectiveId === objective.id)
    if (!tasks.length) continue
    lines.push(paint.bold(`  ${objective.goal.slice(0, width - 6)}`))
    const byStatus = new Map<string, TaskRecord[]>()
    for (const task of tasks) byStatus.set(task.status, [...(byStatus.get(task.status) ?? []), task])
    for (const status of TASK_ORDER) {
      const group = byStatus.get(status)
      if (!group?.length) continue
      const label = `${status.padEnd(18)}`
      const titles = group.map((t) => `${t.title}${t.assigneeId ? paint.dim(` ·${shortId(t.assigneeId)}`) : ''}`).join(', ')
      lines.push(`    ${paint.dim(label)} ${titles.slice(0, width - 26)}`)
    }
    lines.push('')
  }

  // Recent activity (deduped, in sequence order)
  lines.push(paint.bold('  recent'))
  const seen = new Set<number>()
  const ordered = state.feed.filter((e) => !seen.has(e.seq) && seen.add(e.seq)).sort((a, b) => a.seq - b.seq)
  for (const event of ordered.slice(-9)) {
    lines.push(`    ${paint.dim(event.at.slice(11, 19))} ${event.type.padEnd(20)} ${paint.dim(summarise(event).slice(0, width - 36))}`)
  }

  return box(lines, { title: 'workspace' }).split('\n')
}

function shortId(id: string): string {
  return id.replace(/^[a-z]+_/, '').slice(0, 6)
}

function summarise(event: PersistedEvent): string {
  const p = event.payload
  if (event.type === 'AgentMessageCreated') return `[${String(p.kind)}] ${String(p.body)}`
  if (event.type === 'TaskCreated') return `${String(p.title)} (${String(p.role)})`
  if (event.type === 'TaskAssigned') return `-> ${shortId(String(p.assigneeId))}`
  if (event.type === 'DecisionRecorded') return `"${String(p.title)}"`
  if (event.type === 'ConflictDetected') return String(p.detail ?? p.resource)
  if (event.type === 'ReviewCompleted') return p.passed ? 'approved' : 'changes requested'
  if (event.type.startsWith('Task') && p.status) return `-> ${String(p.status)}`
  if (event.type === 'ApprovalRequired') return `${String(p.kind)}: ${String(p.reason ?? '').slice(0, 60)}`
  return `${event.actorId}`
}
