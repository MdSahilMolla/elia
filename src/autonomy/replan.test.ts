import { expect, test } from 'bun:test'
import { applyPlanRevisions, createPlanRevisionTool, MAX_PLAN_REVISIONS, type PlanRevision } from './replan.ts'
import type { Proposal, ProposalStep } from './types.ts'

function step(id: string, dependsOn: string[] = [], files: string[] = []): ProposalStep {
  return { id, title: `Step ${id}`, role: 'builder', instructions: `do ${id}`, files, dependsOn }
}

const proposal: Proposal = {
  goal: 'ship it',
  understanding: '',
  assumptions: [],
  steps: [step('s1'), step('s2'), step('s3', ['s2'])],
  risks: [],
  verification: ['bun test'],
  outOfScope: [],
}

const none = new Set<string>()

test('a missing step is added, and lands where its dependencies put it', () => {
  const revision: PlanRevision = {
    kind: 'add-step',
    reason: 'the schema has to exist before the routes can query it',
    step: step('s4', ['s1'], ['src/schema.ts']),
  }

  const result = applyPlanRevisions(proposal, [revision], none)
  expect(result.applied).toHaveLength(1)
  expect(result.applied[0]).toContain('the schema has to exist')
  expect(result.proposal.steps.map((entry) => entry.id)).toEqual(['s1', 's2', 's3', 's4'])
  expect(result.proposal.steps.find((entry) => entry.id === 's4')?.dependsOn).toEqual(['s1'])
})

test('a dependency the planner forgot can be added between existing steps', () => {
  const result = applyPlanRevisions(
    proposal,
    [{ kind: 'add-dependency', reason: 's2 needs the manifest s1 writes', stepId: 's2', dependsOn: 's1' }],
    none,
  )

  expect(result.rejected).toEqual([])
  expect(result.proposal.steps.find((entry) => entry.id === 's2')?.dependsOn).toEqual(['s1'])
})

test('a step that is no longer needed can be dropped, and its dependents stop waiting for it', () => {
  const result = applyPlanRevisions(proposal, [{ kind: 'drop-step', reason: 'the library already does this', stepId: 's2' }], none)

  expect(result.proposal.steps.map((entry) => entry.id)).toEqual(['s1', 's3'])
  expect(result.proposal.steps.find((entry) => entry.id === 's3')?.dependsOn).toEqual([])
})

// --- what a revision may never do ---

test('work that already completed cannot be dropped — a plan that could rewrite its own history could always claim success', () => {
  const result = applyPlanRevisions(proposal, [{ kind: 'drop-step', reason: 'never mind', stepId: 's1' }], new Set(['s1']))

  expect(result.applied).toEqual([])
  expect(result.rejected[0]).toContain('already completed')
  expect(result.proposal.steps.map((entry) => entry.id)).toEqual(['s1', 's2', 's3'])
})

test('a completed step cannot be made to wait for something', () => {
  const result = applyPlanRevisions(
    proposal,
    [{ kind: 'add-dependency', reason: 'too late', stepId: 's1', dependsOn: 's2' }],
    new Set(['s1']),
  )

  expect(result.rejected[0]).toContain('cannot be made to wait')
})

test('a dependency that would close a loop is refused', () => {
  const result = applyPlanRevisions(
    proposal,
    // s3 already depends on s2, so s2 -> s3 would be a cycle.
    [{ kind: 'add-dependency', reason: 'circular', stepId: 's2', dependsOn: 's3' }],
    none,
  )

  expect(result.applied).toEqual([])
  expect(result.rejected[0]).toContain('cycle')
})

test('a new step cannot reuse an existing id, or depend on a step that does not exist', () => {
  const duplicate = applyPlanRevisions(proposal, [{ kind: 'add-step', reason: 'oops', step: step('s2') }], none)
  expect(duplicate.rejected[0]).toContain('already in the plan')

  const dangling = applyPlanRevisions(proposal, [{ kind: 'add-step', reason: 'oops', step: step('s9', ['nope']) }], none)
  expect(dangling.rejected[0]).toContain('do not exist')
})

test('a run may not rewrite its plan without limit', () => {
  const many: PlanRevision[] = Array.from({ length: MAX_PLAN_REVISIONS + 2 }, (_, index) => ({
    kind: 'add-step' as const,
    reason: 'more',
    step: step(`extra${index}`),
  }))

  const result = applyPlanRevisions(proposal, many, none)
  expect(result.applied).toHaveLength(MAX_PLAN_REVISIONS)
  expect(result.rejected.at(-1)).toContain('at most')
})

test('nothing changes when every revision is refused', () => {
  const result = applyPlanRevisions(proposal, [{ kind: 'drop-step', reason: 'x', stepId: 'ghost' }], none)
  expect(result.proposal).toBe(proposal)
})

// --- the tool ---

test('the tool collects revisions and hands them over once', async () => {
  const capture = createPlanRevisionTool()

  await capture.tool.execute({ kind: 'add-dependency', reason: 's2 needs s1 first', stepId: 's2', dependsOn: 's1' })
  await capture.tool.execute({ kind: 'add-step', reason: 'missing migration', step: { id: 's5', title: 'Migrate', role: 'backend', instructions: 'write it' } })

  const taken = capture.taken()
  expect(taken).toHaveLength(2)
  expect(taken[1]!.step?.files).toEqual([])
  // Drained, so the next wave starts clean.
  expect(capture.taken()).toEqual([])
})

test('the tool refuses a revision with no reason, or with the wrong fields for its kind', async () => {
  const capture = createPlanRevisionTool()

  await expect(capture.tool.execute({ kind: 'add-step', reason: '', step: step('s7') })).rejects.toThrow('concrete "reason"')
  await expect(capture.tool.execute({ kind: 'add-dependency', reason: 'why', stepId: 's2' })).rejects.toThrow()
  expect(capture.taken()).toEqual([])
})

test('an unrecognised role falls back to a general worker rather than failing at dispatch', async () => {
  const capture = createPlanRevisionTool()
  await capture.tool.execute({ kind: 'add-step', reason: 'needed', step: { id: 's8', title: 'X', role: 'wizard', instructions: 'do it' } })

  expect(capture.taken()[0]!.step?.role).toBe('builder')
})
