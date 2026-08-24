import { expect, test } from 'bun:test'
import { browserTool, validateRequest } from './browser.ts'

test('validateRequest accepts an absolute navigation URL', () => {
  expect(validateRequest({ action: 'navigate', url: 'https://example.com' })).toEqual({
    action: 'navigate',
    url: 'https://example.com',
  })
})

test('validateRequest rejects non-http navigation targets', () => {
  expect(() => validateRequest({ action: 'navigate', url: 'javascript:alert(1)' })).toThrow('absolute http(s) url')
})

test('click actions run directly — approval for state-changing actions is the action governor\'s job, not this tool\'s', async () => {
  const previousBridge = process.env.ELIA_BROWSER_BRIDGE_COMMAND
  process.env.ELIA_BROWSER_BRIDGE_COMMAND = 'bun -e "process.stdin.pipe(process.stdout)"'
  try {
    const result = await browserTool.execute({ action: 'click', target: 'Send' })
    expect(result).not.toContain('Confirmation required')
    expect(result).toContain('Task session:')
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
  process.env.ELIA_BROWSER_BRIDGE_COMMAND = "bun -e \"process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({ok:true,result:{url:'https://example.com/done',text:'Done'}})))\""
  try {
    const result = await browserTool.execute({ action: 'navigate', url: 'https://example.com/start', expectUrl: 'https://example.com/done' })
    expect(result).toContain('https://example.com/done')
    expect(result).toContain('Task session:')
  } finally {
    if (previousBridge === undefined) delete process.env.ELIA_BROWSER_BRIDGE_COMMAND
    else process.env.ELIA_BROWSER_BRIDGE_COMMAND = previousBridge
  }
})
