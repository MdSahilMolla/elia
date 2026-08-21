import { expect, test } from 'bun:test'
import { browserTool, isSensitiveBrowserInput, validateRequest } from './browser.ts'

test('validateRequest accepts an absolute navigation URL', () => {
  expect(validateRequest({ action: 'navigate', url: 'https://example.com' })).toEqual({
    action: 'navigate',
    url: 'https://example.com',
    confirmed: false,
  })
})

test('validateRequest rejects non-http navigation targets', () => {
  expect(() => validateRequest({ action: 'navigate', url: 'javascript:alert(1)' })).toThrow('absolute http(s) url')
})

test('sensitive browser inputs are detected conservatively', () => {
  expect(isSensitiveBrowserInput({ target: 'Buy now' })).toBe(true)
  expect(isSensitiveBrowserInput({ target: 'Read product details' })).toBe(false)
})

test('side-effecting actions require explicit confirmation', async () => {
  const result = await browserTool.execute({ action: 'click', target: 'Publish' })
  expect(result).toContain('Confirmation required')
  expect(result).toContain('confirmed=true')
})

test('wait works without a configured browser bridge', async () => {
  const result = await browserTool.execute({ action: 'wait', ms: 0 })
  expect(result).toBe('waited 0ms')
})
