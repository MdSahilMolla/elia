import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { McpClient, mcpChildEnv } from './client.ts'

const FIXTURE = join(import.meta.dir, 'fixtures', 'echoServer.ts')

function echoConfig() {
  return { name: 'echo', command: process.execPath, args: [FIXTURE] }
}

test('connects, lists tools, and calls a tool over real stdio JSON-RPC', async () => {
  const client = new McpClient(echoConfig())
  try {
    await client.connect()
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name).sort()).toEqual(['echo', 'explode'])

    const result = await client.callTool('echo', { text: 'hello' })
    expect(result.isError).toBeUndefined()
    expect(result.content?.[0]?.text).toBe('echo: hello')
  } finally {
    // closeAndWait (not close) — waits for the OS to actually reap the process,
    // so nothing is left for bun test's cross-file dangling-process sweep to
    // race against (that race was observed to surface as a stray EPIPE
    // "between tests" attributed to an unrelated file).
    await client.closeAndWait()
  }
})

test('surfaces isError results without throwing', async () => {
  const client = new McpClient(echoConfig())
  try {
    await client.connect()
    const result = await client.callTool('explode', {})
    expect(result.isError).toBe(true)
    expect(result.content?.[0]?.text).toBe('boom')
  } finally {
    await client.closeAndWait()
  }
})

test('rejects with the server error message for an unknown tool', async () => {
  const client = new McpClient(echoConfig())
  try {
    await client.connect()
    let error: unknown
    try {
      await client.callTool('does_not_exist', {})
    } catch (err) {
      error = err
    }
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('unknown tool does_not_exist')
  } finally {
    await client.closeAndWait()
  }
})

test('a request that times out is removed from the pending map instead of leaking forever', async () => {
  const client = new McpClient(echoConfig())
  try {
    await client.connect()
    const internals = client as unknown as {
      pending: Map<number, unknown>
      request(method: string, params: unknown, timeoutMs?: number, timeoutMessage?: string): Promise<unknown>
    }
    const baseline = internals.pending.size
    let error: unknown
    try {
      // The fixture deliberately never answers this method — see echoServer.ts.
      await internals.request('test/hang', {}, 25, 'timed out waiting for test/hang')
    } catch (err) {
      error = err
    }
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('timed out waiting for test/hang')
    // If the timeout path didn't clean up `pending`, this entry would still be
    // sitting there — the correlation map would have grown by one and stayed
    // that way for the life of the client.
    expect(internals.pending.size).toBe(baseline)
  } finally {
    await client.closeAndWait()
  }
})

test('a server that crashes rejects pending calls immediately (not after the full timeout) with its stderr', async () => {
  const client = new McpClient(echoConfig())
  try {
    await client.connect()
    const internals = client as unknown as {
      request(method: string, params: unknown, timeoutMs?: number, timeoutMessage?: string): Promise<unknown>
    }
    const startedAt = Date.now()
    let error: unknown
    try {
      // The fixture writes to stderr then exits without answering — a real
      // request timeout here would be CALL_TIMEOUT_MS (120s); draining stderr
      // and reacting to the dead process should fail this in well under a second.
      await internals.request('test/crash', {}, 60_000, 'should not reach the timeout')
    } catch (err) {
      error = err
    }
    expect(Date.now() - startedAt).toBeLessThan(5_000)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('simulated fatal error')
  } finally {
    await client.closeAndWait()
  }
})

test('a server that never answers trips the circuit, so the next call fails fast instead of pinning', async () => {
  const client = new McpClient(echoConfig())
  try {
    await client.connect()
    const internals = client as unknown as {
      request(method: string, params: unknown, timeoutMs?: number, timeoutMessage?: string): Promise<unknown>
      breaker: { isOpen(): boolean }
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(internals.request('test/hang', {}, 25, 'never answered')).rejects.toThrow('never answered')
    }
    expect(internals.breaker.isOpen()).toBe(true)
    const startedAt = Date.now()
    const error = await internals.request('test/hang', {}, 60_000, 'should not pin for the full timeout').catch((err: unknown) => err)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('open-circuited')
    expect(Date.now() - startedAt).toBeLessThan(1_000)
  } finally {
    await client.closeAndWait()
  }
})

test('close() rejects any still-pending call instead of hanging', async () => {
  const client = new McpClient(echoConfig())
  await client.connect()
  const pending = client.callTool('echo', { text: 'slow' })
  // Observe the rejection synchronously, before close() triggers it. Otherwise
  // there is a microtask window between close() rejecting the in-flight call and
  // the `await` below attaching a handler — `bun test` (1.3.0) on Windows runs
  // its unhandled-rejection check in that window and fails the test even though
  // the rejection is delivered correctly.
  const settled = pending.then(
    () => undefined,
    (err: unknown) => err,
  )
  client.close()
  const error = await settled
  expect(error).toBeInstanceOf(Error)
  await client.closeAndWait()
})

test('a spawned server gets a minimal environment, not elia\'s provider keys or ELIA_* settings', async () => {
  process.env.ANTHROPIC_API_KEY_TEST_SENTINEL = 'dummy-secret'
  process.env.ELIA_TEST_SENTINEL = 'dummy-setting'
  const client = new McpClient({ ...echoConfig(), env: { EXPLICIT_FROM_CONFIG: 'yes' } })
  try {
    await client.connect()
    const internals = client as unknown as { request(method: string, params: unknown, timeoutMs: number, message: string): Promise<{ value: string | null }> }
    const read = async (name: string) => (await internals.request('test/env', { name }, 5_000, 'no env answer')).value
    expect(await read('ANTHROPIC_API_KEY_TEST_SENTINEL')).toBeNull()
    expect(await read('ELIA_TEST_SENTINEL')).toBeNull()
    expect(await read('EXPLICIT_FROM_CONFIG')).toBe('yes')
    expect(await read('PATH')).toBe(process.env.PATH ?? null)
  } finally {
    delete process.env.ANTHROPIC_API_KEY_TEST_SENTINEL
    delete process.env.ELIA_TEST_SENTINEL
    await client.closeAndWait()
  }
})

test('mcpChildEnv keeps runtime basics and proxies, drops everything else, and lets explicit env win', () => {
  const env = mcpChildEnv(
    { PATH: '/explicit/bin', TOKEN: 'from-config' },
    { PATH: '/usr/bin', HOME: '/home/u', LC_ALL: 'C', HTTPS_PROXY: 'http://proxy', OPENAI_API_KEY: 'dummy', GITHUB_TOKEN: 'dummy', ELIA_SANDBOX: 'off' },
  )
  expect(env).toEqual({ PATH: '/explicit/bin', HOME: '/home/u', LC_ALL: 'C', HTTPS_PROXY: 'http://proxy', TOKEN: 'from-config' })
})
