import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LspClient } from './client.ts'

const FIXTURE = join(import.meta.dir, 'fixtures', 'diagnosticServer.ts')

function newClient(root: string): LspClient {
  return new LspClient(process.execPath, [FIXTURE], 'fixture', root)
}

test('connects and publishes an empty diagnostics list for clean text', async () => {
  const root = mkdtempSync(join(tmpdir(), 'elia-lsp-client-'))
  const file = join(root, 'clean.txt')
  writeFileSync(file, 'nothing wrong here', 'utf8')
  const client = newClient(root)
  try {
    await client.connect()
    const diagnostics = await client.diagnosticsFor(file, 'nothing wrong here')
    expect(diagnostics).toEqual([])
  } finally {
    await client.closeAndWait()
  }
})

test('surfaces a real diagnostic reported by the server', async () => {
  const root = mkdtempSync(join(tmpdir(), 'elia-lsp-client-'))
  const file = join(root, 'broken.txt')
  const client = newClient(root)
  try {
    await client.connect()
    const diagnostics = await client.diagnosticsFor(file, 'const x = ERROR_MARKER')
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]?.message).toBe('found ERROR_MARKER')
    expect(diagnostics[0]?.severity).toBe(1)
  } finally {
    await client.closeAndWait()
  }
})

test('a second diagnosticsFor call (didChange) reflects the new content, not the old', async () => {
  const root = mkdtempSync(join(tmpdir(), 'elia-lsp-client-'))
  const file = join(root, 'evolving.txt')
  const client = newClient(root)
  try {
    await client.connect()
    const first = await client.diagnosticsFor(file, 'const x = ERROR_MARKER')
    expect(first).toHaveLength(1)
    const second = await client.diagnosticsFor(file, 'const x = 1 // fixed')
    expect(second).toEqual([])
  } finally {
    await client.closeAndWait()
  }
})

test('close() rejects any still-pending request instead of hanging', async () => {
  const root = mkdtempSync(join(tmpdir(), 'elia-lsp-client-'))
  const client = newClient(root)
  await client.connect()
  // Fire a request and close in the same synchronous tick (no await in
  // between) so close() is guaranteed to win the race against the fixture's
  // reply, exactly like the equivalent MCP client test.
  const pending = (client as unknown as { request(method: string, params: unknown): Promise<unknown> }).request('workspace/symbol', {})
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
