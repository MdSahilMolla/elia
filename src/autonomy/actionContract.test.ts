import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { contractForAction, evaluatePostconditions, evaluatePreconditions } from './actionContract.ts'

describe('action contracts', () => {
  test('creates an idempotent command contract with a precondition and exit-code postcondition', async () => {
    const contract = contractForAction({ name: 'run_command', input: { command: 'bun --version' } }, process.cwd(), 'run:command:1')
    expect(contract.idempotencyKey).toBe('run:command:1')
    expect(contract.preconditions[0]).toMatchObject({ kind: 'command-available', value: 'bun' })
    expect(contract.postconditions).toEqual([{ kind: 'shell-exit-zero', description: 'the command must return exit code 0 and not time out' }])
    expect((await evaluatePreconditions(contract, process.cwd())).ok).toBe(true)
    expect(evaluatePostconditions(contract, 'exit code: 0\nstdout:\n1.2.3', process.cwd())).toMatchObject({ ok: true, phase: 'postcondition' })
  })

  test('does not mark a timed-out or non-zero command as verified', () => {
    const contract = contractForAction({ name: 'run_command', input: { command: 'bun test' } }, process.cwd(), 'run:command:2')
    expect(evaluatePostconditions(contract, 'exit code: 1\nstderr:\nfailed', process.cwd())).toMatchObject({ ok: false, failures: ['command did not return exit code 0 (exit code 1)'] })
    expect(evaluatePostconditions(contract, 'timed out after 1000ms (killed)', process.cwd())).toMatchObject({ ok: false, failures: ['command timed out'] })
  })

  test('requires configured browser transport and preserves takeover for browser mutations', async () => {
    const previous = {
      cdp: process.env.ELIA_BROWSER_CDP_URL,
      mcp: process.env.ELIA_BROWSER_MCP_SERVER,
      bridge: process.env.ELIA_BROWSER_BRIDGE_COMMAND,
    }
    delete process.env.ELIA_BROWSER_CDP_URL
    delete process.env.ELIA_BROWSER_MCP_SERVER
    delete process.env.ELIA_BROWSER_BRIDGE_COMMAND
    try {
      const contract = contractForAction({ name: 'browser', input: { action: 'click', target: 'Publish', expectUrl: 'https://example.test/done' } }, process.cwd(), 'run:browser:1')
      expect(contract.requiresUserTakeover).toBe(true)
      expect(contract.failureDisposition).toBe('human-review')
      expect((await evaluatePreconditions(contract, process.cwd())).ok).toBe(false)
      process.env.ELIA_BROWSER_CDP_URL = 'ws://configured-for-test'
      expect((await evaluatePreconditions(contract, process.cwd())).ok).toBe(true)
      expect(evaluatePostconditions(contract, '{\n  "url": "https://example.test/start"\n}', process.cwd())).toMatchObject({ ok: false })
      expect(evaluatePostconditions(contract, '{\n  "url": "https://example.test/done"\n}', process.cwd())).toMatchObject({ ok: true })
    } finally {
      if (previous.cdp === undefined) delete process.env.ELIA_BROWSER_CDP_URL
      else process.env.ELIA_BROWSER_CDP_URL = previous.cdp
      if (previous.mcp === undefined) delete process.env.ELIA_BROWSER_MCP_SERVER
      else process.env.ELIA_BROWSER_MCP_SERVER = previous.mcp
      if (previous.bridge === undefined) delete process.env.ELIA_BROWSER_BRIDGE_COMMAND
      else process.env.ELIA_BROWSER_BRIDGE_COMMAND = previous.bridge
    }
  })

  test('verifies a workspace artifact after a write', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'elia-contract-'))
    mkdirSync(join(cwd, 'out'))
    const target = join(cwd, 'out', 'report.txt')
    const contract = contractForAction({ name: 'write_file', input: { path: 'out/report.txt' } }, cwd, 'run:file:1')
    expect(contract.preconditions[0]?.kind).toBe('workspace-path')
    expect(evaluatePostconditions(contract, 'written', cwd)).toMatchObject({ ok: false })
    writeFileSync(target, 'verified')
    expect(evaluatePostconditions(contract, 'written', cwd)).toMatchObject({ ok: true, evidence: [`artifact exists: out/report.txt`] })
  })
})
