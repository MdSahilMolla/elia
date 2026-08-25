import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadMcpServerConfigs as loadMcpServerConfigsRaw } from './config.ts'

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
