import { expect, test } from 'bun:test'
import { moveTaskSelection, renderTaskSummary } from './taskDashboard.ts'
import { TaskSessionStore } from '../taskSessions.ts'

test('task dashboard moves with both arrow-key pairs and wraps', () => {
  expect(moveTaskSelection(0, 3, { name: 'up' })).toBe(2)
  expect(moveTaskSelection(2, 3, { name: 'down' })).toBe(0)
  expect(moveTaskSelection(0, 3, { name: 'left' })).toBe(2)
  expect(moveTaskSelection(2, 3, { name: 'right' })).toBe(0)
})

test('task dashboard keeps selection stable for unrelated keys', () => {
  expect(moveTaskSelection(1, 3, { name: 'return' })).toBe(1)
  expect(moveTaskSelection(99, 3, { name: 'return' })).toBe(2)
  expect(moveTaskSelection(1, 0, { name: 'down' })).toBe(0)
})

test('renderTaskSummary returns empty string when store is empty', () => {
  const store = new TaskSessionStore()
  expect(renderTaskSummary(store)).toBe('')
})

test('renderTaskSummary formats active, done, and failed counts', () => {
  const store = new TaskSessionStore()
  const t1 = store.create('code', 'task 1')
  store.update(t1.id, { status: 'running' })
  const t2 = store.create('browser', 'task 2')
  store.update(t2.id, { status: 'done' })
  const t3 = store.create('data', 'task 3')
  store.update(t3.id, { status: 'failed' })

  expect(renderTaskSummary(store)).toBe('tasks: 1 active · 1 done · 1 failed')
})
