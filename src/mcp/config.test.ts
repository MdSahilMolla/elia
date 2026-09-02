import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  findMcpServerScope,
  loadMcpServerConfigs as loadMcpServerConfigsRaw,
  mcpTransportKind,
  removeMcpServer,
  serverConfigToEntry,
  setMcpServerDisabled,
  upsertMcpServer,
} from './config.ts'

// Isolate every test from whatever the real ~/.elia/mcp.json on this machine
// happens to contain — always point the "user" layer at a path that doesn't exist.
function loadMcpServerConfigs(cwd: string) {
  return loadMcpServerConfigsRaw(cwd, join(cwd, 'no-such-user-config.json'))
}

function writeProjectConfig(cwd: string, json: unknown): void {
  mkdirSync(join(cwd, '.elia'), { recursive: true })
  writeFileSync(join(cwd, '.elia', 'mcp.json'), JSON.stringify(json), 'utf8')
}

test('returns no servers and no errors when no config file exists', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'elia-mcp-config-'))
  const { servers, errors } = loadMcpServerConfigs(cwd)
  expect(servers).toEqual([])
  expect(errors).toEqual([])
})

test('parses a valid project mcpServers file', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'elia-mcp-config-'))
  writeProjectConfig(cwd, { mcpServers: { demo: { command: 'node', args: ['server.js'], env: { TOKEN: 'x' } } } })
  const { servers, errors } = loadMcpServerConfigs(cwd)
  expect(errors).toEqual([])
  expect(servers).toEqual([{ name: 'demo', command: 'node', args: ['server.js'], env: { TOKEN: 'x' }, disabled: false }])
})

test('skips a server missing "command" and reports why, without dropping the others', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'elia-mcp-config-'))
  writeProjectConfig(cwd, { mcpServers: { broken: { args: ['x'] }, good: { command: 'node' } } })
  const { servers, errors } = loadMcpServerConfigs(cwd)
  expect(servers.map((s) => s.name)).toEqual(['good'])
  expect(errors.some((e) => e.includes('broken'))).toBe(true)
})

test('reports invalid JSON instead of throwing', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'elia-mcp-config-'))
  mkdirSync(join(cwd, '.elia'), { recursive: true })
  writeFileSync(join(cwd, '.elia', 'mcp.json'), '{ not json', 'utf8')
  const { servers, errors } = loadMcpServerConfigs(cwd)
  expect(servers).toEqual([])
  expect(errors[0]).toContain('invalid JSON')
})

test('a disabled server is still parsed, so callers can see it was intentionally skipped', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'elia-mcp-config-'))
  writeProjectConfig(cwd, { mcpServers: { demo: { command: 'node', disabled: true } } })
  const { servers } = loadMcpServerConfigs(cwd)
  expect(servers).toEqual([{ name: 'demo', command: 'node', args: undefined, env: undefined, disabled: true }])
})

test('parses a remote connector entry (url + headers) as an http transport', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'elia-mcp-config-'))
  writeProjectConfig(cwd, { mcpServers: { notion: { url: 'https://mcp.notion.com/mcp', headers: { Authorization: 'Bearer x' } } } })
  const { servers, errors } = loadMcpServerConfigs(cwd)
  expect(errors).toEqual([])
  expect(servers).toEqual([{ name: 'notion', url: 'https://mcp.notion.com/mcp', headers: { Authorization: 'Bearer x' }, disabled: false }])
  expect(mcpTransportKind(servers[0]!)).toBe('http')
})

test('honours an explicit sse transport on a connector', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'elia-mcp-config-'))
  writeProjectConfig(cwd, { mcpServers: { linear: { url: 'https://mcp.linear.app/sse', transport: 'sse' } } })
  const { servers } = loadMcpServerConfigs(cwd)
  expect(mcpTransportKind(servers[0]!)).toBe('sse')
})

test('skips an entry that has neither command nor url', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'elia-mcp-config-'))
  writeProjectConfig(cwd, { mcpServers: { bad: { args: ['x'] }, ok: { url: 'https://e.com/mcp' } } })
  const { servers, errors } = loadMcpServerConfigs(cwd)
  expect(servers.map((s) => s.name)).toEqual(['ok'])
  expect(errors.some((e) => e.includes('bad'))).toBe(true)
})

test('serverConfigToEntry drops name and empty maps', () => {
  expect(serverConfigToEntry({ command: 'npx', args: ['-y', 'pkg'] })).toEqual({ command: 'npx', args: ['-y', 'pkg'] })
  expect(serverConfigToEntry({ command: 'node', args: [], env: {} })).toEqual({ command: 'node' })
  expect(serverConfigToEntry({ url: 'https://e.com/mcp', transport: 'http', headers: {} })).toEqual({ url: 'https://e.com/mcp' })
  expect(serverConfigToEntry({ url: 'https://e.com/sse', transport: 'sse', disabled: true })).toEqual({ url: 'https://e.com/sse', transport: 'sse', disabled: true })
})

test('upsertMcpServer writes a new project config, then a second call adds alongside the first', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'elia-mcp-config-'))
  const path = upsertMcpServer('project', { name: 'gh', command: 'npx', args: ['-y', 'server-github'] }, cwd)
  expect(path).toBe(join(cwd, '.elia', 'mcp.json'))
  upsertMcpServer('project', { name: 'notion', url: 'https://mcp.notion.com/mcp', headers: { Authorization: 'Bearer x' } }, cwd)

  const written = JSON.parse(readFileSync(path, 'utf8'))
  expect(Object.keys(written.mcpServers).sort()).toEqual(['gh', 'notion'])
  expect(written.mcpServers.notion).toEqual({ url: 'https://mcp.notion.com/mcp', headers: { Authorization: 'Bearer x' } })

  const { servers } = loadMcpServerConfigs(cwd)
  expect(servers.map((s) => s.name).sort()).toEqual(['gh', 'notion'])
})

test('upsertMcpServer preserves unrelated top-level keys in the file', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'elia-mcp-config-'))
  mkdirSync(join(cwd, '.elia'), { recursive: true })
  writeFileSync(join(cwd, '.elia', 'mcp.json'), JSON.stringify({ $schema: './x.json', mcpServers: {} }), 'utf8')
  upsertMcpServer('project', { name: 'gh', command: 'npx' }, cwd)
  const written = JSON.parse(readFileSync(join(cwd, '.elia', 'mcp.json'), 'utf8'))
  expect(written.$schema).toBe('./x.json')
})

test('upsertMcpServer rejects an invalid server name', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'elia-mcp-config-'))
  expect(() => upsertMcpServer('project', { name: '1bad name', command: 'node' }, cwd)).toThrow(/invalid server name/)
})

test('removeMcpServer deletes just the named entry and reports whether it was there', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'elia-mcp-config-'))
  upsertMcpServer('project', { name: 'a', command: 'node' }, cwd)
  upsertMcpServer('project', { name: 'b', command: 'node' }, cwd)
  expect(removeMcpServer('project', 'a', cwd).removed).toBe(true)
  expect(removeMcpServer('project', 'a', cwd).removed).toBe(false)
  expect(loadMcpServerConfigs(cwd).servers.map((s) => s.name)).toEqual(['b'])
})

test('setMcpServerDisabled toggles the flag and returns null for an unknown server', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'elia-mcp-config-'))
  upsertMcpServer('project', { name: 'a', command: 'node' }, cwd)
  expect(setMcpServerDisabled('project', 'a', true, cwd)).toEqual({ path: join(cwd, '.elia', 'mcp.json'), disabled: true })
  expect(loadMcpServerConfigs(cwd).servers[0]!.disabled).toBe(true)
  expect(setMcpServerDisabled('project', 'a', false, cwd)).toEqual({ path: join(cwd, '.elia', 'mcp.json'), disabled: false })
  expect(loadMcpServerConfigs(cwd).servers[0]!.disabled).toBe(false)
  expect(setMcpServerDisabled('project', 'missing', true, cwd)).toBeNull()
})

test('findMcpServerScope reports which layer a server lives in', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'elia-mcp-config-'))
  const userPath = join(cwd, 'user-mcp.json')
  writeFileSync(userPath, JSON.stringify({ mcpServers: { userone: { command: 'node' } } }), 'utf8')
  upsertMcpServer('project', { name: 'projone', command: 'node' }, cwd)
  expect(findMcpServerScope('projone', cwd, userPath)).toBe('project')
  expect(findMcpServerScope('userone', cwd, userPath)).toBe('user')
  expect(findMcpServerScope('nope', cwd, userPath)).toBeNull()
  expect(existsSync(userPath)).toBe(true)
})
