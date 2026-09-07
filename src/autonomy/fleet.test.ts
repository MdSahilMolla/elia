import { expect, test } from 'bun:test'
import { buildWorkerContract } from './fleet.ts'
import type { ProposalStep } from './types.ts'

// fleet.ts reaches config.ts through the sub-agent runner, which resolves a
// provider at import time — a placeholder key lets the module load. Nothing here
// makes a network call; only the pure planning functions are exercised.
process.env.ANTHROPIC_API_KEY ??= 'test-key-for-fleet-test'

const { planWaves, fileCollisions, fleetConcurrency } = await import('./fleet.ts')

function step(id: string, dependsOn: string[] = [], files: string[] = [], role: ProposalStep['role'] = 'builder'): ProposalStep {
  return { id, title: `step ${id}`, role, instructions: 'do it', files, dependsOn }
}

test('independent steps all land in one wave so they run in parallel', () => {
  const { waves, unreachable } = planWaves([step('a'), step('b'), step('c')])

  expect(unreachable).toEqual([])
  expect(waves.length).toBe(1)
  expect(waves[0]!.map((s) => s.id).sort()).toEqual(['a', 'b', 'c'])
})

test('a dependency chain becomes one wave per link', () => {
  const { waves } = planWaves([step('c', ['b']), step('a'), step('b', ['a'])])

  expect(waves.map((wave) => wave.map((s) => s.id))).toEqual([['a'], ['b'], ['c']])
})

test('steps sharing a dependency run together once it is satisfied', () => {
  const { waves } = planWaves([step('a'), step('b', ['a']), step('c', ['a'])])

  expect(waves.length).toBe(2)
  expect(waves[1]!.map((s) => s.id).sort()).toEqual(['b', 'c'])
})

test('a dependency cycle is reported as unreachable instead of hanging', () => {
  const { waves, unreachable } = planWaves([step('a', ['b']), step('b', ['a'])])

  expect(waves).toEqual([])
  expect(unreachable.map((s) => s.id).sort()).toEqual(['a', 'b'])
})

test('a step downstream of a cycle is unreachable too, and the rest still plan', () => {
  const { waves, unreachable } = planWaves([step('ok'), step('a', ['b']), step('b', ['a']), step('c', ['a'])])

  expect(waves).toEqual([[expect.objectContaining({ id: 'ok' })]])
  expect(unreachable.map((s) => s.id).sort()).toEqual(['a', 'b', 'c'])
})

test('a dependency on a step that does not exist is ignored rather than blocking forever', () => {
  const { waves, unreachable } = planWaves([step('a', ['ghost'])])

  expect(unreachable).toEqual([])
  expect(waves[0]!.map((s) => s.id)).toEqual(['a'])
})

test('fileCollisions finds two steps in one wave claiming the same file', () => {
  const collisions = fileCollisions([
    step('a', [], ['src/one.ts', 'src/two.ts']),
    step('b', [], ['src/two.ts']),
    step('c', [], ['src/three.ts']),
  ])

  expect(collisions).toEqual([{ file: 'src/two.ts', steps: ['a', 'b'] }])
})

test('fileCollisions normalizes separators so the same file is not missed', () => {
  const collisions = fileCollisions([step('a', [], ['src\\one.ts']), step('b', [], ['src/one.ts'])])

  expect(collisions).toEqual([{ file: 'src/one.ts', steps: ['a', 'b'] }])
})

test('fileCollisions normalizes relative path variants', () => {
  const collisions = fileCollisions([step('a', [], ['./src/one.ts']), step('b', [], ['src/dir/../one.ts'])])

  expect(collisions).toEqual([{ file: 'src/one.ts', steps: ['a', 'b'] }])
})

test('disjoint files in one wave are not a collision', () => {
  expect(fileCollisions([step('a', [], ['x.ts']), step('b', [], ['y.ts'])])).toEqual([])
})

test('an unscoped writer is serialized against a scoped writer to avoid unknown file races', () => {
  const { waves } = planWaves([step('a', [], ['src/a.ts']), step('b')])
  expect(waves.map((wave) => wave.map((item) => item.id))).toEqual([['a'], ['b']])
})

test('read-only unscoped steps remain parallel', () => {
  const { waves } = planWaves([step('a', [], [], 'scout'), step('b', [], [], 'scout')])
  expect(waves.map((wave) => wave.map((item) => item.id))).toEqual([['a', 'b']])
})

test('dependency-ready steps that claim the same file are serialized', () => {
  const { waves } = planWaves([
    step('a', [], ['src/same.ts']),
    step('b', [], ['src/same.ts']),
    step('c', [], ['src/other.ts']),
  ])

  expect(waves.map((wave) => wave.map((item) => item.id))).toEqual([['a', 'c'], ['b']])
  expect(waves.every((wave) => fileCollisions(wave).length === 0)).toBe(true)
})

test('fleetConcurrency matches the old fixed default when everyone shares one provider', () => {
  expect(fleetConcurrency(['anthropic', 'anthropic', 'anthropic'])).toBe(4)
})

test('fleetConcurrency does not mistake two models on one provider for separate rate limits', () => {
  expect(fleetConcurrency(['anthropic', 'anthropic'])).toBe(4)
})

test('fleetConcurrency widens per distinct provider so one rate limit does not throttle the whole fleet', () => {
  expect(fleetConcurrency(['groq', 'anthropic'])).toBe(8)
  expect(fleetConcurrency(['groq', 'anthropic', 'openai'])).toBe(12)
})

test('fleetConcurrency is capped even with many distinct providers', () => {
  const labels = Array.from({ length: 10 }, (_, i) => `provider-${i}`)
  expect(fleetConcurrency(labels)).toBe(16)
})

test('fleetConcurrency defaults to 4 for an empty batch rather than dividing by zero', () => {
  expect(fleetConcurrency([])).toBe(4)
})

test('the manifest is written before the source that depends on it, even when the planner declared no dependency', () => {
  // Observed live: a planner put "initialize package.json", "create source" and
  // "add tests" in one parallel wave with no dependsOn between them, so source
  // and tests were written alongside the very install they needed.
  const steps: ProposalStep[] = [
    { id: 's1', title: 'Initialize package.json', role: 'builder', instructions: '', files: ['package.json'], dependsOn: [] },
    { id: 's2', title: 'Create source', role: 'builder', instructions: '', files: ['src/server.ts', 'src/db.ts'], dependsOn: [] },
    { id: 's3', title: 'Add tests', role: 'tester', instructions: '', files: ['tests/api.test.ts'], dependsOn: [] },
  ]

  const { waves } = planWaves(steps)
  const manifestWave = waves.findIndex((wave) => wave.some((step) => step.id === 's1'))
  const sourceWave = waves.findIndex((wave) => wave.some((step) => step.id === 's2'))
  const testWave = waves.findIndex((wave) => wave.some((step) => step.id === 's3'))

  expect(manifestWave).toBeLessThan(sourceWave)
  expect(manifestWave).toBeLessThan(testWave)
})

test('steps that touch no manifest still run in parallel', () => {
  const steps: ProposalStep[] = [
    { id: 'a', title: 'Frontend', role: 'frontend', instructions: '', files: ['src/App.tsx'], dependsOn: [] },
    { id: 'b', title: 'Backend', role: 'backend', instructions: '', files: ['src/api.ts'], dependsOn: [] },
  ]

  expect(planWaves(steps).waves).toHaveLength(1)
})

test('tests are scheduled after the code they test, even when the planner declared no dependency', () => {
  const steps: ProposalStep[] = [
    { id: 's1', title: 'Source', role: 'backend', instructions: '', files: ['src/server.ts'], dependsOn: [] },
    { id: 's2', title: 'Tests', role: 'tester', instructions: '', files: ['tests/api.test.ts'], dependsOn: [] },
  ]

  const { waves } = planWaves(steps)
  const sourceWave = waves.findIndex((wave) => wave.some((step) => step.id === 's1'))
  const testWave = waves.findIndex((wave) => wave.some((step) => step.id === 's2'))

  expect(sourceWave).toBeLessThan(testWave)
})

test('two testers writing different test files still run together', () => {
  const steps: ProposalStep[] = [
    { id: 'a', title: 'Auth tests', role: 'tester', instructions: '', files: ['tests/auth.test.ts'], dependsOn: [] },
    { id: 'b', title: 'Expense tests', role: 'tester', instructions: '', files: ['tests/expenses.test.ts'], dependsOn: [] },
  ]

  expect(planWaves(steps).waves).toHaveLength(1)
})

test('a worker is told to report a broken plan only when it actually has the tool', () => {
  // Framing decides whether a tool gets called at all on this project's model:
  // "how you finish" is used, "available along the way" is not. But promising a
  // tool the worker was never given is worse than saying nothing.
  const withTool = buildWorkerContract({ acceptanceCriteria: ['it works'] }, true)
  const withoutTool = buildWorkerContract({ acceptanceCriteria: ['it works'] }, false)

  expect(withTool).toContain('revise_plan')
  expect(withTool).toContain('Before you finish')
  expect(withoutTool).not.toContain('revise_plan')
  expect(withoutTool).toContain('it works')
})
