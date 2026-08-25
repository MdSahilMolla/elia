import { expect, test, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadMcpTools, resetMcpLoadStateForTests } from './registry.ts'
import { findTool, getMcpTools } from '../tools/registry.ts'

const FIXTURE = join(import.meta.dir, 'fixtures', 'echoServer.ts')

afterEach(async () => {
  await resetMcpLoadStateForTests()
})

function projectWithServer(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'elia-mcp-registry-'))
  mkdirSync(join(cwd, '.elia'), { recursive: true })
  writeFileSync(
    join(cwd, '.elia', 'mcp.json'),
    JSON.stringify({ mcpServers: { echo: { command: process.execPath, args: [FIXTURE] } } }),
    'utf8',
  )
  return cwd
}

test('connects to a configured server and registers its tools into the shared tool registry', async () => {
  const cwd = projectWithServer()
  const report = await loadMcpTools(cwd)

  expect(report.servers).toEqual(['echo'])
  expect(report.failed).toEqual([])
  expect(report.loaded.map((t) => t.name).sort()).toEqual(['mcp_echo_echo', 'mcp_echo_explode'])

  const tool = findTool('mcp_echo_echo')
  expect(tool).toBeDefined()
  expect(tool!.description).toContain('[MCP: echo]')

  const result = await tool!.execute({ text: 'hi' })
  expect(result).toBe('echo: hi')
})

test('an error result from the tool is prefixed rather than thrown', async () => {
  const cwd = projectWithServer()
  await loadMcpTools(cwd)
  const tool = findTool('mcp_echo_explode')
  const result = await tool!.execute({})
  expect(result).toBe('MCP tool error: boom')
})

test('a server that fails to start is reported, not thrown, and does not block other servers', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'elia-mcp-registry-'))
  mkdirSync(join(cwd, '.elia'), { recursive: true })
  writeFileSync(
    join(cwd, '.elia', 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        // A genuinely missing binary — Bun.spawn throws synchronously (ENOENT)
        // rather than starting a process that dies moments later, which keeps
        // this test from racing a real subprocess's stdin pipe teardown.
        broken: { command: 'elia-mcp-server-that-does-not-exist' },
        echo: { command: process.execPath, args: [FIXTURE] },
      },
    }),
    'utf8',
  )

  const report = await loadMcpTools(cwd)
  expect(report.servers).toEqual(['echo'])
  expect(report.failed.map((f) => f.server)).toEqual(['broken'])
  expect(getMcpTools().map((t) => t.name).sort()).toEqual(['mcp_echo_echo', 'mcp_echo_explode'])
})

test('a disabled server is skipped entirely', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'elia-mcp-registry-'))
  mkdirSync(join(cwd, '.elia'), { recursive: true })
  writeFileSync(
    join(cwd, '.elia', 'mcp.json'),
    JSON.stringify({ mcpServers: { echo: { command: process.execPath, args: [FIXTURE], disabled: true } } }),
    'utf8',
  )

  const report = await loadMcpTools(cwd)
  expect(report.servers).toEqual([])
  expect(report.loaded).toEqual([])
})

test('loadMcpTools is idempotent within a process — a second call reuses the cached report', async () => {
  const cwd = projectWithServer()
  const first = await loadMcpTools(cwd)
  const second = await loadMcpTools(cwd)
  expect(second).toBe(first)
})
