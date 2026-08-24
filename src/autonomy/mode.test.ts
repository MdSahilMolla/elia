import { expect, test } from 'bun:test'
import { activeMode, setActiveMode } from './mode.ts'

test('dev is the default general-purpose mode and can be switched explicitly', () => {
  setActiveMode('dev')
  expect(activeMode()).toBe('dev')

  setActiveMode('cyber')
  expect(activeMode()).toBe('cyber')

  setActiveMode('dev')
  expect(activeMode()).toBe('dev')
})
