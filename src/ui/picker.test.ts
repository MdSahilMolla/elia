import { expect, test } from 'bun:test'
import { applyPickerKey, applySearchKey } from './picker.ts'

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

test('applySearchKey appends a typed character to the query', () => {
  expect(applySearchKey(0, 10, 'pl', 'a', { name: 'a' })).toEqual({ type: 'query', query: 'pla' })
})

test('applySearchKey ignores navigation key characters even though they carry a str payload', () => {
  expect(applySearchKey(0, 10, '', undefined, { name: 'down' })).toEqual({ type: 'move', selected: 1 })
})

test('applySearchKey backspace trims the query by one character', () => {
  expect(applySearchKey(0, 10, 'plan', undefined, { name: 'backspace' })).toEqual({ type: 'query', query: 'pla' })
})

test('applySearchKey backspace on an empty query is a no-op, not a cancel', () => {
  expect(applySearchKey(0, 10, '', undefined, { name: 'backspace' })).toEqual({ type: 'none' })
})

test('applySearchKey escape clears a non-empty query before it cancels', () => {
  expect(applySearchKey(0, 10, 'plan', undefined, { name: 'escape' })).toEqual({ type: 'query', query: '' })
  expect(applySearchKey(0, 10, '', undefined, { name: 'escape' })).toEqual({ type: 'cancel' })
})

test('applySearchKey still selects and quits like the plain picker', () => {
  expect(applySearchKey(2, 5, '', undefined, { name: 'return' })).toEqual({ type: 'select', index: 2 })
  expect(applySearchKey(0, 5, '', undefined, { name: 'c', ctrl: true })).toEqual({ type: 'quit' })
})

test('applySearchKey ignores control characters and multi-character escape sequences', () => {
  expect(applySearchKey(0, 10, 'x', '\t', { name: 'tab' })).toEqual({ type: 'none' })
  expect(applySearchKey(0, 10, 'x', '\x1b[A', { name: 'up' })).toEqual({ type: 'move', selected: 9 })
})
