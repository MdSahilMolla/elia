import { expect, test } from 'bun:test'
import { browserTool, validateRequest } from './browser.ts'

test('validates browser navigation inputs', () => {
  expect(validateRequest({ action: 'navigate', url: 'https://example.com' })).toEqual({
    action: 'navigate',
    url: 'https://example.com',
    confirmed: false,
  })
  expect(() => validateRequest({ action: 'navigate', url: 'file:///tmp/secret' })).toThrow('absolute http(s) url')
})

test('requires confirmation for side-effect-like browser actions', async () => {
  const result = await browserTool.execute({ action: 'click', target: 'Buy now' })
  expect(result).toContain('Confirmation required')
  expect(result).toContain('confirmed=true')
})

test('reports missing bridge configuration as an actionable browser failure', async () => {
  const previous = process.env.ELIA_BROWSER_BRIDGE_COMMAND
  const previousCdp = process.env.ELIA_BROWSER_CDP_URL
  delete process.env.ELIA_BROWSER_BRIDGE_COMMAND
  delete process.env.ELIA_BROWSER_CDP_URL
  try {
    const result = await browserTool.execute({ action: 'status' })
    expect(result).toContain('no browser bridge is configured')
    expect(result).toContain('ELIA_BROWSER_BRIDGE_COMMAND')
  } finally {
    if (previous === undefined) delete process.env.ELIA_BROWSER_BRIDGE_COMMAND
    else process.env.ELIA_BROWSER_BRIDGE_COMMAND = previous
    if (previousCdp === undefined) delete process.env.ELIA_BROWSER_CDP_URL
    else process.env.ELIA_BROWSER_CDP_URL = previousCdp
  }
})
