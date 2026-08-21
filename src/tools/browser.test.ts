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

test('side-effecting actions require explicit confirmation and become paused sessions', async () => {
  const result = await browserTool.execute({ action: 'click', target: 'Publish' })
  expect(result).toContain('Confirmation required')
  expect(result).toContain('confirmed=true')
  expect(result).toContain('Task session:')
})

test('wait works without a configured browser bridge and records a session', async () => {
  const result = await browserTool.execute({ action: 'wait', ms: 0 })
  expect(result).toContain('waited 0ms')
  expect(result).toContain('Task session:')
})

test('reports missing bridge configuration as an actionable browser failure', async () => {
  const previous = process.env.ELIA_BROWSER_BRIDGE_COMMAND
  const previousMcp = process.env.ELIA_BROWSER_MCP_SERVER
  const previousCdp = process.env.ELIA_BROWSER_CDP_URL
  delete process.env.ELIA_BROWSER_BRIDGE_COMMAND
  delete process.env.ELIA_BROWSER_MCP_SERVER
  delete process.env.ELIA_BROWSER_CDP_URL
  try {
    const result = await browserTool.execute({ action: 'status' })
    expect(result).toContain('no browser bridge is configured')
    expect(result).toContain('ELIA_BROWSER_MCP_SERVER')
  } finally {
    if (previous === undefined) delete process.env.ELIA_BROWSER_BRIDGE_COMMAND
    else process.env.ELIA_BROWSER_BRIDGE_COMMAND = previous
    if (previousMcp === undefined) delete process.env.ELIA_BROWSER_MCP_SERVER
    else process.env.ELIA_BROWSER_MCP_SERVER = previousMcp
    if (previousCdp === undefined) delete process.env.ELIA_BROWSER_CDP_URL
    else process.env.ELIA_BROWSER_CDP_URL = previousCdp
  }
})
