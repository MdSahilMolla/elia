import { afterEach, expect, test } from 'bun:test'
import { browserTool, unwrapCdpEvaluateValue, validateRequest } from './browser.ts'
import { clearBrowserMcpToolsForTests, registerBrowserMcpTool } from '../mcp/browserRegistry.ts'

afterEach(() => clearBrowserMcpToolsForTests())

test('validateRequest accepts an absolute navigation URL', () => {
  expect(validateRequest({ action: 'navigate', url: 'https://example.com' })).toEqual({
    action: 'navigate',
    url: 'https://example.com',
  })
})

test('validateRequest rejects non-http navigation targets', () => {
  expect(() => validateRequest({ action: 'navigate', url: 'javascript:alert(1)' })).toThrow('absolute http(s) url')
})

test('validateRequest rejects navigation URLs with embedded credentials', () => {
  expect(() => validateRequest({ action: 'navigate', url: 'https://user:secret@example.com/' })).toThrow('must not contain embedded credentials')
  expect(validateRequest({ action: 'navigate', url: 'https://example.com/' })).toEqual({ action: 'navigate', url: 'https://example.com/' })
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

test('uses an already-connected browser MCP tool without an external MCP CLI', async () => {
  const previousBridge = process.env.ELIA_BROWSER_BRIDGE_COMMAND; const previousServer = process.env.ELIA_BROWSER_MCP_SERVER; const previousCdp = process.env.ELIA_BROWSER_CDP_URL
  delete process.env.ELIA_BROWSER_BRIDGE_COMMAND; delete process.env.ELIA_BROWSER_MCP_SERVER; delete process.env.ELIA_BROWSER_CDP_URL
  registerBrowserMcpTool('playwright', 'browser_snapshot', { name: 'mcp_playwright_browser_snapshot', description: 'snapshot', input_schema: { type: 'object', properties: {} }, async execute() { return JSON.stringify({ ok: true, result: { url: 'https://example.com', title: 'Example' } }) } })
  try {
    const result = await browserTool.execute({ action: 'status' })
    expect(result).toContain('https://example.com')
    expect(result).toContain('Task session:')
  } finally {
    if (previousBridge === undefined) delete process.env.ELIA_BROWSER_BRIDGE_COMMAND; else process.env.ELIA_BROWSER_BRIDGE_COMMAND = previousBridge
    if (previousServer === undefined) delete process.env.ELIA_BROWSER_MCP_SERVER; else process.env.ELIA_BROWSER_MCP_SERVER = previousServer
    if (previousCdp === undefined) delete process.env.ELIA_BROWSER_CDP_URL; else process.env.ELIA_BROWSER_CDP_URL = previousCdp
  }
})

test('maps click targets to the current Playwright MCP contract', async () => {
  const previousBridge = process.env.ELIA_BROWSER_BRIDGE_COMMAND; const previousServer = process.env.ELIA_BROWSER_MCP_SERVER; const previousCdp = process.env.ELIA_BROWSER_CDP_URL
  delete process.env.ELIA_BROWSER_BRIDGE_COMMAND; delete process.env.ELIA_BROWSER_MCP_SERVER; delete process.env.ELIA_BROWSER_CDP_URL
  let received: Record<string, unknown> | undefined
  registerBrowserMcpTool('playwright', 'browser_click', { name: 'mcp_playwright_browser_click', description: 'click', input_schema: { type: 'object', properties: {} }, async execute(input) { received = input; return 'clicked' } })
  try {
    await browserTool.execute({ action: 'click', target: 'button-ref-7' })
    expect(received).toEqual({ target: 'button-ref-7', element: 'button-ref-7' })
  } finally {
    if (previousBridge === undefined) delete process.env.ELIA_BROWSER_BRIDGE_COMMAND; else process.env.ELIA_BROWSER_BRIDGE_COMMAND = previousBridge
    if (previousServer === undefined) delete process.env.ELIA_BROWSER_MCP_SERVER; else process.env.ELIA_BROWSER_MCP_SERVER = previousServer
    if (previousCdp === undefined) delete process.env.ELIA_BROWSER_CDP_URL; else process.env.ELIA_BROWSER_CDP_URL = previousCdp
  }
})

test('accepts Playwright MCP Markdown accessibility snapshots', async () => {
  const previousBridge = process.env.ELIA_BROWSER_BRIDGE_COMMAND; const previousServer = process.env.ELIA_BROWSER_MCP_SERVER; const previousCdp = process.env.ELIA_BROWSER_CDP_URL
  delete process.env.ELIA_BROWSER_BRIDGE_COMMAND; delete process.env.ELIA_BROWSER_MCP_SERVER; delete process.env.ELIA_BROWSER_CDP_URL
  registerBrowserMcpTool('playwright', 'browser_snapshot', { name: 'mcp_playwright_browser_snapshot', description: 'snapshot', input_schema: { type: 'object', properties: {} }, async execute() { return '# Page\n```yaml\n- heading "Example Domain"\n```' } })
  try {
    const result = await browserTool.execute({ action: 'status' })
    expect(result).toContain('Example Domain')
    expect(result).not.toContain('Browser action failed')
  } finally {
    if (previousBridge === undefined) delete process.env.ELIA_BROWSER_BRIDGE_COMMAND; else process.env.ELIA_BROWSER_BRIDGE_COMMAND = previousBridge
    if (previousServer === undefined) delete process.env.ELIA_BROWSER_MCP_SERVER; else process.env.ELIA_BROWSER_MCP_SERVER = previousServer
    if (previousCdp === undefined) delete process.env.ELIA_BROWSER_CDP_URL; else process.env.ELIA_BROWSER_CDP_URL = previousCdp
  }
})

test('console and network are accepted actions with bounded limits', () => {
  expect(validateRequest({ action: 'console' })).toMatchObject({ action: 'console', limit: 50 })
  expect(validateRequest({ action: 'network', limit: 5, errorsOnly: true })).toMatchObject({ action: 'network', limit: 5, errorsOnly: true })
  // A limit past the cap is clamped rather than refused — the caller asked for
  // "as much as possible", and the page buffer is bounded anyway.
  expect(validateRequest({ action: 'console', limit: 10_000 })).toMatchObject({ limit: 200 })
  expect(validateRequest({ action: 'console', limit: 0 })).toMatchObject({ limit: 1 })
  expect(() => validateRequest({ action: 'console', errorsOnly: 'yes' })).toThrow('errorsOnly must be a boolean')
})

// --- The CDP path returns the page's value, not the RemoteObject around it ----

test('a Runtime.evaluate result is unwrapped to the value the page script returned', () => {
  // The real shape: cdpRequest resolves the message's `result`, so the value
  // sits one level down. This used to come back as `{ type, value }` for every
  // status/snapshot/extract/console/network read on the CDP path.
  const final = { result: { type: 'object', value: { url: 'https://example.com/', title: 'Example' } } }
  expect(unwrapCdpEvaluateValue(final)).toEqual({ url: 'https://example.com/', title: 'Example' })
})

test('the doubly-nested form is unwrapped too, whichever the transport hands back', () => {
  const final = { result: { result: { type: 'object', value: { text: 'hello' } } } }
  expect(unwrapCdpEvaluateValue(final)).toEqual({ text: 'hello' })
})

test('a result that carries no RemoteObject is returned as it is', () => {
  // Page.navigate answers with frame ids, not a RemoteObject.
  expect(unwrapCdpEvaluateValue({ result: { frameId: 'F1', loaderId: 'L1' } })).toEqual({ frameId: 'F1', loaderId: 'L1' })
})
