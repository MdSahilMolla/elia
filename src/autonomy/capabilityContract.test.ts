import { expect, test } from 'bun:test'
import { allBuiltinTools, assertBuiltinCapabilityContracts } from '../tools/registry.ts'
import { builtinCapabilityContracts, capabilityContractFor, missingCapabilityContracts } from './capabilityContract.ts'

test('every built-in registry tool has exactly one capability contract', () => {
  expect(assertBuiltinCapabilityContracts).not.toThrow()
  const tools = allBuiltinTools()
  expect(missingCapabilityContracts(tools)).toEqual([])
  expect(new Set(builtinCapabilityContracts().map((entry) => entry.tool)).size).toBe(builtinCapabilityContracts().length)
})

test('unknown dynamic tools do not inherit a permissive capability contract', () => {
  expect(capabilityContractFor('unreviewed_mcp_tool')).toBeUndefined()
  expect(missingCapabilityContracts([{ name: 'unreviewed_mcp_tool' }])).toEqual(['unreviewed_mcp_tool'])
})

test('external effects remain explicitly critical', () => {
  expect(capabilityContractFor('browser')).toMatchObject({ risk: 'critical', idempotent: false })
  expect(capabilityContractFor('deployment')).toMatchObject({ risk: 'critical', idempotent: false })
  expect(capabilityContractFor('communication')).toMatchObject({ risk: 'critical', idempotent: false })
})
