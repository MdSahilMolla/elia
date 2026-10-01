import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ActionAssessment, ActionRequest } from '../autonomy/governor.ts'
import type { EliaMcpServerConfig } from './config.ts'
import { createMcpServerRuntime } from './serverRuntime.ts'

function config(approvalMode: EliaMcpServerConfig['approvalMode']): EliaMcpServerConfig {
  return {
    transport: 'stdio',
    port: 0,
    host: '127.0.0.1',
    tokenPath: join(tmpdir(), 'elia-mcp-runtime-test-no-such-token'),
    allowedOperations: ['*'],
    approvalMode,
    streamProgress: false,
    domainAutoDetect: false,
    allowRemoteHost: false,
    maxConcurrentSessions: 4,
    costLimitPerSessionUsd: null,
  }
}

function project(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'elia-mcp-runtime-'))
  mkdirSync(join(cwd, '.elia'), { recursive: true })
  return cwd
}

test("approvalMode 'always' asks for a declared approve-gated mutation and a denial blocks it", async () => {
  const seen: Array<{ assessment: ActionAssessment; action: ActionRequest }> = []
  const runtime = await createMcpServerRuntime({
    config: config('always'),
    cwd: project(),
    approve: async (assessment, action) => {
      seen.push({ assessment, action })
      return false
    },
  })
  let ran = false
  await expect(runtime.governedMutation('promote', {}, () => { ran = true })).rejects.toThrow('not approved')
  expect(ran).toBe(false)
  expect(seen).toHaveLength(1)
  expect(seen[0]!.action.name).toBe('promote')
  expect(seen[0]!.assessment.decision).toBe('approve')
  runtime.dispose()
})

test("approvalMode 'always' runs the mutation once approved, and refuses without any approval callback", async () => {
  const approved = await createMcpServerRuntime({ config: config('always'), cwd: project(), approve: async () => true })
  let ran = 0
  await approved.governedMutation('evolve', {}, () => { ran++ })
  expect(ran).toBe(1)

  const none = await createMcpServerRuntime({ config: config('always'), cwd: project() })
  await expect(none.governedMutation('evolve', {}, () => { ran++ })).rejects.toThrow('approval callback')
  expect(ran).toBe(1)
})

test("a critical policy_update is refused when the callback denies it, even in 'auto'", async () => {
  const runtime = await createMcpServerRuntime({ config: config('auto'), cwd: project(), approve: async () => false })
  let ran = false
  await expect(runtime.governedMutation('policy_update', {}, () => { ran = true })).rejects.toThrow('not approved')
  expect(ran).toBe(false)
})
