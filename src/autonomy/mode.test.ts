import { expect, test } from 'bun:test'
import { activeMode, setActiveMode, withActiveMode } from './mode.ts'

test('dev is the default general-purpose mode and can be switched explicitly', () => {
  setActiveMode('dev')
  expect(activeMode()).toBe('dev')

  setActiveMode('cyber')
  expect(activeMode()).toBe('cyber')

  setActiveMode('dev')
  expect(activeMode()).toBe('dev')
})

test('concurrent turns keep their operating modes isolated', async () => {
  const seen = await Promise.all([
    withActiveMode('battmann', async () => { await Bun.sleep(10); return activeMode() }),
    withActiveMode('cyber', async () => { await Bun.sleep(1); return activeMode() }),
  ])
  expect(seen).toEqual(['battmann', 'cyber'])
})
