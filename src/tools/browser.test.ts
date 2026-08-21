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

test('side-effecting actions require an exact approval token and become paused sessions', async () => {
  const result = await browserTool.execute({ action: 'click', target: 'Publish' })
  expect(result).toContain('Confirmation required')
  expect(result).toContain('confirmationToken=approval_')
  expect(result).toContain('Task session:')
})

test('approval tokens are bound to the exact target and consumed once', async () => {
  const pending = await browserTool.execute({ action: 'click', target: 'Send' })
  const token = pending.match(/confirmationToken=(approval_[^\. ]+)/)?.[1]
  expect(token).toBeDefined()

  const previousBridge = process.env.ELIA_BROWSER_BRIDGE_COMMAND
  process.env.ELIA_BROWSER_BRIDGE_COMMAND = 'cat'
  try {
    const changedTarget = await browserTool.execute({ action: 'click', target: 'Delete', confirmed: true, confirmationToken: token })
    expect(changedTarget).toContain('Confirmation required')

    const approved = await browserTool.execute({ action: 'click', target: 'Send', confirmed: true, confirmationToken: token })
    expect(approved).not.toContain('Confirmation required')
    expect(approved).toContain('Task session:')

    const reused = await browserTool.execute({ action: 'click', target: 'Send', confirmed: true, confirmationToken: token })
    expect(reused).toContain('Confirmation required')
  } finally {
    if (previousBridge === undefined) delete process.env.ELIA_BROWSER_BRIDGE_COMMAND
    else process.env.ELIA_BROWSER_BRIDGE_COMMAND = previousBridge
  }
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

test('validateRequest supports bounded scroll and wait-for actions', () => {
  expect(validateRequest({ action: 'scroll', direction: 'down', amount: 900 })).toMatchObject({ action: 'scroll', direction: 'down', amount: 900 })
  expect(validateRequest({ action: 'wait_for', expectText: 'Ready', ms: 1000 })).toMatchObject({ action: 'wait_for', expectText: 'Ready', ms: 1000 })
  expect(validateRequest({ action: 'verify', expectUrl: 'https://example.com' })).toMatchObject({ action: 'verify', expectUrl: 'https://example.com' })
})

test('verify requires an explicit expectation', () => {
  expect(() => validateRequest({ action: 'verify' })).toThrow('verify requires')
})

test('post-action URL expectations are checked against a follow-up snapshot', async () => {
  const previousBridge = process.env.ELIA_BROWSER_BRIDGE_COMMAND
  process.env.ELIA_BROWSER_BRIDGE_COMMAND = "printf '%s' '{\"ok\":true,\"result\":{\"url\":\"https://example.com/done\",\"text\":\"Done\"}}'"
  try {
    const result = await browserTool.execute({ action: 'navigate', url: 'https://example.com/start', expectUrl: 'https://example.com/done' })
    expect(result).toContain('https://example.com/done')
    expect(result).toContain('Task session:')
  } finally {
    if (previousBridge === undefined) delete process.env.ELIA_BROWSER_BRIDGE_COMMAND
    else process.env.ELIA_BROWSER_BRIDGE_COMMAND = previousBridge
  }
})
