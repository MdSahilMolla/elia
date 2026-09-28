/**
 * Notes a person sends while the work runs — and the plan change each carries.
 *
 * The session's thinking panel reads a mid-work message, works out what the
 * person wants, and decides how the plan should change. That decision travels
 * to the running work as a note: plain text the work can read, plus a
 * `<plan-change>` block the autonomous pipeline applies as plan revisions
 * (`revise-step`, `add-step`, `drop-step`) at its next safe point. A note
 * without a block still reaches every step that starts after it.
 *
 * The block names steps by id when the session knows them (an escalated run's
 * approved steps) and by title otherwise, so it also reads correctly to a
 * plain chat turn that keeps its plan in a todo list.
 */

import type { PlanRevision } from './replan.ts'
import type { TodoItem } from './todoList.ts'
import type { Proposal, ProposalStep } from './types.ts'

export interface NotePlanEdit {
  kind: 'change' | 'add' | 'remove'
  /** change / remove: the step, by id when known … */
  stepId?: string
  /** … and by title always. */
  stepTitle?: string
  /** change: what the step becomes. */
  to?: string
  /** add: the new step. */
  title?: string
  /** add: the step it goes after. */
  afterId?: string
  afterTitle?: string
}

export interface NotePlanChange {
  /** What the person wants, in a line. */
  wants?: string
  edits: NotePlanEdit[]
}

const OPEN = '<plan-change>'
const CLOSE = '</plan-change>'

export function describeEdit(edit: NotePlanEdit): string {
  if (edit.kind === 'change') return `change "${edit.stepTitle ?? edit.stepId}" → "${edit.to}"`
  if (edit.kind === 'add') return `add "${edit.title}"${edit.afterTitle || edit.afterId ? ` after "${edit.afterTitle ?? edit.afterId}"` : ''}`
  return `drop "${edit.stepTitle ?? edit.stepId}"`
}

/** The note as the work receives it: readable text, then the machine-readable change. */
export function encodeNote(text: string, change?: NotePlanChange): string {
  const body = text.trim()
  if (!change || change.edits.length === 0) return body
  const readable = `Change the plan accordingly (steps that have not started): ${change.edits.map(describeEdit).join('; ')}.`
  return `${body}\n\n${readable}\n${OPEN}${JSON.stringify(change)}${CLOSE}`
}

export function decodeNote(raw: string): { text: string; change?: NotePlanChange } {
  const start = raw.indexOf(OPEN)
  const end = raw.indexOf(CLOSE, start + OPEN.length)
  if (start === -1 || end === -1) return { text: raw.trim() }
  const text = `${raw.slice(0, start)}${raw.slice(end + CLOSE.length)}`.trim()
  try {
    const parsed = JSON.parse(raw.slice(start + OPEN.length, end)) as NotePlanChange
    const edits = Array.isArray(parsed?.edits) ? parsed.edits.filter((edit) => edit && (edit.kind === 'change' || edit.kind === 'add' || edit.kind === 'remove')) : []
    return { text, change: { wants: typeof parsed.wants === 'string' ? parsed.wants : undefined, edits } }
  } catch {
    return { text }
  }
}

/** The entry whose title is `title` — exactly, or as a prefix either way (titles get clipped). */
function byTitle<T>(entries: readonly T[], titleOf: (entry: T) => string, title?: string): T | undefined {
  if (!title) return undefined
  const wanted = title.trim().toLowerCase()
  return entries.find((entry) => titleOf(entry).trim().toLowerCase() === wanted) ?? entries.find((entry) => titleOf(entry).toLowerCase().startsWith(wanted) || wanted.startsWith(titleOf(entry).toLowerCase()))
}

function findStep(steps: readonly ProposalStep[], id?: string, title?: string): ProposalStep | undefined {
  if (id) {
    const byId = steps.find((step) => step.id === id)
    if (byId) return byId
  }
  return byTitle(steps, (step) => step.title, title)
}

/**
 * A note's plan change applied to a chat turn's todo list, by title. Finished
 * items are never changed or removed; an edit naming an item the list does not
 * have is skipped.
 */
export function applyEditsToTodos(items: readonly TodoItem[], edits: readonly NotePlanEdit[]): TodoItem[] {
  // Each item keeps the title it started with, so an edit can name a step by
  // either title — the panel describes an add "after" a step it renamed in the
  // same note by the new name.
  let next = items.map((item) => ({ item: { ...item }, was: item.content }))
  const find = (title?: string) => byTitle(next, (entry) => entry.item.content, title) ?? byTitle(next, (entry) => entry.was, title)
  for (const edit of edits) {
    if (edit.kind === 'add') {
      if (!edit.title?.trim()) continue
      const after = find(edit.afterTitle)
      const at = after ? next.indexOf(after) + 1 : next.length
      const title = edit.title.trim()
      next = [...next.slice(0, at), { item: { content: title, status: 'pending' }, was: title }, ...next.slice(at)]
      continue
    }
    const target = find(edit.stepTitle)
    if (!target || target.item.status === 'completed') continue
    if (edit.kind === 'change' && edit.to?.trim()) target.item.content = edit.to.trim()
    else if (edit.kind === 'remove') next = next.filter((entry) => entry !== target)
  }
  return withCurrentStep(next.map((entry) => entry.item), hasStarted(items))
}

/** Work has started on a plan once any step is under way or done. Judge it before an edit: removing the current step must not make the plan look untouched. */
export function hasStarted(items: ReadonlyArray<{ status: TodoItem['status'] }>): boolean {
  return items.some((item) => item.status !== 'pending')
}

/**
 * Once work has started on a plan, exactly one step is in progress: the first
 * one still open. A note that adds a step ahead of the current one, or removes
 * the current one, would otherwise leave the plan showing nothing under way —
 * every open step a bare □ while the work carries on.
 */
export function withCurrentStep<T extends { status: TodoItem['status'] }>(items: readonly T[], started = hasStarted(items)): T[] {
  if (!started) return [...items]
  const first = items.findIndex((item) => item.status !== 'completed')
  return items.map((item, index) => (item.status === 'completed' ? item : { ...item, status: index === first ? 'in_progress' : 'pending' }))
}

/**
 * Turns a batch of notes into plan revisions for `proposal`, plus the notes'
 * text for every step that starts from here. Edits that name a step the plan
 * does not have are dropped here and said so in `unmatched`.
 */
export function operatorRevisions(
  notes: readonly string[],
  proposal: Proposal,
): { revisions: PlanRevision[]; plain: string[]; unmatched: string[] } {
  const revisions: PlanRevision[] = []
  const plain: string[] = []
  const unmatched: string[] = []
  const taken = new Set(proposal.steps.map((step) => step.id))
  // A step renamed earlier in the same batch can be named by its new title.
  const renamed: ProposalStep[] = []
  const locate = (id?: string, title?: string) => findStep(proposal.steps, id, title) ?? byTitle(renamed, (step) => step.title, title)
  let added = 0
  for (const raw of notes) {
    const { text, change } = decodeNote(raw)
    if (text) plain.push(text)
    if (!change) continue
    const reason = `the person asked for it while the work ran${change.wants ? ` (${change.wants})` : ''}`
    for (const edit of change.edits) {
      if (edit.kind === 'add') {
        if (!edit.title?.trim()) continue
        const after = locate(edit.afterId, edit.afterTitle)
        let id = `note-${++added}`
        while (taken.has(id)) id = `note-${++added}`
        taken.add(id)
        revisions.push({
          kind: 'add-step',
          reason,
          step: {
            id,
            title: edit.title.trim(),
            role: after?.role ?? 'builder',
            instructions: `${edit.title.trim()}.\n\nThe person added this step while the work ran${change.wants ? `; they want ${change.wants}` : ''}. Fit it to the work already done.`,
            files: [],
            dependsOn: after ? [after.id] : [],
          },
        })
        continue
      }
      const target = locate(edit.stepId, edit.stepTitle)
      if (!target) {
        unmatched.push(describeEdit(edit))
        continue
      }
      if (edit.kind === 'change') {
        if (!edit.to?.trim()) continue
        revisions.push({ kind: 'revise-step', reason, stepId: target.id, title: edit.to.trim(), change: `${edit.to.trim()}${change.wants ? ` — the person wants ${change.wants}` : ''}` })
        renamed.push({ ...target, title: edit.to.trim() })
      } else {
        revisions.push({ kind: 'drop-step', reason, stepId: target.id })
      }
    }
  }
  return { revisions, plain, unmatched }
}

/** The notes as a section of a worker's instructions. */
export function notesSection(notes: readonly string[]): string {
  if (notes.length === 0) return ''
  return `\n\n## Notes from the person, sent while the work ran\n${notes.map((note) => `- ${note.replace(/\s+/g, ' ').trim()}`).join('\n')}\nHonour these where they bear on your assignment.`
}
