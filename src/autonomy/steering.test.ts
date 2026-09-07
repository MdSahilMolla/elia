import { afterEach, expect, test } from 'bun:test'
import { drainParentSteering, setParentSteering } from './steering.ts'

afterEach(() => setParentSteering(undefined))

test('drainParentSteering is empty when no top-level turn registered a source', () => {
  expect(drainParentSteering()).toEqual([])
})

test('a registered source is forwarded, and only one drainer gets each batch', () => {
  const pending = ['redirect: use tabs, not spaces']
  setParentSteering(() => pending.splice(0))
  expect(drainParentSteering()).toEqual(['redirect: use tabs, not spaces'])
  // A second drainer (a parallel worker) sees nothing — the first consumed it.
  expect(drainParentSteering()).toEqual([])
})

test('a throwing source is swallowed', () => {
  setParentSteering(() => { throw new Error('boom') })
  expect(drainParentSteering()).toEqual([])
})
