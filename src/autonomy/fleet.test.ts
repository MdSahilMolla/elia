import { expect, test } from 'bun:test'
import type { ProposalStep } from './types.ts'

// fleet.ts reaches config.ts through the sub-agent runner, which resolves a
// provider at import time — a placeholder key lets the module load. Nothing here
// makes a network call; only the pure planning functions are exercised.
process.env.ANTHROPIC_API_KEY ??= 'test-key-for-fleet-test'

const { planWaves, fileCollisions } = await import('./fleet.ts')

function step(id: string, dependsOn: string[] = [], files: string[] = []): ProposalStep {
  return { id, title: `step ${id}`, role: 'builder', instructions: 'do it', files, dependsOn }
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

test('disjoint files in one wave are not a collision', () => {
  expect(fileCollisions([step('a', [], ['x.ts']), step('b', [], ['y.ts'])])).toEqual([])
})
