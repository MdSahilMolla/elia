import { expect, test, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beginMcpLoad, loadMcpTools, mcpStatusReport, reloadMcpTools, resetMcpLoadStateForTests } from './registry.ts'
import { findTool, getMcpTools } from '../tools/registry.ts'

const FIXTURE = join(import.meta.dir, 'fixtures', 'echoServer.ts')

// Never merge in this machine's real ~/.elia/mcp.json — point the user layer at a path that won't exist.
process.env.ELIA_MCP_USER_CONFIG = join(tmpdir(), 'elia-registry-test-no-such-user-mcp.json')

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

test('beginMcpLoad hands every caller the same in-flight connect pass, not an empty report', async () => {
  const cwd = projectWithServer()
  // Two callers race for the load before it has resolved (the interactive
  // startup kickoff, then loadRuntimeSkills awaiting it) — both must get the
  // real connected report, never the pre-connect empty one.
  const [a, b] = await Promise.all([beginMcpLoad(cwd), beginMcpLoad(cwd)])
  expect(a).toBe(b)
  expect(a.servers).toEqual(['echo'])
})

test('reloadMcpTools resets beginMcpLoad so it reflects the new config', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'elia-mcp-registry-'))
  mkdirSync(join(cwd, '.elia'), { recursive: true })
  const configPath = join(cwd, '.elia', 'mcp.json')
  writeFileSync(configPath, JSON.stringify({ mcpServers: {} }), 'utf8')
  expect((await beginMcpLoad(cwd)).servers).toEqual([])

  writeFileSync(configPath, JSON.stringify({ mcpServers: { echo: { command: process.execPath, args: [FIXTURE] } } }), 'utf8')
  await reloadMcpTools(cwd)
  expect((await beginMcpLoad(cwd)).servers).toEqual(['echo'])
})

test('report.status describes every configured server, connected or disabled', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'elia-mcp-registry-'))
  mkdirSync(join(cwd, '.elia'), { recursive: true })
  writeFileSync(
    join(cwd, '.elia', 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        echo: { command: process.execPath, args: [FIXTURE] },
        off: { command: process.execPath, args: [FIXTURE], disabled: true },
      },
    }),
    'utf8',
  )
  const report = await loadMcpTools(cwd)
  const byName = Object.fromEntries(report.status.map((s) => [s.name, s]))
  expect(byName.echo!.connected).toBe(true)
  expect(byName.echo!.toolCount).toBe(2)
  expect(byName.off!.disabled).toBe(true)
  expect(byName.off!.connected).toBe(false)
  expect(mcpStatusReport()).toBe(report)
})

test('a hung server does not block loadMcpTools past the soft deadline; healthy servers still register', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'elia-mcp-registry-'))
  mkdirSync(join(cwd, '.elia'), { recursive: true })
  const slow = join(import.meta.dir, 'fixtures', 'slowServer.ts')
  writeFileSync(
    join(cwd, '.elia', 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        echo: { command: process.execPath, args: [FIXTURE] },
        hung: { command: process.execPath, args: [slow] },
      },
    }),
    'utf8',
  )

  const startedAt = Date.now()
  process.env.ELIA_MCP_CONNECT_DEADLINE_MS = '800'
  try {
    const report = await loadMcpTools(cwd)
    const elapsed = Date.now() - startedAt
    // Returned well before the 30s connect timeout the hung server would hit.
    expect(elapsed).toBeLessThan(5000)
    // The healthy server still connected and registered its tools.
    expect(report.servers).toContain('echo')
    expect(findTool('mcp_echo_echo')).toBeDefined()
  } finally {
    delete process.env.ELIA_MCP_CONNECT_DEADLINE_MS
  }
})

test('reloadMcpTools picks up a newly added server without a process restart', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'elia-mcp-registry-'))
  mkdirSync(join(cwd, '.elia'), { recursive: true })
  const configPath = join(cwd, '.elia', 'mcp.json')
  writeFileSync(configPath, JSON.stringify({ mcpServers: {} }), 'utf8')

  expect((await loadMcpTools(cwd)).servers).toEqual([])

  writeFileSync(configPath, JSON.stringify({ mcpServers: { echo: { command: process.execPath, args: [FIXTURE] } } }), 'utf8')
  const reloaded = await reloadMcpTools(cwd)
  expect(reloaded.servers).toEqual(['echo'])
  expect(findTool('mcp_echo_echo')).toBeDefined()
})
