import { expect, test } from 'bun:test'
import { moveTaskSelection } from './taskDashboard.ts'

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
