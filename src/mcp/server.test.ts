import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateMcpSchema, type JsonRpcResponse, type JsonRpcSuccess } from './protocol.ts'
import {
  CANONICAL_MCP_TOOL_COUNT,
  MCP_FEATURE_BY_NAME,
  MCP_FEATURE_INVENTORY,
  MCP_TOOL_NAMES,
  assertMcpFeatureInventoryComplete,
  isCostTier,
} from './featureInventory.ts'
import { COST_TIERS } from './serverTypes.ts'
import { createEliaMcpServer, startHttpMcpServer, startStdioMcpServer, type EliaMcpServer } from './server.ts'
import type { EliaMcpServerConfig } from './config.ts'
import { detectEliaDomain, domainsForMode } from './adapters/domain-detector.ts'

const INIT_PARAMS = {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'server.test', version: '0' },
}

function testConfig(overrides: Partial<EliaMcpServerConfig> = {}): EliaMcpServerConfig {
  return {
    transport: 'stdio',
    port: 0,
    host: '127.0.0.1',
    tokenPath: join(tmpdir(), 'elia-mcp-server-test-no-such-token'),
    allowedOperations: ['*'],
    approvalMode: 'auto',
    streamProgress: true,
    domainAutoDetect: true,
    allowRemoteHost: false,
    maxConcurrentSessions: 4,
    costLimitPerSessionUsd: null,
    ...overrides,
  }
}

function project(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'elia-mcp-server-'))
  mkdirSync(join(cwd, '.elia'), { recursive: true })
  return cwd
}

async function started(config = testConfig()): Promise<{ server: EliaMcpServer; cwd: string }> {
  const cwd = project()
  const server = await createEliaMcpServer({ cwd, config })
  await server.handleRequest({ jsonrpc: '2.0', id: 'init', method: 'initialize', params: INIT_PARAMS })
  return { server, cwd }
}

async function request(server: EliaMcpServer, method: string, params?: unknown, id: string | number = 1): Promise<any> {
  const response = (await server.handleRequest({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })) as JsonRpcResponse | undefined
  expect(response).toBeDefined()
  return response
}

async function callTool(server: EliaMcpServer, name: string, args: Record<string, unknown> = {}, id: string | number = 9): Promise<any> {
  const response = await request(server, 'tools/call', { name, arguments: args }, id)
  return response.result
}

test('the canonical inventory holds exactly 39 unique tools', () => {
  assertMcpFeatureInventoryComplete()
  expect(CANONICAL_MCP_TOOL_COUNT).toBe(39)
  expect(MCP_FEATURE_INVENTORY).toHaveLength(39)
  expect(new Set(MCP_TOOL_NAMES).size).toBe(39)
})

test('every inventory entry declares a valid cost tier and approval flag', () => {
  for (const feature of MCP_FEATURE_INVENTORY) {
    expect(isCostTier(feature.costTier)).toBe(true)
    expect(COST_TIERS as readonly string[]).toContain(feature.costTier)
    expect(typeof feature.requiresApproval).toBe('boolean')
    expect(feature.supportedModes.length).toBeGreaterThan(0)
  }
})

test('the registered tools match the inventory name-for-name and metadata-for-metadata', async () => {
  const { server } = await started()
  try {
    const listed = (await request(server, 'tools/list')).result.tools
    const names = listed.map((tool: { name: string }) => tool.name).sort()
    expect(names).toEqual([...MCP_TOOL_NAMES].sort())
    for (const tool of server.registry.listTools()) {
      const feature = MCP_FEATURE_BY_NAME.get(tool.name)
      expect(feature).toBeDefined()
      expect(tool.requiresApproval).toBe(feature!.requiresApproval)
      expect(tool.costTier).toBe(feature!.costTier)
      expect(tool.idempotent).toBe(feature!.idempotent)
      expect([...tool.supportedModes].sort()).toEqual([...feature!.supportedModes].sort())
    }
  } finally {
    await server.close()
  }
})

test('the specialist and context-bridge tools the review found unreachable are registered', async () => {
  const { server } = await started()
  try {
    const names = new Set(server.registry.listTools().map((tool) => tool.name))
    for (const name of ['elia_research', 'elia_analyze_data', 'elia_write_document', 'elia_strategic_analysis', 'elia_context_subscribe', 'elia_import_context']) {
      expect(names.has(name)).toBe(true)
    }
  } finally {
    await server.close()
  }
})

test('the server advertises 6 resources, 2 templates, and 5 prompts', async () => {
  const { server } = await started()
  try {
    const resources = (await request(server, 'resources/list')).result.resources
    const templates = (await request(server, 'resources/templates/list')).result.resourceTemplates
    const prompts = (await request(server, 'prompts/list')).result.prompts
    expect(resources).toHaveLength(6)
    expect(templates).toHaveLength(2)
    expect(prompts).toHaveLength(5)
    expect(resources.length + templates.length).toBe(8)
  } finally {
    await server.close()
  }
})

test('the run and plan output schemas accept the full receipt the tools actually return', async () => {
  const { server } = await started()
  try {
    const runTask = server.registry.getTool('elia_run_task')
    expect(runTask).toBeDefined()
    const runSchema = validateMcpSchema({
      status: 'awaiting_approval',
      run_id: 'r1',
      plan_id: 'p1',
      summary: 'planned',
      files_changed: [],
      estimated_cost_tier: 'model-call',
      verification: [],
      next_steps: [],
      mode: 'general',
      mode_source: 'server',
      mode_confidence: 0.5,
      plan: { id: 'p1' },
      waves: [],
    }, runTask!.outputSchema!)
    expect(runSchema.errors).toEqual([])

    const getPlan = server.registry.getTool('elia_get_plan')
    const planSchema = validateMcpSchema({
      status: 'awaiting_approval',
      run_id: 'r1',
      plan_id: 'p1',
      plan_status: 'proposed',
      goal: 'ship it',
      mode: 'general',
      steps: ['one'],
      proposal: {},
      detected_checks: [],
      estimated_cost_tier: 'cheap',
      mode_source: 'server',
      plan: { id: 'p1' },
    }, getPlan!.outputSchema!)
    expect(planSchema.errors).toEqual([])
  } finally {
    await server.close()
  }
})

test('a read-only tool error result still satisfies its declared output schema', async () => {
  const { server } = await started()
  try {
    const result = await callTool(server, 'elia_get_plan', { plan_id: 'no-such-plan' })
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent.status).toBe('failed')
    expect(result.structuredContent.error).toContain('no-such-plan')
  } finally {
    await server.close()
  }
})

test('a client cannot widen the active mode through tools/call', async () => {
  const { server } = await started()
  try {
    const forged = await request(server, 'tools/call', { name: 'elia_get_plan', arguments: {}, mode: 'research' }, 'forged')
    expect(forged.error.code).toBe(-32602)
    expect(forged.error.message).toContain('does not match this server')
    expect(server.runtime.getMode('server')).toBe('general')
  } finally {
    await server.close()
  }
})

test('tools are scoped by the active mode and elia_set_mode changes it', async () => {
  const { server } = await started()
  try {
    const general = (await request(server, 'tools/list')).result.tools.map((tool: { name: string }) => tool.name)
    expect(general).toContain('elia_research')

    const switched = await callTool(server, 'elia_set_mode', { mode: 'data' })
    expect(switched.isError).toBeFalsy()
    expect(server.runtime.getMode('server')).toBe('data')

    const dataMode = (await request(server, 'tools/list', undefined, 'after')).result.tools.map((tool: { name: string }) => tool.name)
    expect(dataMode).not.toContain('elia_research')
    expect(dataMode).toContain('elia_analyze_data')
    expect(dataMode).toContain('elia_write_document')
  } finally {
    await server.close()
  }
})

test('each specialist tool is only visible in the modes its metadata allows', async () => {
  const feature = MCP_FEATURE_BY_NAME.get('elia_strategic_analysis')!
  const { server } = await started()
  try {
    for (const mode of feature.supportedModes) {
      expect(server.runtime.getMode('server')).toBeDefined()
      const visible = (await request(server, 'tools/list', undefined, `mode-${mode}`)).result.tools.map((tool: { name: string }) => tool.name)
      const expected = server.registry.listTools({ mode }).map((tool) => tool.name)
      expect(visible).toContain('elia_strategic_analysis')
      expect(expected.length).toBeGreaterThan(0)
    }
  } finally {
    await server.close()
  }
})

test('domain detection maps goals to the specialist modes they belong to', () => {
  expect(detectEliaDomain('compare quarterly revenue across regions').domain).toBe('finance')
  expect(detectEliaDomain('clean this csv and chart the outliers').domain).toBe('data')
  expect(detectEliaDomain('fix the failing test in the parser').domain).toBe('code')
  expect(detectEliaDomain('hello').domain).toBe('general')
  expect(domainsForMode('data')).toContain('data')
  expect(domainsForMode('finance')).toContain('finance')
})

test('a client cannot approve its own policy update and weakening is rejected', async () => {
  const { server, cwd } = await started()
  try {
    const selfApproved = await callTool(server, 'elia_policy_update', {
      changes: { denyTools: ['dangerous_tool'] },
      reason: 'tighten the deny list',
      approved: true,
      actor: 'the-client',
    })
    expect(selfApproved.isError).toBe(true)
    expect(selfApproved.structuredContent.error.code).toBe('INVALID_INPUT')
    expect(selfApproved.structuredContent.error.message).toContain('$.approved')

    const accepted = await callTool(server, 'elia_policy_update', {
      changes: { denyTools: ['dangerous_tool'] },
      reason: 'tighten the deny list',
    })
    expect(accepted.isError).toBeFalsy()
    const document = JSON.parse(await Bun.file(join(cwd, '.elia', 'policy.json')).text())
    expect(document.denyTools).toContain('dangerous_tool')

    const weakened = await callTool(server, 'elia_policy_update', {
      changes: { denyTools: [] },
      reason: 'remove the restriction',
    })
    expect(weakened.isError).toBe(true)
  } finally {
    await server.close()
  }
})

test('approvalMode never blocks a mutation the governor would require approval for', async () => {
  const { server } = await started(testConfig({ approvalMode: 'never' }))
  try {
    const denied = await callTool(server, 'elia_policy_update', {
      changes: { denyTools: ['dangerous_tool'] },
      reason: 'tighten the deny list',
    })
    expect(denied.isError).toBe(true)
  } finally {
    await server.close()
  }
})

test('per-session cost is attributed and the configured cost limit is enforced', async () => {
  const { server } = await started(testConfig({ costLimitPerSessionUsd: 0.25 }))
  try {
    const runtime = server.runtime
    expect(() => runtime.assertSessionCostWithinLimit('s1')).not.toThrow()
    runtime.recordSessionCost('s1', 0.2)
    expect(runtime.sessionCostUsd.get('s1')).toBeCloseTo(0.2)
    expect(() => runtime.assertSessionCostWithinLimit('s1')).not.toThrow()
    runtime.recordSessionCost('s1', 0.1)
    expect(() => runtime.assertSessionCostWithinLimit('s1')).toThrow('cost limit')
    expect(() => runtime.assertSessionCostWithinLimit('s2')).not.toThrow()
  } finally {
    await server.close()
  }
})

test('an unlimited cost configuration never blocks a session', async () => {
  const { server } = await started()
  try {
    server.runtime.recordSessionCost('s1', 10_000)
    expect(() => server.runtime.assertSessionCostWithinLimit('s1')).not.toThrow()
  } finally {
    await server.close()
  }
})

test('imported context is readable back through the context bridge', async () => {
  const { server } = await started()
  try {
    const imported = await callTool(server, 'elia_import_context', {
      messages: [
        { role: 'user', content: 'we are migrating the auth service' },
        { role: 'assistant', content: 'understood, the deadline is friday' },
      ],
      source: 'server.test',
    })
    expect(imported.isError).toBeFalsy()
    const sessionId = imported.structuredContent.sessionId as string
    expect(typeof sessionId).toBe('string')
    expect(imported.structuredContent.messageCount).toBe(2)

    const read = await callTool(server, 'elia_session_context', { session: sessionId })
    expect(read.isError).toBeFalsy()
    expect(JSON.stringify(read.structuredContent)).toContain('migrating the auth service')
  } finally {
    await server.close()
  }
})

test('sessions are isolated from each other', async () => {
  const { server } = await started()
  try {
    const first = await callTool(server, 'elia_session_create', { name: 'first', worktree: false })
    const second = await callTool(server, 'elia_session_create', { name: 'second', worktree: false })
    expect(first.isError).toBeFalsy()
    expect(second.isError).toBeFalsy()
    const firstId = first.structuredContent.session.id as string
    const secondId = second.structuredContent.session.id as string
    expect(firstId).not.toBe(secondId)

    const duplicate = await callTool(server, 'elia_session_create', { name: 'first', worktree: false })
    expect(duplicate.isError).toBe(true)

    const list = await callTool(server, 'elia_session_list', {})
    const listed = (list.structuredContent.sessions as Array<{ id: string }>).map((entry) => entry.id)
    expect(listed).toContain(firstId)
    expect(listed).toContain(secondId)
  } finally {
    await server.close()
  }
})

test('stdio and http expose the same tool list', async () => {
  const cwd = project()
  const config = testConfig({ transport: 'stdio' })
  const inProcess = await createEliaMcpServer({ cwd, config })
  await inProcess.handleRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: INIT_PARAMS })
  const direct = (await inProcess.handleRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) as JsonRpcSuccess).result as { tools: unknown[] }

  const stdout: string[] = []
  let buffered = ''
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: INIT_PARAMS })}\n`))
      controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`))
      controller.close()
    },
  })
  const stdio = await startStdioMcpServer({
    cwd,
    config,
    input,
    output: {
      write(chunk: string | Uint8Array) {
        buffered += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)
        const lines = buffered.split('\n')
        buffered = lines.pop() ?? ''
        stdout.push(...lines)
        return true
      },
    } as unknown as NodeJS.WriteStream,
  })
  await stdio.transport.closed
  await stdio.close()
  if (buffered.trim().length > 0) stdout.push(buffered)
  const stdioTools = stdout
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line))
    .find((message) => message.id === 2).result.tools as unknown[]
  expect(stdioTools.map((tool: any) => tool.name).sort()).toEqual(direct.tools.map((tool: any) => tool.name).sort())

  const http = await startHttpMcpServer({ cwd: project(), config: testConfig({ transport: 'http', port: 0 }), token: 'test-token-for-http-parity' })
  try {
    const response = await fetch(new URL('/mcp', http.transport.url), {
      method: 'POST',
      headers: { authorization: 'Bearer test-token-for-http-parity', 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    expect(response.status).toBe(200)
    const body = await response.json() as { result: { tools: Array<{ name: string }> } }
    expect(body.result.tools.map((tool) => tool.name).sort()).toEqual(direct.tools.map((tool: any) => tool.name).sort())
  } finally {
    await http.close()
  }
  await inProcess.close()
})

test('the http transport rejects unauthenticated, misrouted, and unknown-session requests', async () => {
  const http = await startHttpMcpServer({ cwd: project(), config: testConfig({ transport: 'http', port: 0 }), token: 'test-token-for-http-auth' })
  const url = new URL('/mcp', http.transport.url)
  try {
    const anonymous = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(anonymous.status).toBe(401)

    const wrongToken = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer nope', 'content-type': 'application/json' }, body: '{}' })
    expect(wrongToken.status).toBe(401)

    const unknownSession = await fetch(url, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token-for-http-auth', 'mcp-session-id': '00000000-0000-4000-8000-000000000000', 'content-type': 'application/json' },
      body: '{}',
    })
    expect(unknownSession.status).toBe(404)

    const notFound = await fetch(new URL('/nope', http.transport.url), { headers: { authorization: 'Bearer test-token-for-http-auth' } })
    expect(notFound.status).toBe(404)

    const created = await fetch(url, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token-for-http-auth', 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: INIT_PARAMS }),
    })
    const sessionId = created.headers.get('mcp-session-id')
    expect(sessionId).toBeTruthy()

    const badMethod = await fetch(url, { method: 'PUT', headers: { authorization: 'Bearer test-token-for-http-auth', 'mcp-session-id': sessionId! } })
    expect(badMethod.status).toBe(405)

    const badAccept = await fetch(url, {
      method: 'GET',
      headers: { authorization: 'Bearer test-token-for-http-auth', 'mcp-session-id': sessionId!, accept: 'application/json' },
    })
    expect(badAccept.status).toBe(406)

    const deleted = await fetch(url, { method: 'DELETE', headers: { authorization: 'Bearer test-token-for-http-auth', 'mcp-session-id': sessionId! } })
    expect(deleted.status).toBe(204)
  } finally {
    await http.close()
  }
})

test('an sse response delivers progress events before the json-rpc response', async () => {
  const http = await startHttpMcpServer({ cwd: project(), config: testConfig({ transport: 'http', port: 0 }), token: 'test-token-for-sse' })
  try {
    const response = await fetch(new URL('/mcp', http.transport.url), {
      method: 'POST',
      headers: { authorization: 'Bearer test-token-for-sse', 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'elia_get_plan', arguments: { plan_id: 'no-such-plan' } } }),
    })
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const body = await response.text()
    const payloads = body
      .split('\n\n')
      .filter((frame) => frame.includes('data: '))
      .map((frame) => JSON.parse(frame.replace(/^event: message\n/u, '').replace(/^data: /u, '')))
    expect(payloads.length).toBeGreaterThan(0)
    const last = payloads[payloads.length - 1]
    expect(last.id).toBe(1)
    expect(last.result).toBeDefined()
    for (const payload of payloads.slice(0, -1)) {
      expect(payload.method).toBe('notifications/progress')
    }
  } finally {
    await http.close()
  }
})

test('an unknown tool and a malformed request are rejected without a crash', async () => {
  const { server } = await started()
  try {
    const unknown = await request(server, 'tools/call', { name: 'elia_does_not_exist' })
    expect(unknown.error.code).toBe(-32602)

    const badArgs = await callTool(server, 'elia_run_task', { goal: 42 })
    expect(badArgs.isError).toBe(true)
    expect(badArgs.structuredContent.error.code).toBe('INVALID_INPUT')

    const stillAlive = await request(server, 'tools/list', undefined, 'alive')
    expect((stillAlive.result as { tools: unknown[] }).tools).toHaveLength(39)
  } finally {
    await server.close()
  }
})

test('a project policy on disk is honoured when the server starts', async () => {
  const cwd = project()
  writeFileSync(join(cwd, '.elia', 'policy.json'), JSON.stringify({ denyTools: ['shell_exec'], denyIntents: [], denyCommandPatterns: [], requireApprovalAtOrAbove: 'review' }), 'utf8')
  const server = await createEliaMcpServer({ cwd, config: testConfig() })
  try {
    // A connection that never initializes is treated as 2024-11-05, which
    // defines no structured output, so a real client has to handshake first.
    await server.handleRequest({ jsonrpc: '2.0', id: 'init', method: 'initialize', params: INIT_PARAMS })
    const policy = await callTool(server, 'elia_policy_read', {})
    expect(policy.isError).toBeFalsy()
    const effective = policy.structuredContent.effective as Record<string, unknown>
    expect(effective.denyTools).toContain('shell_exec')
    expect(effective.requireApprovalAtOrAbove).toBe('review')
  } finally {
    await server.close()
  }
})

function runFixture(cwd: string, runId: string, receiptOverrides: Record<string, unknown> = {}): void {
  const dir = join(cwd, '.elia', 'runs', runId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'receipt.json'), JSON.stringify({
    goal: 'ship the mcp server',
    outcome: 'success',
    createdAt: 1_700_000_000_000,
    completedAt: 1_700_000_002_000,
    elapsedMs: 2_000,
    model: 'claude-sonnet-4-5',
    usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ...receiptOverrides,
  }), 'utf8')
  writeFileSync(join(dir, 'actions.ndjson'), `${JSON.stringify({
    at: 1_700_000_000_100,
    actor: 'elia',
    role: 'executor',
    tool: 'write_file',
    input: { path: 'src/a.ts' },
    result: 'ok',
    isError: false,
    decision: 'allow',
    risk: 'low',
    durationMs: 12,
  })}\n`, 'utf8')
}

test('the run receipt takes a snake_case run id and answers in snake_case', async () => {
  const { server, cwd } = await started()
  try {
    runFixture(cwd, 'run1')
    const receipt = await callTool(server, 'elia_run_receipt', { run_id: 'run1', include_actions: true })
    expect(receipt.isError).toBeFalsy()
    const payload = receipt.structuredContent as Record<string, any>
    expect(payload.run.run_id).toBe('run1')
    expect(payload.run.started_at).toBe(1_700_000_000_000)
    expect(payload.run.completed_at).toBe(1_700_000_002_000)
    expect(payload.run.elapsed_ms).toBe(2_000)
    expect(payload.run.action_count).toBe(1)
    expect(payload.run.receipt_available).toBe(true)
    expect(payload.run).not.toHaveProperty('runId')
    expect(payload.run).not.toHaveProperty('elapsedMs')
    expect(payload.actions[0].is_error).toBe(false)
    expect(payload.actions[0].duration_ms).toBe(12)
    expect(payload.actions[0]).not.toHaveProperty('isError')
  } finally {
    await server.close()
  }
})

test('the run list and cost report answer in snake_case', async () => {
  const { server, cwd } = await started()
  try {
    runFixture(cwd, 'run1')
    const listed = await callTool(server, 'elia_runs_list', { include_incomplete: true })
    expect(listed.isError).toBeFalsy()
    expect(listed.structuredContent.runs[0].run_id).toBe('run1')

    const report = await callTool(server, 'elia_cost_report', { run_id: 'run1' })
    expect(report.isError).toBeFalsy()
    const payload = report.structuredContent as Record<string, any>
    expect(payload.estimate_only).toBe(true)
    expect(payload.runs[0].run_id).toBe('run1')
    expect(payload.runs[0].total_tokens).toBe(150)
    expect(payload.runs[0]).not.toHaveProperty('runId')
    expect(payload.totals.total_tokens).toBe(150)
    expect(typeof payload.totals.cost_known).toBe('boolean')
    expect(payload.totals).not.toHaveProperty('totalTokens')
  } finally {
    await server.close()
  }
})

test('a run diff accepts both spellings and reports snake_case sections', async () => {
  const { server, cwd } = await started()
  try {
    runFixture(cwd, 'run1')
    runFixture(cwd, 'run2', { elapsedMs: 4_000, usage: { inputTokens: 200, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 } })
    const diff = await callTool(server, 'elia_run_diff', { from_run_id: 'run1', to_run_id: 'run2' })
    expect(diff.isError).toBeFalsy()
    const payload = diff.structuredContent as Record<string, any>
    expect(payload.from_run_id).toBe('run1')
    expect(payload.to_run_id).toBe('run2')
    expect(payload.from_run.run_id).toBe('run1')
    expect(payload.metrics.elapsed_ms.delta).toBe(2_000)
    expect(payload.metrics.failed_actions).toBeDefined()
    expect(payload.receipt_changes).toBeDefined()
    expect(payload.tool_counts).toBeDefined()
    expect(payload.phase_counts).toBeDefined()
    expect(payload.file_activity.from_only).toEqual([])
    expect(payload.actions.from_truncated).toBe(false)
    expect(payload.evidence.action_ledgers).toEqual([1, 1])
    expect(payload.evidence.source_patch_available).toBe(false)
    expect(payload).not.toHaveProperty('fromRunId')
    expect(payload).not.toHaveProperty('fileActivity')

    const legacy = await callTool(server, 'elia_run_diff', { fromRunId: 'run1', toRunId: 'run2' })
    expect(legacy.isError).toBeFalsy()
    expect(legacy.structuredContent.from_run_id).toBe('run1')
  } finally {
    await server.close()
  }
})

test('a governance tool rejects two spellings of one argument that disagree', async () => {
  const { server, cwd } = await started()
  try {
    runFixture(cwd, 'run1')
    runFixture(cwd, 'run2')
    const conflictingRun = await callTool(server, 'elia_run_receipt', { run_id: 'run1', runId: 'run2' })
    expect(conflictingRun.isError).toBe(true)
    expect(conflictingRun.structuredContent.error.message).toContain('conflicting values')

    const conflictingFlag = await callTool(server, 'elia_run_receipt', { run_id: 'run1', include_actions: true, includeActions: false })
    expect(conflictingFlag.isError).toBe(true)
    expect(conflictingFlag.structuredContent.error.message).toContain('conflicting values')

    const agreeing = await callTool(server, 'elia_run_receipt', { run_id: 'run1', include_actions: true, includeActions: true })
    expect(agreeing.isError).toBeFalsy()

    const missing = await callTool(server, 'elia_run_receipt', {})
    expect(missing.isError).toBe(true)
    expect(missing.structuredContent.error.message).toContain('run_id')
  } finally {
    await server.close()
  }
})

async function initializedWith(protocolVersion: unknown): Promise<EliaMcpServer> {
  const server = await createEliaMcpServer({ cwd: project(), config: testConfig() })
  await server.handleRequest({ jsonrpc: '2.0', id: 'init', method: 'initialize', params: { ...INIT_PARAMS, protocolVersion } })
  return server
}

async function negotiatedWith(protocolVersion: unknown): Promise<any> {
  const server = await createEliaMcpServer({ cwd: project(), config: testConfig() })
  try {
    return await server.handleRequest({ jsonrpc: '2.0', id: 'init', method: 'initialize', params: { ...INIT_PARAMS, protocolVersion } })
  } finally {
    await server.close()
  }
}

test('initialize negotiates the version the client asked for', async () => {
  for (const version of ['2025-06-18', '2025-03-26', '2024-11-05']) {
    const response = await negotiatedWith(version)
    expect(response.result.protocolVersion).toBe(version)
  }
})

test('initialize falls back rather than echoing a version it does not speak', async () => {
  for (const unsupported of ['1999-01-01', 'latest', '']) {
    const response = await negotiatedWith(unsupported)
    expect(response.result.protocolVersion).toBe('2024-11-05')
  }
  const omitted = await negotiatedWith(undefined)
  expect(omitted.result.protocolVersion).toBe('2024-11-05')
})

test('a protocolVersion that is not a string is rejected instead of negotiated', async () => {
  for (const invalid of [7, null, { version: '2025-06-18' }, ['2025-06-18']]) {
    const response = await negotiatedWith(invalid)
    expect(response.result).toBeUndefined()
    expect(response.error.code).toBe(-32_602)
  }
})

test('structured output is offered only to a version that defines it', async () => {
  const modern = await initializedWith('2025-06-18')
  try {
    const listed = (await request(modern, 'tools/list')).result.tools as Array<Record<string, unknown>>
    expect(listed.length).toBe(39)
    expect(listed.every((tool) => tool.outputSchema !== undefined)).toBe(true)
    const called = await callTool(modern, 'elia_policy_read', {})
    expect(called.structuredContent).toBeDefined()
  } finally {
    await modern.close()
  }

  const legacy = await initializedWith('2024-11-05')
  try {
    const listed = (await request(legacy, 'tools/list')).result.tools as Array<Record<string, unknown>>
    expect(listed.length).toBe(39)
    for (const tool of listed) expect(tool).not.toHaveProperty('outputSchema')
    const called = await callTool(legacy, 'elia_policy_read', {})
    expect(called.structuredContent).toBeUndefined()
    expect(called.content[0].type).toBe('text')
  } finally {
    await legacy.close()
  }
})

test('requests after initialize do not reset the negotiated version', async () => {
  const server = await initializedWith('2025-06-18')
  try {
    await request(server, 'tools/list')
    await request(server, 'prompts/list')
    await callTool(server, 'elia_policy_read', {})
    const listed = (await request(server, 'tools/list')).result.tools as Array<Record<string, unknown>>
    expect(listed.every((tool) => tool.outputSchema !== undefined)).toBe(true)
  } finally {
    await server.close()
  }
})
