import { expect, test } from 'bun:test'
import { collectPromptInjects, parseLifecycleHooks, fireLifecycleEvent } from './lifecycleHooks.ts'

test('parseLifecycleHooks accepts UserPromptSubmit inject', () => {
  const hooks = parseLifecycleHooks(JSON.stringify([
    { id: 'branch', event: 'UserPromptSubmit', inject: 'Current focus: auth' },
  ]))
  expect(hooks).toHaveLength(1)
  expect(collectPromptInjects(hooks)).toBe('Current focus: auth')
})

test('parseLifecycleHooks rejects unknown events', () => {
  expect(() => parseLifecycleHooks(JSON.stringify([{ id: 'x', event: 'Boom', inject: 'y' }]))).toThrow(/unknown event/)
})

test('fireLifecycleEvent skips shell without ELIA_UNSAFE_HOOKS', async () => {
  const hooks = parseLifecycleHooks(JSON.stringify([
    { id: 'notify', event: 'SessionEnd', command: 'echo done' },
  ]))
  const notes = await fireLifecycleEvent('SessionEnd', {}, hooks, {})
  expect(notes.some((n) => n.includes('ELIA_UNSAFE_HOOKS=1'))).toBe(true)
})
