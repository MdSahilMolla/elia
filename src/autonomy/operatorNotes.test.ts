import { expect, test } from 'bun:test'
import { applyEditsToTodos, decodeNote, encodeNote, notesSection, operatorRevisions, withCurrentStep } from './operatorNotes.ts'
import { applyPlanRevisions } from './replan.ts'
import type { Proposal, ProposalStep } from './types.ts'

function step(id: string, title: string, dependsOn: string[] = []): ProposalStep {
  return { id, title, role: 'builder', instructions: `do ${id}`, files: [], dependsOn }
}

const proposal: Proposal = {
  goal: 'build the shop',
  understanding: '',
  assumptions: [],
  steps: [step('schema', 'Design the schema'), step('api', 'Build the API', ['schema']), step('ui', 'Build the page', ['api'])],
  risks: [],
  verification: ['bun test'],
  outOfScope: [],
}

test('a note carries readable text and a plan change the pipeline can read back', () => {
  const raw = encodeNote("The person's note: make it realistic", {
    wants: 'real data',
    edits: [{ kind: 'change', stepId: 'api', stepTitle: 'Build the API', to: 'Build the API on Postgres' }],
  })
  expect(raw).toContain('Change the plan accordingly (steps that have not started): change "Build the API" → "Build the API on Postgres".')
  const decoded = decodeNote(raw)
  expect(decoded.text).toContain("The person's note: make it realistic")
  expect(decoded.text).not.toContain('<plan-change>')
  expect(decoded.change).toEqual({ wants: 'real data', edits: [{ kind: 'change', stepId: 'api', stepTitle: 'Build the API', to: 'Build the API on Postgres' }] })
  // No change: the note is just its text.
  expect(encodeNote('  also add tests ')).toBe('also add tests')
  expect(decodeNote('also add tests')).toEqual({ text: 'also add tests' })
  // A broken block never throws; the text still gets through.
  expect(decodeNote('hi <plan-change>{nope</plan-change>')).toEqual({ text: 'hi' })
})

test('notes become plan revisions — by id, by title, and an added step goes after the one named', () => {
  const notes = [
    encodeNote('note one', { wants: 'real data', edits: [
      { kind: 'change', stepId: 'api', stepTitle: 'Build the API', to: 'Build the API on Postgres' },
      { kind: 'add', title: 'Seed realistic rows', afterId: 'schema', afterTitle: 'Design the schema' },
    ] }),
    // A chat-turn note names steps by title only.
    encodeNote('note two', { edits: [{ kind: 'remove', stepTitle: 'build the page' }, { kind: 'remove', stepTitle: 'Write the docs' }] }),
    'a plain note',
  ]
  const { revisions, plain, unmatched } = operatorRevisions(notes, proposal)
  expect(plain).toEqual([expect.stringContaining('note one'), expect.stringContaining('note two'), 'a plain note'])
  expect(unmatched).toEqual(['drop "Write the docs"'])
  expect(revisions.map((revision) => revision.kind)).toEqual(['revise-step', 'add-step', 'drop-step'])
  const added = revisions[1]!.step!
  expect(added).toMatchObject({ id: 'note-1', title: 'Seed realistic rows', dependsOn: ['schema'], role: 'builder' })

  const result = applyPlanRevisions(proposal, revisions, new Set(['schema']), revisions.length)
  expect(result.rejected).toEqual([])
  expect(result.proposal.steps.map((entry) => `${entry.id}:${entry.title}`)).toEqual(['schema:Design the schema', 'api:Build the API on Postgres', 'note-1:Seed realistic rows'])
  expect(result.proposal.steps.find((entry) => entry.id === 'api')!.instructions).toContain('the person wants real data')
})

test('a title-only note can add a step after one it renamed in the same breath', () => {
  const { revisions } = operatorRevisions([encodeNote('x', { edits: [
    { kind: 'change', stepTitle: 'Build the API', to: 'Build the API on Postgres' },
    { kind: 'add', title: 'Load realistic rows', afterTitle: 'Build the API on Postgres' },
  ] })], proposal)
  expect(revisions[1]!.step!.dependsOn).toEqual(['api'])
})

test('an added step never takes an id the plan already uses', () => {
  const taken: Proposal = { ...proposal, steps: [...proposal.steps, step('note-1', 'Earlier note step')] }
  const { revisions } = operatorRevisions([encodeNote('x', { edits: [{ kind: 'add', title: 'Another' }] })], taken)
  expect(revisions[0]!.step!.id).toBe('note-2')
  expect(revisions[0]!.step!.dependsOn).toEqual([])
})

test('every step that starts after a note is told about it', () => {
  expect(notesSection([])).toBe('')
  const section = notesSection(['use postgres\n  not sqlite'])
  expect(section).toContain('## Notes from the person, sent while the work ran')
  expect(section).toContain('- use postgres not sqlite')
})

test('a chat turn applies the change to its own todo list, by title, and never touches finished items', () => {
  const items = [
    { content: 'Inspect the repository', status: 'completed' as const },
    { content: 'Write node:test tests for the notes functions.', status: 'in_progress' as const },
    { content: 'Update the README', status: 'pending' as const },
  ]
  const next = applyEditsToTodos(items, [
    { kind: 'change', stepTitle: 'Write node:test tests for the notes functions.', to: 'Write node:test tests with realistic sample notes' },
    { kind: 'add', title: 'Test that remove() works', afterTitle: 'Write node:test tests for the notes functions.' },
    { kind: 'remove', stepTitle: 'Inspect the repository' },
    { kind: 'remove', stepTitle: 'No such step' },
  ])
  expect(next).toEqual([
    { content: 'Inspect the repository', status: 'completed' },
    { content: 'Write node:test tests with realistic sample notes', status: 'in_progress' },
    { content: 'Test that remove() works', status: 'pending' },
    { content: 'Update the README', status: 'pending' },
  ])
  // The input is untouched.
  expect(items[1]!.content).toBe('Write node:test tests for the notes functions.')
})

test('once work has started, a note never leaves the plan with nothing under way', () => {
  // A step added ahead of the current one becomes the current one.
  expect(applyEditsToTodos(
    [{ content: 'Build', status: 'completed' }, { content: 'Preview', status: 'in_progress' }],
    [{ kind: 'add', title: 'Add the demo', afterTitle: 'Build' }],
  ).map((item) => item.status)).toEqual(['completed', 'in_progress', 'pending'])
  // Removing the current step hands "in progress" to the next open one.
  expect(applyEditsToTodos(
    [{ content: 'Build', status: 'in_progress' }, { content: 'Test', status: 'pending' }],
    [{ kind: 'remove', stepTitle: 'Build' }],
  )).toEqual([{ content: 'Test', status: 'in_progress' }])
  // A plan nobody has started stays untouched.
  expect(withCurrentStep([{ content: 'a', status: 'pending' }, { content: 'b', status: 'pending' }]).map((item) => item.status)).toEqual(['pending', 'pending'])
})
