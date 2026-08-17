import { expect, test } from 'bun:test'

process.env.ANTHROPIC_API_KEY ??= 'test-key-for-proposal-test'

const { parseProposal, renderProposal } = await import('./proposal.ts')

const minimal = {
  goal: 'make the thing work',
  understanding: 'src/thing.ts owns it',
  steps: [{ title: 'fix it', instructions: 'edit src/thing.ts' }],
  verification: ['bun test'],
}

function expectOk(raw: unknown) {
  const parsed = parseProposal(raw)
  if ('error' in parsed) throw new Error(`expected a valid proposal, got: ${parsed.error}`)
  return parsed.proposal
}

function expectError(raw: unknown): string {
  const parsed = parseProposal(raw)
  if (!('error' in parsed)) throw new Error('expected a rejection, got a valid proposal')
  return parsed.error
}

test('a minimal proposal parses and gets generated step ids', () => {
  const proposal = expectOk(minimal)

  expect(proposal.steps[0]!.id).toBe('s1')
  expect(proposal.steps[0]!.role).toBe('builder')
  expect(proposal.steps[0]!.dependsOn).toEqual([])
  expect(proposal.steps[0]!.files).toEqual([])
})

test('an unrecognised role falls back to builder rather than failing the plan', () => {
  const proposal = expectOk({ ...minimal, steps: [{ ...minimal.steps[0], role: 'wizard' }] })

  expect(proposal.steps[0]!.role).toBe('builder')
})

test('a valid role is preserved', () => {
  const proposal = expectOk({ ...minimal, steps: [{ ...minimal.steps[0], role: 'scout' }] })

  expect(proposal.steps[0]!.role).toBe('scout')
})

test('a proposal with no steps is rejected', () => {
  expect(expectError({ ...minimal, steps: [] })).toContain('at least one step')
})

test('a missing goal is rejected', () => {
  expect(expectError({ ...minimal, goal: '   ' })).toContain('goal is required')
})

test('a step without instructions is rejected, naming its index', () => {
  const error = expectError({ ...minimal, steps: [{ title: 'no body' }] })

  expect(error).toContain('steps[0].instructions')
})

test('duplicate step ids are rejected', () => {
  const error = expectError({
    ...minimal,
    steps: [
      { id: 's1', title: 'a', instructions: 'a' },
      { id: 's1', title: 'b', instructions: 'b' },
    ],
  })

  expect(error).toContain('unique')
})

test('a dependency on a step that does not exist is rejected, not silently dropped', () => {
  // Silently dropping it would parallelise work the model deliberately ordered.
  const error = expectError({
    ...minimal,
    steps: [{ id: 's1', title: 'a', instructions: 'a', dependsOn: ['s9'] }],
  })

  expect(error).toContain('unknown step "s9"')
})

test('a dependency cycle is rejected', () => {
  const error = expectError({
    ...minimal,
    steps: [
      { id: 'a', title: 'a', instructions: 'a', dependsOn: ['b'] },
      { id: 'b', title: 'b', instructions: 'b', dependsOn: ['a'] },
    ],
  })

  expect(error).toContain('cycle')
})

test('non-string entries in the string lists are dropped', () => {
  const proposal = expectOk({ ...minimal, risks: ['real risk', 42, null, '  '], assumptions: 'not an array' })

  expect(proposal.risks).toEqual(['real risk'])
  expect(proposal.assumptions).toEqual([])
})

test('a non-object proposal is rejected rather than throwing', () => {
  expect(expectError('just a string')).toContain('must be an object')
  expect(expectError(null)).toContain('must be an object')
})

test('the rendered proposal shows the wave structure it implies', () => {
  const proposal = expectOk({
    ...minimal,
    steps: [
      { id: 'a', title: 'first', instructions: 'x' },
      { id: 'b', title: 'second', instructions: 'y' },
      { id: 'c', title: 'third', instructions: 'z', dependsOn: ['a', 'b'] },
    ],
  })

  const rendered = renderProposal(proposal)

  expect(rendered).toContain('3 workers in 2 waves')
  expect(rendered).toContain('2 in parallel')
  expect(rendered).toContain('bun test')
})

test('the rendered proposal flags two steps in one wave claiming the same file', () => {
  const proposal = expectOk({
    ...minimal,
    steps: [
      { id: 'a', title: 'first', instructions: 'x', files: ['src/same.ts'] },
      { id: 'b', title: 'second', instructions: 'y', files: ['src/same.ts'] },
    ],
  })

  expect(renderProposal(proposal)).toContain('is claimed by a and b in the same wave')
})
