import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BRIDGE_METHODS, encodeBridgeMessage, isBridgeMethod, isBridgeRequest } from './vscodeBridgeProtocol.ts'

// The VS Code extension is compiled and packaged on its own (`rootDir: src`
// under extensions/vscode), so it cannot import this module and keeps its own
// copy of the wire types in bridgeClient.ts. These tests are the lockstep
// check that stops the two copies drifting apart.
const repoRoot = join(import.meta.dir, '..')
const read = (...parts: string[]) => readFileSync(join(repoRoot, ...parts), 'utf8').replace(/\r\n/g, '\n')
const server = read('src', 'vscodeBridgeProtocol.ts')
const client = read('extensions', 'vscode', 'src', 'bridgeClient.ts')

function unionMembers(source: string, typeName: string): string[] {
  const match = new RegExp(`export type ${typeName} =([\\s\\S]*?)\\n\\n`).exec(source)
  if (!match) throw new Error(`type ${typeName} not found`)
  return [...match[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!).sort()
}

function interfaceFields(source: string, name: string): string[] {
  const match = new RegExp(`interface ${name} \\{([\\s\\S]*?)\\n\\}`).exec(source)
  if (!match) throw new Error(`interface ${name} not found`)
  return [...match[1]!.matchAll(/^\s*(\w+\??):/gm)].map((m) => m[1]!).sort()
}

test('the extension speaks exactly the bridge methods the server defines', () => {
  const methods = unionMembers(server, 'BridgeMethod')
  expect(methods).toContain('tasks.list')
  expect(unionMembers(client, 'BridgeMethod')).toEqual(methods)
})

test('the extension reads the response envelope the server writes', () => {
  const fields = interfaceFields(server, 'BridgeResponse')
  expect(fields).toEqual(['error?', 'id', 'ok', 'result?', 'type'])
  expect(interfaceFields(client, 'BridgeResponse')).toEqual(fields)
})

test('accepts a bounded request envelope', () => {
  expect(isBridgeRequest({ id: 'request-1', method: 'tasks.list', params: {} })).toBe(true)
  expect(isBridgeRequest({ id: '', method: 'tasks.list' })).toBe(false)
  expect(isBridgeRequest({ id: 'request-1' })).toBe(false)
  expect(isBridgeRequest(null)).toBe(false)
})

test('only the declared bridge methods survive the envelope check', () => {
  expect(BRIDGE_METHODS.every((method) => isBridgeMethod(method))).toBe(true)
  // Arbitrary or attacker-picked method names never reach a handler boundary.
  expect(isBridgeMethod('shell.exec')).toBe(false)
  expect(isBridgeMethod('autonomous.approve_everything')).toBe(false)
  expect(isBridgeMethod('')).toBe(false)
  expect(isBridgeRequest({ id: 'request-1', method: 'deployment.run', params: {} })).toBe(true)
  expect(isBridgeRequest({ id: 'request-1', method: 'deployment.runx', params: {} })).toBe(false)
  expect(isBridgeRequest({ id: 'request-1', method: 'autonomous.approve', params: {} })).toBe(true)
  expect(isBridgeRequest({ id: 'request-1', method: 'shutdown', params: {} })).toBe(true)
})

test('encodes one JSON object per line', () => {
  const encoded = encodeBridgeMessage({ type: 'event', event: 'bridge_started', data: { version: 1 } })
  expect(encoded).toBe('{"type":"event","event":"bridge_started","data":{"version":1}}\n')
})
