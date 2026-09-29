import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BoxUnavailable,
  boxFallbackToHost,
  boxPolicyFor,
  boxSandboxRequested,
  findBoxBinary,
  recentBoxReceipts,
  resetBoxReceiptsForTests,
  runInBox,
  runShellInBox,
  shellResultFromBox,
  toolReadPaths,
  type BoxRun,
} from './box.ts'
import { runShell } from '../shell.ts'

const saved = { ...process.env }
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
  Object.assign(process.env, saved)
  resetBoxReceiptsForTests()
})

function fakeRun(over: Partial<BoxRun['receipt']['exit']> = {}, truncated = false): BoxRun {
  return {
    stdout: 'out',
    stderr: 'err',
    receipt: {
      schema: 'elia-box.receipt/1',
      id: 'abc123',
      backend: 'seatbelt',
      argv: ['x'],
      policyHash: 'h',
      exit: { code: 0, signal: null, timedOut: false, interrupted: false, limitHit: null, stragglersKilled: false, ...over },
      usage: { wallMs: 42, cpuUserMs: 1, cpuSysMs: 1, maxRssKb: 1, peakTreeRssKb: 1, peakProcs: 1 },
      output: { stdoutBytes: 3, stderrBytes: 3, stdoutSha256: 's', stderrSha256: 's', truncated },
      workspace: { path: '/w', mode: 'inplace', forked: false, copyOnWrite: false, forkPath: null, snapshot: null },
      network: { mode: 'none', allow: [], broker: null },
      containment: { enforced: [], notEnforced: [] },
      receiptHash: 'r',
    },
  }
}

describe('opt-in and fail-closed switches', () => {
  test('the box is requested only by ELIA_SANDBOX=box', () => {
    delete process.env.ELIA_SANDBOX
    expect(boxSandboxRequested()).toBe(false)
    process.env.ELIA_SANDBOX = 'container'
    expect(boxSandboxRequested()).toBe(false)
    process.env.ELIA_SANDBOX = 'BOX'
    expect(boxSandboxRequested()).toBe(true)
  })

  test('falling back to the host must be asked for by name', () => {
    delete process.env.ELIA_BOX_FALLBACK
    expect(boxFallbackToHost()).toBe(false)
    process.env.ELIA_BOX_FALLBACK = 'host'
    expect(boxFallbackToHost()).toBe(true)
  })
})

describe('policy construction', () => {
  test('defaults: no network, cleared environment, only PATH and harmless names carried in', () => {
    delete process.env.ELIA_BOX_NETWORK
    process.env.ANTHROPIC_API_KEY = 'sk-secret'
    const p = boxPolicyFor('/work', 5000, { FOO: 'bar' })
    expect(p.network).toEqual({ mode: 'none' })
    expect(p.mode).toBe('inplace')
    expect(p.limits?.wallMs).toBe(5000)
    expect(Object.keys(p.env ?? {}).sort()).toEqual(['FOO', 'PATH'])
    expect(JSON.stringify(p)).not.toContain('sk-secret')
    expect(p.envPassthrough).not.toContain('ANTHROPIC_API_KEY')
  })

  test('network modes come from the environment; brokered carries its allowlist', () => {
    process.env.ELIA_BOX_NETWORK = 'brokered'
    process.env.ELIA_BOX_ALLOW = 'pypi.org, *.pythonhosted.org'
    expect(boxPolicyFor('/w', 1).network).toEqual({ mode: 'brokered', allow: ['pypi.org', '*.pythonhosted.org'] })
    process.env.ELIA_BOX_NETWORK = 'open'
    expect(boxPolicyFor('/w', 1).network).toEqual({ mode: 'open' })
    process.env.ELIA_BOX_NETWORK = 'nonsense'
    expect(boxPolicyFor('/w', 1).network).toEqual({ mode: 'none' })
  })

  test('toolReadPaths lists real PATH dirs and known tool installs only', () => {
    const home = mkdtempSync(join(tmpdir(), 'eb-home-'))
    mkdirSync(join(home, '.bun'))
    mkdirSync(join(home, '.ssh'))
    const paths = toolReadPaths(`/usr/bin:/definitely/not/here:relative/bin`, home)
    expect(paths).toContain('/usr/bin')
    expect(paths).toContain(join(home, '.bun'))
    expect(paths.some((p) => p.includes('.ssh'))).toBe(false)
    expect(paths.some((p) => p.includes('not/here') || p.startsWith('relative'))).toBe(false)
    rmSync(home, { recursive: true })
  })
})

describe('result mapping', () => {
  test('a clean run maps straight through', () => {
    const r = shellResultFromBox('echo', fakeRun())
    expect(r).toMatchObject({ exitCode: 0, stdout: 'out', stderr: 'err', elapsedMs: 42, timedOut: false })
  })

  test('a kill is explained in stderr and given a shell-style exit code', () => {
    const r = shellResultFromBox('x', fakeRun({ code: null, signal: 9, limitHit: 'memory' }))
    expect(r.exitCode).toBe(137)
    expect(r.stderr).toContain('memory limit reached')
    expect(r.stderr).toContain('abc123')
  })

  test('timeouts and truncation are surfaced', () => {
    const r = shellResultFromBox('x', fakeRun({ code: null, signal: 9, timedOut: true }, true))
    expect(r.timedOut).toBe(true)
    expect(r.stderr).toContain('wall-clock limit')
    expect(r.stderr).toContain('output truncated')
  })
})

const bin = findBoxBinary()
const live = bin && process.platform === 'darwin' ? describe : describe.skip

live('live: elia-box on this machine (seatbelt)', () => {
  test('runs a command, seals a receipt, and keeps the environment clean', async () => {
    const ws = realpathSync(mkdtempSync(join(tmpdir(), 'eb-ws-')))
    process.env.ANTHROPIC_API_KEY = 'sk-must-not-leak'
    try {
      const r = await runShellInBox('echo ok; echo "key=[$ANTHROPIC_API_KEY]"; echo data > f.txt', 20_000, ws)
      expect(r.exitCode).toBe(0)
      expect(r.stdout).toContain('ok')
      expect(r.stdout).toContain('key=[]')
      expect(readFileSync(join(ws, 'f.txt'), 'utf8')).toBe('data\n')
      const [receipt] = recentBoxReceipts()
      expect(receipt?.backend).toBe('seatbelt')
      expect(receipt?.containment.enforced).toContain('network.none')
      expect(receipt?.receiptHash).toMatch(/^[0-9a-f]{64}$/)
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  test('cannot read outside the allowlist or write outside the workspace', async () => {
    const ws = realpathSync(mkdtempSync(join(tmpdir(), 'eb-ws-')))
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'eb-out-')))
    writeFileSync(join(outside, 'secret'), 'TOPSECRET')
    try {
      const r = await runShellInBox(`cat ${outside}/secret; echo x > ${outside}/planted`, 20_000, ws)
      expect(r.stdout).not.toContain('TOPSECRET')
      expect(r.stderr).toContain('Operation not permitted')
      expect(existsSync(join(outside, 'planted'))).toBe(false)
    } finally {
      rmSync(ws, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test('fork mode leaves the original untouched and reports the diff', async () => {
    const ws = realpathSync(mkdtempSync(join(tmpdir(), 'eb-ws-')))
    writeFileSync(join(ws, 'a.txt'), 'before')
    try {
      const policy = { ...boxPolicyFor(ws, 20_000), mode: 'fork' as const }
      const run = await runInBox(policy, ['/bin/sh', '-c', 'echo after > a.txt; echo n > new.txt'])
      expect(readFileSync(join(ws, 'a.txt'), 'utf8')).toBe('before')
      expect(existsSync(join(ws, 'new.txt'))).toBe(false)
      expect(run.receipt.workspace.snapshot?.changes).toEqual({ added: ['new.txt'], modified: ['a.txt'], deleted: [] })
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  test('the wall clock kills a runaway command', async () => {
    const ws = realpathSync(mkdtempSync(join(tmpdir(), 'eb-ws-')))
    try {
      const r = await runShellInBox('sleep 60', 700, ws)
      expect(r.timedOut).toBe(true)
      expect(r.elapsedMs).toBeLessThan(8000)
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  test('a policy the box refuses runs nothing and says why', async () => {
    const ws = realpathSync(mkdtempSync(join(tmpdir(), 'eb-ws-')))
    try {
      const policy = { ...boxPolicyFor(ws, 5000), network: { mode: 'brokered' as const, allow: [] } }
      await expect(runInBox(policy, ['/bin/echo', 'x'])).rejects.toThrow(/refused the run \(policy\)/)
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  test('runShell with ELIA_SANDBOX=box goes through the box, and fails closed when it cannot', async () => {
    const ws = realpathSync(mkdtempSync(join(tmpdir(), 'eb-ws-')))
    try {
      process.env.ELIA_SANDBOX = 'box'
      const ok = await runShell('echo $ELIA_BOX', 20_000, ws)
      expect(ok.stdout.trim()).toBe('1')

      process.env.ELIA_BOX_BIN = '/nonexistent/elia-box'
      const closed = await runShell('echo ran-on-host', 20_000, ws)
      expect(closed.exitCode).toBe(1)
      expect(closed.stdout).not.toContain('ran-on-host')
      expect(closed.stderr).toContain('elia-box did not run this command')

      process.env.ELIA_BOX_FALLBACK = 'host'
      const open = await runShell('echo ran-on-host', 20_000, ws)
      expect(open.stdout).toContain('ran-on-host')
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })
})

test('BoxUnavailable is distinguishable from a policy failure', () => {
  expect(new BoxUnavailable('x')).toBeInstanceOf(Error)
  expect(new BoxUnavailable('x').name).toBe('BoxUnavailable')
})
