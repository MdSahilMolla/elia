import { expect, test } from 'bun:test'
import { applyPickerKey } from './picker.ts'

test('down moves the selection forward', () => {
  expect(applyPickerKey(0, 4, { name: 'down' })).toEqual({ type: 'move', selected: 1 })
})

test('up moves the selection backward', () => {
  expect(applyPickerKey(2, 4, { name: 'up' })).toEqual({ type: 'move', selected: 1 })
})

test('right is an alias for down', () => {
  expect(applyPickerKey(0, 4, { name: 'right' })).toEqual({ type: 'move', selected: 1 })
})

test('left is an alias for up', () => {
  expect(applyPickerKey(2, 4, { name: 'left' })).toEqual({ type: 'move', selected: 1 })
})

test('down wraps from the last option back to the first', () => {
  expect(applyPickerKey(3, 4, { name: 'down' })).toEqual({ type: 'move', selected: 0 })
})

test('up wraps from the first option to the last', () => {
  expect(applyPickerKey(0, 4, { name: 'up' })).toEqual({ type: 'move', selected: 3 })
})

test('return selects the current index', () => {
  expect(applyPickerKey(2, 4, { name: 'return' })).toEqual({ type: 'select', index: 2 })
})

test('escape cancels', () => {
  expect(applyPickerKey(1, 4, { name: 'escape' })).toEqual({ type: 'cancel' })
})

test('ctrl+c quits regardless of the key name', () => {
  expect(applyPickerKey(1, 4, { name: 'c', ctrl: true })).toEqual({ type: 'quit' })
})

test('an unrelated key is a no-op', () => {
  expect(applyPickerKey(1, 4, { name: 'a' })).toEqual({ type: 'none' })
})

test('a single-option list still wraps to itself', () => {
  expect(applyPickerKey(0, 1, { name: 'down' })).toEqual({ type: 'move', selected: 0 })
  expect(applyPickerKey(0, 1, { name: 'up' })).toEqual({ type: 'move', selected: 0 })
})

test('page navigation and home/end stay within large catalogs', () => {
  expect(applyPickerKey(9, 50, { name: 'pagedown' })).toEqual({ type: 'move', selected: 19 })
  expect(applyPickerKey(9, 50, { name: 'pageup' })).toEqual({ type: 'move', selected: 0 })
  expect(applyPickerKey(9, 50, { name: 'home' })).toEqual({ type: 'move', selected: 0 })
  expect(applyPickerKey(9, 50, { name: 'end' })).toEqual({ type: 'move', selected: 49 })
})
