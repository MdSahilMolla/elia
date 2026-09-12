/**
 * Scoped project context for an agent about to run a task.
 *
 * The point is *not* to hand every agent the whole workspace. An agent gets:
 * the objective's goal and acceptance contract, its own task, the final reports
 * of the dependencies it actually builds on, the decisions already made, the
 * files it currently holds a reservation on, and the messages addressed to it or
 * broadcast on its objective. Nothing else.
 */

import type { WorkspaceStore } from './store.ts'
import type { AgentMessageRecord, DecisionRecord, TaskRecord } from './types.ts'

export interface ContextPack {
  /** `build` = do the work; `review` = adversarially check work already done. */
  mode: 'build' | 'review'
  objectiveGoal: string
  acceptanceCriteria: string[]
  verificationCommands: string[]
  task: {
    id: string
    title: string
    role: string
    instructions: string
    files: string[]
    reviewNotes?: string
    /** On a review job: the report the completing agent gave. */
    workReport?: string
  }
  dependencyReports: { taskId: string; title: string; report: string }[]
  decisions: { title: string; detail: string }[]
  reservations: string[]
  messages: { from: string; kind: string; topic: string; body: string }[]
  /** Ready-to-inject prompt block. */
  briefing: string
}

export function buildContextPack(store: WorkspaceStore, taskId: string, agentId?: string): ContextPack {
  const task = store.task(taskId)
  if (!task) throw new Error(`unknown task ${taskId}`)
  const objective = store.objective(task.objectiveId)
  if (!objective) throw new Error(`task ${taskId} has no objective`)

  const dependencyReports = task.dependsOn
    .map((depId) => store.task(depId))
    .filter((dep): dep is TaskRecord => Boolean(dep) && Boolean(dep!.resultReport))
    .map((dep) => ({ taskId: dep.id, title: dep.title, report: dep.resultReport!.slice(0, 4_000) }))

  const decisions: DecisionRecord[] = store.decisions(task.objectiveId)
  const reservations = store.reservations(true, { taskId }).map((r) => r.resource)

  const relevant = (message: AgentMessageRecord): boolean => {
    if (message.fromId === agentId) return false
    if (message.toId && message.toId !== agentId) return false
    return message.topic === `task:${taskId}` || !message.toId || message.toId === agentId
  }
  const messages = store.messages({ objectiveId: task.objectiveId, limit: 60 })
    .filter(relevant)
    .slice(-12)
    .map((message) => ({ from: message.fromId, kind: message.kind, topic: message.topic, body: message.body.slice(0, 800) }))

  const mode: ContextPack['mode'] = task.status === 'in-review' ? 'review' : 'build'
  const pack: ContextPack = {
    mode,
    objectiveGoal: objective.goal,
    acceptanceCriteria: task.acceptanceCriteria,
    verificationCommands: task.verificationCommands,
    task: {
      id: task.id, title: task.title, role: task.role, instructions: task.instructions,
      files: task.files, reviewNotes: task.reviewNotes,
      workReport: mode === 'review' ? task.resultReport ?? task.reviewNotes : undefined,
    },
    dependencyReports,
    decisions: decisions.map((d) => ({ title: d.title, detail: d.detail })),
    reservations,
    messages,
    briefing: '',
  }
  pack.briefing = renderBriefing(pack)
  return pack
}

function renderBriefing(pack: ContextPack): string {
  const lines: string[] = [`# Shared objective\n${pack.objectiveGoal}`]

  if (pack.mode === 'review') {
    lines.push(
      `\n## You are reviewing work already done`,
      `The task "${pack.task.title}" was completed by another agent. Read the diff for the files it owns` +
        ` (${pack.task.files.join(', ') || 'the working tree'}), verify its report against what the code actually does,` +
        ` and check it against the acceptance criteria${pack.acceptanceCriteria.length ? ` (${pack.acceptanceCriteria.join('; ')})` : ''}.`,
      pack.task.workReport ? `\n### The completing agent's report\n${pack.task.workReport}` : '',
      `\nFinish by reporting a verdict: state clearly whether the work is APPROVED or needs REVISION, and for revision list every concrete change required.`,
    )
  }

  if (pack.decisions.length) {
    lines.push(`\n## Decisions already made (do not relitigate)\n${pack.decisions.map((d) => `- ${d.title}: ${d.detail}`).join('\n')}`)
  }
  if (pack.dependencyReports.length) {
    lines.push(`\n## What the tasks you depend on produced\n${pack.dependencyReports.map((d) => `### ${d.title}\n${d.report}`).join('\n\n')}`)
  }
  if (pack.messages.length) {
    lines.push(`\n## Messages for you\n${pack.messages.map((m) => `- [${m.kind}] ${m.from} on "${m.topic}": ${m.body}`).join('\n')}`)
  }
  if (pack.reservations.length) {
    lines.push(`\n## Files reserved for you\nYou hold an exclusive lock on: ${pack.reservations.join(', ')}. Stay inside these — other agents are working in parallel on the rest of the tree.`)
  }
  if (pack.task.reviewNotes) {
    lines.push(`\n## A reviewer asked for changes\n${pack.task.reviewNotes}\nAddress every point before reporting completion.`)
  }
  if (pack.task.files.length) {
    lines.push(`\n## Your task owns these files\n${pack.task.files.map((f) => `- ${f}`).join('\n')}`)
  }
  return lines.join('\n')
}
