// A plan that cannot change is a plan that has to be right the first time.
//
// Until now elia froze the proposal at approval and could only ever repair
// *code* afterwards. When the plan itself was wrong — a step that has to happen
// first but was scheduled in parallel, a piece of work nobody thought of, a step
// that turned out to be impossible — execution had no way to say so. It worked
// around the plan, failed against it, or blocked. Every one of those was
// observed: three dependent steps placed in one parallel wave, a step ordered to
// write a file the policy protects, and a repair phase left to rebuild an entire
// goal because the plan's first step collapsed.
//
// So a worker that discovers the plan is wrong can now say which part and why,
// and the loop amends the plan between waves. Amendments are deliberately
// narrow: add a step, add a dependency, drop a step that has not run. Nothing
// here can rewrite what a step *does*, and nothing can touch work that already
// completed — a plan that could rewrite its own history could always claim
// success.
import type { Tool } from '../tools/types.ts'
import { isRoleName, type ProposalStep, type Proposal } from './types.ts'

export type PlanRevisionKind = 'add-step' | 'add-dependency' | 'drop-step'

export interface PlanRevision {
  kind: PlanRevisionKind
  /** Why the plan is wrong. Recorded verbatim in the journal and the receipt. */
  reason: string
  /** add-step: the work that was missing. */
  step?: ProposalStep
  /** add-dependency / drop-step: the step being changed. */
  stepId?: string
  /** add-dependency: the step that must finish first. */
  dependsOn?: string
}

export interface RevisionCapture {
  tool: Tool
  taken(): PlanRevision[]
}

export interface AppliedRevisions {
  proposal: Proposal
  /** Human-readable descriptions of what changed, for the terminal and the journal. */
  applied: string[]
  /** Revisions refused, each with the reason — always surfaced, never silently dropped. */
  rejected: string[]
}

/**
 * How many amendments one run may make. A plan that keeps rewriting itself is
 * not adapting, it is thrashing, and the budget makes the difference visible
 * rather than letting it run.
 */
export const MAX_PLAN_REVISIONS = 6

export function createPlanRevisionTool(): RevisionCapture {
  const collected: PlanRevision[] = []

  const tool: Tool = {
    name: 'revise_plan',
    description:
      'Report that the *plan* is wrong — not that your own work failed. Use this when you discover work nobody planned, a step that must finish before another one can start, or a step that cannot be done as written. Keep doing your own assignment either way; this only records the correction for the lead to apply between waves.',
    input_schema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['add-step', 'add-dependency', 'drop-step'],
          description: 'add-step: work the plan is missing. add-dependency: this step must wait for another. drop-step: this step should not be done at all.',
        },
        reason: { type: 'string', description: 'What you found that makes this necessary. Be concrete.' },
        step: {
          type: 'object',
          description: 'add-step only: the missing work, self-contained enough to hand to another worker.',
          properties: {
            id: { type: 'string', description: 'A new short id, not one already in the plan' },
            title: { type: 'string' },
            role: { type: 'string', description: 'builder, backend, frontend, tester, scribe, …' },
            instructions: { type: 'string', description: 'Everything the worker needs; it will not see this conversation' },
            files: { type: 'array', items: { type: 'string' }, description: 'Files this step will touch' },
            dependsOn: { type: 'array', items: { type: 'string' }, description: 'Ids of steps that must finish first' },
          },
          required: ['id', 'title', 'role', 'instructions'],
        },
        stepId: { type: 'string', description: 'add-dependency / drop-step: the step being changed' },
        dependsOn: { type: 'string', description: 'add-dependency: the id of the step that must finish first' },
      },
      required: ['kind', 'reason'],
    },
    async execute(input) {
      const revision = parseRevision(input)
      if (!revision) throw new Error('revise_plan needs a "kind", a concrete "reason", and the fields that kind requires.')
      collected.push(revision)
      return `Recorded a plan revision (${revision.kind}). Carry on with your own assignment; the lead applies it between waves.`
    },
  }

  return {
    tool,
    taken() {
      return collected.splice(0)
    },
  }
}

/**
 * Applies what survives validation, and says plainly what did not.
 *
 * `completed` is the set of step ids that have already finished. They are
 * immutable: a revision cannot drop them, and cannot add a dependency to them,
 * because a step that is already done cannot be made to wait for anything.
 */
export function applyPlanRevisions(proposal: Proposal, revisions: PlanRevision[], completed: ReadonlySet<string>): AppliedRevisions {
  const steps = proposal.steps.map((step) => ({ ...step, files: [...step.files], dependsOn: [...step.dependsOn] }))
  const applied: string[] = []
  const rejected: string[] = []
  const byId = () => new Map(steps.map((step) => [step.id, step]))

  for (const revision of revisions.slice(0, MAX_PLAN_REVISIONS)) {
    const index = byId()

    if (revision.kind === 'add-step') {
      const step = revision.step
      if (!step) {
        rejected.push('add-step without a step')
        continue
      }
      if (index.has(step.id)) {
        rejected.push(`add-step "${step.id}": a step with that id is already in the plan`)
        continue
      }
      const unknown = step.dependsOn.filter((id) => !index.has(id))
      if (unknown.length > 0) {
        rejected.push(`add-step "${step.id}": depends on step(s) that do not exist: ${unknown.join(', ')}`)
        continue
      }
      steps.push(step)
      applied.push(`added step "${step.id}" (${step.title}) — ${revision.reason}`)
      continue
    }

    if (revision.kind === 'add-dependency') {
      const target = revision.stepId ? index.get(revision.stepId) : undefined
      const prerequisite = revision.dependsOn ? index.get(revision.dependsOn) : undefined
      if (!target || !prerequisite) {
        rejected.push(`add-dependency ${revision.stepId} -> ${revision.dependsOn}: one of those steps does not exist`)
        continue
      }
      if (target.id === prerequisite.id) {
        rejected.push(`add-dependency "${target.id}": a step cannot depend on itself`)
        continue
      }
      if (completed.has(target.id)) {
        rejected.push(`add-dependency "${target.id}": that step has already completed and cannot be made to wait`)
        continue
      }
      if (target.dependsOn.includes(prerequisite.id)) {
        rejected.push(`add-dependency "${target.id}" -> "${prerequisite.id}": already declared`)
        continue
      }
      if (createsCycle(steps, target.id, prerequisite.id)) {
        rejected.push(`add-dependency "${target.id}" -> "${prerequisite.id}": would create a dependency cycle`)
        continue
      }
      target.dependsOn.push(prerequisite.id)
      applied.push(`"${target.id}" now waits for "${prerequisite.id}" — ${revision.reason}`)
      continue
    }

    const doomed = revision.stepId ? index.get(revision.stepId) : undefined
    if (!doomed) {
      rejected.push(`drop-step ${revision.stepId}: no such step`)
      continue
    }
    if (completed.has(doomed.id)) {
      rejected.push(`drop-step "${doomed.id}": that step has already completed; dropping it would rewrite what the run did`)
      continue
    }
    steps.splice(steps.indexOf(doomed), 1)
    // Dependents lose the requirement rather than becoming unsatisfiable.
    for (const step of steps) step.dependsOn = step.dependsOn.filter((id) => id !== doomed.id)
    applied.push(`dropped step "${doomed.id}" (${doomed.title}) — ${revision.reason}`)
  }

  if (revisions.length > MAX_PLAN_REVISIONS) {
    rejected.push(`${revisions.length - MAX_PLAN_REVISIONS} further revision(s) ignored: a plan may be amended at most ${MAX_PLAN_REVISIONS} times in one run`)
  }

  return { proposal: applied.length > 0 ? { ...proposal, steps } : proposal, applied, rejected }
}

/** Would making `from` depend on `to` close a loop? */
function createsCycle(steps: ProposalStep[], from: string, to: string): boolean {
  const dependencies = new Map(steps.map((step) => [step.id, step.dependsOn]))
  const seen = new Set<string>()
  const stack = [to]
  while (stack.length > 0) {
    const current = stack.pop()!
    if (current === from) return true
    if (seen.has(current)) continue
    seen.add(current)
    stack.push(...(dependencies.get(current) ?? []))
  }
  return false
}

function parseRevision(input: Record<string, unknown>): PlanRevision | undefined {
  const kind = input.kind
  const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
  if (!reason) return undefined
  if (kind !== 'add-step' && kind !== 'add-dependency' && kind !== 'drop-step') return undefined

  if (kind === 'add-step') {
    const raw = input.step
    if (typeof raw !== 'object' || raw === null) return undefined
    const candidate = raw as Record<string, unknown>
    const id = typeof candidate.id === 'string' ? candidate.id.trim() : ''
    const title = typeof candidate.title === 'string' ? candidate.title.trim() : ''
    const instructions = typeof candidate.instructions === 'string' ? candidate.instructions.trim() : ''
    if (!id || !title || !instructions) return undefined
    // An unrecognised role would fail at dispatch; a builder is the safe general worker.
    const role = isRoleName(candidate.role) ? candidate.role : 'builder'
    return {
      kind,
      reason,
      step: {
        id,
        title,
        role,
        instructions,
        files: Array.isArray(candidate.files) ? candidate.files.filter((file): file is string => typeof file === 'string') : [],
        dependsOn: Array.isArray(candidate.dependsOn) ? candidate.dependsOn.filter((dep): dep is string => typeof dep === 'string') : [],
      },
    }
  }

  const stepId = typeof input.stepId === 'string' ? input.stepId.trim() : ''
  if (!stepId) return undefined
  if (kind === 'drop-step') return { kind, reason, stepId }

  const dependsOn = typeof input.dependsOn === 'string' ? input.dependsOn.trim() : ''
  if (!dependsOn) return undefined
  return { kind, reason, stepId, dependsOn }
}
