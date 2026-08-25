import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { McpClient } from './client.ts'

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

test('close() rejects any still-pending call instead of hanging', async () => {
  const client = new McpClient(echoConfig())
  await client.connect()
  const pending = client.callTool('echo', { text: 'slow' })
  client.close()
  let error: unknown
  try {
    await pending
  } catch (err) {
    error = err
  }
  expect(error).toBeInstanceOf(Error)
  await client.closeAndWait()
})
